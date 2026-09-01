import assert from "node:assert/strict";
import test from "node:test";
import { createElevatedInvocation, runCommand } from "../src/command.js";
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
