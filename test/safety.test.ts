import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCommand } from "../src/command.js";
import {
  assertSameRemovalMount,
  assertSameRemovalFilesystem,
  createFunctionOperation,
  createRemovePathOperation,
  executeOperations,
  prepareOperations,
  removeAnchoredUnixPath,
  removePathTarget,
} from "../src/operations.js";
import {
  createSwapOperation,
  LINUX_SWAP_EXECUTABLES,
  linuxSwapCommandEnvironment,
  type LinuxSwapCommandInvocation,
} from "../src/platforms/linux.js";
import {
  assertSafeDirectoryTarget,
  assertSafeRemovalTarget,
  captureSafeRemovalBoundary,
} from "../src/safety.js";
import { contextFor } from "./helpers.js";

test("Linux targets must be absolute, bounded, and non-protected", () => {
  const context = contextFor("linux");
  assert.equal(
    assertSafeRemovalTarget("/usr/share/dotnet", ["/usr/share"], context),
    "/usr/share/dotnet",
  );
  assert.throws(
    () => assertSafeRemovalTarget("dotnet", ["/usr/share"], context),
    /non-absolute/,
  );
  assert.throws(
    () => assertSafeRemovalTarget("/usr/share/../etc", ["/usr/share"], context),
    /outside/,
  );
  assert.throws(
    () => assertSafeRemovalTarget(context.home, [context.home], context),
    /protected/,
  );
  assert.throws(
    () => assertSafeRemovalTarget("/", ["/"], context),
    /protected/,
  );
});

test("Windows paths are validated with win32 semantics on any test host", () => {
  const context = contextFor("windows");
  assert.equal(
    assertSafeRemovalTarget(
      "C:\\Program Files\\dotnet",
      ["C:\\Program Files"],
      context,
    ),
    "C:\\Program Files\\dotnet",
  );
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        "C:\\Program Files\\dotnet\\..\\..\\Windows",
        ["C:\\Program Files\\dotnet"],
        context,
      ),
    /outside/,
  );
  assert.throws(
    () => assertSafeRemovalTarget("C:\\", ["C:\\"], context),
    /protected/,
  );
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        "C:\\Program Files",
        ["C:\\Program Files"],
        context,
      ),
    /outside/,
  );
  assert.throws(
    () => assertSafeRemovalTarget(context.workspace ?? "", ["C:\\a"], context),
    /protected/,
  );
});

test("a target containing a protected workspace is rejected", () => {
  const context = contextFor("linux");
  assert.throws(
    () =>
      assertSafeRemovalTarget("/home/runner/work", ["/home/runner"], context),
    /protected/,
  );
});

test("the Node executable is protected without blocking sibling tools", () => {
  const context = contextFor("linux");
  const runtimeDirectory = dirname(context.runtimeExecutable);
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        context.runtimeExecutable,
        [runtimeDirectory],
        context,
      ),
    /protected/,
  );
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        runtimeDirectory,
        [dirname(runtimeDirectory)],
        context,
      ),
    /protected/,
  );
  const sibling = join(runtimeDirectory, "unrelated-runner-tool");
  assert.equal(
    assertSafeRemovalTarget(sibling, [runtimeDirectory], context),
    sibling,
  );
});

test("realpath validation blocks intermediate symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-safety-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, join(allowed, "link"));

  const context = {
    ...contextFor("linux"),
    home: "/home/runner",
    temp: join(root, "runner-temp"),
    workspace: undefined,
  };
  const operation = createRemovePathOperation({
    id: "escape",
    component: "vcpkg",
    description: "escape fixture",
    target: join(allowed, "link", "sentinel"),
    allowedParents: [allowed],
    context,
  });
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /redirected ancestor/);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("privileged path fallback rejects a target type changed after local failure", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-fallback-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "payload");
  const outside = join(root, "outside");
  await mkdir(target, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  let elevated = false;

  const result = await removePathTarget(
    target,
    [allowed],
    { ...contextFor("linux"), workspace: undefined },
    {
      remove: async () => {
        await rm(target, { recursive: true, force: true });
        await symlink(outside, target);
        throw Object.assign(new Error("simulated local removal failure"), {
          code: "EACCES",
        });
      },
      elevate: async () => {
        elevated = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /boundary changed|target type changed/);
  assert.equal(elevated, false);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("filesystem removal aborts when an ancestor identity changes immediately before mutation", async () => {
  let reads = 0;
  let removed = false;
  const result = await removePathTarget(
    "/usr/local/share/example",
    ["/usr/local/share"],
    { ...contextFor("linux"), workspace: undefined },
    {
      inspect: async () => ({
        exists: true,
        isLink: false,
        realPath: "/usr/local/share/example",
      }),
      boundary: async () => ({
        targetExists: true,
        entries: [
          {
            path: "/usr/local/share",
            device: 1n,
            inode: BigInt(++reads),
            mode: 0o40755n,
          },
        ],
      }),
      remove: async () => {
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /boundary changed/);
  assert.equal(removed, false);
});

test("Windows removal uses the locked boundary helper instead of raw recursive rm", async () => {
  const target = "C:\\tools\\payload";
  const boundary = {
    targetExists: true,
    entries: [
      {
        path: "C:\\tools",
        device: 1n,
        inode: 10n,
        mode: 0o40755n,
      },
      {
        path: target,
        device: 1n,
        inode: 11n,
        mode: 0o40755n,
      },
    ],
  };
  let exists = true;
  let lockedRemovalCalled = false;
  let rawRemovalCalled = false;
  const dependencies = {
    inspect: async () => ({
      exists,
      isLink: false,
      realPath: target,
    }),
    boundary: async () => boundary,
    windowsLockedRemove: async () => {
      lockedRemovalCalled = true;
      exists = false;
    },
    remove: async () => {
      rawRemovalCalled = true;
      exists = false;
    },
  };

  const result = await removePathTarget(
    target,
    ["C:\\tools"],
    { ...contextFor("windows"), workspace: undefined },
    dependencies,
  );

  assert.equal(result.status, "removed");
  assert.equal(lockedRemovalCalled, true);
  assert.equal(rawRemovalCalled, false);
});

test("Windows locked removal pins its runtimes and ignores workflow command configuration", async () => {
  const target = "C:\\tools\\payload";
  const runtimeExecutable =
    "C:\\hostedtoolcache\\windows\\node\\24.0.0\\x64\\node.exe";
  const powershellExecutable =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const boundary = {
    targetExists: true,
    entries: [
      {
        path: "C:\\tools",
        device: 5n,
        inode: 20n,
        mode: 0o40755n,
      },
      {
        path: target,
        device: 5n,
        inode: 21n,
        mode: 0o40755n,
      },
    ],
  };
  const identities = new Map([
    [
      powershellExecutable.toLowerCase(),
      {
        device: 1n,
        inode: 10n,
        size: 100n,
        modifiedNanoseconds: 200n,
        changedNanoseconds: 300n,
        mode: 0o100755n,
        userId: 0n,
        groupId: 0n,
        contentSha256: "a".repeat(64),
      },
    ],
    [
      runtimeExecutable.toLowerCase(),
      {
        device: 2n,
        inode: 11n,
        size: 101n,
        modifiedNanoseconds: 201n,
        changedNanoseconds: 301n,
        mode: 0o100755n,
        userId: 0n,
        groupId: 0n,
        contentSha256: "b".repeat(64),
      },
    ],
  ]);
  let exists = true;
  let invocation:
    | {
        readonly executable: string;
        readonly args: readonly string[];
        readonly options: {
          readonly cwd?: string;
          readonly env?: NodeJS.ProcessEnv;
          readonly input?: string | Uint8Array;
          readonly timeoutMs?: number;
          readonly silent?: boolean;
        };
      }
    | undefined;
  const dependencies = {
    inspect: async () => ({
      exists,
      isLink: false,
      realPath: target,
    }),
    boundary: async () => boundary,
    hostPlatform: "win32" as NodeJS.Platform,
    currentRuntimeExecutable: runtimeExecutable,
    inspectExecutable: async (executable: string) =>
      identities.get(executable.toLowerCase()),
    commandRunner: async (
      executable: string,
      args: readonly string[],
      options: {
        readonly cwd?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly input?: string | Uint8Array;
        readonly timeoutMs?: number;
        readonly silent?: boolean;
      },
    ) => {
      invocation = { executable, args, options };
      exists = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const context = {
    ...contextFor("windows"),
    workspace: undefined,
    runtimeExecutable,
  };

  const result = await removePathTarget(
    target,
    ["C:\\tools"],
    context,
    dependencies,
  );

  assert.equal(result.status, "removed", result.detail ?? "removal failed");
  assert.ok(invocation);
  assert.equal(invocation.executable, powershellExecutable);
  assert.deepEqual(invocation.args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.ok(invocation.args.join(" ").length < 30_000);
  const helperSource = invocation.args.at(-1) ?? "";
  assert.match(helperSource, /FindFirstFileW/);
  assert.match(helperSource, /FindNextFileW/);
  assert.match(helperSource, /FirstChild/);
  assert.doesNotMatch(helperSource, /EnumerateFileSystemEntries/);
  assert.doesNotMatch(helperSource, /IEnumerable<string> Children/);
  assert.equal(invocation.options.cwd, "C:\\Windows\\System32");
  assert.equal(invocation.options.timeoutMs, 10 * 60_000);
  assert.equal(invocation.options.silent, true);
  const commandEnvironment = invocation.options.env;
  assert.equal(commandEnvironment?.BASH_ENV, undefined);
  assert.equal(commandEnvironment?.NODE_OPTIONS, undefined);
  assert.deepEqual(commandEnvironment, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Windows\\Temp",
    TMP: "C:\\Windows\\Temp",
    NoDefaultCurrentDirectoryInExePath: "1",
  });
  assert.equal(typeof invocation.options.input, "string");
  const serialized = JSON.parse(
    Buffer.from(String(invocation.options.input), "base64").toString("utf8"),
  );
  assert.equal(serialized.target, target);
  assert.equal(serialized.runtimeExecutable, runtimeExecutable);
  assert.equal(serialized.powershellExecutable, powershellExecutable);
  assert.deepEqual(serialized.entries, [
    { path: "C:\\tools", device: "5", inode: "20", mode: "16877" },
    { path: target, device: "5", inode: "21", mode: "16877" },
  ]);
  assert.equal(serialized.runtime.contentSha256, "b".repeat(64));
  assert.equal(serialized.powershell.contentSha256, "a".repeat(64));
});

test("Windows locked removal refuses a host-platform mismatch before mutation", async () => {
  const target = "C:\\tools\\payload";
  const boundary = {
    targetExists: true,
    entries: [
      {
        path: "C:\\tools",
        device: 1n,
        inode: 1n,
        mode: 0o40755n,
      },
      {
        path: target,
        device: 1n,
        inode: 2n,
        mode: 0o40755n,
      },
    ],
  };
  let rawRemovalCalled = false;
  let helperCalled = false;
  const dependencies = {
    inspect: async () => ({
      exists: true,
      isLink: false,
      realPath: target,
    }),
    boundary: async () => boundary,
    hostPlatform: "linux" as NodeJS.Platform,
    currentRuntimeExecutable: "C:\\runner\\node.exe",
    commandRunner: async () => {
      helperCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    remove: async () => {
      rawRemovalCalled = true;
    },
  };

  const result = await removePathTarget(
    target,
    ["C:\\tools"],
    {
      ...contextFor("windows"),
      workspace: undefined,
      runtimeExecutable: "C:\\runner\\node.exe",
    },
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /non-Windows host/);
  assert.equal(helperCalled, false);
  assert.equal(rawRemovalCalled, false);
});

test("Windows locked removal refuses PowerShell identity drift before launch", async () => {
  const target = "C:\\tools\\payload";
  const runtimeExecutable = "C:\\runner\\node.exe";
  const powershellExecutable =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const boundary = {
    targetExists: true,
    entries: [
      {
        path: "C:\\tools",
        device: 1n,
        inode: 1n,
        mode: 0o40755n,
      },
      {
        path: target,
        device: 1n,
        inode: 2n,
        mode: 0o40755n,
      },
    ],
  };
  const identity = {
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
  let powershellReads = 0;
  let helperCalled = false;
  const dependencies = {
    inspect: async () => ({
      exists: true,
      isLink: false,
      realPath: target,
    }),
    boundary: async () => boundary,
    hostPlatform: "win32" as NodeJS.Platform,
    currentRuntimeExecutable: runtimeExecutable,
    inspectExecutable: async (executable: string) => {
      if (executable.toLowerCase() === powershellExecutable.toLowerCase()) {
        powershellReads += 1;
        return {
          ...identity,
          inode: powershellReads === 1 ? 10n : 99n,
        };
      }
      return { ...identity, inode: 11n, contentSha256: "b".repeat(64) };
    },
    commandRunner: async () => {
      helperCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const result = await removePathTarget(
    target,
    ["C:\\tools"],
    {
      ...contextFor("windows"),
      workspace: undefined,
      runtimeExecutable,
    },
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /PowerShell executable changed/);
  assert.equal(helperCalled, false);
});

test("Windows locked removal rejects an oversized boundary before launch", async () => {
  const target = "C:\\tools\\payload";
  const runtimeExecutable = "C:\\runner\\node.exe";
  const identity = {
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
  const boundary = {
    targetExists: true,
    entries: [
      {
        path: `C:\\tools\\${"a".repeat(128 * 1024)}`,
        device: 1n,
        inode: 2n,
        mode: 0o40755n,
      },
      {
        path: target,
        device: 1n,
        inode: 3n,
        mode: 0o40755n,
      },
    ],
  };
  let helperCalled = false;
  const dependencies = {
    inspect: async () => ({
      exists: true,
      isLink: false,
      realPath: target,
    }),
    boundary: async () => boundary,
    hostPlatform: "win32" as NodeJS.Platform,
    currentRuntimeExecutable: runtimeExecutable,
    inspectExecutable: async () => identity,
    commandRunner: async () => {
      helperCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const result = await removePathTarget(
    target,
    ["C:\\tools"],
    {
      ...contextFor("windows"),
      workspace: undefined,
      runtimeExecutable,
    },
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /exceeded 128 KiB/);
  assert.equal(helperCalled, false);
});

test("Windows locked removal rejects a boundary that omits an ancestor", async () => {
  const target = "C:\\tools\\cache\\payload";
  const runtimeExecutable = "C:\\runner\\node.exe";
  const identity = {
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
  const boundary = {
    targetExists: true,
    entries: [
      {
        path: "C:\\tools",
        device: 1n,
        inode: 2n,
        mode: 0o40755n,
      },
      {
        path: target,
        device: 1n,
        inode: 3n,
        mode: 0o40755n,
      },
    ],
  };
  let helperCalled = false;
  const dependencies = {
    inspect: async () => ({
      exists: true,
      isLink: false,
      realPath: target,
    }),
    boundary: async () => boundary,
    hostPlatform: "win32" as NodeJS.Platform,
    currentRuntimeExecutable: runtimeExecutable,
    inspectExecutable: async () => identity,
    commandRunner: async () => {
      helperCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const result = await removePathTarget(
    target,
    ["C:\\tools"],
    {
      ...contextFor("windows"),
      workspace: undefined,
      runtimeExecutable,
    },
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /omits an ancestor/);
  assert.equal(helperCalled, false);
});

test(
  "Windows hosted smoke removes a target through native locked handles",
  { skip: process.platform !== "win32" },
  async (testContext) => {
    const root = await mkdtemp(join(tmpdir(), "maximize-space-windows-lock-"));
    testContext.after(
      async () => await rm(root, { recursive: true, force: true }),
    );
    const target = join(root, "payload");
    let deepTarget = target;
    let segment = 0;
    while (deepTarget.length <= 320) {
      deepTarget = join(deepTarget, `definition-cache-${segment++}`);
    }
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve me");
    await mkdir(deepTarget, { recursive: true });
    await writeFile(join(deepTarget, "owned"), "remove me");
    await symlink(outside, join(target, "outside-junction"), "junction");
    const context = {
      ...contextFor("windows"),
      temp: "C:\\Windows\\Temp",
      workspace: undefined,
      runtimeExecutable: process.execPath,
    };

    const result = await removePathTarget(target, [root], context);

    assert.equal(result.status, "removed", result.detail ?? "removal failed");
    await assert.rejects(async () => await access(target));
    assert.equal(
      await readFile(join(outside, "sentinel"), "utf8"),
      "preserve me",
    );
  },
);

test("anchored Unix removal rejects an ancestor swapped after the final snapshot", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-anchored-race-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const allowed = join(root, "allowed");
  const ancestor = join(allowed, "cache");
  const originalAncestor = join(allowed, "cache-original");
  const target = join(ancestor, "payload");
  const outside = join(root, "outside");
  await mkdir(target, { recursive: true });
  await mkdir(outside);
  await writeFile(join(target, "owned"), "remove me");
  await writeFile(join(outside, "sentinel"), "preserve me");
  const context = { ...contextFor("linux"), workspace: undefined };
  const expected = await captureSafeRemovalBoundary(target, [allowed], context);

  await rename(ancestor, originalAncestor);
  await symlink(outside, ancestor);

  await assert.rejects(
    async () => await removeAnchoredUnixPath(target, expected),
    /boundary changed|redirected ancestor/,
  );
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
  assert.equal(
    await readFile(join(originalAncestor, "payload", "owned"), "utf8"),
    "remove me",
  );
});

test("anchored Unix removal unlinks nested links without traversing them", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-anchored-link-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "payload");
  const outside = join(root, "outside");
  await mkdir(target, { recursive: true });
  await mkdir(outside);
  await writeFile(join(target, "owned"), "remove me");
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, join(target, "redirect"));
  const context = { ...contextFor("linux"), workspace: undefined };
  const expected = await captureSafeRemovalBoundary(target, [allowed], context);

  await removeAnchoredUnixPath(target, expected);

  await assert.rejects(async () => await access(target));
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("anchored Unix removal refuses to cross a mounted filesystem", () => {
  assert.doesNotThrow(() =>
    assertSameRemovalFilesystem(11n, 11n, "/cache/same-filesystem"),
  );
  assert.throws(
    () => assertSameRemovalFilesystem(11n, 12n, "/cache/mounted-volume"),
    /crosses a mounted filesystem.*mounted-volume/,
  );
  assert.doesNotThrow(() =>
    assertSameRemovalMount(11n, 11n, 101n, 101n, "/cache/same-mount"),
  );
  assert.doesNotThrow(() =>
    assertSameRemovalMount(
      11n,
      11n,
      undefined,
      undefined,
      "/cache/device-only-platform",
    ),
  );
  assert.throws(
    () =>
      assertSameRemovalMount(
        11n,
        11n,
        101n,
        202n,
        "/cache/same-device-bind-mount",
      ),
    /crosses a mounted filesystem.*bind-mount/,
  );
  assert.throws(
    () =>
      assertSameRemovalMount(
        11n,
        11n,
        101n,
        undefined,
        "/cache/unverified-mount",
      ),
    /crosses a mounted filesystem.*unverified-mount/,
  );
});

test("privileged fallback rejects a same-type target replacement after local failure", async () => {
  let boundaryReads = 0;
  let elevated = false;
  const result = await removePathTarget(
    "/usr/local/share/example",
    ["/usr/local/share"],
    { ...contextFor("linux"), workspace: undefined },
    {
      inspect: async () => ({
        exists: true,
        isLink: false,
        realPath: "/usr/local/share/example",
      }),
      boundary: async () => {
        boundaryReads += 1;
        return {
          targetExists: true,
          entries: [
            {
              path: "/usr/local/share/example",
              device: 1n,
              inode: boundaryReads <= 2 ? 10n : 20n,
              mode: 0o40755n,
            },
          ],
        };
      },
      remove: async () => {
        throw new Error("simulated local removal failure");
      },
      elevate: async () => {
        elevated = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /changed after local removal/);
  assert.equal(elevated, false);
});

test("privileged Unix fallback uses the anchored Node helper instead of path-based rm", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-anchored-sudo-"));
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "payload");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "owned"), "remove me");
  const context = {
    ...contextFor("linux"),
    workspace: undefined,
    runtimeExecutable: process.execPath,
  };
  let elevatedExecutable = "";
  let elevatedArguments: readonly string[] = [];
  let elevatedInput: string | Uint8Array | undefined;

  const result = await removePathTarget(target, [allowed], context, {
    remove: async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
    elevate: async (_context, executable, args, options) => {
      elevatedExecutable = executable;
      elevatedArguments = args;
      elevatedInput = options?.input;
      return await runCommand(process.execPath, args, {
        ...(options?.input === undefined ? {} : { input: options.input }),
        silent: true,
        timeoutMs: 10_000,
      });
    },
  });

  assert.equal(result.status, "removed", result.detail ?? "removal failed");
  assert.equal(elevatedExecutable, `/proc/${process.pid}/exe`);
  assert.deepEqual(elevatedArguments.slice(0, 2), [
    "--input-type=module",
    "--eval",
  ]);
  assert.match(
    String(elevatedArguments[2]),
    /removeContents = async \([\s\S]*expectedMountId,[\s\S]*displayDirectory/,
  );
  assert.match(String(elevatedArguments[2]), /mnt_id:/);
  assert.match(String(elevatedArguments[2]), /crosses a mounted filesystem/);
  assert.equal(elevatedArguments.includes("/bin/rm"), false);
  assert.equal(typeof elevatedInput, "string");
  assert.equal(JSON.parse(String(elevatedInput)).target, target);
});

test(
  "Linux hosted smoke rejects a same-device bind mount in both removal helpers",
  {
    skip:
      process.platform !== "linux" ||
      process.env.RUN_NATIVE_BIND_MOUNT_TEST !== "1",
  },
  async (testContext) => {
    const root = await mkdtemp(join(tmpdir(), "maximize-space-bind-mount-"));
    const allowed = join(root, "allowed");
    const target = join(allowed, "payload");
    const mounted = join(target, "mounted");
    const outside = join(root, "outside");
    await mkdir(mounted, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve me");
    let mountedActive = false;
    testContext.after(async () => {
      if (mountedActive) {
        const unmounted = spawnSync("/usr/bin/umount", [mounted], {
          encoding: "utf8",
          shell: false,
        });
        assert.equal(
          unmounted.status,
          0,
          unmounted.stderr || "bind unmount failed",
        );
      }
      await rm(root, { force: true, recursive: true });
    });
    const mountedResult = spawnSync(
      "/usr/bin/mount",
      ["--bind", outside, mounted],
      { encoding: "utf8", shell: false },
    );
    assert.equal(
      mountedResult.status,
      0,
      mountedResult.stderr || "bind mount failed",
    );
    mountedActive = true;
    assert.equal((await lstat(outside)).dev, (await lstat(mounted)).dev);
    let elevated = false;
    const result = await removePathTarget(
      target,
      [allowed],
      { ...contextFor("linux"), workspace: undefined },
      {
        elevate: async (_context, _executable, args, options) => {
          elevated = true;
          return await runCommand(process.execPath, args, {
            ...(options?.input === undefined ? {} : { input: options.input }),
            silent: true,
            timeoutMs: 10_000,
          });
        },
      },
    );

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /crosses a mounted filesystem/);
    assert.equal(elevated, true);
    assert.equal(
      await readFile(join(outside, "sentinel"), "utf8"),
      "preserve me",
    );
  },
);

test("complete-plan path validation aborts before an earlier package mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-plan-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, join(allowed, "redirect"));

  let packageRan = false;
  const packageOperation = createFunctionOperation({
    id: "package-before-path",
    component: "vcpkg",
    description: "package mutation fixture",
    phase: "package",
    run: async () => {
      packageRan = true;
      return { status: "removed" };
    },
  });
  const unsafePathOperation = createRemovePathOperation({
    id: "later-unsafe-path",
    component: "vcpkg",
    description: "redirected path fixture",
    target: join(allowed, "redirect", "sentinel"),
    allowedParents: [allowed],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });

  await assert.rejects(
    async () =>
      await executeOperations([packageOperation, unsafePathOperation]),
    /validation failed before mutation.*redirected ancestor/s,
  );
  assert.equal(packageRan, false);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("a package may satisfy a validated residual path by removing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-package-path-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "package-payload");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "payload"), "remove me");
  const context = { ...contextFor("linux"), temp: join(root, "runner-temp") };
  const packageOperation = createFunctionOperation({
    id: "package-removes-payload",
    component: "chrome",
    description: "remove package payload",
    phase: "package",
    run: async () => {
      await rm(target, { force: true, recursive: true });
      return { status: "removed" };
    },
  });
  const residual = createRemovePathOperation({
    id: "package-residual",
    component: "chrome",
    description: "remove package residual",
    target,
    allowedParents: [allowed],
    context,
  });

  const results = await executeOperations([packageOperation, residual]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ["removed", "not-found"],
  );
});

test("a package may remove a residual path and its empty parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-package-parent-"));
  const allowed = join(root, "allowed");
  const packageRoot = join(allowed, "package-root");
  const target = join(packageRoot, "payload");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(target, "remove me");
  const context = { ...contextFor("linux"), temp: join(root, "runner-temp") };
  const packageOperation = createFunctionOperation({
    id: "package-removes-parent",
    component: "chrome",
    description: "remove package and empty parent",
    phase: "package",
    run: async () => {
      await rm(packageRoot, { force: true, recursive: true });
      return { status: "removed" };
    },
  });
  const residual = createRemovePathOperation({
    id: "package-parent-residual",
    component: "chrome",
    description: "remove package child residual",
    target,
    allowedParents: [allowed],
    context,
  });

  const results = await executeOperations([packageOperation, residual]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ["removed", "not-found"],
  );
});

test("a vanished target still rejects a replaced validated ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-vanished-race-"));
  const allowed = join(root, "allowed");
  const displaced = join(root, "displaced");
  const target = join(allowed, "payload");
  await mkdir(allowed);
  await writeFile(target, "remove me");
  const operation = createRemovePathOperation({
    id: "vanished-race",
    component: "chrome",
    description: "vanished target race",
    target,
    allowedParents: [allowed],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });
  assert.ok(operation.validate);
  await operation.validate();
  await rm(target);
  await rename(allowed, displaced);
  await mkdir(allowed);

  const result = await operation.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /boundary changed/);
});

async function createSwapFixture(): Promise<{
  readonly root: string;
  readonly context: ReturnType<typeof contextFor>;
}> {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-swap-"));
  await mkdir(join(root, "mnt"));
  await mkdir(join(root, "etc"));
  await writeFile(join(root, "etc", "fstab"), "# test fixture\n");
  return {
    root,
    context: contextFor("linux"),
  };
}

async function fixturePathTest(args: readonly string[]) {
  const target = args[1];
  assert.ok(target !== undefined);
  try {
    await access(target);
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch {
    return { exitCode: 1, stdout: "", stderr: "" };
  }
}

async function renameFixturePath(args: readonly string[]): Promise<void> {
  const source = args[0];
  const target = args[1];
  assert.ok(source !== undefined && target !== undefined);
  await rename(source, target);
}

async function removeFixturePaths(
  root: string,
  args: readonly string[],
): Promise<void> {
  for (const target of args.filter((arg) => arg.startsWith(root))) {
    await rm(target, { force: true });
  }
}

test("the prepared swap operation validates its exact definition targets", async () => {
  const { context, root } = await createSwapFixture();
  const operation = createSwapOperation(context, 0n, root);
  const prepared = prepareOperations([operation], {
    profile: "custom",
    enabled: new Set(),
    skipped: new Set(),
    swapfileBytes: 0n,
  });

  assert.deepEqual(
    prepared.map(({ id }) => id),
    ["swapfile"],
  );
  assert.notEqual(prepared[0]?.validate, undefined);
  await prepared[0]?.validate?.();
});

test("swap validation rejects a writable transaction parent", async () => {
  const { context, root } = await createSwapFixture();
  await chmod(join(root, "mnt"), 0o777);
  const operation = createSwapOperation(context, 0n, root);
  assert.ok(operation.validate);

  await assert.rejects(operation.validate, /unprotected swap parent.*mnt/i);
});

test("swap execution rejects a parent replaced after plan validation", async () => {
  const { context, root } = await createSwapFixture();
  const mount = join(root, "mnt");
  const displaced = join(root, "mnt-displaced");
  let commands = 0;
  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async () => {
      commands += 1;
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    },
    inspectExecutable: async (executable) => ({
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
      contentSha256: executable,
    }),
  });
  assert.ok(operation.validate);
  await operation.validate();
  await rename(mount, displaced);
  await mkdir(mount);

  await assert.rejects(operation.run, /swap parent.*changed/i);
  assert.equal(commands, 0);
});

test("an impossible swap request fails complete-plan validation before package cleanup", async () => {
  const { context, root } = await createSwapFixture();
  let packageRan = false;
  const packageOperation = createFunctionOperation({
    id: "package-before-impossible-swap",
    component: "large-packages",
    description: "package mutation fixture",
    phase: "package",
    run: async () => {
      packageRan = true;
      return { status: "removed" };
    },
  });
  const swap = createSwapOperation(context, 100n * 1024n ** 4n, root);

  await assert.rejects(
    async () => await executeOperations([packageOperation, swap]),
    /requested swap exceeds.*filesystem capacity/s,
  );
  assert.equal(packageRan, false);
});

test("missing swap utilities fail complete-plan validation before package cleanup", async () => {
  const { context, root } = await createSwapFixture();
  let packageRan = false;
  const packageOperation = createFunctionOperation({
    id: "package-before-missing-swap-utility",
    component: "large-packages",
    description: "package mutation fixture",
    phase: "package",
    run: async () => {
      packageRan = true;
      return { status: "removed" };
    },
  });
  const identity = {
    device: 1n,
    inode: 2n,
    size: 3n,
    modifiedNanoseconds: 4n,
  };
  const swap = createSwapOperation(context, 1024n ** 2n, root, {
    inspectExecutable: async (executable) =>
      executable === LINUX_SWAP_EXECUTABLES.mkswap ? undefined : identity,
  });

  await assert.rejects(
    async () => await executeOperations([packageOperation, swap]),
    /mkswap.*unavailable/s,
  );
  assert.equal(packageRan, false);
});

test("the swap transaction pins every utility and ignores workflow command injection", async () => {
  assert.deepEqual(LINUX_SWAP_EXECUTABLES, {
    chmod: "/usr/bin/chmod",
    chown: "/usr/bin/chown",
    dd: "/usr/bin/dd",
    df: "/usr/bin/df",
    fallocate: "/usr/bin/fallocate",
    grep: "/usr/bin/grep",
    mktemp: "/usr/bin/mktemp",
    mkswap: "/usr/sbin/mkswap",
    mv: "/usr/bin/mv",
    python3: "/usr/bin/python3",
    rm: "/usr/bin/rm",
    swapoff: "/usr/sbin/swapoff",
    swapon: "/usr/sbin/swapon",
    tee: "/usr/bin/tee",
    test: "/usr/bin/test",
    truncate: "/usr/bin/truncate",
  });
  assert.deepEqual(linuxSwapCommandEnvironment(), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });

  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  const calls: LinuxSwapCommandInvocation[] = [];
  const inspected = new Set<string>();
  let active = false;
  const poisonedNames = ["PATH", "BASH_ENV", "ENV", "LD_PRELOAD"] as const;
  const original = new Map(
    poisonedNames.map((name) => [name, process.env[name]]),
  );
  process.env.PATH = "/workflow/untrusted-bin";
  process.env.BASH_ENV = "/workflow/bash-env";
  process.env.ENV = "/workflow/shell-env";
  process.env.LD_PRELOAD = "/workflow/preload.so";

  try {
    const operation = createSwapOperation(context, 1024n ** 2n, root, {
      commandRunner: async (invocation) => {
        calls.push({
          ...invocation,
          args: [...invocation.args],
          options: {
            ...invocation.options,
            env: { ...invocation.options.env },
          },
        });
        const success = { exitCode: 0, stdout: "", stderr: "" };
        if (
          invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
          invocation.args[0] === "--show=NAME"
        ) {
          return { ...success, stdout: active ? `${swapfile}\n` : "" };
        }
        if (
          invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
          invocation.args[0] === swapfile
        ) {
          active = true;
          return success;
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.swapoff) {
          active = false;
          return success;
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.test) {
          return await fixturePathTest(invocation.args);
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.grep) {
          return { ...success, exitCode: 1 };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.df) {
          return { ...success, stdout: "Avail\n1073741824\n" };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.mktemp) {
          const template = invocation.args[0];
          assert.ok(template !== undefined);
          assert.ok(template.endsWith("XXXXXX"));
          const path = `${template.slice(0, -6)}ABC123`;
          await writeFile(path, "");
          return {
            ...success,
            stdout: `${path}\n`,
          };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.fallocate) {
          return { ...success, exitCode: 1, stderr: "unsupported filesystem" };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.mv) {
          await renameFixturePath(invocation.args);
          return success;
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.rm) {
          await removeFixturePaths(root, invocation.args);
          return success;
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.tee) {
          const target = invocation.args[0];
          assert.ok(target !== undefined);
          await writeFile(target, "# partial replacement\n");
          return { ...success, exitCode: 1, stderr: "simulated tee failure" };
        }
        return success;
      },
      inspectExecutable: async (executable) => {
        inspected.add(executable);
        return {
          device: 1n,
          inode: 2n,
          size: 3n,
          modifiedNanoseconds: 4n,
          contentSha256: executable,
        };
      },
    });
    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /simulated tee failure/);
    assert.equal(await readFile(fstab, "utf8"), "# test fixture\n");
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const requiredPinnedUtilities = new Set(
    Object.entries(LINUX_SWAP_EXECUTABLES)
      .filter(([utility]) => utility !== "grep" && utility !== "python3")
      .map(([, executable]) => executable),
  );
  const requiredLegacyInvocations = new Set(
    [...requiredPinnedUtilities].filter(
      (executable) => executable !== LINUX_SWAP_EXECUTABLES.chown,
    ),
  );
  assert.deepEqual(
    new Set(calls.map(({ executable }) => executable)),
    requiredLegacyInvocations,
  );
  assert.deepEqual(inspected, requiredPinnedUtilities);
  for (const invocation of calls) {
    const readOnly =
      invocation.executable === LINUX_SWAP_EXECUTABLES.test ||
      invocation.executable === LINUX_SWAP_EXECUTABLES.grep ||
      invocation.executable === LINUX_SWAP_EXECUTABLES.df ||
      (invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
        invocation.args[0] === "--show=NAME");
    assert.equal(
      invocation.elevated,
      !readOnly,
      `${invocation.executable} ${invocation.args.join(" ")}`,
    );
    assert.equal(invocation.executable.startsWith("/"), true);
    assert.deepEqual(invocation.options.env, linuxSwapCommandEnvironment());
    assert.equal(invocation.options.env.BASH_ENV, undefined);
    assert.equal(invocation.options.env.ENV, undefined);
    assert.equal(invocation.options.env.LD_PRELOAD, undefined);
  }
});

test("swap commits a verified fstab replacement through an atomic rename", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  let active = false;
  let temporaryFiles = 0;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    inspectExecutable: async (executable) => ({
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
      contentSha256: executable,
    }),
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        active = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(args);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        const source = args[0];
        const target = args[1];
        assert.ok(source !== undefined && target !== undefined);
        await rename(source, target);
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(active, true);
  assert.equal(
    await readFile(fstab, "utf8"),
    `# test fixture\n${swapfile} none swap sw 0 0\n`,
  );
});

test("swap never overwrites an unrelated concurrent fstab update", async (testContext) => {
  const { context, root } = await createSwapFixture();
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  const concurrent = "# test fixture\nUUID=data /data ext4 defaults 0 2\n";
  let active = false;
  let temporaryFiles = 0;
  let injected = false;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    inspectExecutable: async (executable) => ({
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
      contentSha256: executable,
    }),
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        active = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(args);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}RACE0${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        return success;
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.chmod &&
        args[0] === `--reference=${fstab}`
      ) {
        await writeFile(fstab, concurrent);
        injected = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        await renameFixturePath(args);
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        await removeFixturePaths(root, args);
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(injected, true);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /fstab.*changed|expected content/i);
  assert.equal(await readFile(fstab, "utf8"), concurrent);
});

test("swap removal commits fstab deletion through an atomic rename", async (testContext) => {
  const { context, root } = await createSwapFixture();
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  const original = `# keep\n${swapfile} none swap sw 0 0\nUUID=root / ext4 defaults 0 1\n`;
  await writeFile(fstab, original);
  let temporaryFiles = 0;
  let staged = false;
  let renamed = false;

  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}RMV00${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        staged = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        const source = args[0];
        const target = args[1];
        assert.ok(source !== undefined && target !== undefined);
        await rename(source, target);
        renamed = true;
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(staged, true);
  assert.equal(renamed, true);
  assert.equal(
    await readFile(fstab, "utf8"),
    "# keep\nUUID=root / ext4 defaults 0 1\n",
  );
});

test("swap removal rejects a successful no-op fstab rename and restores its backing file", async (testContext) => {
  const { context, root } = await createSwapFixture();
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  const originalFstab = `# keep\n${swapfile} none swap sw 0 0\n`;
  const originalSwap = "original swap bytes";
  await writeFile(fstab, originalFstab);
  await writeFile(swapfile, originalSwap);
  let temporaryFiles = 0;
  let noOpRename = false;

  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
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
      if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}NOP00${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        const source = args[0];
        const target = args[1];
        assert.ok(source !== undefined && target !== undefined);
        if (target === fstab) {
          noOpRename = true;
          return success;
        }
        await rename(source, target);
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        for (const target of args.filter((arg) => arg.startsWith(root))) {
          await rm(target, { force: true });
        }
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /committed fstab replacement/);
  assert.equal(noOpRename, true);
  assert.equal(await readFile(fstab, "utf8"), originalFstab);
  assert.equal(await readFile(swapfile, "utf8"), originalSwap);
});

test("swap removal restores fstab when rename reports failure after commit", async (testContext) => {
  const { context, root } = await createSwapFixture();
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  const original = `# keep\n${swapfile} none swap sw 0 0\n`;
  await writeFile(fstab, original);
  let temporaryFiles = 0;
  let fstabMoves = 0;

  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
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
      if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}RMV00${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv && args[1] === fstab) {
        const source = args[0];
        assert.ok(source !== undefined);
        await rename(source, fstab);
        fstabMoves += 1;
        return fstabMoves === 1
          ? { ...success, exitCode: 5, stderr: "rename completed before error" }
          : success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        const target = args.at(-1);
        assert.ok(target !== undefined);
        await rm(target, { force: true });
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /rename completed before error/);
  assert.equal(fstabMoves, 2);
  assert.equal(await readFile(fstab, "utf8"), original);
});

test("a backup rename error after commit never deletes an inactive original swap", async (testContext) => {
  const { context, root } = await createSwapFixture();
  testContext.after(
    async () => await rm(root, { recursive: true, force: true }),
  );
  const swapfile = join(root, "mnt", "swapfile");
  const original = "original inactive swap bytes";
  await writeFile(swapfile, original);
  let temporaryFiles = 0;
  let backupMoveAttempted = false;

  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
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
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}BKP00${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        const source = args[0];
        const target = args[1];
        assert.ok(source !== undefined && target !== undefined);
        await rename(source, target);
        if (source === swapfile && !backupMoveAttempted) {
          backupMoveAttempted = true;
          return {
            ...success,
            exitCode: 5,
            stderr: "backup committed before error",
          };
        }
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        for (const target of args.filter((arg) => arg.startsWith(root))) {
          await rm(target, { force: true });
        }
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /backup committed before error/);
  assert.equal(await readFile(swapfile, "utf8"), original);
});

for (const installFailure of ["success-noop", "rename-nonzero"] as const) {
  test(`swap replacement rejects ${installFailure} before swapon`, async (testContext) => {
    const { context, root } = await createSwapFixture();
    testContext.after(
      async () => await rm(root, { recursive: true, force: true }),
    );
    const swapfile = join(root, "mnt", "swapfile");
    const fstab = join(root, "etc", "fstab");
    const original = "original inactive swap bytes";
    await writeFile(swapfile, original);
    await writeFile(fstab, `${swapfile} none swap sw 0 0\n`);
    let temporaryFiles = 0;
    let installSwaponCalls = 0;

    const operation = createSwapOperation(context, 1024n ** 2n, root, {
      commandRunner: async ({ executable, args }) => {
        const success = { exitCode: 0, stdout: "", stderr: "" };
        if (
          executable === LINUX_SWAP_EXECUTABLES.swapon &&
          args[0] === "--show=NAME"
        ) {
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.swapon) {
          installSwaponCalls += 1;
          return { ...success, exitCode: 5, stderr: "swap path is absent" };
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
        if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
        if (executable === LINUX_SWAP_EXECUTABLES.df) {
          return { ...success, stdout: "Avail\n1073741824\n" };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
          temporaryFiles += 1;
          const template = args[0] ?? "";
          const path = `${template.slice(0, -6)}MOV00${temporaryFiles}`;
          await writeFile(path, "");
          return { ...success, stdout: `${path}\n` };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mv) {
          const source = args[0];
          const target = args[1];
          assert.ok(source !== undefined && target !== undefined);
          if (target === swapfile && source.includes(".new.")) {
            if (installFailure === "success-noop") return success;
            await rename(source, target);
            return {
              ...success,
              exitCode: 5,
              stderr: "replacement rename completed before error",
            };
          }
          await rename(source, target);
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.rm) {
          for (const target of args.filter((arg) => arg.startsWith(root))) {
            await rm(target, { force: true });
          }
        }
        return success;
      },
    });

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(
      result.detail ?? "",
      installFailure === "success-noop"
        ? /without installing the replacement/
        : /replacement rename completed before error/,
    );
    assert.equal(installSwaponCalls, 0);
    assert.equal(await readFile(swapfile, "utf8"), original);
  });
}

test("swap preserves an externally changed fstab after post-rename verification fails", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  let active = false;
  let temporaryFiles = 0;
  let fstabMoves = 0;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    inspectExecutable: async (executable) => ({
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
      contentSha256: executable,
    }),
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        active = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(args);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv && args[1] === fstab) {
        const source = args[0];
        assert.ok(source !== undefined);
        await rename(source, fstab);
        fstabMoves += 1;
        if (fstabMoves === 1)
          await writeFile(fstab, "# corrupted after move\n");
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        await renameFixturePath(args);
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        await removeFixturePaths(root, args);
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /fstab recovery is unconfirmed/);
  assert.equal(fstabMoves, 1);
  assert.equal(active, true);
  assert.equal(await readFile(fstab, "utf8"), "# corrupted after move\n");
});

test("swap restores fstab when mv reports failure after performing the rename", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const fstab = join(root, "etc", "fstab");
  let active = false;
  let temporaryFiles = 0;
  let fstabMoves = 0;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    inspectExecutable: async (executable) => ({
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
      contentSha256: executable,
    }),
    commandRunner: async ({ executable, args, options }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        active = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(args);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) {
        const target = args[0];
        assert.ok(target !== undefined);
        await writeFile(target, options.input ?? "");
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv && args[1] === fstab) {
        const source = args[0];
        assert.ok(source !== undefined);
        await rename(source, fstab);
        fstabMoves += 1;
        return fstabMoves === 1
          ? { ...success, exitCode: 5, stderr: "rename completed before error" }
          : success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        await renameFixturePath(args);
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        await removeFixturePaths(root, args);
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /rename completed before error/);
  assert.equal(fstabMoves, 2);
  assert.equal(active, false);
  assert.equal(await readFile(fstab, "utf8"), "# test fixture\n");
});

for (const restoreFailure of ["staging", "rename", "verification"] as const) {
  test(`swap retains an active replacement when fstab restore ${restoreFailure} is unconfirmed`, async () => {
    const { context, root } = await createSwapFixture();
    const swapfile = join(root, "mnt", "swapfile");
    const fstab = join(root, "etc", "fstab");
    let active = false;
    let temporaryFiles = 0;
    let teeCalls = 0;
    let fstabMoveCalls = 0;
    let replacementRemoved = false;
    const operation = createSwapOperation(context, 1024n ** 2n, root, {
      inspectExecutable: async (executable) => ({
        device: 1n,
        inode: 2n,
        size: 3n,
        modifiedNanoseconds: 4n,
        contentSha256: executable,
      }),
      commandRunner: async ({ executable, args, options }) => {
        const success = { exitCode: 0, stdout: "", stderr: "" };
        if (
          executable === LINUX_SWAP_EXECUTABLES.swapon &&
          args[0] === "--show=NAME"
        ) {
          return { ...success, stdout: active ? `${swapfile}\n` : "" };
        }
        if (
          executable === LINUX_SWAP_EXECUTABLES.swapon &&
          args[0] === swapfile
        ) {
          active = true;
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
          active = false;
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.test) {
          return await fixturePathTest(args);
        }
        if (executable === LINUX_SWAP_EXECUTABLES.grep) {
          return { ...success, exitCode: 1 };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.df) {
          return { ...success, stdout: "Avail\n1073741824\n" };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
          temporaryFiles += 1;
          const template = args[0] ?? "";
          const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
          await writeFile(path, "");
          return { ...success, stdout: `${path}\n` };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.tee) {
          teeCalls += 1;
          if (restoreFailure === "staging" && teeCalls === 2) {
            return {
              ...success,
              exitCode: 6,
              stderr: "restore staging failed",
            };
          }
          const target = args[0];
          assert.ok(target !== undefined);
          await writeFile(target, options.input ?? "");
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mv && args[1] === fstab) {
          fstabMoveCalls += 1;
          if (restoreFailure === "rename" && fstabMoveCalls === 2) {
            return { ...success, exitCode: 7, stderr: "restore rename failed" };
          }
          const source = args[0];
          assert.ok(source !== undefined);
          await rename(source, fstab);
          if (fstabMoveCalls === 1 || restoreFailure === "verification") {
            await writeFile(fstab, `# ${restoreFailure} restore unconfirmed\n`);
          }
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mv) {
          await renameFixturePath(args);
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.rm) {
          if (args.includes(swapfile)) replacementRemoved = true;
          await removeFixturePaths(root, args);
          return success;
        }
        return success;
      },
    });

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(
      result.detail ?? "",
      /fstab.*unconfirmed|backing file retained/i,
    );
    assert.equal(active, true);
    assert.equal(replacementRemoved, false);
    assert.notEqual(await readFile(fstab, "utf8"), "# test fixture\n");
  });
}

for (const cleanupFailure of ["rm-nonzero", "file-remains"] as const) {
  test(`fstab staging reports temporary cleanup failure: ${cleanupFailure}`, async () => {
    const { context, root } = await createSwapFixture();
    const swapfile = join(root, "mnt", "swapfile");
    const fstab = join(root, "etc", "fstab");
    let active = false;
    let temporaryFiles = 0;
    let fstabTemporary: string | undefined;
    const operation = createSwapOperation(context, 1024n ** 2n, root, {
      inspectExecutable: async (executable) => ({
        device: 1n,
        inode: 2n,
        size: 3n,
        modifiedNanoseconds: 4n,
        contentSha256: executable,
      }),
      commandRunner: async ({ executable, args }) => {
        const success = { exitCode: 0, stdout: "", stderr: "" };
        if (
          executable === LINUX_SWAP_EXECUTABLES.swapon &&
          args[0] === "--show=NAME"
        ) {
          return { ...success, stdout: active ? `${swapfile}\n` : "" };
        }
        if (
          executable === LINUX_SWAP_EXECUTABLES.swapon &&
          args[0] === swapfile
        ) {
          active = true;
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
          active = false;
          return success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.test) {
          if (fstabTemporary !== undefined && args[1] === fstabTemporary) {
            return success;
          }
          return await fixturePathTest(args);
        }
        if (executable === LINUX_SWAP_EXECUTABLES.grep) {
          return { ...success, exitCode: 1 };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.df) {
          return { ...success, stdout: "Avail\n1073741824\n" };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
          temporaryFiles += 1;
          const template = args[0] ?? "";
          const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
          await writeFile(path, "");
          if (path.startsWith(`${fstab}.maximize-github-runner-space.`)) {
            fstabTemporary = path;
          }
          return { ...success, stdout: `${path}\n` };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.tee) {
          return { ...success, exitCode: 8, stderr: "fstab staging failed" };
        }
        if (executable === LINUX_SWAP_EXECUTABLES.mv) {
          await renameFixturePath(args);
          return success;
        }
        if (
          executable === LINUX_SWAP_EXECUTABLES.rm &&
          fstabTemporary !== undefined &&
          args.includes(fstabTemporary)
        ) {
          return cleanupFailure === "rm-nonzero"
            ? { ...success, exitCode: 9, stderr: "fstab temp rm failed" }
            : success;
        }
        if (executable === LINUX_SWAP_EXECUTABLES.rm) {
          await removeFixturePaths(root, args);
          return success;
        }
        return success;
      },
    });

    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /temporary fstab cleanup failed/);
    assert.equal(active, false);
    assert.equal(await readFile(fstab, "utf8"), "# test fixture\n");
    if (fstabTemporary !== undefined) {
      await rm(fstabTemporary, { force: true });
    }
  });
}

test("failed atomic fstab staging leaves the live file untouched", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const calls: LinuxSwapCommandInvocation[] = [];
  let swapoffCalls = 0;
  let active = false;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    commandRunner: async (invocation) => {
      calls.push(invocation);
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
        invocation.args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (
        invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
        invocation.args[0] === swapfile
      ) {
        active = true;
        return success;
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(invocation.args);
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = invocation.args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC123`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.mv) {
        await renameFixturePath(invocation.args);
        return success;
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.rm) {
        await removeFixturePaths(root, invocation.args);
        return success;
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.tee) {
        return { ...success, exitCode: 1, stderr: "partial fstab write" };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        swapoffCalls += 1;
        return { ...success, exitCode: 5, stderr: "replacement stayed active" };
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /rollback swapoff failed/);
  assert.equal(swapoffCalls, 1);
  const teeIndex = calls.findIndex(
    ({ executable }) => executable === LINUX_SWAP_EXECUTABLES.tee,
  );
  assert.notEqual(teeIndex, -1);
  assert.equal(
    await readFile(join(root, "etc", "fstab"), "utf8"),
    "# test fixture\n",
  );
});

test("failed swap allocation reports an unremoved replacement file", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  let replacement: string | undefined;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    inspectExecutable: async (executable) => ({
      device: 1n,
      inode: 2n,
      size: 3n,
      modifiedNanoseconds: 4n,
      contentSha256: executable,
    }),
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return {
          ...success,
          exitCode:
            replacement !== undefined && args[1] === replacement ? 0 : 1,
        };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = args[0] ?? "";
        replacement = `${template.slice(0, -6)}LEAK01`;
        return { ...success, stdout: `${replacement}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.fallocate) {
        return { ...success, exitCode: 1, stderr: "fallocate unavailable" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.dd) {
        return { ...success, exitCode: 2, stderr: "allocation failed" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        return { ...success, exitCode: 9, stderr: "replacement rm failed" };
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /allocation failed/);
  assert.match(result.detail ?? "", /temporary file cleanup failed/);
  assert.match(result.detail ?? "", /file remained after removal/);
  assert.notEqual(replacement, undefined);
  assert.notEqual(replacement, swapfile);
});

test("swap refuses an active entry whose backing path is missing", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  let swapoffCalled = false;
  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: `${swapfile}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) swapoffCalled = true;
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /active swapfile path is missing/);
  assert.equal(swapoffCalled, false);
});

test("post-commit swap backup cleanup fails when the stale backup remains", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  await writeFile(
    join(root, "etc", "fstab"),
    `# test fixture\n${swapfile} none swap sw 0 0\n`,
  );
  let temporaryFiles = 0;
  let backupRemovalAttempts = 0;
  let active = false;
  let swapExists = true;
  let replacementPath: string | undefined;
  let replacementExists = false;
  let backupPath: string | undefined;
  let backupExists = false;
  let backupCommitted = false;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        active = true;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        const target = args[1];
        const present =
          target === swapfile
            ? swapExists
            : target === replacementPath
              ? replacementExists
              : target === backupPath
                ? backupExists
                : true;
        return { ...success, exitCode: present ? 0 : 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
        if (path.includes(".new.")) {
          replacementPath = path;
          replacementExists = true;
        } else if (path.includes(".previous.")) {
          backupPath = path;
          backupExists = true;
        }
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        if (args[0] === swapfile && args[1] === backupPath) {
          swapExists = false;
          backupExists = true;
          backupCommitted = true;
        } else if (args[0] === replacementPath && args[1] === swapfile) {
          replacementExists = false;
          swapExists = true;
        }
        return success;
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.rm &&
        backupPath !== undefined &&
        args.includes(backupPath)
      ) {
        if (!backupCommitted) {
          backupExists = false;
          return success;
        }
        backupRemovalAttempts += 1;
        return { ...success, exitCode: 5, stderr: "backup cleanup failed" };
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /replacement active; stale backup remains/);
  assert.equal(backupRemovalAttempts, 2);
});

test("swap removal reports failure when the original active swap cannot be restored", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  let active = true;
  let swapExists = true;
  let backupPath: string | undefined;
  let backupExists = false;
  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        const target = args[1];
        const present =
          target === swapfile
            ? swapExists
            : target === backupPath
              ? backupExists
              : true;
        return { ...success, exitCode: present ? 0 : 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = args[0] ?? "";
        backupPath = `${template.slice(0, -6)}ABC123`;
        backupExists = true;
        return { ...success, stdout: `${backupPath}\n` };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.rm &&
        backupPath !== undefined &&
        args.includes(backupPath)
      ) {
        backupExists = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        return { ...success, exitCode: 5, stderr: "backup move failed" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return success;
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        return { ...success, exitCode: 7, stderr: "reactivation failed" };
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /backup move failed/);
  assert.match(
    result.detail ?? "",
    /rollback swapon failed.*reactivation failed/,
  );
});

test("swap removal restores original activity when swapoff fails after changing state", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  let active = true;
  let reactivations = 0;
  let backupPath: string | undefined;
  let backupExists = false;
  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        const target = args[1];
        const present = target === backupPath ? backupExists : true;
        return { ...success, exitCode: present ? 0 : 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = args[0] ?? "";
        backupPath = `${template.slice(0, -6)}ABC123`;
        backupExists = true;
        return { ...success, stdout: `${backupPath}\n` };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.rm &&
        backupPath !== undefined &&
        args.includes(backupPath)
      ) {
        backupExists = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return { ...success, exitCode: 5, stderr: "late swapoff failure" };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        reactivations += 1;
        active = true;
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /late swapoff failure/);
  assert.equal(active, true);
  assert.equal(reactivations, 1);
});

test("swap replacement never unlinks a replacement activated by a failed swapon", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  let active = false;
  let unlinkedWhileActive = false;
  let rollbackSwapoff = 0;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(args);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC123`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        await renameFixturePath(args);
        return success;
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        active = true;
        return { ...success, exitCode: 5, stderr: "late swapon failure" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        rollbackSwapoff += 1;
        active = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        if (active) unlinkedWhileActive = true;
        await removeFixturePaths(root, args);
        return success;
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /late swapon failure/);
  assert.equal(rollbackSwapoff, 1);
  assert.equal(active, false);
  assert.equal(unlinkedWhileActive, false);
});

test("swap replacement reports failure when backup-move rollback cannot reactivate swap", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  let temporaryFiles = 0;
  let active = true;
  let swapExists = true;
  let replacementPath: string | undefined;
  let replacementExists = false;
  let backupPath: string | undefined;
  let backupExists = false;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: active ? `${swapfile}\n` : "" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        const target = args[1];
        const present =
          target === swapfile
            ? swapExists
            : target === replacementPath
              ? replacementExists
              : target === backupPath
                ? backupExists
                : true;
        return { ...success, exitCode: present ? 0 : 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        temporaryFiles += 1;
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC12${temporaryFiles}`;
        if (path.includes(".new.")) {
          replacementPath = path;
          replacementExists = true;
        } else if (path.includes(".previous.")) {
          backupPath = path;
          backupExists = true;
        }
        return { ...success, stdout: `${path}\n` };
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.rm &&
        backupPath !== undefined &&
        args.includes(backupPath)
      ) {
        backupExists = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv && args[0] === swapfile) {
        return { ...success, exitCode: 5, stderr: "backup move failed" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return success;
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === swapfile
      ) {
        return { ...success, exitCode: 7, stderr: "reactivation failed" };
      }
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /backup move failed/);
  assert.match(
    result.detail ?? "",
    /rollback swapon failed.*reactivation failed/,
  );
});

test("swap revalidates fstab at commit after swap inventory", async () => {
  const { context, root } = await createSwapFixture();
  const fstab = join(root, "etc", "fstab");
  const outside = join(root, "outside-fstab");
  await writeFile(outside, "preserve me\n");
  let mutationCalled = false;
  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        await unlink(fstab);
        await symlink(outside, fstab);
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) mutationCalled = true;
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /symbolic link/);
  assert.equal(mutationCalled, false);
  assert.equal(await readFile(outside, "utf8"), "preserve me\n");
});

test("swap revalidates fstab immediately before tee follows it", async () => {
  const { context, root } = await createSwapFixture();
  const fstab = join(root, "etc", "fstab");
  const outside = join(root, "outside-fstab");
  await writeFile(outside, "preserve me\n");
  let teeCalled = false;
  let active = false;
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    commandRunner: async ({ executable, args }) => {
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] === "--show=NAME"
      ) {
        return {
          ...success,
          stdout: active ? `${join(root, "mnt", "swapfile")}\n` : "",
        };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.test) {
        return await fixturePathTest(args);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.grep) {
        return { ...success, exitCode: 1 };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n1073741824\n" };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = args[0] ?? "";
        const path = `${template.slice(0, -6)}ABC123`;
        await writeFile(path, "");
        return { ...success, stdout: `${path}\n` };
      }
      if (executable === LINUX_SWAP_EXECUTABLES.mv) {
        await renameFixturePath(args);
        return success;
      }
      if (
        executable === LINUX_SWAP_EXECUTABLES.swapon &&
        args[0] !== "--show=NAME"
      ) {
        active = true;
        await unlink(fstab);
        await symlink(outside, fstab);
      }
      if (executable === LINUX_SWAP_EXECUTABLES.swapoff) {
        active = false;
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.rm) {
        await removeFixturePaths(root, args);
        return success;
      }
      if (executable === LINUX_SWAP_EXECUTABLES.tee) teeCalled = true;
      return success;
    },
  });

  assert.ok(operation.validate);
  await operation.validate();
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /symbolic link/);
  assert.equal(teeCalled, false);
  assert.equal(await readFile(outside, "utf8"), "preserve me\n");
});

for (const redirectedTarget of ["swapfile", "fstab"] as const) {
  test(`a final ${redirectedTarget} symlink aborts before package mutation`, async () => {
    const { context, root } = await createSwapFixture();
    const target =
      redirectedTarget === "swapfile"
        ? join(root, "mnt", "swapfile")
        : join(root, "etc", "fstab");
    if (redirectedTarget === "fstab") await unlink(target);
    await symlink(join(root, "outside"), target);

    let packageRan = false;
    const packageOperation = createFunctionOperation({
      id: `package-before-${redirectedTarget}`,
      component: "large-packages",
      description: "package mutation fixture",
      phase: "package",
      run: async () => {
        packageRan = true;
        return { status: "removed" };
      },
    });
    const swap = createSwapOperation(context, 0n, root);

    await assert.rejects(
      async () => await executeOperations([packageOperation, swap]),
      /validation failed before mutation.*symbolic link/s,
    );
    assert.equal(packageRan, false);
  });
}

test("a symlinked allowlist parent cannot redirect deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-parent-link-"));
  const outside = join(root, "outside");
  const parentLink = join(root, "allowed");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, parentLink);

  const operation = createRemovePathOperation({
    id: "parent-escape",
    component: "vcpkg",
    description: "parent escape fixture",
    target: join(parentLink, "sentinel"),
    allowedParents: [parentLink],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /redirected ancestor/);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("a final symlink is unlinked without deleting its destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-final-link-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  const finalLink = join(allowed, "runner-link");
  await symlink(join(outside, "sentinel"), finalLink);

  const operation = createRemovePathOperation({
    id: "final-link",
    component: "vcpkg",
    description: "final link fixture",
    target: finalLink,
    allowedParents: [allowed],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("directory recreation rejects a final symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-recreate-link-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  const target = join(allowed, "toolcache");
  await symlink(outside, target);

  await assert.rejects(
    async () =>
      await assertSafeDirectoryTarget(target, [allowed], {
        ...contextFor("linux"),
        temp: join(root, "runner-temp"),
      }),
    /non-directory target/,
  );
});
