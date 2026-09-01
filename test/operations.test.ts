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
    | "dedupeKey"
    | "blockedBy"
    | "coveredBy"
    | "coveredBySuccessfulOperations"
    | "always"
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

test("a narrower fallback runs unless its broad operation removed the payload", async () => {
  for (const [broadStatus, expectedOrder] of [
    ["removed", ["visual-studio", "unrelated"]],
    ["not-found", ["visual-studio", "windows-sdk", "unrelated"]],
    ["failed", ["visual-studio", "windows-sdk", "unrelated"]],
  ] as const) {
    const executionOrder: string[] = [];
    const packageOperation = (
      id: string,
      status: "removed" | "not-found" | "failed",
      coveredBySuccessfulOperations?: readonly string[],
    ): Operation =>
      createFunctionOperation({
        id,
        component:
          id === "visual-studio"
            ? "visual-studio"
            : id === "windows-sdk"
              ? "windows-sdk"
              : "azcopy",
        description: id,
        phase: "package",
        ...(coveredBySuccessfulOperations === undefined
          ? {}
          : { coveredBySuccessfulOperations }),
        run: async () => {
          executionOrder.push(id);
          return { status };
        },
      });

    const results = await executeOperations([
      packageOperation("visual-studio", broadStatus),
      packageOperation("windows-sdk", "removed", ["visual-studio"]),
      packageOperation("unrelated", "removed"),
    ]);

    assert.deepEqual(executionOrder, expectedOrder, broadStatus);
    assert.deepEqual(
      results.map(({ status }) => status),
      broadStatus === "removed"
        ? ["removed", "removed"]
        : [broadStatus, "removed", "removed"],
      broadStatus,
    );
  }
});

test("a fallback remains eligible when overlap filtering removes its broad operation", async () => {
  const executionOrder: string[] = [];
  const prepared = prepareOperations(
    [
      createFunctionOperation({
        id: "visual-studio",
        component: "visual-studio",
        description: "visual-studio",
        phase: "package",
        blockedBy: ["dotnet"],
        run: async () => {
          executionOrder.push("visual-studio");
          return { status: "removed" };
        },
      }),
      createFunctionOperation({
        id: "windows-sdk",
        component: "windows-sdk",
        description: "windows-sdk",
        phase: "package",
        coveredBySuccessfulOperations: ["visual-studio"],
        run: async () => {
          executionOrder.push("windows-sdk");
          return { status: "removed" };
        },
      }),
      createFunctionOperation({
        id: "unrelated",
        component: "azcopy",
        description: "unrelated",
        phase: "package",
        run: async () => {
          executionOrder.push("unrelated");
          return { status: "removed" };
        },
      }),
    ],
    plan(["visual-studio", "windows-sdk", "azcopy"], ["dotnet"]),
  );

  assert.deepEqual(
    prepared.map(({ id }) => id),
    ["windows-sdk", "unrelated"],
  );
  await executeOperations(prepared);
  assert.deepEqual(executionOrder, ["windows-sdk", "unrelated"]);
});

test("result-dependent coverage must point to an earlier serialized operation", async () => {
  let mutated = false;
  const broad = createFunctionOperation({
    id: "broad",
    component: "visual-studio",
    description: "broad",
    phase: "package",
    run: async () => {
      mutated = true;
      return { status: "removed" };
    },
  });
  const fallback = createFunctionOperation({
    id: "fallback",
    component: "windows-sdk",
    description: "fallback",
    phase: "package",
    coveredBySuccessfulOperations: ["broad"],
    run: async () => {
      mutated = true;
      return { status: "removed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([fallback, broad]),
    /must run after its serialized coverage dependency broad/,
  );
  assert.equal(mutated, false);
});
