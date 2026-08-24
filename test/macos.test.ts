import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
  createMacOSAdapter as createNativeMacOSAdapter,
  inspectMacOSXcodeBundleIdentity,
  resolveDefinitionBrewExecutable,
  resolveMacOSDefinitionPath,
  validateDefinitionBrewConfigRoot,
  type BrewConfigProbe,
  type BrewConfigRootProbe,
  type MacOSAdapterDependencies,
  type BrewPathProbe,
  type MacOSBrewRunner,
  type MacOSXcodeBundleIdentity,
} from "../src/platforms/macos.js";
import {
  createFunctionOperation,
  executeOperations,
} from "../src/operations.js";
import type { Architecture, CleanupPlan, ComponentId } from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

async function createMacOSAdapter(
  context: Parameters<typeof createNativeMacOSAdapter>[0],
  dependencies: NonNullable<
    Parameters<typeof createNativeMacOSAdapter>[1]
  > = {},
) {
  const syntheticXcodeIdentities = new Map<
    string,
    NonNullable<
      Awaited<
        ReturnType<
          NonNullable<MacOSAdapterDependencies["inspectXcodeBundleIdentity"]>
        >
      >
    >
  >();
  const removedXcodeTargets = new Set<string>();
  let nextXcodeInode = 1_000n;
  const inspectXcodeBundleIdentity =
    dependencies.inspectXcodeBundleIdentity ??
    (async (path: string) => {
      if (removedXcodeTargets.has(path)) return undefined;
      let identity = syntheticXcodeIdentities.get(path);
      if (identity === undefined) {
        identity = {
          kind: "directory",
          device: 1n,
          inode: nextXcodeInode++,
          mode: 0o40755n,
          userId: 0n,
          groupId: 0n,
          linkCount: 1n,
          size: 128n,
          modifiedNanoseconds: 1_000n,
          changedNanoseconds: 2_000n,
        };
        syntheticXcodeIdentities.set(path, identity);
      }
      return identity;
    });
  const injectedXcodeRemoval = dependencies.removeXcodeTarget;
  const removeXcodeTarget =
    injectedXcodeRemoval === undefined ||
    dependencies.inspectXcodeBundleIdentity !== undefined
      ? injectedXcodeRemoval
      : async (target: string) => {
          const result = await injectedXcodeRemoval(target);
          if (result.status === "removed") removedXcodeTargets.add(target);
          return result;
        };
  return await createNativeMacOSAdapter(context, {
    // Unit tests inject all filesystem and command effects. Tests that exercise
    // protection ordering override this explicit no-op seam.
    runBrewConfigSystemUtility: async () => undefined,
    ...dependencies,
    inspectXcodeBundleIdentity,
    ...(removeXcodeTarget === undefined ? {} : { removeXcodeTarget }),
  });
}

const symlinkStats = {
  isFile: () => false,
  isSymbolicLink: () => true,
};

const fileStats = {
  isFile: () => true,
  isSymbolicLink: () => false,
};

const BREW_PATHS: Readonly<
  Record<
    Architecture,
    { candidate: string; candidateKind: "file" | "symlink"; executable: string }
  >
> = {
  arm64: {
    candidate: "/opt/homebrew/bin/brew",
    candidateKind: "file",
    executable: "/opt/homebrew/bin/brew",
  },
  x64: {
    candidate: "/usr/local/bin/brew",
    candidateKind: "symlink",
    executable: "/usr/local/Homebrew/bin/brew",
  },
};

const TEST_BREW_CONFIG_PREFIX =
  "/private/tmp/maximize-github-runner-space-homebrew-";

function testBrewConfigRoot(hexDigit: string): string {
  assert.match(hexDigit, /^[0-9a-f]$/);
  return `${TEST_BREW_CONFIG_PREFIX}${hexDigit.repeat(32)}`;
}

for (const architecture of ["arm64", "x64"] as const) {
  test(`macOS ${architecture} accepts only its verified definition Homebrew executable`, async () => {
    const definition = BREW_PATHS[architecture];
    const calls: string[] = [];
    const probe: BrewPathProbe = {
      lstat: async (path) => {
        calls.push(`lstat:${path}`);
        if (path === definition.candidate) {
          return definition.candidateKind === "symlink"
            ? symlinkStats
            : fileStats;
        }
        if (path === definition.executable) return fileStats;
        throw new Error(`unexpected lstat: ${path}`);
      },
      realpath: async (path) => {
        calls.push(`realpath:${path}`);
        assert.equal(path, definition.candidate);
        return definition.executable;
      },
      access: async (path, mode) => {
        calls.push(`access:${path}:${mode}`);
        assert.equal(path, definition.executable);
        assert.equal(mode, constants.X_OK);
      },
    };

    assert.equal(
      await resolveDefinitionBrewExecutable(architecture, probe),
      definition.executable,
    );
    const expectedCalls = [
      `lstat:${definition.candidate}`,
      `realpath:${definition.candidate}`,
      `access:${definition.executable}:${constants.X_OK}`,
    ];
    if (definition.executable !== definition.candidate) {
      expectedCalls.splice(2, 0, `lstat:${definition.executable}`);
    }
    assert.deepEqual(calls, expectedCalls);
  });
}

test("macOS ignores workflow PATH and the other architecture's Homebrew candidate", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/workflow/shims:/usr/local/bin";
  const inspected: string[] = [];
  const probe: BrewPathProbe = {
    lstat: async (path) => {
      inspected.push(path);
      // Model an attacker-provided Intel brew while the Apple Silicon
      // definition candidate is absent.
      if (path === BREW_PATHS.x64.candidate) return fileStats;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    realpath: async () => {
      throw new Error("a missing definition candidate must not be resolved");
    },
    access: async () => {
      throw new Error("a PATH-selected executable must not be accessed");
    },
  };

  try {
    assert.equal(
      await resolveDefinitionBrewExecutable("arm64", probe),
      undefined,
    );
    assert.deepEqual(inspected, [BREW_PATHS.arm64.candidate]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("macOS rejects a fixed Homebrew link redirected outside its definition prefix", async () => {
  const definition = BREW_PATHS.x64;
  const inspected: string[] = [];
  const probe: BrewPathProbe = {
    lstat: async (path) => {
      inspected.push(`lstat:${path}`);
      assert.equal(path, definition.candidate);
      return symlinkStats;
    },
    realpath: async (path) => {
      inspected.push(`realpath:${path}`);
      return "/workflow/shims/brew";
    },
    access: async () => {
      throw new Error("a redirected Homebrew target must not be accessed");
    },
  };

  assert.equal(await resolveDefinitionBrewExecutable("x64", probe), undefined);
  assert.deepEqual(inspected, [
    `lstat:${definition.candidate}`,
    `realpath:${definition.candidate}`,
  ]);
});

test("macOS Homebrew discovery distinguishes absence from inspection failure", async () => {
  await assert.rejects(
    async () =>
      await resolveDefinitionBrewExecutable("arm64", {
        lstat: async () =>
          Promise.reject(
            Object.assign(new Error("definition path denied"), {
              code: "EACCES",
            }),
          ),
        realpath: async () => BREW_PATHS.arm64.executable,
        access: async () => undefined,
      }),
    /definition path denied/,
  );
});

test("macOS Homebrew commands use a trusted environment and preserve unknown packages", async () => {
  const configRoot = testBrewConfigRoot("1");
  const preflightEvents: string[] = [];
  const environmentNames = [
    "PATH",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "HOMEBREW_BREW_FILE",
    "HOMEBREW_PATH",
    "HOMEBREW_FORCE_BREW_WRAPPER",
    "HOMEBREW_RUBY_PATH",
    "HOMEBREW_GIT_PATH",
    "HOMEBREW_XDG_CONFIG_HOME",
    "RUBYOPT",
    "BASH_ENV",
    "ENV",
  ] as const;
  const original = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of environmentNames) {
    process.env[name] = `/workflow-controlled/${name.toLowerCase()}`;
  }

  const calls: {
    executable: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
    options: { readonly silent: boolean; readonly timeoutMs: number };
  }[] = [];
  const installedFormulae = new Set([
    "homebrew/core/gh",
    "gradle",
    "workflow/tools/gh",
    "private/tools/gradle",
    "workflow/tools/private-formula",
  ]);
  const installedCasks = new Set([
    "google-chrome",
    "evil/browsers/google-chrome",
    "workflow-private-cask",
  ]);
  const execute: MacOSBrewRunner = async (
    executable,
    args,
    environment,
    options,
  ) => {
    calls.push({
      executable,
      args: [...args],
      environment: { ...environment },
      options,
    });
    if (args.join(" ") === "list --formula --full-name") {
      return {
        exitCode: 0,
        stdout: `${[...installedFormulae].join("\n")}\n`,
        stderr: "",
      };
    }
    if (args.join(" ") === "list --cask --full-name") {
      return {
        exitCode: 0,
        stdout: `${[...installedCasks].join("\n")}\n`,
        stderr: "",
      };
    }
    if (args[0] === "uninstall") {
      const installed = args.includes("--formula")
        ? installedFormulae
        : installedCasks;
      for (const name of [...installed]) {
        if (args.includes(name)) installed.delete(name);
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  try {
    const executable = BREW_PATHS.arm64.executable;
    const adapter = await createMacOSAdapter(contextFor("macos"), {
      resolveBrewExecutable: async (architecture) => {
        assert.equal(architecture, "arm64");
        return executable;
      },
      executeBrew: execute,
      inspectBrewConfig: async (path) => {
        preflightEvents.push(`inspect:${path}`);
        return undefined;
      },
      createBrewConfigRoot: async (prefix) => {
        assert.equal(
          prefix,
          "/private/tmp/maximize-github-runner-space-homebrew-",
        );
        preflightEvents.push("create");
        return configRoot;
      },
      validateBrewConfigRoot: async (path, requireEmpty) => {
        assert.equal(path, configRoot);
        assert.equal(requireEmpty, true);
        preflightEvents.push("validate:protected");
      },
      removeBrewConfigRoot: async (path) => {
        assert.equal(path, configRoot);
        preflightEvents.push(`remove:${path}`);
      },
    });
    const operations = await adapter.operations(planFor("homebrew"));
    const configuration = operations.find(
      ({ id }) => id === "macos:brew:configuration",
    );
    const packages = operations.find(
      ({ id }) => id === "brew:definition-packages",
    );
    const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");
    assert.ok(configuration);
    assert.ok(configuration.validate);
    assert.equal(configuration.phase, "preflight");
    assert.equal(configuration.fatal, true);
    assert.deepEqual(preflightEvents, []);
    await configuration.validate();
    assert.deepEqual(preflightEvents, [
      "inspect:/etc/homebrew/brew.env",
      "inspect:/opt/homebrew/etc/homebrew/brew.env",
    ]);
    assert.equal((await configuration.run()).status, "removed");
    assert.deepEqual(preflightEvents, [
      "inspect:/etc/homebrew/brew.env",
      "inspect:/opt/homebrew/etc/homebrew/brew.env",
      "inspect:/etc/homebrew/brew.env",
      "inspect:/opt/homebrew/etc/homebrew/brew.env",
      "create",
      "validate:protected",
    ]);
    assert.ok(packages);
    assert.ok(cleanup);
    assert.equal((await packages.run()).status, "removed");
    assert.equal((await cleanup.run()).status, "removed");
    assert.equal(
      preflightEvents.at(-1),
      `remove:${configRoot}`,
      "the final Homebrew operation must release its isolated configuration",
    );

    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        ["list", "--formula", "--full-name"],
        ["list", "--cask", "--full-name"],
        ["uninstall", "--cask", "--force", "google-chrome"],
        ["list", "--formula", "--full-name"],
        ["list", "--cask", "--full-name"],
        [
          "uninstall",
          "--formula",
          "--force",
          "--ignore-dependencies",
          "homebrew/core/gh",
          "gradle",
        ],
        ["list", "--formula", "--full-name"],
        ["list", "--cask", "--full-name"],
        ["cleanup", "--prune=all", "-s"],
      ],
    );
    assert.equal(
      calls.some(({ args }) =>
        args.some((argument) => argument.includes("workflow")),
      ),
      false,
      "workflow-installed unknown packages must not be passed to uninstall",
    );
    assert.equal(
      calls.some(({ args }) =>
        args.some(
          (argument) =>
            argument === "workflow/tools/gh" ||
            argument === "private/tools/gradle" ||
            argument === "evil/browsers/google-chrome",
        ),
      ),
      false,
      "custom-tap basename collisions must remain outside definition ownership",
    );
    assert.equal(
      calls.some(({ args }) => args[0] === "autoremove"),
      false,
      "autoremove could claim an unknown workflow-installed dependency",
    );

    const expectedEnvironmentKeys = [
      "CI",
      "HOME",
      "HOMEBREW_NO_ANALYTICS",
      "HOMEBREW_NO_AUTOREMOVE",
      "HOMEBREW_NO_AUTO_UPDATE",
      "HOMEBREW_NO_ENV_HINTS",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
      "XDG_CONFIG_HOME",
    ];
    for (const call of calls) {
      assert.equal(call.executable, executable);
      assert.deepEqual(
        Object.keys(call.environment).sort(),
        expectedEnvironmentKeys,
      );
      assert.equal(call.environment.HOME, "/Users/runner");
      assert.equal(call.environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
      assert.equal(call.environment.TMPDIR, "/private/tmp");
      assert.equal(call.environment.XDG_CONFIG_HOME, configRoot);
      assert.equal(call.environment.HOMEBREW_BREW_FILE, undefined);
      assert.equal(call.environment.HOMEBREW_PATH, undefined);
      assert.equal(call.environment.HOMEBREW_FORCE_BREW_WRAPPER, undefined);
      assert.equal(call.environment.HOMEBREW_RUBY_PATH, undefined);
      assert.equal(call.environment.HOMEBREW_GIT_PATH, undefined);
      assert.equal(call.environment.HOMEBREW_XDG_CONFIG_HOME, undefined);
      assert.equal(call.environment.RUBYOPT, undefined);
      assert.equal(call.environment.BASH_ENV, undefined);
      assert.equal(call.environment.ENV, undefined);
    }
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("macOS narrow Homebrew cleanup uninstalls only its package and releases configuration", async () => {
  const configRoot = testBrewConfigRoot("2");
  const commands: string[][] = [];
  const removedConfigRoots: string[] = [];
  const formulae = new Set(["homebrew/core/gh", "workflow/tools/gh"]);
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args) => {
      commands.push([...args]);
      if (args.join(" ") === "list --formula --full-name") {
        return {
          exitCode: 0,
          stdout: `${[...formulae].join("\n")}\n`,
          stderr: "",
        };
      }
      if (args.join(" ") === "list --cask --full-name") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "uninstall") {
        for (const name of args) formulae.delete(name);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async (path) => {
      removedConfigRoots.push(path);
    },
  });
  const operations = (await adapter.operations(planFor("gh-cli"))).filter(
    ({ id }) => id === "macos:brew:configuration" || id.startsWith("brew:"),
  );
  const configuration = operations[0];
  assert.equal(operations.length, 3);
  assert.ok(configuration?.validate);

  await configuration.validate();
  const results = [];
  for (const operation of operations) results.push(await operation.run());

  assert.deepEqual(
    results.map(({ status }) => status),
    ["removed", "removed", "removed"],
  );
  assert.deepEqual(commands, [
    ["list", "--formula", "--full-name"],
    ["list", "--cask", "--full-name"],
    [
      "uninstall",
      "--formula",
      "--force",
      "--ignore-dependencies",
      "homebrew/core/gh",
    ],
    ["list", "--formula", "--full-name"],
    ["list", "--cask", "--full-name"],
  ]);
  assert.equal(
    commands.some(
      ([command]) => command === "cleanup" || command === "autoremove",
    ),
    false,
  );
  assert.deepEqual([...formulae], ["workflow/tools/gh"]);
  assert.deepEqual(removedConfigRoots, [configRoot]);
});

test("macOS broad Homebrew cleanup still runs native cleanup and releases configuration", async () => {
  const configRoot = testBrewConfigRoot("2");
  const commands: string[][] = [];
  const removedConfigRoots: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args) => {
      commands.push([...args]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async (path) => {
      removedConfigRoots.push(path);
    },
  });
  const operations = (await adapter.operations(planFor("homebrew"))).filter(
    ({ id }) => id === "macos:brew:configuration" || id.startsWith("brew:"),
  );
  const configuration = operations[0];
  assert.equal(operations.length, 3);
  assert.ok(configuration?.validate);

  await configuration.validate();
  for (const operation of operations) await operation.run();

  assert.deepEqual(commands, [
    ["list", "--formula", "--full-name"],
    ["list", "--cask", "--full-name"],
    ["cleanup", "--prune=all", "-s"],
  ]);
  assert.equal(
    commands.some(([command]) => command === "autoremove"),
    false,
  );
  assert.deepEqual(removedConfigRoots, [configRoot]);
});

test("macOS Homebrew cleanup is a no-op when the fixed candidate is absent", async () => {
  let executed = false;
  let created = false;
  let removed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => undefined,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => {
      created = true;
      throw new Error("absent Homebrew must not create a configuration root");
    },
    removeBrewConfigRoot: async () => {
      removed = true;
      throw new Error("absent Homebrew must not remove a configuration root");
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const homebrew = operations.filter(
    ({ component }) => component === "homebrew",
  );
  assert.equal(homebrew.length, 3);
  for (const operation of homebrew) {
    assert.equal((await operation.run()).status, "not-found");
  }
  assert.equal(executed, false);
  assert.equal(created, false);
  assert.equal(removed, false);
});

test("macOS broad Homebrew cleanup removes the complete current runner-image package union", async () => {
  const officialFormulae = [
    "ant",
    "aria2",
    "azure-cli",
    "bazelisk",
    "carthage",
    "cmake",
    "gh",
    "gnupg",
    "gnu-tar",
    "kotlin",
    "libpq",
    "libsodium",
    "openssl@3",
    "p7zip",
    "packer",
    "perl",
    "pkgconf",
    "swiftformat",
    "tcl-tk@8",
    "zstd",
    "ninja",
    "gmp",
    "yq",
    "unxip",
    "xcbeautify",
    "xcodes",
  ] as const;
  const officialCasks = ["parallels"] as const;
  const formulae = new Set<string>([
    ...officialFormulae,
    "workflow/private-formula",
    "private/tools/cmake",
  ]);
  const casks = new Set<string>([
    ...officialCasks,
    "workflow-private-cask",
    "evil/cask/parallels",
  ]);
  const removed = new Set<string>();
  const execute: MacOSBrewRunner = async (_executable, args) => {
    if (args.join(" ") === "list --formula --full-name") {
      return {
        exitCode: 0,
        stdout: `${[...formulae].join("\n")}\n`,
        stderr: "",
      };
    }
    if (args.join(" ") === "list --cask --full-name") {
      return {
        exitCode: 0,
        stdout: `${[...casks].join("\n")}\n`,
        stderr: "",
      };
    }
    if (args[0] === "uninstall") {
      const inventory = args.includes("--formula") ? formulae : casks;
      for (const name of args
        .slice(1)
        .filter((value) => !value.startsWith("-"))) {
        removed.add(name);
        inventory.delete(name);
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: execute,
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => testBrewConfigRoot("2"),
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => undefined,
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");
  assert.ok(configuration?.validate);
  assert.ok(packages);
  assert.ok(cleanup);

  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  assert.equal((await packages.run()).status, "removed");
  assert.equal((await cleanup.run()).status, "removed");
  assert.deepEqual(
    [...removed].sort(),
    [...officialFormulae, ...officialCasks].sort(),
  );
  assert.deepEqual([...formulae].sort(), [
    "private/tools/cmake",
    "workflow/private-formula",
  ]);
  assert.deepEqual([...casks].sort(), [
    "evil/cask/parallels",
    "workflow-private-cask",
  ]);
});

for (const failure of ["uninstall", "postcondition"] as const) {
  test(`macOS broad Homebrew cleanup stops after the first ${failure} failure`, async () => {
    const configRoot = testBrewConfigRoot("3");
    const formulae = new Set(["ant"]);
    const casks = new Set(["parallels"]);
    const uninstallCalls: string[][] = [];
    const execute: MacOSBrewRunner = async (_executable, args) => {
      if (args.join(" ") === "list --formula --full-name") {
        return {
          exitCode: 0,
          stdout: `${[...formulae].join("\n")}\n`,
          stderr: "",
        };
      }
      if (args.join(" ") === "list --cask --full-name") {
        return {
          exitCode: 0,
          stdout: `${[...casks].join("\n")}\n`,
          stderr: "",
        };
      }
      if (args[0] === "uninstall") {
        uninstallCalls.push([...args]);
        if (args.includes("--cask")) {
          if (failure === "uninstall") {
            return {
              exitCode: 23,
              stdout: "",
              stderr: "simulated cask uninstall failure",
            };
          }
          // Homebrew reported success, but its postcondition still contains
          // the package. No later formula batch may run after this point.
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        for (const name of args) formulae.delete(name);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const adapter = await createMacOSAdapter(contextFor("macos"), {
      resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
      executeBrew: execute,
      inspectBrewConfig: async () => undefined,
      createBrewConfigRoot: async () => configRoot,
      validateBrewConfigRoot: async () => undefined,
      removeBrewConfigRoot: async () => undefined,
    });
    const operations = await adapter.operations(planFor("homebrew"));
    const configuration = operations.find(
      ({ id }) => id === "macos:brew:configuration",
    );
    const packages = operations.find(
      ({ id }) => id === "brew:definition-packages",
    );
    assert.ok(configuration?.validate);
    assert.ok(packages);

    await configuration.validate();
    assert.equal((await configuration.run()).status, "removed");
    const result = await packages.run();
    assert.equal(result.status, "failed");
    assert.deepEqual(uninstallCalls, [
      ["uninstall", "--cask", "--force", "parallels"],
    ]);
  });
}

test("macOS atomically creates and revalidates isolated Homebrew configuration before every command", async () => {
  const configRoot = testBrewConfigRoot("4");
  const events: string[] = [];
  let created = false;
  let formulaInstalled = true;
  const dependencies = {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args) => {
      assert.equal(created, true, "Brew must never run before root mkdir");
      assert.equal(events.at(-1), "validate:sealed");
      events.push(`brew:${args.join(" ")}`);
      if (args.join(" ") === "list --formula --full-name") {
        return {
          exitCode: 0,
          stdout: formulaInstalled ? "ant\n" : "",
          stderr: "",
        };
      }
      if (args.join(" ") === "list --cask --full-name") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "uninstall") formulaInstalled = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    runBrewConfigSystemUtility: async (
      executable: string,
      args: readonly string[],
    ) => {
      assert.ok(["/bin/mkdir", "/bin/rmdir"].includes(executable));
      assert.deepEqual(
        args,
        executable === "/bin/mkdir" ? ["-m", "0555", configRoot] : [configRoot],
      );
      events.push(`utility:${executable}:${args.join(" ")}`);
      if (executable === "/bin/mkdir") created = true;
    },
    validateBrewConfigRoot: async (path: string, requireEmpty: boolean) => {
      assert.equal(path, configRoot);
      assert.equal(requireEmpty, true);
      assert.equal(created, true);
      events.push("validate:sealed");
    },
  } satisfies MacOSAdapterDependencies;
  const adapter = await createMacOSAdapter(contextFor("macos"), dependencies);
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");
  assert.ok(configuration?.validate);
  assert.ok(packages);
  assert.ok(cleanup);

  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  assert.equal((await packages.run()).status, "removed");
  assert.equal((await cleanup.run()).status, "removed");
  assert.deepEqual(events.slice(0, 2), [
    `utility:/bin/mkdir:-m 0555 ${configRoot}`,
    "validate:sealed",
  ]);
  assert.equal(
    events.some((event) => /chown|chmod/.test(event)),
    false,
  );
  for (const [index, event] of events.entries()) {
    if (event.startsWith("brew:")) {
      assert.equal(events[index - 1], "validate:sealed");
    }
  }
  assert.deepEqual(events.slice(-2), [
    "validate:sealed",
    `utility:/bin/rmdir:${configRoot}`,
  ]);
});

test("macOS preserves an unconfirmed timeout while protecting Homebrew configuration", async () => {
  const configRoot = testBrewConfigRoot("5");
  const fatal = new UnconfirmedCommandTerminationError(
    "simulated Homebrew configuration protection timeout",
  );
  const utilities: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => undefined,
    runBrewConfigSystemUtility: async (executable) => {
      utilities.push(executable);
      markCommandTerminationUnconfirmed(fatal.message);
      throw fatal;
    },
  });
  const configuration = (await adapter.operations(planFor("homebrew"))).find(
    ({ id }) => id === "macos:brew:configuration",
  );

  try {
    assert.ok(configuration?.validate);
    await configuration.validate();
    await assert.rejects(configuration.run, (error) => error === fatal);
    assert.deepEqual(utilities, ["/bin/mkdir"]);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("macOS refuses a Homebrew configuration path collision without validation or removal", async () => {
  const configRoot = testBrewConfigRoot("6");
  const utilities: string[] = [];
  let brewCalls = 0;
  let rootValidations = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      brewCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => {
      rootValidations += 1;
    },
    runBrewConfigSystemUtility: async (executable, args) => {
      utilities.push(`${executable}:${args.join(" ")}`);
      if (executable === "/bin/mkdir") {
        throw new Error("simulated mkdir collision: File exists");
      }
      throw new Error(`unexpected utility after collision: ${executable}`);
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  assert.ok(configuration?.validate);
  assert.ok(packages);
  await configuration.validate();

  const result = await configuration.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /mkdir collision.*exists/i);
  assert.deepEqual(utilities, [`/bin/mkdir:-m 0555 ${configRoot}`]);
  assert.equal((await packages.run()).status, "failed");
  assert.equal(rootValidations, 0);
  assert.equal(brewCalls, 0);
});

test("macOS generates bounded high-entropy Homebrew configuration candidates", async () => {
  const candidates: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const adapter = await createMacOSAdapter(contextFor("macos"), {
      resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
      inspectBrewConfig: async () => undefined,
      runBrewConfigSystemUtility: async (executable, args, description) => {
        assert.equal(executable, "/bin/mkdir");
        assert.equal(description, "Homebrew configuration directory creation");
        assert.equal(args.length, 3);
        assert.deepEqual(args.slice(0, 2), ["-m", "0555"]);
        const candidate = args[2];
        assert.ok(candidate);
        assert.match(
          candidate,
          /^\/private\/tmp\/maximize-github-runner-space-homebrew-[0-9a-f]{32}$/,
        );
        candidates.push(candidate);
        throw new Error("stop after candidate observation");
      },
    });
    const configuration = (await adapter.operations(planFor("homebrew"))).find(
      ({ id }) => id === "macos:brew:configuration",
    );
    assert.ok(configuration?.validate);
    await configuration.validate();
    assert.equal((await configuration.run()).status, "failed");
  }

  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0], candidates[1]);
});

test("macOS never invokes Brew or removes a configuration root that fails post-mkdir validation", async () => {
  const configRoot = testBrewConfigRoot("6");
  const utilities: string[] = [];
  let brewCalls = 0;
  let validations = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      brewCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => {
      validations += 1;
      if (validations <= 2) {
        throw new Error("simulated unsafe root-owned directory");
      }
    },
    runBrewConfigSystemUtility: async (executable, args) => {
      utilities.push(`${executable}:${args.join(" ")}`);
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  assert.ok(configuration?.validate);
  assert.ok(packages);
  await configuration.validate();

  const result = await configuration.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /unsafe root-owned directory/);
  assert.deepEqual(utilities, [`/bin/mkdir:-m 0555 ${configRoot}`]);
  const packageResult = await packages.run();
  assert.equal(packageResult.status, "failed");
  assert.match(
    packageResult.detail ?? "",
    /before its fatal preflight completed/,
  );
  assert.equal(brewCalls, 0);
});

test("macOS releases its isolated configuration when Homebrew cleanup fails", async () => {
  const configRoot = testBrewConfigRoot("7");
  const removed: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args, environment) => {
      assert.equal(environment.XDG_CONFIG_HOME, configRoot);
      assert.equal(environment.HOMEBREW_XDG_CONFIG_HOME, undefined);
      assert.deepEqual(args, ["cleanup", "--prune=all", "-s"]);
      return { exitCode: 23, stdout: "", stderr: "simulated cleanup failure" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async (path, requireEmpty) => {
      assert.equal(path, configRoot);
      assert.equal(typeof requireEmpty, "boolean");
    },
    removeBrewConfigRoot: async (path) => {
      removed.push(path);
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");
  assert.ok(configuration?.validate);
  assert.ok(cleanup);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  const result = await cleanup.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /simulated cleanup failure/);
  assert.deepEqual(removed, [configRoot]);
});

test("macOS releases isolated Homebrew configuration after a later operation fails", async () => {
  const configRoot = testBrewConfigRoot("8");
  const removed: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async (path) => {
      removed.push(path);
    },
  });
  const configuration = (await adapter.operations(planFor("homebrew"))).find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration);
  const laterFailure = createFunctionOperation({
    id: "macos:later-failure",
    component: "homebrew",
    description: "later Homebrew failure",
    phase: "package",
    run: async () => ({ status: "failed", detail: "simulated failure" }),
  });

  await assert.rejects(
    async () => await executeOperations([configuration, laterFailure]),
    /simulated failure/,
  );
  assert.deepEqual(removed, [configRoot]);
});

test("macOS preserves its timeout error without deleting native Homebrew configuration", async () => {
  const configRoot = testBrewConfigRoot("9");
  const fatal = new UnconfirmedCommandTerminationError(
    "simulated macOS Homebrew timeout",
  );
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      markCommandTerminationUnconfirmed(fatal.message);
      throw fatal;
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => {
      removals += 1;
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");

  try {
    assert.ok(configuration?.validate);
    assert.ok(cleanup);
    await configuration.validate();
    assert.equal((await configuration.run()).status, "removed");
    await assert.rejects(cleanup.run, (error) => error === fatal);
    assert.equal(removals, 0);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("macOS does not swallow a timeout latch raised before native Homebrew cleanup", async () => {
  const configRoot = testBrewConfigRoot("a");
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      markCommandTerminationUnconfirmed("simulated returned timeout latch");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => {
      removals += 1;
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");

  try {
    assert.ok(configuration?.validate);
    assert.ok(cleanup);
    await configuration.validate();
    assert.equal((await configuration.run()).status, "removed");
    await assert.rejects(cleanup.run, UnconfirmedCommandTerminationError);
    assert.equal(removals, 0);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("macOS broad Homebrew cleanup preserves protected owners while removing ownerless runner packages", async () => {
  const configRoot = testBrewConfigRoot("b");
  const commands: string[][] = [];
  const removed: string[] = [];
  const formulae = new Set(["gh", "cmake"]);
  const casks = new Set(["parallels"]);
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args, environment) => {
      assert.equal(environment.XDG_CONFIG_HOME, configRoot);
      assert.equal(environment.HOMEBREW_XDG_CONFIG_HOME, undefined);
      commands.push([...args]);
      if (args.join(" ") === "list --formula --full-name") {
        return {
          exitCode: 0,
          stdout: `${[...formulae].join("\n")}\n`,
          stderr: "",
        };
      }
      if (args.join(" ") === "list --cask --full-name") {
        return {
          exitCode: 0,
          stdout: `${[...casks].join("\n")}\n`,
          stderr: "",
        };
      }
      if (args[0] === "uninstall") {
        const inventory = args.includes("--formula") ? formulae : casks;
        for (const name of args
          .slice(1)
          .filter((value) => !value.startsWith("-"))) {
          inventory.delete(name);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async (path) => {
      assert.equal(path, configRoot);
    },
    removeBrewConfigRoot: async (path) => {
      removed.push(path);
    },
  });
  const plan: CleanupPlan = {
    profile: "max",
    enabled: new Set<ComponentId>(["homebrew"]),
    skipped: new Set<ComponentId>(
      COMPONENTS.map(({ id }) => id).filter((id) => id !== "homebrew"),
    ),
    swapfileBytes: undefined,
  };
  const operations = await adapter.operations(plan);
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");

  assert.ok(configuration?.validate);
  assert.ok(cleanup);
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  assert.ok(packages);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  assert.equal((await packages.run()).status, "removed");
  assert.equal((await cleanup.run()).status, "removed");
  assert.deepEqual([...formulae], ["gh"]);
  assert.deepEqual([...casks], []);
  assert.equal(
    commands.some(({ 0: command }) => command === "uninstall"),
    true,
  );
  assert.deepEqual(removed, [configRoot]);
});

test("macOS Homebrew rejects fixed configuration files before any command", async () => {
  const config = "/opt/homebrew/etc/homebrew/brew.env";
  const observed: string[] = [];
  const inspectConfig: BrewConfigProbe = async (path) => {
    observed.push(path);
    return path === config ? fileStats : undefined;
  };
  let executed = false;
  let created = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: inspectConfig,
    createBrewConfigRoot: async () => {
      created = true;
      throw new Error("rejected configuration must prevent directory creation");
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await assert.rejects(
    async () => await configuration.validate?.(),
    /configuration can override cleanup paths/,
  );
  assert.equal(executed, false);
  assert.equal(created, false);
  assert.deepEqual(observed, [
    "/etc/homebrew/brew.env",
    "/opt/homebrew/etc/homebrew/brew.env",
  ]);
});

test("macOS Homebrew rechecks fixed configuration files before package mutation", async () => {
  const config = "/etc/homebrew/brew.env";
  let inspections = 0;
  let executed = false;
  let created = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async (path) => {
      if (path !== config) return undefined;
      inspections += 1;
      return inspections === 1 ? undefined : fileStats;
    },
    createBrewConfigRoot: async () => {
      created = true;
      throw new Error("failed recheck must prevent directory creation");
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await configuration.validate();
  const result = await configuration.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configuration can override cleanup paths/);
  assert.equal(executed, false);
  assert.equal(created, false);
});

test("macOS Homebrew rejects an executable replacement before package mutation", async () => {
  const executable = BREW_PATHS.arm64.executable;
  let inspections = 0;
  let executed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => executable,
    inspectBrewExecutable: async () => ({
      device: 1n,
      inode: ++inspections < 4 ? 2n : 99n,
      size: 3n,
      modifiedNanoseconds: 4n,
    }),
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => testBrewConfigRoot("c"),
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => undefined,
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  assert.ok(configuration?.validate);
  assert.ok(packages);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  const result = await packages.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Homebrew executable changed/);
  assert.equal(executed, false);
});

test("macOS Homebrew rejects an unavailable executable identity before any command", async () => {
  let executed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    inspectBrewExecutable: async () => undefined,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await assert.rejects(
    async () => await configuration.validate?.(),
    /Homebrew executable changed|could not be inspected/,
  );
  assert.equal(executed, false);
});

test("macOS Homebrew rechecks fixed configuration immediately before every command", async () => {
  const config = "/etc/homebrew/brew.env";
  let configAppeared = false;
  let executed = false;
  const identity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    inspectBrewExecutable: async () => identity,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async (path) =>
      configAppeared && path === config ? fileStats : undefined,
    createBrewConfigRoot: async () => testBrewConfigRoot("d"),
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => undefined,
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packages = operations.find(
    ({ id }) => id === "brew:definition-packages",
  );
  assert.ok(configuration?.validate);
  assert.ok(packages);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");

  configAppeared = true;
  const result = await packages.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configuration can override cleanup paths/);
  assert.equal(executed, false);
});

test("macOS Homebrew rejects an isolated configuration root outside its fixed temporary parent", async () => {
  let executed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () =>
      "/Users/runner/work/_temp/maximize-github-runner-space-homebrew-test",
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await configuration.validate();
  const result = await configuration.run();
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /Refusing unexpected Homebrew configuration directory/,
  );
  assert.equal(executed, false);
});

test("macOS validates isolated Homebrew configuration ownership, mode, and emptiness", async () => {
  const path = testBrewConfigRoot("e");
  const directoryStats = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    mode: 0o40555,
  };
  const validProbe: BrewConfigRootProbe = {
    lstat: async (observed) => {
      assert.equal(observed, path);
      return directoryStats;
    },
    readdir: async (observed) => {
      assert.equal(observed, path);
      return [];
    },
  };
  await validateDefinitionBrewConfigRoot(path, true, validProbe);

  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      lstat: async () => ({ ...directoryStats, isSymbolicLink: () => true }),
    }),
    /non-directory/,
  );
  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      lstat: async () => ({ ...directoryStats, uid: 501, gid: 20 }),
    }),
    /unprotected.*ownership/,
  );
  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      lstat: async () => ({ ...directoryStats, mode: 0o40755 }),
    }),
    /writable.*permissions/,
  );
  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      readdir: async () => ["homebrew"],
    }),
    /non-empty/,
  );
});

test("macOS toolcache recreation is validated and fatal", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"));
  const recreation = (await adapter.operations(planFor("cached-tools"))).find(
    ({ id }) => id === "macos:toolcache:recreate",
  );

  assert.equal(recreation?.phase, "system");
  assert.equal(recreation?.fatal, true);
  assert.equal(typeof recreation?.validate, "function");
});

test("macOS toolcache recreation fails when the recreated directory is not writable", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    createToolCacheDirectory: async () => undefined,
    accessToolCacheDirectory: async () => {
      throw Object.assign(new Error("toolcache is not writable"), {
        code: "EACCES",
      });
    },
  });
  const recreation = (await adapter.operations(planFor("cached-tools"))).find(
    ({ id }) => id === "macos:toolcache:recreate",
  );
  assert.ok(recreation?.validate);

  await recreation.validate();
  const result = await recreation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /not writable/);
});

test("macOS does not inspect Homebrew for a plan without Homebrew-owned components", async () => {
  let brewInspections = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => {
      brewInspections += 1;
      throw new Error("Homebrew inspection should not run");
    },
  });

  const operations = await adapter.operations(planFor("cached-tools"));
  assert.ok(operations.some(({ id }) => id === "macos:toolcache:recreate"));
  assert.equal(brewInspections, 0);
});

test("macOS max skips all Homebrew work when homebrew is protected", async () => {
  const unexpectedHomebrewCall = async (): Promise<never> => {
    throw new Error("skipped Homebrew must not be initialized or executed");
  };
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: unexpectedHomebrewCall,
    executeBrew: unexpectedHomebrewCall,
    inspectBrewConfig: unexpectedHomebrewCall,
    createBrewConfigRoot: unexpectedHomebrewCall,
    validateBrewConfigRoot: unexpectedHomebrewCall,
    removeBrewConfigRoot: unexpectedHomebrewCall,
  });
  const plan: CleanupPlan = {
    profile: "max",
    enabled: new Set<ComponentId>(["rust"]),
    skipped: new Set<ComponentId>(["homebrew"]),
    swapfileBytes: undefined,
  };

  const operations = await adapter.operations(plan);

  assert.ok(
    operations.some(
      ({ component, id }) =>
        component === "rust" && id === "rust:/Users/runner/.cargo",
    ),
    "non-Homebrew cleanup for a Homebrew-owned component must remain enabled",
  );
  assert.equal(
    operations.some(
      ({ id }) => id === "macos:brew:configuration" || id.startsWith("brew:"),
    ),
    false,
  );
});

test("macOS Java discovery distinguishes absence from inventory failure", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    readJavaDirectory: async () =>
      Promise.reject(
        Object.assign(new Error("Java inventory denied"), { code: "EACCES" }),
      ),
  });

  await assert.rejects(
    async () => await adapter.operations(planFor("java")),
    /Java inventory denied/,
  );
});

test("macOS Homebrew requires package absence after a successful uninstall", async () => {
  let uninstallCalls = 0;
  let formulaInventories = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args) => {
      const command = args.join(" ");
      if (command === "list --formula --full-name") {
        formulaInventories += 1;
        return {
          exitCode: 0,
          stdout: formulaInventories === 1 ? "homebrew/core/gh\n" : "gh\n",
          stderr: "",
        };
      }
      if (command === "list --cask --full-name") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "uninstall") uninstallCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => testBrewConfigRoot("f"),
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => undefined,
  });
  const operations = await adapter.operations(planFor("gh-cli"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packageOperation = operations.find(
    ({ component, id }) =>
      component === "gh-cli" && id.startsWith("brew:formula:"),
  );
  assert.ok(configuration?.validate);
  assert.ok(packageOperation);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  const result = await packageOperation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /remained installed/);
  assert.equal(uninstallCalls, 1);
});

test("macOS Homebrew rejects truncated package inventory", async () => {
  let uninstallCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args) => {
      if (args.join(" ") === "list --formula --full-name") {
        return {
          exitCode: 0,
          stdout: "homebrew/core/gh\n",
          stderr: "",
          stdoutTruncated: true,
        };
      }
      if (args[0] === "uninstall") uninstallCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => testBrewConfigRoot("0"),
    validateBrewConfigRoot: async () => undefined,
    removeBrewConfigRoot: async () => undefined,
  });
  const operations = await adapter.operations(planFor("gh-cli"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const packageOperation = operations.find(
    ({ component, id }) =>
      component === "gh-cli" && id.startsWith("brew:formula:"),
  );
  assert.ok(configuration?.validate);
  assert.ok(packageOperation);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  const result = await packageOperation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /inventory exceeded/);
  assert.equal(uninstallCalls, 0);
});

function xcodeDirectoryEntry(name: string) {
  return {
    name,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function xcodeBundleIdentity(
  inode: bigint,
  overrides: Partial<MacOSXcodeBundleIdentity> = {},
): MacOSXcodeBundleIdentity {
  return {
    kind: "directory",
    device: 1n,
    inode,
    mode: 0o40755n,
    userId: 0n,
    groupId: 0n,
    linkCount: 1n,
    size: 128n,
    modifiedNanoseconds: 1_000n,
    changedNanoseconds: 2_000n,
    ...overrides,
  };
}

test("macOS Xcode bundle identity inspection does not follow symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-xcode-identity-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const bundle = join(root, "Xcode_15.4.app");
  const alias = join(root, "Xcode.app");
  await mkdir(bundle);
  await symlink(bundle, alias, "dir");

  const bundleIdentity = await inspectMacOSXcodeBundleIdentity(bundle);
  const aliasIdentity = await inspectMacOSXcodeBundleIdentity(alias);

  assert.equal(bundleIdentity?.kind, "directory");
  assert.equal(aliasIdentity?.kind, "symbolic-link");
  assert.notEqual(aliasIdentity?.inode, bundleIdentity?.inode);
});

test("macOS unsafe Xcode inventory fails complete-plan validation before package mutation", async () => {
  let packageRan = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "xcode-select unavailable",
    }),
    readXcodeApplications: async () => {
      throw new Error("unsafe selection must stop before directory discovery");
    },
  });
  const inventoryFailure = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:inventory",
  );
  const packageOperation = createFunctionOperation({
    id: "macos:test:package-before-xcode",
    component: "xcode",
    description: "Simulate an earlier package cleanup",
    phase: "package",
    run: async () => {
      packageRan = true;
      return { status: "removed" };
    },
  });
  assert.ok(inventoryFailure?.validate);

  await assert.rejects(
    async () => await executeOperations([packageOperation, inventoryFailure]),
    /xcode-select is unavailable or unsafe/,
  );
  assert.equal(packageRan, false);
  assert.equal((await inventoryFailure.run()).status, "failed");
});

test("macOS Xcode validation rejects a target selected after discovery", async () => {
  let selected = "/Applications/Xcode_15.4.app/Contents/Developer";
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({ exitCode: 0, stdout: selected, stderr: "" }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath: async (path) => path,
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);

  selected = "/Applications/Xcode_16.0.app/Contents/Developer";
  await assert.rejects(operation.validate, /Xcode selection changed/);
  assert.equal(removals, 0);
});

test("macOS Xcode deletion rejects selection spelling drift with the same resolved bundle", async () => {
  let selected = "/Applications/Xcode.app/Contents/Developer";
  let removals = 0;
  const resolveXcodePath = async (path: string): Promise<string> =>
    path.replace("/Applications/Xcode.app", "/Applications/Xcode_15.4.app");
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({ exitCode: 0, stdout: selected, stderr: "" }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath,
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  selected = "/Applications/Xcode_15.4.app/Contents/Developer";
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(removals, 0);
});

test("macOS Xcode deletion rejects a preserved alias retargeted to the pending target", async () => {
  const selected = "/Applications/Xcode.app/Contents/Developer";
  let selectedAlias = "/Applications/Xcode_15.4.app";
  let removals = 0;
  const resolveXcodePath = async (path: string): Promise<string> =>
    path.replace("/Applications/Xcode.app", selectedAlias);
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({ exitCode: 0, stdout: selected, stderr: "" }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath,
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  selectedAlias = "/Applications/Xcode_16.0.app";
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(removals, 0);
});

test("macOS Xcode deletion rejects a selected and removable bundle identity exchange", async () => {
  const selectedBundle = "/Applications/Xcode_15.4.app";
  const removalTarget = "/Applications/Xcode_16.0.app";
  const selectedIdentity = xcodeBundleIdentity(154n);
  const targetIdentity = xcodeBundleIdentity(160n, {
    modifiedNanoseconds: 3_000n,
    changedNanoseconds: 4_000n,
  });
  const identities = new Map([
    [selectedBundle, selectedIdentity],
    [removalTarget, targetIdentity],
  ]);
  let removals = 0;
  const dependencies = {
    runXcodeSelect: async () => ({
      exitCode: 0,
      stdout: `${selectedBundle}/Contents/Developer`,
      stderr: "",
    }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath: async (path: string) =>
      path === "/Applications/Xcode.app" ? undefined : path,
    inspectXcodeBundleIdentity: async (path: string) => identities.get(path),
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      return { status: "removed" } as const;
    },
  };
  const adapter = await createMacOSAdapter(contextFor("macos"), dependencies);
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  identities.set(selectedBundle, targetIdentity);
  identities.set(removalTarget, selectedIdentity);

  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode bundle identity changed/);
  assert.equal(removals, 0);
});

test("macOS Xcode deletion rejects target disappearance before removal", async () => {
  const selectedBundle = "/Applications/Xcode_15.4.app";
  const removalTarget = "/Applications/Xcode_16.0.app";
  const identities = new Map<string, MacOSXcodeBundleIdentity>([
    [selectedBundle, xcodeBundleIdentity(154n)],
    [removalTarget, xcodeBundleIdentity(160n)],
  ]);
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({
      exitCode: 0,
      stdout: `${selectedBundle}/Contents/Developer`,
      stderr: "",
    }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode.app" ? undefined : path,
    inspectXcodeBundleIdentity: async (path) => identities.get(path),
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  identities.delete(removalTarget);

  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /disappeared before bundle deletion/);
  assert.equal(removals, 0);
});

test("macOS Xcode deletion revalidates preserved identities after removal", async () => {
  const selectedBundle = "/Applications/Xcode_15.4.app";
  const removalTarget = "/Applications/Xcode_16.0.app";
  const selectedIdentity = xcodeBundleIdentity(154n);
  const identities = new Map<string, MacOSXcodeBundleIdentity>([
    [selectedBundle, selectedIdentity],
    [removalTarget, xcodeBundleIdentity(160n)],
  ]);
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({
      exitCode: 0,
      stdout: `${selectedBundle}/Contents/Developer`,
      stderr: "",
    }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode.app" ? undefined : path,
    inspectXcodeBundleIdentity: async (path) => identities.get(path),
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      identities.delete(removalTarget);
      identities.set(
        selectedBundle,
        xcodeBundleIdentity(154n, { mode: 0o40700n }),
      );
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode bundle identity changed during/);
  assert.equal(removals, 1);
});

test("macOS Xcode deletion requires absence after removal reports success", async () => {
  const selectedBundle = "/Applications/Xcode_15.4.app";
  const removalTarget = "/Applications/Xcode_16.0.app";
  const identities = new Map<string, MacOSXcodeBundleIdentity>([
    [selectedBundle, xcodeBundleIdentity(154n)],
    [removalTarget, xcodeBundleIdentity(160n)],
  ]);
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({
      exitCode: 0,
      stdout: `${selectedBundle}/Contents/Developer`,
      stderr: "",
    }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode.app" ? undefined : path,
    inspectXcodeBundleIdentity: async (path) => identities.get(path),
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /remained after removal reported success/);
  assert.equal(removals, 1);
});

test("macOS revalidates xcode-select immediately before every versioned deletion", async () => {
  let selected = "/Applications/Xcode_15.4.app/Contents/Developer";
  const removed: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({ exitCode: 0, stdout: selected, stderr: "" }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
      xcodeDirectoryEntry("Xcode_17.0.app"),
    ],
    resolveXcodePath: async (path) => path,
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async (target) => {
      removed.push(target);
      return { status: "removed" };
    },
  });
  const operations = await adapter.operations(planFor("xcode"));
  const xcode16 = operations.find(({ id }) => id === "xcode:Xcode_16.0.app");
  const xcode17 = operations.find(({ id }) => id === "xcode:Xcode_17.0.app");
  assert.ok(xcode16?.validate);
  assert.ok(xcode17?.validate);
  await xcode16.validate();
  await xcode17.validate();

  assert.equal((await xcode16.run()).status, "removed");
  selected = "/Applications/Xcode_17.0.app/Contents/Developer";
  const second = await xcode17.run();
  assert.equal(second.status, "failed");
  assert.match(second.detail ?? "", /Xcode selection changed/);
  assert.deepEqual(removed, ["/Applications/Xcode_16.0.app"]);
});

test("macOS reports failure when xcode-select changes during bundle deletion", async () => {
  let selected = "/Applications/Xcode_15.4.app/Contents/Developer";
  let removals = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => ({ exitCode: 0, stdout: selected, stderr: "" }),
    readXcodeApplications: async () => [
      xcodeDirectoryEntry("Xcode_15.4.app"),
      xcodeDirectoryEntry("Xcode_16.0.app"),
    ],
    resolveXcodePath: async (path) => path,
    validateXcodeTarget: async () => undefined,
    removeXcodeTarget: async () => {
      removals += 1;
      selected = "/Applications/Xcode_16.0.app/Contents/Developer";
      return { status: "removed" };
    },
  });
  const operation = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_16.0.app",
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed during/);
  assert.equal(removals, 1);
});

test("macOS definition paths distinguish absence from inspection failure", async () => {
  assert.equal(
    await resolveMacOSDefinitionPath("/Applications/missing", async () =>
      Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    ),
    undefined,
  );
  await assert.rejects(
    async () =>
      await resolveMacOSDefinitionPath("/Applications/Xcode.app", async () =>
        Promise.reject(
          Object.assign(new Error("Xcode path denied"), { code: "EACCES" }),
        ),
      ),
    /Xcode path denied/,
  );
});
