import assert from "node:assert/strict";
import test from "node:test";
import { COMPONENTS } from "../src/components.js";
import {
  createLinuxAdapter,
  existingFileState,
  isStoppedSystemdUnit,
} from "../src/platforms/linux.js";
import { createMacOSAdapter } from "../src/platforms/macos.js";
import {
  createWindowsAdapter,
  isMissingWindowsService,
} from "../src/platforms/windows.js";
import { prepareOperations } from "../src/operations.js";
import { createPlan } from "../src/planner.js";
import type { Adapter, ComponentId, Platform } from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

const factories: Readonly<Record<Platform, () => Promise<Adapter>>> = {
  linux: async () => await createLinuxAdapter(contextFor("linux")),
  macos: async () => await createMacOSAdapter(contextFor("macos")),
  windows: async () => await createWindowsAdapter(contextFor("windows")),
};

function maxPlan(skipComponents = "") {
  return createPlan((name) => {
    if (name === "cleanup-profile") return "max";
    if (name === "skip-components") return skipComponents;
    return "";
  });
}

for (const platform of ["linux", "macos", "windows"] as const) {
  test(`${platform} adapter has an operation for every declared capability`, async () => {
    const adapter = await factories[platform]();
    const expected = COMPONENTS.filter((definition) =>
      (definition.platforms as readonly string[]).includes(platform),
    ).map(({ id }) => id);
    assert.deepEqual([...adapter.supportedComponents], expected);

    for (const component of expected) {
      const operations = await adapter.operations(planFor(component));
      assert.equal(
        operations.some((operation) => operation.component === component),
        true,
        `missing ${component}`,
      );
    }
  });
}

test("platform-specific capabilities do not leak across adapters", async () => {
  const supported = async (
    platform: Platform,
  ): Promise<ReadonlySet<ComponentId>> =>
    (await factories[platform]()).supportedComponents;
  assert.equal((await supported("linux")).has("xcode"), false);
  assert.equal((await supported("macos")).has("visual-studio"), false);
  assert.equal((await supported("windows")).has("large-packages"), false);
});

test("macOS fails closed instead of guessing a runner home", async () => {
  const adapter = await createMacOSAdapter({
    ...contextFor("macos"),
    home: "/tmp/workflow-controlled-home",
  });
  await assert.rejects(
    async () => await adapter.operations(planFor("dotnet")),
    /unexpected macOS runner home/,
  );
  const nestedAdapter = await createMacOSAdapter({
    ...contextFor("macos"),
    home: "/Users/runner/project",
  });
  await assert.rejects(
    async () => await nestedAdapter.operations(planFor("dotnet")),
    /unexpected macOS runner home/,
  );
});

test("macOS ignores workflow path overrides outside exact image definitions", async () => {
  const names = [
    "ANDROID_SDK_ROOT",
    "VCPKG_INSTALLATION_ROOT",
    "CHROMEWEBDRIVER",
    "EDGEWEBDRIVER",
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.ANDROID_SDK_ROOT = "/Users/runner/Library/Android/project";
    process.env.VCPKG_INSTALLATION_ROOT = "/usr/local/share/project";
    process.env.CHROMEWEBDRIVER = "/usr/local/share/project-driver";
    process.env.EDGEWEBDRIVER = "/usr/local/share/project-edge";
    const adapter = await createMacOSAdapter(contextFor("macos"));
    const operations = await adapter.operations(
      planFor("android", "vcpkg", "webdrivers"),
    );
    const ids = operations.map(({ id }) => id).join("\n");
    assert.doesNotMatch(ids, /project/);
    assert.match(ids, /Library\/Android\/sdk/);
    assert.match(ids, /usr\/local\/share\/vcpkg/);
    assert.match(ids, /chromedriver-mac-arm64/);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Windows fails closed for a home outside the users directory", async () => {
  await assert.rejects(
    async () =>
      await createWindowsAdapter({
        ...contextFor("windows"),
        home: "C:\\Windows",
      }),
    /unexpected Windows runner home/,
  );
});

test("Windows ignores a workflow-controlled SystemDrive override", async () => {
  const original = process.env.SystemDrive;
  process.env.SystemDrive = "D:";
  try {
    const adapter = await createWindowsAdapter(contextFor("windows"));
    const operations = await adapter.operations(planFor("vcpkg", "miniconda"));
    const ids = operations.map(({ id }) => id).join("\n");
    assert.doesNotMatch(ids, /D:\\/i);
    assert.match(ids, /C:\\vcpkg/i);
    assert.equal(
      operations.some(
        ({ id, component }) =>
          id === "windows:managed-directory:miniconda:miniconda" &&
          component === "miniconda",
      ),
      true,
    );
  } finally {
    if (original === undefined) delete process.env.SystemDrive;
    else process.env.SystemDrive = original;
  }
});

test("Windows rejects a workflow-controlled home on another drive", async () => {
  await assert.rejects(
    async () =>
      await createWindowsAdapter({
        ...contextFor("windows"),
        home: "D:\\Users\\runner",
      }),
    /unexpected Windows runner home/,
  );
});

test("Windows rejects a nested workflow-controlled home", async () => {
  await assert.rejects(
    async () =>
      await createWindowsAdapter({
        ...contextFor("windows"),
        home: "C:\\Users\\runneradmin\\project",
      }),
    /unexpected Windows runner home/,
  );
});

test("Linux broad toolcache cleanup covers owner children only while enabled", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const plan = maxPlan();
  const raw = await adapter.operations(plan);
  const codeqlToolcacheId = "codeql:/opt/hostedtoolcache/CodeQL";
  assert.equal(
    raw.some(({ id }) => id === codeqlToolcacheId),
    true,
  );

  const prepared = prepareOperations(raw, plan);
  assert.equal(
    prepared.some(({ id }) => id === "cached-tools:/opt/hostedtoolcache"),
    true,
  );
  assert.equal(
    prepared.some(({ id }) => id === codeqlToolcacheId),
    false,
  );
});

test("skipping Linux cached-tools preserves its root while cleaning enabled owners", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const plan = maxPlan("cached-tools");
  const prepared = prepareOperations(await adapter.operations(plan), plan);

  assert.equal(
    prepared.some(({ component }) => component === "cached-tools"),
    false,
  );
  assert.equal(
    prepared.some(({ id }) => id === "codeql:/opt/hostedtoolcache/CodeQL"),
    true,
  );
  assert.equal(
    prepared.some(({ id }) => id === "dotnet:/opt/hostedtoolcache/dotnet"),
    true,
  );
});

test("skipping Visual Studio preserves every overlapping Windows toolchain", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = maxPlan("visual-studio");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const preserved = new Set<ComponentId>([
    "android",
    "dotnet",
    "vcpkg",
    "windows-sdk",
    "visual-studio",
  ]);

  assert.deepEqual(
    prepared
      .filter(({ component }) => preserved.has(component))
      .map(({ component }) => component),
    [],
  );
  assert.equal(
    prepared.some(({ component }) => component === "azcopy"),
    true,
  );
});

test("Windows Docker engine cleanup owns its image data without a redundant prune", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = createPlan((name) =>
    name === "cleanup-profile"
      ? "custom"
      : name === "remove-docker-engine"
        ? "true"
        : "",
  );
  const prepared = prepareOperations(await adapter.operations(plan), plan);

  assert.equal(
    prepared.some(({ id }) => id === "windows:docker:engine"),
    true,
  );
  assert.equal(
    prepared.some(({ id }) => id === "windows:docker:data"),
    true,
  );
  assert.equal(
    prepared.some(({ id }) => id === "windows:docker:prune"),
    false,
  );
  assert.equal(
    prepared.find(({ id }) => id === "windows:docker:service")?.phase,
    "preflight",
  );
  assert.equal(
    prepared.find(({ id }) => id === "windows:docker:data")?.phase,
    "filesystem",
  );
  assert.equal(
    prepared.find(({ id }) => id === "windows:docker:engine")?.phase,
    "system",
  );
});

test("Linux Docker data cleanup has a fatal service-stop precondition", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const plan = planFor("docker-engine");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const stop = prepared.find(({ id }) => id === "docker:stop");
  const data = prepared.find(
    ({ id }) => id === "docker-engine:/var/lib/docker",
  );

  assert.equal(stop?.phase, "preflight");
  assert.equal(stop?.fatal, true);
  assert.equal(data?.phase, "filesystem");
});

test("Windows service discovery distinguishes absence from unsafe query failure", () => {
  assert.equal(
    isMissingWindowsService({
      exitCode: 1060,
      stdout: "[SC] OpenService FAILED 1060: service does not exist",
      stderr: "",
    }),
    true,
  );
  for (const result of [
    { exitCode: 124, stdout: "", stderr: "" },
    { exitCode: 5, stdout: "", stderr: "Access is denied" },
  ]) {
    assert.equal(isMissingWindowsService(result), false);
  }
});

test("swapfile discovery distinguishes absence from command failure", () => {
  assert.equal(existingFileState(0), "present");
  assert.equal(existingFileState(1), "absent");
  assert.equal(existingFileState(124), "failed");
  assert.equal(existingFileState(127), "failed");
});

test("systemd verification accepts only terminal stopped states", () => {
  for (const state of ["inactive", "failed"]) {
    assert.equal(
      isStoppedSystemdUnit({ exitCode: 0, stdout: `${state}\n`, stderr: "" }),
      true,
    );
  }
  for (const result of [
    { exitCode: 0, stdout: "deactivating\n", stderr: "" },
    { exitCode: 0, stdout: "active\n", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 124, stdout: "inactive\n", stderr: "" },
    { exitCode: 1, stdout: "", stderr: "D-Bus error" },
  ]) {
    assert.equal(isStoppedSystemdUnit(result), false);
  }
});
