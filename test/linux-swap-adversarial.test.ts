import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../src/command.js";
import {
  createSwapOperation,
  LINUX_SWAP_EXECUTABLES,
  type LinuxSwapCommandInvocation,
  type LinuxSwapDependencies,
} from "../src/platforms/linux.js";
import { contextFor } from "./helpers.js";

const success = { exitCode: 0, stdout: "", stderr: "" } as const;

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
  await operation.validate();
  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /exceeded the 1 MiB safety bound/);
});
