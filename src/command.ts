import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { CommandResult, RuntimeContext } from "./types.js";

export interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly silent?: boolean;
}

export interface CommandPathDependencies {
  readonly platform?: NodeJS.Platform;
  readonly pathValue?: string;
  readonly pathExtValue?: string;
  readonly stat?: typeof stat;
  readonly access?: typeof access;
}

export interface RunCommandDependencies {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof spawn;
}

export interface CommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const TRUSTED_UNIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const UNIX_SUDO_EXECUTABLE = "/usr/bin/sudo";
export const WINDOWS_TASKKILL_EXECUTABLE =
  "C:\\Windows\\System32\\taskkill.exe";

export function createWindowsTaskkillInvocation(
  pid: number,
  force: boolean,
): CommandInvocation {
  return {
    executable: WINDOWS_TASKKILL_EXECUTABLE,
    args: ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
  };
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
  dependencies: RunCommandDependencies = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const platform = dependencies.platform ?? process.platform;
    const spawnProcess = dependencies.spawn ?? spawn;
    const child = spawnProcess(executable, [...args], {
      env: options.env ?? process.env,
      // A Unix process group lets timeout handling terminate grandchildren
      // that outlive their immediate parent while retaining inherited stdio.
      detached: platform !== "win32",
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let hardBound: NodeJS.Timeout | undefined;
    let pendingTimedOutResult: CommandResult | undefined;
    const maxCaptureLength = 2 * 1024 * 1024;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (hardBound !== undefined) clearTimeout(hardBound);
      resolve({
        ...result,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(stderrTruncated ? { stderrTruncated: true } : {}),
      });
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
      const remaining = maxCaptureLength - stdout.length;
      if (chunk.length <= remaining) stdout += chunk;
      else {
        stdout += chunk.slice(0, Math.max(remaining, 0));
        stdoutTruncated = true;
      }
    });
    childStderr.on("data", (chunk: string) => {
      if (!options.silent) process.stderr.write(chunk);
      const remaining = maxCaptureLength - stderr.length;
      if (chunk.length <= remaining) stderr += chunk;
      else {
        stderr += chunk.slice(0, Math.max(remaining, 0));
        stderrTruncated = true;
      }
    });

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (platform === "win32") {
        const invocation = createWindowsTaskkillInvocation(
          child.pid,
          signal === "SIGKILL",
        );
        const killer = spawnProcess(
          invocation.executable,
          [...invocation.args],
          {
            windowsHide: true,
            stdio: "ignore",
            shell: false,
          },
        );
        // A missing or concurrently replaced taskkill must not surface as an
        // uncaught ChildProcess error. The hard timeout below still bounds the
        // original command when Windows cannot start its process-tree killer.
        killer.on("error", () => undefined);
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
      if (platform === "win32" || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    timeout = setTimeout(() => {
      timedOut = true;
      killTree(platform === "win32" ? "SIGKILL" : "SIGTERM");
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
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref();

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
  dependencies: CommandPathDependencies = {},
): Promise<string | undefined> {
  const platform = dependencies.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const pathEntries = (dependencies.pathValue ?? process.env.PATH ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const extensions =
    platform === "win32"
      ? (
          dependencies.pathExtValue ??
          process.env.PATHEXT ??
          ".EXE;.CMD;.BAT;.COM"
        )
          .split(";")
          .filter(Boolean)
      : [""];
  const allowedExtensions = new Set(
    extensions.map((extension) => extension.toLowerCase()),
  );
  const suppliedExtension = platform === "win32" ? path.extname(name) : "";
  if (
    platform === "win32" &&
    suppliedExtension !== "" &&
    !allowedExtensions.has(suppliedExtension.toLowerCase())
  ) {
    return undefined;
  }
  const candidateExtensions =
    platform === "win32" && suppliedExtension !== "" ? [""] : extensions;
  const inspect = dependencies.stat ?? stat;
  const checkAccess = dependencies.access ?? access;

  for (const pathEntry of pathEntries) {
    for (const extension of candidateExtensions) {
      const candidate = path.join(pathEntry, `${name}${extension}`);
      if (
        platform === "win32" &&
        !allowedExtensions.has(path.extname(candidate).toLowerCase())
      ) {
        continue;
      }
      try {
        const candidateStats = await inspect(candidate);
        if (!candidateStats.isFile()) continue;
        if (platform !== "win32") {
          await checkAccess(candidate, constants.X_OK);
        }
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

export function createElevatedInvocation(
  context: RuntimeContext,
  executable: string,
  args: readonly string[],
  effectiveUid = typeof process.getuid === "function"
    ? process.getuid()
    : undefined,
): CommandInvocation | undefined {
  if (context.platform === "windows" || effectiveUid === 0) {
    return { executable, args };
  }
  if (!context.hasPasswordlessSudo) return undefined;

  // Supported Linux and macOS runner definitions install sudo here. Never
  // resolve this privilege boundary through workflow-controlled PATH entries.
  return {
    executable: UNIX_SUDO_EXECUTABLE,
    args: ["-n", "--", executable, ...args],
  };
}

export async function runElevated(
  context: RuntimeContext,
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const invocation = createElevatedInvocation(context, executable, args);
  if (invocation === undefined) {
    return {
      exitCode: 126,
      stdout: "",
      stderr: "passwordless sudo is unavailable",
    };
  }
  return await runCommand(invocation.executable, invocation.args, options);
}
