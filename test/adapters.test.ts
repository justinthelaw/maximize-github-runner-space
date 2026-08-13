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
  classifyPostgreSqlServiceInventory,
  createWindowsAdapter,
  isMissingWindowsService,
  isStoppedWindowsService,
  isStrictWindowsDescendant,
  PINNED_WINDOWS_WEB_SERVICE_NAMES,
  POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
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

for (const protectedPayload of [
  "android",
  "dotnet",
  "vcpkg",
  "windows-sdk",
] as const satisfies readonly ComponentId[]) {
  test(`skipping Windows ${protectedPayload} blocks the broad Visual Studio uninstall`, async () => {
    const adapter = await createWindowsAdapter(contextFor("windows"));
    const plan = maxPlan(protectedPayload);
    const operations = await adapter.operations(plan);

    assert.equal(
      operations.some(({ id }) => id === "windows:visual-studio:uninstall"),
      true,
      "adapter must offer the broad uninstall before overlap filtering",
    );

    const prepared = prepareOperations(operations, plan);
    assert.equal(
      prepared.some(({ component }) => component === "visual-studio"),
      false,
    );
    assert.equal(
      prepared.some(({ component }) => component === protectedPayload),
      false,
    );
    assert.equal(
      prepared.some(({ component }) => component === "azcopy"),
      true,
    );
  });
}

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
    {
      exitCode: 1,
      stdout: "[SC] OpenService FAILED 1060: service does not exist",
      stderr: "",
    },
    { exitCode: 124, stdout: "", stderr: "" },
    { exitCode: 5, stdout: "", stderr: "Access is denied" },
  ]) {
    assert.equal(isMissingWindowsService(result), false);
  }
});

test("Windows PostgreSQL service discovery requests and accepts a complete bounded inventory", () => {
  assert.deepEqual(POSTGRESQL_SERVICE_QUERY_ARGUMENTS, [
    "query",
    "type=",
    "service",
    "state=",
    "all",
    "bufsize=",
    "262144",
  ]);
  const inventory = [
    "SERVICE_NAME: postgresql-x64-17",
    "SERVICE_NAME: PostgreSQL-x64-14.2",
    "SERVICE_NAME: postgresql-x64-17",
    "SERVICE_NAME: docker",
  ].join("\r\n");
  assert.deepEqual(classifyPostgreSqlServiceInventory(inventory), {
    status: "complete",
    serviceNames: ["PostgreSQL-x64-14.2", "postgresql-x64-17"],
  });
});

test("Windows PostgreSQL service discovery fails closed on incomplete or unrecognized inventory", () => {
  const unsafeInventories = [
    "",
    "Enum: more data, need 1048576 bytes start resume at index 42",
    "SERVICE_NAME: docker\r\nEnumQueryServicesStatus: more data",
    "SERVICE_NAME: postgresql-x64-17\r\nresume at index 42",
    "SERVICE_NAME: docker\r\nRESUME_INDEX=42",
    "SERVICE_NAME: postgresql-evil",
    "SERVICE_NAME: postgresql-x64-17 & whoami",
    "SERVICE_NAME: PostgreSQL Backup",
  ];
  for (const inventory of unsafeInventories) {
    assert.equal(
      classifyPostgreSqlServiceInventory(inventory).status,
      "unsafe",
      inventory,
    );
  }
});

test("Visual Studio discovery accepts only strict definition-root descendants", () => {
  const root = "C:\\Program Files\\Microsoft Visual Studio";
  assert.equal(
    isStrictWindowsDescendant(
      "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
      root,
    ),
    true,
  );
  assert.equal(isStrictWindowsDescendant(root, root), false);
  assert.equal(
    isStrictWindowsDescendant(
      "C:\\Program Files\\Microsoft Visual Studio Evil\\2022",
      root,
    ),
    false,
  );
});

test("Windows service state parsing requires a successful STOPPED response", () => {
  assert.equal(
    isStoppedWindowsService({
      exitCode: 0,
      stdout: "        STATE              : 1  STOPPED\r\n",
      stderr: "",
    }),
    true,
  );
  for (const result of [
    { exitCode: 1, stdout: "STATE : 1 STOPPED", stderr: "" },
    { exitCode: 0, stdout: "STATE : 4 RUNNING", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
  ]) {
    assert.equal(isStoppedWindowsService(result), false);
  }
});

test("Windows PostgreSQL cleanup has a fatal service-stop precondition", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const prepared = prepareOperations(
    await adapter.operations(planFor("postgresql")),
    planFor("postgresql"),
  );
  const stop = prepared.find(({ id }) => id === "windows:postgresql:services");
  assert.equal(stop?.phase, "preflight");
  assert.equal(stop?.fatal, true);
});

test("Windows Apache and Nginx cleanup have exact fatal service-stop preconditions", async () => {
  assert.deepEqual(PINNED_WINDOWS_WEB_SERVICE_NAMES, {
    apache: "Apache",
    nginx: "nginx",
  });
  for (const expected of [
    {
      component: "apache" as const,
      serviceId: "windows:apache:service",
      packageId: "windows:choco:apache:apache-httpd",
      residualId: "windows:residual:apache:C:\\tools\\Apache24",
    },
    {
      component: "nginx" as const,
      serviceId: "windows:nginx:service",
      packageId: "windows:choco:nginx:nginx",
    },
  ]) {
    const adapter = await createWindowsAdapter(contextFor("windows"));
    const plan = planFor(expected.component);
    const prepared = prepareOperations(await adapter.operations(plan), plan);
    const serviceIndex = prepared.findIndex(
      ({ id }) => id === expected.serviceId,
    );
    const packageIndex = prepared.findIndex(
      ({ id }) => id === expected.packageId,
    );
    const service = prepared[serviceIndex];

    assert.notEqual(serviceIndex, -1);
    assert.notEqual(packageIndex, -1);
    assert.equal(service?.component, expected.component);
    assert.equal(service?.phase, "preflight");
    assert.equal(service?.fatal, true);
    assert.equal(prepared[packageIndex]?.phase, "package");
    assert.ok(serviceIndex < packageIndex);

    if (expected.residualId !== undefined) {
      const residualIndex = prepared.findIndex(
        ({ id }) => id === expected.residualId,
      );
      assert.notEqual(residualIndex, -1);
      assert.equal(prepared[residualIndex]?.phase, "system");
      assert.ok(serviceIndex < residualIndex);
    }
  }
});

test("Windows manual path removers participate in complete-plan validation", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = planFor("miniconda", "php", "docker-engine");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const manualPathOperations = prepared.filter(({ id }) =>
    [
      "windows:managed-directory:miniconda:miniconda",
      "windows:residual:php:C:\\tools\\php",
      "windows:docker:engine",
    ].includes(id),
  );
  assert.equal(manualPathOperations.length, 3);
  assert.equal(
    manualPathOperations.every(({ validate }) => validate !== undefined),
    true,
  );
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
