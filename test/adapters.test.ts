import assert from "node:assert/strict";
import test from "node:test";
import { win32 } from "node:path";
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
  createWindowsServiceCoordinator,
  executableUninstallOperation,
  isMissingWindowsService,
  isStoppedWindowsService,
  isStrictWindowsDescendant,
  managedDirectoryUninstallOperation,
  PINNED_WINDOWS_WEB_SERVICE_NAMES,
  POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
  type WindowsManagedPathProbe,
  type WindowsPathProbe,
  type WindowsServiceControl,
  windowsPaths,
  windowsDockerEngineTargets,
} from "../src/platforms/windows.js";
import { prepareOperations } from "../src/operations.js";
import { createPlan } from "../src/planner.js";
import type {
  Adapter,
  ComponentId,
  OperationResult,
  Platform,
  RuntimeContext,
} from "../src/types.js";
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

test("macOS schedules only component-owned Android, Gradle, and Azure user cleanup paths", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"));
  const plan = maxPlan();
  const prepared = prepareOperations(await adapter.operations(plan), plan);

  assert.deepEqual(
    prepared
      .filter(({ component }) => component === "android")
      .map(({ id }) => id)
      .filter((id) => id.includes(".android") || id.includes(".gradle")),
    ["android:/Users/runner/.android"],
  );
  assert.deepEqual(
    prepared.find(({ id }) => id === "gradle:/Users/runner/.gradle")?.blockedBy,
    ["android"],
  );
  assert.equal(
    prepared.some(
      ({ id }) =>
        id === "azure-cli:/Users/runner/.azure/cliextensions/azure-devops",
    ),
    true,
  );
  assert.equal(
    prepared.some(({ id }) => id === "azure-cli:/Users/runner/.azure"),
    false,
  );
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform} assigns shared Gradle user state only to the Gradle component`, async () => {
    const adapter = await factories[platform]();
    const gradleHome = `${contextFor(platform).home}/.gradle`;
    const androidPlan = planFor("android");
    const androidOperations = prepareOperations(
      await adapter.operations(androidPlan),
      androidPlan,
    );
    const gradlePlan = planFor("gradle");
    const gradleOperations = prepareOperations(
      await adapter.operations(gradlePlan),
      gradlePlan,
    );

    assert.equal(
      androidOperations.some(({ id }) => id.endsWith(gradleHome)),
      false,
      "Android-only custom cleanup must preserve shared Gradle state",
    );
    assert.equal(
      gradleOperations.some(
        ({ component, id, blockedBy }) =>
          component === "gradle" &&
          id.endsWith(gradleHome) &&
          blockedBy?.length === 1 &&
          blockedBy[0] === "android",
      ),
      true,
      "Gradle cleanup must own shared Gradle state",
    );
    assert.equal(
      prepareOperations(await adapter.operations(maxPlan()), maxPlan()).some(
        ({ id }) => id.endsWith(gradleHome),
      ),
      true,
      "default max cleanup must retain its existing Gradle-state cleanup",
    );
    for (const protectedComponent of ["android", "gradle"] as const) {
      const protectedPlan = maxPlan(protectedComponent);
      assert.equal(
        prepareOperations(
          await adapter.operations(protectedPlan),
          protectedPlan,
        ).some(({ id }) => id.endsWith(gradleHome)),
        false,
        `max cleanup must preserve Gradle state when ${protectedComponent} is protected`,
      );
    }
  });
}

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

test("Windows SDK cleanup orders standalone bundles before Visual Studio and keeps only the component fallback covered", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = planFor("visual-studio", "windows-sdk", "azcopy");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const standaloneIndex = prepared.findIndex(
    ({ id }) => id === "windows:windows-sdk:standalone-bundles",
  );
  const visualStudioIndex = prepared.findIndex(
    ({ id }) => id === "windows:visual-studio:uninstall",
  );
  const windowsSdkIndex = prepared.findIndex(
    ({ id }) => id === "windows:windows-sdk:remove-components",
  );
  const windowsSdk = prepared[windowsSdkIndex];

  assert.notEqual(standaloneIndex, -1);
  assert.notEqual(visualStudioIndex, -1);
  assert.notEqual(windowsSdkIndex, -1);
  assert.ok(standaloneIndex < visualStudioIndex);
  assert.ok(visualStudioIndex < windowsSdkIndex);
  assert.equal(
    prepared[standaloneIndex]?.coveredBySuccessfulOperations,
    undefined,
  );
  assert.deepEqual(windowsSdk?.coveredBySuccessfulOperations, [
    "windows:visual-studio:uninstall",
  ]);
  assert.equal(windowsSdk?.coveredBy, undefined);
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
      prepared.some(({ id }) => id === "windows:windows-sdk:remove-components"),
      protectedPayload !== "windows-sdk",
      "targeted SDK cleanup should remain when only the broad uninstall is blocked",
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
    prepared.find(({ id }) => id === "windows:services:stop")?.phase,
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

test("Windows Docker engine cleanup tracks current definition helpers", async () => {
  const paths = windowsPaths();
  const targets = windowsDockerEngineTargets(paths);
  const expectedTargets = [
    win32.join(paths.system32, "docker.exe"),
    win32.join(paths.system32, "dockerd.exe"),
    win32.join(paths.systemRoot, "SysWOW64", "docker.exe"),
    win32.join(paths.programData, "docker", "cli-plugins"),
    win32.join(paths.programFiles, "docker", "cli-plugins"),
    win32.join(paths.system32, "docker-credential-wincred.exe"),
  ];
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = planFor("docker-engine");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const engine = prepared.find(({ id }) => id === "windows:docker:engine");

  assert.deepEqual(targets, expectedTargets);
  assert.equal(engine?.component, "docker-engine");
  const expectedParents = new Map([
    [expectedTargets[3], win32.join(paths.programData, "docker")],
    [expectedTargets[4], win32.join(paths.programFiles, "docker")],
    [expectedTargets[5], paths.system32],
  ]);
  for (const target of expectedTargets.slice(3)) {
    assert.equal(
      targets.filter((candidate) => candidate === target).length,
      1,
      `expected exactly one Docker Engine target for ${target}`,
    );
    assert.equal(
      win32.dirname(target),
      expectedParents.get(target),
      `expected a fixed allowlist parent for ${target}`,
    );
  }
});

test("Windows Docker engine cleanup consumes every helper through injected safety boundaries", async () => {
  const paths = windowsPaths();
  const targets = windowsDockerEngineTargets(paths);
  const validated: string[] = [];
  const removed: string[] = [];
  type DockerDependencies = {
    readonly dockerEngine?: {
      readonly validateTarget?: (target: string) => Promise<void>;
      readonly removeTarget?: (target: string) => Promise<OperationResult>;
    };
  };
  const createWithDependencies = createWindowsAdapter as unknown as (
    context: RuntimeContext,
    dependencies?: DockerDependencies,
  ) => Promise<Adapter>;
  const adapter = await createWithDependencies(contextFor("windows"), {
    dockerEngine: {
      validateTarget: async (target) => {
        validated.push(target);
      },
      removeTarget: async (target) => {
        removed.push(target);
        return {
          status: target === targets[0] ? "removed" : "not-found",
        };
      },
    },
  });
  const plan = planFor("docker-engine");
  const operation = prepareOperations(
    await adapter.operations(plan),
    plan,
  ).find(({ id }) => id === "windows:docker:engine");
  assert.ok(operation?.validate);

  await operation.validate();
  assert.deepEqual(await operation.run(), { status: "removed" });
  assert.deepEqual(validated, targets);
  assert.deepEqual(removed, targets);
});

test("Linux Docker data cleanup has a fatal service-stop precondition", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const plan = planFor("docker-engine");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const stop = prepared.find(({ id }) => id === "linux:services:stop");
  const data = prepared.find(
    ({ id }) => id === "docker-engine:/var/lib/docker",
  );

  assert.equal(stop?.phase, "preflight");
  assert.equal(stop?.fatal, true);
  assert.equal(typeof stop?.validate, "function");
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
  const stop = prepared.find(({ id }) => id === "windows:services:stop");
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
      serviceId: "windows:services:stop",
      packageId: "windows:choco:apache:apache-httpd",
      residualId: "windows:residual:apache:C:\\tools\\Apache24",
    },
    {
      component: "nginx" as const,
      serviceId: "windows:services:stop",
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

test("Windows service coordination discovers the complete selected set before stopping", async () => {
  const calls: string[] = [];
  const stopped = new Set<string>();
  const inventoryOutput = [
    "SERVICE_NAME: postgresql-x64-16",
    "SERVICE_NAME: docker",
  ].join("\r\n");
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => {
      calls.push("exists");
      return true;
    },
    inventory: async () => {
      calls.push("inventory");
      return result(inventoryOutput);
    },
    query: async (name) => {
      calls.push(`query:${name}`);
      return result(
        stopped.has(name) ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      );
    },
    stop: async (name) => {
      calls.push(`stop:${name}`);
      stopped.add(name);
      return result("");
    },
    delete: async (name) => {
      calls.push(`delete:${name}`);
      return result("");
    },
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache", "nginx", "postgresql", "docker-engine"),
    control,
  );
  assert.ok(operation?.validate);
  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "removed");

  const firstStop = calls.findIndex((call) => call.startsWith("stop:"));
  assert.notEqual(firstStop, -1);
  assert.deepEqual(
    calls.slice(0, firstStop).filter((call) => call !== "exists"),
    [
      "inventory",
      "query:docker",
      "query:Apache",
      "query:nginx",
      "query:postgresql-x64-16",
      "inventory",
      "query:docker",
      "query:Apache",
      "query:nginx",
      "query:postgresql-x64-16",
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("stop:")),
    ["stop:docker", "stop:Apache", "stop:nginx", "stop:postgresql-x64-16"],
  );
  assert.equal(calls.at(-1), "delete:docker");
});

test("Windows service coordination rejects later discovery failure before any stop", async () => {
  const calls: string[] = [];
  let nginxQueries = 0;
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async (name) => {
      calls.push(`query:${name}`);
      if (name === "nginx" && ++nginxQueries === 2) {
        return result("", 5, "Access is denied");
      }
      return result("STATE : 4 RUNNING\r\n");
    },
    stop: async (name) => {
      calls.push(`stop:${name}`);
      return result("");
    },
    delete: async () => result(""),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache", "nginx"),
    control,
  );
  assert.ok(operation?.validate);
  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "failed");
  assert.equal(
    calls.some((call) => call.startsWith("stop:")),
    false,
  );
});

test("Windows service coordination rejects PostgreSQL membership changes after stop", async () => {
  let inventories = 0;
  const stopped = new Set<string>();
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => {
      inventories += 1;
      return result(
        inventories < 3
          ? "SERVICE_NAME: postgresql-x64-16\r\n"
          : "SERVICE_NAME: postgresql-x64-16\r\nSERVICE_NAME: postgresql-x64-17\r\n",
      );
    },
    query: async (name) =>
      result(
        stopped.has(name) ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      ),
    stop: async (name) => {
      stopped.add(name);
      return result("");
    },
    delete: async () => result(""),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("postgresql"),
    control,
  );
  assert.ok(operation?.validate);
  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "failed");
  assert.match(operationResult.detail ?? "", /changed or reactivated/);
});

test("Windows service coordination recognizes canonical stopped output without mutation", async () => {
  let stops = 0;
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async () => result("        STATE              : 1  STOPPED\r\n"),
    stop: async () => {
      stops += 1;
      return result("");
    },
    delete: async () => result(""),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);
  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "removed");
  assert.equal(stops, 0);
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

function windowsPathStats(
  kind: "directory" | "file",
  options: {
    readonly link?: boolean;
    readonly fileAttributes?: number;
    readonly ino?: bigint;
    readonly size?: bigint;
    readonly mtimeNs?: bigint;
  } = {},
): Awaited<ReturnType<WindowsPathProbe["lstat"]>> {
  return Object.assign(
    {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      isSymbolicLink: () => options.link ?? false,
      dev: 1n,
      ino: options.ino ?? (kind === "directory" ? 2n : 3n),
      size: options.size ?? 4n,
      mtimeNs: options.mtimeNs ?? 5n,
    },
    { fileAttributes: options.fileAttributes ?? 0 },
  );
}

function windowsPathStatsWithoutAttributes(
  kind: "directory" | "file",
  options: Parameters<typeof windowsPathStats>[1] = {},
): Awaited<ReturnType<WindowsPathProbe["lstat"]>> {
  const { fileAttributes: _fileAttributes, ...stats } = windowsPathStats(
    kind,
    options,
  );
  return stats;
}

test("Windows executable uninstall rejects ordinary-looking reparse roots and files", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  for (const reparsePath of [installationRoot, executable]) {
    let executions = 0;
    const operation = executableUninstallOperation({
      context: contextFor("windows"),
      component: "postgresql",
      id: "postgresql-reparse-test",
      description: "test PostgreSQL reparse protection",
      candidates: [{ installationRoot, executable }],
      args: ["--mode", "unattended"],
      probe: {
        lstat: async (path) =>
          windowsPathStats(path === installationRoot ? "directory" : "file", {
            fileAttributes: path === reparsePath ? 0x400 : 0,
          }),
      },
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await assert.rejects(operation.validate(), /reparse/i);
    assert.equal(executions, 0);
  }
});

test("Windows executable uninstall rejects identity drift during its attribute probe", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  let transitioned = false;
  let executions = 0;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-attribute-transition-test",
    description: "test PostgreSQL attribute transition",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) =>
        windowsPathStatsWithoutAttributes(
          path === installationRoot ? "directory" : "file",
          { ino: path === executable && transitioned ? 99n : 3n },
        ),
      fileAttributes: async (paths) => {
        transitioned = true;
        return paths.map(() => 0);
      },
    },
    execute: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);

  await assert.rejects(
    operation.validate(),
    /identity.*changed|changed.*attribute/i,
  );
  assert.equal(executions, 0);
});

test("Windows executable uninstall rejects size-only and mtime-only drift during attributes", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  for (const changedField of ["size", "mtimeNs"] as const) {
    let transitioned = false;
    let executions = 0;
    const operation = executableUninstallOperation({
      context: contextFor("windows"),
      component: "postgresql",
      id: `postgresql-${changedField}-transition-test`,
      description: `test PostgreSQL ${changedField} transition`,
      candidates: [{ installationRoot, executable }],
      args: ["--mode", "unattended"],
      probe: {
        lstat: async (path) =>
          windowsPathStatsWithoutAttributes(
            path === installationRoot ? "directory" : "file",
            {
              size:
                path === executable && transitioned && changedField === "size"
                  ? 99n
                  : 4n,
              mtimeNs:
                path === executable &&
                transitioned &&
                changedField === "mtimeNs"
                  ? 99n
                  : 5n,
            },
          ),
        fileAttributes: async (paths) => {
          transitioned = true;
          return paths.map(() => 0);
        },
      },
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);

    await assert.rejects(operation.validate(), /identity|kind.*changed/i);
    assert.equal(executions, 0);
  }
});

test("Windows executable uninstall spawns adjacent to its explicit-attribute observation", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  const events: string[] = [];
  let attributeCalls = 0;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-attribute-adjacency-test",
    description: "test PostgreSQL attribute adjacency",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        events.push(`lstat:${path}`);
        return windowsPathStatsWithoutAttributes(
          path === installationRoot ? "directory" : "file",
        );
      },
      fileAttributes: async (paths) => {
        attributeCalls += 1;
        events.push(`attributes:${paths.join("|")}`);
        return paths.map(() => 0);
      },
    },
    execute: async () => {
      assert.deepEqual(events.slice(-3), [
        `attributes:${installationRoot}|${executable}`,
        `lstat:${installationRoot}`,
        `lstat:${executable}`,
      ]);
      events.push("execute");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  assert.equal((await operation.run()).status, "removed");
  assert.equal(attributeCalls, 3);
  assert.equal(events.filter((event) => event === "execute").length, 1);
});

test("Windows executable uninstall stabilizes a present root when its child is missing", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  let transitioned = false;
  let executions = 0;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-missing-child-transition-test",
    description: "test PostgreSQL missing child transition",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        if (path === executable) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return windowsPathStatsWithoutAttributes("directory", {
          ino: transitioned ? 99n : 2n,
        });
      },
      fileAttributes: async (paths) => {
        transitioned = true;
        return paths.map(() => 0);
      },
    },
    execute: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);

  await assert.rejects(operation.validate(), /identity.*changed/i);
  assert.equal(executions, 0);
});

test("Windows executable uninstall preflights all roots and executable types before spawn", async () => {
  const safeRoot = "C:\\Program Files\\Mozilla Firefox";
  const safeExecutable = `${safeRoot}\\uninstall\\helper.exe`;
  const unsafeRoot = "C:\\Program Files (x86)\\Mozilla Firefox";
  const unsafeExecutable = `${unsafeRoot}\\uninstall\\helper.exe`;
  for (const unsafePath of [unsafeRoot, unsafeExecutable]) {
    let executions = 0;
    const probe: WindowsPathProbe = {
      lstat: async (path) => {
        if (path === safeRoot || path === unsafeRoot) {
          return windowsPathStats("directory", {
            link: path === unsafePath,
          });
        }
        assert.ok(path === safeExecutable || path === unsafeExecutable);
        return windowsPathStats("file", { link: path === unsafePath });
      },
    };
    const operation = executableUninstallOperation({
      context: contextFor("windows"),
      component: "firefox",
      id: "firefox-test",
      description: "test Firefox",
      candidates: [
        { installationRoot: safeRoot, executable: safeExecutable },
        { installationRoot: unsafeRoot, executable: unsafeExecutable },
      ],
      args: ["/S"],
      probe,
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await assert.rejects(
      operation.validate(),
      /unexpected (installation root|executable) type/,
    );
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(
      result.detail ?? "",
      /unexpected (installation root|executable) type/,
    );
    assert.equal(executions, 0);
  }
});

test("Windows executable uninstall rejects root and file replacement immediately before spawn", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  for (const replacedPath of [installationRoot, executable]) {
    let replacementChecks = 0;
    let executed = false;
    const probe: WindowsPathProbe = {
      lstat: async (path) => {
        assert.ok(path === installationRoot || path === executable);
        const kind = path === installationRoot ? "directory" : "file";
        if (path !== replacedPath) return windowsPathStats(kind);
        replacementChecks += 1;
        return windowsPathStats(kind, {
          ino: replacementChecks < 3 ? 3n : 99n,
        });
      },
    };
    const operation = executableUninstallOperation({
      context: contextFor("windows"),
      component: "postgresql",
      id: "postgresql-17-test",
      description: "test PostgreSQL",
      candidates: [{ installationRoot, executable }],
      args: ["--mode", "unattended"],
      probe,
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /changed immediately before spawn/);
    assert.equal(executed, false);
  }
});

test("Windows executable uninstall preserves missing and reboot-required exit semantics", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  const missing = (): NodeJS.ErrnoException =>
    Object.assign(new Error("missing"), { code: "ENOENT" });
  for (const missingPath of [installationRoot, executable]) {
    let executed = false;
    const operation = executableUninstallOperation({
      context: contextFor("windows"),
      component: "postgresql",
      id: "postgresql-17-test",
      description: "test PostgreSQL",
      candidates: [{ installationRoot, executable }],
      args: ["--mode", "unattended"],
      probe: {
        lstat: async (path) => {
          if (path === missingPath) throw missing();
          assert.equal(path, installationRoot);
          return windowsPathStats("directory");
        },
      },
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();
    assert.equal((await operation.run()).status, "not-found");
    assert.equal(executed, false);
  }

  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-17-test",
    description: "test PostgreSQL",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) =>
        windowsPathStats(path === installationRoot ? "directory" : "file"),
    },
    execute: async () => ({ exitCode: 3010, stdout: "", stderr: "" }),
  });
  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
});

test("Windows managed uninstall rejects a junction root and linked uninstaller", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  for (const probe of [
    {
      lstat: async (path: string) => {
        assert.equal(path, root);
        return windowsPathStats("directory", { link: true });
      },
    },
    {
      lstat: async (path: string) => {
        if (path === root) return windowsPathStats("directory");
        assert.equal(path, executable);
        return windowsPathStats("file", { link: true });
      },
    },
  ] satisfies readonly WindowsManagedPathProbe[]) {
    let executed = false;
    const operation = managedDirectoryUninstallOperation({
      context: contextFor("windows"),
      component: "miniconda",
      id: "miniconda-test",
      description: "test Miniconda",
      target: root,
      uninstaller: "Uninstall-Miniconda3.exe",
      args: ["/S"],
      probe,
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await assert.rejects(operation.validate(), /unexpected target type/);
    assert.equal(executed, false);
  }
});

test("Windows managed uninstall rejects ordinary-looking reparse roots and files", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  for (const reparsePath of [root, executable]) {
    let executions = 0;
    const operation = managedDirectoryUninstallOperation({
      context: contextFor("windows"),
      component: "miniconda",
      id: "miniconda-reparse-test",
      description: "test Miniconda reparse protection",
      target: root,
      uninstaller: "Uninstall-Miniconda3.exe",
      args: ["/S"],
      probe: {
        lstat: async (path) =>
          windowsPathStats(path === root ? "directory" : "file", {
            fileAttributes: path === reparsePath ? 0x400 : 0,
          }),
      },
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await assert.rejects(operation.validate(), /reparse/i);
    assert.equal(executions, 0);
  }
});

test("Windows managed uninstall rejects identity drift during its attribute probe", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  let transitioned = false;
  let executions = 0;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-attribute-transition-test",
    description: "test Miniconda attribute transition",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) =>
        windowsPathStatsWithoutAttributes(
          path === root ? "directory" : "file",
          {
            ino: path === executable && transitioned ? 99n : 3n,
          },
        ),
      fileAttributes: async (paths) => {
        transitioned = true;
        return paths.map(() => 0);
      },
    },
    execute: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);

  await assert.rejects(
    operation.validate(),
    /identity.*changed|changed.*attribute/i,
  );
  assert.equal(executions, 0);
});

test("Windows managed uninstall rejects size-only and mtime-only drift during attributes", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  for (const changedField of ["size", "mtimeNs"] as const) {
    let transitioned = false;
    let executions = 0;
    const operation = managedDirectoryUninstallOperation({
      context: contextFor("windows"),
      component: "miniconda",
      id: `miniconda-${changedField}-transition-test`,
      description: `test Miniconda ${changedField} transition`,
      target: root,
      uninstaller: "Uninstall-Miniconda3.exe",
      args: ["/S"],
      probe: {
        lstat: async (path) =>
          windowsPathStatsWithoutAttributes(
            path === root ? "directory" : "file",
            {
              size:
                path === executable && transitioned && changedField === "size"
                  ? 99n
                  : 4n,
              mtimeNs:
                path === executable &&
                transitioned &&
                changedField === "mtimeNs"
                  ? 99n
                  : 5n,
            },
          ),
        fileAttributes: async (paths) => {
          transitioned = true;
          return paths.map(() => 0);
        },
      },
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);

    await assert.rejects(operation.validate(), /identity|kind.*changed/i);
    assert.equal(executions, 0);
  }
});

test("Windows managed uninstall spawns adjacent to its explicit-attribute observation", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  const events: string[] = [];
  let attributeCalls = 0;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-attribute-adjacency-test",
    description: "test Miniconda attribute adjacency",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) => {
        events.push(`lstat:${path}`);
        return windowsPathStatsWithoutAttributes(
          path === root ? "directory" : "file",
        );
      },
      fileAttributes: async (paths) => {
        attributeCalls += 1;
        events.push(`attributes:${paths.join("|")}`);
        return paths.map(() => 0);
      },
    },
    execute: async () => {
      assert.deepEqual(events.slice(-3), [
        `attributes:${root}|${executable}`,
        `lstat:${root}`,
        `lstat:${executable}`,
      ]);
      events.push("execute");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  assert.equal((await operation.run()).status, "removed");
  assert.equal(attributeCalls, 2);
  assert.equal(events.filter((event) => event === "execute").length, 1);
});

test("Windows managed uninstall does not treat attribute-time ENOENT as initial child absence", async () => {
  const root = "C:\\Miniconda";
  let attributeCalls = 0;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-attribute-enoent-test",
    description: "test Miniconda attribute ENOENT",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) =>
        windowsPathStatsWithoutAttributes(path === root ? "directory" : "file"),
      fileAttributes: async (paths) => {
        attributeCalls += 1;
        if (attributeCalls === 1) {
          throw Object.assign(new Error("changed during attributes"), {
            code: "ENOENT",
          });
        }
        return paths.map(() => 0);
      },
    },
  });
  assert.ok(operation.validate);

  await assert.rejects(operation.validate(), /changed during attributes/);
  assert.equal(attributeCalls, 1);
});

test("Windows managed uninstall rechecks file identity immediately before spawn", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  let executableChecks = 0;
  let executed = false;
  const probe: WindowsManagedPathProbe = {
    lstat: async (path) => ({
      isDirectory: () => path === root,
      isFile: () => path === executable,
      isSymbolicLink: () => false,
      dev: 1n,
      ino: path === root ? 2n : ++executableChecks === 1 ? 3n : 99n,
      size: 4n,
      mtimeNs: 5n,
      fileAttributes: 0,
    }),
  };
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-test",
    description: "test Miniconda",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe,
    execute: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
  assert.equal(executed, false);
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
