import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/command.js";

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
