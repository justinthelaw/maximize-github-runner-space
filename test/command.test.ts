import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assertTrustedUnixExecutable,
  clearCommandTerminationUnconfirmed,
  boundedOutputChunk,
  createElevatedInvocation,
  findCommandPath,
  inspectExecutable,
  runCommand,
  runElevated,
  sameCommandFileIdentity,
  UnconfirmedCommandTerminationError,
} from "../src/command.js";
import { contextFor } from "./helpers.js";

test("elevated Unix commands never resolve sudo through workflow PATH", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/workflow-controlled/bin";
  try {
    const invocation = createElevatedInvocation(
      contextFor("linux"),
      "/usr/bin/systemctl",
      ["stop", "docker.service"],
      1001,
    );
    assert.deepEqual(invocation, {
      executable: "/usr/bin/sudo",
      args: [
        "-n",
        "--",
        "/usr/bin/env",
        "-i",
        "HOME=/home/runner",
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
        "LOGNAME=runner",
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
        "USER=runner",
        "/usr/bin/systemctl",
        "stop",
        "docker.service",
      ],
    });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("elevation fails closed when passwordless sudo is unavailable", () => {
  assert.equal(
    createElevatedInvocation(
      { ...contextFor("macos"), hasPasswordlessSudo: false },
      "/bin/rm",
      ["-f", "/tmp/example"],
      501,
    ),
    undefined,
  );
});

test("elevation rejects writable executables and parent directories", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix trust validation is not applicable on Windows");
    return;
  }
  const root = await mkdtemp("/tmp/maximize-space-elevated-trust-");
  const executable = join(root, "payload");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o777);
    await assert.rejects(
      async () =>
        await runElevated(contextFor("linux"), executable, [], {
          silent: true,
        }),
      /trusted elevated executable|writable parent directory/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unix executable trust returns the protected canonical launch path", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix trust validation is not applicable on Windows");
    return;
  }
  const canonical = await realpath("/bin/sh");
  assert.equal(await assertTrustedUnixExecutable("/bin/sh"), canonical);
});

test("timeouts fail closed after attempting to terminate the process tree", async () => {
  const started = Date.now();
  try {
    await assert.rejects(
      async () =>
        await runCommand(
          process.execPath,
          [
            "-e",
            [
              'const { spawn } = require("node:child_process");',
              'spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "inherit" });',
              "setTimeout(() => {}, 10000);",
            ].join("\n"),
          ],
          { timeoutMs: 100, silent: true },
        ),
      UnconfirmedCommandTerminationError,
    );
    assert.ok(
      Date.now() - started < 5_000,
      "timeout waited indefinitely for a descendant",
    );

    await assert.rejects(
      async () =>
        await runCommand(process.execPath, ["-e", "process.exit(0)"], {
          silent: true,
        }),
      /process tree may still be running/,
    );
  } finally {
    clearCommandTerminationUnconfirmed();
  }
});

test("commands do not inherit the workflow working directory", async (context) => {
  if (process.platform === "win32") {
    context.skip(
      "the Windows trusted working directory is covered on Windows CI",
    );
    return;
  }
  const result = await runCommand("/bin/pwd", [], { silent: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "/");
});

test("missing executable identities never compare as stable", () => {
  assert.equal(sameCommandFileIdentity(undefined, undefined), false);
});

test("executable identity detects an in-place rewrite with restored size and mtime", async () => {
  const root = await mkdtemp("/tmp/maximize-github-runner-space-identity-");
  const executable = join(root, "tool");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const timestamps = await lstat(executable);
    const before = await inspectExecutable(executable);
    assert.notEqual(before, undefined);

    await writeFile(executable, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    await utimes(executable, timestamps.atime, timestamps.mtime);
    const after = await inspectExecutable(executable);

    assert.notEqual(after, undefined);
    assert.notEqual(before?.contentSha256, after?.contentSha256);
    assert.equal(sameCommandFileIdentity(before, after), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("early child exit while writing stdin never raises an unhandled EPIPE", async () => {
  const executable = process.platform === "win32" ? "cmd.exe" : "/bin/false";
  const args = process.platform === "win32" ? ["/c", "exit", "1"] : [];
  const result = await runCommand(executable, args, {
    input: "x".repeat(4 * 1024 * 1024),
    silent: true,
  });
  assert.notEqual(result.exitCode, 0);
});

test("command output capture enforces its byte bound for multibyte UTF-8", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", 'process.stdout.write("€".repeat(800000))'],
    { silent: true },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 2 * 1024 * 1024);
  assert.doesNotMatch(result.stdout, /�/u);
});

test("forwarded child output is capped independently of capture", () => {
  const first = boundedOutputChunk(0, Buffer.alloc(2 * 1024 * 1024, 0x61));
  assert.equal(first.chunk.length, 2 * 1024 * 1024);
  assert.equal(first.truncated, false);
  const overflow = boundedOutputChunk(first.bytes, Buffer.from("overflow"));
  assert.equal(overflow.chunk.length, 0);
  assert.equal(overflow.bytes, 2 * 1024 * 1024);
  assert.equal(overflow.truncated, true);
});

test("PATH resolution ignores directories and non-executable entries", async () => {
  const originalPath = process.env.PATH;
  const root = await mkdtemp("/tmp/maximize-github-runner-space-command-");
  const candidate = join(
    root,
    process.platform === "win32" ? "tool.EXE" : "tool",
  );
  try {
    await mkdir(candidate);
    process.env.PATH = root;
    assert.equal(await findCommandPath("tool"), undefined);
    await rm(candidate, { recursive: true, force: true });
    if (process.platform !== "win32") {
      await writeFile(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      assert.equal(await findCommandPath("tool"), undefined);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
