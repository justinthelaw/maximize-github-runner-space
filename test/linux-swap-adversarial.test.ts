import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCommand } from "../src/command.js";
import {
  createSwapOperation,
  FSTAB_EXCHANGE_SCRIPT,
  IDENTITY_BOUND_UNLINK_SCRIPT,
  LINUX_SWAP_EXECUTABLES,
  openLinuxMetadataHandle,
  SWAP_TRANSITION_SCRIPT,
  type LinuxSwapCommandInvocation,
  type LinuxSwapDependencies,
} from "../src/platforms/linux.js";
import { contextFor } from "./helpers.js";

const success = { exitCode: 0, stdout: "", stderr: "" } as const;

test(
  "pinned swap transition rolls back when the live path changes",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const root = await mkdtemp(join(tmpdir(), "maximize-swap-transition-"));
    testContext.after(
      async () => await rm(root, { recursive: true, force: true }),
    );
    const target = join(root, "swapfile");
    const displaced = join(root, "swapfile.displaced");
    await writeFile(target, "original", { mode: 0o600 });
    const metadata = await stat(target, { bigint: true });
    const instrumented = SWAP_TRANSITION_SCRIPT.replace(
      "try:\n    apply_transition(action)",
      'def apply_transition(selected):\n    print("TRANSITION:" + selected, flush=True)\ntry:\n    apply_transition(action)\n    print("READY", flush=True)\n    sys.stdin.readline()',
    );
    assert.notEqual(instrumented, SWAP_TRANSITION_SCRIPT);
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        instrumented,
        "on",
        target,
        metadata.dev.toString(),
        metadata.ino.toString(),
        metadata.size.toString(),
        metadata.mode.toString(),
        metadata.uid.toString(),
        metadata.gid.toString(),
        metadata.mtimeNs.toString(),
        metadata.ctimeNs.toString(),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n") && !settled) {
          settled = true;
          resolve();
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `fstab helper exited ${String(code)} before READY: ${stdout} ${stderr}`,
          ),
        );
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await ready;
    await rename(target, displaced);
    await writeFile(target, "foreign", { mode: 0o600 });
    child.stdin.end("\n");
    const [exitCode] = (await once(child, "close")) as [number];

    assert.equal(exitCode, 73, stderr);
    assert.match(stdout, /TRANSITION:on/);
    assert.match(stdout, /TRANSITION:off/);
    assert.match(stdout, /ROLLED_BACK/);
    assert.equal(await readFile(target, "utf8"), "foreign");
    assert.equal(await readFile(displaced, "utf8"), "original");
  },
);

test(
  "Linux metadata handles can pin an unreadable swap staging file",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    let target = "/proc/1/mem";
    if (process.getuid?.() !== 0) {
      const root = await mkdtemp(join(tmpdir(), "maximize-swap-opath-"));
      testContext.after(
        async () => await rm(root, { recursive: true, force: true }),
      );
      target = join(root, "unreadable-swapfile");
      await writeFile(target, "fixture", { mode: 0o000 });
    }
    try {
      const readable = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      await readable.close();
      testContext.skip(`${target} is readable on this host`);
      return;
    } catch (error) {
      assert.match(
        (error as NodeJS.ErrnoException).code ?? "",
        /^(?:EACCES|EPERM)$/,
      );
    }

    const handle = await openLinuxMetadataHandle(target);
    try {
      assert.equal((await handle.stat()).isFile(), true);
    } finally {
      await handle.close();
    }
  },
);

interface SwapHarnessHooks {
  readonly beforeFstabExchange?: () => Promise<void>;
  readonly beforeBackupPath?: () => Promise<void>;
  readonly move?: (
    source: string,
    destination: string,
  ) => Promise<
    undefined | { readonly exitCode: number; readonly stderr?: string }
  >;
  readonly grep?: () => Promise<number>;
  readonly temporaryMode?: number;
  readonly afterFallocate?: (path: string) => Promise<void>;
  readonly beforeIdentityBoundUnlink?: (path: string) => Promise<void>;
  readonly failSwapon?: boolean;
}

interface SwapHarness {
  readonly dependencies: LinuxSwapDependencies;
  readonly getBackupPath: () => string | undefined;
  readonly getSwaponCalls: () => number;
}

async function createFixture(testContext: test.TestContext): Promise<{
  readonly root: string;
  readonly swapfile: string;
  readonly fstab: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "maximize-swap-adversarial-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  await mkdir(join(root, "mnt"));
  await mkdir(join(root, "etc"));
  const fstab = join(root, "etc", "fstab");
  await writeFile(fstab, "# fixture\n");
  return { root, swapfile: join(root, "mnt", "swapfile"), fstab };
}

function ownedEntry(swapfile: string): string {
  return `${swapfile} none swap sw 0 0`;
}

const fstabIndentations = [
  { name: "space", value: "  " },
  { name: "tab", value: "\t" },
] as const;

async function identityArguments(path: string): Promise<string[]> {
  const metadata = await stat(path, { bigint: true });
  return [
    metadata.dev.toString(),
    metadata.ino.toString(),
    metadata.size.toString(),
    metadata.mode.toString(),
    metadata.uid.toString(),
    metadata.gid.toString(),
    metadata.mtimeNs.toString(),
    metadata.ctimeNs.toString(),
  ];
}

async function fstabSnapshotArguments(path: string): Promise<string[]> {
  const metadata = await stat(path, { bigint: true });
  const content = await readFile(path);
  return [
    metadata.dev.toString(),
    metadata.ino.toString(),
    metadata.size.toString(),
    metadata.mtimeNs.toString(),
    metadata.ctimeNs.toString(),
    (metadata.mode & 0o7777n).toString(),
    metadata.uid.toString(),
    metadata.gid.toString(),
    createHash("sha256").update(content).digest("hex"),
  ];
}

async function fstabExchangeBoundaryArguments(
  target: string,
): Promise<string[]> {
  const parent = dirname(target);
  const metadata = await stat(parent, { bigint: true });
  const handle = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const fdinfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
    const mountId = /^mnt_id:[ \t]+([0-9]+)[ \t]*$/m.exec(fdinfo)?.[1];
    assert.notEqual(mountId, undefined);
    return [
      metadata.dev.toString(),
      metadata.ino.toString(),
      metadata.mode.toString(),
      metadata.uid.toString(),
      metadata.gid.toString(),
      mountId ?? "",
    ];
  } finally {
    await handle.close();
  }
}

function nativeFilesystemDependencies(
  dependencies: LinuxSwapDependencies & {
    readonly nativeFilesystemSemantics?: boolean;
  },
): LinuxSwapDependencies {
  return dependencies;
}

function createHarness(
  root: string,
  fstab: string,
  hooks: SwapHarnessHooks = {},
): SwapHarness {
  let active = false;
  let temporaryCounter = 0;
  let backupPath: string | undefined;
  let swaponCalls = 0;
  let fstabExchangeInjected = false;
  let backupPathInjected = false;

  const commandRunner = async (invocation: LinuxSwapCommandInvocation) => {
    const { executable, args, options } = invocation;
    if (
      executable === LINUX_SWAP_EXECUTABLES.swapon &&
      args[0] === "--show=NAME"
    ) {
      return {
        ...success,
        stdout: active ? `${join(root, "mnt", "swapfile")}\n` : "",
      };
    }
    if (executable === LINUX_SWAP_EXECUTABLES.swapon) {
      swaponCalls += 1;
      active = true;
      return success;
    }
    if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
      active = false;
      return success;
    }
    if (executable === LINUX_SWAP_EXECUTABLES.test) {
      const target = args[1];
      assert.ok(target !== undefined);
      try {
        await access(target);
        return success;
      } catch {
        return { ...success, exitCode: 1 };
      }
    }
    if (executable === LINUX_SWAP_EXECUTABLES.grep) {
      if (hooks.grep !== undefined) {
        return { ...success, exitCode: await hooks.grep() };
      }
      const content = await readFile(fstab, "utf8");
      const swapfile = join(root, "mnt", "swapfile");
      const present = content
        .split("\n")
        .some((line) => line.startsWith(`${swapfile} `));
      return { ...success, exitCode: present ? 0 : 1 };
    }
    if (executable === LINUX_SWAP_EXECUTABLES.df) {
      return { ...success, stdout: "Avail\n1073741824\n" };
    }
    if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
      temporaryCounter += 1;
      const template = args[0];
      assert.ok(template !== undefined && template.endsWith("XXXXXX"));
      const suffix = temporaryCounter.toString().padStart(6, "0");
      const path = `${template.slice(0, -6)}${suffix}`;
      if (
        path.includes(".previous.") &&
        hooks.beforeBackupPath !== undefined &&
        !backupPathInjected
      ) {
        backupPathInjected = true;
        await hooks.beforeBackupPath();
      }
      await writeFile(path, "", { mode: hooks.temporaryMode ?? 0o600 });
      if (path.includes(".previous.")) backupPath = path;
      return { ...success, stdout: `${path}\n` };
    }
    if (executable === LINUX_SWAP_EXECUTABLES.tee) {
      const target = args[0];
      assert.ok(target !== undefined);
      await writeFile(target, options.input ?? "");
      return success;
    }
    if (executable === LINUX_SWAP_EXECUTABLES.fallocate) {
      const target = args[2];
      const size = args[1];
      assert.ok(target !== undefined && size !== undefined);
      await truncate(target, Number(size));
      await hooks.afterFallocate?.(target);
      return success;
    }
    if (executable === LINUX_SWAP_EXECUTABLES.truncate) {
      const target = args[2];
      const size = args[1];
      assert.ok(target !== undefined && size !== undefined);
      await truncate(target, Number(size));
      return success;
    }
    if (executable === LINUX_SWAP_EXECUTABLES.chmod) {
      const rawMode = args[0];
      const target = args.at(-1);
      assert.ok(rawMode !== undefined && target !== undefined);
      await chmod(target, Number.parseInt(rawMode, 8));
      return success;
    }
    if (executable === LINUX_SWAP_EXECUTABLES.mv) {
      const source = args.at(-2);
      const destination = args.at(-1);
      assert.ok(source !== undefined && destination !== undefined);
      if (
        destination === fstab &&
        hooks.beforeFstabExchange !== undefined &&
        !fstabExchangeInjected
      ) {
        fstabExchangeInjected = true;
        await hooks.beforeFstabExchange();
      }
      const intercepted = await hooks.move?.(source, destination);
      if (intercepted !== undefined) {
        return {
          ...success,
          exitCode: intercepted.exitCode,
          stderr: intercepted.stderr ?? "",
        };
      }
      await rename(source, destination);
      return success;
    }
    if (/^\/usr\/bin\/python3(?:\.[0-9]+)+$/.test(executable)) {
      if (args[3] === IDENTITY_BOUND_UNLINK_SCRIPT) {
        const target = args[4];
        assert.ok(target !== undefined);
        await hooks.beforeIdentityBoundUnlink?.(target);
      }
      if (hooks.beforeFstabExchange !== undefined && !fstabExchangeInjected) {
        fstabExchangeInjected = true;
        await hooks.beforeFstabExchange();
      }
      return await runCommand(executable, args, options);
    }
    if (executable === LINUX_SWAP_EXECUTABLES.rm) {
      for (const target of args.filter((arg) => arg.startsWith(root))) {
        await rm(target, { force: true });
      }
      return success;
    }
    return success;
  };

  return {
    dependencies: nativeFilesystemDependencies({
      commandRunner,
      nativeFilesystemSemantics: true,
      inspectExecutable: async (executable) => ({
        device: 1n,
        inode: 2n,
        size: 3n,
        modifiedNanoseconds: 4n,
        contentSha256: executable,
      }),
      swapTransition: async (action) => {
        if (action === "on") {
          swaponCalls += 1;
          if (hooks.failSwapon === true) {
            return {
              ...success,
              exitCode: 1,
              stderr: "simulated swapon failure",
            };
          }
          active = true;
        } else {
          active = false;
        }
        return { ...success, stdout: "APPLIED\n" };
      },
    }),
    getBackupPath: () => backupPath,
    getSwaponCalls: () => swaponCalls,
  };
}

test("swap staging rejects a temporary file with unsafe permissions", async (testContext) => {
  const { root, fstab } = await createFixture(testContext);
  const harness = createHarness(root, fstab, { temporaryMode: 0o644 });
  const operation = createSwapOperation(
    contextFor("linux"),
    1024n ** 2n,
    root,
    harness.dependencies,
  );
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /temporary.*permissions|mode.*0600/i);
  assert.equal(harness.getSwaponCalls(), 0);
});

test("swap validation proves fstab is readable before any command can mutate state", async (testContext) => {
  const { root, fstab } = await createFixture(testContext);
  let commandCalls = 0;
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    nativeFilesystemDependencies({
      nativeFilesystemSemantics: true,
      validateReadableFstab: async (path: string) => {
        assert.equal(path, fstab);
        throw new Error("simulated unreadable fstab");
      },
      commandRunner: async () => {
        commandCalls += 1;
        return success;
      },
      inspectExecutable: async (executable) => ({
        device: 1n,
        inode: 2n,
        size: 3n,
        modifiedNanoseconds: 4n,
        contentSha256: executable,
      }),
    } as LinuxSwapDependencies),
  );

  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /unreadable fstab/);
  assert.equal(commandCalls, 0);
});

test("swap staging retains a replacement exchanged during allocation", async (testContext) => {
  const { root, fstab } = await createFixture(testContext);
  let foreignPath: string | undefined;
  const harness = createHarness(root, fstab, {
    afterFallocate: async (path) => {
      await rename(path, `${path}.displaced`);
      await writeFile(path, "foreign replacement", { mode: 0o600 });
      foreignPath = path;
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    1024n ** 2n,
    root,
    harness.dependencies,
  );
  assert.ok(operation.validate);
  await operation.validate();

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /temporary swap file identity changed/i);
  assert.match(result.detail ?? "", /file retained/i);
  assert.equal(harness.getSwaponCalls(), 0);
  assert.ok(foreignPath !== undefined);
  assert.equal(await readFile(foreignPath, "utf8"), "foreign replacement");
});

test("an fstab writer racing the commit is restored instead of overwritten", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(fstab, `# original\n${ownedEntry(swapfile)}\n`);
  const concurrent = "# concurrent writer\nUUID=data /data ext4 defaults 0 2\n";
  const harness = createHarness(root, fstab, {
    beforeFstabExchange: async () => {
      const writer = join(root, "etc", "fstab.writer");
      await writeFile(writer, concurrent);
      await rename(writer, fstab);
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /fstab.*changed|concurrent/i);
  assert.equal(await readFile(fstab, "utf8"), concurrent);
});

test("an fstab mode writer racing the commit remains live", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(fstab, `# original\n${ownedEntry(swapfile)}\n`);
  await chmod(fstab, 0o644);
  const harness = createHarness(root, fstab, {
    beforeFstabExchange: async () => await chmod(fstab, 0o600),
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /fstab.*changed|concurrent/i);
  assert.equal((await stat(fstab)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(fstab, "utf8"),
    `# original\n${ownedEntry(swapfile)}\n`,
  );
});

test(
  "ambiguous fstab exchange never performs a second exchange",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const { root, fstab } = await createFixture(testContext);
    const replacement = join(root, "etc", "fstab.replacement");
    const intendedRetained = join(root, "etc", "fstab.intended");
    const original = "# original\n";
    const intended = "# intended\n";
    const foreign = "# foreign staging writer\n";
    await writeFile(fstab, original, { mode: 0o644 });
    await writeFile(replacement, intended, { mode: 0o644 });
    const argumentsFor = async (path: string): Promise<string[]> => {
      const metadata = await stat(path, { bigint: true });
      const content = await readFile(path);
      return [
        metadata.dev.toString(),
        metadata.ino.toString(),
        metadata.size.toString(),
        metadata.mtimeNs.toString(),
        metadata.ctimeNs.toString(),
        (metadata.mode & 0o7777n).toString(),
        metadata.uid.toString(),
        metadata.gid.toString(),
        createHash("sha256").update(content).digest("hex"),
      ];
    };
    const instrumented = FSTAB_EXCHANGE_SCRIPT.replace(
      "exchange_error = None\ntry:\n    exchange()",
      'print("READY", flush=True)\nsys.stdin.readline()\nexchange_error = None\ntry:\n    exchange()',
    );
    assert.notEqual(instrumented, FSTAB_EXCHANGE_SCRIPT);
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        instrumented,
        replacement,
        fstab,
        ...(await argumentsFor(replacement)),
        ...(await argumentsFor(fstab)),
        ...(await fstabExchangeBoundaryArguments(fstab)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n") && !settled) {
          settled = true;
          resolve();
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `fstab helper exited ${String(code)} before READY: ${stdout} ${stderr}`,
          ),
        );
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await ready;
    await rename(replacement, intendedRetained);
    await writeFile(replacement, foreign, { mode: 0o644 });
    child.stdin.end("\n");
    const [exitCode] = (await once(child, "close")) as [number];

    assert.equal(exitCode, 74, stderr);
    assert.match(stdout, /UNCONFIRMED/);
    assert.equal(await readFile(fstab, "utf8"), foreign);
    assert.equal(await readFile(replacement, "utf8"), original);
    assert.equal(await readFile(intendedRetained, "utf8"), intended);
    assert.match(stderr, /original retained at/);
  },
);

test(
  "fstab leaves a post-exchange live writer in place",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const { root, fstab } = await createFixture(testContext);
    const replacement = join(root, "etc", "fstab.replacement");
    const writer = join(root, "etc", "fstab.writer");
    const original = "# original\n";
    const intended = "# intended\n";
    const concurrent = "# concurrent writer\n";
    await writeFile(fstab, original, { mode: 0o644 });
    await writeFile(replacement, intended, { mode: 0o644 });
    const argumentsFor = async (path: string): Promise<string[]> => {
      const metadata = await stat(path, { bigint: true });
      const content = await readFile(path);
      return [
        metadata.dev.toString(),
        metadata.ino.toString(),
        metadata.size.toString(),
        metadata.mtimeNs.toString(),
        metadata.ctimeNs.toString(),
        (metadata.mode & 0o7777n).toString(),
        metadata.uid.toString(),
        metadata.gid.toString(),
        createHash("sha256").update(content).digest("hex"),
      ];
    };
    const instrumented = FSTAB_EXCHANGE_SCRIPT.replace(
      "except Exception as error:\n    exchange_error = str(error)\n\ntry:\n    displaced",
      'except Exception as error:\n    exchange_error = str(error)\n\nprint("READY", flush=True)\nsys.stdin.readline()\n\ntry:\n    displaced',
    );
    assert.notEqual(instrumented, FSTAB_EXCHANGE_SCRIPT);
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        instrumented,
        replacement,
        fstab,
        ...(await argumentsFor(replacement)),
        ...(await argumentsFor(fstab)),
        ...(await fstabExchangeBoundaryArguments(fstab)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n")) resolve();
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await ready;
    await writeFile(writer, concurrent, { mode: 0o644 });
    await rename(writer, fstab);
    child.stdin.end("\n");
    const [exitCode] = (await once(child, "close")) as [number];

    assert.equal(exitCode, 74, stderr);
    assert.match(stdout, /UNCONFIRMED/);
    assert.equal(await readFile(fstab, "utf8"), concurrent);
    assert.equal(await readFile(replacement, "utf8"), original);
    assert.match(stderr, /original retained at/);
  },
);

test(
  "fstab exchange rejects a mismatched parent commit boundary",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const { root, fstab } = await createFixture(testContext);
    const replacement = join(root, "etc", "fstab.replacement");
    await writeFile(fstab, "# original\n", { mode: 0o644 });
    await writeFile(replacement, "# intended\n", { mode: 0o644 });
    const argumentsFor = async (path: string): Promise<string[]> => {
      const metadata = await stat(path, { bigint: true });
      const content = await readFile(path);
      return [
        metadata.dev.toString(),
        metadata.ino.toString(),
        metadata.size.toString(),
        metadata.mtimeNs.toString(),
        metadata.ctimeNs.toString(),
        (metadata.mode & 0o7777n).toString(),
        metadata.uid.toString(),
        metadata.gid.toString(),
        createHash("sha256").update(content).digest("hex"),
      ];
    };
    const boundary = await fstabExchangeBoundaryArguments(fstab);
    boundary[1] = (BigInt(boundary[1] ?? "0") + 1n).toString();

    const result = await runCommand(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        FSTAB_EXCHANGE_SCRIPT,
        replacement,
        fstab,
        ...(await argumentsFor(replacement)),
        ...(await argumentsFor(fstab)),
        ...boundary,
      ],
      { silent: true, timeoutMs: 10_000 },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /NO_EXCHANGE/);
    assert.match(result.stderr, /parent.*changed|boundary/i);
    assert.equal(await readFile(fstab, "utf8"), "# original\n");
    assert.equal(await readFile(replacement, "utf8"), "# intended\n");
  },
);

test(
  "identity-bound unlink restores a replacement raced at the commit point",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const { root } = await createFixture(testContext);
    const target = join(root, "mnt", "cleanup-target");
    const displaced = join(root, "mnt", "cleanup-target.displaced");
    await writeFile(target, "expected", { mode: 0o600 });
    const expected = await identityArguments(target);
    const instrumented = IDENTITY_BOUND_UNLINK_SCRIPT.replace(
      "quarantine_name = allocate_quarantine()",
      'print("READY", flush=True)\n    sys.stdin.readline()\n    quarantine_name = allocate_quarantine()',
    );
    assert.notEqual(instrumented, IDENTITY_BOUND_UNLINK_SCRIPT);
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        instrumented,
        target,
        ...expected,
        ...(await fstabExchangeBoundaryArguments(target)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n") && !settled) {
          settled = true;
          resolve();
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `identity-bound unlink exited ${String(code)} before READY: ${stdout} ${stderr}`,
          ),
        );
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await ready;
    await rename(target, displaced);
    await writeFile(target, "foreign replacement", { mode: 0o600 });
    child.stdin.end("\n");
    const [exitCode] = (await once(child, "close")) as [number];

    assert.notEqual(exitCode, 0, stderr);
    assert.match(stdout, /RETAINED/);
    assert.equal(await readFile(target, "utf8"), "foreign replacement");
    assert.equal(await readFile(displaced, "utf8"), "expected");
  },
);

test(
  "identity-bound unlink removes only the captured inode",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const { root } = await createFixture(testContext);
    const target = join(root, "mnt", "cleanup-target");
    await writeFile(target, "expected", { mode: 0o600 });

    const result = await runCommand(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        IDENTITY_BOUND_UNLINK_SCRIPT,
        target,
        ...(await identityArguments(target)),
        ...(await fstabExchangeBoundaryArguments(target)),
      ],
      { silent: true, timeoutMs: 10_000 },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "REMOVED");
    await assert.rejects(access(target));
  },
);

test(
  "fstab recovery cleanup retains a raced replacement",
  { skip: process.platform !== "linux" },
  async (testContext) => {
    const { root, fstab } = await createFixture(testContext);
    const replacement = join(root, "etc", "fstab.replacement");
    await writeFile(fstab, "# original\n", { mode: 0o644 });
    await writeFile(replacement, "# intended\n", { mode: 0o644 });
    const instrumented = FSTAB_EXCHANGE_SCRIPT.replace(
      "    quarantine_name = allocate_recovery_quarantine()",
      '    print("CLEANUP_READY", flush=True)\n    sys.stdin.readline()\n    quarantine_name = allocate_recovery_quarantine()',
    );
    assert.notEqual(instrumented, FSTAB_EXCHANGE_SCRIPT);
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        instrumented,
        replacement,
        fstab,
        ...(await fstabSnapshotArguments(replacement)),
        ...(await fstabSnapshotArguments(fstab)),
        ...(await fstabExchangeBoundaryArguments(fstab)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("CLEANUP_READY\n") && !settled) {
          settled = true;
          resolve();
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `fstab helper exited ${String(code)} before cleanup: ${stdout} ${stderr}`,
          ),
        );
      });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await ready;
    const names = await readdir(join(root, "etc"));
    const recoveryName = names.find((name) =>
      name.startsWith(".fstab.maximize-github-runner-space.recovery."),
    );
    assert.ok(recoveryName !== undefined);
    const recovery = join(root, "etc", recoveryName);
    await rename(recovery, `${recovery}.displaced`);
    await writeFile(recovery, "foreign recovery replacement", { mode: 0o600 });
    child.stdin.end("\n");
    const [exitCode] = (await once(child, "close")) as [number];

    assert.notEqual(exitCode, 0, stderr);
    assert.match(stdout, /UNCONFIRMED/);
    assert.equal(
      await readFile(recovery, "utf8"),
      "foreign recovery replacement",
    );
    assert.equal(await readFile(fstab, "utf8"), "# intended\n");
    assert.equal(await readFile(replacement, "utf8"), "# original\n");
  },
);

test("a swapfile changed after discovery is never backed up or deleted", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap bytes");
  const concurrent = "concurrent writer bytes";
  const harness = createHarness(root, fstab, {
    beforeBackupPath: async () => await writeFile(swapfile, concurrent),
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /swapfile.*changed|identity/i);
  assert.equal(await readFile(swapfile, "utf8"), concurrent);
});

test("swap removal uses the commit-time fstab snapshot", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap");
  let injected = false;
  const harness = createHarness(root, fstab, {
    move: async (source, destination) => {
      if (source === swapfile && destination.includes(".previous.")) {
        await rename(source, destination);
        await writeFile(fstab, `# fixture\n${ownedEntry(swapfile)}\n`);
        injected = true;
        return { exitCode: 0 };
      }
      return undefined;
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(injected, true);
  assert.equal(result.status, "removed");
  assert.equal(await readFile(fstab, "utf8"), "# fixture\n");
});

for (const indentation of fstabIndentations) {
  test(`swap removal recognizes a ${indentation.name}-indented owned fstab entry`, async (testContext) => {
    const { root, swapfile, fstab } = await createFixture(testContext);
    await writeFile(swapfile, "original swap");
    await writeFile(
      fstab,
      `# fixture\n${indentation.value}${ownedEntry(swapfile)}\n${indentation.value}${swapfile}.foreign none swap sw 0 0\n`,
    );
    const harness = createHarness(root, fstab);
    const operation = createSwapOperation(
      contextFor("linux"),
      0n,
      root,
      harness.dependencies,
    );

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();

    assert.equal(result.status, "removed");
    assert.equal(
      await readFile(fstab, "utf8"),
      `# fixture\n${indentation.value}${swapfile}.foreign none swap sw 0 0\n`,
    );
    await assert.rejects(access(swapfile));
  });
}

test("swap removal recognizes a CRLF-terminated owned fstab entry", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap");
  const foreignEntry = `${swapfile}.foreign none swap sw 0 0`;
  await writeFile(
    fstab,
    `# fixture\r\n${ownedEntry(swapfile)}\r\n${foreignEntry}\r\n`,
  );
  const harness = createHarness(root, fstab);
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "removed");
  assert.equal(
    await readFile(fstab, "utf8"),
    `# fixture\r\n${foreignEntry}\r\n`,
  );
  await assert.rejects(access(swapfile));
});

test("swap removal does not own an entry preceded by non-field whitespace", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap");
  const unsupportedEntry = `\v${ownedEntry(swapfile)}\n`;
  await writeFile(fstab, `# fixture\n${unsupportedEntry}`);
  const harness = createHarness(root, fstab);
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "removed");
  assert.equal(await readFile(fstab, "utf8"), `# fixture\n${unsupportedEntry}`);
  await assert.rejects(access(swapfile));
});

for (const separator of [
  { name: "vertical-tab", value: "\v" },
  { name: "form-feed", value: "\f" },
  { name: "carriage-return", value: "\r" },
] as const) {
  test(`swap removal retains entries with ${separator.name} field separators`, async (testContext) => {
    const { root, swapfile, fstab } = await createFixture(testContext);
    await writeFile(swapfile, "original swap");
    const fields = [swapfile, "none", "swap", "sw 0 0"];
    const unsupportedEntries = [0, 1, 2].map((separatorIndex) =>
      fields
        .map((field, fieldIndex) =>
          fieldIndex === separatorIndex
            ? `${field}${separator.value}`
            : fieldIndex < fields.length - 1
              ? `${field} `
              : field,
        )
        .join(""),
    );
    const original = `# fixture\n${unsupportedEntries.join("\n")}\n`;
    await writeFile(fstab, original);
    const harness = createHarness(root, fstab);
    const operation = createSwapOperation(
      contextFor("linux"),
      0n,
      root,
      harness.dependencies,
    );

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();

    assert.equal(result.status, "removed");
    assert.equal(await readFile(fstab, "utf8"), original);
    await assert.rejects(access(swapfile));
  });
}

test("swap resize de-duplicates owned fstab entries at commit", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(
    fstab,
    `# fixture\n${ownedEntry(swapfile)}\n${ownedEntry(swapfile)}\n`,
  );
  const harness = createHarness(root, fstab);
  const operation = createSwapOperation(
    contextFor("linux"),
    1024n ** 2n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "removed");
  assert.equal(
    await readFile(fstab, "utf8"),
    `# fixture\n${ownedEntry(swapfile)}\n`,
  );
});

for (const indentation of fstabIndentations) {
  test(`swap resize de-duplicates ${indentation.name}-indented owned fstab entries`, async (testContext) => {
    const { root, swapfile, fstab } = await createFixture(testContext);
    await writeFile(
      fstab,
      `# fixture\n${indentation.value}${ownedEntry(swapfile)}\n${indentation.value}${ownedEntry(swapfile)}\n${indentation.value}${swapfile}.foreign none swap sw 0 0\n`,
    );
    const harness = createHarness(root, fstab);
    const operation = createSwapOperation(
      contextFor("linux"),
      1024n ** 2n,
      root,
      harness.dependencies,
    );

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();

    assert.equal(result.status, "removed");
    assert.equal(
      await readFile(fstab, "utf8"),
      `# fixture\n${indentation.value}${swapfile}.foreign none swap sw 0 0\n${ownedEntry(swapfile)}\n`,
    );
  });
}

test("swap rollback does not report a moved staging path as an identity failure", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  const harness = createHarness(root, fstab, { failSwapon: true });
  const operation = createSwapOperation(
    contextFor("linux"),
    1024n ** 2n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /simulated swapon failure/i);
  assert.doesNotMatch(
    result.detail ?? "",
    /identity is unavailable|rollback cleanup failed/i,
  );
  await assert.rejects(access(swapfile));
});

test("a foreign backup destination is never accepted or deleted", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap");
  const harness = createHarness(root, fstab, {
    move: async (source, destination) => {
      if (source === swapfile && destination.includes(".previous.")) {
        await unlink(source);
        await writeFile(destination, "foreign file");
        return { exitCode: 0 };
      }
      return undefined;
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /identity/);
  const backup = harness.getBackupPath();
  assert.ok(backup !== undefined);
  assert.equal(await readFile(backup, "utf8"), "foreign file");
});

test("final backup cleanup retains a replacement raced after commit", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap");
  let backup: string | undefined;
  let displaced: string | undefined;
  const harness = createHarness(root, fstab, {
    beforeIdentityBoundUnlink: async (path) => {
      if (!path.includes(".previous.") || displaced !== undefined) return;
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        return;
      }
      if (content !== "original swap") return;
      backup = path;
      displaced = `${path}.captured`;
      await rename(path, displaced);
      await writeFile(path, "foreign replacement", { mode: 0o600 });
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /swap removal committed.*backup cleanup/i);
  assert.ok(backup !== undefined && displaced !== undefined);
  assert.equal(await readFile(backup, "utf8"), "foreign replacement");
  assert.equal(await readFile(displaced, "utf8"), "original swap");
});

test("a foreign installed destination is never activated", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  const harness = createHarness(root, fstab, {
    move: async (source, destination) => {
      if (source.includes(".new.") && destination === swapfile) {
        await unlink(source);
        await writeFile(destination, "foreign file");
        return { exitCode: 0 };
      }
      return undefined;
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    1024n ** 2n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /identity/);
  assert.equal(harness.getSwaponCalls(), 0);
  assert.equal(await readFile(swapfile, "utf8"), "foreign file");
});

test("a foreign restore destination is never reported as the original", async (testContext) => {
  const { root, swapfile, fstab } = await createFixture(testContext);
  await writeFile(swapfile, "original swap");
  let backupMoveCompleted = false;
  const harness = createHarness(root, fstab, {
    move: async (source, destination) => {
      if (source === swapfile && destination.includes(".previous.")) {
        await rename(source, destination);
        backupMoveCompleted = true;
        return { exitCode: 5, stderr: "late backup failure" };
      }
      if (backupMoveCompleted && source.includes(".previous.")) {
        await unlink(source);
        await writeFile(destination, "foreign restore");
        return { exitCode: 0 };
      }
      return undefined;
    },
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /identity/);
  assert.equal(await readFile(swapfile, "utf8"), "foreign restore");
});

test("an oversized sparse fstab is rejected before an unbounded read", async (testContext) => {
  const { root, fstab } = await createFixture(testContext);
  const handle = await open(fstab, "r+");
  try {
    await handle.truncate(3 * 1024 ** 3);
  } finally {
    await handle.close();
  }
  const harness = createHarness(root, fstab, {
    grep: async () => 0,
  });
  const operation = createSwapOperation(
    contextFor("linux"),
    0n,
    root,
    harness.dependencies,
  );

  assert.ok(operation.validate);
  await assert.rejects(operation.validate, /exceeded the 1 MiB safety bound/);
});
