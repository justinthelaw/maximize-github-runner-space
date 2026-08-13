import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { CommandResult, RuntimeContext } from "./types.js";

export interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly silent?: boolean;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(executable, [...args], {
      env: options.env ?? process.env,
      // A Unix process group lets timeout handling terminate grandchildren
      // that outlive their immediate parent while retaining inherited stdio.
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let hardBound: NodeJS.Timeout | undefined;
    let pendingTimedOutResult: CommandResult | undefined;
    const maxCaptureBytes = 2 * 1024 * 1024;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (hardBound !== undefined) clearTimeout(hardBound);
      resolve(result);
    };

    if (child.stdin !== null) {
      // An executable can exit before consuming input. EPIPE is expected in
      // that case and must not crash the action outside this promise.
      child.stdin.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
          stderr += error.message;
        }
      });
      if (options.input !== undefined) child.stdin.end(options.input);
    }

    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      settle({
        exitCode: 127,
        stdout,
        stderr: `Unable to capture output from ${executable}.`,
      });
      return;
    }
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => {
      if (!options.silent) process.stdout.write(chunk);
      if (stdout.length < maxCaptureBytes) stdout += chunk;
    });
    childStderr.on("data", (chunk: string) => {
      if (!options.silent) process.stderr.write(chunk);
      if (stderr.length < maxCaptureBytes) stderr += chunk;
    });

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill.exe",
          [
            "/pid",
            String(child.pid),
            "/t",
            ...(signal === "SIGKILL" ? ["/f"] : []),
          ],
          { windowsHide: true, stdio: "ignore", shell: false },
        );
        killer.unref();
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.kill(signal);
        }
      }
    };
    const unixProcessGroupExists = (): boolean => {
      if (process.platform === "win32" || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        killTree(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
        forceKill = setTimeout(() => {
          // Kill the group even if the direct child has already exited: a
          // descendant may still hold stdout/stderr and keep `close` pending.
          killTree("SIGKILL");
          const pending = pendingTimedOutResult;
          if (pending !== undefined) {
            // Give pipe close notifications one event-loop turn after SIGKILL.
            setTimeout(() => settle(pending), 50);
          }
        }, 2_000);
        // A process tree that ignores both signals must not consume an
        // unbounded runner allocation. Resolve with the timeout status even if
        // an OS-level pipe close notification never arrives.
        hardBound = setTimeout(() => {
          // Do not keep the action process alive on inherited pipe handles
          // if the OS cannot terminate a detached descendant tree.
          childStdout.destroy();
          childStderr.destroy();
          child.stdin?.destroy();
          child.unref();
          settle({ exitCode: 124, stdout, stderr });
        }, 2_500);
      }, options.timeoutMs);
      timeout.unref();
    }

    child.on("error", (error) => {
      settle({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr === "" ? "" : "\n"}${error.message}`,
      });
    });
    child.on("close", (exitCode, signal) => {
      const result: CommandResult = {
        exitCode: timedOut ? 124 : (exitCode ?? (signal === null ? 1 : 128)),
        stdout,
        stderr,
      };
      if (timedOut && unixProcessGroupExists()) {
        pendingTimedOutResult = result;
        return;
      }
      settle(result);
    });
  });
}

export async function findCommandPath(
  name: string,
): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(pathEntry, `${name}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

export async function commandExists(name: string): Promise<boolean> {
  return (await findCommandPath(name)) !== undefined;
}

export async function runResolvedCommand(
  name: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const executable = await findCommandPath(name);
  if (executable === undefined) {
    return { exitCode: 127, stdout: "", stderr: `${name} was not found` };
  }
  return await runCommand(executable, args, options);
}

export async function runElevated(
  context: RuntimeContext,
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (
    context.platform !== "windows" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0
  ) {
    if (!context.hasPasswordlessSudo) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: "passwordless sudo is unavailable",
      };
    }
    return await runCommand("sudo", ["-n", executable, ...args], options);
  }
  return await runCommand(executable, args, options);
}
