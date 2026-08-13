import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CHILDREN,
  COMPONENTS,
  TOOLCACHE_CHILDREN,
} from "../src/components.js";
import { createPlan, parseSwapfileSize } from "../src/planner.js";

function inputs(
  values: Readonly<Record<string, string>> = {},
): (name: string) => string {
  return (name) => values[name] ?? (name === "cleanup-profile" ? "max" : "");
}

test("the no-input contract remains aggressive max with swap untouched", () => {
  const plan = createPlan(inputs());
  assert.equal(plan.profile, "max");
  assert.equal(plan.swapfileBytes, undefined);
  assert.equal(plan.skipped.size, 0);
  assert.equal(plan.enabled.has("dotnet"), true);
  assert.equal(plan.enabled.has("browsers"), true);
  assert.equal(plan.enabled.has("cached-tools"), true);
  assert.equal(plan.enabled.has("docker-engine"), true);
  assert.equal(plan.enabled.has("docker-images"), false);
  for (const child of [...BROWSER_CHILDREN, ...TOOLCACHE_CHILDREN]) {
    assert.equal(
      plan.enabled.has(child),
      false,
      `${child} is covered by its group`,
    );
  }
});

test("custom enables only the exact lowercase string true", () => {
  const plan = createPlan(
    inputs({
      "cleanup-profile": " CUSTOM ",
      "remove-java": "true",
      "remove-dotnet": "True",
      "skip-components": "java",
    }),
  );
  assert.deepEqual([...plan.enabled], ["java"]);
  assert.equal(plan.skipped.size, 0);
});

test("skipping an umbrella protects every owned child", () => {
  const plan = createPlan(
    inputs({ "skip-components": " Browsers , CACHED-TOOLS " }),
  );
  for (const component of [
    "browsers",
    ...BROWSER_CHILDREN,
    "cached-tools",
    ...TOOLCACHE_CHILDREN,
  ] as const) {
    assert.equal(plan.enabled.has(component), false, component);
    assert.equal(plan.skipped.has(component), true, component);
  }
  for (const component of [
    "codeql",
    "dotnet",
    "haskell",
    "swift",
    "julia",
    "java",
  ] as const) {
    assert.equal(plan.enabled.has(component), true, component);
  }
});

test("skipping one child preserves it while enabling sibling cleanup", () => {
  const plan = createPlan(
    inputs({ "skip-components": " cached-node , firefox " }),
  );
  assert.equal(plan.enabled.has("cached-tools"), false);
  assert.equal(plan.enabled.has("cached-node"), false);
  assert.equal(plan.enabled.has("cached-python"), true);
  assert.equal(plan.enabled.has("browsers"), false);
  assert.equal(plan.enabled.has("firefox"), false);
  assert.equal(plan.enabled.has("chrome"), true);
});

test("toolcache owners cannot be deleted by the broad cache operation", () => {
  for (const owner of [
    "codeql",
    "dotnet",
    "haskell",
    "swift",
    "julia",
    "java",
  ] as const) {
    const plan = createPlan(inputs({ "skip-components": owner }));
    assert.equal(plan.enabled.has("cached-tools"), false, owner);
    assert.equal(plan.enabled.has(owner), false, owner);
  }
});

test("the Linux large-packages umbrella yields to protected components", () => {
  const linux = createPlan(inputs({ "skip-components": "powershell" }));
  assert.equal(linux.enabled.has("large-packages"), false);
  // Homebrew ownership is platform-specific and therefore enforced by the
  // macOS adapter, not by the platform-neutral plan.
  assert.equal(linux.enabled.has("homebrew"), true);
});

test("unknown profiles and skip names fail validation", () => {
  assert.throws(
    () => createPlan(inputs({ "cleanup-profile": "everything" })),
    /Invalid cleanup-profile/,
  );
  assert.throws(
    () => createPlan(inputs({ "skip-components": "java,not-a-component" })),
    /not-a-component/,
  );
});

test("every declared component has a unique input and skip identifier", () => {
  assert.equal(new Set(COMPONENTS.map(({ id }) => id)).size, COMPONENTS.length);
  assert.equal(
    new Set(COMPONENTS.map(({ input }) => input)).size,
    COMPONENTS.length,
  );
});

test("swap sizes preserve legacy binary-unit and rounding semantics", () => {
  assert.equal(parseSwapfileSize(""), undefined);
  assert.equal(parseSwapfileSize("0"), 0n);
  assert.equal(parseSwapfileSize("2"), 2n * 1024n ** 3n);
  assert.equal(parseSwapfileSize(" 1.5 GiB "), 1536n * 1024n ** 2n);
  assert.equal(parseSwapfileSize("512MB"), 512n * 1024n ** 2n);
  assert.throws(() => parseSwapfileSize("0.5MiB"), /at least 1 MiB/);
  assert.throws(() => parseSwapfileSize("-1"), /Invalid swapfile-size/);
  assert.throws(() => parseSwapfileSize("1PB"), /Invalid swapfile-size/);
});
