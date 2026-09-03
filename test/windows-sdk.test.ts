import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import { runCommand } from "../src/command.js";
import {
  parseWindowsSdkBundleRegistry,
  standaloneWindowsSdkOperation,
  windowsPaths,
  type WindowsPathProbe,
  type WindowsSdkBundleRecord,
} from "../src/platforms/windows.js";
import { contextFor } from "./helpers.js";

const root = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const wowRoot =
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const cache = "C:\\ProgramData\\Package Cache";

function registryRecord(
  registryKey: string,
  displayName: string,
  bundleCachePath: string | undefined,
  options: {
    readonly displayType?: string;
    readonly pathType?: string;
  } = {},
): string {
  return [
    registryKey,
    `    DisplayName    ${options.displayType ?? "REG_SZ"}    ${displayName}`,
    ...(bundleCachePath === undefined
      ? []
      : [
          `    BundleCachePath    ${options.pathType ?? "REG_SZ"}    ${bundleCachePath}`,
        ]),
  ].join("\r\n");
}

const wdkPath = `${cache}\\{wdk-id}\\wdksetup.exe`;
const sdkPath = `${cache}\\{sdk-id}\\sdksetup.exe`;

const wdk: WindowsSdkBundleRecord = {
  registryKey: `${root}\\{wdk-id}`,
  displayName: "Windows Driver Kit",
  kind: "wdk",
  bundleCachePath: wdkPath,
};

const sdk: WindowsSdkBundleRecord = {
  registryKey: `${root}\\{sdk-id}`,
  displayName: "Windows Software Development Kit",
  kind: "sdk",
  bundleCachePath: sdkPath,
};

function pathStats(
  kind: "directory" | "file",
  options: {
    readonly link?: boolean;
    readonly fileAttributes?: number;
    readonly dev?: bigint;
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
      dev: options.dev ?? 1n,
      ino: options.ino ?? 2n,
      size: options.size ?? 3n,
      mtimeNs: options.mtimeNs ?? 4n,
    },
    { fileAttributes: options.fileAttributes ?? 0 },
  );
}

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function safeBundleProbe(
  bundleStats?: (
    path: string,
  ) => Awaited<ReturnType<WindowsPathProbe["lstat"]>>,
): WindowsPathProbe {
  const identities = new Map<string, bigint>();
  const inspectBundle =
    bundleStats ??
    ((path: string) => {
      let identity = identities.get(path);
      if (identity === undefined) {
        identity = BigInt(identities.size + 100);
        identities.set(path, identity);
      }
      return pathStats("file", { ino: identity });
    });
  return {
    lstat: async (path) =>
      win32.extname(path).toLowerCase() === ".exe"
        ? inspectBundle(path)
        : pathStats("directory", { ino: 10n }),
  };
}

function testPaths() {
  return {
    drive: "C:\\",
    systemRoot: "C:\\Windows",
    system32: "C:\\Windows\\System32",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    programData: "C:\\ProgramData",
    commonProgramFiles: "C:\\Program Files\\Common Files",
    defaultUser: "C:\\Users\\runneradmin",
    chocolatey: "C:\\ProgramData\\chocolatey\\bin\\choco.exe",
    reg: "C:\\Windows\\System32\\reg.exe",
    msiexec: "C:\\Windows\\System32\\msiexec.exe",
    serviceControl: "C:\\Windows\\System32\\sc.exe",
    visualStudioInstaller:
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer",
    vswhere:
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
  } as const;
}

test("Windows SDK registry parser accepts exact legacy bundle names and classifies both kinds", () => {
  const accepted = parseWindowsSdkBundleRegistry(
    [
      registryRecord(
        `${root}\\{sdk-id}`,
        "Windows Software Development Kit",
        sdkPath,
      ),
      registryRecord(
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{wdk-id}",
        "Windows Driver Kit",
        wdkPath,
      ),
      registryRecord(
        `${root}\\{other-id}`,
        "Windows Software Development Kit Preview",
        `${cache}\\{other-id}\\setup.exe`,
      ),
    ].join("\r\n"),
    root,
  );

  assert.deepEqual(accepted, [sdk, wdk]);
});

test("Windows SDK registry parser accepts bounded runner-image version suffixes", () => {
  const versionedSdkPath = `${cache}\\{versioned-sdk}\\sdksetup.exe`;
  const versionedWdkPath = `${cache}\\{versioned-wdk}\\wdksetup.exe`;

  assert.deepEqual(
    parseWindowsSdkBundleRegistry(
      [
        registryRecord(
          `${root}\\{versioned-sdk}`,
          "Windows Software Development Kit - Windows 10.0.26100.7705",
          versionedSdkPath,
        ),
        registryRecord(
          `${root}\\{versioned-wdk}`,
          "Windows Driver Kit - Windows 10.0.26100.6584",
          versionedWdkPath,
        ),
      ].join("\r\n"),
      root,
    ),
    [
      {
        registryKey: `${root}\\{versioned-sdk}`,
        displayName:
          "Windows Software Development Kit - Windows 10.0.26100.7705",
        kind: "sdk",
        bundleCachePath: versionedSdkPath,
      },
      {
        registryKey: `${root}\\{versioned-wdk}`,
        displayName: "Windows Driver Kit - Windows 10.0.26100.6584",
        kind: "wdk",
        bundleCachePath: versionedWdkPath,
      },
    ],
  );
});

test("Windows SDK registry parser rejects preview and lookalike bundle names", () => {
  for (const [index, displayName] of [
    "Windows Driver Kit Preview",
    "Windows Driver Kit - Windows 10.0.26100.6584 Preview",
    "Windows Driver Kit Visual Studio Extension",
    "Windows Driver Kit - Windows 10.0",
    "Windows Driver Kit - Windows 10.0.26100",
    "Windows Driver Kit - Windows 10.0.26100.beta",
    "Windows Driver Kit - Windows 10.0.12345678901.6584",
    "Windows Driver Kit - Windows 11.0.26100.6584",
    "Windows Driver Kit - Windows 10.0.26100.6584.1",
    "Windows Software Development Kit AddOn",
  ].entries()) {
    assert.deepEqual(
      parseWindowsSdkBundleRegistry(
        registryRecord(
          `${root}\\{lookalike-${index}}`,
          displayName,
          `${cache}\\{lookalike-${index}}\\setup.exe`,
        ),
        root,
      ),
      [],
      displayName,
    );
  }
});

test("Windows SDK registry parser rejects incomplete, duplicate, conflicting, and wrong-typed records", () => {
  for (const output of [
    registryRecord(`${root}\\{missing-path}`, "Windows Driver Kit", undefined),
    [
      `${root}\\{duplicate-name}`,
      "    DisplayName    REG_SZ    Windows Driver Kit",
      "    DisplayName    REG_SZ    Windows Driver Kit",
      `    BundleCachePath    REG_SZ    ${wdkPath}`,
    ].join("\r\n"),
    [
      `${root}\\{conflicting-path}`,
      "    DisplayName    REG_SZ    Windows Driver Kit",
      `    BundleCachePath    REG_SZ    ${wdkPath}`,
      `    BundleCachePath    REG_SZ    ${sdkPath}`,
    ].join("\r\n"),
    registryRecord(
      `${root}\\{wrong-name-type}`,
      "Windows Driver Kit",
      wdkPath,
      { displayType: "REG_EXPAND_SZ" },
    ),
    registryRecord(
      `${root}\\{wrong-path-type}`,
      "Windows Driver Kit",
      wdkPath,
      { pathType: "REG_EXPAND_SZ" },
    ),
  ]) {
    assert.deepEqual(parseWindowsSdkBundleRegistry(output, root), []);
  }
});

test("Windows SDK registry parser rejects relative and non-descendant cache paths", () => {
  for (const candidate of [
    "setup.exe",
    cache,
    "C:\\ProgramData\\Package Cache sibling\\{id}\\setup.exe",
    "C:\\ProgramData\\other\\setup.exe",
    "D:\\ProgramData\\Package Cache\\{id}\\setup.exe",
    `${cache}\\..\\outside\\setup.exe`,
  ]) {
    assert.deepEqual(
      parseWindowsSdkBundleRegistry(
        registryRecord(`${root}\\{unsafe-id}`, "Windows Driver Kit", candidate),
        root,
      ),
      [],
      candidate,
    );
  }
});

test("Windows SDK registry parser rejects padded registry key lines", () => {
  for (const paddedKey of [
    ` ${root}\\{padded-key}`,
    `${root}\\{padded-key} `,
    `\t${root}\\{padded-key}`,
    `${root}\\{padded-key}\t`,
  ]) {
    assert.deepEqual(
      parseWindowsSdkBundleRegistry(
        registryRecord(paddedKey, "Windows Driver Kit", wdkPath),
        root,
      ),
      [],
    );
  }

  assert.deepEqual(
    parseWindowsSdkBundleRegistry(
      [
        registryRecord(
          `${root}\\{padded-shadow}`,
          "Windows Driver Kit",
          wdkPath,
        ),
        registryRecord(
          `${root}\\{padded-shadow} `,
          "Windows Driver Kit",
          wdkPath,
        ),
      ].join("\r\n"),
      root,
    ),
    [],
  );
});

test("Windows SDK registry parser preserves safe path spelling exactly", () => {
  const unnormalizedPath = `${cache}\\{raw-path}\\.\\wdksetup.exe`;
  assert.equal(
    parseWindowsSdkBundleRegistry(
      registryRecord(
        `${root}\\{raw-path}`,
        "Windows Driver Kit",
        unnormalizedPath,
      ),
      root,
    )[0]?.bundleCachePath,
    unnormalizedPath,
  );
});

test("Windows SDK registry parser rejects padded accepted metadata", () => {
  for (const [displayName, bundleCachePath] of [
    [" Windows Driver Kit", wdkPath],
    ["Windows Driver Kit ", wdkPath],
    ["Windows Driver Kit", ` ${wdkPath}`],
    ["Windows Driver Kit", `${wdkPath} `],
  ] as const) {
    assert.deepEqual(
      parseWindowsSdkBundleRegistry(
        registryRecord(
          `${root}\\{padded-metadata}`,
          displayName,
          bundleCachePath,
        ),
        root,
      ),
      [],
    );
  }
});

test("Windows SDK registry parser rejects malformed targeted lines before valid shadows", () => {
  for (const malformed of [
    "    DisplayName    BROKEN    Windows Driver Kit",
    `    BundleCachePath    BROKEN    ${wdkPath}`,
    "DisplayName    BROKEN    Windows Driver Kit",
    `BundleCachePath    BROKEN    ${wdkPath}`,
  ]) {
    assert.deepEqual(
      parseWindowsSdkBundleRegistry(
        [
          `${root}\\{malformed-shadow}`,
          malformed,
          "    DisplayName    REG_SZ    Windows Driver Kit",
          `    BundleCachePath    REG_SZ    ${wdkPath}`,
        ].join("\r\n"),
        root,
      ),
      [],
    );
  }
});

test("standalone Windows SDK validation rejects links, reparse points, and directories", async () => {
  for (const stats of [
    pathStats("file", { link: true }),
    pathStats("file", { fileAttributes: 0x400 }),
    pathStats("directory"),
    pathStats("directory", { link: true }),
  ]) {
    let executed = false;
    const operation = standaloneWindowsSdkOperation(
      contextFor("windows"),
      testPaths(),
      {
        inventory: async () => [wdk],
        probe: safeBundleProbe(() => stats),
        execute: async () => {
          executed = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.ok(operation.validate);
    await assert.rejects(operation.validate(), /unexpected bundle file type/);
    assert.equal(executed, false);
  }
});

test("standalone Windows SDK batches native attributes for its complete followed prefix", async () => {
  const attributeBatches: string[][] = [];
  const withoutEmbeddedAttributes = (
    stats: Awaited<ReturnType<WindowsPathProbe["lstat"]>>,
  ): Awaited<ReturnType<WindowsPathProbe["lstat"]>> => {
    const { fileAttributes: _fileAttributes, ...plainStats } = stats;
    return plainStats;
  };
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk],
      probe: {
        lstat: async (path) =>
          withoutEmbeddedAttributes(
            path === wdkPath ? pathStats("file") : pathStats("directory"),
          ),
        fileAttributes: async (paths) => {
          attributeBatches.push([...paths]);
          return paths.map(() => 0);
        },
      },
    },
  );
  assert.ok(operation.validate);

  await operation.validate();

  assert.deepEqual(attributeBatches, [
    ["C:\\ProgramData", cache, `${cache}\\{wdk-id}`, wdkPath],
  ]);
});

test("standalone Windows SDK rejects a selected bundle identity transition during its attribute probe", async () => {
  let attributeCalls = 0;
  let selectedTransitioned = false;
  let executions = 0;
  const attributeBatches: string[][] = [];
  const events: string[] = [];
  const withoutEmbeddedAttributes = (
    stats: Awaited<ReturnType<WindowsPathProbe["lstat"]>>,
  ): Awaited<ReturnType<WindowsPathProbe["lstat"]>> => {
    const { fileAttributes: _fileAttributes, ...plainStats } = stats;
    return plainStats;
  };
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk, sdk],
      probe: {
        lstat: async (path) => {
          events.push(`lstat:${path}`);
          return withoutEmbeddedAttributes(
            path === wdkPath
              ? pathStats("file", {
                  ino: selectedTransitioned ? 999n : 100n,
                })
              : path === sdkPath
                ? pathStats("file", { ino: 200n })
                : pathStats("directory", { ino: 10n }),
          );
        },
        fileAttributes: async (paths) => {
          attributeCalls += 1;
          attributeBatches.push([...paths]);
          events.push(`attributes:${paths.at(-1) ?? "missing"}`);
          if (attributeCalls === 5) selectedTransitioned = true;
          return paths.map(() => 0);
        },
      },
      execute: async () => {
        executions += 1;
        events.push("execute");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /selected bundle.*changed|identity.*changed/i,
  );
  assert.equal(executions, 0);
  assert.deepEqual(attributeBatches.at(-1), [
    "C:\\ProgramData",
    cache,
    `${cache}\\{wdk-id}`,
    wdkPath,
  ]);
  assert.equal(attributeBatches.at(-1)?.includes(sdkPath), false);
  assert.equal(events.at(-1), `lstat:${wdkPath}`);
});

test("standalone Windows SDK rejects selected bundle metadata drift during its attribute probe", async () => {
  let attributeCalls = 0;
  let selectedTransitioned = false;
  let executions = 0;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk],
      probe: {
        lstat: async (path) => {
          const stats =
            path === wdkPath
              ? pathStats("file", {
                  ino: 100n,
                  size: selectedTransitioned ? 999n : 3n,
                })
              : pathStats("directory", { ino: 10n });
          const { fileAttributes: _fileAttributes, ...plainStats } = stats;
          return plainStats;
        },
        fileAttributes: async (paths) => {
          attributeCalls += 1;
          if (attributeCalls === 3) selectedTransitioned = true;
          return paths.map(() => 0);
        },
      },
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /selected bundle.*changed|identity.*changed/i,
  );
  assert.equal(executions, 0);
});

test("standalone Windows SDK executes immediately after the selected post-attribute lstat", async () => {
  let inventoryCalls = 0;
  let attributeCalls = 0;
  const events: string[] = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => {
        inventoryCalls += 1;
        events.push(`inventory:${inventoryCalls}`);
        return inventoryCalls < 4 ? [wdk] : [];
      },
      probe: {
        lstat: async (path) => {
          events.push(`lstat:${path}`);
          const stats =
            path === wdkPath
              ? pathStats("file", { ino: 100n })
              : pathStats("directory", { ino: 10n });
          const { fileAttributes: _fileAttributes, ...plainStats } = stats;
          return plainStats;
        },
        fileAttributes: async (paths) => {
          attributeCalls += 1;
          events.push(`attributes:${paths.at(-1) ?? "missing"}`);
          return paths.map(() => 0);
        },
      },
      execute: async () => {
        assert.deepEqual(events.slice(-10), [
          "inventory:3",
          "lstat:C:\\ProgramData",
          `lstat:${cache}`,
          `lstat:${cache}\\{wdk-id}`,
          `lstat:${wdkPath}`,
          `attributes:${wdkPath}`,
          "lstat:C:\\ProgramData",
          `lstat:${cache}`,
          `lstat:${cache}\\{wdk-id}`,
          `lstat:${wdkPath}`,
        ]);
        events.push("execute");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();

  assert.equal((await operation.run()).status, "removed");
  assert.equal(attributeCalls, 3);
  assert.equal(events.filter((event) => event === "execute").length, 1);
  assert.deepEqual(
    events.filter((event) => event.startsWith("inventory:")),
    ["inventory:1", "inventory:2", "inventory:3", "inventory:4"],
  );
});

test("standalone Windows SDK fails closed on malformed native attribute batches", async () => {
  for (const fileAttributes of [
    async () => [] as number[],
    async (paths: readonly string[]) =>
      new Array<number>(paths.length) as number[],
  ]) {
    const operation = standaloneWindowsSdkOperation(
      contextFor("windows"),
      testPaths(),
      {
        inventory: async () => [wdk],
        probe: {
          lstat: async (path) => {
            const stats =
              path === wdkPath ? pathStats("file") : pathStats("directory");
            const { fileAttributes: _fileAttributes, ...plainStats } = stats;
            return plainStats;
          },
          fileAttributes,
        },
      },
    );
    assert.ok(operation.validate);
    await assert.rejects(operation.validate(), /attribute probe.*malformed/i);
  }
});

test("standalone Windows SDK ignores registry records whose bundle files are missing", async () => {
  let executions = 0;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk],
      probe: safeBundleProbe(() => {
        throw missing();
      }),
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "not-found");
  assert.equal(executions, 0);
});

test("standalone Windows SDK refuses to run without a validation snapshot", async () => {
  let inventoryCalls = 0;
  let executions = 0;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => {
        inventoryCalls += 1;
        return [wdk];
      },
      probe: safeBundleProbe(),
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /not validated before execution/);
  assert.equal(inventoryCalls, 0);
  assert.equal(executions, 0);
});

test("standalone Windows SDK fails closed when fixed reg.exe is missing", async () => {
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      registryExecutableExists: async () => false,
      queryRegistry: async () => assert.fail("missing reg.exe must not run"),
    },
  );
  assert.ok(operation.validate);
  await assert.rejects(
    operation.validate(),
    /fixed registry executable.*missing/i,
  );
});

test("standalone Windows SDK rejects truncated registry inventory", async () => {
  const paths = testPaths();
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    paths,
    {
      registryExecutableExists: async (executable) => {
        assert.equal(executable, paths.reg);
        return true;
      },
      queryRegistry: async (executable) => {
        assert.equal(executable, paths.reg);
        return {
          exitCode: 0,
          stdout: registryRecord(
            `${root}\\{truncated}`,
            "Windows Driver Kit",
            wdkPath,
          ),
          stderr: "",
          stdoutTruncated: true,
        };
      },
    },
  );
  assert.ok(operation.validate);
  await assert.rejects(operation.validate(), /registry inventory.*truncated/i);
});

test("standalone Windows SDK queries only the fixed reg.exe and HKLM roots", async () => {
  const paths = testPaths();
  const queries: Array<{
    executable: string;
    args: readonly string[];
  }> = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    paths,
    {
      registryExecutableExists: async (executable) => {
        assert.equal(executable, paths.reg);
        return true;
      },
      queryRegistry: async (executable, args) => {
        queries.push({ executable, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  assert.deepEqual(queries, [
    { executable: paths.reg, args: ["query", root, "/s"] },
    { executable: paths.reg, args: ["query", wowRoot, "/s"] },
  ]);
});

test("standalone Windows SDK preflights every bundle and runs WDK before SDK with exact arguments", async () => {
  let inventoryCalls = 0;
  const probed: string[] = [];
  const executions: Array<{ executable: string; args: readonly string[] }> = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => {
        inventoryCalls += 1;
        if (inventoryCalls <= 3) return [sdk, wdk];
        if (inventoryCalls <= 5) return [sdk];
        return [];
      },
      probe: safeBundleProbe((path) => {
        probed.push(path);
        return pathStats("file", { ino: path === wdkPath ? 10n : 20n });
      }),
      execute: async (executable, args) => {
        assert.equal(
          probed.length,
          executions.length === 0 ? 5 : 7,
          "every pending file must be re-statted before each spawn",
        );
        executions.push({ executable, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "removed");
  assert.deepEqual(
    executions.map(({ executable }) => executable),
    [wdkPath, sdkPath],
  );
  assert.deepEqual(
    executions.map(({ args }) => args),
    [
      ["/uninstall", "/quiet", "/norestart"],
      ["/uninstall", "/quiet", "/norestart"],
    ],
  );
});

test("standalone Windows SDK refuses inventory membership and metadata drift before spawn", async () => {
  for (const changed of [
    [wdk],
    [{ ...wdk, bundleCachePath: `${cache}\\{changed}\\wdksetup.exe` }],
  ] satisfies readonly (readonly WindowsSdkBundleRecord[])[]) {
    let calls = 0;
    let executed = false;
    const operation = standaloneWindowsSdkOperation(
      contextFor("windows"),
      testPaths(),
      {
        inventory: async () => (++calls === 1 ? [wdk, sdk] : changed),
        probe: safeBundleProbe(),
        execute: async () => {
          executed = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(
      result.detail ?? "",
      /inventory changed after plan validation/,
    );
    assert.equal(executed, false);
  }
});

test("standalone Windows SDK preserves versioned display names for drift detection", async () => {
  const initial: WindowsSdkBundleRecord = {
    ...wdk,
    displayName: "Windows Driver Kit - Windows 10.0.26100.6584",
  };
  const changed: WindowsSdkBundleRecord = {
    ...initial,
    displayName: "Windows Driver Kit - Windows 10.0.26100.7705",
  };
  let calls = 0;
  let executed = false;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => (++calls === 1 ? [initial] : [changed]),
      probe: safeBundleProbe(),
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /inventory changed after plan validation/);
  assert.equal(executed, false);
});

test("standalone Windows SDK refuses identity drift in any bundle before first spawn", async () => {
  let sdkStats = 0;
  let executed = false;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk, sdk],
      probe: safeBundleProbe((path) => {
        if (path !== sdkPath) return pathStats("file", { ino: 10n });
        sdkStats += 1;
        return pathStats("file", { ino: sdkStats === 1 ? 20n : 99n });
      }),
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /bundle file changed after plan validation/,
  );
  assert.equal(executed, false);
});

test("standalone Windows SDK rechecks the selected record after inspecting every pending candidate", async () => {
  let sdkChecks = 0;
  let selectedMutated = false;
  let inventoryCalls = 0;
  const executions: string[] = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => {
        inventoryCalls += 1;
        return [wdk, sdk];
      },
      probe: safeBundleProbe((path) => {
        if (path === sdkPath && ++sdkChecks === 2) selectedMutated = true;
        return pathStats("file", {
          ino: path === wdkPath ? (selectedMutated ? 99n : 10n) : 20n,
        });
      }),
      execute: async (executable) => {
        executions.push(executable);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed.*immediately before spawn/i);
  assert.ok(inventoryCalls >= 3, "selected record metadata was not refreshed");
  assert.deepEqual(executions, []);
});

test("standalone Windows SDK rejects distinct present records with one physical identity", async () => {
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk, sdk],
      probe: safeBundleProbe(() => pathStats("file", { dev: 7n, ino: 42n })),
    },
  );
  assert.ok(operation.validate);
  await assert.rejects(operation.validate(), /duplicate.*physical/i);
});

test("standalone Windows SDK rejects a duplicate physical identity on a refreshed inventory", async () => {
  const checks = new Map<string, number>();
  let executed = false;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk, sdk],
      probe: safeBundleProbe((path) => {
        const count = (checks.get(path) ?? 0) + 1;
        checks.set(path, count);
        return pathStats("file", {
          dev: 7n,
          ino: count === 1 ? (path === wdkPath ? 10n : 20n) : 42n,
        });
      }),
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /duplicate.*physical/i);
  assert.equal(executed, false);
});

test("standalone Windows SDK revalidates the second candidate after the first completes", async () => {
  let firstCompleted = false;
  const executions: string[] = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk, sdk],
      probe: safeBundleProbe((path) =>
        pathStats("file", {
          ino: path === wdkPath ? 10n : firstCompleted ? 99n : 20n,
        }),
      ),
      execute: async (executable) => {
        executions.push(executable);
        if (executable === wdkPath) firstCompleted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed.*before spawn/i);
  assert.deepEqual(executions, [wdkPath]);
});

test("standalone Windows SDK ignores completed records while revalidating pending candidates", async () => {
  let inventoryCalls = 0;
  let firstCompleted = false;
  const executions: string[] = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () =>
        ++inventoryCalls <= 3 ? [wdk, sdk] : inventoryCalls <= 5 ? [sdk] : [],
      probe: safeBundleProbe((path) =>
        pathStats("file", {
          ino: path === wdkPath ? (firstCompleted ? 99n : 10n) : 20n,
        }),
      ),
      execute: async (executable) => {
        executions.push(executable);
        if (executable === wdkPath) firstCompleted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.deepEqual(executions, [wdkPath, sdkPath]);
});

test("standalone Windows SDK permits shared ancestor content metadata changes", async () => {
  let inventoryCalls = 0;
  let firstCompleted = false;
  const executions: string[] = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () =>
        ++inventoryCalls <= 3 ? [wdk, sdk] : inventoryCalls <= 5 ? [sdk] : [],
      probe: {
        lstat: async (path) =>
          win32.extname(path).toLowerCase() === ".exe"
            ? pathStats("file", {
                ino: path === wdkPath ? 10n : 20n,
              })
            : pathStats("directory", {
                ino: 10n,
                size: firstCompleted ? 30n : 3n,
                mtimeNs: firstCompleted ? 40n : 4n,
              }),
      },
      execute: async (executable) => {
        executions.push(executable);
        if (executable === wdkPath) firstCompleted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.deepEqual(executions, [wdkPath, sdkPath]);
});

test("standalone Windows SDK rejects Package Cache and intermediate ancestor links or files", async () => {
  const candidateParent = `${cache}\\{wdk-id}`;
  for (const [unsafePath, unsafeStats] of [
    ["C:\\ProgramData", pathStats("directory", { fileAttributes: 0x400 })],
    [cache, pathStats("directory", { link: true })],
    [cache, pathStats("directory", { fileAttributes: 0x400 })],
    [cache, pathStats("file")],
    [candidateParent, pathStats("directory", { link: true })],
    [candidateParent, pathStats("directory", { fileAttributes: 0x400 })],
    [candidateParent, pathStats("file")],
  ] as const) {
    let executed = false;
    const operation = standaloneWindowsSdkOperation(
      contextFor("windows"),
      testPaths(),
      {
        inventory: async () => [wdk],
        probe: {
          lstat: async (path) => {
            if (path === unsafePath) return unsafeStats;
            if (path === wdkPath) return pathStats("file");
            return pathStats("directory");
          },
        },
        execute: async () => {
          executed = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.ok(operation.validate);
    await assert.rejects(operation.validate(), /ancestor.*type/i);
    assert.equal(executed, false);
  }
});

test("standalone Windows SDK rejects Package Cache ancestor identity drift", async () => {
  let cacheChecks = 0;
  let executed = false;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => [wdk],
      probe: {
        lstat: async (path) => {
          if (path === wdkPath) return pathStats("file");
          if (path === cache) {
            cacheChecks += 1;
            return pathStats("directory", {
              ino: cacheChecks === 1 ? 10n : 99n,
            });
          }
          return pathStats("directory", { ino: 20n });
        },
      },
      execute: async () => {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed.*before spawn/i);
  assert.equal(executed, false);
});

test("standalone Windows SDK rejects pending ancestor drift after a completed candidate", async () => {
  const sdkParent = `${cache}\\{sdk-id}`;
  let firstCompleted = false;
  const executions: string[] = [];
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => (firstCompleted ? [sdk] : [wdk, sdk]),
      probe: {
        lstat: async (path) => {
          if (path === wdkPath || path === sdkPath) {
            return pathStats("file", {
              ino: path === wdkPath ? 10n : 20n,
            });
          }
          return pathStats("directory", {
            ino: path === sdkParent && firstCompleted ? 99n : 10n,
          });
        },
      },
      execute: async (executable) => {
        executions.push(executable);
        if (executable === wdkPath) firstCompleted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed.*before spawn/i);
  assert.deepEqual(executions, [wdkPath]);
});

test("standalone Windows SDK accepts reboot-required success", async () => {
  let calls = 0;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => (++calls < 4 ? [wdk] : []),
      probe: safeBundleProbe(),
      execute: async () => ({ exitCode: 3010, stdout: "", stderr: "" }),
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
});

test("standalone Windows SDK reports command failure", async () => {
  let calls = 0;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => (++calls < 4 ? [wdk] : []),
      probe: safeBundleProbe(),
      execute: async () => ({ exitCode: 5, stdout: "", stderr: "denied" }),
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /denied/);
});

test("standalone Windows SDK fails with bounded diagnostics when accepted entries remain", async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    ...wdk,
    registryKey: `${root}\\{wdk-${index}}`,
    bundleCachePath: `${cache}\\{wdk-${index}}\\wdksetup.exe`,
  }));
  let calls = 0;
  const operation = standaloneWindowsSdkOperation(
    contextFor("windows"),
    testPaths(),
    {
      inventory: async () => (++calls < 4 ? [wdk] : many),
      probe: safeBundleProbe(),
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /standalone Windows SDK\/WDK bundle/);
  assert.ok((result.detail?.length ?? 0) <= 1024);
});

test(
  "native Windows standalone SDK registry inventory validates without mutation",
  { skip: process.platform !== "win32" },
  async () => {
    const livePaths = windowsPaths();
    const records: WindowsSdkBundleRecord[] = [];

    for (const registryRoot of [root, wowRoot]) {
      const result = await runCommand(
        livePaths.reg,
        ["query", registryRoot, "/s"],
        { silent: true, timeoutMs: 2 * 60_000 },
      );
      assert.equal(
        result.exitCode,
        0,
        `supported Windows images must expose '${registryRoot}'`,
      );
      assert.notEqual(
        result.stdoutTruncated,
        true,
        `registry inventory for '${registryRoot}' must fit the production capture bound`,
      );
      records.push(
        ...parseWindowsSdkBundleRegistry(result.stdout, registryRoot),
      );
    }

    assert.ok(
      records.some(({ kind }) => kind === "sdk"),
      "supported Windows images must expose an eligible standalone Windows SDK bundle",
    );

    const context = {
      ...contextFor("windows"),
      architecture: process.arch === "arm64" ? "arm64" : "x64",
    } as const;
    const operation = standaloneWindowsSdkOperation(context, livePaths, {
      inventory: async () => records,
    });
    assert.ok(operation.validate);
    await operation.validate();
  },
);
