import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLinuxAdapter,
  createLinuxAptBatchOperation,
  createLinuxAptFinalizeOperation,
  createLinuxDockerPruneOperation,
  createLinuxHomebrewCleanupOperation,
  createLinuxServiceStopOperation,
  LINUX_PACKAGE_EXECUTABLES,
  linuxPackageCommandEnvironment,
  linuxSystemCommandEnvironment,
  validateLinuxDockerConfigMetadata,
  type LinuxSystemctl,
} from "../src/platforms/linux.js";
import {
  assertCommandTerminationConfirmed,
  clearCommandTerminationUnconfirmed,
  markCommandTerminationUnconfirmed,
  UnconfirmedCommandTerminationError,
  type CommandFileIdentity,
} from "../src/command.js";
import {
  createFunctionOperation,
  executeOperations,
} from "../src/operations.js";
import type { CommandResult } from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

function commandResult(
  stdout: string,
  exitCode = 0,
  stderr = "",
): CommandResult {
  return { exitCode, stdout, stderr };
}

test("Linux system and package environments canonicalize the runner home", () => {
  const context = {
    ...contextFor("linux"),
    home: "/home/runner/link/..",
  };
  assert.equal(linuxSystemCommandEnvironment(context).HOME, "/home/runner");
  assert.equal(linuxPackageCommandEnvironment(context).HOME, "/home/runner");
});

const LINUX_TEST_IDENTITY = {
  device: 1n,
  inode: 2n,
  size: 1024n,
  modifiedNanoseconds: 3n,
} as const;

const LINUX_DOCKER_CONFIG_DIRECTORY =
  "/tmp/maximize-github-runner-space-docker-config-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY: CommandFileIdentity = {
  device: 11n,
  inode: 12n,
  size: 13n,
  modifiedNanoseconds: 14n,
  mode: 0o100755n,
  userId: 0n,
  groupId: 0n,
};

const LINUX_PROTECTED_CONFIG_UTILITY_PATHS = new Set([
  "/usr/bin/env",
  "/usr/bin/mkdir",
  "/usr/bin/rmdir",
  "/usr/bin/sudo",
]);

function inspectDockerOrProtectedConfigUtility(
  path: string,
  dockerIdentity: CommandFileIdentity,
): CommandFileIdentity | undefined {
  if (path === LINUX_PACKAGE_EXECUTABLES.docker) return dockerIdentity;
  return LINUX_PROTECTED_CONFIG_UTILITY_PATHS.has(path)
    ? LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY
    : undefined;
}

function linuxDockerConfigStats(options: {
  readonly kind?: "directory" | "file" | "symlink";
  readonly uid?: bigint;
  readonly gid?: bigint;
  readonly mode?: bigint;
  readonly inode?: bigint;
}) {
  const kind = options.kind ?? "directory";
  return {
    isSymbolicLink: () => kind === "symlink",
    isDirectory: () => kind === "directory",
    dev: 1n,
    ino: options.inode ?? 2n,
    size: 0n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    mode: options.mode ?? 0o40555n,
    uid: options.uid ?? 0n,
    gid: options.gid ?? 0n,
  };
}

test("Linux Docker config metadata requires exact protected roots and an empty target", async () => {
  const configDirectory = LINUX_DOCKER_CONFIG_DIRECTORY;
  const accepted = await validateLinuxDockerConfigMetadata(configDirectory, {
    lstat: async (path) =>
      path === "/tmp"
        ? linuxDockerConfigStats({ mode: 0o41777n, inode: 1n })
        : linuxDockerConfigStats({ inode: 2n }),
    readdir: async () => [],
  });
  assert.equal(accepted.inode, 2n);
  assert.equal(accepted.mode, 0o40555n);
  assert.equal(accepted.userId, 0n);

  for (const [name, root, target, entries, expected] of [
    [
      "writable root",
      linuxDockerConfigStats({ mode: 0o40777n }),
      linuxDockerConfigStats({}),
      [],
      /unprotected Docker config root/,
    ],
    [
      "unowned root",
      linuxDockerConfigStats({ mode: 0o41777n, uid: 1000n }),
      linuxDockerConfigStats({}),
      [],
      /unprotected Docker config root/,
    ],
    [
      "linked target",
      linuxDockerConfigStats({ mode: 0o41777n }),
      linuxDockerConfigStats({ kind: "symlink" }),
      [],
      /non-directory Docker config target/,
    ],
    [
      "writable target",
      linuxDockerConfigStats({ mode: 0o41777n }),
      linuxDockerConfigStats({ mode: 0o40755n }),
      [],
      /writable Docker config directory permissions/,
    ],
    [
      "unowned target",
      linuxDockerConfigStats({ mode: 0o41777n }),
      linuxDockerConfigStats({ uid: 1000n }),
      [],
      /Docker config directory ownership/,
    ],
    [
      "non-empty target",
      linuxDockerConfigStats({ mode: 0o41777n }),
      linuxDockerConfigStats({}),
      ["config.json"],
      /non-empty Docker config directory/,
    ],
  ] as const) {
    await assert.rejects(
      validateLinuxDockerConfigMetadata(configDirectory, {
        lstat: async (path) => (path === "/tmp" ? root : target),
        readdir: async () => entries,
      }),
      expected,
      name,
    );
  }
});

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

test("Linux apt cleanup uses fixed executables and a trusted environment", async () => {
  const calls: {
    kind: string;
    executable: string;
    environment: NodeJS.ProcessEnv | undefined;
  }[] = [];
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  let inventoryReads = 0;
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async (executable) => {
        assert.ok(
          executable === LINUX_PACKAGE_EXECUTABLES.aptGet ||
            executable === LINUX_PACKAGE_EXECUTABLES.dpkgQuery ||
            executable === LINUX_PACKAGE_EXECUTABLES.dpkg,
        );
        return identity;
      },
      runCommand: async (executable, _args, options) => {
        calls.push({ kind: "probe", executable, environment: options.env });
        inventoryReads += 1;
        return commandResult(inventoryReads <= 2 ? "openjdk-17-jdk\n" : "");
      },
      runElevated: async (_context, executable, _args, options) => {
        calls.push({ kind: "mutation", executable, environment: options.env });
        return commandResult("");
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(
    calls.map(({ kind, executable }) => `${kind}:${executable}`),
    [
      `probe:${LINUX_PACKAGE_EXECUTABLES.dpkgQuery}`,
      `probe:${LINUX_PACKAGE_EXECUTABLES.dpkgQuery}`,
      `mutation:${LINUX_PACKAGE_EXECUTABLES.aptGet}`,
      `probe:${LINUX_PACKAGE_EXECUTABLES.dpkgQuery}`,
    ],
  );
  for (const call of calls) {
    assert.equal(call.environment?.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(call.environment?.APT_CONFIG, "/dev/null");
    assert.equal(call.environment?.LD_PRELOAD, undefined);
  }
});

test("PostgreSQL apt cleanup includes the package owning the pg_config diversion", async () => {
  let purgeArguments: readonly string[] | undefined;
  let inventoryReads = 0;
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("postgresql"),
    () => undefined,
    {
      inspectExecutable: async () => LINUX_TEST_IDENTITY,
      runCommand: async () => {
        inventoryReads += 1;
        return commandResult(
          inventoryReads <= 2
            ? "postgresql-16\npostgresql-common\nlibpq-dev\n"
            : "",
        );
      },
      runElevated: async (_context, _executable, args) => {
        purgeArguments = args;
        return commandResult("");
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.deepEqual(purgeArguments, [
    "-o",
    "Dir::Etc::main=/dev/null",
    "-o",
    "Dir::Etc::parts=/dev/null",
    "-o",
    "Dir::Bin::dpkg=/usr/bin/dpkg",
    "purge",
    "-y",
    "--no-install-recommends",
    "postgresql-16",
    "postgresql-common",
    "libpq-dev",
  ]);
});

test("Linux apt cleanup fails when a successful purge leaves a selected package installed", async () => {
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async () => identity,
      runCommand: async () => commandResult("openjdk-17-jdk\n"),
      runElevated: async () => commandResult(""),
    },
  );
  assert.ok(operation.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /openjdk-17-jdk remained installed/);
});

test("unprivileged Linux apt cleanup fails before residual filesystem work", async () => {
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxAptBatchOperation(
    {
      ...contextFor("linux"),
      isContainer: true,
      hasPasswordlessSudo: false,
    },
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async () => identity,
      runCommand: async () => commandResult("openjdk-17-jdk\n"),
    },
  );
  assert.ok(operation.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /passwordless sudo.*required/i);
});

test("Linux apt cleanup requires its complete executable inventory before mutation", async () => {
  let mutations = 0;
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async (executable) =>
        executable === LINUX_PACKAGE_EXECUTABLES.dpkgQuery
          ? undefined
          : LINUX_TEST_IDENTITY,
      runCommand: async () => commandResult("openjdk-17-jdk\n"),
      runElevated: async () => {
        mutations += 1;
        return commandResult("");
      },
    },
  );
  assert.ok(operation.validate);

  await assert.rejects(
    operation.validate,
    /dpkg-query executable is unavailable/,
  );
  assert.equal(mutations, 0);
});

test("Linux apt cleanup rejects excess selected packages before elevation", async () => {
  let mutations = 0;
  const inventory = Array.from(
    { length: 513 },
    (_, index) => `openjdk-fixture-${index.toString().padStart(4, "0")}`,
  ).join("\n");
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async () => LINUX_TEST_IDENTITY,
      runCommand: async () => commandResult(`${inventory}\n`),
      runElevated: async () => {
        mutations += 1;
        return commandResult("");
      },
    },
  );
  assert.ok(operation.validate);

  await assert.rejects(operation.validate, /exceeded 512 packages/i);
  assert.equal(mutations, 0);
});

test("Linux rejects an active masked service before any stop", async () => {
  let stops = 0;
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) =>
      commandResult(property === "LoadState" ? "masked\n" : "active\n"),
    stop: async () => {
      stops += 1;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await assert.rejects(
    operation.validate,
    /masked.*cannot be safely restarted/,
  );
  assert.equal(stops, 0);
});

test("Linux Docker prune cannot use workflow-selected daemon configuration", async () => {
  const dockerIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const configIdentity: CommandFileIdentity = {
    ...LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY,
    inode: 77n,
    mode: 0o40555n,
  };
  let configExists = false;
  const calls: {
    kind: string;
    executable: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv | undefined;
  }[] = [];
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (executable) =>
      inspectDockerOrProtectedConfigUtility(executable, dockerIdentity),
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    validateConfigDirectory: async () => {
      assert.equal(configExists, true);
      return configIdentity;
    },
    runCommand: async (executable, args, options) => {
      calls.push({ kind: "probe", executable, args, environment: options.env });
      return commandResult("");
    },
    runElevated: async (_context, executable, args, options) => {
      if (executable === "/usr/bin/mkdir") {
        configExists = true;
        return commandResult("");
      }
      if (executable === "/usr/bin/rmdir") {
        configExists = false;
        return commandResult("");
      }
      calls.push({
        kind: "mutation",
        executable,
        args,
        environment: options.env,
      });
      return commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(configExists, false);
  assert.deepEqual(
    calls.map(({ kind, executable }) => `${kind}:${executable}`),
    [
      `probe:${LINUX_PACKAGE_EXECUTABLES.docker}`,
      `mutation:${LINUX_PACKAGE_EXECUTABLES.docker}`,
    ],
  );
  const configDirectory = calls[0]?.environment?.DOCKER_CONFIG;
  assert.match(
    configDirectory ?? "",
    /^\/tmp\/maximize-github-runner-space-docker-config-/,
  );
  for (const call of calls) {
    assert.equal(call.environment?.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(call.environment?.DOCKER_HOST, "unix:///var/run/docker.sock");
    assert.equal(call.environment?.DOCKER_CONTEXT, undefined);
    assert.deepEqual(call.args.slice(0, 4), [
      "--host",
      "unix:///var/run/docker.sock",
      "--config",
      configDirectory,
    ]);
  }
});

test("Linux Docker protects isolated configuration with atomic privileged utilities", async () => {
  const docker = LINUX_PACKAGE_EXECUTABLES.docker;
  const configDirectory =
    "/tmp/maximize-github-runner-space-docker-config-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dockerIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const utilities = new Set([
    "/usr/bin/env",
    "/usr/bin/mkdir",
    "/usr/bin/rmdir",
    "/usr/bin/sudo",
  ]);
  const systemCalls: { executable: string; args: readonly string[] }[] = [];
  const validations: CommandFileIdentity[] = [];
  let exists = false;
  let probes = 0;
  let prunes = 0;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) =>
      path === docker
        ? dockerIdentity
        : utilities.has(path)
          ? LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY
          : undefined,
    createConfigCandidate: async () => configDirectory,
    validateConfigDirectory: async (path) => {
      assert.equal(path, configDirectory);
      assert.equal(exists, true);
      const identity = {
        ...LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY,
        inode: 77n,
        mode: 0o40555n,
      };
      validations.push(identity);
      return identity;
    },
    runCommand: async (path) => {
      assert.equal(path, docker);
      probes += 1;
      return commandResult("");
    },
    runElevated: async (_context, path, args) => {
      if (path === "/usr/bin/mkdir") {
        assert.equal(exists, false);
        exists = true;
        systemCalls.push({ executable: path, args });
      } else if (path === "/usr/bin/rmdir") {
        assert.equal(exists, true);
        exists = false;
        systemCalls.push({ executable: path, args });
      } else {
        assert.equal(path, docker);
        prunes += 1;
      }
      return commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "removed");
  assert.equal(exists, false);
  assert.equal(probes, 1);
  assert.equal(prunes, 1);
  assert.equal(validations.length, 4);
  assert.deepEqual(systemCalls, [
    {
      executable: "/usr/bin/mkdir",
      args: ["-m", "0555", "--", configDirectory],
    },
    {
      executable: "/usr/bin/rmdir",
      args: ["--", configDirectory],
    },
  ]);
});

test("Linux Docker config creation fails closed on an atomic mkdir collision", async () => {
  const dockerIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const elevated: string[] = [];
  let configValidations = 0;
  let dockerCommands = 0;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) =>
      inspectDockerOrProtectedConfigUtility(path, dockerIdentity),
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    validateConfigDirectory: async () => {
      configValidations += 1;
      return dockerIdentity;
    },
    runCommand: async () => {
      dockerCommands += 1;
      return commandResult("");
    },
    runElevated: async (_context, executable) => {
      elevated.push(executable);
      return executable === "/usr/bin/mkdir"
        ? commandResult("", 1, "mkdir: File exists")
        : commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /File exists/);
  assert.deepEqual(elevated, ["/usr/bin/mkdir"]);
  assert.equal(configValidations, 0);
  assert.equal(dockerCommands, 0);
});

test("Linux Docker config creation rejects a protected utility replacement", async () => {
  const dockerIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  let utilityRound = 0;
  let mutations = 0;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) => {
      if (path === LINUX_PACKAGE_EXECUTABLES.docker) return dockerIdentity;
      if (path === "/usr/bin/env") utilityRound += 1;
      if (!LINUX_PROTECTED_CONFIG_UTILITY_PATHS.has(path)) return undefined;
      return path === "/usr/bin/mkdir" && utilityRound >= 2
        ? { ...LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY, inode: 99n }
        : LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY;
    },
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    runCommand: async () => {
      mutations += 1;
      return commandResult("");
    },
    runElevated: async () => {
      mutations += 1;
      return commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /trusted executable changed before/i);
  assert.equal(mutations, 0);
});

test("Linux Docker prune rejects an executable that appears after validation", async () => {
  let checks = 0;
  let executed = false;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async () =>
      ++checks === 1
        ? undefined
        : {
            device: 1n,
            inode: 2n,
            size: 3n,
            modifiedNanoseconds: 4n,
          },
    runCommand: async () => {
      executed = true;
      return commandResult("");
    },
    runElevated: async () => {
      executed = true;
      return commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
  assert.equal(executed, false);
});

test("Linux Docker prune reports an executable removed after validation", async () => {
  let dockerChecks = 0;
  const dockerIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) => {
      if (path === LINUX_PACKAGE_EXECUTABLES.docker) {
        dockerChecks += 1;
        return dockerChecks === 1 ? dockerIdentity : undefined;
      }
      return LINUX_PROTECTED_CONFIG_UTILITY_PATHS.has(path)
        ? LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY
        : undefined;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
});

test("Linux Docker removes isolated config after pre-mutation executable drift", async () => {
  const dockerIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  let dockerChecks = 0;
  let dockerCommands = 0;
  const protectedMutations: string[] = [];
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) => {
      if (path === LINUX_PACKAGE_EXECUTABLES.docker) {
        dockerChecks += 1;
        return dockerChecks < 3
          ? dockerIdentity
          : { ...dockerIdentity, inode: 99n };
      }
      return LINUX_PROTECTED_CONFIG_UTILITY_PATHS.has(path)
        ? LINUX_PROTECTED_CONFIG_UTILITY_IDENTITY
        : undefined;
    },
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    validateConfigDirectory: async () => dockerIdentity,
    runCommand: async () => {
      dockerCommands += 1;
      return commandResult("");
    },
    runElevated: async (_context, executable) => {
      protectedMutations.push(executable);
      return commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed before daemon inspection/);
  assert.deepEqual(protectedMutations, ["/usr/bin/mkdir", "/usr/bin/rmdir"]);
  assert.equal(dockerCommands, 0);
});

test("Linux Docker prune rejects isolated configuration drift", async () => {
  const executableIdentity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  let configChecks = 0;
  let commands = 0;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) =>
      inspectDockerOrProtectedConfigUtility(path, executableIdentity),
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    validateConfigDirectory: async () => ({
      ...executableIdentity,
      inode: ++configChecks === 1 ? 7n : 8n,
    }),
    runCommand: async () => {
      commands += 1;
      return commandResult("");
    },
    runElevated: async (_context, path) => {
      if (path === LINUX_PACKAGE_EXECUTABLES.docker) commands += 1;
      return commandResult("");
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configuration changed/);
  assert.equal(commands, 0);
});

test("Linux Docker timeout is a failure, not an unavailable daemon", async () => {
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) =>
      inspectDockerOrProtectedConfigUtility(path, identity),
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    validateConfigDirectory: async () => identity,
    runCommand: async () => ({
      exitCode: 124,
      stdout: "",
      stderr: "timed out",
    }),
    runElevated: async () => commandResult(""),
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /timed out/);
});

test("Linux Docker does not remove isolated configuration after a fatal timeout latch", async () => {
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const fatal = new UnconfirmedCommandTerminationError(
    "simulated Docker timeout",
  );
  let removals = 0;
  const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
    inspectExecutable: async (path) =>
      inspectDockerOrProtectedConfigUtility(path, identity),
    createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
    validateConfigDirectory: async () => identity,
    runCommand: async () => commandResult(""),
    runElevated: async (_context, path) => {
      if (path === "/usr/bin/mkdir") return commandResult("");
      if (path === "/usr/bin/rmdir") {
        removals += 1;
        return commandResult("");
      }
      assert.equal(path, LINUX_PACKAGE_EXECUTABLES.docker);
      markCommandTerminationUnconfirmed(fatal.message);
      throw fatal;
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
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "unsupported",
  ],
  [
    "permission denied while trying to connect to the Docker daemon socket",
    "failed",
  ],
] as const) {
  test(`Linux Docker classifies exit 1 as ${expectedStatus} for ${stderr}`, async () => {
    const identity: CommandFileIdentity = {
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
    };
    const operation = createLinuxDockerPruneOperation(contextFor("linux"), {
      inspectExecutable: async (path) =>
        inspectDockerOrProtectedConfigUtility(path, identity),
      createConfigCandidate: async () => LINUX_DOCKER_CONFIG_DIRECTORY,
      validateConfigDirectory: async () => identity,
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr }),
      runElevated: async () => commandResult(""),
    });

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, expectedStatus);
  });
}

test("Linux apt finalization rejects an executable that appears after validation", async () => {
  let checks = 0;
  let elevated = false;
  const operation = createLinuxAptFinalizeOperation(
    contextFor("linux"),
    () => true,
    {
      inspectExecutable: async () =>
        ++checks === 1
          ? undefined
          : {
              device: 1n,
              inode: 2n,
              size: 3n,
              modifiedNanoseconds: 4n,
            },
      runElevated: async () => {
        elevated = true;
        return commandResult("");
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
  assert.equal(elevated, false);
});

test("Linux apt finalization reports an executable removed after validation", async () => {
  let checks = 0;
  const operation = createLinuxAptFinalizeOperation(
    contextFor("linux"),
    () => true,
    {
      inspectExecutable: async () =>
        ++checks === 1
          ? {
              device: 1n,
              inode: 2n,
              size: 3n,
              modifiedNanoseconds: 4n,
            }
          : undefined,
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after plan validation/);
});

test("Linux apt finalization cleans archives without global autoremove", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxAptFinalizeOperation(
    contextFor("linux"),
    () => true,
    {
      inspectExecutable: async () => identity,
      runElevated: async (_context, executable, args) => {
        assert.equal(executable, LINUX_PACKAGE_EXECUTABLES.aptGet);
        mutableCalls.push([...args]);
        return commandResult("");
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.includes("autoremove"), false);
  assert.equal(calls[0]?.at(-1), "clean");
});

test("Linux apt inventory failures abort complete-plan validation", async () => {
  const identity: CommandFileIdentity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async () => identity,
      runCommand: async () => commandResult("", 5, "dpkg database locked"),
    },
  );

  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /dpkg database locked/);
});

test("Linux apt cleanup stops if a package executable changes before mutation", async () => {
  let aptChecks = 0;
  let elevated = false;
  const operation = createLinuxAptBatchOperation(
    contextFor("linux"),
    planFor("java"),
    () => undefined,
    {
      inspectExecutable: async (executable) => ({
        device: 1n,
        inode:
          executable === LINUX_PACKAGE_EXECUTABLES.aptGet && ++aptChecks > 2
            ? 99n
            : 2n,
        size: 3n,
        modifiedNanoseconds: 4n,
      }),
      runCommand: async () => commandResult("openjdk-17-jdk\n"),
      runElevated: async () => {
        elevated = true;
        return commandResult("");
      },
    },
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed before package mutation/);
  assert.equal(elevated, false);
});

test("Linux systemd inventory has one aggregate deadline", async () => {
  let now = 0;
  let stops = 0;
  let masks = 0;
  const timeouts: number[] = [];
  const systemctl: LinuxSystemctl = {
    now: () => now,
    show: async (_unit, property, timeoutMs) => {
      assert.notEqual(timeoutMs, undefined);
      timeouts.push(timeoutMs!);
      now += 40_001;
      return commandResult(
        property === "LoadState"
          ? "loaded\n"
          : property === "ActiveState"
            ? "active\n"
            : "enabled\n",
      );
    },
    stop: async () => {
      stops += 1;
      return commandResult("");
    },
    start: async () => commandResult(""),
    mask: async () => {
      masks += 1;
      return commandResult("");
    },
    unmask: async () => commandResult(""),
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await assert.rejects(
    operation.validate,
    /systemd unit inventory exceeded its two-minute aggregate deadline/i,
  );
  assert.equal(stops, 0);
  assert.equal(masks, 0);
  assert.deepEqual(timeouts, [120_000, 79_999, 39_998]);
});

test("Linux systemd rejects a non-monotonic budget clock before commands", async () => {
  const clock = [10, 9];
  let commands = 0;
  const systemctl: LinuxSystemctl = {
    now: () => clock.shift() ?? 9,
    show: async () => {
      commands += 1;
      return commandResult("loaded\n");
    },
    stop: async () => {
      commands += 1;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await assert.rejects(operation.validate, /invalid monotonic clock value/i);
  assert.equal(commands, 0);
});

test("Linux systemd transition checks its aggregate deadline after each command", async () => {
  let now = 0;
  let active = true;
  let masks = 0;
  let starts = 0;
  const stopTimeouts: number[] = [];
  const systemctl: LinuxSystemctl = {
    now: () => now,
    show: async (_unit, property) =>
      commandResult(
        property === "LoadState"
          ? "loaded\n"
          : property === "UnitFileState"
            ? "enabled\n"
            : active
              ? "active\n"
              : "inactive\n",
      ),
    stop: async (_unit, timeoutMs) => {
      assert.notEqual(timeoutMs, undefined);
      stopTimeouts.push(timeoutMs!);
      active = false;
      now += 120_001;
      return commandResult("");
    },
    start: async () => {
      starts += 1;
      active = true;
      return commandResult("");
    },
    mask: async () => {
      masks += 1;
      return commandResult("");
    },
    unmask: async () => commandResult(""),
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /systemd service coordination exceeded its two-minute aggregate deadline/i,
  );
  assert.deepEqual(stopTimeouts, [120_000]);
  assert.equal(masks, 0);
  assert.equal(starts, 1, "rollback receives a fresh aggregate budget");
  assert.equal(active, true);
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

test("a later Linux payload failure leaves preflight services stopped", async () => {
  let active = true;
  let starts = 0;
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) =>
      commandResult(
        property === "LoadState"
          ? "loaded\n"
          : active
            ? "active\n"
            : "inactive\n",
      ),
    stop: async () => {
      active = false;
      return commandResult("");
    },
    start: async () => {
      starts += 1;
      active = true;
      return commandResult("");
    },
  };
  const service = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.notEqual(service, undefined);
  const packageFailure = createFunctionOperation({
    id: "apt:failure",
    component: "nginx",
    description: "apt failure",
    phase: "package",
    run: async () => ({
      status: "failed",
      detail: "package inventory unavailable",
    }),
  });

  await assert.rejects(
    async () => await executeOperations([service!, packageFailure]),
    /package inventory unavailable/,
  );
  assert.equal(starts, 0);
  assert.equal(active, false);
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

test("Linux runtime-masks selected units before payload cleanup", async () => {
  let active = true;
  let masked = false;
  const calls: string[] = [];
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) =>
      commandResult(
        property === "LoadState"
          ? "loaded\n"
          : property === "UnitFileState"
            ? masked
              ? "masked-runtime\n"
              : "enabled\n"
            : active
              ? "active\n"
              : "inactive\n",
      ),
    stop: async (unit) => {
      calls.push(`stop:${unit}`);
      active = false;
      return commandResult("");
    },
    start: async (unit) => {
      calls.push(`start:${unit}`);
      if (masked) return commandResult("", 1, "unit is masked");
      active = true;
      return commandResult("");
    },
    mask: async (unit) => {
      calls.push(`mask:${unit}`);
      masked = true;
      return commandResult("");
    },
    unmask: async (unit) => {
      calls.push(`unmask:${unit}`);
      masked = false;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(active, false);
  assert.equal(masked, true);
  assert.deepEqual(calls, ["stop:nginx.service", "mask:nginx.service"]);
  assert.equal((await systemctl.start?.("nginx.service"))?.exitCode, 1);
});

test("Linux service validation inventories every unit-file state before stopping anything", async () => {
  let stops = 0;
  let masks = 0;
  const systemctl: LinuxSystemctl = {
    show: async (unit, property) => {
      if (property === "LoadState") return commandResult("loaded\n");
      if (property === "ActiveState") return commandResult("active\n");
      if (unit === "docker.service") {
        return commandResult("", 1, "unit-file state unavailable");
      }
      return commandResult("enabled\n");
    },
    stop: async () => {
      stops += 1;
      return commandResult("");
    },
    start: async () => commandResult(""),
    mask: async () => {
      masks += 1;
      return commandResult("");
    },
    unmask: async () => commandResult(""),
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("docker-engine"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await assert.rejects(operation.validate, /unit-file state unavailable/);
  assert.equal(stops, 0);
  assert.equal(masks, 0);
});

test("Linux service rollback re-stops an originally inactive unit activated by unmask", async () => {
  let active = false;
  let masked = false;
  let stops = 0;
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) =>
      commandResult(
        property === "LoadState"
          ? "loaded\n"
          : property === "UnitFileState"
            ? masked
              ? "masked-runtime\n"
              : "enabled\n"
            : active
              ? "active\n"
              : "inactive\n",
      ),
    stop: async () => {
      stops += 1;
      active = false;
      return commandResult("");
    },
    start: async () => {
      active = true;
      return commandResult("");
    },
    mask: async () => {
      masked = true;
      return commandResult("");
    },
    unmask: async () => {
      masked = false;
      active = true;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");

  await operation.rollback();

  assert.equal(active, false);
  assert.equal(masked, false);
  assert.equal(stops, 2);
});

test("Linux service rollback removes a runtime mask applied by a failed command", async () => {
  let active = true;
  let masked = false;
  const calls: string[] = [];
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) =>
      commandResult(
        property === "LoadState"
          ? "loaded\n"
          : property === "UnitFileState"
            ? masked
              ? "masked-runtime\n"
              : "enabled\n"
            : active
              ? "active\n"
              : "inactive\n",
      ),
    stop: async (unit) => {
      calls.push(`stop:${unit}`);
      active = false;
      return commandResult("");
    },
    start: async (unit) => {
      calls.push(`start:${unit}`);
      if (masked) return commandResult("", 1, "unit remains masked");
      active = true;
      return commandResult("");
    },
    mask: async (unit) => {
      calls.push(`mask:${unit}`);
      masked = true;
      return commandResult("", 1, "mask failed after changing state");
    },
    unmask: async (unit) => {
      calls.push(`unmask:${unit}`);
      masked = false;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /mask failed after changing state/);
  assert.equal(masked, false);
  assert.equal(active, true);
  assert.deepEqual(calls, [
    "stop:nginx.service",
    "mask:nginx.service",
    "unmask:nginx.service",
    "start:nginx.service",
  ]);
});

test("Linux service rollback retains failed runtime-mask recovery for retry", async () => {
  let active = true;
  let masked = false;
  let failUnmask = true;
  let rollbackCalls = 0;
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) =>
      commandResult(
        property === "LoadState"
          ? "loaded\n"
          : property === "UnitFileState"
            ? masked
              ? "masked-runtime\n"
              : "enabled\n"
            : active
              ? "active\n"
              : "inactive\n",
      ),
    stop: async () => {
      active = false;
      return commandResult("");
    },
    start: async () => {
      rollbackCalls += 1;
      if (masked) return commandResult("", 1, "unit remains masked");
      active = true;
      return commandResult("");
    },
    mask: async () => {
      masked = true;
      return commandResult("");
    },
    unmask: async () => {
      rollbackCalls += 1;
      if (failUnmask) return commandResult("", 1, "unmask failed");
      masked = false;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);
  assert.ok(operation.rollback);
  await operation.validate();
  assert.equal((await operation.run()).status, "removed");

  await assert.rejects(operation.rollback, /unmask failed|remains masked/);
  assert.equal(active, false);
  assert.equal(masked, true);
  failUnmask = false;
  await operation.rollback();
  assert.equal(active, true);
  assert.equal(masked, false);
  const callsAfterRecovery = rollbackCalls;
  await operation.rollback();
  assert.equal(rollbackCalls, callsAfterRecovery);
});

test("Linux service cleanup restores earlier active units after a later stop fails", async () => {
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
      if (unit === "containerd.service") {
        return commandResult("", 5, "stop failed");
      }
      stopped.add(unit);
      return commandResult("");
    },
    start: async (unit) => {
      calls.push(`start:${unit}`);
      stopped.delete(unit);
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
  assert.match(result.detail ?? "", /stop failed/);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("start:")),
    ["start:docker.service", "start:docker.socket"],
  );
  assert.deepEqual([...stopped], []);
});

test("Linux service cleanup restores an active unit when its stop reports failure after stopping it", async () => {
  const calls: string[] = [];
  let active = true;
  const systemctl: LinuxSystemctl = {
    show: async (unit, property) => {
      calls.push(`show:${property}:${unit}`);
      return commandResult(
        property === "LoadState"
          ? "loaded\n"
          : active
            ? "active\n"
            : "inactive\n",
      );
    },
    stop: async (unit) => {
      calls.push(`stop:${unit}`);
      active = false;
      return commandResult("", 124, "stop timed out");
    },
    start: async (unit) => {
      calls.push(`start:${unit}`);
      active = true;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /stop timed out/);
  assert.equal(active, true);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("start:")),
    ["start:nginx.service"],
  );
});

test("an unconfirmed service-stop timeout never launches rollback commands", async () => {
  let active = true;
  let starts = 0;
  const fatal = new UnconfirmedCommandTerminationError(
    "nginx stop process tree could not be confirmed dead",
  );
  const systemctl: LinuxSystemctl = {
    show: async (_unit, property) => {
      assertCommandTerminationConfirmed();
      return commandResult(
        property === "LoadState"
          ? "loaded\n"
          : active
            ? "active\n"
            : "inactive\n",
      );
    },
    stop: async () => {
      active = false;
      markCommandTerminationUnconfirmed(fatal.message);
      throw fatal;
    },
    start: async () => {
      assertCommandTerminationConfirmed();
      starts += 1;
      active = true;
      return commandResult("");
    },
  };
  const operation = createLinuxServiceStopOperation(
    contextFor("linux"),
    planFor("nginx"),
    systemctl,
  );
  assert.ok(operation?.validate);

  try {
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /could not be confirmed dead/);
    assert.equal(starts, 0);
    assert.equal(active, false);
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("Linux service rollback continues when status and restart calls throw", async () => {
  const active = new Set([
    "docker.socket",
    "docker.service",
    "containerd.service",
  ]);
  const starts: string[] = [];
  let rollback = false;
  const systemctl: LinuxSystemctl = {
    show: async (unit, property) => {
      if (property === "LoadState") return commandResult("loaded\n");
      if (rollback && unit === "docker.service" && !starts.includes(unit)) {
        throw new Error("docker status unavailable");
      }
      return commandResult(active.has(unit) ? "active\n" : "inactive\n");
    },
    stop: async (unit) => {
      active.delete(unit);
      if (unit === "containerd.service") {
        rollback = true;
        return commandResult("", 124, "containerd stop timed out");
      }
      return commandResult("");
    },
    start: async (unit) => {
      starts.push(unit);
      if (unit === "containerd.service") {
        throw new Error("containerd restart crashed");
      }
      active.add(unit);
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
  assert.match(result.detail ?? "", /containerd restart crashed/);
  assert.match(result.detail ?? "", /docker status unavailable/);
  assert.deepEqual(starts, [
    "containerd.service",
    "docker.service",
    "docker.socket",
  ]);
  assert.deepEqual([...active].sort(), ["docker.service", "docker.socket"]);
});

test("Linux Homebrew cleanup removes only its anchored cache", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-linuxbrew-cache-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const home = join(root, "home");
  const cache = join(home, ".cache", "Homebrew");
  const prefixPackage = join(root, "linuxbrew", "Cellar", "workflow-tool");
  await mkdir(cache, { recursive: true });
  await mkdir(prefixPackage, { recursive: true });
  await writeFile(join(cache, "download"), "remove me");
  await writeFile(join(prefixPackage, "installed"), "preserve me");
  const operation = createLinuxHomebrewCleanupOperation({
    ...contextFor("linux"),
    home,
    workspace: undefined,
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(
    result.status,
    "removed",
    result.detail ?? "cache removal failed",
  );
  await assert.rejects(async () => await access(cache));
  assert.equal(
    await readFile(join(prefixPackage, "installed"), "utf8"),
    "preserve me",
  );
});

test("Linux Homebrew cleanup refuses a cache exchanged after validation", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-linuxbrew-race-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const home = join(root, "home");
  const cache = join(home, ".cache", "Homebrew");
  const original = join(home, ".cache", "Homebrew-original");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "owned"), "original");
  const operation = createLinuxHomebrewCleanupOperation({
    ...contextFor("linux"),
    home,
    workspace: undefined,
  });
  assert.ok(operation.validate);
  await operation.validate();

  await rename(cache, original);
  await mkdir(cache);
  await writeFile(join(cache, "sentinel"), "replacement");
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /boundary changed/);
  assert.equal(await readFile(join(cache, "sentinel"), "utf8"), "replacement");
  assert.equal(await readFile(join(original, "owned"), "utf8"), "original");
});

test("Linux adapter schedules cache-only Homebrew cleanup", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const operations = await adapter.operations(planFor("homebrew"));

  assert.equal(
    operations.some(({ id }) => id === "linux:brew:cache"),
    true,
  );
  assert.equal(
    operations.some(({ id }) => id.includes("/home/linuxbrew/.linuxbrew")),
    false,
  );
});
