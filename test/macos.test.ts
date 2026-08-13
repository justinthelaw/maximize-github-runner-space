import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";
import {
  createMacOSAdapter,
  resolveDefinitionBrewExecutable,
  type BrewConfigProbe,
  type BrewPathProbe,
  type MacOSBrewRunner,
} from "../src/platforms/macos.js";
import type { Architecture } from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

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

test("macOS Homebrew commands use a trusted environment and preserve unknown packages", async () => {
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
        stdout:
          "homebrew/core/gh\ngradle\nworkflow/tools/gh\nprivate/tools/gradle\nworkflow/tools/private-formula\n",
        stderr: "",
      };
    }
    if (args.join(" ") === "list --cask --full-name") {
      return {
        exitCode: 0,
        stdout:
          "google-chrome\nevil/browsers/google-chrome\nworkflow-private-cask\n",
        stderr: "",
      };
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
      inspectBrewConfig: async () => undefined,
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
    await configuration.validate();
    assert.equal((await configuration.run()).status, "removed");
    assert.ok(packages);
    assert.ok(cleanup);
    assert.equal((await packages.run()).status, "removed");
    assert.equal((await cleanup.run()).status, "removed");

    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        ["list", "--formula", "--full-name"],
        ["list", "--cask", "--full-name"],
        ["uninstall", "--cask", "--force", "google-chrome"],
        [
          "uninstall",
          "--formula",
          "--force",
          "--ignore-dependencies",
          "homebrew/core/gh",
          "gradle",
        ],
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
      assert.equal(call.environment.XDG_CONFIG_HOME, "/dev/null");
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

test("macOS Homebrew cleanup is a no-op when the fixed candidate is absent", async () => {
  let executed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => undefined,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
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
});

test("macOS Homebrew rejects fixed configuration files before any command", async () => {
  const config = "/opt/homebrew/etc/homebrew/brew.env";
  const observed: string[] = [];
  const inspectConfig: BrewConfigProbe = async (path) => {
    observed.push(path);
    return path === config ? fileStats : undefined;
  };
  let executed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: inspectConfig,
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
  assert.deepEqual(observed, [
    "/etc/homebrew/brew.env",
    "/opt/homebrew/etc/homebrew/brew.env",
  ]);
});

test("macOS Homebrew rechecks fixed configuration files before package mutation", async () => {
  const config = "/etc/homebrew/brew.env";
  let inspections = 0;
  let executed = false;
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
});
