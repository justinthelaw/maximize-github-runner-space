import assert from "node:assert/strict";
import test from "node:test";
import {
  createFunctionOperation,
  executeOperations,
  prepareOperations,
} from "../src/operations.js";
import type { CleanupPlan, ComponentId, Operation } from "../src/types.js";

function operation(
  component: ComponentId,
  id: string,
  options: Pick<
    Operation,
    "dedupeKey" | "blockedBy" | "coveredBy" | "always"
  > = {},
): Operation {
  return createFunctionOperation({
    component,
    id,
    description: id,
    phase: "filesystem",
    ...options,
    run: async () => ({ status: "removed" }),
  });
}

function plan(
  enabled: readonly ComponentId[],
  skipped: readonly ComponentId[] = [],
): CleanupPlan {
  return {
    profile: "custom",
    enabled: new Set(enabled),
    skipped: new Set(skipped),
    swapfileBytes: undefined,
  };
}

test("operations honor enabled, blocked, covered, always, and dedupe rules", () => {
  const prepared = prepareOperations(
    [
      operation("java", "selected"),
      operation("dotnet", "disabled"),
      operation("java", "blocked", { blockedBy: ["cached-node"] }),
      operation("java", "covered", { coveredBy: ["cached-tools"] }),
      operation("java", "first", { dedupeKey: "same" }),
      operation("java", "second", { dedupeKey: "same" }),
      operation("large-packages", "swap", { always: true }),
    ],
    plan(["java", "cached-tools"], ["cached-node"]),
  );
  assert.deepEqual(
    prepared.map(({ id }) => id),
    ["selected", "first", "swap"],
  );
});

test("package uninstallers run before their filesystem payloads disappear", async () => {
  const executionOrder: string[] = [];
  const phasedOperation = (id: string, phase: Operation["phase"]): Operation =>
    createFunctionOperation({
      id,
      component: "dotnet",
      description: id,
      phase,
      run: async () => {
        executionOrder.push(id);
        return { status: "removed" };
      },
    });

  await executeOperations([
    phasedOperation("system", "system"),
    phasedOperation("filesystem", "filesystem"),
    phasedOperation("package", "package"),
    phasedOperation("preflight", "preflight"),
  ]);

  assert.deepEqual(executionOrder, [
    "preflight",
    "package",
    "filesystem",
    "system",
  ]);
});
