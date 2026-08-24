import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CommandResult, RuntimeContext } from "./types.js";

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly silent?: boolean;
}

interface CommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
export const TRUSTED_UNIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const UNIX_ENV_EXECUTABLE = "/usr/bin/env";
export const UNIX_SUDO_EXECUTABLE = "/usr/bin/sudo";
export const WINDOWS_TASKKILL_EXECUTABLE =
  "C:\\Windows\\System32\\taskkill.exe";
export const TRUSTED_WINDOWS_CWD = "C:\\Windows\\System32";

export class UnconfirmedCommandTerminationError extends Error {
  override readonly name = "UnconfirmedCommandTerminationError";
}

let unconfirmedTerminationDetail: string | undefined;

export function boundedOutputChunk(
  currentBytes: number,
  chunk: Buffer,
  maximumBytes = MAX_COMMAND_OUTPUT_BYTES,
): {
  readonly chunk: Buffer;
  readonly bytes: number;
  readonly truncated: boolean;
} {
  const remaining = maximumBytes - currentBytes;
  if (remaining <= 0) {
    return {
      chunk: Buffer.alloc(0),
      bytes: currentBytes,
      truncated: chunk.length > 0,
    };
  }
  const accepted = Math.min(remaining, chunk.length);
  return {
    chunk: chunk.subarray(0, accepted),
    bytes: currentBytes + accepted,
    truncated: accepted < chunk.length,
  };
}

export function markCommandTerminationUnconfirmed(detail: string): void {
  unconfirmedTerminationDetail ??= detail;
}

export function assertCommandTerminationConfirmed(): void {
  if (unconfirmedTerminationDetail !== undefined) {
    throw new UnconfirmedCommandTerminationError(unconfirmedTerminationDetail);
  }
}

export function clearCommandTerminationUnconfirmed(): void {
  unconfirmedTerminationDetail = undefined;
}

export function trustedUnixCommandEnvironment(
  context: RuntimeContext,
): NodeJS.ProcessEnv {
  return {
    HOME: context.home,
    USER: "runner",
    LOGNAME: "runner",
    PATH: TRUSTED_UNIX_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

export interface CommandFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds?: bigint;
  readonly mode?: bigint;
  readonly userId?: bigint;
  readonly groupId?: bigint;
  readonly contentSha256?: string;
}

export async function inspectExecutable(
  executable: string,
): Promise<CommandFileIdentity | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathBefore = await lstat(executable, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return undefined;
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(executable, flags);
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      pathBefore.dev !== metadata.dev ||
      pathBefore.ino !== metadata.ino
    ) {
      return undefined;
    }
    await access(executable, constants.X_OK);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const [handleAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(executable, { bigint: true }),
    ]);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      metadata.dev !== handleAfter.dev ||
      metadata.ino !== handleAfter.ino ||
      metadata.size !== handleAfter.size ||
      metadata.mtimeNs !== handleAfter.mtimeNs ||
      metadata.ctimeNs !== handleAfter.ctimeNs ||
      metadata.dev !== pathAfter.dev ||
      metadata.ino !== pathAfter.ino ||
      metadata.size !== pathAfter.size ||
      metadata.mtimeNs !== pathAfter.mtimeNs ||
      metadata.ctimeNs !== pathAfter.ctimeNs
    ) {
      return undefined;
    }
    return {
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      modifiedNanoseconds: metadata.mtimeNs,
      changedNanoseconds: metadata.ctimeNs,
      mode: metadata.mode,
      userId: metadata.uid,
      groupId: metadata.gid,
      contentSha256: hash.digest("hex"),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function sameCommandFileIdentity(
  left: CommandFileIdentity | undefined,
  right: CommandFileIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds &&
    left.mode === right.mode &&
    left.userId === right.userId &&
    left.groupId === right.groupId &&
    left.contentSha256 === right.contentSha256
  );
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  assertCommandTerminationConfirmed();
  const result = await new Promise<CommandResult>((resolve) => {
    const child = spawn(executable, [...args], {
      cwd:
        options.cwd ??
        (process.platform === "win32" ? TRUSTED_WINDOWS_CWD : "/"),
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
    let windowsTerminationPending = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutForwardedBytes = 0;
    let stderrForwardedBytes = 0;
    let stdoutForwardTruncated = false;
    let stderrForwardTruncated = false;
    let stdoutFinalized = false;
    let stderrFinalized = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const boundedAppend = (
      decoder: StringDecoder,
      currentBytes: number,
      chunk: Buffer,
    ): {
      readonly value: string;
      readonly bytes: number;
      readonly truncated: boolean;
    } => {
      const bounded = boundedOutputChunk(currentBytes, chunk);
      return {
        value: decoder.write(bounded.chunk),
        bytes: bounded.bytes,
        truncated: bounded.truncated,
      };
    };

    const finalizeCapturedOutput = (): void => {
      if (!stdoutFinalized) {
        const tail = stdoutDecoder.end();
        if (!stdoutTruncated) stdout += tail;
        stdoutFinalized = true;
      }
      if (!stderrFinalized) {
        const tail = stderrDecoder.end();
        if (!stderrTruncated) stderr += tail;
        stderrFinalized = true;
      }
    };

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
    childStdout.on("data", (chunk: Buffer) => {
      if (!options.silent) {
        const forwarded = boundedOutputChunk(stdoutForwardedBytes, chunk);
        stdoutForwardedBytes = forwarded.bytes;
        const notice =
          forwarded.truncated && !stdoutForwardTruncated
            ? Buffer.from("\n[stdout truncated after 2 MiB]\n", "utf8")
            : Buffer.alloc(0);
        stdoutForwardTruncated ||= forwarded.truncated;
        const payload =
          notice.length === 0
            ? forwarded.chunk
            : Buffer.concat([forwarded.chunk, notice]);
        if (payload.length > 0 && !process.stdout.write(payload)) {
          childStdout.pause();
          process.stdout.once("drain", () => {
            if (!childStdout.destroyed) childStdout.resume();
          });
        }
      }
      if (stdoutFinalized || stdoutTruncated) return;
      const capture = boundedAppend(stdoutDecoder, stdoutBytes, chunk);
      stdout += capture.value;
      stdoutBytes = capture.bytes;
      stdoutTruncated ||= capture.truncated;
    });
    childStderr.on("data", (chunk: Buffer) => {
      if (!options.silent) {
        const forwarded = boundedOutputChunk(stderrForwardedBytes, chunk);
        stderrForwardedBytes = forwarded.bytes;
        const notice =
          forwarded.truncated && !stderrForwardTruncated
            ? Buffer.from("\n[stderr truncated after 2 MiB]\n", "utf8")
            : Buffer.alloc(0);
        stderrForwardTruncated ||= forwarded.truncated;
        const payload =
          notice.length === 0
            ? forwarded.chunk
            : Buffer.concat([forwarded.chunk, notice]);
        if (payload.length > 0 && !process.stderr.write(payload)) {
          childStderr.pause();
          process.stderr.once("drain", () => {
            if (!childStderr.destroyed) childStderr.resume();
          });
        }
      }
      if (stderrFinalized || stderrTruncated) return;
      const capture = boundedAppend(stderrDecoder, stderrBytes, chunk);
      stderr += capture.value;
      stderrBytes = capture.bytes;
      stderrTruncated ||= capture.truncated;
    });

    const killUnixTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.kill(signal);
        }
      }
    };
    const killWindowsTree = async (): Promise<void> => {
      if (child.pid === undefined) return;
      windowsTerminationPending = true;
      await new Promise<void>((done) => {
        let finished = false;
        const finish = (detail?: string): void => {
          if (finished) return;
          finished = true;
          clearTimeout(killerTimeout);
          if (detail !== undefined) {
            stderr += `${stderr === "" ? "" : "\n"}${detail}`;
          }
          done();
        };
        const killer = spawn(
          WINDOWS_TASKKILL_EXECUTABLE,
          ["/pid", String(child.pid), "/t", "/f"],
          {
            cwd: TRUSTED_WINDOWS_CWD,
            env: {
              SystemRoot: "C:\\Windows",
              WINDIR: "C:\\Windows",
              PATH: TRUSTED_WINDOWS_CWD,
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
            windowsHide: true,
            stdio: "ignore",
            shell: false,
          },
        );
        const killerTimeout = setTimeout(() => {
          killer.kill();
          finish(
            "taskkill.exe did not finish while terminating a timed-out process tree",
          );
        }, 2_000);
        killerTimeout.unref();
        killer.on("error", (error) =>
          finish(
            `taskkill.exe could not terminate a timed-out process tree: ${error.message}`,
          ),
        );
        killer.on("close", (exitCode) =>
          finish(
            exitCode === 0
              ? undefined
              : `taskkill.exe exited ${exitCode ?? 1} while terminating a timed-out process tree`,
          ),
        );
      });
      windowsTerminationPending = false;
      if (pendingTimedOutResult !== undefined) {
        settle(pendingTimedOutResult);
      }
    };
    const unixProcessGroupExists = (): boolean => {
      if (process.platform === "win32" || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    timeout = setTimeout(() => {
      timedOut = true;
      // A descendant can escape a Unix process group with setsid(), and a
      // Windows launcher can outlive its direct child. Attempt best-effort
      // tree termination, but never authorize later destructive work after a
      // timeout on the basis of an incomplete OS-level observation.
      markCommandTerminationUnconfirmed(
        `${executable} timed out and its process tree may still be running`,
      );
      if (process.platform === "win32") {
        void killWindowsTree();
      } else {
        killUnixTree("SIGTERM");
      }
      forceKill = setTimeout(() => {
        // Kill the group even if the direct child has already exited: a
        // descendant may still hold stdout/stderr and keep `close` pending.
        if (process.platform !== "win32") killUnixTree("SIGKILL");
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
        const terminationUnconfirmed = timedOut;
        // Do not keep the action process alive on inherited pipe handles
        // if the OS cannot terminate a detached descendant tree.
        childStdout.destroy();
        childStderr.destroy();
        child.stdin?.destroy();
        child.unref();
        finalizeCapturedOutput();
        settle({
          exitCode: 124,
          stdout,
          stderr,
          ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(stderrTruncated ? { stderrTruncated: true } : {}),
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
        });
      }, 2_500);
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref();

    child.on("error", (error) => {
      finalizeCapturedOutput();
      settle({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr === "" ? "" : "\n"}${error.message}`,
        ...(timedOut ? { terminationUnconfirmed: true } : {}),
      });
    });
    child.on("close", (exitCode, signal) => {
      finalizeCapturedOutput();
      const result: CommandResult = {
        exitCode: timedOut ? 124 : (exitCode ?? (signal === null ? 1 : 128)),
        stdout,
        stderr,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(stderrTruncated ? { stderrTruncated: true } : {}),
        ...(timedOut ? { terminationUnconfirmed: true } : {}),
      };
      if (
        timedOut &&
        process.platform === "win32" &&
        windowsTerminationPending
      ) {
        pendingTimedOutResult = result;
        return;
      }
      if (timedOut && unixProcessGroupExists()) {
        pendingTimedOutResult = result;
        return;
      }
      settle(result);
    });
  });
  assertCommandTerminationConfirmed();
  return result;
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
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          if (!(await stat(candidate)).isFile()) continue;
        } else if (!metadata.isFile()) {
          continue;
        }
        await access(candidate, constants.X_OK);
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
  environment: NodeJS.ProcessEnv = trustedUnixCommandEnvironment(context),
): CommandInvocation | undefined {
  if (context.platform === "windows" || effectiveUid === 0) {
    return { executable, args };
  }
  if (!context.hasPasswordlessSudo) return undefined;

  // Supported Linux and macOS runner definitions install sudo here. Never
  // resolve this privilege boundary through workflow-controlled PATH entries.
  // Reconstruct the allowlisted environment on the privileged side because
  // sudoers env_reset and PAM are allowed to replace the launcher environment.
  const assignments = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Refusing invalid elevated environment name '${name}'`);
      }
      return `${name}=${value}`;
    });
  return {
    executable: UNIX_SUDO_EXECUTABLE,
    args: [
      "-n",
      "--",
      UNIX_ENV_EXECUTABLE,
      "-i",
      ...assignments,
      executable,
      ...args,
    ],
  };
}

export async function runElevated(
  context: RuntimeContext,
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const environment =
    options.env ??
    (context.platform === "windows"
      ? process.env
      : trustedUnixCommandEnvironment(context));
  const invocation = createElevatedInvocation(
    context,
    executable,
    args,
    undefined,
    environment,
  );
  if (invocation === undefined) {
    return {
      exitCode: 126,
      stdout: "",
      stderr: "passwordless sudo is unavailable",
    };
  }
  return await runCommand(invocation.executable, invocation.args, {
    ...options,
    env: environment,
  });
}
