import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";

const TIMEOUT_MS = 10_000;
export const WINDOWS_POWERSHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const STARTUP_INJECTION_KEYS = [
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
];

export const PYTHON_SMOKE_SOURCE =
  'import hashlib, json; assert len(hashlib.sha256(json.dumps({"status": "ok"}).encode()).hexdigest()) == 64';

function runtimeEnvironment() {
  const environment = { ...process.env };
  for (const key of STARTUP_INJECTION_KEYS) delete environment[key];
  return environment;
}

export function runRuntime(
  label,
  executable,
  args,
  spawn = spawnSync,
  timeout = TIMEOUT_MS,
) {
  const result = spawn(executable, args, {
    cwd:
      process.platform === "win32"
        ? (process.env.SystemRoot ?? "C:\\Windows")
        : "/",
    env: runtimeEnvironment(),
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      (result.error?.message ?? result.stderr?.trim()) ||
      `${executable} exited ${String(result.status)}`;
    throw new Error(`${label} runtime smoke failed: ${detail}`);
  }
  process.stdout.write(`runtime smoke: ${label} ok\n`);
}

export function runOptional(label, executable, args) {
  if (!existsSync(executable)) {
    process.stdout.write(`runtime smoke: ${label} unavailable (skipped)\n`);
    return;
  }
  runRuntime(label, executable, args);
}

function expectedWhereMiss(stderr) {
  const detail = stderr.trim();
  return (
    detail === "" ||
    /^INFO:\s+Could not find files for the given pattern\(s\)\.?$/i.test(detail)
  );
}

export function windowsCandidates(systemRoot, names, spawn = spawnSync) {
  const where = join(systemRoot, "System32", "where.exe");
  const candidates = [];
  const observed = new Set();
  for (const name of names) {
    const result = spawn(where, [name], {
      cwd: systemRoot,
      env: runtimeEnvironment(),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw new Error(
        `Python runtime discovery failed for ${name}: ${result.error.message}`,
      );
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (
      result.status === 1 &&
      stdout.trim() === "" &&
      expectedWhereMiss(stderr)
    ) {
      continue;
    }
    if (result.status !== 0) {
      throw new Error(
        `Python runtime discovery failed for ${name}: ${stderr.trim() || `where.exe exited ${String(result.status)}`}`,
      );
    }
    const matches = stdout
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    if (matches.length === 0) {
      throw new Error(`where.exe returned no path for ${name}`);
    }
    for (const match of matches) {
      const normalized = win32.normalize(match);
      if (
        match.includes("\0") ||
        !win32.isAbsolute(normalized) ||
        win32.basename(normalized).toLowerCase() !== name.toLowerCase()
      ) {
        throw new Error(`where.exe returned an unsafe path for ${name}`);
      }
      const key = normalized.toLowerCase();
      if (observed.has(key)) continue;
      observed.add(key);
      candidates.push({
        executable: normalized,
        launcherArgs: name.toLowerCase() === "py.exe" ? ["-3"] : [],
      });
      if (candidates.length > 32) {
        throw new Error("Python runtime discovery exceeded 32 candidates");
      }
    }
  }
  return candidates;
}

export function runFirstWorkingPython(candidates, run = runRuntime) {
  if (candidates.length === 0) return false;
  let lastFailure;
  for (const candidate of candidates) {
    try {
      run("Python", candidate.executable, [
        ...candidate.launcherArgs,
        "-I",
        "-S",
        "-c",
        PYTHON_SMOKE_SOURCE,
      ]);
      return true;
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure ?? new Error("Python runtime smoke failed");
}
