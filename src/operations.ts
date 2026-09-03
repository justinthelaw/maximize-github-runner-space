import * as core from "@actions/core";
import { rm, unlink } from "node:fs/promises";
import { dirname, normalize, win32 } from "node:path";
import { runElevated } from "./command.js";
import {
  assertSafeExistingTarget,
  assertSafeRemovalTarget,
  inspectTarget,
  type LinuxMountInfoReader,
  type TargetInspection,
} from "./safety.js";
import { isWindowsReparsePoint } from "./windows-path.js";
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

export interface RemovePathDependencies {
  readonly inspectTarget?: typeof inspectTarget;
  readonly readLinuxMountInfo?: LinuxMountInfoReader;
  readonly lstat?: typeof import("node:fs/promises").lstat;
  readonly realpath?: typeof import("node:fs/promises").realpath;
  readonly readWindowsFileAttributes?: typeof import("./windows-path.js").readWindowsFileAttributes;
  readonly remove?: typeof rm;
  readonly unlink?: typeof unlink;
  readonly runElevated?: typeof runElevated;
  readonly beforeMutation?: (
    boundary: "local" | "elevated",
    inspection: Extract<TargetInspection, { readonly exists: true }>,
  ) => Promise<void>;
}

const MAX_MUTATION_GUARD_FAILURE_LENGTH = 2_000;

function classifyWindowsReparseInspection(
  inspection: TargetInspection,
  context: RuntimeContext,
): TargetInspection {
  if (
    context.platform !== "windows" ||
    !inspection.exists ||
    inspection.fileAttributes === undefined ||
    !isWindowsReparsePoint(inspection.fileAttributes) ||
    inspection.isLink
  ) {
    return inspection;
  }
  const { realPath: _realPath, ...withoutRealPath } = inspection;
  return { ...withoutRealPath, isLink: true };
}

function targetDriftFailure(
  expected: TargetInspection,
  current: TargetInspection,
  target: string,
): OperationResult | undefined {
  if (!expected.exists || !current.exists) return undefined;
  if (current.isLink !== expected.isLink) {
    return {
      status: "failed",
      detail: `Cleanup target kind changed after validation: '${target}'.`,
    };
  }
  if (
    current.identity.device !== expected.identity.device ||
    current.identity.inode !== expected.identity.inode
  ) {
    return {
      status: "failed",
      detail: `Cleanup target identity changed after validation: '${target}'.`,
    };
  }
  if (
    current.ancestors?.length !== expected.ancestors?.length ||
    !(
      expected.ancestors?.every((ancestor, index) => {
        const other = current.ancestors?.[index];
        return (
          other !== undefined &&
          ancestor.path === other.path &&
          ancestor.kind === other.kind &&
          ancestor.identity.device === other.identity.device &&
          ancestor.identity.inode === other.identity.inode
        );
      }) ?? true
    )
  ) {
    return {
      status: "failed",
      detail: `Cleanup target ancestor changed after validation: '${target}'.`,
    };
  }
  return undefined;
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
  dependencies: RemovePathDependencies = {},
): Promise<OperationResult> {
  const inspect = dependencies.inspectTarget ?? inspectTarget;
  const remove = dependencies.remove ?? rm;
  const unlinkTarget = dependencies.unlink ?? unlink;
  const elevate = dependencies.runElevated ?? runElevated;
  const runMutationGuard = async (
    boundary: "local" | "elevated",
    inspection: Extract<TargetInspection, { readonly exists: true }>,
  ): Promise<OperationResult | undefined> => {
    if (dependencies.beforeMutation === undefined) return undefined;
    try {
      await dependencies.beforeMutation(boundary, inspection);
      return undefined;
    } catch (error) {
      return {
        status: "failed",
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          MAX_MUTATION_GUARD_FAILURE_LENGTH,
        ),
      };
    }
  };
  const inspectSafely = async (): Promise<
    | { readonly inspection: TargetInspection }
    | { readonly failure: OperationResult }
  > => {
    try {
      return {
        inspection: classifyWindowsReparseInspection(
          await assertSafeExistingTarget(
            target,
            allowedParents,
            context,
            dependencies,
          ),
          context,
        ),
      };
    } catch (error) {
      return {
        failure: {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  const initialResult = await inspectSafely();
  if ("failure" in initialResult) return initialResult.failure;
  const inspected = initialResult.inspection;
  if (!inspected.exists) return { status: "not-found" };

  // This complete safety pass is the final filesystem observation before the
  // optional policy guard and local mutation. Its returned classification,
  // not an older preflight snapshot, decides whether the entry can be
  // recursively removed or must be unlinked.
  const revalidatedResult = await inspectSafely();
  if ("failure" in revalidatedResult) return revalidatedResult.failure;
  const revalidated = revalidatedResult.inspection;
  if (!revalidated.exists) return { status: "not-found" };
  const revalidationFailure = targetDriftFailure(
    inspected,
    revalidated,
    target,
  );
  if (revalidationFailure !== undefined) return revalidationFailure;
  const verifyRemoved = async (): Promise<OperationResult> => {
    try {
      if (!(await inspect(target)).exists) return { status: "removed" };
      return {
        status: "failed",
        detail: `Cleanup target still exists after removal: '${target}'.`,
      };
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const localGuardFailure = await runMutationGuard("local", revalidated);
  if (localGuardFailure !== undefined) return localGuardFailure;

  try {
    if (revalidated.isLink) {
      // Unlink the directory symlink/junction itself. Never give a recursive
      // remover a final link that could be swapped or followed differently.
      await unlinkTarget(target);
    } else {
      await remove(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
    return await verifyRemoved();
  } catch (nodeError) {
    if (
      revalidated.isLink &&
      (nodeError as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return await verifyRemoved();
    }
    if (context.platform === "windows") {
      return { status: "failed", detail: (nodeError as Error).message };
    }

    const elevatedResult = await inspectSafely();
    if ("failure" in elevatedResult) return elevatedResult.failure;
    const elevatedTarget = elevatedResult.inspection;
    if (!elevatedTarget.exists) return { status: "removed" };
    const elevationFailure = targetDriftFailure(
      revalidated,
      elevatedTarget,
      target,
    );
    if (elevationFailure !== undefined) return elevationFailure;

    const elevatedGuardFailure = await runMutationGuard(
      "elevated",
      elevatedTarget,
    );
    if (elevatedGuardFailure !== undefined) return elevatedGuardFailure;

    const result = await elevate(
      context,
      "/bin/rm",
      [elevatedTarget.isLink ? "-f" : "-rf", "--", target],
      { silent: true, timeoutMs: 10 * 60_000 },
    );
    if (result.exitCode === 0) return await verifyRemoved();
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
