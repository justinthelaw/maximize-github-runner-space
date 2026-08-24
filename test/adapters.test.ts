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
  createWindowsDockerEngineOperation,
  createWindowsDockerServiceLifecycle,
  createWindowsChocolateyOperation,
  createWindowsMsiOperation,
  createWindowsSdkBundleOperation,
  createWindowsSdkComponentOperation,
  createWindowsVisualStudioOperation,
  createWindowsAdapter,
  createWindowsServiceCoordinator,
  createWindowsToolCacheRecreateOperation,
  executableUninstallOperation,
  isMissingWindowsService,
  isStoppedWindowsService,
  isStrictWindowsDescendant,
  listChocolateyPackages,
  listMsiProducts,
  listVisualStudioInstances,
  managedDirectoryUninstallOperation,
  parseAndValidateWindowsServiceExecutable,
  PINNED_WINDOWS_WEB_SERVICE_NAMES,
  POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
  UNINSTALL_REGISTRY_ROOTS,
  type WindowsManagedPathProbe,
  type WindowsPathProbe,
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
          ? `${paths.drive}\\tools\\nginx\\nginx.exe -s run`
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
          return { exitCode: 3010, stdout: "", stderr: "" };
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
  assert.equal(windowsInstallerExitDisposition(3010), "completed");
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

test("Visual Studio inventory rejects silent target omission above its bound", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  const records = Array.from({ length: 9 }, (_, index) => ({
    installationPath: `${paths.programFiles}\\Microsoft Visual Studio\\2022\\Enterprise${index}`,
    installationVersion: "17.14.0",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
  }));
  await assert.rejects(
    async () =>
      await listVisualStudioInstances(paths, {
        inspectExecutable: async () => identity,
        pathProbe: { lstat: async () => windowsPathStats("directory") },
        runCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify(records),
          stderr: "",
        }),
      }),
    /exceeded 8 instances/,
  );
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
    executable: "C:\\tools\\nginx\\nginx.exe",
    commandLine: "C:\\tools\\nginx\\nginx.exe -s run",
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
    `remove:${paths.programData}\\docker\\cli-plugins`,
    "delete:docker",
    `remove:${paths.system32}\\dockerd.exe`,
  ]);
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
  assert.equal(pendingQueries, 3);
  assert.ok(Date.now() - started >= 450);
});

test("Windows Docker fails if its service is recreated after dockerd removal", async () => {
  const paths = windowsPaths();
  const identity = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  let registered = true;
  let dockerdRemoved = false;
  const commandResult = (stdout: string, exitCode = 0, stderr = "") => ({
    stdout,
    exitCode,
    stderr,
  });
  const control: WindowsServiceControl = {
    exists: async () => true,
    inventory: async () => commandResult(""),
    query: async () =>
      registered
        ? commandResult("STATE : 1 STOPPED\r\n")
        : commandResult("", 1060, "service does not exist"),
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
      validateTarget: async () => undefined,
      removeTarget: async (target) => {
        if (target === `${paths.system32}\\dockerd.exe`) {
          dockerdRemoved = true;
          registered = true;
        }
        return { status: "removed" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(dockerdRemoved, true);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /service.*recreated|remained registered/i);
});

test("Windows Docker rechecks service configuration after payload cleanup before deletion", async () => {
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
  assert.equal(payloadRemovals, 3);
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
      /service executable is outside|configuration changed|not stopped/,
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
    `${paths.programData}\\docker\\cli-plugins`,
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

test("Windows service coordination recognizes canonical stopped output without mutation", async () => {
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
  } = {},
): Awaited<ReturnType<WindowsPathProbe["lstat"]>> {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => options.link ?? false,
    dev: 1n,
    ino: options.ino ?? (kind === "directory" ? 2n : 3n),
    size: 4n,
    mtimeNs: 5n,
  };
}

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

test("Windows executable uninstall preserves missing and reboot-required exit semantics", async () => {
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
      rootPresent = false;
      return { status: "removed" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
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
