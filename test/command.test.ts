import assert from "node:assert/strict";
import type { PathLike, Stats } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import {
  createElevatedInvocation,
  findCommandPath,
  runCommand,
} from "../src/command.js";
import { contextFor } from "./helpers.js";

test("findCommandPath skips an earlier non-executable shadow", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix executable permissions");
    return;
  }
  const first = await mkdtemp(join(tmpdir(), "command-shadow-"));
  const second = await mkdtemp(join(tmpdir(), "command-valid-"));
  await writeFile(join(first, "tool"), "not executable", { mode: 0o644 });
  await writeFile(join(second, "tool"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  assert.equal(
    await findCommandPath("tool", {
      pathValue: `${first}:${second}`,
      platform: "linux",
    }),
    join(second, "tool"),
  );
});

test("findCommandPath skips an earlier directory shadow", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix executable permissions");
    return;
  }
  const first = await mkdtemp(join(tmpdir(), "command-directory-"));
  const second = await mkdtemp(join(tmpdir(), "command-valid-"));
  await mkdir(join(first, "tool"));
  await writeFile(join(second, "tool"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  assert.equal(
    await findCommandPath("tool", {
      pathValue: `${first}:${second}`,
      platform: "linux",
    }),
    join(second, "tool"),
  );
});

test("findCommandPath applies Windows PATHEXT to regular-file candidates", async () => {
  const first = "C:\\shadow";
  const second = "C:\\valid";
  const regularFile = { isFile: () => true } as Stats;
  const directory = { isFile: () => false } as Stats;
  const stat = (async (candidate: PathLike): Promise<Stats> => {
    if (candidate === win32.join(first, "tool.eXe")) return directory;
    if (candidate === win32.join(second, "tool.CmD")) return regularFile;
    throw new Error("not found");
  }) as typeof fsStat;

  assert.equal(
    await findCommandPath("tool", {
      platform: "win32",
      pathValue: `${first};${second}`,
      pathExtValue: ".eXe;.CmD",
      stat,
      access: async () => assert.fail("Windows candidates do not use X_OK"),
    }),
    win32.join(second, "tool.CmD"),
  );
});

test("findCommandPath matches an existing Windows suffix case-insensitively and rejects a denied suffix", async () => {
  const directory = "C:\\tools";
  const regularFile = { isFile: () => true } as Stats;
  const stat = (async (): Promise<Stats> =>
    regularFile) as unknown as typeof fsStat;
  const dependencies = {
    platform: "win32" as const,
    pathValue: directory,
    pathExtValue: ".CmD",
    stat,
    access: async () => assert.fail("Windows candidates do not use X_OK"),
  };

  assert.equal(
    await findCommandPath("tool.cMd", dependencies),
    win32.join(directory, "tool.cMd"),
  );
  assert.equal(await findCommandPath("tool.BaT", dependencies), undefined);
});

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
      args: ["-n", "--", "/usr/bin/systemctl", "stop", "docker.service"],
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

test("timeouts terminate a Unix descendant process tree", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix process-group semantics");
    return;
  }
  const started = Date.now();
  const result = await runCommand("/bin/sh", ["-c", "sleep 10 & wait"], {
    timeoutMs: 100,
    silent: true,
  });
  assert.equal(result.exitCode, 124);
  assert.ok(Date.now() - started < 3_000, "timeout waited for a descendant");
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

test("runCommand reports bounded stdout truncation", async () => {
  const emittedLength = 3 * 1024 * 1024;
  const result = await runCommand(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(${emittedLength}))`],
    { silent: true },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout.length, 2 * 1024 * 1024);
});
