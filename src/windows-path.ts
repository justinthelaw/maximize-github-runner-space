import { runCommand, type CommandOptions } from "./command.js";
import type { CommandResult } from "./types.js";

export const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;

export type WindowsFileAttributeRunner = (
  executable: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

export interface WindowsPathStatsLike {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size?: bigint | number;
  readonly mtimeNs?: bigint | number;
  readonly fileAttributes?: number;
  isDirectory?(): boolean;
  isFile?(): boolean;
  isSymbolicLink(): boolean;
}

export interface InitialWindowsPathObservation<
  Stats extends WindowsPathStatsLike,
> {
  readonly path: string;
  readonly stats: Stats;
}

export interface StableWindowsPathObservation<
  Stats extends WindowsPathStatsLike,
> extends InitialWindowsPathObservation<Stats> {
  readonly fileAttributes: number;
}

export type WindowsPathIdentityComparator<Stats extends WindowsPathStatsLike> =
  (path: string, before: Stats, after: Stats) => boolean;

const TRUSTED_WINDOWS_POWERSHELL =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_FILE_ATTRIBUTE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$encoded = [Console]::In.ReadToEnd()",
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
  "$paths = @($json | ConvertFrom-Json)",
  "$attributes = @()",
  "foreach ($path in $paths) {",
  "  $attributes += [int64][System.IO.File]::GetAttributes([string]$path)",
  "}",
  "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($attributes)))",
].join("\n");
const WINDOWS_FILE_ATTRIBUTE_COMMAND = Buffer.from(
  WINDOWS_FILE_ATTRIBUTE_SCRIPT,
  "utf16le",
).toString("base64");

/**
 * Read Windows file attributes without allowing a target path to become code
 * or a command-line option. The executable and script are fixed; paths travel
 * only as JSON data on the child's standard input.
 */
export async function readWindowsFileAttributes(
  paths: readonly string[],
  execute: WindowsFileAttributeRunner = runCommand,
): Promise<readonly number[]> {
  if (paths.length === 0) return [];

  const result = await execute(
    TRUSTED_WINDOWS_POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_FILE_ATTRIBUTE_COMMAND,
    ],
    {
      input: Buffer.from(JSON.stringify(paths), "utf8").toString("base64"),
      silent: true,
      timeoutMs: 30_000,
    },
  );
  if (
    result.exitCode !== 0 ||
    result.stdoutTruncated === true ||
    result.stderrTruncated === true
  ) {
    throw new Error("Unable to read complete Windows file attributes safely.");
  }

  // Windows PowerShell 5.1 can emit bounded startup progress records as
  // CLIXML on stderr even when an encoded command succeeds. Stderr is not the
  // result channel: script failures are terminating, while the stdout payload
  // below must still be a complete, exact attribute array. Truncated stderr
  // remains fatal because its classification would be incomplete.

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Windows file attribute probe returned malformed output.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== paths.length ||
    parsed.some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new Error("Windows file attribute probe returned malformed output.");
  }
  return parsed;
}

function windowsPathKind(stats: WindowsPathStatsLike): string {
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory?.() === true) return "directory";
  if (stats.isFile?.() === true) return "file";
  return "other";
}

function sameWindowsPathIdentity(
  _path: string,
  before: WindowsPathStatsLike,
  after: WindowsPathStatsLike,
): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function validateWindowsFileAttributes(
  paths: readonly string[],
  attributes: readonly number[],
): void {
  if (
    attributes.length !== paths.length ||
    Array.from({ length: paths.length }, (_, index) => attributes[index]).some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new Error("Windows file attribute probe returned malformed output.");
  }
}

/**
 * Complete an explicit-attribute observation without combining pre-probe
 * identity with post-probe filesystem state. Native lstat does not expose the
 * reparse bit, so each awaited attribute batch is sandwiched between stable
 * lstat generations and the post-attribute generation is authoritative.
 */
export async function observeStableWindowsPaths<
  Stats extends WindowsPathStatsLike,
>(
  initial: readonly InitialWindowsPathObservation<Stats>[],
  lstatPath: (path: string) => Promise<Stats>,
  readAttributes: (
    paths: readonly string[],
  ) => Promise<readonly number[]> = readWindowsFileAttributes,
  additionalIdentity: WindowsPathIdentityComparator<Stats> = () => true,
): Promise<readonly StableWindowsPathObservation<Stats>[]> {
  if (initial.length === 0) return [];
  const embedded = initial.map(({ stats }) => stats.fileAttributes);
  if (embedded.every((value): value is number => value !== undefined)) {
    validateWindowsFileAttributes(
      initial.map(({ path }) => path),
      embedded,
    );
    return initial.map(({ path, stats }, index) => ({
      path,
      stats,
      fileAttributes: embedded[index] ?? 0,
    }));
  }

  const paths = initial.map(({ path }) => path);
  const attributes = await readAttributes(paths);
  validateWindowsFileAttributes(paths, attributes);
  const stable: StableWindowsPathObservation<Stats>[] = [];
  for (const [index, before] of initial.entries()) {
    let after: Stats;
    try {
      after = await lstatPath(before.path);
    } catch {
      throw new Error(
        `Windows path changed during file attribute inspection: '${before.path}'.`,
      );
    }
    if (
      windowsPathKind(before.stats) !== windowsPathKind(after) ||
      !sameWindowsPathIdentity(before.path, before.stats, after) ||
      !additionalIdentity(before.path, before.stats, after)
    ) {
      throw new Error(
        `Windows path identity or kind changed during file attribute inspection: '${before.path}'.`,
      );
    }
    stable.push({
      path: before.path,
      stats: after,
      fileAttributes: attributes[index] ?? 0,
    });
  }
  return stable;
}

export function isWindowsReparsePoint(fileAttributes: number): boolean {
  return (fileAttributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0;
}
