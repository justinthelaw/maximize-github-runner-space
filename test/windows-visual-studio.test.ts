import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import { executeOperations } from "../src/operations.js";
import {
  discoverVisualStudioInstances,
  WINDOWS_SDK_COMPONENTS,
  visualStudioOperation,
  windowsPaths,
  windowsSdkOperation,
  type VisualStudioInstance,
  type WindowsPathProbe,
  type WindowsPaths,
} from "../src/platforms/windows.js";
import { contextFor } from "./helpers.js";

const paths: WindowsPaths = {
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
};

const setup = win32.join(paths.visualStudioInstaller, "setup.exe");
const enterprise: VisualStudioInstance = {
  installationPath:
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
  installationVersion: "17.14.37614.0",
  productId: "Microsoft.VisualStudio.Product.Enterprise",
};
const vs2026Enterprise: VisualStudioInstance = {
  installationPath:
    "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise",
  installationVersion: "18.9.12112.369",
  productId: "Microsoft.VisualStudio.Product.Enterprise",
};

function safeProbe(
  options: {
    readonly events?: string[];
    readonly instanceAttributes?: () => number;
    readonly instanceInode?: () => bigint;
    readonly setupInode?: () => bigint;
    readonly setupAttributes?: () => number;
  } = {},
): WindowsPathProbe {
  const identities = new Map<string, bigint>();
  return {
    lstat: async (path) => {
      options.events?.push(`lstat:${path}`);
      const canonical = win32.normalize(path).toLowerCase();
      let inode = identities.get(canonical);
      if (inode === undefined) {
        inode = BigInt(identities.size + 10);
        identities.set(canonical, inode);
      }
      const isSetup = canonical === setup.toLowerCase();
      const isInstance =
        canonical === enterprise.installationPath.toLowerCase();
      return {
        isDirectory: () => !isSetup,
        isFile: () => isSetup,
        isSymbolicLink: () => false,
        dev: 1n,
        ino: isSetup
          ? (options.setupInode?.() ?? inode)
          : isInstance
            ? (options.instanceInode?.() ?? inode)
            : inode,
        size: isSetup ? 1024n : 0n,
        mtimeNs: isSetup ? 5n : 0n,
      };
    },
    fileAttributes: async (observedPaths) => {
      options.events?.push(`attributes:${observedPaths.at(-1) ?? "missing"}`);
      return observedPaths.map((path) => {
        const canonical = win32.normalize(path).toLowerCase();
        if (canonical === setup.toLowerCase()) {
          return options.setupAttributes?.() ?? 0;
        }
        if (canonical === enterprise.installationPath.toLowerCase()) {
          return options.instanceAttributes?.() ?? 0;
        }
        return 0;
      });
    },
  };
}

test("Visual Studio uninstall refreshes inventory and proves removal", async () => {
  let installed: readonly VisualStudioInstance[] = [enterprise];
  const executions: { executable: string; args: readonly string[] }[] = [];
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    inventory: async () => installed,
    probe: safeProbe(),
    execute: async (executable, args) => {
      executions.push({ executable, args });
      installed = [];
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "removed");
  assert.deepEqual(executions, [
    {
      executable: setup,
      args: [
        "uninstall",
        "--installPath",
        enterprise.installationPath,
        "--quiet",
        "--norestart",
        "--force",
      ],
    },
  ]);
});

test("Visual Studio uninstall rejects inventory drift before spawn", async () => {
  let inventoryCalls = 0;
  let executions = 0;
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    inventory: async () => {
      inventoryCalls += 1;
      return inventoryCalls === 1
        ? [enterprise]
        : [{ ...enterprise, installationVersion: "17.10.2" }];
    },
    probe: safeProbe(),
    execute: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /inventory changed.*before/i);
  assert.equal(executions, 0);
});

for (const transition of ["identity", "reparse"] as const) {
  test(`Visual Studio uninstall rejects setup ${transition} drift before spawn`, async () => {
    let inventoryCalls = 0;
    let executions = 0;
    const operation = visualStudioOperation(contextFor("windows"), paths, {
      inventory: async () => {
        inventoryCalls += 1;
        return [enterprise];
      },
      probe: safeProbe({
        setupInode: () =>
          transition === "identity" && inventoryCalls >= 2 ? 999n : 20n,
        setupAttributes: () =>
          transition === "reparse" && inventoryCalls >= 2 ? 0x400 : 0,
      }),
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();

    const result = await operation.run();

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /setup|reparse|path changed/i);
    assert.equal(executions, 0);
  });
}

for (const transition of ["identity", "reparse"] as const) {
  test(`Visual Studio uninstall rejects instance ${transition} drift before spawn`, async () => {
    let inventoryCalls = 0;
    let executions = 0;
    const operation = visualStudioOperation(contextFor("windows"), paths, {
      inventory: async () => {
        inventoryCalls += 1;
        return [enterprise];
      },
      probe: safeProbe({
        instanceInode: () =>
          transition === "identity" && inventoryCalls >= 2 ? 999n : 30n,
        instanceAttributes: () =>
          transition === "reparse" && inventoryCalls >= 2 ? 0x400 : 0,
      }),
      execute: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();

    const result = await operation.run();

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /instance|reparse|path changed/i);
    assert.equal(executions, 0);
  });
}

test("Visual Studio setup observation is adjacent to spawn", async () => {
  let installed: readonly VisualStudioInstance[] = [enterprise];
  const events: string[] = [];
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    inventory: async () => {
      events.push("inventory");
      return installed;
    },
    probe: safeProbe({ events }),
    execute: async () => {
      events.push("execute");
      installed = [];
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();
  events.length = 0;

  assert.equal((await operation.run()).status, "removed");

  const executeIndex = events.indexOf("execute");
  assert.ok(executeIndex > 0);
  assert.equal(events[executeIndex - 1], `lstat:${setup}`);
});

test("Visual Studio uninstall rejects a no-op success postcondition", async () => {
  let executions = 0;
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    inventory: async () => [enterprise],
    probe: safeProbe(),
    execute: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /postcondition/);
  assert.equal(executions, 1);
});

test("Visual Studio uninstall fails when an inventoried instance has no trusted setup", async () => {
  const baseProbe = safeProbe();
  let executions = 0;
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    inventory: async () => [enterprise],
    probe: {
      ...baseProbe,
      lstat: async (path) => {
        if (win32.normalize(path).toLowerCase() === setup.toLowerCase()) {
          throw Object.assign(new Error("missing setup"), { code: "ENOENT" });
        }
        return await baseProbe.lstat(path);
      },
    },
    execute: async () => {
      executions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /setup|installer/i);
  assert.equal(executions, 0);
});

test("Visual Studio uninstall revalidates the remaining set before each spawn", async () => {
  let inventory: readonly VisualStudioInstance[] = [
    enterprise,
    vs2026Enterprise,
  ];
  let inventoryCalls = 0;
  let executions = 0;
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    inventory: async () => {
      inventoryCalls += 1;
      return inventoryCalls >= 4
        ? inventory.map((instance) =>
            instance === enterprise
              ? { ...instance, installationVersion: "17.11.1" }
              : instance,
          )
        : inventory;
    },
    probe: safeProbe(),
    execute: async (_executable, args) => {
      executions += 1;
      const selectedPath = args[2];
      inventory = inventory.filter(
        ({ installationPath }) => installationPath !== selectedPath,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /inventory changed.*before/i);
  assert.equal(executions, 1);
});

test("Windows SDK fallback cleans unchanged instances left by a partial Visual Studio uninstall", async () => {
  let installed: readonly VisualStudioInstance[] = [
    enterprise,
    vs2026Enterprise,
  ];
  let componentInstances: readonly VisualStudioInstance[] = [
    enterprise,
    vs2026Enterprise,
  ];
  const executions: Array<readonly [string, string]> = [];
  const dependencies = {
    inventory: async () => installed,
    componentInventory: async () => componentInstances,
    probe: safeProbe(),
    execute: async (_executable: string, args: readonly string[]) => {
      const command = args[0] ?? "";
      const installationPath = args[2] ?? "";
      executions.push([command, installationPath]);
      if (command === "uninstall") {
        if (installationPath === vs2026Enterprise.installationPath) {
          installed = installed.filter(
            (instance) => instance.installationPath !== installationPath,
          );
          componentInstances = componentInstances.filter(
            (instance) => instance.installationPath !== installationPath,
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "uninstall failed" };
      }
      componentInstances = componentInstances.filter(
        (instance) => instance.installationPath !== installationPath,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const results = await executeOperations([
    visualStudioOperation(contextFor("windows"), paths, dependencies),
    windowsSdkOperation(contextFor("windows"), paths, dependencies),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ["failed", "removed"],
  );
  assert.deepEqual(executions, [
    ["uninstall", vs2026Enterprise.installationPath],
    ["uninstall", enterprise.installationPath],
    ["modify", enterprise.installationPath],
  ]);
});

for (const [label, changedInventory] of [
  [
    "changed instance",
    [{ ...enterprise, installationVersion: "17.14.37614.1" }],
  ],
  ["new instance", [enterprise, vs2026Enterprise]],
] as const) {
  test(`Windows SDK fallback rejects a ${label} outside the validated subset`, async () => {
    let inventoryCalls = 0;
    let setupExecutions = 0;
    const operation = windowsSdkOperation(contextFor("windows"), paths, {
      componentInventory: async () => {
        inventoryCalls += 1;
        return inventoryCalls === 1 ? [enterprise] : changedInventory;
      },
      probe: safeProbe(),
      execute: async () => {
        setupExecutions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();

    const result = await operation.run();

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /inventory changed.*before/i);
    assert.equal(setupExecutions, 0);
  });
}

for (const satisfiesPostcondition of [false, true]) {
  test(`Windows SDK component cleanup ${
    satisfiesPostcondition ? "proves" : "rejects"
  } its postcondition`, async () => {
    let componentInstances: readonly VisualStudioInstance[] = [enterprise];
    const calls: { executable: string; args: readonly string[] }[] = [];
    const operation = windowsSdkOperation(contextFor("windows"), paths, {
      componentInventory: async () => componentInstances,
      probe: safeProbe(),
      execute: async (executable, args) => {
        calls.push({ executable, args });
        if (satisfiesPostcondition) componentInstances = [];
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();

    const result = await operation.run();

    assert.equal(result.status, satisfiesPostcondition ? "removed" : "failed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executable, setup);
    assert.equal(calls[0]?.args[0], "modify");
    assert.equal(calls[0]?.args.includes("--remove"), true);
    if (!satisfiesPostcondition) {
      assert.match(result.detail ?? "", /postcondition/);
    }
  });
}

test("Visual Studio discovery invokes fixed vswhere and parses only exact supported Enterprise records", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const instances = await discoverVisualStudioInstances(paths, [], {
    pathExists: async (path) =>
      path === paths.vswhere ||
      path === "C:\\ProgramData\\chocolatey\\bin\\vswhere.exe",
    execute: async (executable, args) => {
      calls.push({ executable, args });
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            installationPath:
              "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
            installationVersion: "17.14.37614.0",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "c:\\PROGRAM FILES\\MICROSOFT VISUAL STUDIO\\18\\ENTERPRISE",
            installationVersion: "18.9.12112.369",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "C:\\Program Files\\Microsoft Visual Studio\\2025\\Enterprise",
            installationVersion: "17.14.37614.0",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise",
            installationVersion: "18.9.12112.369",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Enterprise",
            installationVersion: "17.14.37614.0",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\nested",
            installationVersion: "17.14.37614.0",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
            installationVersion: "17.preview",
            productId: "Microsoft.VisualStudio.Product.Enterprise",
          },
          {
            installationPath:
              "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
            installationVersion: "17.14.37614.0",
            productId: "Microsoft.VisualStudio.Product.Community",
          },
        ]),
      };
    },
  });

  assert.deepEqual(calls, [
    {
      executable:
        "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
      args: [
        "-all",
        "-prerelease",
        "-products",
        "*",
        "-format",
        "json",
        "-utf8",
      ],
    },
  ]);
  assert.deepEqual(instances, [
    {
      installationPath:
        "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
      installationVersion: "17.14.37614.0",
      productId: "Microsoft.VisualStudio.Product.Enterprise",
    },
    {
      installationPath:
        "c:\\PROGRAM FILES\\MICROSOFT VISUAL STUDIO\\18\\ENTERPRISE",
      installationVersion: "18.9.12112.369",
      productId: "Microsoft.VisualStudio.Product.Enterprise",
    },
  ]);
});

for (const [label, result, expected] of [
  ["malformed JSON", { exitCode: 0, stdout: "{", stderr: "" }, /JSON/i],
  [
    "non-array JSON",
    { exitCode: 0, stdout: "{}", stderr: "" },
    /invalid JSON/i,
  ],
  [
    "truncated JSON output",
    {
      exitCode: 0,
      stdout: JSON.stringify([enterprise]),
      stderr: "",
      stdoutTruncated: true,
    },
    /truncated/i,
  ],
] as const) {
  test(`Visual Studio discovery rejects ${label}`, async () => {
    await assert.rejects(
      discoverVisualStudioInstances(paths, [], {
        pathExists: async (path) => path === paths.vswhere,
        execute: async () => result,
      }),
      expected,
    );
  });
}

for (const [label, installationPath, installationVersion] of [
  [
    "arbitrary version directory",
    "C:\\Program Files\\Microsoft Visual Studio\\2025\\Enterprise",
    "17.14.37614.0",
  ],
  [
    "Program Files x86 instance",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\Enterprise",
    "18.9.12112.369",
  ],
] as const) {
  test(`Visual Studio operation rejects injected ${label} inventory`, async () => {
    const operation = visualStudioOperation(contextFor("windows"), paths, {
      inventory: async () => [
        {
          installationPath,
          installationVersion,
          productId: "Microsoft.VisualStudio.Product.Enterprise",
        },
      ],
      probe: safeProbe(),
    });
    assert.ok(operation.validate);

    await assert.rejects(
      operation.validate(),
      /Refusing an invalid Visual Studio instance inventory/,
    );
  });
}

test("Windows SDK discovery invokes Chocolatey fallback with requires-any components", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const fallback = "C:\\ProgramData\\chocolatey\\bin\\vswhere.exe";
  const operation = windowsSdkOperation(contextFor("windows"), paths, {
    discovery: {
      pathExists: async (path) => path === fallback,
      execute: async (executable, args) => {
        calls.push({ executable, args });
        return {
          exitCode: 0,
          stderr: "",
          stdout: "[]",
        };
      },
    },
    probe: safeProbe(),
  });
  assert.ok(operation.validate);

  await operation.validate();

  assert.deepEqual(calls, [
    {
      executable: fallback,
      args: [
        "-all",
        "-prerelease",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.Windows10SDK.19041",
        "Microsoft.VisualStudio.Component.Windows11SDK.22621",
        "Microsoft.VisualStudio.Component.Windows11SDK.26100",
        "Component.Microsoft.Windows.DriverKit",
        "-requiresAny",
        "-format",
        "json",
        "-utf8",
      ],
    },
  ]);
});

test("Visual Studio operation preserves initial no-vswhere compatibility", async () => {
  const checkedPaths: string[] = [];
  let discoveryExecutions = 0;
  let setupExecutions = 0;
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    discovery: {
      pathExists: async (path) => {
        checkedPaths.push(path);
        return false;
      },
      execute: async () => {
        discoveryExecutions += 1;
        return { exitCode: 0, stdout: "[]", stderr: "" };
      },
    },
    probe: safeProbe(),
    execute: async () => {
      setupExecutions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);

  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "not-found");
  assert.deepEqual(checkedPaths, [
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
    "C:\\ProgramData\\chocolatey\\bin\\vswhere.exe",
  ]);
  assert.equal(discoveryExecutions, 0);
  assert.equal(setupExecutions, 0);
});

test("Visual Studio operation rejects false success if vswhere disappears after setup", async () => {
  let vswhereAvailable = true;
  let setupExecutions = 0;
  const operation = visualStudioOperation(contextFor("windows"), paths, {
    discovery: {
      pathExists: async (path) => vswhereAvailable && path === paths.vswhere,
      execute: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify([enterprise]),
      }),
    },
    probe: safeProbe(),
    execute: async () => {
      setupExecutions += 1;
      vswhereAvailable = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Visual Studio inventory unavailable/i);
  assert.equal(setupExecutions, 1);
});

test(
  "native Windows Visual Studio inventory validates without mutation",
  { skip: process.platform !== "win32" },
  async () => {
    const livePaths = windowsPaths();
    const instances = await discoverVisualStudioInstances(livePaths);
    assert.ok(
      instances.length > 0,
      "supported Windows images must expose a Visual Studio instance",
    );
    const sdkInstances = await discoverVisualStudioInstances(
      livePaths,
      WINDOWS_SDK_COMPONENTS,
    );
    assert.ok(
      sdkInstances.length > 0,
      "supported Windows images must expose a configured SDK or WDK component",
    );

    const context = {
      ...contextFor("windows"),
      architecture: process.arch === "arm64" ? "arm64" : "x64",
    } as const;
    const operations = [
      visualStudioOperation(context, livePaths),
      windowsSdkOperation(context, livePaths),
    ];
    for (const operation of operations) {
      assert.ok(operation.validate);
      await operation.validate();
    }
  },
);
