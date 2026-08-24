import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPONENTS } from "../src/components.js";
import {
  clearCommandTerminationUnconfirmed,
  markCommandTerminationUnconfirmed,
  UnconfirmedCommandTerminationError,
} from "../src/command.js";
import {
  createLinuxAdapter,
  createLinuxDockerPruneOperation,
  createLinuxToolCacheRecreateOperation,
  existingFileState,
  isStoppedSystemdUnit,
  LINUX_PACKAGE_EXECUTABLES,
} from "../src/platforms/linux.js";
import { createMacOSAdapter } from "../src/platforms/macos.js";
import {
  classifyPostgreSqlServiceInventory,
  assertWindowsDirectoryChain,
  createWindowsDockerPruneOperation,
  createWindowsDockerEngineOperation as createWindowsDockerEngineOperationImpl,
  createWindowsDockerServiceLifecycle,
  createWindowsChocolateyOperation,
  createWindowsInventoryBudget,
  createWindowsMsiOperation,
  createWindowsSdkBundleOperation,
  createWindowsSdkComponentOperation,
  createWindowsVisualStudioOperation,
  createWindowsAdapter,
  createWindowsServiceRegistrationCleanup as createWindowsServiceRegistrationCleanupImpl,
  createWindowsServiceCoordinator as createWindowsServiceCoordinatorImpl,
  createWindowsToolCacheRecreateOperation,
  executableUninstallOperation,
  isMissingWindowsService,
  isStoppedWindowsService,
  isStrictWindowsDescendant,
  guardWindowsServiceOperation,
  inspectWindowsServiceExecutable,
  listChocolateyPackages,
  listMsiProducts,
  listVisualStudioInstances,
  listWindowsUninstallRecords,
  listWindowsVersionedDirectories,
  managedDirectoryUninstallOperation,
  parseAndValidateWindowsServiceExecutable,
  parseWindowsUninstallRecords,
  PINNED_WINDOWS_WEB_SERVICE_NAMES,
  POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
  UNINSTALL_REGISTRY_ROOTS,
  type WindowsManagedPathProbe,
  type WindowsPathProbe,
  type WindowsDockerEngineDependencies,
  type WindowsDockerServiceLifecycle,
  type WindowsPaths,
  type WindowsServiceControl,
  windowsInstallerExitDisposition,
  windowsPaths,
} from "../src/platforms/windows.js";
import {
  createFunctionOperation,
  executeOperations,
  prepareOperations,
  type RemovePathDependencies,
} from "../src/operations.js";
import { createPlan } from "../src/planner.js";
import type {
  Adapter,
  CleanupPlan,
  ComponentId,
  Platform,
  RuntimeContext,
} from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

const factories: Readonly<Record<Platform, () => Promise<Adapter>>> = {
  linux: async () => await createLinuxAdapter(contextFor("linux")),
  macos: async () => await createMacOSAdapter(contextFor("macos")),
  windows: async () => await createWindowsAdapter(contextFor("windows")),
};

test("Windows versioned inventories bound all inspected entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-windows-versions-"));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  await Promise.all(
    Array.from(
      { length: 257 },
      async (_, index) => await mkdir(join(root, `unrelated-${index}`)),
    ),
  );

  await assert.rejects(
    async () => await listWindowsVersionedDirectories(root, /^version-\d+$/),
    /exceeded 256 inspected entries/,
  );
});

test("Windows command inventories enforce one aggregate wall deadline", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };

  let visualStudioNow = 0;
  let visualStudioCommands = 0;
  await assert.rejects(
    async () =>
      await listVisualStudioInstances(paths, {
        now: () => visualStudioNow,
        inspectExecutable: async () => {
          visualStudioNow = 120_001;
          return identity;
        },
        runCommand: async () => {
          visualStudioCommands += 1;
          return { exitCode: 0, stdout: "[]", stderr: "" };
        },
      }),
    /two-minute aggregate deadline/,
  );
  assert.equal(visualStudioCommands, 0);

  let registryNow = 0;
  let registryCommands = 0;
  await assert.rejects(
    async () =>
      await listWindowsUninstallRecords(paths, {
        now: () => registryNow,
        inspectExecutable: async () => identity,
        runCommand: async () => {
          registryCommands += 1;
          registryNow = 120_001;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    /two-minute aggregate deadline/,
  );
  assert.equal(registryCommands, 1);
});

test("Windows command inventories can share one debited operation budget", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let now = 0;
  const budget = createWindowsInventoryBudget({ now: () => now });
  const dependencies = {
    now: () => now,
    inventoryBudget: budget,
    inspectExecutable: async () => identity,
    runCommand: async () => {
      now += 70_000;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    },
  };

  await listVisualStudioInstances(paths, dependencies);
  await assert.rejects(
    async () => await listVisualStudioInstances(paths, dependencies),
    /two-minute aggregate deadline/,
  );

  now = 0;
  const registryBudget = createWindowsInventoryBudget({ now: () => now });
  const registryDependencies = {
    now: () => now,
    inventoryBudget: registryBudget,
    inspectExecutable: async () => identity,
    runCommand: async () => {
      now += 35_000;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await listWindowsUninstallRecords(paths, registryDependencies);
  await assert.rejects(
    async () => await listWindowsUninstallRecords(paths, registryDependencies),
    /two-minute aggregate deadline/,
  );
});

test("Windows MSI selection is capped before executable probes", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const products = Array.from({ length: 17 }, (_, index) => {
    const suffix = index.toString(16).padStart(12, "0");
    const productCode = `{00000000-0000-0000-0000-${suffix}}`;
    return {
      registryKey: `${UNINSTALL_REGISTRY_ROOTS[0]}\\${productCode}`,
      productCode,
      displayName: "GitHub CLI",
      windowsInstaller: 1 as const,
    };
  });
  let executableProbes = 0;
  const operation = createWindowsMsiOperation(
    paths,
    "gh-cli",
    [/^GitHub CLI$/],
    async () => ({ products, registryExecutable: identity }),
    "bounded-selection",
    "Bounded MSI selection",
    {
      inspectExecutable: async () => {
        executableProbes += 1;
        return identity;
      },
    },
  );
  assert.ok(operation.validate);

  await assert.rejects(operation.validate, /exceeded 16 products/);
  assert.equal(executableProbes, 0);
});

function maxPlan(skipComponents = "") {
  return createPlan((name) => {
    if (name === "cleanup-profile") return "max";
    if (name === "skip-components") return skipComponents;
    return "";
  });
}

function testWindowsServiceConfiguration(serviceName: string) {
  const paths = windowsPaths();
  const postgresqlVersion = /^postgresql-x64-(\d+(?:\.\d+)*)$/i.exec(
    serviceName,
  )?.[1];
  const executable =
    serviceName.toLowerCase() === "docker"
      ? `${paths.system32}\\dockerd.exe --run-service`
      : serviceName.toLowerCase() === "apache"
        ? `${paths.drive}\\tools\\Apache24\\bin\\httpd.exe -k runservice`
        : serviceName.toLowerCase() === "nginx"
          ? `${paths.drive}\\tools\\nginx-1.31.3\\nginx.exe -s run`
          : postgresqlVersion !== undefined
            ? `"${paths.programFiles}\\PostgreSQL\\${postgresqlVersion}\\bin\\pg_ctl.exe" runservice`
            : undefined;
  if (executable === undefined) {
    throw new Error(`unexpected test service: ${serviceName}`);
  }
  return {
    exitCode: 0,
    stdout: `BINARY_PATH_NAME : ${executable}\r\n`,
    stderr: "",
  };
}

const TEST_WINDOWS_SERVICE_IDENTITY_CONTROL = {
  config: async (serviceName: string) =>
    testWindowsServiceConfiguration(serviceName),
  inspectExecutable: async () => ({
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
  }),
};

const TEST_WINDOWS_SERVICE_CONTROLS = new WeakMap<
  WindowsServiceControl,
  WindowsServiceControl
>();

function withTestWindowsServiceStartLatch(
  control: WindowsServiceControl,
  defaultStartType: 2 | 3 | 4 = 2,
  latchWhenStopped = false,
): WindowsServiceControl {
  const cached = TEST_WINDOWS_SERVICE_CONTROLS.get(control);
  if (cached !== undefined) return cached;
  const startTypes = new Map<string, 2 | 3 | 4>();
  const startTypeValue = (
    setting: "auto" | "delayed-auto" | "demand" | "disabled",
  ) =>
    setting === "auto" || setting === "delayed-auto"
      ? 2
      : setting === "demand"
        ? 3
        : 4;
  const startTypeLine = (value: 2 | 3 | 4): string =>
    `START_TYPE : ${value} ${value === 2 ? "AUTO_START" : value === 3 ? "DEMAND_START" : "DISABLED"}\r\n`;
  const wrapped: WindowsServiceControl = {
    ...control,
    query: async (serviceName: string, timeoutMs?: number) => {
      const result = await control.query(serviceName, timeoutMs);
      if (latchWhenStopped && isStoppedWindowsService(result)) {
        startTypes.set(serviceName, 4);
      }
      return result;
    },
    ...(control.config === undefined
      ? {}
      : {
          config: async (serviceName: string, timeoutMs?: number) => {
            const result = await control.config?.(serviceName, timeoutMs);
            if (
              result === undefined ||
              result.exitCode !== 0 ||
              /^\s*START_TYPE\s*:/im.test(result.stdout)
            ) {
              if (result === undefined) {
                throw new Error("test service configuration is unavailable");
              }
              return result;
            }
            return {
              ...result,
              stdout: `${startTypeLine(startTypes.get(serviceName) ?? defaultStartType)}${result.stdout}`,
            };
          },
          configureStart: async (
            serviceName: string,
            setting: "auto" | "delayed-auto" | "demand" | "disabled",
            timeoutMs?: number,
          ) => {
            const result =
              control.configureStart === undefined
                ? { exitCode: 0, stdout: "", stderr: "" }
                : await control.configureStart(serviceName, setting, timeoutMs);
            if (result.exitCode === 0) {
              startTypes.set(serviceName, startTypeValue(setting));
            }
            return result;
          },
        }),
  };
  TEST_WINDOWS_SERVICE_CONTROLS.set(control, wrapped);
  return wrapped;
}

function createWindowsServiceCoordinator(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control?: WindowsServiceControl,
  lifecycle?: WindowsDockerServiceLifecycle,
) {
  return createWindowsServiceCoordinatorImpl(
    paths,
    plan,
    control === undefined
      ? undefined
      : withTestWindowsServiceStartLatch(control),
    lifecycle,
  );
}

function createWindowsServiceRegistrationCleanup(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control?: WindowsServiceControl,
  lifecycle?: WindowsDockerServiceLifecycle,
) {
  return createWindowsServiceRegistrationCleanupImpl(
    paths,
    plan,
    control === undefined
      ? undefined
      : withTestWindowsServiceStartLatch(control, 2, true),
    lifecycle,
  );
}

function createWindowsDockerEngineOperation(
  context: RuntimeContext,
  paths: WindowsPaths,
  dependencies: WindowsDockerEngineDependencies = {},
) {
  return createWindowsDockerEngineOperationImpl(context, paths, {
    ...dependencies,
    ...(dependencies.control === undefined
      ? {}
      : {
          control: withTestWindowsServiceStartLatch(dependencies.control, 4),
        }),
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
    assert.match(ids, /android:\/Users\/runner\/\.android/);
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

test("Windows cleanup covers documented active-user tools and caches", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const operations = await adapter.operations(
    planFor("dotnet", "android", "miniconda", "vcpkg"),
  );
  const expected = [
    ["dotnet", "C:\\Users\\runneradmin\\.dotnet"],
    ["android", "C:\\Users\\runneradmin\\.android"],
    ["miniconda", "C:\\Users\\runneradmin\\.conda"],
    ["miniconda", "C:\\Users\\runneradmin\\AppData\\Local\\conda"],
    ["vcpkg", "C:\\Users\\runneradmin\\.vcpkg"],
    ["vcpkg", "C:\\Users\\runneradmin\\AppData\\Local\\vcpkg"],
  ] as const;

  for (const [component, target] of expected) {
    assert.equal(
      operations.some(
        (operation) =>
          operation.component === component &&
          operation.id === `windows:path:${component}:${target}`,
      ),
      true,
      `missing ${component} cleanup for ${target}`,
    );
  }
});

test("Windows native command environment excludes workflow redirection variables", () => {
  const paths = windowsPaths();
  const environment = paths.commandEnvironment;
  assert.equal(
    environment.PATH,
    "C:\\Windows\\System32;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System;C:\\Windows",
  );
  assert.equal(environment.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(environment.DOCKER_HOST, undefined);
  assert.equal(environment.DOCKER_CONTEXT, undefined);
  assert.equal(environment.PSModulePath, undefined);
  assert.equal(environment.ChocolateyInstall, undefined);
  assert.equal(environment.NoDefaultCurrentDirectoryInExePath, "1");
  assert.match(paths.chocolateyEnvironment.PATH ?? "", /chocolatey\\bin$/i);
  assert.equal(
    paths.chocolateyEnvironment.ChocolateyInstall,
    "C:\\ProgramData\\chocolatey",
  );
  assert.equal(paths.installerEnvironment.ProgramW6432, "C:\\Program Files");
  assert.equal(
    paths.installerEnvironment.LOCALAPPDATA,
    "C:\\Users\\runneradmin\\AppData\\Local",
  );
  assert.equal(
    windowsPaths("C:\\Users\\runneradmin", "arm64").installerEnvironment
      .PROCESSOR_ARCHITECTURE,
    "ARM64",
  );
});

test("Windows native command environment canonicalizes the validated runner home", () => {
  const environment = windowsPaths(
    "C:\\Users\\workflow-controlled\\..\\runneradmin",
  ).commandEnvironment;
  assert.equal(environment.USERPROFILE, "C:\\Users\\runneradmin");
  assert.equal(environment.HOMEDRIVE, "C:");
  assert.equal(environment.HOMEPATH, "\\Users\\runneradmin");
});

test("Windows Chocolatey inventory failures abort complete-plan discovery", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  for (const result of [
    { exitCode: 5, stdout: "", stderr: "Access is denied" },
    {
      exitCode: 0,
      stdout: "azcopy10|10.0.0\n",
      stderr: "",
      stdoutTruncated: true,
    },
    {
      exitCode: 0,
      stdout: "unexpected successful inventory output\n",
      stderr: "",
    },
  ]) {
    await assert.rejects(
      async () =>
        await listChocolateyPackages(
          paths.chocolatey,
          paths.commandEnvironment,
          {
            inspectExecutable: async () => identity,
            runCommand: async () => result,
          },
        ),
      /Access is denied|safe output bound|unsafe package inventory record/,
    );
  }
  let commands = 0;
  await assert.rejects(
    async () =>
      await listChocolateyPackages(paths.chocolatey, paths.commandEnvironment, {
        inspectExecutable: async () => undefined,
        runCommand: async () => {
          commands += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    /Chocolatey executable is unavailable/,
  );
  assert.equal(commands, 0);
});

test("Windows Chocolatey inventory rejects a known executable replacement before launch", async () => {
  const paths = windowsPaths();
  const original = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const replacement = { ...original, ino: 99n };
  let commands = 0;
  const dependencies = {
    expectedInventoryExecutable: original,
    inspectExecutable: async () => replacement,
    runCommand: async () => {
      commands += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await assert.rejects(
    async () =>
      await listChocolateyPackages(
        paths.chocolatey,
        paths.chocolateyEnvironment,
        dependencies,
      ),
    /Chocolatey executable changed before package inventory/,
  );
  assert.equal(commands, 0);
});

test("Windows Chocolatey uninstall rejects package-version drift", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let uninstallCalls = 0;
  const operation = createWindowsChocolateyOperation(
    paths,
    "azcopy",
    ["azcopy10"],
    async () => ({
      packages: new Set(["azcopy10"]),
      versions: new Map([["azcopy10", "1.0.0"]]),
      executable: identity,
    }),
    undefined,
    {
      inspectExecutable: async () => identity,
      runCommand: async (_executable, args) => {
        if (args[0] === "uninstall") uninstallCalls += 1;
        return {
          exitCode: 0,
          stdout: "azcopy10|2.0.0\n",
          stderr: "",
        };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
  assert.equal(uninstallCalls, 0);
});

test("Windows Chocolatey uninstall pins version and verifies absence", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let listCalls = 0;
  let uninstallArguments: readonly string[] | undefined;
  const operation = createWindowsChocolateyOperation(
    paths,
    "azcopy",
    ["azcopy10"],
    async () => ({
      packages: new Set(["azcopy10"]),
      versions: new Map([["azcopy10", "1.0.0"]]),
      executable: identity,
    }),
    undefined,
    {
      inspectExecutable: async () => identity,
      runCommand: async (_executable, args) => {
        if (args[0] === "uninstall") {
          uninstallArguments = args;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        listCalls += 1;
        return {
          exitCode: 0,
          stdout: listCalls === 1 ? "azcopy10|1.0.0\n" : "",
          stderr: "",
        };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(uninstallArguments, [
    "uninstall",
    "azcopy10",
    "--version",
    "1.0.0",
    "--exact",
    "--yes",
    "--no-progress",
    "--limit-output",
  ]);
});

test("Windows Chocolatey final inventory never launches a replacement executable", async () => {
  const paths = windowsPaths();
  const original = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const replacement = { ...original, ino: 99n };
  let replaced = false;
  let replacementInventoryCommands = 0;
  const operation = createWindowsChocolateyOperation(
    paths,
    "azcopy",
    ["azcopy10"],
    async () => ({
      packages: new Set(["azcopy10"]),
      versions: new Map([["azcopy10", "1.0.0"]]),
      executable: original,
    }),
    undefined,
    {
      inspectExecutable: async () => (replaced ? replacement : original),
      runCommand: async (_executable, args) => {
        if (args[0] === "uninstall") {
          replaced = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (replaced) replacementInventoryCommands += 1;
        return {
          exitCode: 0,
          stdout: replaced ? "" : "azcopy10|1.0.0\n",
          stderr: "",
        };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  await assert.rejects(
    operation.run,
    /Chocolatey executable changed before package inventory/,
  );
  assert.equal(replacementInventoryCommands, 0);
});

test("Windows MSI discovery excludes HKCU and distinguishes absence from command failure", async () => {
  assert.deepEqual(UNINSTALL_REGISTRY_ROOTS, [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]);
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const missing = await listMsiProducts(paths, {
    inspectExecutable: async () => identity,
    runCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "ERROR: The system was unable to find the specified registry key or value.",
    }),
  });
  assert.deepEqual(missing.products, []);

  await assert.rejects(
    async () =>
      await listMsiProducts(paths, {
        inspectExecutable: async () => identity,
        runCommand: async () => ({
          exitCode: 124,
          stdout: "",
          stderr: "registry query timed out",
        }),
      }),
    /registry query timed out/,
  );
  await assert.rejects(
    async () =>
      await listMsiProducts(paths, {
        inspectExecutable: async () => identity,
        runCommand: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "ERROR: Access is denied.",
        }),
      }),
    /Access is denied/,
  );

  await assert.rejects(
    async () =>
      await listMsiProducts(paths, {
        inspectExecutable: async () => undefined,
      }),
    /reg\.exe is unavailable/,
  );

  const productKey =
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{01234567-89AB-CDEF-0123-456789ABCDEF}";
  const found = await listMsiProducts(paths, {
    inspectExecutable: async () => identity,
    runCommand: async () => ({
      exitCode: 0,
      stderr: "",
      stdout: [
        productKey,
        "    DisplayName    REG_SZ    Google Chrome",
        "    WindowsInstaller    REG_DWORD    0x1",
      ].join("\r\n"),
    }),
  });
  assert.deepEqual(found.products, [
    {
      registryKey: productKey,
      productCode: "{01234567-89AB-CDEF-0123-456789ABCDEF}",
      displayName: "Google Chrome",
      windowsInstaller: 1,
    },
  ]);
});

test("Windows MSI discovery rejects conflicting cross-root product identities", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const productCode = "{01234567-89AB-CDEF-0123-456789ABCDEF}";

  await assert.rejects(
    async () =>
      await listMsiProducts(paths, {
        inspectExecutable: async () => identity,
        runCommand: async (_executable, args) => {
          const root = args[1] ?? "";
          const wow = root.includes("WOW6432Node");
          return {
            exitCode: 0,
            stderr: "",
            stdout: [
              `HKEY_LOCAL_MACHINE\\${wow ? "SOFTWARE\\WOW6432Node" : "SOFTWARE"}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productCode}`,
              `    DisplayName    REG_SZ    ${wow ? "Workflow Impostor" : "Google Chrome"}`,
              "    WindowsInstaller    REG_DWORD    0x1",
            ].join("\r\n"),
          };
        },
      }),
    /conflicting.*product code|duplicate.*product code/i,
  );
});

test("Windows uninstall parsing rejects malformed classification fields", () => {
  const productKey =
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{01234567-89AB-CDEF-0123-456789ABCDEF}";
  for (const lines of [
    [
      productKey,
      "    DisplayName    REG_SZ    Google Chrome",
      "    WindowsInstaller    REG_SZ    1",
    ],
    [
      productKey,
      "    DisplayName    REG_SZ    Google Chrome",
      "    WindowsInstaller    REG_DWORD    not-a-number",
    ],
    [
      productKey,
      "    DisplayName    REG_SZ    Google Chrome",
      "    WindowsInstaller    REG_DWORD    0x1",
      "    WindowsInstaller    REG_DWORD    0x0",
    ],
  ]) {
    assert.throws(
      () => parseWindowsUninstallRecords(lines.join("\r\n")),
      /WindowsInstaller.*(?:type|value|duplicate)/i,
    );
  }
});

test("Windows MSI uninstall rejects exact registry product drift", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const registryKey =
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{01234567-89AB-CDEF-0123-456789ABCDEF}";
  const product = {
    registryKey,
    productCode: "{01234567-89AB-CDEF-0123-456789ABCDEF}",
    displayName: "Google Chrome",
    windowsInstaller: 1 as const,
  };
  let msiexecCalls = 0;
  const operation = createWindowsMsiOperation(
    paths,
    "chrome",
    [/^Google Chrome$/i],
    async () => ({ products: [product], registryExecutable: identity }),
    "google-chrome-test",
    "Uninstall test Chrome MSI",
    {
      inspectExecutable: async () => identity,
      runCommand: async (executable) => {
        if (executable === paths.msiexec) msiexecCalls += 1;
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            registryKey,
            "    DisplayName    REG_SZ    Workflow Impostor",
            "    WindowsInstaller    REG_DWORD    0x1",
          ].join("\r\n"),
        };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /registry identity changed/);
  assert.equal(msiexecCalls, 0);
});

test("Windows MSI uninstall treats restart-initiated exit 1641 as terminal", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const registryKey =
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{01234567-89AB-CDEF-0123-456789ABCDEF}";
  const product = {
    registryKey,
    productCode: "{01234567-89AB-CDEF-0123-456789ABCDEF}",
    displayName: "Google Chrome",
    windowsInstaller: 1 as const,
  };
  let registryQueries = 0;
  const operation = createWindowsMsiOperation(
    paths,
    "chrome",
    [/^Google Chrome$/i],
    async () => ({ products: [product], registryExecutable: identity }),
    "google-chrome-test",
    "Uninstall test Chrome MSI",
    {
      inspectExecutable: async () => identity,
      runCommand: async (executable) => {
        if (executable === paths.msiexec) {
          return { exitCode: 1641, stdout: "", stderr: "" };
        }
        registryQueries += 1;
        if (registryQueries >= 2) {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "ERROR: The system was unable to find the specified registry key or value.",
          };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            registryKey,
            "    DisplayName    REG_SZ    Google Chrome",
            "    WindowsInstaller    REG_DWORD    0x1",
          ].join("\r\n"),
        };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.equal(result.abortAction, true);
  assert.match(result.detail ?? "", /initiating a system restart/);
  assert.equal(registryQueries, 1);
});

test("Windows installer exit classification accepts only completed outcomes", () => {
  assert.equal(windowsInstallerExitDisposition(0), "completed");
  assert.equal(windowsInstallerExitDisposition(3010), "restart-required");
  assert.equal(windowsInstallerExitDisposition(1641), "restart-initiated");
  assert.equal(windowsInstallerExitDisposition(1), "failed");
});

test("Windows SDK bundle cleanup validates cache path and registry postcondition", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const registryKey =
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{01234567-89AB-CDEF-0123-456789ABCDEF}";
  const executable =
    "C:\\ProgramData\\Package Cache\\{01234567-89AB-CDEF-0123-456789ABCDEF}\\winsdksetup.exe";
  const record = {
    registryKey,
    displayName: "Windows Software Development Kit - Windows 10.0.26100.7705",
    displayVersion: "10.1.26100.7705",
    bundleCachePath: executable,
  };
  let registryQueries = 0;
  const bundleCalls: { executable: string; args: readonly string[] }[] = [];
  const operation = createWindowsSdkBundleOperation(
    paths,
    async () => ({ records: [record], registryExecutable: identity }),
    {
      inspectExecutable: async () => identity,
      pathProbe: {
        lstat: async () => windowsPathStats("directory"),
      },
      runCommand: async (command, args) => {
        if (command === executable) {
          bundleCalls.push({ executable: command, args });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        registryQueries += 1;
        if (registryQueries >= 2) {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "ERROR: The system was unable to find the specified registry key or value.",
          };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            registryKey,
            `    DisplayName    REG_SZ    ${record.displayName}`,
            `    DisplayVersion    REG_SZ    ${record.displayVersion}`,
            `    BundleCachePath    REG_SZ    ${executable}`,
          ].join("\r\n"),
        };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(bundleCalls, [
    {
      executable,
      args: ["/uninstall", "/quiet", "/norestart"],
    },
  ]);
});

test("Windows SDK bundle cleanup rejects executables outside Package Cache", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const operation = createWindowsSdkBundleOperation(
    paths,
    async () => ({
      registryExecutable: identity,
      records: [
        {
          registryKey:
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sdk",
          displayName:
            "Windows Software Development Kit - Windows 10.0.26100.7705",
          bundleCachePath: "C:\\workflow\\winsdksetup.exe",
        },
      ],
    }),
    {
      inspectExecutable: async () => identity,
      pathProbe: { lstat: async () => windowsPathStats("directory") },
    },
  );

  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /outside Package Cache/);
});

test("Windows SDK bundle inventory rejects excess records before path probes", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const records = Array.from({ length: 17 }, (_, index) => ({
    registryKey: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sdk-${index}`,
    displayName: `Windows Software Development Kit - Windows 10.0.26100.${index}`,
    bundleCachePath: `C:\\ProgramData\\Package Cache\\sdk-${index}\\winsdksetup.exe`,
  }));
  let pathProbes = 0;
  let executableInspections = 0;
  const operation = createWindowsSdkBundleOperation(
    paths,
    async () => ({ records, registryExecutable: identity }),
    {
      inspectExecutable: async () => {
        executableInspections += 1;
        return identity;
      },
      pathProbe: {
        lstat: async () => {
          pathProbes += 1;
          return windowsPathStats("directory");
        },
      },
    },
  );

  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /exceeded 16 records/);
  assert.equal(pathProbes, 0);
  assert.equal(executableInspections, 0);
});

test("Windows SDK bundle inventory bounds the inventory provider and probes together", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let now = 0;
  let pathProbes = 0;
  const operation = createWindowsSdkBundleOperation(
    paths,
    async () => {
      now = 120_001;
      return { records: [], registryExecutable: identity };
    },
    {
      now: () => now,
      inspectExecutable: async () => identity,
      pathProbe: {
        lstat: async () => {
          pathProbes += 1;
          return windowsPathStats("directory");
        },
      },
    },
  );

  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /two-minute aggregate deadline/);
  assert.equal(pathProbes, 0);
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

test("Windows SDK cleanup includes independent standalone bundles", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = planFor("visual-studio", "windows-sdk", "azcopy");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const visualStudioIndex = prepared.findIndex(
    ({ id }) => id === "windows:visual-studio:uninstall",
  );
  const windowsSdkIndex = prepared.findIndex(
    ({ id }) => id === "windows:windows-sdk:remove-components",
  );
  const windowsSdk = prepared[windowsSdkIndex];
  const standaloneIndex = prepared.findIndex(
    ({ id }) => id === "windows:windows-sdk:standalone-bundles",
  );

  assert.notEqual(visualStudioIndex, -1);
  assert.notEqual(windowsSdkIndex, -1);
  assert.notEqual(standaloneIndex, -1);
  assert.ok(visualStudioIndex < windowsSdkIndex);
  assert.ok(windowsSdkIndex < standaloneIndex);
  assert.equal(windowsSdk?.coveredBySuccessfulOperations, undefined);
  assert.equal(windowsSdk?.coveredBy, undefined);
  assert.equal(
    prepared.some(({ component }) => component === "azcopy"),
    true,
  );
});

test("Windows MySQL cleanup reflects the runner image's CLI-only installation", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const operations = (await adapter.operations(planFor("mysql"))).filter(
    ({ component }) => component === "mysql",
  );

  assert.deepEqual(
    operations.map(({ id }) => id),
    ["windows:msi:mysql:mysql-server-8"],
  );
  assert.equal(
    operations[0]?.description,
    "Uninstall runner-image MySQL CLI MSI",
  );
});

test("Windows PowerShell cleanup preserves shared all-users module stores", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const operations = (await adapter.operations(planFor("powershell"))).filter(
    ({ component }) => component === "powershell",
  );

  assert.equal(
    operations.some(({ id }) => id === "windows:msi:powershell:powershell-7"),
    true,
  );
  assert.equal(
    operations.some(({ id }) =>
      id.toLowerCase().startsWith("windows:path:powershell:c:\\modules"),
    ),
    false,
  );
  assert.equal(
    operations.some(({ id }) =>
      id
        .toLowerCase()
        .startsWith(
          "windows:path:powershell:c:\\program files\\windowspowershell\\modules",
        ),
    ),
    false,
  );
});

test("Windows Maven cleanup preserves the shared ProgramData repository", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const operations = (await adapter.operations(planFor("maven"))).filter(
    ({ component }) => component === "maven",
  );

  assert.equal(
    operations.some(({ id }) => id === "windows:choco:maven:maven"),
    true,
  );
  assert.equal(
    operations.some(
      ({ id }) =>
        id.toLowerCase() ===
        "windows:path:maven:c:\\programdata\\m2".toLowerCase(),
    ),
    false,
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
  const plan = planFor("docker-engine", "docker-images");
  const prepared = prepareOperations(await adapter.operations(plan), plan);

  assert.equal(
    prepared.some(({ id }) => id === "windows:docker:engine"),
    true,
  );
  assert.equal(
    prepared.some(({ id }) => id === "windows:docker:data"),
    false,
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
    prepared.find(({ id }) => id === "windows:docker:engine")?.phase,
    "system",
  );
});

test("Linux Docker engine cleanup owns its image data without a redundant prune", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const plan = planFor("docker-engine", "docker-images");
  const prepared = prepareOperations(await adapter.operations(plan), plan);

  assert.equal(
    prepared.some(({ id }) => id === "docker:prune"),
    false,
  );
  assert.equal(
    prepared.find(({ id }) => id === "linux:services:stop")?.phase,
    "preflight",
  );
});

test("Windows Docker prune pins its executable and isolates client configuration", async () => {
  const paths = windowsPaths();
  const calls: {
    executable: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv | undefined;
  }[] = [];
  let removedConfig: string | undefined;
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const operation = createWindowsDockerPruneOperation(paths, {
    inspectExecutable: async () => identity,
    inspectConfigDirectory: async () => identity,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, environment: options.env });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    createConfigDirectory: async () =>
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    removeConfigDirectory: async (path) => {
      removedConfig = path;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, "C:\\Windows\\System32\\docker.exe");
    assert.deepEqual(call.args.slice(0, 4), [
      "--host",
      "npipe:////./pipe/docker_engine",
      "--config",
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    ]);
    assert.equal(
      call.environment?.DOCKER_HOST,
      "npipe:////./pipe/docker_engine",
    );
    assert.equal(call.environment?.DOCKER_CONTEXT, undefined);
    assert.equal(
      call.environment?.DOCKER_CONFIG,
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    );
  }
  assert.equal(
    removedConfig,
    "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
  );
});

test("Windows Docker default config cleanup uses the locked removal boundary", async () => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "maximize-windows-docker-config-"),
  );
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const dependencies = {
    context: contextFor("windows"),
    inspectExecutable: async () => identity,
    inspectConfigDirectory: async () => ({ ...identity, ino: 8n }),
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    createConfigDirectory: async () => configDirectory,
  };
  const operation = createWindowsDockerPruneOperation(
    windowsPaths(),
    dependencies,
  );

  try {
    assert.ok(operation.validate);
    await operation.validate();
    await assert.rejects(operation.run, /outside|locked removal boundary/);
    await stat(configDirectory);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("Windows Docker pins the original config identity inside locked removal", async () => {
  const configDirectory =
    "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test";
  const original = { dev: 1n, ino: 2n, size: 0n, mtimeNs: 4n };
  let lockedRemovals = 0;
  const dependencies = {
    context: contextFor("windows"),
    inspectExecutable: async () => original,
    inspectConfigDirectory: async () => original,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    createConfigDirectory: async () => configDirectory,
    captureConfigBoundary: async () => ({
      targetExists: true,
      entries: [
        {
          path: configDirectory,
          device: original.dev,
          inode: 99n,
          mode: 0n,
        },
      ],
    }),
    removeConfigTarget: async (
      target: string,
      allowedParents: readonly string[],
      context: ReturnType<typeof contextFor>,
      removalDependencies: RemovePathDependencies = {},
    ) => {
      lockedRemovals += 1;
      assert.ok(removalDependencies.boundary);
      await removalDependencies.boundary(target, allowedParents, context);
      return { status: "removed" as const };
    },
  };
  const operation = createWindowsDockerPruneOperation(
    windowsPaths(),
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  await assert.rejects(operation.run, /identity changed before locked removal/);
  assert.equal(lockedRemovals, 1);
});

test("Windows Docker prune rejects executable replacement before mutation", async () => {
  const paths = windowsPaths();
  let checks = 0;
  let pruneCalled = false;
  const operation = createWindowsDockerPruneOperation(paths, {
    inspectExecutable: async () => ({
      dev: 1n,
      ino: ++checks >= 4 ? 99n : 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    runCommand: async (_executable, args) => {
      if (args.includes("prune")) pruneCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    createConfigDirectory: async () =>
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    inspectConfigDirectory: async () => ({
      dev: 1n,
      ino: 8n,
      size: 0n,
      mtimeNs: 4n,
    }),
    removeConfigDirectory: async () => undefined,
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed before image mutation/);
  assert.equal(pruneCalled, false);
});

test("Windows Docker prune reports an executable removed after validation", async () => {
  let checks = 0;
  const operation = createWindowsDockerPruneOperation(windowsPaths(), {
    inspectExecutable: async () =>
      ++checks === 1 ? { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n } : undefined,
    inspectConfigDirectory: async () => ({
      dev: 1n,
      ino: 8n,
      size: 0n,
      mtimeNs: 4n,
    }),
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
});

test("Windows Docker prune rejects config injection before mutation", async () => {
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let configInspections = 0;
  let pruneCalled = false;
  const operation = createWindowsDockerPruneOperation(windowsPaths(), {
    inspectExecutable: async () => identity,
    inspectConfigDirectory: async () => {
      configInspections += 1;
      if (configInspections >= 2) {
        throw new Error("isolated Docker configuration is not empty");
      }
      return { ...identity, ino: 8n };
    },
    runCommand: async (_executable, args) => {
      if (args.includes("prune")) pruneCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    createConfigDirectory: async () =>
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    removeConfigDirectory: async () => undefined,
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configuration is not empty/);
  assert.equal(pruneCalled, false);
});

test("Windows Docker timeout is a failure, not an unavailable daemon", async () => {
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const operation = createWindowsDockerPruneOperation(windowsPaths(), {
    inspectExecutable: async () => identity,
    inspectConfigDirectory: async () => ({ ...identity, ino: 8n }),
    runCommand: async () => ({
      exitCode: 124,
      stdout: "",
      stderr: "timed out",
    }),
    createConfigDirectory: async () =>
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    removeConfigDirectory: async () => undefined,
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /timed out/);
});

test("Windows Docker does not remove isolated configuration after a fatal timeout latch", async () => {
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const fatal = new UnconfirmedCommandTerminationError(
    "simulated Windows Docker timeout",
  );
  let removals = 0;
  const operation = createWindowsDockerPruneOperation(windowsPaths(), {
    inspectExecutable: async () => identity,
    inspectConfigDirectory: async () => ({ ...identity, ino: 8n }),
    runCommand: async (_executable, args) => {
      if (args.includes("prune")) {
        markCommandTerminationUnconfirmed(fatal.message);
        throw fatal;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    createConfigDirectory: async () =>
      "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
    removeConfigDirectory: async () => {
      removals += 1;
    },
  });

  try {
    assert.ok(operation.validate);
    await operation.validate();
    await assert.rejects(operation.run, (error) => error === fatal);
    assert.equal(removals, 0);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

for (const [stderr, expectedStatus] of [
  [
    "error during connect: open //./pipe/docker_engine: The system cannot find the file specified.",
    "unsupported",
  ],
  ["error during connect: access is denied", "failed"],
] as const) {
  test(`Windows Docker classifies exit 1 as ${expectedStatus} for ${stderr}`, async () => {
    const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
    const operation = createWindowsDockerPruneOperation(windowsPaths(), {
      inspectExecutable: async () => identity,
      inspectConfigDirectory: async () => ({ ...identity, ino: 8n }),
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr }),
      createConfigDirectory: async () =>
        "C:\\Windows\\Temp\\maximize-github-runner-space-docker-test",
      removeConfigDirectory: async () => undefined,
    });

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === "failed")
      assert.match(result.detail ?? "", /access is denied/);
  });
}

test("Linux Docker prune treats stable executable absence as not found", async () => {
  let commands = 0;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async () => undefined,
    runCommand: async () => {
      commands += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    runElevated: async () => {
      commands += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "not-found");
  assert.equal(commands, 0);
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

test("Linux toolcache recreation is fatal and requires pinned utilities", async () => {
  const operation = createLinuxToolCacheRecreateOperation(
    contextFor("linux"),
    "/opt/hostedtoolcache",
    { inspectExecutable: async () => undefined },
  );

  assert.ok(operation);
  assert.equal(operation.fatal, true);
  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /mkdir executable is unavailable/);
});

test("Linux toolcache recreation rechecks mkdir immediately before elevation", async () => {
  const identity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  let mkdirInspections = 0;
  let elevatedCalls = 0;
  const operation = createLinuxToolCacheRecreateOperation(
    contextFor("linux"),
    "/opt/hostedtoolcache",
    {
      inspectExecutable: async (executable) =>
        executable.endsWith("/mkdir") && ++mkdirInspections >= 3
          ? { ...identity, inode: 99n }
          : identity,
      createDirectory: async () => {
        throw new Error("permission denied");
      },
      runElevated: async () => {
        elevatedCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.ok(operation?.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /mkdir executable changed before use/);
  assert.equal(elevatedCalls, 0);
});

test("Linux toolcache recreation repairs ownership and verifies writability", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-toolcache-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const target = join(root, "hostedtoolcache");
  const identity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  let accessChecks = 0;
  const elevated: string[] = [];
  const operation = createLinuxToolCacheRecreateOperation(
    contextFor("linux"),
    target,
    {
      inspectExecutable: async () => identity,
      createDirectory: async (path) => {
        await mkdir(path, { recursive: true });
      },
      accessDirectory: async (path, mode) => {
        accessChecks += 1;
        if (accessChecks === 1) {
          throw Object.assign(new Error("not writable"), { code: "EACCES" });
        }
        await access(path, mode);
      },
      runElevated: async (_context, executable) => {
        elevated.push(executable);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.ok(operation?.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(accessChecks, 2);
  assert.deepEqual(elevated, [LINUX_PACKAGE_EXECUTABLES.chown]);
  assert.equal((await stat(target)).isDirectory(), true);
  await access(target, constants.W_OK | constants.X_OK);
});

test("Linux toolcache recreation fails when ownership repair is still not writable", async () => {
  const identity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxToolCacheRecreateOperation(
    contextFor("linux"),
    "/opt/hostedtoolcache",
    {
      inspectExecutable: async () => identity,
      createDirectory: async () => undefined,
      accessDirectory: async () => {
        throw Object.assign(new Error("not writable"), { code: "EACCES" });
      },
      runElevated: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  );

  assert.ok(operation?.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /not writable/);
});

test("Windows toolcache recreation is fatal", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = planFor("cached-tools");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const recreation = prepared.find(
    ({ id }) => id === "windows:toolcache:recreate",
  );

  assert.equal(recreation?.phase, "system");
  assert.equal(recreation?.fatal, true);
  assert.equal(typeof recreation?.validate, "function");
});

test("Windows toolcache recreation verifies directory writability", async () => {
  const operation = createWindowsToolCacheRecreateOperation(
    contextFor("windows"),
    "C:\\hostedtoolcache\\windows",
    {
      createDirectory: async () => undefined,
      accessDirectory: async () => {
        throw Object.assign(new Error("toolcache is not writable"), {
          code: "EACCES",
        });
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /not writable/);
});

test("Windows selected toolcache cleanup rejects missing or wrong runner context", async () => {
  for (const toolCache of [undefined, "C:\\workflow\\toolcache"]) {
    const adapter = await createWindowsAdapter({
      ...contextFor("windows"),
      toolCache,
    });
    await assert.rejects(
      async () => await adapter.operations(planFor("cached-tools")),
      /RUNNER_TOOL_CACHE.*C:\\hostedtoolcache\\windows/i,
    );
  }

  const unrelated = await createWindowsAdapter({
    ...contextFor("windows"),
    toolCache: undefined,
  });
  assert.ok((await unrelated.operations(planFor("azcopy"))).length > 0);
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

  const oversized = Array.from(
    { length: 17 },
    (_, index) => `SERVICE_NAME: postgresql-x64-${index + 1}`,
  ).join("\r\n");
  const classified = classifyPostgreSqlServiceInventory(oversized);
  assert.equal(classified.status, "unsafe");
  assert.match(
    classified.status === "unsafe" ? classified.detail : "",
    /exceeded 16 services/i,
  );
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

test("Visual Studio discovery rejects reparse points in an accepted path", async () => {
  const root = "C:\\Program Files\\Microsoft Visual Studio";
  const candidate = `${root}\\2022\\Enterprise`;
  const probe: WindowsPathProbe = {
    lstat: async (path) =>
      windowsPathStats("directory", {
        link: path.toLowerCase() === `${root}\\2022`.toLowerCase(),
      }),
  };
  await assert.rejects(
    async () => await assertWindowsDirectoryChain(candidate, root, probe),
    /reparse point/,
  );
});

test("Windows service executable inspection rejects reparse-point ancestors", async () => {
  const paths = windowsPaths();
  const executable = `${paths.drive}\\tools\\Apache24\\bin\\httpd.exe`;
  const linkedDirectory = `${paths.drive}\\tools\\Apache24`.toLowerCase();
  const probe: WindowsPathProbe = {
    lstat: async (path) =>
      windowsPathStats(path === executable ? "file" : "directory", {
        link: path.toLowerCase() === linkedDirectory,
      }),
  };

  await assert.rejects(
    async () => await inspectWindowsServiceExecutable(paths, executable, probe),
    /reparse point/,
  );
});

test("Windows service executable inspection rejects non-directory ancestors", async () => {
  const paths = windowsPaths();
  const executable = `${paths.drive}\\tools\\Apache24\\bin\\httpd.exe`;
  const replacedDirectory = `${paths.drive}\\tools\\Apache24`.toLowerCase();
  const probe: WindowsPathProbe = {
    lstat: async (path) =>
      windowsPathStats(
        path.toLowerCase() === replacedDirectory
          ? "file"
          : path === executable
            ? "file"
            : "directory",
      ),
  };

  await assert.rejects(
    async () => await inspectWindowsServiceExecutable(paths, executable, probe),
    /non-directory/,
  );
});

test("Visual Studio inventory rejects silent target omission above its bound", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const records = Array.from({ length: 9 }, (_, index) => ({
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise${index}`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  }));
  let pathProbes = 0;
  await assert.rejects(
    async () =>
      await listVisualStudioInstances(paths, {
        inspectExecutable: async () => identity,
        pathProbe: {
          lstat: async () => {
            pathProbes += 1;
            return windowsPathStats("directory");
          },
        },
        runCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify(records),
          stderr: "",
        }),
      }),
    /exceeded 8 instances/,
  );
  assert.equal(pathProbes, 0);
});

test("Visual Studio inventory rejects malformed Enterprise records and ignores only explicit other products", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const installationPath = `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`;
  const inventoryFor = async (records: readonly unknown[]) =>
    await listVisualStudioInstances(paths, {
      inspectExecutable: async () => identity,
      pathProbe: { lstat: async () => windowsPathStats("directory") },
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(records),
        stderr: "",
      }),
    });

  assert.deepEqual(
    (
      await inventoryFor([
        {
          productId: "Microsoft.VisualStudio.Product.Community",
          installationPath: "not-an-absolute-path",
        },
      ])
    ).instances,
    [],
  );
  await assert.rejects(
    async () =>
      await inventoryFor([
        {
          productId: "Microsoft.VisualStudio.Product.Enterprise",
          installationPath,
        },
      ]),
    /malformed Visual Studio Enterprise record/,
  );
  await assert.rejects(
    async () =>
      await inventoryFor([
        {
          installationPath,
          installationVersion: "17.14.0",
        },
      ]),
    /unclassified Visual Studio record/,
  );
});

test("Visual Studio inventory rejects a known vswhere replacement before launch", async () => {
  const paths = windowsPaths();
  const original = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const replacement = { ...original, ino: 99n };
  let commands = 0;
  const dependencies = {
    expectedInventoryExecutable: original,
    inspectExecutable: async () => replacement,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async () => {
      commands += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    },
  };

  await assert.rejects(
    async () => await listVisualStudioInstances(paths, dependencies),
    /vswhere\.exe changed before Visual Studio inventory/,
  );
  assert.equal(commands, 0);
});

test("Visual Studio uninstall requires instance disappearance after success", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  const dependencies = {
    inspectExecutable: async () => identity,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async (executable: string) =>
      executable === paths.vswhere
        ? {
            exitCode: 0,
            stdout: JSON.stringify([record]),
            stderr: "",
          }
        : { exitCode: 0, stdout: "", stderr: "" },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsVisualStudioOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /remained registered/);
});

test("Visual Studio uninstall rejects a replaced vswhere executable before mutation", async () => {
  const paths = windowsPaths();
  const originalVswhere = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const replacementVswhere = { dev: 1n, ino: 99n, size: 3n, mtimeNs: 4n };
  const setupIdentity = { dev: 1n, ino: 3n, size: 5n, mtimeNs: 6n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  let vswhereReplaced = false;
  let installerCalls = 0;
  let replacementVswhereCalls = 0;
  const dependencies = {
    inspectExecutable: async (executable: string) =>
      executable === paths.vswhere
        ? vswhereReplaced
          ? replacementVswhere
          : originalVswhere
        : setupIdentity,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async (executable: string) => {
      if (executable === paths.vswhere) {
        if (vswhereReplaced) replacementVswhereCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify([record]),
          stderr: "",
        };
      }
      installerCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsVisualStudioOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  vswhereReplaced = true;
  await assert.rejects(operation.run, /vswhere\.exe changed/);
  assert.equal(installerCalls, 0);
  assert.equal(replacementVswhereCalls, 0);
});

test("Visual Studio SDK modify requires component disappearance", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  const dependencies = {
    inspectExecutable: async () => identity,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async (executable: string) =>
      executable === paths.vswhere
        ? {
            exitCode: 0,
            stdout: JSON.stringify([record]),
            stderr: "",
          }
        : { exitCode: 0, stdout: "", stderr: "" },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsSdkComponentOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /components remained registered/);
});

test("Visual Studio SDK modify fails if the selected instance disappears", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  let modified = false;
  const dependencies = {
    inspectExecutable: async () => identity,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async (executable: string) => {
      if (executable === paths.vswhere) {
        return {
          exitCode: 0,
          stdout: JSON.stringify(modified ? [] : [record]),
          stderr: "",
        };
      }
      modified = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsSdkComponentOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /instance disappeared/);
});

test("Visual Studio SDK modify preserves the selected directory identity", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  let modified = false;
  const dependencies = {
    inspectExecutable: async () => identity,
    pathProbe: {
      lstat: async (path: string) =>
        windowsPathStats("directory", {
          ino:
            modified &&
            path.toLowerCase() === record.installationPath.toLowerCase()
              ? 99n
              : 2n,
        }),
    },
    runCommand: async (executable: string, args: readonly string[]) => {
      if (executable === paths.vswhere) {
        const filtersComponents = args.includes("-requires");
        return {
          exitCode: 0,
          stdout: JSON.stringify(modified && filtersComponents ? [] : [record]),
          stderr: "",
        };
      }
      modified = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsSdkComponentOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /instance identity changed/);
});

test("Visual Studio SDK modify accepts metadata drift on the preserved directory", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  let modified = false;
  const dependencies = {
    inspectExecutable: async () => identity,
    pathProbe: {
      lstat: async () =>
        windowsPathStats("directory", { mtimeNs: modified ? 99n : 5n }),
    },
    runCommand: async (executable: string, args: readonly string[]) => {
      if (executable === paths.vswhere) {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            modified && args.includes("-requires") ? [] : [record],
          ),
          stderr: "",
        };
      }
      modified = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsSdkComponentOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "removed", result.detail ?? "SDK removal failed");
});

test("Visual Studio SDK postconditions reject a replaced vswhere executable", async () => {
  const paths = windowsPaths();
  const originalVswhere = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const replacementVswhere = { dev: 1n, ino: 99n, size: 3n, mtimeNs: 4n };
  const setupIdentity = { dev: 1n, ino: 3n, size: 5n, mtimeNs: 6n };
  const record = {
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  };
  let modified = false;
  let vswhereReplaced = false;
  let installerCalls = 0;
  let replacementVswhereCalls = 0;
  const dependencies = {
    inspectExecutable: async (executable: string) =>
      executable === paths.vswhere
        ? vswhereReplaced
          ? replacementVswhere
          : originalVswhere
        : setupIdentity,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async (executable: string, args: readonly string[]) => {
      if (executable === paths.vswhere) {
        if (vswhereReplaced) replacementVswhereCalls += 1;
        const filtersComponents = args.includes("-requires");
        return {
          exitCode: 0,
          stdout: JSON.stringify(modified && filtersComponents ? [] : [record]),
          stderr: "",
        };
      }
      installerCalls += 1;
      modified = true;
      vswhereReplaced = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsSdkComponentOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  await assert.rejects(operation.run, /vswhere\.exe changed/);
  assert.equal(installerCalls, 1);
  assert.equal(replacementVswhereCalls, 0);
});

test("Windows SDK component inventory covers current VS17 and VS18 definitions", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const records = [
    {
      installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise`,
      installationVersion: "17.14.0",
      productId: "Microsoft.VisualStudio.Product.Enterprise",
    },
    {
      installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\18\\Enterprise`,
      installationVersion: "18.0.0",
      productId: "Microsoft.VisualStudio.Product.Enterprise",
    },
  ];
  const modified = new Set<string>();
  const inventoryArguments: string[][] = [];
  const modifyArguments: string[][] = [];
  const dependencies = {
    inspectExecutable: async () => identity,
    pathProbe: { lstat: async () => windowsPathStats("directory") },
    runCommand: async (executable: string, args: readonly string[]) => {
      if (executable === paths.vswhere) {
        if (args.includes("-requires")) inventoryArguments.push([...args]);
        const visible = args.includes("-requires")
          ? records.filter(
              ({ installationPath }) =>
                !modified.has(installationPath.toLowerCase()),
            )
          : records;
        return {
          exitCode: 0,
          stdout: JSON.stringify(visible),
          stderr: "",
        };
      }
      modifyArguments.push([...args]);
      const installPathIndex = args.indexOf("--installPath");
      const installationPath = args[installPathIndex + 1];
      assert.ok(installationPath);
      modified.add(installationPath.toLowerCase());
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const inventory = async () =>
    await listVisualStudioInstances(paths, dependencies);
  const operation = createWindowsSdkComponentOperation(
    paths,
    inventory,
    dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(modified.size, 2);
  assert.equal(
    inventoryArguments.every((args) =>
      args.includes("Microsoft.VisualStudio.Component.Windows10SDK"),
    ),
    true,
  );
  assert.equal(
    modifyArguments.every((args) => {
      const componentIndex = args.indexOf(
        "Microsoft.VisualStudio.Component.Windows10SDK",
      );
      return componentIndex > 0 && args[componentIndex - 1] === "--remove";
    }),
    true,
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

test("Windows service discovery binds names to definition-owned executables", () => {
  const paths = windowsPaths();
  assert.equal(
    parseAndValidateWindowsServiceExecutable(
      paths,
      "docker-engine",
      "docker",
      "BINARY_PATH_NAME : C:\\Windows\\System32\\dockerd.exe --run-service",
    ),
    "C:\\Windows\\System32\\dockerd.exe",
  );
  assert.equal(
    parseAndValidateWindowsServiceExecutable(
      paths,
      "apache",
      "Apache",
      "BINARY_PATH_NAME : C:\\tools\\Apache24\\bin\\httpd.exe -k runservice",
    ),
    "C:\\tools\\Apache24\\bin\\httpd.exe",
  );
  assert.equal(
    parseAndValidateWindowsServiceExecutable(
      paths,
      "nginx",
      "nginx",
      "BINARY_PATH_NAME : C:\\tools\\nginx-1.31.3\\nginx.exe -s run",
    ),
    "C:\\tools\\nginx-1.31.3\\nginx.exe",
  );
  assert.equal(
    parseAndValidateWindowsServiceExecutable(
      paths,
      "postgresql",
      "postgresql-x64-17",
      'BINARY_PATH_NAME : "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe" runservice',
    ),
    "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe",
  );
  assert.throws(
    () =>
      parseAndValidateWindowsServiceExecutable(
        paths,
        "apache",
        "Apache",
        "BINARY_PATH_NAME : C:\\workflow\\httpd.exe -k runservice",
      ),
    /outside its runner-image installation root/,
  );
  assert.throws(
    () =>
      parseAndValidateWindowsServiceExecutable(
        paths,
        "postgresql",
        "postgresql-x64-17",
        "BINARY_PATH_NAME : C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe runservice",
      ),
    /unquoted executable path/,
  );
  for (const [component, serviceName, commandLine] of [
    [
      "apache",
      "Apache",
      "C:\\tools\\Apache24\\workflow-owned\\httpd.exe -k runservice",
    ],
    ["nginx", "nginx", "C:\\tools\\workflow-owned\\nginx.exe -s run"],
    [
      "nginx",
      "nginx",
      "C:\\tools\\nginx-1.31.3\\workflow-owned\\nginx.exe -s run",
    ],
    [
      "postgresql",
      "postgresql-x64-17",
      '"C:\\Program Files\\PostgreSQL\\16\\bin\\pg_ctl.exe" runservice',
    ],
  ] as const) {
    assert.throws(
      () =>
        parseAndValidateWindowsServiceExecutable(
          paths,
          component,
          serviceName,
          `BINARY_PATH_NAME : ${commandLine}`,
        ),
      /outside its runner-image installation root/,
    );
  }
});

test("Windows service discovery rejects a final executable inspection overrun", async () => {
  let now = 0;
  let stops = 0;
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    query: async () => ({
      exitCode: 0,
      stdout: "STATE : 4 RUNNING\r\n",
      stderr: "",
    }),
    inspectExecutable: async () => {
      now = 120_001;
      return { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
    },
    stop: async () => {
      stops += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);

  await assert.rejects(operation.validate, /two-minute aggregate deadline/);
  assert.equal(stops, 0);
});

test("Windows service coordination disables before stop and restores before restart", async () => {
  const paths = windowsPaths();
  let running = true;
  let startType: 2 | 3 | 4 = 2;
  const events: string[] = [];
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const startTypeOutput = () =>
    `START_TYPE : ${startType} ${startType === 2 ? "AUTO_START" : startType === 3 ? "DEMAND_START" : "DISABLED"}\r\n`;
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    config: async () =>
      result(
        `${startTypeOutput()}BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    configureStart: async (_serviceName, setting) => {
      events.push(`configure:${setting}`);
      startType =
        setting === "auto" || setting === "delayed-auto"
          ? 2
          : setting === "demand"
            ? 3
            : 4;
      return result();
    },
    stop: async () => {
      events.push("stop");
      running = false;
      return result();
    },
    start: async () => {
      events.push("start");
      assert.equal(startType, 2);
      running = true;
      return result();
    },
    delete: async () => result(),
    wait: async () => undefined,
  };
  const operation = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);

  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(startType, 4);
  assert.equal(running, false);
  assert.ok(events.indexOf("configure:disabled") < events.indexOf("stop"));

  // An ordinary SCM recovery attempt cannot start a disabled service.
  if (startType !== 4) running = true;
  assert.equal(running, false);
  await operation.validateAfterPreflight?.();

  await operation.rollback();
  assert.equal(startType, 2);
  assert.equal(running, true);
  assert.ok(events.indexOf("configure:auto") < events.indexOf("start"));
});

test("Windows service coordination stops a service that starts while its latch is applied", async () => {
  const paths = windowsPaths();
  let running = false;
  let startType: 2 | 3 | 4 = 2;
  let stops = 0;
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    config: async () =>
      result(
        `START_TYPE : ${startType} ${startType === 4 ? "DISABLED" : "AUTO_START"}\r\nBINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    configureStart: async (_serviceName, setting) => {
      startType = setting === "disabled" ? 4 : setting === "demand" ? 3 : 2;
      if (setting === "disabled") running = true;
      return result();
    },
    stop: async () => {
      stops += 1;
      running = false;
      return result();
    },
    start: async () => {
      running = true;
      return result();
    },
    delete: async () => result(),
    wait: async () => undefined,
  };
  const operation = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);

  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(stops, 1);
  assert.equal(running, false);

  await operation.rollback();
  assert.equal(startType, 2);
  assert.equal(running, false);
});

test("Windows service rollback preserves delayed automatic start", async () => {
  const paths = windowsPaths();
  let running = true;
  let startSetting = "delayed-auto";
  const configured: string[] = [];
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const startTypeOutput = () =>
    startSetting === "disabled"
      ? "START_TYPE : 4 DISABLED\r\n"
      : startSetting === "delayed-auto"
        ? "START_TYPE : 2 AUTO_START (DELAYED)\r\n"
        : "START_TYPE : 2 AUTO_START\r\n";
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    config: async () =>
      result(
        `${startTypeOutput()}BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    configureStart: async (_serviceName, setting) => {
      configured.push(setting);
      startSetting = setting;
      return result();
    },
    stop: async () => {
      running = false;
      return result();
    },
    start: async () => {
      running = true;
      return result();
    },
    delete: async () => result(),
    wait: async () => undefined,
  };
  const operation = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);

  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  await operation.rollback();

  assert.deepEqual(configured, ["disabled", "delayed-auto"]);
  assert.equal(startSetting, "delayed-auto");
  assert.equal(running, true);
});

test("Windows service coordination rolls back a side-effecting start-mode failure", async () => {
  const paths = windowsPaths();
  let startType: 2 | 3 | 4 = 2;
  let stops = 0;
  const configured: string[] = [];
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () => result("STATE : 4 RUNNING\r\n"),
    config: async () =>
      result(
        `START_TYPE : ${startType} ${startType === 4 ? "DISABLED" : "AUTO_START"}\r\nBINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    configureStart: async (_serviceName, setting) => {
      configured.push(setting);
      startType = setting === "disabled" ? 4 : setting === "demand" ? 3 : 2;
      return setting === "disabled"
        ? result("", 5, "simulated output loss after mutation")
        : result();
    },
    stop: async () => {
      stops += 1;
      return result();
    },
    start: async () => result(),
    delete: async () => result(),
  };
  const operation = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const cleanup = await operation.run();
  assert.equal(cleanup.status, "failed");
  assert.equal(startType, 2);
  assert.equal(stops, 0);
  assert.deepEqual(configured, ["disabled", "auto"]);
});

test("Windows service guard blocks reactivation during the final lock probe", async () => {
  const paths = windowsPaths();
  let running = true;
  let startType: 2 | 3 | 4 = 2;
  let payloadRan = false;
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    config: async () =>
      result(
        `START_TYPE : ${startType} ${startType === 4 ? "DISABLED" : "AUTO_START"}\r\nBINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    configureStart: async (_serviceName, setting) => {
      startType = setting === "disabled" ? 4 : setting === "demand" ? 3 : 2;
      return result();
    },
    stop: async () => {
      running = false;
      return result();
    },
    start: async () => {
      running = true;
      return result();
    },
    delete: async () => result(),
    wait: async () => undefined,
  };
  const coordinator = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
  );
  assert.ok(coordinator);
  const payload = guardWindowsServiceOperation(
    createFunctionOperation({
      id: "windows:test:guarded-docker-payload",
      component: "docker-engine",
      description: "Run guarded Docker payload",
      phase: "package",
      // Model a service recovery race after a successful target lock probe.
      validateBeforeRun: async () => {
        running = true;
      },
      run: async () => {
        payloadRan = true;
        return { status: "removed" };
      },
    }),
    coordinator,
  );

  await assert.rejects(
    async () => await executeOperations([coordinator, payload]),
    /unsafe reactivation|reactivated/,
  );
  assert.equal(payloadRan, false);
  assert.equal(startType, 2);
  assert.equal(running, true);
});

for (const service of [
  {
    component: "docker-engine" as const,
    name: "docker",
    executable: "C:\\Windows\\System32\\dockerd.exe",
    commandLine: "C:\\Windows\\System32\\dockerd.exe --run-service",
  },
  {
    component: "apache" as const,
    name: "Apache",
    executable: "C:\\tools\\Apache24\\bin\\httpd.exe",
    commandLine: "C:\\tools\\Apache24\\bin\\httpd.exe -k runservice",
  },
  {
    component: "nginx" as const,
    name: "nginx",
    executable: "C:\\tools\\nginx-1.31.3\\nginx.exe",
    commandLine: "C:\\tools\\nginx-1.31.3\\nginx.exe -s run",
  },
  {
    component: "postgresql" as const,
    name: "postgresql-x64-17",
    executable: "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe",
    commandLine:
      '"C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe" runservice',
  },
]) {
  test(`Windows ${service.component} rollback never starts a replaced service executable`, async () => {
    const original = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
    const replacement = { ...original, ino: 99n };
    let running = true;
    let replaced = false;
    let starts = 0;
    const result = (stdout: string, exitCode = 0, stderr = "") => ({
      exitCode,
      stdout,
      stderr,
    });
    const control: WindowsServiceControl = {
      exists: async () => true,
      inventory: async () => result(`SERVICE_NAME: ${service.name}\r\n`),
      query: async () =>
        result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
      config: async () =>
        result(`BINARY_PATH_NAME : ${service.commandLine}\r\n`),
      inspectExecutable: async (executable: string) => {
        assert.equal(executable, service.executable);
        return replaced ? replacement : original;
      },
      stop: async () => {
        running = false;
        return result("");
      },
      start: async () => {
        starts += 1;
        running = true;
        return result("");
      },
      delete: async () => result(""),
      wait: async () => undefined,
    };
    const operation = createWindowsServiceCoordinator(
      windowsPaths(),
      planFor(service.component),
      control,
    );

    assert.ok(operation?.validate);
    assert.ok(operation.rollback);
    await operation.validate();
    assert.equal((await operation.run()).status, "removed");
    replaced = true;
    await assert.rejects(operation.rollback, /executable identity changed/);
    assert.equal(starts, 0);
    assert.equal(running, false);
  });
}

test("Windows service rollback never starts a missing registered executable", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let running = true;
  let executableMissing = false;
  let starts = 0;
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    config: async () =>
      result(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => (executableMissing ? undefined : identity),
    stop: async () => {
      running = false;
      return result("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return result("");
    },
    delete: async () => result(""),
  };
  const operation = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
  );

  assert.ok(operation?.validate);
  assert.ok(operation.rollback);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  executableMissing = true;
  await assert.rejects(operation.rollback, /executable identity changed/);
  assert.equal(starts, 0);
  assert.equal(running, false);
});

test("Windows service preflight requires executable identity for every present service", async () => {
  let stops = 0;
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const control = {
    exists: async () => true,
    inventory: async () => result(""),
    query: async () => result("STATE : 4 RUNNING\r\n"),
    stop: async () => {
      stops += 1;
      return result("");
    },
    delete: async () => result(""),
  } as WindowsServiceControl;
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );

  assert.ok(operation?.validate);
  await assert.rejects(
    operation.validate,
    /configuration and executable identity cannot be verified/,
  );
  assert.equal(stops, 0);
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
  const deleted = new Set<string>();
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
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
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
      if (deleted.has(name)) return result("", 1060, "service missing");
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
      deleted.add(name);
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
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete:")),
    [],
  );
  assert.equal(calls.at(-1), "query:postgresql-x64-16");
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
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
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

test("Windows service coordination rejects truncated discovery before any stop", async () => {
  let stops = 0;
  const result = (stdout: string) => ({
    stdout,
    stderr: "",
    exitCode: 0,
    stdoutTruncated: true,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: postgresql-x64-17\r\n"),
    query: async () => ({
      exitCode: 0,
      stdout: "STATE : 4 RUNNING",
      stderr: "",
    }),
    stop: async () => {
      stops += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("postgresql"),
    control,
  );

  assert.ok(operation?.validate);
  await assert.rejects(operation.validate, /safe output bound/);
  assert.equal(stops, 0);
});

test("Windows service coordination rejects unstable initial states before mutation", async () => {
  for (const state of [2, 3, 5, 6, 7]) {
    let stops = 0;
    const control: WindowsServiceControl = {
      exists: async () => true,
      inventory: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      query: async () => ({
        exitCode: 0,
        stdout: `STATE : ${state} TRANSITIONAL\r\n`,
        stderr: "",
      }),
      stop: async () => {
        stops += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const operation = createWindowsServiceCoordinator(
      windowsPaths(),
      planFor("apache"),
      control,
    );
    assert.ok(operation?.validate);

    await assert.rejects(operation.validate, /stable STOPPED or RUNNING state/);
    assert.equal(stops, 0, `state ${state}`);
  }
});

test("Windows service stop and polling share one 30-second wall deadline", async () => {
  let now = 0;
  let stopRequested = false;
  let stopPolling = false;
  const transitionTimeouts: number[] = [];
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => result(""),
    query: async (_name, timeoutMs) => {
      if (!stopRequested) return result("STATE : 4 RUNNING\r\n");
      if (!stopPolling || timeoutMs === undefined) {
        return result("STATE : 1 STOPPED\r\n");
      }
      transitionTimeouts.push(timeoutMs);
      now += timeoutMs;
      stopPolling = false;
      return result("STATE : 3 STOP_PENDING\r\n");
    },
    stop: async (_name, timeoutMs) => {
      stopRequested = true;
      stopPolling = true;
      assert.notEqual(timeoutMs, undefined);
      transitionTimeouts.push(timeoutMs ?? 0);
      now += 10_000;
      return result("");
    },
    start: async () => {
      stopRequested = false;
      return result("");
    },
    delete: async () => result(""),
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "failed");
  assert.match(operationResult.detail ?? "", /30 seconds|deadline/i);
  assert.ok(transitionTimeouts.length >= 2);
  assert.ok(
    transitionTimeouts.at(-1)! <= 20_000,
    "polling must receive only the transition time left after sc stop",
  );
});

test("Windows final service recheck cannot reset the coordination deadline", async () => {
  let now = 0;
  let running = true;
  let stopCompleted = false;
  let starts = 0;
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    exitCode,
    stdout,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => result(),
    query: async () => {
      if (!running && !stopCompleted) {
        stopCompleted = true;
        now += 120_001;
      }
      return result(
        running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
      );
    },
    stop: async () => {
      running = false;
      return result();
    },
    start: async () => {
      starts += 1;
      running = true;
      return result();
    },
    delete: async () => result(),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const operationResult = await operation.run();

  assert.equal(operationResult.status, "failed");
  assert.match(operationResult.detail ?? "", /two-minute aggregate deadline/);
  assert.equal(starts, 1, "rollback receives a fresh coordination budget");
  assert.equal(running, true);
});

test("Windows service discovery shares one two-minute aggregate deadline", async () => {
  let now = 0;
  let stops = 0;
  const timeouts: number[] = [];
  const serviceNames = Array.from(
    { length: 16 },
    (_, index) => `postgresql-x64-${index + 1}`,
  );
  const consume = (timeoutMs: number | undefined): void => {
    assert.notEqual(timeoutMs, undefined);
    timeouts.push(timeoutMs ?? 0);
    now += timeoutMs ?? 0;
  };
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async (timeoutMs) => {
      consume(timeoutMs);
      return {
        exitCode: 0,
        stdout: serviceNames
          .map((name) => `SERVICE_NAME: ${name}\r\n`)
          .join(""),
        stderr: "",
      };
    },
    query: async (_name, timeoutMs) => {
      consume(timeoutMs);
      return { exitCode: 0, stdout: "STATE : 4 RUNNING\r\n", stderr: "" };
    },
    config: async (name, timeoutMs) => {
      consume(timeoutMs);
      return testWindowsServiceConfiguration(name);
    },
    stop: async () => {
      stops += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("postgresql"),
    control,
  );
  assert.ok(operation?.validate);

  await assert.rejects(operation.validate, /two-minute aggregate deadline/);
  assert.ok(timeouts.length >= 1);
  assert.ok(timeouts.reduce((total, timeout) => total + timeout, 0) <= 120_000);
  assert.equal(stops, 0);
});

test("Windows cleanup removes exact stale service registrations after package cleanup", async () => {
  const paths = windowsPaths();
  const registered = new Set(["Apache", "nginx", "postgresql-x64-16"]);
  const deleted: string[] = [];
  let stopped = false;
  let executablesPresent = true;
  const removedInstallationDirectories = new Set(
    [
      `${paths.drive}\\tools\\Apache24`,
      `${paths.drive}\\tools\\nginx-1.31.3`,
      `${paths.programFiles}\\PostgreSQL\\16`,
    ].map((path) => path.toLowerCase()),
  );
  const executableProbe: WindowsPathProbe = {
    lstat: async (path) => {
      if (
        !executablesPresent &&
        removedInstallationDirectories.has(path.toLowerCase())
      ) {
        throw Object.assign(new Error("installation directory is absent"), {
          code: "ENOENT",
        });
      }
      return windowsPathStats(/\.exe$/i.test(path) ? "file" : "directory");
    },
  };
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () =>
      result(
        registered.has("postgresql-x64-16")
          ? "SERVICE_NAME: postgresql-x64-16\r\n"
          : "SERVICE_NAME: EventLog\r\n",
      ),
    query: async (name) =>
      registered.has(name)
        ? result(stopped ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n")
        : result("", 1060, "service does not exist"),
    config: async (name) => testWindowsServiceConfiguration(name),
    inspectExecutable: async (executable) =>
      await inspectWindowsServiceExecutable(paths, executable, executableProbe),
    stop: async () => result(""),
    delete: async (name) => {
      deleted.push(name);
      registered.delete(name);
      return result("");
    },
    wait: async () => undefined,
  };
  const operation = createWindowsServiceRegistrationCleanup(
    paths,
    planFor("apache", "nginx", "postgresql"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  stopped = true;
  executablesPresent = false;
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "removed", cleanupResult.detail ?? "");
  assert.deepEqual(deleted, ["Apache", "nginx", "postgresql-x64-16"]);
  assert.equal(registered.size, 0);
});

test("Windows service guards accept verified uninstaller absence and reject recreation", async () => {
  const paths = windowsPaths();
  const lifecycle = createWindowsDockerServiceLifecycle();
  let registered = true;
  let running = true;
  let residualRan = false;
  let recreatedPayloadRan = false;
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () =>
      registered
        ? result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n")
        : result("", 1060, "service does not exist"),
    stop: async () => {
      running = false;
      return result();
    },
    start: async () => {
      running = true;
      return result();
    },
    delete: async () => {
      registered = false;
      return result();
    },
    wait: async () => undefined,
  };
  const plan = planFor("apache");
  const coordinator = createWindowsServiceCoordinator(
    paths,
    plan,
    control,
    lifecycle,
  );
  const finalizer = createWindowsServiceRegistrationCleanup(
    paths,
    plan,
    control,
    lifecycle,
  );
  assert.ok(coordinator);
  assert.ok(finalizer);
  const uninstaller = guardWindowsServiceOperation(
    createFunctionOperation({
      id: "windows:test:apache-uninstaller",
      component: "apache",
      description: "Simulate Apache uninstaller",
      phase: "package",
      run: async () => {
        registered = false;
        return { status: "removed" };
      },
    }),
    coordinator,
  );
  const residual = guardWindowsServiceOperation(
    createFunctionOperation({
      id: "windows:test:apache-residual",
      component: "apache",
      description: "Remove Apache residual",
      phase: "system",
      run: async () => {
        residualRan = true;
        return { status: "removed" };
      },
    }),
    coordinator,
  );
  const recreated = guardWindowsServiceOperation(
    createFunctionOperation({
      id: "windows:test:apache-recreated",
      component: "apache",
      description: "Reject recreated Apache service",
      phase: "system",
      validateBeforeRun: async () => {
        registered = true;
      },
      run: async () => {
        recreatedPayloadRan = true;
        return { status: "removed" };
      },
    }),
    coordinator,
  );

  await assert.rejects(
    async () =>
      await executeOperations([
        coordinator,
        uninstaller,
        finalizer,
        residual,
        recreated,
      ]),
    /reactivated|disabled latch/,
  );
  assert.equal(residualRan, true);
  assert.equal(recreatedPayloadRan, false);
  assert.equal(lifecycle.isRegistrationFinalized("apache"), true);
});

test("Windows service registration cleanup is the last selected package operation", async () => {
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const plan = planFor("apache", "nginx", "postgresql");
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  const cleanupIndex = prepared.findIndex(
    ({ id }) => id === "windows:services:unregister",
  );
  const selectedPackageIndexes = prepared
    .map((operation, index) => ({ operation, index }))
    .filter(
      ({ operation }) =>
        operation.phase === "package" &&
        operation.id !== "windows:services:unregister",
    )
    .map(({ index }) => index);

  assert.notEqual(cleanupIndex, -1);
  assert.equal(prepared[cleanupIndex]?.phase, "package");
  assert.equal(prepared[cleanupIndex]?.validateBeforeRun, undefined);
  assert.ok(selectedPackageIndexes.every((index) => index < cleanupIndex));
  assert.equal(
    selectedPackageIndexes
      .map((index) => prepared[index])
      .filter(
        (operation) =>
          operation !== undefined &&
          ["apache", "nginx", "postgresql"].includes(operation.component),
      )
      .every((operation) => operation?.validateBeforeRun !== undefined),
    true,
  );
});

test("Windows service registration cleanup rejects new PostgreSQL services before any delete", async () => {
  let inventoryCalls = 0;
  const deleted: string[] = [];
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => {
      inventoryCalls += 1;
      return result(
        inventoryCalls === 1
          ? "SERVICE_NAME: postgresql-x64-16\r\n"
          : "SERVICE_NAME: postgresql-x64-16\r\nSERVICE_NAME: postgresql-x64-17\r\n",
      );
    },
    query: async () => result("STATE : 1 STOPPED\r\n"),
    stop: async () => result(""),
    delete: async (name) => {
      deleted.push(name);
      return result("");
    },
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("postgresql"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /inventory changed/i);
  assert.deepEqual(deleted, []);
});

test("Windows service registration cleanup rejects reactivation before any delete", async () => {
  let validationComplete = false;
  const deleted: string[] = [];
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async (name) =>
      result(
        validationComplete && name === "nginx"
          ? "STATE : 4 RUNNING\r\n"
          : validationComplete
            ? "STATE : 1 STOPPED\r\n"
            : "STATE : 4 RUNNING\r\n",
      ),
    stop: async () => result(""),
    delete: async (name) => {
      deleted.push(name);
      return result("");
    },
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("apache", "nginx"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  validationComplete = true;
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /reactivated/i);
  assert.deepEqual(deleted, []);
});

test("Windows service registration cleanup rejects configuration drift before any delete", async () => {
  let drifted = false;
  const deleted: string[] = [];
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () =>
      result(drifted ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n"),
    config: async (name) =>
      drifted
        ? result(
            `BINARY_PATH_NAME : ${windowsPaths().drive}\\workflow\\httpd.exe\r\n`,
          )
        : testWindowsServiceConfiguration(name),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    stop: async () => result(""),
    delete: async (name) => {
      deleted.push(name);
      return result("");
    },
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  drifted = true;
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /outside|configuration changed/i);
  assert.deepEqual(deleted, []);
});

test("Windows service registration deletion uses one 30-second wall deadline", async () => {
  let now = 0;
  let validationComplete = false;
  let deletionAccepted = false;
  const pollTimeouts: number[] = [];
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async (_name, timeoutMs) => {
      if (deletionAccepted) {
        if (timeoutMs !== undefined) {
          pollTimeouts.push(timeoutMs);
          now += timeoutMs;
        }
        return result("", 1072, "service marked for deletion");
      }
      return result(
        validationComplete ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      );
    },
    stop: async () => result(""),
    delete: async () => {
      deletionAccepted = true;
      return result("", 1072, "service marked for deletion");
    },
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  validationComplete = true;
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /30 seconds|deadline/i);
  assert.ok(pollTimeouts.length >= 1);
  assert.ok(
    pollTimeouts.reduce((total, timeout) => total + timeout, 0) <= 30_000,
  );
});

test("Windows service registration deletion includes the delete command in its deadline", async () => {
  let now = 0;
  let validationComplete = false;
  let registered = true;
  let postDeletionQueries = 0;
  const lifecycle = createWindowsDockerServiceLifecycle();
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () => {
      if (!registered) {
        postDeletionQueries += 1;
        return result("", 1060, "service does not exist");
      }
      return result(
        validationComplete ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      );
    },
    stop: async () => result(),
    delete: async () => {
      registered = false;
      now += 30_001;
      return result();
    },
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("apache"),
    control,
    lifecycle,
  );
  assert.ok(operation?.validate);
  await operation.validate();
  validationComplete = true;

  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /30 seconds|deadline/i);
  assert.equal(postDeletionQueries, 0);
  assert.equal(lifecycle.isRegistrationFinalized("apache"), false);
});

test("Windows service registration never finalizes after a terminal query overruns its budget", async () => {
  let now = 0;
  let stopped = false;
  let registered = true;
  let missingQueries = 0;
  const lifecycle = createWindowsDockerServiceLifecycle();
  const result = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () => {
      if (!registered) {
        missingQueries += 1;
        if (missingQueries === 2) now += 120_001;
        return result("", 1060, "service does not exist");
      }
      return result(
        stopped ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      );
    },
    stop: async () => result(),
    delete: async () => {
      registered = false;
      return result();
    },
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("apache"),
    control,
    lifecycle,
  );
  assert.ok(operation?.validate);
  await operation.validate();
  stopped = true;

  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /two-minute aggregate deadline/);
  assert.equal(lifecycle.isRegistrationFinalized("apache"), false);
});

test("Windows service registration cleanup accepts an uninstaller deletion already in progress", async () => {
  let validationComplete = false;
  let pendingQueries = 0;
  let deletes = 0;
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () => {
      if (!validationComplete) return result("STATE : 4 RUNNING\r\n");
      pendingQueries += 1;
      return pendingQueries < 3
        ? result("", 1072, "service marked for deletion")
        : result("", 1060, "service does not exist");
    },
    stop: async () => result(""),
    delete: async () => {
      deletes += 1;
      return result("");
    },
    wait: async () => undefined,
  };
  const operation = createWindowsServiceRegistrationCleanup(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  validationComplete = true;
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "not-found", cleanupResult.detail ?? "");
  assert.equal(deletes, 0);
  assert.equal(pendingQueries, 4);
});

test("Windows Docker service remains registered after successful preflight", async () => {
  let stopped = false;
  let deleted = false;
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => ({
      exitCode: 0,
      stdout: "SERVICE_NAME: docker\r\n",
      stderr: "",
    }),
    query: async () => ({
      exitCode: 0,
      stdout: stopped ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      stderr: "",
    }),
    stop: async () => {
      stopped = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    start: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    delete: async () => {
      deleted = true;
      return { exitCode: 1072, stdout: "", stderr: "marked for deletion" };
    },
    wait: async () => undefined,
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(deleted, false);
  assert.equal(stopped, true);
  assert.equal(result.status, "removed");
});

test("Windows Docker service is not deleted when preflight fails", async () => {
  let queries = 0;
  let deleted = false;
  let stopped = false;
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    query: async () => {
      queries += 1;
      if (queries >= 3) {
        return { exitCode: 5, stdout: "", stderr: "Access is denied" };
      }
      return {
        exitCode: 0,
        stdout: "STATE : 4 RUNNING\r\n",
        stderr: "",
      };
    },
    stop: async () => {
      stopped = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    start: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    delete: async () => {
      deleted = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.equal(stopped, true);
  assert.equal(deleted, false);
});

test("Windows Docker removes dockerd only after verified service deletion", async () => {
  const paths = windowsPaths();
  let registered = true;
  let running = true;
  let deletes = 0;
  let starts = 0;
  const events: string[] = [];
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    query: async () =>
      registered
        ? commandResult(
            running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
          )
        : commandResult("", 1060, "service does not exist"),
    config: async () =>
      commandResult(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    stop: async () => {
      running = false;
      return commandResult("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return commandResult("");
    },
    delete: async (name) => {
      assert.equal(name, "docker");
      assert.equal(running, false);
      events.push("delete:docker");
      deletes += 1;
      registered = false;
      return commandResult("");
    },
    wait: async () => undefined,
  };
  const lifecycle = createWindowsDockerServiceLifecycle();
  const coordinator = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
    lifecycle,
  );
  const engine = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        events.push(`remove:${target}`);
        if (target === `${paths.system32}\\dockerd.exe`) {
          assert.equal(registered, false);
        }
        return { status: "removed" };
      },
    },
  );
  const laterFailure = createFunctionOperation({
    id: "windows:test:after-docker-service-removal",
    component: "docker-engine",
    description: "Fail after Docker service removal",
    phase: "system",
    run: async () => ({ status: "failed", detail: "simulated later failure" }),
  });
  assert.ok(coordinator);

  await assert.rejects(
    async () => await executeOperations([coordinator, engine, laterFailure]),
    /simulated later failure/,
  );
  assert.equal(deletes, 1);
  assert.equal(registered, false);
  assert.equal(starts, 0);
  assert.deepEqual(events, [
    `remove:${paths.system32}\\docker.exe`,
    `remove:${paths.systemRoot}\\SysWOW64\\docker.exe`,
    `remove:${paths.programData}\\docker`,
    "delete:docker",
    `remove:${paths.system32}\\dockerd.exe`,
  ]);
});

test("Windows Docker propagates every validated target boundary to locked removal", async () => {
  const paths = windowsPaths();
  const targets = [
    `${paths.system32}\\docker.exe`,
    `${paths.systemRoot}\\SysWOW64\\docker.exe`,
    `${paths.programData}\\docker`,
    `${paths.system32}\\dockerd.exe`,
  ];
  const snapshots = new Map(
    targets.map((target, index) => [
      target,
      {
        targetExists: true,
        entries: [
          {
            path: target,
            device: 1n,
            inode: BigInt(index + 10),
            mode: 0o100755n,
          },
        ],
      },
    ]),
  );
  const removed: string[] = [];
  const missingService = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    query: async () => ({
      exitCode: 1060,
      stdout: "",
      stderr: "service does not exist",
    }),
    stop: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    start: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  } satisfies WindowsServiceControl;
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: missingService,
      validateTarget: async (target) => snapshots.get(target),
      removeTarget: async (target, expectedBoundary) => {
        assert.equal(expectedBoundary, snapshots.get(target));
        removed.push(target);
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(removed, targets);
});

test("Windows Docker preflights every locked target operation", async () => {
  const paths = windowsPaths();
  const validated: string[] = [];
  const removed: string[] = [];
  const expectedTargets = [
    `${paths.system32}\\docker.exe`,
    `${paths.systemRoot}\\SysWOW64\\docker.exe`,
    `${paths.programData}\\docker`,
    `${paths.system32}\\dockerd.exe`,
  ];
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        exists: async () => true,
        inventory: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        query: async () => ({
          exitCode: 1060,
          stdout: "",
          stderr: "service does not exist",
        }),
        stop: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      createTargetOperation: (target) =>
        createFunctionOperation({
          id: `locked-target:${target}`,
          component: "docker-engine",
          description: `locked target ${target}`,
          phase: "system",
          validate: async () => {
            validated.push(target);
          },
          run: async () => {
            removed.push(target);
            return { status: "removed" };
          },
        }),
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.deepEqual(validated, expectedTargets);
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(removed, expectedTargets);
});

test("Windows Docker preserves image data when docker-images is skipped", async () => {
  const paths = windowsPaths();
  const validated: string[] = [];
  const removed: string[] = [];
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      removeDockerData: false,
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        exists: async () => true,
        inventory: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        query: async () => ({
          exitCode: 1060,
          stdout: "",
          stderr: "service does not exist",
        }),
        stop: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        delete: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      createTargetOperation: (target) =>
        createFunctionOperation({
          id: `preserved-data-target:${target}`,
          component: "docker-engine",
          description: `preserved data target ${target}`,
          phase: "system",
          validate: async () => {
            validated.push(target);
          },
          run: async () => {
            removed.push(target);
            return { status: "removed" };
          },
        }),
    },
  );
  const expectedTargets = [
    `${paths.system32}\\docker.exe`,
    `${paths.systemRoot}\\SysWOW64\\docker.exe`,
    `${paths.programData}\\docker\\cli-plugins`,
    `${paths.system32}\\dockerd.exe`,
  ];

  assert.ok(operation.validate);
  await operation.validate();
  assert.deepEqual(validated, expectedTargets);
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(removed, expectedTargets);
  assert.equal(removed.includes(`${paths.programData}\\docker`), false);
});

test("Windows Docker stops before deleting data if its service reactivates mid-cleanup", async () => {
  const paths = windowsPaths();
  let running = false;
  let registered = true;
  const removed: string[] = [];
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        exists: async () => true,
        inventory: async () => commandResult(""),
        query: async () =>
          registered
            ? commandResult(
                running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
              )
            : commandResult("", 1060, "service does not exist"),
        config: async () =>
          commandResult(
            `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
          ),
        stop: async () => commandResult(""),
        delete: async () => {
          registered = false;
          return commandResult("");
        },
      },
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        removed.push(target);
        running = true;
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /not stopped|unsafe reactivation/);
  assert.deepEqual(removed, [`${paths.system32}\\docker.exe`]);
  assert.equal(removed.includes(`${paths.programData}\\docker`), false);
});

test("Windows Docker accepts a raced service-delete no-op only after absence is verified", async () => {
  const paths = windowsPaths();
  let registered = true;
  let deletes = 0;
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    query: async () =>
      registered
        ? commandResult("STATE : 1 STOPPED\r\n")
        : commandResult("", 1060, "service does not exist"),
    config: async () =>
      commandResult(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    stop: async () => commandResult(""),
    delete: async () => {
      deletes += 1;
      registered = false;
      return commandResult("", 1060, "service does not exist");
    },
    wait: async () => undefined,
  };
  const lifecycle = createWindowsDockerServiceLifecycle();
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async () => ({ status: "not-found" }),
    },
  );

  const results = await executeOperations([operation]);
  assert.equal(results[0]?.status, "removed");
  assert.equal(deletes, 1);
  assert.equal(registered, false);
});

test("Windows Docker polls a service marked for deletion until 1060 verifies absence", async () => {
  const paths = windowsPaths();
  let deletionAccepted = false;
  let pendingQueries = 0;
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    query: async () => {
      if (!deletionAccepted) return commandResult("STATE : 1 STOPPED\r\n");
      pendingQueries += 1;
      return pendingQueries < 2
        ? commandResult("", 1072, "service marked for deletion")
        : commandResult("", 1060, "service does not exist");
    },
    config: async () =>
      commandResult(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    stop: async () => commandResult(""),
    delete: async () => {
      deletionAccepted = true;
      return commandResult("");
    },
  };
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      validateTarget: async () => undefined,
      removeTarget: async () => ({ status: "not-found" }),
    },
  );

  const started = Date.now();
  const results = await executeOperations([operation]);
  assert.equal(results[0]?.status, "removed");
  assert.equal(pendingQueries, 4);
  assert.ok(Date.now() - started >= 450);
});

test("Windows Docker deletion polling shares one 30-second wall deadline", async () => {
  const paths = windowsPaths();
  let now = 0;
  let deletionAccepted = false;
  const pollTimeouts: number[] = [];
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => commandResult(""),
    query: async (_name, timeoutMs) => {
      if (!deletionAccepted) return commandResult("STATE : 1 STOPPED\r\n");
      if (timeoutMs !== undefined) {
        pollTimeouts.push(timeoutMs);
        now += timeoutMs;
      }
      return commandResult("", 1072, "service marked for deletion");
    },
    stop: async () => commandResult(""),
    delete: async () => {
      deletionAccepted = true;
      return commandResult("", 1072, "service marked for deletion");
    },
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      validateTarget: async () => undefined,
      removeTarget: async () => ({ status: "not-found" }),
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const cleanupResult = await operation.run();
  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /30 seconds|deadline/i);
  assert.ok(pollTimeouts.length >= 1);
  assert.ok(
    pollTimeouts.reduce((total, timeout) => total + timeout, 0) <= 30_000,
  );
});

test("Windows Docker deletion includes the delete command in its deadline", async () => {
  const paths = windowsPaths();
  const lifecycle = createWindowsDockerServiceLifecycle();
  let now = 0;
  let deletionStarted = false;
  let postDeletionQueries = 0;
  let dockerdRemovals = 0;
  const commandResult = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        now: () => now,
        exists: async () => true,
        inventory: async () => commandResult(),
        query: async () => {
          if (deletionStarted) {
            postDeletionQueries += 1;
            return commandResult("", 1060, "service does not exist");
          }
          return commandResult("STATE : 1 STOPPED\r\n");
        },
        stop: async () => commandResult(),
        delete: async () => {
          deletionStarted = true;
          now += 30_001;
          return commandResult();
        },
      },
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdRemovals += 1;
        }
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /30 seconds|deadline/i);
  assert.equal(postDeletionQueries, 0);
  assert.equal(dockerdRemovals, 0);
  assert.equal(lifecycle.isRegistrationFinalized(), false);
});

test("Windows Docker service budget excludes bounded filesystem removal time", async () => {
  const paths = windowsPaths();
  let now = 0;
  const removed: string[] = [];
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        now: () => now,
        exists: async () => true,
        inventory: async () => commandResult(""),
        query: async () => commandResult("", 1060, "service does not exist"),
        stop: async () => commandResult(""),
        delete: async () => commandResult(""),
      },
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        removed.push(target);
        now += 120_001;
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const cleanupResult = await operation.run();

  assert.equal(
    cleanupResult.status,
    "removed",
    cleanupResult.detail ?? "Docker cleanup failed",
  );
  assert.ok(removed.length > 1);
});

test("Windows Docker service budget rejects a completed task overrun", async () => {
  const paths = windowsPaths();
  let now = 0;
  let dockerdRemoved = false;
  let removals = 0;
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        now: () => now,
        exists: async () => true,
        inventory: async () => commandResult(""),
        query: async () => {
          if (dockerdRemoved) now = 120_001;
          return commandResult("", 1060, "service does not exist");
        },
        stop: async () => commandResult(""),
        delete: async () => commandResult(""),
      },
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        removals += 1;
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdRemoved = true;
        }
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /two-minute aggregate deadline/);
  assert.ok(removals > 0);
});

test("Windows Docker rejects a deadline crossed by its final budget debit", async () => {
  const paths = windowsPaths();
  const lifecycle = createWindowsDockerServiceLifecycle();
  let payloadRemovals = 0;
  let completionClockReads = 0;
  let completionClockArmed = false;
  let dockerdRemovals = 0;
  const commandResult = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        now: () => {
          if (!completionClockArmed) return 0;
          completionClockReads += 1;
          return completionClockReads <= 3 ? 119_999 : 120_000;
        },
        exists: async () => true,
        inventory: async () => commandResult(),
        query: async () => {
          if (payloadRemovals === 3 && !completionClockArmed) {
            completionClockArmed = true;
          }
          return commandResult("", 1060, "service does not exist");
        },
        stop: async () => commandResult(),
        delete: async () => commandResult(),
      },
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdRemovals += 1;
        } else {
          payloadRemovals += 1;
        }
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /two-minute aggregate deadline/);
  assert.equal(completionClockReads, 4);
  assert.equal(dockerdRemovals, 0);
  assert.equal(lifecycle.isRegistrationFinalized(), false);
});

test("Windows Docker stops after an over-budget service deletion", async () => {
  const paths = windowsPaths();
  const lifecycle = createWindowsDockerServiceLifecycle();
  let now = 0;
  let deletionStarted = false;
  let postDeletionQueries = 0;
  let dockerdRemovals = 0;
  const commandResult = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        now: () => now,
        exists: async () => true,
        inventory: async () => commandResult(),
        query: async () => {
          if (deletionStarted) {
            postDeletionQueries += 1;
            return commandResult("", 1060, "service does not exist");
          }
          return commandResult("STATE : 1 STOPPED\r\n");
        },
        stop: async () => commandResult(),
        delete: async () => {
          deletionStarted = true;
          now += 120_001;
          return commandResult();
        },
      },
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdRemovals += 1;
        }
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /two-minute aggregate deadline/);
  assert.equal(postDeletionQueries, 0);
  assert.equal(dockerdRemovals, 0);
  assert.equal(lifecycle.isRegistrationFinalized(), false);
});

test("Windows Docker stops before dockerd removal if its service is recreated", async () => {
  const paths = windowsPaths();
  const lifecycle = createWindowsDockerServiceLifecycle();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let registered = true;
  let dockerdRemoved = false;
  let missingQueries = 0;
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    query: async () => {
      if (registered) return commandResult("STATE : 1 STOPPED\r\n");
      missingQueries += 1;
      if (missingQueries === 1) registered = true;
      return commandResult("", 1060, "service does not exist");
    },
    config: async () =>
      commandResult(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    inspectExecutable: async () => identity,
    stop: async () => commandResult(""),
    delete: async () => {
      registered = false;
      return commandResult("");
    },
    wait: async () => undefined,
  };
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdRemoved = true;
        }
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(dockerdRemoved, false);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /service.*recreated|remained registered/i);
  assert.equal(lifecycle.isRegistrationFinalized(), false);
});

test("Windows Docker preserves a primary discovery error that overruns its budget", async () => {
  const paths = windowsPaths();
  let now = 0;
  let runStarted = false;
  const commandResult = (stdout = "", exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const operation = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control: {
        ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
        now: () => now,
        exists: async () => true,
        inventory: async () => commandResult(),
        query: async () => {
          if (runStarted) {
            now += 120_001;
            throw new Error("primary Docker discovery failure");
          }
          return commandResult("", 1060, "service does not exist");
        },
        stop: async () => commandResult(),
        delete: async () => commandResult(),
      },
      validateTarget: async () => undefined,
      removeTarget: async () => ({ status: "removed" }),
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  runStarted = true;
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /primary Docker discovery failure/);
  assert.match(result.detail ?? "", /two-minute aggregate deadline/);
});

test("Windows Docker rechecks service configuration between payload targets", async () => {
  const paths = windowsPaths();
  let running = true;
  let drifted = false;
  let deletes = 0;
  let starts = 0;
  let payloadRemovals = 0;
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    query: async () =>
      commandResult(
        running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
      ),
    config: async () =>
      commandResult(
        drifted
          ? "BINARY_PATH_NAME : C:\\workflow\\dockerd.exe --run-service\r\n"
          : `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    stop: async () => {
      running = false;
      return commandResult("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return commandResult("");
    },
    delete: async () => {
      deletes += 1;
      return commandResult("");
    },
    wait: async () => undefined,
  };
  const lifecycle = createWindowsDockerServiceLifecycle();
  const coordinator = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
    lifecycle,
  );
  const engine = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async () => {
        payloadRemovals += 1;
        drifted = true;
        return { status: "removed" };
      },
    },
  );
  assert.ok(coordinator);

  await assert.rejects(
    async () => await executeOperations([coordinator, engine]),
    /service executable is outside|configuration changed/,
  );
  assert.equal(payloadRemovals, 1);
  assert.equal(deletes, 0);
  assert.equal(starts, 0);
  assert.equal(running, false);
});

test("Windows Docker rejects a drifted or reactivated service before any payload mutation", async () => {
  for (const mutation of ["configuration", "reactivation"] as const) {
    const paths = windowsPaths();
    let running = true;
    let drifted = false;
    let deletes = 0;
    let starts = 0;
    let payloadRemovals = 0;
    const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
      stdout,
      exitCode,
      stderr,
    });
    const control: WindowsServiceControl = {
      exists: async () => true,
      inventory: async () => commandResult(""),
      inspectExecutable: async () => ({
        dev: 1n,
        ino: 2n,
        size: 3n,
        mtimeNs: 4n,
      }),
      query: async () =>
        commandResult(
          running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
        ),
      config: async () =>
        commandResult(
          drifted
            ? "BINARY_PATH_NAME : C:\\workflow\\dockerd.exe --run-service\r\n"
            : `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
        ),
      stop: async () => {
        running = false;
        return commandResult("");
      },
      start: async () => {
        starts += 1;
        running = true;
        return commandResult("");
      },
      delete: async () => {
        deletes += 1;
        return commandResult("");
      },
      wait: async () => undefined,
    };
    const lifecycle = createWindowsDockerServiceLifecycle();
    const coordinator = createWindowsServiceCoordinator(
      paths,
      planFor("docker-engine"),
      control,
      lifecycle,
    );
    const mutateAfterPreflight = createFunctionOperation({
      id: `windows:test:docker-${mutation}`,
      component: "docker-engine",
      description: `Simulate Docker service ${mutation}`,
      phase: "package",
      run: async () => {
        if (mutation === "configuration") drifted = true;
        else running = true;
        return { status: "removed" };
      },
    });
    const engine = createWindowsDockerEngineOperation(
      contextFor("windows"),
      paths,
      {
        control,
        lifecycle,
        validateTarget: async () => undefined,
        removeTarget: async () => {
          payloadRemovals += 1;
          return { status: "removed" };
        },
      },
    );
    assert.ok(coordinator);

    await assert.rejects(
      async () =>
        await executeOperations([coordinator, mutateAfterPreflight, engine]),
      /service executable is outside|configuration changed|not stopped|unsafe reactivation/,
    );
    assert.equal(payloadRemovals, 0, mutation);
    assert.equal(deletes, 0, mutation);
    assert.equal(starts, 0, mutation);
  }
});

test("Windows Docker keeps dockerd available but stopped when service deletion fails", async () => {
  const paths = windowsPaths();
  let running = true;
  let dockerdPresent = true;
  let starts = 0;
  const removedTargets: string[] = [];
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    query: async () =>
      commandResult(
        running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
      ),
    config: async () =>
      commandResult(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    stop: async () => {
      running = false;
      return commandResult("");
    },
    start: async () => {
      starts += 1;
      if (!dockerdPresent) {
        return commandResult(
          "",
          2,
          "The system cannot find the file specified.",
        );
      }
      running = true;
      return commandResult("");
    },
    delete: async () => commandResult("", 5, "Access is denied"),
    wait: async () => undefined,
  };
  const lifecycle = createWindowsDockerServiceLifecycle();
  const coordinator = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
    lifecycle,
  );
  const engine = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        removedTargets.push(target);
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdPresent = false;
        }
        return { status: "removed" };
      },
    },
  );
  assert.ok(coordinator);

  await assert.rejects(
    async () => await executeOperations([coordinator, engine]),
    /Access is denied/,
  );
  assert.equal(starts, 0);
  assert.equal(running, false);
  assert.equal(dockerdPresent, true);
  assert.deepEqual(removedTargets, [
    `${paths.system32}\\docker.exe`,
    `${paths.systemRoot}\\SysWOW64\\docker.exe`,
    `${paths.programData}\\docker`,
  ]);
});

test("Windows Docker stops payload removal at the first failure", async () => {
  const paths = windowsPaths();
  let running = true;
  let deletes = 0;
  let starts = 0;
  const removedTargets: string[] = [];
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
    }),
    query: async () =>
      commandResult(
        running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
      ),
    config: async () =>
      commandResult(
        `BINARY_PATH_NAME : ${paths.system32}\\dockerd.exe --run-service\r\n`,
      ),
    stop: async () => {
      running = false;
      return commandResult("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return commandResult("");
    },
    delete: async () => {
      deletes += 1;
      return commandResult("");
    },
  };
  const lifecycle = createWindowsDockerServiceLifecycle();
  const coordinator = createWindowsServiceCoordinator(
    paths,
    planFor("docker-engine"),
    control,
    lifecycle,
  );
  const engine = createWindowsDockerEngineOperation(
    contextFor("windows"),
    paths,
    {
      control,
      lifecycle,
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        removedTargets.push(target);
        return removedTargets.length === 1
          ? {
              status: "failed",
              detail: "simulated payload removal failure",
            }
          : { status: "removed" };
      },
    },
  );
  assert.ok(coordinator);

  await assert.rejects(
    async () => await executeOperations([coordinator, engine]),
    /simulated payload removal failure/,
  );
  assert.equal(deletes, 0);
  assert.equal(starts, 0);
  assert.equal(running, false);
  assert.deepEqual(removedTargets, [`${paths.system32}\\docker.exe`]);
});

test("Windows service coordinator rollback is persistent and idempotent", async () => {
  let running = true;
  let starts = 0;
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    stop: async () => {
      running = false;
      return result("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return result("");
    },
    delete: async () => result(""),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);

  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(running, false);
  await operation.rollback();
  assert.equal(running, true);
  assert.equal(starts, 1);
  await operation.rollback();
  assert.equal(starts, 1);
});

test("Windows service coordinator stays stopped after payload cleanup starts", async () => {
  let running = true;
  let starts = 0;
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    stop: async () => {
      running = false;
      return result("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return result("");
    },
    delete: async () => result(""),
  };
  const coordinator = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );
  assert.ok(coordinator);
  const laterFailure = createFunctionOperation({
    id: "windows:test:later-failure",
    component: "docker-engine",
    description: "Simulate a later Windows cleanup failure",
    phase: "package",
    run: async () => ({ status: "failed", detail: "simulated failure" }),
  });

  await assert.rejects(
    async () => await executeOperations([coordinator, laterFailure]),
    /simulated failure/,
  );
  assert.equal(running, false);
  assert.equal(starts, 0);
});

test("Windows service coordinator rolls back its own failure exactly once", async () => {
  let running = true;
  let stoppedQueries = 0;
  let starts = 0;
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async () => {
      if (running) return result("STATE : 4 RUNNING\r\n");
      stoppedQueries += 1;
      return result(
        stoppedQueries === 2
          ? "STATE : 4 RUNNING\r\n"
          : "STATE : 1 STOPPED\r\n",
      );
    },
    stop: async () => {
      running = false;
      return result("");
    },
    start: async () => {
      starts += 1;
      running = true;
      return result("");
    },
    delete: async () => result(""),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);

  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "failed");
  assert.equal(running, true);
  assert.equal(starts, 1);
  await operation.rollback();
  assert.equal(starts, 1);
});

for (const originallyRunning of [false, true]) {
  test(`Windows service rollback rejects an over-budget terminal ${
    originallyRunning ? "RUNNING" : "STOPPED"
  } query`, async () => {
    let now = 0;
    let running = originallyRunning;
    let rollbackPhase = false;
    let overrunApplied = false;
    let starts = 0;
    const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const control: WindowsServiceControl = {
      ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
      now: () => now,
      exists: async () => true,
      inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
      query: async () => {
        if (rollbackPhase && !overrunApplied && running === originallyRunning) {
          overrunApplied = true;
          now += 120_001;
        }
        return result(
          running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
        );
      },
      stop: async () => {
        running = false;
        return result();
      },
      start: async () => {
        starts += 1;
        running = true;
        return result();
      },
      delete: async () => result(),
    };
    const operation = createWindowsServiceCoordinator(
      windowsPaths(),
      planFor("apache"),
      control,
    );
    assert.ok(operation?.validate);
    assert.ok(operation.rollback);
    await operation.validate();
    assert.equal((await operation.run()).status, "removed");
    rollbackPhase = true;

    await assert.rejects(
      operation.rollback,
      originallyRunning
        ? /30 seconds|two-minute aggregate deadline/
        : /two-minute aggregate deadline/,
    );
    assert.equal(overrunApplied, true);

    await operation.rollback();
    assert.equal(starts, originallyRunning ? 1 : 0);
    assert.equal(running, originallyRunning);
  });
}

test("Windows service rollback includes start in its 30-second deadline", async () => {
  let now = 0;
  let running = true;
  let rollbackPhase = false;
  let starts = 0;
  const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => now,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () =>
      result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
    stop: async () => {
      running = false;
      return result();
    },
    start: async () => {
      starts += 1;
      running = true;
      if (rollbackPhase) now += 30_001;
      return result();
    },
    delete: async () => result(),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  rollbackPhase = true;

  await assert.rejects(operation.rollback, /30 seconds|deadline/i);
  assert.equal(starts, 1);

  await operation.rollback();
  assert.equal(starts, 1);
  assert.equal(running, true);
});

test("Windows service rollback retains its ledger after the final deadline check", async () => {
  let rollbackPhase = false;
  let overrunEnabled = true;
  let finalClockArmed = false;
  let finalClockReads = 0;
  let running = false;
  let starts = 0;
  let rollbackQueries = 0;
  const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    now: () => {
      if (!finalClockArmed) return 0;
      finalClockReads += 1;
      return finalClockReads === 1 ? 119_999 : 120_000;
    },
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
    query: async () => {
      if (rollbackPhase) rollbackQueries += 1;
      if (rollbackPhase && overrunEnabled && !running && !finalClockArmed) {
        finalClockArmed = true;
      }
      return result(
        running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n",
      );
    },
    stop: async () => {
      running = false;
      return result();
    },
    start: async () => {
      starts += 1;
      running = true;
      return result();
    },
    delete: async () => result(),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    control,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  rollbackPhase = true;

  await assert.rejects(operation.rollback, /two-minute aggregate deadline/);
  const queriesAfterFailure = rollbackQueries;
  overrunEnabled = false;
  finalClockArmed = false;
  finalClockReads = 0;

  await operation.rollback();
  assert.ok(rollbackQueries > queriesAfterFailure);
  assert.equal(starts, 0);
  assert.equal(running, false);
});

test("Windows service deadlines preserve an overrun task error", async () => {
  let now = 0;
  let running = true;
  const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("apache"),
    {
      ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
      now: () => now,
      exists: async () => true,
      inventory: async () => result("SERVICE_NAME: EventLog\r\n"),
      query: async () =>
        result(running ? "STATE : 4 RUNNING\r\n" : "STATE : 1 STOPPED\r\n"),
      stop: async () => {
        now += 30_001;
        throw new Error("primary Windows stop failure");
      },
      start: async () => {
        running = true;
        return result();
      },
      delete: async () => result(),
    },
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const cleanupResult = await operation.run();

  assert.equal(cleanupResult.status, "failed");
  assert.match(cleanupResult.detail ?? "", /primary Windows stop failure/);
  assert.match(cleanupResult.detail ?? "", /30 seconds/);
});

test("Windows service rollback continues after one restart query throws", async () => {
  const stopped = new Set<string>();
  const starts: string[] = [];
  const queries = new Map<string, number>();
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async (name) => {
      const count = (queries.get(name) ?? 0) + 1;
      queries.set(name, count);
      if (name === "Apache" && count === 5) {
        throw new Error("simulated Apache rollback query failure");
      }
      if (name === "Apache" && count === 4) {
        return result("STATE : 4 RUNNING\r\n");
      }
      return result(
        stopped.has(name) ? "STATE : 1 STOPPED\r\n" : "STATE : 4 RUNNING\r\n",
      );
    },
    stop: async (name) => {
      stopped.add(name);
      return result("");
    },
    start: async (name) => {
      starts.push(name);
      stopped.delete(name);
      return result("");
    },
    delete: async () => result("", 5, "simulated delete failure"),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine", "apache"),
    control,
  );

  assert.ok(operation?.validate);
  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "failed");
  assert.match(operationResult.detail ?? "", /Apache rollback query failure/);
  assert.deepEqual(starts, ["docker"]);
  assert.ok(operation.rollback);
  await operation.rollback();
  assert.deepEqual(starts, ["docker", "Apache"]);
  await operation.rollback();
  assert.deepEqual(starts, ["docker", "Apache"]);
});

test("Windows service rollback requires RUNNING after START_PENDING", async () => {
  let stopped = false;
  let rollbackQueries = 0;
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
    exists: async () => true,
    inventory: async () => result("SERVICE_NAME: docker\r\n"),
    query: async () => {
      if (!stopped) return result("STATE : 4 RUNNING\r\n");
      rollbackQueries += 1;
      if (rollbackQueries === 2) return result("STATE : 4 RUNNING\r\n");
      if (rollbackQueries === 4) {
        return result("STATE : 2 START_PENDING\r\n");
      }
      return result("STATE : 1 STOPPED\r\n");
    },
    stop: async () => {
      stopped = true;
      return result("");
    },
    start: async () => result(""),
    delete: async () => result("", 5, "simulated delete failure"),
  };
  const operation = createWindowsServiceCoordinator(
    windowsPaths(),
    planFor("docker-engine"),
    control,
  );

  assert.ok(operation?.validate);
  await operation.validate();
  const operationResult = await operation.run();
  assert.equal(operationResult.status, "failed");
  assert.match(operationResult.detail ?? "", /did not reach RUNNING/);
});

test("Windows service coordination rejects PostgreSQL membership changes after stop", async () => {
  let inventories = 0;
  const stopped = new Set<string>();
  const restarted: string[] = [];
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
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
    start: async (name) => {
      restarted.push(name);
      stopped.delete(name);
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
  assert.deepEqual(restarted, ["postgresql-x64-16"]);
});

test("Windows service coordination idempotently stops a canonical stopped service", async () => {
  let stops = 0;
  const result = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    ...TEST_WINDOWS_SERVICE_IDENTITY_CONTROL,
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
  assert.equal(stops, 1);
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

test("Windows registered package removers precede every definition-owned orphan cleanup", async () => {
  const plan = planFor("julia", "php", "apache", "nginx");
  const adapter = await createWindowsAdapter(contextFor("windows"));
  const prepared = prepareOperations(await adapter.operations(plan), plan);
  for (const [packageId, residualPrefix] of [
    ["windows:choco:julia:julia", "windows:residual:julia:"],
    ["windows:choco:php:composer,php", "windows:residual:php:"],
    ["windows:choco:apache:apache-httpd", "windows:residual:apache:"],
    ["windows:choco:nginx:nginx", "windows:residual:nginx:"],
  ] as const) {
    const packageIndex = prepared.findIndex(({ id }) => id === packageId);
    const residualIndexes = prepared
      .map(({ id }, index) => (id.startsWith(residualPrefix) ? index : -1))
      .filter((index) => index !== -1);
    assert.notEqual(packageIndex, -1, packageId);
    for (const residualIndex of residualIndexes) {
      assert.ok(packageIndex < residualIndex, `${packageId} before residual`);
      assert.equal(prepared[packageIndex]?.phase, "package");
      assert.equal(prepared[residualIndex]?.phase, "system");
    }
  }
});

test("Windows package identity drift aborts before a later residual deletion", async () => {
  const paths = windowsPaths();
  let residualRan = false;
  let uninstallRan = false;
  const identity = {
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    contentSha256: "trusted-chocolatey",
  };
  const packageOperation = createWindowsChocolateyOperation(
    paths,
    "julia",
    ["julia"],
    async () => ({
      packages: new Set(["julia"]),
      versions: new Map([["julia", "1.11.5"]]),
      executable: identity,
    }),
    undefined,
    {
      inspectExecutable: async () => identity,
      runCommand: async (_executable, args) => {
        if (args[0] === "list") {
          return { exitCode: 0, stdout: "julia|1.11.6\r\n", stderr: "" };
        }
        uninstallRan = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  const residual = createFunctionOperation({
    id: "windows:test:julia-residual",
    component: "julia",
    description: "Simulate definition-owned Julia orphan cleanup",
    phase: "system",
    run: async () => {
      residualRan = true;
      return { status: "removed" };
    },
  });

  await assert.rejects(
    async () => await executeOperations([packageOperation, residual]),
    /changed after plan validation/,
  );
  assert.equal(uninstallRan, false);
  assert.equal(residualRan, false);
});

function windowsPathStats(
  kind: "directory" | "file",
  options: {
    readonly link?: boolean;
    readonly ino?: bigint;
    readonly mtimeNs?: bigint;
  } = {},
): Awaited<ReturnType<WindowsPathProbe["lstat"]>> {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => options.link ?? false,
    dev: 1n,
    ino: options.ino ?? (kind === "directory" ? 2n : 3n),
    size: 4n,
    mtimeNs: options.mtimeNs ?? 5n,
  };
}

const TEST_WINDOWS_REMOVAL_RUNTIME_IDENTITY = {
  device: 1n,
  inode: 10n,
  size: 100n,
  modifiedNanoseconds: 200n,
  changedNanoseconds: 300n,
  mode: 0o100755n,
  userId: 0n,
  groupId: 0n,
  contentSha256: "a".repeat(64),
};

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

test("Windows executable uninstall preflights locked residual deletion before spawn", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  let executed = false;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-removal-preflight-test",
    description: "test PostgreSQL removal preflight",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) =>
        windowsPathStats(path === installationRoot ? "directory" : "file"),
    },
    execute: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removalDependencies: {
      inspect: async (target) => ({
        exists: true,
        isLink: false,
        realPath: target,
      }),
      boundary: async () => ({
        targetExists: true,
        entries: [
          {
            path: "C:\\Program Files",
            device: 1n,
            inode: 20n,
            mode: 0o40755n,
          },
          {
            path: "C:\\Program Files\\PostgreSQL",
            device: 1n,
            inode: 21n,
            mode: 0o40755n,
          },
          {
            path: installationRoot,
            device: 1n,
            inode: 22n,
            mode: 0o40755n,
          },
        ],
      }),
      hostPlatform: "win32",
      currentRuntimeExecutable: contextFor("windows").runtimeExecutable,
      inspectExecutable: async () => TEST_WINDOWS_REMOVAL_RUNTIME_IDENTITY,
      commandRunner: async () => ({
        exitCode: 5,
        stdout: "",
        stderr: "residual root denies DELETE access",
      }),
    },
  });

  await assert.rejects(
    async () => await executeOperations([operation]),
    /residual root denies DELETE access/,
  );
  assert.equal(executed, false);
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

test("Windows executable uninstall rejects same-metadata content replacement", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  let inspections = 0;
  let executed = false;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-content-test",
    description: "test PostgreSQL content identity",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) =>
        windowsPathStats(path === installationRoot ? "directory" : "file"),
    },
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 3n,
      size: 4n,
      mtimeNs: 5n,
      contentSha256: ++inspections >= 3 ? "changed" : "original",
    }),
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
});

test("Windows executable uninstall rejects a replaced root after the uninstaller exits", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let rootInode = 2n;
  let executablePresent = true;
  let removerCalled = false;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-root-replacement-test",
    description: "test PostgreSQL root replacement",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        if (path === executable && !executablePresent) throw missing;
        return windowsPathStats(
          path === installationRoot ? "directory" : "file",
          {
            ino: path === installationRoot ? rootInode : 3n,
          },
        );
      },
    },
    execute: async () => {
      executablePresent = false;
      rootInode = 99n;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removeInstallationRoot: async () => {
      removerCalled = true;
      return { status: "removed" };
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /installation root changed after uninstall/i,
  );
  assert.equal(removerCalled, false);
});

test("Windows executable uninstall allows expected directory timestamp changes", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let uninstalled = false;
  let removed = false;
  let rootPresent = true;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-directory-mtime-test",
    description: "test PostgreSQL directory mutation",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        if (path === installationRoot && !rootPresent) throw missing;
        if (path === executable && uninstalled) throw missing;
        return windowsPathStats(
          path === installationRoot ? "directory" : "file",
          {
            mtimeNs: path === installationRoot && uninstalled ? 99n : 5n,
          },
        );
      },
    },
    execute: async () => {
      uninstalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removeInstallationRoot: async () => {
      removed = true;
      rootPresent = false;
      return { status: "removed" };
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(removed, true);
});

test("Windows executable uninstall preserves absence and rejects reboot-required success", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  const missing = (): NodeJS.ErrnoException =>
    Object.assign(new Error("missing"), { code: "ENOENT" });
  const absent = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-17-absent-test",
    description: "test absent PostgreSQL",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: { lstat: async () => Promise.reject(missing()) },
    execute: async () => {
      throw new Error("absent uninstaller should not execute");
    },
  });
  assert.ok(absent.validate);
  await absent.validate();
  assert.equal((await absent.run()).status, "not-found");

  let residualRootPresent = true;
  let residualExecuted = false;
  const residual = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-17-residual-test",
    description: "test residual PostgreSQL",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        if (path === installationRoot && residualRootPresent) {
          return windowsPathStats("directory");
        }
        throw missing();
      },
    },
    execute: async () => {
      residualExecuted = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removeInstallationRoot: async () => {
      residualRootPresent = false;
      return { status: "removed" };
    },
  });
  assert.ok(residual.validate);
  await residual.validate();
  assert.equal((await residual.run()).status, "removed");
  assert.equal(residualExecuted, false);

  let uninstalled = false;
  let rootPresent = true;
  let residualRemovalAttempted = false;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-17-test",
    description: "test PostgreSQL",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        if (path === installationRoot && !rootPresent) throw missing();
        if (path === executable && uninstalled) throw missing();
        return windowsPathStats(
          path === installationRoot ? "directory" : "file",
        );
      },
    },
    execute: async () => {
      uninstalled = true;
      return { exitCode: 3010, stdout: "", stderr: "" };
    },
    removeInstallationRoot: async () => {
      residualRemovalAttempted = true;
      rootPresent = false;
      return { status: "removed" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();
  const rebootRequired = await operation.run();
  assert.equal(rebootRequired.status, "failed");
  assert.equal(rebootRequired.abortAction, true);
  assert.match(rebootRequired.detail ?? "", /3010.*restart is required/i);
  assert.equal(residualRemovalAttempted, false);
});

test("Windows executable uninstall does not treat a residual root as absent", async () => {
  const installationRoot = "C:\\Program Files\\PostgreSQL\\17";
  const executable = `${installationRoot}\\uninstall-postgresql.exe`;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "postgresql",
    id: "postgresql-residual-test",
    description: "test PostgreSQL residual root",
    candidates: [{ installationRoot, executable }],
    args: ["--mode", "unattended"],
    probe: {
      lstat: async (path) => {
        if (path === executable) throw missing;
        return windowsPathStats("directory");
      },
    },
    execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  assert.ok(operation.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /installation root remained/);
});

test("Windows executable uninstall rejects a self-deleting no-op uninstaller", async () => {
  const installationRoot = "C:\\Program Files\\Mozilla Firefox";
  const executable = `${installationRoot}\\uninstall\\helper.exe`;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let executablePresent = true;
  const operation = executableUninstallOperation({
    context: contextFor("windows"),
    component: "firefox",
    id: "firefox-self-delete-test",
    description: "test Firefox self-deleting uninstaller",
    candidates: [{ installationRoot, executable }],
    args: ["/S"],
    probe: {
      lstat: async (path) => {
        if (path === executable && !executablePresent) throw missing;
        return windowsPathStats(
          path === installationRoot ? "directory" : "file",
        );
      },
    },
    execute: async () => {
      executablePresent = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /installation root remained/);
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

test("Windows managed uninstall preflights locked residual deletion before spawn", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  let executed = false;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-removal-preflight-test",
    description: "test Miniconda removal preflight",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) =>
        windowsPathStats(path === root ? "directory" : "file"),
    },
    execute: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removalDependencies: {
      inspect: async (target) => ({
        exists: true,
        isLink: false,
        realPath: target,
      }),
      boundary: async () => ({
        targetExists: true,
        entries: [{ path: root, device: 1n, inode: 20n, mode: 0o40755n }],
      }),
      hostPlatform: "win32",
      currentRuntimeExecutable: contextFor("windows").runtimeExecutable,
      inspectExecutable: async () => TEST_WINDOWS_REMOVAL_RUNTIME_IDENTITY,
      commandRunner: async () => ({
        exitCode: 5,
        stdout: "",
        stderr: "managed root denies DELETE access",
      }),
    },
  });

  await assert.rejects(
    async () => await executeOperations([operation]),
    /managed root denies DELETE access/,
  );
  assert.equal(executed, false);
  assert.equal(executable.endsWith(".exe"), true);
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

test("Windows managed uninstall rejects same-metadata content replacement", async () => {
  const root = "C:\\Miniconda";
  let inspections = 0;
  let executed = false;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-content-test",
    description: "test Miniconda content identity",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) =>
        windowsPathStats(path === root ? "directory" : "file"),
    },
    inspectExecutable: async () => ({
      dev: 1n,
      ino: 3n,
      size: 4n,
      mtimeNs: 5n,
      contentSha256: ++inspections >= 2 ? "changed" : "original",
    }),
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

test("Windows managed uninstall rejects a replaced root after the uninstaller exits", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let rootInode = 2n;
  let executablePresent = true;
  let removerCalled = false;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-root-replacement-test",
    description: "test Miniconda root replacement",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) => {
        if (path === executable && !executablePresent) throw missing;
        return windowsPathStats(path === root ? "directory" : "file", {
          ino: path === root ? rootInode : 3n,
        });
      },
    },
    execute: async () => {
      executablePresent = false;
      rootInode = 99n;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removeInstallationRoot: async () => {
      removerCalled = true;
      return { status: "removed" };
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /installation root changed after uninstall/i,
  );
  assert.equal(removerCalled, false);
});

test("Windows managed uninstall allows expected directory timestamp changes", async () => {
  const root = "C:\\Miniconda";
  const executable = `${root}\\Uninstall-Miniconda3.exe`;
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let uninstalled = false;
  let removed = false;
  const operation = managedDirectoryUninstallOperation({
    context: contextFor("windows"),
    component: "miniconda",
    id: "miniconda-directory-mtime-test",
    description: "test Miniconda directory mutation",
    target: root,
    uninstaller: "Uninstall-Miniconda3.exe",
    args: ["/S"],
    probe: {
      lstat: async (path) => {
        if (path === executable && uninstalled) throw missing;
        return windowsPathStats(path === root ? "directory" : "file", {
          mtimeNs: path === root && uninstalled ? 99n : 5n,
        });
      },
    },
    execute: async () => {
      uninstalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    removeInstallationRoot: async () => {
      removed = true;
      return { status: "removed" };
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(removed, true);
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
