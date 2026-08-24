import { posix, win32 } from "node:path";
import {
  assertCommandTerminationConfirmed,
  runCommand,
  UnconfirmedCommandTerminationError,
  type CommandOptions,
} from "./command.js";
import type { CommandResult } from "./types.js";

const DIRECTORY_INVENTORY_TIMEOUT_MS = 10_000;
const DIRECTORY_INVENTORY_INPUT_LIMIT_BYTES = 16 * 1024;
const STARTUP_INJECTION_ENVIRONMENT_KEYS = [
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
] as const;

function trustedDirectoryInventoryEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv =
    process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          WINDIR: process.env.WINDIR,
        }
      : {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        };
  for (const key of STARTUP_INJECTION_ENVIRONMENT_KEYS) {
    delete environment[key];
  }
  return environment;
}

const BOUNDED_DIRECTORY_INVENTORY_SOURCE = String.raw`
import { opendir } from "node:fs/promises";
import { posix, win32 } from "node:path";

let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 16384) throw new Error("directory inventory input exceeded 16 KiB");
}
const spec = JSON.parse(input.toString("utf8"));
if (
  typeof spec.parent !== "string" ||
  !["posix", "win32"].includes(spec.pathStyle) ||
  typeof spec.patternSource !== "string" ||
  typeof spec.patternFlags !== "string" ||
  !Number.isSafeInteger(spec.maxInspected) ||
  spec.maxInspected < 1 ||
  spec.maxInspected > 256 ||
  !Number.isSafeInteger(spec.maxSelected) ||
  spec.maxSelected < 1 ||
  spec.maxSelected > 256
) {
  throw new Error("directory inventory input is malformed");
}
if (spec.parent.length > 4096 || spec.patternSource.length > 1024 || spec.patternFlags.length > 16) {
  throw new Error("directory inventory input exceeded its field bounds");
}
const path = spec.pathStyle === "win32" ? win32 : posix;
if (!path.isAbsolute(spec.parent) || path.normalize(spec.parent) !== spec.parent) {
  throw new Error("directory inventory parent is not canonical and absolute");
}
const pattern = new RegExp(spec.patternSource, spec.patternFlags);
const selected = [];
let inspected = 0;
let directory;
try {
  directory = await opendir(spec.parent);
  while (true) {
    const entry = await directory.read();
    if (entry === null) break;
    inspected += 1;
    if (inspected > spec.maxInspected) {
      throw new Error("directory inventory exceeded " + spec.maxInspected + " inspected entries");
    }
    pattern.lastIndex = 0;
    if ((entry.isDirectory() || entry.isSymbolicLink()) && pattern.test(entry.name)) {
      selected.push({
        name: entry.name,
        directory: entry.isDirectory(),
        symbolicLink: entry.isSymbolicLink(),
      });
      if (selected.length > spec.maxSelected) {
        throw new Error("directory inventory exceeded " + spec.maxSelected + " selected entries");
      }
    }
  }
} catch (error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    process.stdout.write(JSON.stringify({ status: "missing", entries: [] }));
    process.exit(0);
  }
  throw error;
} finally {
  await directory?.close().catch(() => undefined);
}
selected.sort((left, right) => left.name.localeCompare(right.name));
process.stdout.write(JSON.stringify({ status: "ok", entries: selected }));
`;

export interface BoundedDirectoryInventoryEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
}

export interface BoundedDirectoryInventoryDependencies {
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
}

export async function listBoundedVersionedDirectoryEntries(
  parent: string,
  pattern: RegExp,
  pathStyle: "posix" | "win32",
  description: string,
  maxSelected = 64,
  dependencies: BoundedDirectoryInventoryDependencies = {},
): Promise<readonly BoundedDirectoryInventoryEntry[]> {
  const path = pathStyle === "win32" ? win32 : posix;
  const normalizedParent = path.normalize(parent);
  if (!path.isAbsolute(normalizedParent) || normalizedParent !== parent) {
    throw new Error(`${description} parent must be canonical and absolute`);
  }
  if (
    !Number.isSafeInteger(maxSelected) ||
    maxSelected < 1 ||
    maxSelected > 256
  ) {
    throw new Error(`${description} has an invalid selected-entry limit`);
  }
  const serialized = JSON.stringify({
    parent: normalizedParent,
    pathStyle,
    patternSource: pattern.source,
    patternFlags: pattern.flags,
    maxInspected: 256,
    maxSelected,
  });
  if (
    Buffer.byteLength(serialized, "utf8") >
    DIRECTORY_INVENTORY_INPUT_LIMIT_BYTES
  ) {
    throw new Error(`${description} input exceeded 16 KiB`);
  }
  const execute = dependencies.runCommand ?? runCommand;
  assertCommandTerminationConfirmed();
  const result = await execute(
    process.execPath,
    ["--input-type=module", "--eval", BOUNDED_DIRECTORY_INVENTORY_SOURCE],
    {
      env: trustedDirectoryInventoryEnvironment(),
      input: serialized,
      silent: true,
      timeoutMs: DIRECTORY_INVENTORY_TIMEOUT_MS,
    },
  );
  if (result.terminationUnconfirmed === true) {
    throw new UnconfirmedCommandTerminationError(
      `${description} helper termination is unconfirmed`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    if (/exceeded 256 inspected entries/.test(detail)) {
      throw new Error(`${description} exceeded 256 inspected entries`);
    }
    if (new RegExp(`exceeded ${maxSelected} selected entries`).test(detail)) {
      throw new Error(`${description} exceeded ${maxSelected} entries`);
    }
    throw new Error(
      detail || `${description} helper exited ${result.exitCode}`,
    );
  }
  if (result.stdoutTruncated === true || result.stderrTruncated === true) {
    throw new Error(`${description} exceeded the safe output bound`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${description} returned malformed JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("status" in parsed) ||
    !("entries" in parsed)
  ) {
    throw new Error(`${description} returned a malformed result`);
  }
  const { status, entries } = parsed as {
    readonly status: unknown;
    readonly entries: unknown;
  };
  if (!Array.isArray(entries) || !["ok", "missing"].includes(String(status))) {
    throw new Error(`${description} returned a malformed result`);
  }
  if (status === "missing") {
    if (entries.length !== 0) {
      throw new Error(`${description} returned an unsafe missing result`);
    }
    return [];
  }
  if (entries.length > maxSelected) {
    throw new Error(`${description} exceeded ${maxSelected} entries`);
  }
  const resultPattern = new RegExp(pattern.source, pattern.flags);
  const observedNames = new Set<string>();
  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { directory?: unknown }).directory !== "boolean" ||
      typeof (entry as { symbolicLink?: unknown }).symbolicLink !== "boolean"
    ) {
      throw new Error(`${description} returned an unsafe entry`);
    }
    const value = entry as BoundedDirectoryInventoryEntry;
    if (
      value.name === "" ||
      value.name === "." ||
      value.name === ".." ||
      value.name.includes("/") ||
      value.name.includes("\\")
    ) {
      throw new Error(`${description} returned an unsafe entry name`);
    }
    resultPattern.lastIndex = 0;
    if (!resultPattern.test(value.name)) {
      throw new Error(
        `${description} returned an entry that does not match the requested pattern`,
      );
    }
    const nameKey =
      pathStyle === "win32" ? value.name.toLowerCase() : value.name;
    if (observedNames.has(nameKey)) {
      throw new Error(`${description} returned a duplicate entry name`);
    }
    observedNames.add(nameKey);
    if (value.directory === value.symbolicLink) {
      throw new Error(
        `${description} returned an entry without exactly one valid entry type`,
      );
    }
    return value;
  });
}
