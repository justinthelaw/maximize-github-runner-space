import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import type { RemovePathDependencies } from "../src/operations.js";
import {
  createLinuxAdapter,
  createLinuxHomebrewCleanupOperation,
  createLinuxServiceStopOperation,
  linuxSystemCommandEnvironment,
  resolveDefinitionLinuxBrewExecutable,
  type ResolvedLinuxBrew,
  type LinuxBrewConfigProbe,
  type LinuxBrewPathProbe,
  type LinuxSystemctl,
} from "../src/platforms/linux.js";
import type { CommandResult } from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

function commandResult(
  stdout: string,
  exitCode = 0,
  stderr = "",
): CommandResult {
  return { exitCode, stdout, stderr };
}

function linuxMountInfoLine(mountPoint: string): string {
  return `36 25 0:32 / ${mountPoint} rw,relatime - ext4 /dev/root rw`;
}

test("Linux service commands ignore workflow-selected D-Bus endpoints", () => {
  const originalBus = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  const originalSystemd = process.env.SYSTEMD_OFFLINE;
  process.env.DBUS_SYSTEM_BUS_ADDRESS = "unix:path=/workflow/fake-system-bus";
  process.env.SYSTEMD_OFFLINE = "1";
  try {
    const environment = linuxSystemCommandEnvironment(contextFor("linux"));
    assert.equal(environment.DBUS_SYSTEM_BUS_ADDRESS, undefined);
    assert.equal(environment.SYSTEMD_OFFLINE, undefined);
    assert.deepEqual(environment, {
      HOME: "/home/runner",
      USER: "runner",
      LOGNAME: "runner",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      SYSTEMD_COLORS: "0",
      SYSTEMD_PAGER: "",
    });
  } finally {
    if (originalBus === undefined) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    else process.env.DBUS_SYSTEM_BUS_ADDRESS = originalBus;
    if (originalSystemd === undefined) delete process.env.SYSTEMD_OFFLINE;
    else process.env.SYSTEMD_OFFLINE = originalSystemd;
  }
});

test("Linux service validation discovers every selected unit before any stop", async () => {
  const calls: string[] = [];
  const stopped = new Set<string>();
  const systemctl: LinuxSystemctl = {
    show: async (unit, property) => {
      calls.push(`show:${property}:${unit}`);
      return commandResult(
        property === "LoadState"
          ? "loaded\n"
          : stopped.has(unit)
            ? "inactive\n"
            : "active\n",
      );
    },
    stop: async (unit) => {
      calls.push(`stop:${unit}`);
      stopped.add(unit);
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("docker-engine", "nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");

  const firstStop = calls.findIndex((call) => call.startsWith("stop:"));
  assert.notEqual(firstStop, -1);
  assert.deepEqual(calls.slice(0, firstStop), [
    "show:LoadState:docker.socket",
    "show:ActiveState:docker.socket",
    "show:LoadState:docker.service",
    "show:ActiveState:docker.service",
    "show:LoadState:containerd.service",
    "show:ActiveState:containerd.service",
    "show:LoadState:nginx.service",
    "show:ActiveState:nginx.service",
    "show:LoadState:docker.socket",
    "show:ActiveState:docker.socket",
    "show:LoadState:docker.service",
    "show:ActiveState:docker.service",
    "show:LoadState:containerd.service",
    "show:ActiveState:containerd.service",
    "show:LoadState:nginx.service",
    "show:ActiveState:nginx.service",
  ]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("stop:")),
    [
      "stop:docker.socket",
      "stop:docker.service",
      "stop:containerd.service",
      "stop:nginx.service",
    ],
  );
});

test("a later Linux service recheck failure cannot leave an earlier component stopped", async () => {
  const calls: string[] = [];
  let activeQueries = 0;
  const systemctl: LinuxSystemctl = {
    show: async (unit, property) => {
      calls.push(`show:${property}:${unit}`);
      if (property === "ActiveState") {
        activeQueries += 1;
        if (activeQueries === 8) {
          return commandResult("", 5, "inventory unavailable");
        }
        return commandResult("active\n");
      }
      return commandResult("loaded\n");
    },
    stop: async (unit) => {
      calls.push(`stop:${unit}`);
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("docker-engine", "nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /inventory unavailable/);
  assert.equal(
    calls.some((call) => call.startsWith("stop:")),
    false,
  );
});

test("Linux service cleanup fails if an earlier unit reactivates", async () => {
  const calls: string[] = [];
  let dockerActiveQueries = 0;
  const stopped = new Set<string>();
  const systemctl: LinuxSystemctl = {
    show: async (unit, property) => {
      calls.push(`show:${property}:${unit}`);
      if (property === "LoadState") return commandResult("loaded\n");
      if (unit === "docker.service") {
        dockerActiveQueries += 1;
        return commandResult(
          dockerActiveQueries >= 4
            ? "active\n"
            : stopped.has(unit)
              ? "inactive\n"
              : "active\n",
        );
      }
      return commandResult(stopped.has(unit) ? "inactive\n" : "active\n");
    },
    stop: async (unit) => {
      calls.push(`stop:${unit}`);
      stopped.add(unit);
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("docker-engine"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /docker\.service reactivated/);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("stop:")),
    ["stop:docker.socket", "stop:docker.service", "stop:containerd.service"],
  );
});

test("Linuxbrew resolves only the definition-owned executable", async () => {
  const candidate = "/home/linuxbrew/.linuxbrew/bin/brew";
  const executable = "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew";
  const calls: string[] = [];
  const probe: LinuxBrewPathProbe = {
    lstat: async (path) => {
      calls.push(`lstat:${path}`);
      if (path === candidate) {
        return { isFile: () => false, isSymbolicLink: () => true };
      }
      assert.equal(path, executable);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    realpath: async (path) => {
      calls.push(`realpath:${path}`);
      return executable;
    },
    access: async (path, mode) => {
      calls.push(`access:${path}:${mode}`);
      assert.equal(path, executable);
      assert.equal(mode, constants.X_OK);
    },
  };

  assert.equal(await resolveDefinitionLinuxBrewExecutable(probe), executable);
  assert.deepEqual(calls, [
    `lstat:${candidate}`,
    `realpath:${candidate}`,
    `lstat:${executable}`,
    `access:${executable}:${constants.X_OK}`,
  ]);

  const redirected: LinuxBrewPathProbe = {
    ...probe,
    realpath: async () => "/workflow/shims/brew",
    access: async () => {
      throw new Error("a redirected executable must not be accessed");
    },
  };
  assert.equal(
    await resolveDefinitionLinuxBrewExecutable(redirected),
    undefined,
  );
});

test("Linux Homebrew cleanup preserves the prefix and workflow-installed packages", async () => {
  const executable = "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew";
  let configDirectory: string | undefined;
  let configDirectoryRemoved = false;
  const calls: {
    executable: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
  }[] = [];
  const poisoned = {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOMEBREW_CACHE: process.env.HOMEBREW_CACHE,
    HOMEBREW_FORCE_BREW_WRAPPER: process.env.HOMEBREW_FORCE_BREW_WRAPPER,
  };
  process.env.PATH = "/workflow/shims";
  process.env.XDG_CONFIG_HOME = "/workflow/config";
  process.env.HOMEBREW_CACHE = "/workflow/cache";
  process.env.HOMEBREW_FORCE_BREW_WRAPPER = "/workflow/wrapper";
  const operation = createLinuxHomebrewCleanupOperation(
    contextFor("linux"),
    async () => ({ executable }),
    async (resolved, args, environment) => {
      calls.push({ executable: resolved, args, environment });
      const config = environment.XDG_CONFIG_HOME;
      assert.equal(typeof config, "string");
      assert.equal((await lstat(config as string)).isDirectory(), true);
      return commandResult("");
    },
    async () => undefined,
    async () => {
      configDirectory = await mkdtemp(
        "/tmp/maximize-github-runner-space-brew-config-",
      );
      return configDirectory;
    },
  );
  assert.ok(operation.validate);
  let result: Awaited<ReturnType<typeof operation.run>> | undefined;
  try {
    await operation.validate();
    result = await operation.run();
    assert.notEqual(configDirectory, undefined);
    try {
      await access(configDirectory as string);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      configDirectoryRemoved = true;
    }
  } finally {
    for (const [key, value] of Object.entries(poisoned)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (configDirectory !== undefined) {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }
  assert.equal(result?.status, "removed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, "/home/linuxbrew/.linuxbrew/bin/brew");
  assert.deepEqual(calls[0]?.args, ["cleanup", "--prune=120"]);
  assert.equal(
    calls[0]?.environment.HOMEBREW_PREFIX,
    "/home/linuxbrew/.linuxbrew",
  );
  assert.equal(
    calls[0]?.environment.HOMEBREW_CACHE,
    "/home/runner/.cache/Homebrew",
  );
  assert.equal(calls[0]?.environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(calls[0]?.environment.XDG_CONFIG_HOME, configDirectory);
  assert.match(
    calls[0]?.environment.XDG_CONFIG_HOME ?? "",
    /^\/tmp\/maximize-github-runner-space-brew-config-[^/]+$/,
  );
  assert.equal(configDirectoryRemoved, true);
  assert.equal(calls[0]?.environment.HOMEBREW_FORCE_BREW_WRAPPER, undefined);
  assert.equal(
    calls[0]?.args.some((argument) =>
      /^(?:uninstall|autoremove|--force)$/.test(argument),
    ),
    false,
  );

  const adapter = await createLinuxAdapter(contextFor("linux"));
  const operations = await adapter.operations(planFor("homebrew"));
  assert.equal(
    operations.some(({ id }) => id === "linux:brew:cleanup"),
    true,
  );
  assert.equal(
    operations.some(({ id }) => id.includes("/home/linuxbrew/.linuxbrew")),
    false,
  );
});

test("Linux Homebrew cleanup rejects configuration that can override safe paths", async () => {
  const executable = "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew";
  let executed = false;
  const observed: string[] = [];
  const inspectConfig: LinuxBrewConfigProbe = async (path) => {
    observed.push(path);
    return path === "/home/linuxbrew/.linuxbrew/etc/homebrew/brew.env"
      ? { isFile: () => true, isSymbolicLink: () => false }
      : undefined;
  };
  const operation = createLinuxHomebrewCleanupOperation(
    contextFor("linux"),
    async () => ({ executable }),
    async () => {
      executed = true;
      return commandResult("");
    },
    inspectConfig,
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "unsupported");
  assert.match(result.detail ?? "", /configuration can override cleanup paths/);
  assert.equal(executed, false);
  assert.deepEqual(observed, [
    "/etc/homebrew/brew.env",
    "/home/linuxbrew/.linuxbrew/etc/homebrew/brew.env",
    "/etc/homebrew/brew.env",
    "/home/linuxbrew/.linuxbrew/etc/homebrew/brew.env",
  ]);
});

test("Linux Homebrew cleanup fails closed if its executable changes", async () => {
  let resolveCalls = 0;
  let executed = false;
  const operation = createLinuxHomebrewCleanupOperation(
    contextFor("linux"),
    async () => {
      resolveCalls += 1;
      return resolveCalls === 1
        ? { executable: "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew" }
        : undefined;
    },
    async () => {
      executed = true;
      return commandResult("");
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.equal(executed, false);
});

test("Linux Homebrew cleanup fails closed when config directory creation fails", async () => {
  let executed = false;
  let removed = false;
  const operation = createLinuxHomebrewCleanupOperation(
    contextFor("linux"),
    async () => ({
      executable: "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew",
    }),
    async () => {
      executed = true;
      return commandResult("");
    },
    async () => undefined,
    async () => {
      throw new Error("temporary storage unavailable");
    },
    async () => {
      removed = true;
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /temporary storage unavailable/);
  assert.equal(executed, false);
  assert.equal(removed, false);
});

test("Linux Homebrew cleanup rejects a config directory outside fixed temporary ownership", async () => {
  let executed = false;
  let removed = false;
  const operation = createLinuxHomebrewCleanupOperation(
    contextFor("linux"),
    async () => ({
      executable: "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew",
    }),
    async () => {
      executed = true;
      return commandResult("");
    },
    async () => undefined,
    async () => "/tmp/workflow-config",
    async () => {
      removed = true;
    },
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /unsafe Linuxbrew config directory/);
  assert.equal(executed, false);
  assert.equal(removed, false);
});

test("Linux Homebrew cleanup fails closed if the verified file identity changes", async () => {
  const executable = "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew";
  let resolveCalls = 0;
  let executed = false;
  const resolved = (inode: bigint): ResolvedLinuxBrew => ({
    executable,
    identity: {
      device: 1n,
      inode,
      size: 1024n,
      modifiedNanoseconds: 3n,
    },
  });
  const operation = createLinuxHomebrewCleanupOperation(
    contextFor("linux"),
    async () => resolved(++resolveCalls === 1 ? 2n : 4n),
    async () => {
      executed = true;
      return commandResult("");
    },
    async () => undefined,
  );
  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.equal(executed, false);
});

for (const mountedPath of ["target", "descendant"] as const) {
  test(`Linux Homebrew temporary config cleanup rejects ${mountedPath} mount drift`, async () => {
    const createWithRemovalDependencies =
      createLinuxHomebrewCleanupOperation as unknown as (
        ...args: unknown[]
      ) => ReturnType<typeof createLinuxHomebrewCleanupOperation>;
    let configDirectory: string | undefined;
    let sentinel: string | undefined;
    let mountReads = 0;
    let recursiveRemovals = 0;
    let elevatedRemovals = 0;
    const removalDependencies: RemovePathDependencies = {
      readLinuxMountInfo: async () => {
        mountReads += 1;
        if (mountReads === 1) return "";
        assert.ok(configDirectory);
        return linuxMountInfoLine(
          mountedPath === "target"
            ? configDirectory
            : `${configDirectory}/mounted-child`,
        );
      },
      runElevated: async () => {
        elevatedRemovals += 1;
        return commandResult("");
      },
    };
    const operation = createWithRemovalDependencies(
      contextFor("linux"),
      async () => ({
        executable: "/home/linuxbrew/.linuxbrew/Homebrew/bin/brew",
      }),
      async () => {
        assert.ok(configDirectory);
        const child = `${configDirectory}/mounted-child`;
        await mkdir(child);
        sentinel = `${child}/sentinel`;
        await writeFile(sentinel, "preserve me");
        return commandResult("");
      },
      async () => undefined,
      async () => {
        configDirectory = await mkdtemp(
          "/tmp/maximize-github-runner-space-brew-config-",
        );
        return configDirectory;
      },
      async () => {
        recursiveRemovals += 1;
      },
      removalDependencies,
    );
    assert.ok(operation.validate);

    try {
      await operation.validate();
      const result = await operation.run();
      assert.equal(result.status, "failed");
      assert.match(result.detail ?? "", /mounted path/);
      assert.equal(mountReads, 2);
      assert.equal(recursiveRemovals, 0);
      assert.equal(elevatedRemovals, 0);
      assert.ok(sentinel);
      assert.equal(await readFile(sentinel, "utf8"), "preserve me");
    } finally {
      if (configDirectory !== undefined) {
        await rm(configDirectory, { recursive: true, force: true });
      }
    }
  });
}
