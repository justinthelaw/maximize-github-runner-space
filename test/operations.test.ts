import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCommandTerminationUnconfirmed,
  markCommandTerminationUnconfirmed,
  UnconfirmedCommandTerminationError,
} from "../src/command.js";
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

test("any failed operation stops all later mutations", async () => {
  const executionOrder: string[] = [];
  const failed = createFunctionOperation({
    id: "failed",
    component: "visual-studio",
    description: "failed",
    phase: "package",
    run: async () => {
      executionOrder.push("failed");
      return { status: "failed" };
    },
  });
  const later = createFunctionOperation({
    id: "later",
    component: "windows-sdk",
    description: "later",
    phase: "filesystem",
    run: async () => {
      executionOrder.push("later");
      return { status: "removed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([failed, later]),
    /failed failed/,
  );
  assert.deepEqual(executionOrder, ["failed"]);
});

test("a payload failure does not restart a service over partial cleanup", async () => {
  const executionOrder: string[] = [];
  const reversible = createFunctionOperation({
    id: "stop-service",
    component: "postgresql",
    description: "stop-service",
    phase: "preflight",
    run: async () => {
      executionOrder.push("stop");
      return { status: "removed" };
    },
    rollback: async () => {
      executionOrder.push("restart");
    },
  });
  const failed = createFunctionOperation({
    id: "package-failure",
    component: "postgresql",
    description: "package-failure",
    phase: "package",
    run: async () => {
      executionOrder.push("package");
      return { status: "failed", detail: "inventory unavailable" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([reversible, failed]),
    /inventory unavailable/,
  );
  assert.deepEqual(executionOrder, ["stop", "package"]);
});

test("a preflight failure rolls back earlier reversible preflight state", async () => {
  const executionOrder: string[] = [];
  const reversible = createFunctionOperation({
    id: "stop-service",
    component: "postgresql",
    description: "stop-service",
    phase: "preflight",
    run: async () => {
      executionOrder.push("stop");
      return { status: "removed" };
    },
    rollback: async () => {
      executionOrder.push("restart");
    },
  });
  const failed = createFunctionOperation({
    id: "preflight-failure",
    component: "postgresql",
    description: "preflight-failure",
    phase: "preflight",
    run: async () => {
      executionOrder.push("preflight");
      return { status: "failed", detail: "probe unavailable" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([reversible, failed]),
    /probe unavailable/,
  );
  assert.deepEqual(executionOrder, ["stop", "preflight", "restart"]);
});

test("post-preflight validation rolls back services before payload mutation", async () => {
  const events: string[] = [];
  const service = createFunctionOperation({
    id: "service-stop-before-lock-probe",
    component: "postgresql",
    description: "stop PostgreSQL",
    phase: "preflight",
    rollback: async () => {
      events.push("service-restarted");
    },
    run: async () => {
      events.push("service-stopped");
      return { status: "removed" };
    },
  });
  const payload = createFunctionOperation({
    id: "payload-after-lock-probe",
    component: "postgresql",
    description: "remove PostgreSQL payload",
    phase: "filesystem",
    validateAfterPreflight: async () => {
      events.push("lock-probe");
      throw new Error("locked descendant remains");
    },
    run: async () => {
      events.push("payload-removed");
      return { status: "removed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([service, payload]),
    /locked descendant remains/,
  );
  assert.deepEqual(events, [
    "service-stopped",
    "lock-probe",
    "service-restarted",
  ]);
});

test("final post-preflight barriers run after ordinary lock probes", async () => {
  const events: string[] = [];
  const preflight = createFunctionOperation({
    id: "preflight",
    component: "postgresql",
    description: "preflight",
    phase: "preflight",
    run: async () => ({ status: "removed" }),
  });
  const finalBarrier = createFunctionOperation({
    id: "final-service-barrier",
    component: "postgresql",
    description: "final service barrier",
    phase: "system",
    validateAfterPreflightLast: true,
    validateAfterPreflight: async () => {
      events.push("service-barrier");
    },
    run: async () => ({ status: "not-found" }),
  });
  const lockProbe = createFunctionOperation({
    id: "ordinary-lock-probe",
    component: "postgresql",
    description: "ordinary lock probe",
    phase: "filesystem",
    validateAfterPreflight: async () => {
      events.push("lock-probe");
    },
    run: async () => ({ status: "not-found" }),
  });

  await executeOperations([preflight, finalBarrier, lockProbe]);

  assert.deepEqual(events, ["lock-probe", "service-barrier"]);
});

test("immediate validation failure rolls back before payload mutation", async () => {
  const events: string[] = [];
  const service = createFunctionOperation({
    id: "service-stop",
    component: "postgresql",
    description: "stop service",
    phase: "preflight",
    rollback: async () => {
      events.push("service-restarted");
    },
    run: async () => {
      events.push("service-stopped");
      return { status: "removed" };
    },
  });
  const payload = createFunctionOperation({
    id: "guarded-payload",
    component: "postgresql",
    description: "guarded payload",
    phase: "package",
    validateBeforeRun: async () => {
      events.push("immediate-check");
      throw new Error("service reactivated");
    },
    run: async () => {
      events.push("payload-removed");
      return { status: "removed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([service, payload]),
    /service reactivated/,
  );

  assert.deepEqual(events, [
    "service-stopped",
    "immediate-check",
    "service-restarted",
  ]);
});

test("safe housekeeping may roll back after payload cleanup starts", async () => {
  const executionOrder: string[] = [];
  const housekeeping = createFunctionOperation({
    id: "create-private-config",
    component: "homebrew",
    description: "create-private-config",
    phase: "preflight",
    run: async () => {
      executionOrder.push("create");
      return { status: "removed" };
    },
    rollbackAfterPayloadMutation: true,
    rollback: async () => {
      executionOrder.push("release");
    },
  });
  const failed = createFunctionOperation({
    id: "package-failure",
    component: "homebrew",
    description: "package-failure",
    phase: "package",
    run: async () => {
      executionOrder.push("package");
      return { status: "failed", detail: "cleanup failed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([housekeeping, failed]),
    /cleanup failed/,
  );
  assert.deepEqual(executionOrder, ["create", "package", "release"]);
});

test("even an empty plan observes the global termination latch", async () => {
  markCommandTerminationUnconfirmed("escaped sudo probe may still be running");
  try {
    await assert.rejects(
      async () => await executeOperations([]),
      /escaped sudo probe may still be running/,
    );
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("an unconfirmed validation timeout stops every later validator", async () => {
  const fatal = new UnconfirmedCommandTerminationError(
    "validation process may still be running",
  );
  let laterValidated = false;
  const timedOut = createFunctionOperation({
    id: "timed-out-validation",
    component: "docker-images",
    description: "timed-out-validation",
    phase: "preflight",
    validate: async () => {
      markCommandTerminationUnconfirmed(fatal.message);
      throw fatal;
    },
    run: async () => ({ status: "removed" }),
  });
  const later = createFunctionOperation({
    id: "later-validation",
    component: "java",
    description: "later-validation",
    phase: "package",
    validate: async () => {
      laterValidated = true;
    },
    run: async () => ({ status: "removed" }),
  });

  try {
    await assert.rejects(
      async () => await executeOperations([timedOut, later]),
      (error) => error === fatal,
    );
    assert.equal(laterValidated, false);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("an unconfirmed rollback timeout stops every earlier rollback", async () => {
  const fatal = new UnconfirmedCommandTerminationError(
    "rollback process may still be running",
  );
  let earlierRollbackRan = false;
  const reversible = (id: string, rollback: () => Promise<void>): Operation =>
    createFunctionOperation({
      id,
      component: "postgresql",
      description: id,
      phase: "preflight",
      run: async () => ({ status: "removed" }),
      rollback,
    });
  const failure = createFunctionOperation({
    id: "force-rollback",
    component: "postgresql",
    description: "force-rollback",
    phase: "preflight",
    run: async () => ({ status: "failed" }),
  });

  try {
    await assert.rejects(
      async () =>
        await executeOperations([
          reversible("earlier", async () => {
            earlierRollbackRan = true;
          }),
          reversible("timed-out", async () => {
            markCommandTerminationUnconfirmed(fatal.message);
            throw fatal;
          }),
          failure,
        ]),
      (error) => error === fatal,
    );
    assert.equal(earlierRollbackRan, false);
  } finally {
    clearCommandTerminationUnconfirmed();
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

test("an operation-level abort result prevents every later mutation", async () => {
  const executionOrder: string[] = [];
  const terminal = createFunctionOperation({
    id: "terminal",
    component: "visual-studio",
    description: "terminal",
    phase: "package",
    run: async () => {
      executionOrder.push("terminal");
      return {
        status: "failed",
        detail: "restart initiated",
        abortAction: true,
      };
    },
  });
  const later = createFunctionOperation({
    id: "later",
    component: "windows-sdk",
    description: "later",
    phase: "package",
    run: async () => {
      executionOrder.push("later");
      return { status: "removed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([terminal, later]),
    /restart initiated/,
  );
  assert.deepEqual(executionOrder, ["terminal"]);
});

test("an unconfirmed command termination prevents every later mutation", async () => {
  const executionOrder: string[] = [];
  const timedOut = createFunctionOperation({
    id: "timed-out",
    component: "visual-studio",
    description: "timed-out",
    phase: "package",
    run: async () => {
      executionOrder.push("timed-out");
      markCommandTerminationUnconfirmed(
        "timed-out installer process may still be running",
      );
      return { status: "failed", detail: "timeout" };
    },
  });
  const later = createFunctionOperation({
    id: "later",
    component: "windows-sdk",
    description: "later",
    phase: "package",
    run: async () => {
      executionOrder.push("later");
      return { status: "removed" };
    },
  });

  try {
    await assert.rejects(
      async () => await executeOperations([timedOut, later]),
      /may still be running/,
    );
    assert.deepEqual(executionOrder, ["timed-out"]);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("filesystem operations are serialized before a fatal termination latch", async () => {
  const executionOrder: string[] = [];
  const timedOut = createFunctionOperation({
    id: "filesystem-timeout",
    component: "java",
    description: "filesystem-timeout",
    phase: "filesystem",
    run: async () => {
      executionOrder.push("filesystem-timeout");
      await new Promise((resolve) => setImmediate(resolve));
      markCommandTerminationUnconfirmed(
        "filesystem process may still be running",
      );
      return { status: "failed", detail: "timeout" };
    },
  });
  const later = createFunctionOperation({
    id: "later-filesystem-mutation",
    component: "dotnet",
    description: "later-filesystem-mutation",
    phase: "filesystem",
    run: async () => {
      executionOrder.push("later-filesystem-mutation");
      return { status: "removed" };
    },
  });

  try {
    await assert.rejects(
      async () => await executeOperations([timedOut, later]),
      /filesystem process may still be running/,
    );
    assert.deepEqual(executionOrder, ["filesystem-timeout"]);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});
