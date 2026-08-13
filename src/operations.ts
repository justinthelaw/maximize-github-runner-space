import * as core from "@actions/core";
import { rm, unlink } from "node:fs/promises";
import { dirname, normalize, win32 } from "node:path";
import { runElevated } from "./command.js";
import {
  assertSafeExistingTarget,
  assertSafeRemovalTarget,
  inspectTarget,
} from "./safety.js";
import type {
  CleanupPlan,
  ComponentId,
  Operation,
  OperationPhase,
  OperationResult,
  RuntimeContext,
} from "./types.js";

export interface RemovePathOptions {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly target: string;
  readonly allowedParents: readonly string[];
  readonly context: RuntimeContext;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
}

export async function validateRemovePathTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<void> {
  await assertSafeExistingTarget(target, allowedParents, context);
}

export async function removePathTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<OperationResult> {
  const inspected = await inspectTarget(target);
  if (!inspected.exists) return { status: "not-found" };
  try {
    await assertSafeExistingTarget(target, allowedParents, context);
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (inspected.isLink) {
      // Unlink the directory symlink/junction itself. Never give a recursive
      // remover a final link that could be swapped or followed differently.
      await unlink(target);
    } else {
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
    return { status: "removed" };
  } catch (nodeError) {
    if (context.platform === "windows") {
      return { status: "failed", detail: (nodeError as Error).message };
    }

    const result = await runElevated(
      context,
      "/bin/rm",
      [inspected.isLink ? "-f" : "-rf", "--", target],
      { silent: true, timeoutMs: 10 * 60_000 },
    );
    if (result.exitCode === 0) return { status: "removed" };
    return {
      status: "failed",
      detail: result.stderr.trim() || (nodeError as Error).message,
    };
  }
}

export function createRemovePathOperation(
  options: RemovePathOptions,
): Operation {
  const target = assertSafeRemovalTarget(
    options.target,
    options.allowedParents,
    options.context,
  );
  return {
    id: options.id,
    component: options.component,
    description: options.description,
    phase: "filesystem",
    dedupeKey: `path:${
      options.context.platform === "windows"
        ? win32.normalize(target).toLowerCase()
        : normalize(target)
    }`,
    ...(options.blockedBy === undefined
      ? {}
      : { blockedBy: options.blockedBy }),
    ...(options.coveredBy === undefined
      ? {}
      : { coveredBy: options.coveredBy }),
    validate: async () =>
      await validateRemovePathTarget(
        target,
        options.allowedParents,
        options.context,
      ),
    run: async () =>
      await removePathTarget(target, options.allowedParents, options.context),
  };
}

export function createUnsupportedOperation(
  component: ComponentId,
  detail: string,
): Operation {
  return createFunctionOperation({
    id: `unsupported:${component}`,
    component,
    description: `${component} cleanup is not applicable on this runner`,
    phase: "system",
    run: async () => ({ status: "unsupported", detail }),
  });
}

export function createFunctionOperation(options: {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly phase: OperationPhase;
  readonly dedupeKey?: string;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
  readonly coveredBySuccessfulOperations?: readonly string[];
  readonly always?: boolean;
  readonly fatal?: boolean;
  readonly validate?: () => Promise<void>;
  readonly run: () => Promise<OperationResult>;
}): Operation {
  return {
    id: options.id,
    component: options.component,
    description: options.description,
    phase: options.phase,
    ...(options.dedupeKey === undefined
      ? {}
      : { dedupeKey: options.dedupeKey }),
    ...(options.blockedBy === undefined
      ? {}
      : { blockedBy: options.blockedBy }),
    ...(options.coveredBy === undefined
      ? {}
      : { coveredBy: options.coveredBy }),
    ...(options.coveredBySuccessfulOperations === undefined
      ? {}
      : {
          coveredBySuccessfulOperations: options.coveredBySuccessfulOperations,
        }),
    ...(options.always === undefined ? {} : { always: options.always }),
    ...(options.fatal === undefined ? {} : { fatal: options.fatal }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    run: options.run,
  };
}

export function prepareOperations(
  operations: readonly Operation[],
  plan: CleanupPlan,
): readonly Operation[] {
  const byKey = new Map<string, Operation>();
  const prepared: Operation[] = [];
  for (const operation of operations) {
    if (operation.always !== true && !plan.enabled.has(operation.component)) {
      continue;
    }
    if (operation.blockedBy?.some((component) => plan.skipped.has(component))) {
      continue;
    }
    if (operation.coveredBy?.some((component) => plan.enabled.has(component))) {
      continue;
    }
    if (operation.dedupeKey === undefined) {
      prepared.push(operation);
      continue;
    }
    if (!byKey.has(operation.dedupeKey)) {
      byKey.set(operation.dedupeKey, operation);
      prepared.push(operation);
    }
  }
  return prepared;
}

async function runOne(operation: Operation): Promise<OperationResult> {
  core.info(`• ${operation.description}`);
  try {
    const result = await operation.run();
    const suffix = result.detail === undefined ? "" : `: ${result.detail}`;
    if (result.status === "failed") {
      core.warning(`${operation.description} failed${suffix}`);
      if (operation.fatal === true) {
        throw new Error(`${operation.description} failed${suffix}`);
      }
    } else if (result.status !== "not-found") {
      core.info(`  ${result.status}${suffix}`);
    }
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(`${operation.description} failed: ${detail}`);
    if (operation.fatal === true) throw error;
    return { status: "failed", detail };
  }
}

async function runBounded(
  operations: readonly Operation[],
  concurrency: number,
): Promise<readonly OperationResult[]> {
  const results: OperationResult[] = new Array(operations.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, operations.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        const operation = operations[index];
        if (operation === undefined) return;
        results[index] = await runOne(operation);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const PHASES = ["preflight", "package", "filesystem", "system"] as const;

function assertValidResultCoverage(operations: readonly Operation[]): void {
  const byId = new Map<string, Operation[]>();
  for (const operation of operations) {
    const matching = byId.get(operation.id) ?? [];
    matching.push(operation);
    byId.set(operation.id, matching);
  }

  const executionOrder = new Map<Operation, number>();
  let cursor = 0;
  for (const phase of PHASES) {
    for (const operation of operations) {
      if (operation.phase === phase) executionOrder.set(operation, cursor++);
    }
  }

  for (const operation of operations) {
    for (const coveringId of operation.coveredBySuccessfulOperations ?? []) {
      const covering = byId.get(coveringId) ?? [];
      if (covering.length === 0) continue;
      if (covering.length > 1) {
        throw new Error(
          `${operation.id} has an ambiguous successful-operation coverage dependency on ${coveringId}`,
        );
      }
      const coveringOperation = covering[0];
      if (coveringOperation === undefined) continue;
      const coveringOrder = executionOrder.get(coveringOperation);
      const fallbackOrder = executionOrder.get(operation);
      if (
        coveringOrder === undefined ||
        fallbackOrder === undefined ||
        coveringOrder >= fallbackOrder ||
        (operation.phase === "filesystem" &&
          coveringOperation.phase === "filesystem")
      ) {
        throw new Error(
          `${operation.id} must run after its serialized coverage dependency ${coveringId}`,
        );
      }
    }
  }
}

function successfulCoveringOperation(
  operation: Operation,
  resultsById: ReadonlyMap<string, OperationResult>,
): string | undefined {
  return operation.coveredBySuccessfulOperations?.find(
    (id) => resultsById.get(id)?.status === "removed",
  );
}

function isCoveredBySuccessfulOperation(
  operation: Operation,
  resultsById: ReadonlyMap<string, OperationResult>,
): boolean {
  const coveringId = successfulCoveringOperation(operation, resultsById);
  if (coveringId === undefined) return false;
  core.info(`• ${operation.description} (covered by successful ${coveringId})`);
  return true;
}

export async function executeOperations(
  operations: readonly Operation[],
): Promise<readonly OperationResult[]> {
  assertValidResultCoverage(operations);
  const validationFailures: string[] = [];
  for (const operation of operations) {
    if (operation.validate === undefined) continue;
    try {
      await operation.validate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      validationFailures.push(`${operation.description}: ${detail}`);
    }
  }
  if (validationFailures.length > 0) {
    throw new Error(
      `Cleanup plan validation failed before mutation:\n${validationFailures.join("\n")}`,
    );
  }

  const results: OperationResult[] = [];
  const resultsById = new Map<string, OperationResult>();
  for (const phase of PHASES) {
    const phaseOperations = operations.filter(
      (operation) => operation.phase === phase,
    );
    if (phaseOperations.length === 0) continue;
    await core.group(`${phase} cleanup`, async () => {
      if (phase === "filesystem") {
        const eligible = phaseOperations.filter(
          (operation) =>
            !isCoveredBySuccessfulOperation(operation, resultsById),
        );
        const phaseResults = await runBounded(eligible, 4);
        results.push(...phaseResults);
        for (let index = 0; index < eligible.length; index++) {
          const operation = eligible[index];
          const result = phaseResults[index];
          if (operation !== undefined && result !== undefined) {
            resultsById.set(operation.id, result);
          }
        }
        return;
      }

      for (const operation of phaseOperations) {
        if (isCoveredBySuccessfulOperation(operation, resultsById)) continue;
        const result = await runOne(operation);
        results.push(result);
        resultsById.set(operation.id, result);
      }
    });
  }
  return results;
}

export function parentOf(target: string): string {
  return dirname(normalize(target));
}
