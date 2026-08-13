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

async function removePath(
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
    run: async () =>
      await removePath(target, options.allowedParents, options.context),
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
  readonly always?: boolean;
  readonly fatal?: boolean;
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
    ...(options.always === undefined ? {} : { always: options.always }),
    ...(options.fatal === undefined ? {} : { fatal: options.fatal }),
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

export async function executeOperations(
  operations: readonly Operation[],
): Promise<readonly OperationResult[]> {
  const results: OperationResult[] = [];
  for (const phase of [
    "preflight",
    "package",
    "filesystem",
    "system",
  ] as const) {
    const phaseOperations = operations.filter(
      (operation) => operation.phase === phase,
    );
    if (phaseOperations.length === 0) continue;
    await core.group(`${phase} cleanup`, async () => {
      const phaseResults =
        phase === "filesystem"
          ? await runBounded(phaseOperations, 4)
          : await runBounded(phaseOperations, 1);
      results.push(...phaseResults);
    });
  }
  return results;
}

export function parentOf(target: string): string {
  return dirname(normalize(target));
}
