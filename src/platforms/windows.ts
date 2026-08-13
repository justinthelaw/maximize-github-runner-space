import { access, lstat, mkdir, readdir } from "node:fs/promises";
import { win32 } from "node:path";
import { runCommand } from "../command.js";
import { COMPONENTS } from "../components.js";
import {
  createFunctionOperation,
  createRemovePathOperation,
  removePathTarget,
  validateRemovePathTarget,
} from "../operations.js";
import { assertSafeDirectoryTarget } from "../safety.js";
import type {
  Adapter,
  CleanupPlan,
  CommandResult,
  ComponentId,
  Operation,
  OperationResult,
  RuntimeContext,
} from "../types.js";

const SUPPORTED = new Set<ComponentId>(
  COMPONENTS.filter((component) =>
    component.platforms.some((platform) => platform === "windows"),
  ).map((component) => component.id),
);

const SUCCESS_EXIT_CODES = new Set([0, 3010]);
const MSI_SUCCESS_EXIT_CODES = new Set([0, 1605, 1614, 3010]);
const MAX_VERSIONED_CHILDREN = 64;
const VISUAL_STUDIO_OVERLAPS = [
  "android",
  "dotnet",
  "vcpkg",
  "windows-sdk",
] as const satisfies readonly ComponentId[];

export function isMissingWindowsService(result: CommandResult): boolean {
  return result.exitCode === 1060;
}

const POSTGRESQL_SERVICE_NAME = /^postgresql-x64-\d+(?:\.\d+)*$/i;
const POSTGRESQL_SERVICE_PREFIX = /^postgresql/i;
const WINDOWS_SERVICE_INVENTORY_TRUNCATION =
  /\bEnum(?:QueryServicesStatus)?\s*:\s*more data\b|\bresume(?:\s+at)?[\s_-]+index\b|^\s*ri\s*[:=]/im;
const WINDOWS_SERVICE_INVENTORY_BUFFER_BYTES = 256 * 1024;

export const POSTGRESQL_SERVICE_QUERY_ARGUMENTS = Object.freeze([
  "query",
  "type=",
  "service",
  "state=",
  "all",
  "bufsize=",
  String(WINDOWS_SERVICE_INVENTORY_BUFFER_BYTES),
] as const);

export const PINNED_WINDOWS_WEB_SERVICE_NAMES = Object.freeze({
  apache: "Apache",
  nginx: "nginx",
} as const);

export type PostgreSqlServiceInventory =
  | {
      readonly status: "complete";
      readonly serviceNames: readonly string[];
    }
  | {
      readonly status: "unsafe";
      readonly detail: string;
    };

export function classifyPostgreSqlServiceInventory(
  output: string,
): PostgreSqlServiceInventory {
  if (WINDOWS_SERVICE_INVENTORY_TRUNCATION.test(output)) {
    return {
      status: "unsafe",
      detail: "sc.exe returned a truncated service inventory",
    };
  }

  const byCanonicalName = new Map<string, string>();
  let sawServiceRecord = false;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*SERVICE_NAME\s*:\s*(.*?)\s*$/i.exec(line);
    if (match === null) continue;
    sawServiceRecord = true;
    const name = match[1] ?? "";
    if (!POSTGRESQL_SERVICE_PREFIX.test(name)) continue;
    if (!POSTGRESQL_SERVICE_NAME.test(name)) {
      return {
        status: "unsafe",
        detail: "Refusing an unrecognized PostgreSQL-prefixed service name",
      };
    }
    byCanonicalName.set(name.toLowerCase(), name);
  }

  if (!sawServiceRecord) {
    return {
      status: "unsafe",
      detail: "sc.exe returned no parseable service inventory",
    };
  }

  return {
    status: "complete",
    serviceNames: [...byCanonicalName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, name]) => name),
  };
}

export function isStoppedWindowsService(result: CommandResult): boolean {
  return (
    result.exitCode === 0 &&
    /^\s*STATE\s*:\s*1\s+STOPPED\b/im.test(result.stdout)
  );
}

interface WindowsServiceTarget {
  readonly component: ComponentId;
  readonly serviceName: string;
  readonly unregister: boolean;
}

interface WindowsPathStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

export interface WindowsPathProbe {
  lstat(path: string): Promise<WindowsPathStats>;
}

export type WindowsManagedPathProbe = WindowsPathProbe;

interface WindowsPathIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

const NODE_WINDOWS_PATH_PROBE: WindowsPathProbe = {
  lstat: async (path: string) => await lstat(path, { bigint: true }),
};

function windowsPathIdentity(stats: WindowsPathStats): WindowsPathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
  };
}

function sameWindowsPathIdentity(
  left: WindowsPathIdentity | undefined,
  right: WindowsPathIdentity | undefined,
): boolean {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.size === right?.size &&
    left?.mtimeNs === right?.mtimeNs
  );
}

interface WindowsServiceSnapshot extends WindowsServiceTarget {
  readonly status: "present" | "missing";
  readonly state: number;
}

export interface WindowsServiceControl {
  exists(): Promise<boolean>;
  inventory(): Promise<CommandResult>;
  query(serviceName: string): Promise<CommandResult>;
  stop(serviceName: string): Promise<CommandResult>;
  delete(serviceName: string): Promise<CommandResult>;
}
const DEFINITION_POWERSHELL_MODULES = [
  "DockerMsftProvider",
  "MarkdownPS",
  "Pester",
  "PowerShellGet",
  "PSScriptAnalyzer",
  "PSWindowsUpdate",
  "SqlServer",
  "VSSetup",
  "Microsoft.Graph",
  "AWSPowershell",
] as const;

export interface WindowsPaths {
  readonly drive: string;
  readonly systemRoot: string;
  readonly system32: string;
  readonly programFiles: string;
  readonly programFilesX86: string;
  readonly programData: string;
  readonly commonProgramFiles: string;
  readonly defaultUser: string;
  readonly chocolatey: string;
  readonly reg: string;
  readonly msiexec: string;
  readonly serviceControl: string;
  readonly visualStudioInstaller: string;
  readonly vswhere: string;
}

interface MsiProduct {
  readonly productCode: string;
  readonly displayName: string;
}

interface VisualStudioInstance {
  readonly installationPath: string;
  readonly installationVersion?: string;
  readonly productId?: string;
}

type AsyncValue<T> = () => Promise<T>;

function lazyAsync<T>(factory: () => Promise<T>): AsyncValue<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}

function absoluteEnvironmentPath(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || !win32.isAbsolute(value)) return fallback;
  const normalized = win32.normalize(value);
  return normalized.toLowerCase() === win32.normalize(fallback).toLowerCase()
    ? normalized
    : fallback;
}

export function windowsPaths(): WindowsPaths {
  // Every supported standard Windows runner definition uses C: for the OS and
  // image-owned software roots. Never let workflow-controlled HOME/SystemDrive
  // redirect system cleanup to another volume.
  const drive = "C:";
  const systemRoot = absoluteEnvironmentPath(
    "SystemRoot",
    absoluteEnvironmentPath("WINDIR", win32.join(drive, "Windows")),
  );
  const programFiles = absoluteEnvironmentPath(
    "ProgramFiles",
    win32.join(drive, "Program Files"),
  );
  const programFilesX86 = absoluteEnvironmentPath(
    "ProgramFiles(x86)",
    win32.join(drive, "Program Files (x86)"),
  );
  const programData = absoluteEnvironmentPath(
    "ProgramData",
    win32.join(drive, "ProgramData"),
  );
  const commonProgramFiles = absoluteEnvironmentPath(
    "CommonProgramFiles",
    win32.join(programFiles, "Common Files"),
  );
  const chocolateyInstall = absoluteEnvironmentPath(
    "ChocolateyInstall",
    win32.join(programData, "chocolatey"),
  );
  const system32 = win32.join(systemRoot, "System32");
  const visualStudioInstaller = win32.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
  );

  return {
    drive,
    systemRoot,
    system32,
    programFiles,
    programFilesX86,
    programData,
    commonProgramFiles,
    defaultUser: win32.join(drive, "Users", "Default"),
    chocolatey: win32.join(chocolateyInstall, "bin", "choco.exe"),
    reg: win32.join(system32, "reg.exe"),
    msiexec: win32.join(system32, "msiexec.exe"),
    serviceControl: win32.join(system32, "sc.exe"),
    visualStudioInstaller,
    vswhere: win32.join(visualStudioInstaller, "vswhere.exe"),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function failureDetail(
  stderr: string,
  executable: string,
  exitCode: number,
): string {
  return stderr.trim() || `${win32.basename(executable)} exited ${exitCode}`;
}

function windowsServiceControl(paths: WindowsPaths): WindowsServiceControl {
  return {
    exists: async () => await pathExists(paths.serviceControl),
    inventory: async () =>
      await runCommand(
        paths.serviceControl,
        POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
        {
          silent: true,
          timeoutMs: 30_000,
        },
      ),
    query: async (serviceName) =>
      await runCommand(paths.serviceControl, ["query", serviceName], {
        silent: true,
        timeoutMs: 30_000,
      }),
    stop: async (serviceName) =>
      await runCommand(paths.serviceControl, ["stop", serviceName], {
        silent: true,
        timeoutMs: 30_000,
      }),
    delete: async (serviceName) =>
      await runCommand(paths.serviceControl, ["delete", serviceName], {
        silent: true,
        timeoutMs: 30_000,
      }),
  };
}

function selectedFixedWindowsServices(
  plan: CleanupPlan,
): readonly WindowsServiceTarget[] {
  const definitions = [
    {
      component: "docker-engine",
      serviceName: "docker",
      unregister: true,
    },
    {
      component: "apache",
      serviceName: PINNED_WINDOWS_WEB_SERVICE_NAMES.apache,
      unregister: false,
    },
    {
      component: "nginx",
      serviceName: PINNED_WINDOWS_WEB_SERVICE_NAMES.nginx,
      unregister: false,
    },
  ] as const satisfies readonly WindowsServiceTarget[];
  return definitions.filter(({ component }) => plan.enabled.has(component));
}

function windowsServiceFailure(
  paths: WindowsPaths,
  serviceName: string,
  result: CommandResult,
): Error {
  return new Error(
    `${serviceName}: ${failureDetail(
      result.stderr || result.stdout,
      paths.serviceControl,
      result.exitCode,
    )}`,
  );
}

async function discoverWindowsServices(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl,
): Promise<readonly WindowsServiceSnapshot[]> {
  if (!(await control.exists())) throw new Error("sc.exe is unavailable");

  const targets = [...selectedFixedWindowsServices(plan)];
  if (plan.enabled.has("postgresql")) {
    const inventory = await control.inventory();
    if (inventory.exitCode !== 0) {
      throw windowsServiceFailure(paths, "PostgreSQL inventory", inventory);
    }
    const classified = classifyPostgreSqlServiceInventory(
      `${inventory.stdout}\n${inventory.stderr}`,
    );
    if (classified.status === "unsafe") throw new Error(classified.detail);
    targets.push(
      ...classified.serviceNames.map((serviceName) => ({
        component: "postgresql" as const,
        serviceName,
        unregister: false,
      })),
    );
  }

  const snapshots: WindowsServiceSnapshot[] = [];
  for (const target of targets) {
    const result = await control.query(target.serviceName);
    if (isMissingWindowsService(result)) {
      snapshots.push({ ...target, status: "missing", state: 0 });
      continue;
    }
    if (result.exitCode !== 0) {
      throw windowsServiceFailure(paths, target.serviceName, result);
    }
    const stateText = /^\s*STATE\s*:\s*(\d+)\s+[A-Z_]+\b/im.exec(
      result.stdout,
    )?.[1];
    const state = stateText === undefined ? undefined : Number(stateText);
    if (state === undefined || !Number.isSafeInteger(state)) {
      throw new Error(
        `${target.serviceName}: sc.exe returned no service state`,
      );
    }
    snapshots.push({ ...target, status: "present", state });
  }
  return snapshots;
}

function sameWindowsServiceSnapshot(
  left: readonly WindowsServiceSnapshot[],
  right: readonly WindowsServiceSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.component === right[index]?.component &&
        target.serviceName === right[index]?.serviceName &&
        target.unregister === right[index]?.unregister &&
        target.status === right[index]?.status &&
        target.state === right[index]?.state,
    )
  );
}

async function stopWindowsService(
  paths: WindowsPaths,
  target: WindowsServiceSnapshot,
  control: WindowsServiceControl,
): Promise<void> {
  if (target.status === "missing") return;
  if (target.state === 1) return;
  const stop = await control.stop(target.serviceName);
  if (isMissingWindowsService(stop)) return;
  if (stop.exitCode !== 0) {
    throw windowsServiceFailure(paths, target.serviceName, stop);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await control.query(target.serviceName);
    if (isMissingWindowsService(status) || isStoppedWindowsService(status)) {
      return;
    }
    if (status.exitCode !== 0) {
      throw windowsServiceFailure(paths, target.serviceName, status);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${target.serviceName} did not stop within 30 seconds`);
}

export function createWindowsServiceCoordinator(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl = windowsServiceControl(paths),
): Operation | undefined {
  const fixed = selectedFixedWindowsServices(plan);
  if (fixed.length === 0 && !plan.enabled.has("postgresql")) return undefined;
  const component = fixed[0]?.component ?? "postgresql";
  let validated: readonly WindowsServiceSnapshot[] | undefined;
  const validate = async (): Promise<void> => {
    validated = await discoverWindowsServices(paths, plan, control);
  };
  return createFunctionOperation({
    id: "windows:services:stop",
    component,
    description: "Stop selected Windows services before cleanup",
    phase: "preflight",
    dedupeKey: "windows:services:stop",
    fatal: true,
    validate,
    run: async (): Promise<OperationResult> => {
      try {
        validated ??= await discoverWindowsServices(paths, plan, control);
        const immediate = await discoverWindowsServices(paths, plan, control);
        if (!sameWindowsServiceSnapshot(validated, immediate)) {
          return {
            status: "failed",
            detail: "Windows service inventory changed after plan validation",
          };
        }
        for (const target of immediate) {
          await stopWindowsService(paths, target, control);
        }
        const stopped = await discoverWindowsServices(paths, plan, control);
        if (
          stopped.length !== immediate.length ||
          stopped.some(
            (target, index) =>
              target.component !== immediate[index]?.component ||
              target.serviceName !== immediate[index]?.serviceName ||
              target.unregister !== immediate[index]?.unregister ||
              (target.status === "present" && target.state !== 1),
          )
        ) {
          return {
            status: "failed",
            detail:
              "Windows service inventory changed or reactivated after stop",
          };
        }
        for (const target of immediate) {
          if (!target.unregister || target.status === "missing") continue;
          const deleted = await control.delete(target.serviceName);
          if (deleted.exitCode !== 0 && !isMissingWindowsService(deleted)) {
            throw windowsServiceFailure(paths, target.serviceName, deleted);
          }
        }
        return immediate.some(({ status }) => status === "present")
          ? { status: "removed" }
          : { status: "not-found" };
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

function fixedPathOperation(
  context: RuntimeContext,
  component: ComponentId,
  target: string,
  description: string,
  blockedBy?: readonly ComponentId[],
  coveredBy?: readonly ComponentId[],
): Operation {
  return createRemovePathOperation({
    id: `windows:path:${component}:${target}`,
    component,
    description,
    target,
    allowedParents: [win32.dirname(target)],
    context,
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(coveredBy === undefined ? {} : { coveredBy }),
  });
}

function versionedPathOperation(
  context: RuntimeContext,
  component: ComponentId,
  parent: string,
  target: string,
  description: string,
): Operation {
  return createRemovePathOperation({
    id: `windows:path:${component}:${target}`,
    component,
    description,
    target,
    allowedParents: [parent],
    context,
  });
}

function notFoundOperation(
  component: ComponentId,
  id: string,
  description: string,
): Operation {
  return createFunctionOperation({
    id: `windows:not-found:${id}`,
    component,
    description,
    phase: "filesystem",
    run: async () => ({ status: "not-found" }),
  });
}

async function versionedDirectories(
  parent: string,
  pattern: RegExp,
): Promise<readonly string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          pattern.test(entry.name),
      )
      .map((entry) => win32.join(parent, entry.name))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_VERSIONED_CHILDREN);
  } catch (error) {
    if (
      error instanceof Error &&
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return [];
    }
    throw error;
  }
}

async function listChocolateyPackages(
  executable: string,
): Promise<ReadonlySet<string>> {
  if (!(await pathExists(executable))) return new Set();
  const result = await runCommand(
    executable,
    // Chocolatey 2 made `list` local-only and removed --local-only. Hosted
    // Windows images use Chocolatey 2+, so avoid the removed compatibility flag.
    ["list", "--limit-output", "--no-color"],
    { silent: true, timeoutMs: 2 * 60_000 },
  );
  if (result.exitCode !== 0) return new Set();

  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.split("|", 1)[0]?.trim().toLowerCase())
      .filter((name): name is string => name !== undefined && name !== ""),
  );
}

function chocolateyOperation(
  paths: WindowsPaths,
  component: ComponentId,
  packageNames: readonly string[],
  installedPackages: AsyncValue<ReadonlySet<string>>,
  dedupeKey?: string,
): Operation {
  return createFunctionOperation({
    id: `windows:choco:${component}:${packageNames.join(",")}`,
    component,
    description: `Uninstall ${packageNames.join(", ")} with Chocolatey`,
    phase: "package",
    dedupeKey: dedupeKey ?? `windows:choco:${packageNames.join(",")}`,
    run: async (): Promise<OperationResult> => {
      if (!(await pathExists(paths.chocolatey))) return { status: "not-found" };
      const installed = await installedPackages();
      const selected = packageNames.filter((name) =>
        installed.has(name.toLowerCase()),
      );
      if (selected.length === 0) return { status: "not-found" };

      const result = await runCommand(
        paths.chocolatey,
        ["uninstall", ...selected, "--yes", "--no-progress", "--limit-output"],
        { silent: false, timeoutMs: 20 * 60_000 },
      );
      return result.exitCode === 0
        ? { status: "removed", detail: selected.join(", ") }
        : {
            status: "failed",
            detail: failureDetail(
              result.stderr,
              paths.chocolatey,
              result.exitCode,
            ),
          };
    },
  });
}

const UNINSTALL_REGISTRY_ROOTS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const;

function parseMsiProducts(output: string): readonly MsiProduct[] {
  const products: MsiProduct[] = [];
  let currentProductCode: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^HKEY_/i.test(trimmed)) {
      const candidate = win32.basename(trimmed);
      currentProductCode =
        /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(
          candidate,
        )
          ? candidate
          : undefined;
      continue;
    }
    const displayName = /^DisplayName\s+REG_\w+\s+(.+)$/i.exec(trimmed)?.[1];
    if (currentProductCode !== undefined && displayName !== undefined) {
      products.push({
        productCode: currentProductCode,
        displayName: displayName.trim(),
      });
    }
  }
  return products;
}

async function listMsiProducts(
  paths: WindowsPaths,
): Promise<readonly MsiProduct[]> {
  if (!(await pathExists(paths.reg))) return [];
  const byCode = new Map<string, MsiProduct>();
  for (const root of UNINSTALL_REGISTRY_ROOTS) {
    const result = await runCommand(
      paths.reg,
      ["query", root, "/s", "/v", "DisplayName"],
      { silent: true, timeoutMs: 2 * 60_000 },
    );
    // reg.exe returns 1 when a root or value is absent. Other roots can still
    // contain the requested MSI product, so absence is intentionally ignored.
    if (result.exitCode !== 0 && result.stdout.trim() === "") continue;
    for (const product of parseMsiProducts(result.stdout)) {
      byCode.set(product.productCode.toLowerCase(), product);
    }
  }
  return [...byCode.values()];
}

function msiOperation(
  paths: WindowsPaths,
  component: ComponentId,
  displayNamePatterns: readonly RegExp[],
  products: AsyncValue<readonly MsiProduct[]>,
  id: string,
  description: string,
): Operation {
  return createFunctionOperation({
    id: `windows:msi:${component}:${id}`,
    component,
    description,
    phase: "package",
    dedupeKey: `windows:msi:${id}`,
    run: async (): Promise<OperationResult> => {
      if (!(await pathExists(paths.msiexec))) return { status: "not-found" };
      const selected = (await products()).filter((product) =>
        displayNamePatterns.some((pattern) =>
          pattern.test(product.displayName),
        ),
      );
      if (selected.length === 0) return { status: "not-found" };

      for (const product of selected) {
        const result = await runCommand(
          paths.msiexec,
          ["/x", product.productCode, "/qn", "/norestart"],
          { silent: true, timeoutMs: 30 * 60_000 },
        );
        if (!MSI_SUCCESS_EXIT_CODES.has(result.exitCode)) {
          return {
            status: "failed",
            detail: `${product.displayName}: ${failureDetail(
              result.stderr,
              paths.msiexec,
              result.exitCode,
            )}`,
          };
        }
      }
      return {
        status: "removed",
        detail: selected.map((product) => product.displayName).join(", "),
      };
    },
  });
}

export interface WindowsExecutableUninstallCandidate {
  readonly installationRoot: string;
  readonly executable: string;
}

type WindowsExecutableUninstallSnapshot =
  | {
      readonly candidate: WindowsExecutableUninstallCandidate;
      readonly status: "root-absent";
    }
  | {
      readonly candidate: WindowsExecutableUninstallCandidate;
      readonly status: "executable-absent";
      readonly root: WindowsPathIdentity;
    }
  | {
      readonly candidate: WindowsExecutableUninstallCandidate;
      readonly status: "present";
      readonly root: WindowsPathIdentity;
      readonly executable: WindowsPathIdentity;
    };

function sameExecutableUninstallSnapshot(
  left: WindowsExecutableUninstallSnapshot,
  right: WindowsExecutableUninstallSnapshot,
): boolean {
  return (
    win32.normalize(left.candidate.installationRoot).toLowerCase() ===
      win32.normalize(right.candidate.installationRoot).toLowerCase() &&
    win32.normalize(left.candidate.executable).toLowerCase() ===
      win32.normalize(right.candidate.executable).toLowerCase() &&
    left.status === right.status &&
    (left.status === "root-absent" ||
      (right.status !== "root-absent" &&
        sameWindowsPathIdentity(left.root, right.root) &&
        (left.status === "executable-absent" ||
          (right.status === "present" &&
            sameWindowsPathIdentity(left.executable, right.executable)))))
  );
}

function sameExecutableUninstallSnapshots(
  left: readonly WindowsExecutableUninstallSnapshot[],
  right: readonly WindowsExecutableUninstallSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((snapshot, index) => {
      const other = right[index];
      return (
        other !== undefined && sameExecutableUninstallSnapshot(snapshot, other)
      );
    })
  );
}

async function inspectExecutableUninstallCandidate(
  context: RuntimeContext,
  candidate: WindowsExecutableUninstallCandidate,
  probe: WindowsPathProbe,
): Promise<WindowsExecutableUninstallSnapshot> {
  await validateExactTarget(context, candidate.installationRoot);
  await validateRemovePathTarget(
    candidate.executable,
    [candidate.installationRoot],
    context,
  );

  let root: WindowsPathStats;
  try {
    root = await probe.lstat(candidate.installationRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { candidate, status: "root-absent" };
    }
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(
      `Refusing executable uninstaller with an unexpected installation root type: '${candidate.installationRoot}'.`,
    );
  }

  let executable: WindowsPathStats;
  try {
    executable = await probe.lstat(candidate.executable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        candidate,
        status: "executable-absent",
        root: windowsPathIdentity(root),
      };
    }
    throw error;
  }
  if (executable.isSymbolicLink() || !executable.isFile()) {
    throw new Error(
      `Refusing executable uninstaller with an unexpected executable type: '${candidate.executable}'.`,
    );
  }
  return {
    candidate,
    status: "present",
    root: windowsPathIdentity(root),
    executable: windowsPathIdentity(executable),
  };
}

export function executableUninstallOperation(options: {
  readonly context: RuntimeContext;
  readonly component: ComponentId;
  readonly id: string;
  readonly description: string;
  readonly candidates: readonly WindowsExecutableUninstallCandidate[];
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly probe?: WindowsPathProbe;
  readonly execute?: (
    executable: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
}): Operation {
  const probe = options.probe ?? NODE_WINDOWS_PATH_PROBE;
  const execute =
    options.execute ??
    (async (executable: string, args: readonly string[]) =>
      await runCommand(executable, args, {
        silent: true,
        timeoutMs: options.timeoutMs ?? 20 * 60_000,
      }));
  const candidates = [
    ...new Map(
      options.candidates.map((candidate) => [
        `${win32.normalize(candidate.installationRoot).toLowerCase()}\0${win32
          .normalize(candidate.executable)
          .toLowerCase()}`,
        candidate,
      ]),
    ).values(),
  ];
  const inspectAll = async (): Promise<
    readonly WindowsExecutableUninstallSnapshot[]
  > =>
    await Promise.all(
      candidates.map(
        async (candidate) =>
          await inspectExecutableUninstallCandidate(
            options.context,
            candidate,
            probe,
          ),
      ),
    );
  let validated: readonly WindowsExecutableUninstallSnapshot[] | undefined;
  return createFunctionOperation({
    id: `windows:uninstall:${options.component}:${options.id}`,
    component: options.component,
    description: options.description,
    phase: "package",
    dedupeKey: `windows:uninstall:${options.id}`,
    validate: async () => {
      validated = await inspectAll();
    },
    run: async (): Promise<OperationResult> => {
      try {
        validated ??= await inspectAll();
        const immediate = await inspectAll();
        if (!sameExecutableUninstallSnapshots(validated, immediate)) {
          return {
            status: "failed",
            detail: "executable uninstaller changed after plan validation",
          };
        }
        let removed = false;
        for (const snapshot of validated) {
          if (snapshot.status !== "present") continue;
          const beforeSpawn = await inspectExecutableUninstallCandidate(
            options.context,
            snapshot.candidate,
            probe,
          );
          if (!sameExecutableUninstallSnapshot(snapshot, beforeSpawn)) {
            return {
              status: "failed",
              detail: "executable uninstaller changed immediately before spawn",
            };
          }
          const result = await execute(
            snapshot.candidate.executable,
            options.args,
          );
          if (!SUCCESS_EXIT_CODES.has(result.exitCode)) {
            return {
              status: "failed",
              detail: failureDetail(
                result.stderr,
                snapshot.candidate.executable,
                result.exitCode,
              ),
            };
          }
          removed = true;
        }
        return removed ? { status: "removed" } : { status: "not-found" };
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export function isStrictWindowsDescendant(
  candidate: string,
  parent: string,
): boolean {
  const difference = win32.relative(
    win32.resolve(parent),
    win32.resolve(candidate),
  );
  return (
    difference !== "" &&
    !difference.startsWith(`..${win32.sep}`) &&
    difference !== ".." &&
    !win32.isAbsolute(difference)
  );
}

async function listVisualStudioInstances(
  paths: WindowsPaths,
): Promise<readonly VisualStudioInstance[]> {
  const vswhere = (await pathExists(paths.vswhere))
    ? paths.vswhere
    : win32.join(win32.dirname(paths.chocolatey), "vswhere.exe");
  if (!(await pathExists(vswhere))) return [];
  const result = await runCommand(
    vswhere,
    ["-all", "-prerelease", "-products", "*", "-format", "json", "-utf8"],
    { silent: true, timeoutMs: 2 * 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(failureDetail(result.stderr, vswhere, result.exitCode));
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("vswhere returned invalid JSON");
  const roots = [
    win32.join(paths.programFiles, "Microsoft Visual Studio"),
    win32.join(paths.programFilesX86, "Microsoft Visual Studio"),
  ];
  const instances: VisualStudioInstance[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const installationPath = record.installationPath;
    const installationVersion = record.installationVersion;
    const productId = record.productId;
    if (
      typeof installationPath !== "string" ||
      !win32.isAbsolute(installationPath) ||
      !roots.some((root) =>
        isStrictWindowsDescendant(installationPath, root),
      ) ||
      productId !== "Microsoft.VisualStudio.Product.Enterprise" ||
      typeof installationVersion !== "string" ||
      !/^(?:17|18)\./.test(installationVersion)
    ) {
      continue;
    }
    instances.push({
      installationPath: win32.normalize(installationPath),
      ...(typeof installationVersion === "string"
        ? { installationVersion }
        : {}),
      ...(typeof productId === "string" ? { productId } : {}),
    });
  }
  return instances.slice(0, 8);
}

function visualStudioOperation(
  paths: WindowsPaths,
  instances: AsyncValue<readonly VisualStudioInstance[]>,
): Operation {
  return createFunctionOperation({
    id: "windows:visual-studio:uninstall",
    component: "visual-studio",
    description: "Uninstall runner-image Visual Studio instances",
    phase: "package",
    dedupeKey: "windows:visual-studio:uninstall",
    blockedBy: VISUAL_STUDIO_OVERLAPS,
    validate: async () => {
      await instances();
    },
    run: async (): Promise<OperationResult> => {
      const setup = win32.join(paths.visualStudioInstaller, "setup.exe");
      if (!(await pathExists(setup))) return { status: "not-found" };
      const selected = await instances();
      if (selected.length === 0) return { status: "not-found" };

      for (const instance of selected) {
        const result = await runCommand(
          setup,
          [
            "uninstall",
            "--installPath",
            instance.installationPath,
            "--quiet",
            "--norestart",
            "--force",
          ],
          { silent: false, timeoutMs: 75 * 60_000 },
        );
        if (!SUCCESS_EXIT_CODES.has(result.exitCode)) {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, setup, result.exitCode),
          };
        }
      }
      return { status: "removed", detail: `${selected.length} instance(s)` };
    },
  });
}

const WINDOWS_SDK_COMPONENTS = [
  "Microsoft.VisualStudio.Component.Windows10SDK.19041",
  "Microsoft.VisualStudio.Component.Windows11SDK.22621",
  "Microsoft.VisualStudio.Component.Windows11SDK.26100",
  "Component.Microsoft.Windows.DriverKit",
] as const;

// Windows SDK payloads are shared and reference-counted. Use the Visual Studio
// installer component IDs from the image definitions; never delete Windows Kits,
// invoke DISM package removal, or touch WinSxS directly.

function windowsSdkOperation(
  paths: WindowsPaths,
  instances: AsyncValue<readonly VisualStudioInstance[]>,
): Operation {
  return createFunctionOperation({
    id: "windows:windows-sdk:remove-components",
    component: "windows-sdk",
    description: "Remove definition-listed Windows SDK and WDK components",
    phase: "package",
    dedupeKey: "windows:windows-sdk:remove-components",
    coveredBySuccessfulOperations: ["windows:visual-studio:uninstall"],
    validate: async () => {
      await instances();
    },
    run: async (): Promise<OperationResult> => {
      const setup = win32.join(paths.visualStudioInstaller, "setup.exe");
      if (!(await pathExists(setup))) return { status: "not-found" };
      const selected = await instances();
      if (selected.length === 0) return { status: "not-found" };

      const removeArguments = WINDOWS_SDK_COMPONENTS.flatMap((component) => [
        "--remove",
        component,
      ]);
      for (const instance of selected) {
        const result = await runCommand(
          setup,
          [
            "modify",
            "--installPath",
            instance.installationPath,
            ...removeArguments,
            "--quiet",
            "--norestart",
          ],
          { silent: false, timeoutMs: 75 * 60_000 },
        );
        if (!SUCCESS_EXIT_CODES.has(result.exitCode)) {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, setup, result.exitCode),
          };
        }
      }
      return { status: "removed", detail: `${selected.length} instance(s)` };
    },
  });
}

function dockerImagesOperation(paths: WindowsPaths): Operation {
  return createFunctionOperation({
    id: "windows:docker:prune",
    component: "docker-images",
    description: "Prune unused Windows Docker data",
    phase: "system",
    dedupeKey: "windows:docker:prune",
    run: async (): Promise<OperationResult> => {
      const docker = win32.join(paths.system32, "docker.exe");
      if (!(await pathExists(docker))) return { status: "not-found" };
      const responsive = await runCommand(docker, ["info"], {
        silent: true,
        timeoutMs: 15_000,
      });
      if (responsive.exitCode !== 0) {
        return { status: "unsupported", detail: "Docker daemon unavailable" };
      }
      const result = await runCommand(
        docker,
        ["system", "prune", "--all", "--volumes", "--force"],
        { silent: false, timeoutMs: 20 * 60_000 },
      );
      return result.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: failureDetail(result.stderr, docker, result.exitCode),
          };
    },
  });
}

function recreateToolCacheOperation(
  context: RuntimeContext,
  target: string,
): Operation {
  return createFunctionOperation({
    id: "windows:toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    validate: async () =>
      await assertSafeDirectoryTarget(target, [win32.dirname(target)], context),
    run: async () => {
      try {
        await assertSafeDirectoryTarget(
          target,
          [win32.dirname(target)],
          context,
        );
        await mkdir(target, { recursive: true });
        await assertSafeDirectoryTarget(
          target,
          [win32.dirname(target)],
          context,
        );
        return { status: "removed" };
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

async function removeExactTarget(
  context: RuntimeContext,
  target: string,
): Promise<OperationResult> {
  return await removePathTarget(target, [win32.dirname(target)], context);
}

async function validateExactTarget(
  context: RuntimeContext,
  target: string,
): Promise<void> {
  await validateRemovePathTarget(target, [win32.dirname(target)], context);
}

export function managedDirectoryUninstallOperation(options: {
  readonly context: RuntimeContext;
  readonly component: ComponentId;
  readonly id: string;
  readonly description: string;
  readonly target: string;
  readonly uninstaller: string;
  readonly args: readonly string[];
  readonly probe?: WindowsPathProbe;
  readonly execute?: (
    executable: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
}): Operation {
  const probe = options.probe ?? NODE_WINDOWS_PATH_PROBE;
  const execute =
    options.execute ??
    (async (path: string, args: readonly string[]) =>
      await runCommand(path, args, {
        silent: true,
        timeoutMs: 30 * 60_000,
      }));
  const executable = win32.join(options.target, options.uninstaller);
  type ManagedTargets =
    | { readonly status: "root-absent" }
    | {
        readonly status: "root-present";
        readonly root: WindowsPathIdentity;
        readonly uninstaller?: WindowsPathIdentity;
      };
  const inspectManagedTargets = async (): Promise<ManagedTargets> => {
    await validateExactTarget(options.context, options.target);
    let root: WindowsPathStats;
    try {
      root = await probe.lstat(options.target);
      if (root.isSymbolicLink() || !root.isDirectory()) {
        throw new Error(
          `Refusing managed directory with an unexpected target type: '${options.target}'.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "root-absent" };
      }
      throw error;
    }
    try {
      const uninstaller = await probe.lstat(executable);
      if (uninstaller.isSymbolicLink() || !uninstaller.isFile()) {
        throw new Error(
          `Refusing managed uninstaller with an unexpected target type: '${executable}'.`,
        );
      }
      return {
        status: "root-present",
        root: windowsPathIdentity(root),
        uninstaller: windowsPathIdentity(uninstaller),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "root-present", root: windowsPathIdentity(root) };
      }
      throw error;
    }
  };
  let validatedState: ManagedTargets | undefined;
  const sameTargets = (left: ManagedTargets, right: ManagedTargets): boolean =>
    left.status === right.status &&
    (left.status === "root-absent" ||
      (right.status === "root-present" &&
        sameWindowsPathIdentity(left.root, right.root) &&
        sameWindowsPathIdentity(left.uninstaller, right.uninstaller)));
  return createFunctionOperation({
    id: `windows:managed-directory:${options.component}:${options.id}`,
    component: options.component,
    description: options.description,
    phase: "package",
    dedupeKey: `path:${win32.normalize(options.target).toLowerCase()}`,
    validate: async () => {
      validatedState = await inspectManagedTargets();
    },
    run: async (): Promise<OperationResult> => {
      try {
        if (validatedState === undefined) {
          validatedState = await inspectManagedTargets();
        }
        const immediateState = await inspectManagedTargets();
        if (!sameTargets(immediateState, validatedState)) {
          return {
            status: "failed",
            detail: "managed uninstaller changed after plan validation",
          };
        }
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (validatedState.status === "root-absent") {
        return { status: "not-found" };
      }
      if (validatedState.uninstaller !== undefined) {
        const result = await execute(executable, options.args);
        if (!SUCCESS_EXIT_CODES.has(result.exitCode)) {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, executable, result.exitCode),
          };
        }
      }

      // Some quiet uninstallers intentionally leave caches behind. The root is
      // fixed by the image definition, so remove only that exact residual tree.
      const residual = await removeExactTarget(options.context, options.target);
      return residual.status === "failed" ? residual : { status: "removed" };
    },
  });
}

function residualPathOperation(
  context: RuntimeContext,
  component: ComponentId,
  target: string,
  description: string,
): Operation {
  return createFunctionOperation({
    id: `windows:residual:${component}:${target}`,
    component,
    description,
    phase: "system",
    dedupeKey: `path:${win32.normalize(target).toLowerCase()}`,
    validate: async () => await validateExactTarget(context, target),
    run: async () => await removeExactTarget(context, target),
  });
}

function dockerEngineOperation(
  context: RuntimeContext,
  paths: WindowsPaths,
): Operation {
  const targets = [
    win32.join(paths.system32, "docker.exe"),
    win32.join(paths.system32, "dockerd.exe"),
    win32.join(paths.systemRoot, "SysWOW64", "docker.exe"),
    win32.join(paths.programData, "docker", "cli-plugins"),
  ];
  return createFunctionOperation({
    id: "windows:docker:engine",
    component: "docker-engine",
    description: "Remove runner-image Docker Engine binaries",
    phase: "system",
    dedupeKey: "windows:docker:engine",
    validate: async () => {
      for (const target of targets) {
        await validateExactTarget(context, target);
      }
    },
    run: async (): Promise<OperationResult> => {
      const hadTargets = (await Promise.all(targets.map(pathExists))).some(
        Boolean,
      );
      if (!hadTargets) return { status: "not-found" };

      const failures: string[] = [];
      let removed = false;
      for (const target of targets) {
        const result = await removeExactTarget(context, target);
        if (result.status === "removed") removed = true;
        if (result.status === "failed") {
          failures.push(`${target}: ${result.detail ?? "removal failed"}`);
        }
      }
      if (failures.length > 0) {
        return { status: "failed", detail: failures.join("; ") };
      }
      return removed ? { status: "removed" } : { status: "not-found" };
    },
  });
}

export async function createWindowsAdapter(
  context: RuntimeContext,
): Promise<Adapter> {
  const normalizedHome = win32.normalize(context.home);
  if (normalizedHome.toLowerCase() !== "c:\\users\\runneradmin") {
    throw new Error(
      `Refusing unexpected Windows runner home '${context.home}'; no cleanup was scheduled.`,
    );
  }
  const paths = windowsPaths();
  const installedChocolateyPackages = lazyAsync(
    async () => await listChocolateyPackages(paths.chocolatey),
  );
  const installedMsiProducts = lazyAsync(
    async () => await listMsiProducts(paths),
  );
  const visualStudioInstances = lazyAsync(
    async () => await listVisualStudioInstances(paths),
  );

  return {
    supportedComponents: SUPPORTED,
    operations: async (plan: CleanupPlan): Promise<readonly Operation[]> => {
      const operations: Operation[] = [];
      const serviceCoordinator = createWindowsServiceCoordinator(paths, plan);
      if (serviceCoordinator !== undefined) {
        operations.push(serviceCoordinator);
      }
      const addFixed = (
        component: ComponentId,
        target: string,
        description: string,
        blockedBy?: readonly ComponentId[],
        coveredBy?: readonly ComponentId[],
      ): void => {
        operations.push(
          fixedPathOperation(
            context,
            component,
            target,
            description,
            blockedBy,
            coveredBy,
          ),
        );
      };

      const expectedToolCache = win32.join(
        paths.drive,
        "hostedtoolcache",
        "windows",
      );
      const toolCache =
        context.toolCache !== undefined &&
        win32.normalize(context.toolCache).toLowerCase() ===
          expectedToolCache.toLowerCase()
          ? expectedToolCache
          : undefined;

      addFixed(
        "dotnet",
        win32.join(paths.programFiles, "dotnet"),
        "Remove runner-image .NET SDKs",
      );
      addFixed(
        "dotnet",
        win32.join(paths.defaultUser, ".dotnet"),
        "Remove default-user .NET tools",
      );
      addFixed(
        "android",
        win32.join(paths.programFilesX86, "Android", "android-sdk"),
        "Remove Android SDK",
      );
      addFixed(
        "android",
        win32.join(paths.drive, "Android", "android-sdk"),
        "Remove Android SDK definition link",
      );
      addFixed(
        "haskell",
        win32.join(paths.drive, "ghcup"),
        "Remove GHCup toolchains",
      );
      addFixed(
        "haskell",
        win32.join(paths.drive, "cabal"),
        "Remove Cabal tools",
      );
      const minicondaRoot = win32.join(paths.drive, "Miniconda");
      operations.push(
        managedDirectoryUninstallOperation({
          context,
          component: "miniconda",
          id: "miniconda",
          description: "Uninstall the runner-image Miniconda distribution",
          target: minicondaRoot,
          uninstaller: "Uninstall-Miniconda3.exe",
          args: ["/S"],
        }),
      );
      addFixed(
        "vcpkg",
        win32.join(paths.drive, "vcpkg"),
        "Remove vcpkg checkout",
      );
      addFixed(
        "rust",
        win32.join(paths.defaultUser, ".cargo"),
        "Remove default-user Cargo home",
      );
      addFixed(
        "rust",
        win32.join(paths.defaultUser, ".rustup"),
        "Remove default-user Rustup home",
      );
      if (
        win32.normalize(context.home) !== win32.normalize(paths.defaultUser)
      ) {
        addFixed(
          "rust",
          win32.join(context.home, ".cargo"),
          "Remove runner-user Cargo home",
        );
        addFixed(
          "rust",
          win32.join(context.home, ".rustup"),
          "Remove runner-user Rustup home",
        );
      }
      addFixed(
        "kind",
        win32.join(paths.programData, "kind"),
        "Remove kind executable",
      );
      addFixed(
        "kustomize",
        win32.join(paths.programData, "chocolatey", "bin", "kustomize.exe"),
        "Remove runner-image kustomize shim if present",
      );
      addFixed(
        "azure-cli",
        win32.join(paths.drive, "azureCli"),
        "Remove Azure CLI cache",
      );
      addFixed(
        "azure-cli",
        win32.join(paths.commonProgramFiles, "AzureCliExtensionDirectory"),
        "Remove Azure CLI extension cache",
      );
      addFixed(
        "powershell",
        win32.join(paths.drive, "Modules"),
        "Remove runner-image Azure PowerShell modules",
      );
      const allUsersPowerShellModules = win32.join(
        paths.programFiles,
        "WindowsPowerShell",
        "Modules",
      );
      for (const moduleName of DEFINITION_POWERSHELL_MODULES) {
        addFixed(
          "powershell",
          win32.join(allUsersPowerShellModules, moduleName),
          `Remove PowerShell module ${moduleName}`,
        );
      }
      addFixed(
        "maven",
        win32.join(paths.programData, "m2"),
        "Remove runner-image Maven repository cache",
      );

      if (toolCache === undefined) {
        const missingToolcacheComponents = [
          "cached-tools",
          "codeql",
          "cached-go",
          "cached-node",
          "cached-python",
          "cached-pypy",
          "cached-ruby",
          "java",
        ] as const satisfies readonly ComponentId[];
        for (const component of missingToolcacheComponents) {
          operations.push(
            notFoundOperation(
              component,
              `toolcache-${component}`,
              `Locate hosted toolcache for ${component}`,
            ),
          );
        }
      } else {
        addFixed("cached-tools", toolCache, "Remove hosted toolcache");
        operations.push(recreateToolCacheOperation(context, toolCache));
        const cachedTargets: readonly [ComponentId, string, string][] = [
          ["codeql", "CodeQL", "Remove CodeQL bundles"],
          ["cached-go", "go", "Remove cached Go versions"],
          ["cached-node", "node", "Remove cached Node.js versions"],
          ["cached-python", "Python", "Remove cached Python versions"],
          ["cached-pypy", "PyPy", "Remove cached PyPy versions"],
          ["cached-ruby", "Ruby", "Remove cached Ruby versions"],
          ["haskell", "stack", "Remove cached Stack versions"],
          ["java", "Java_Temurin-Hotspot_jdk", "Remove cached Temurin JDKs"],
        ];
        for (const [component, name, description] of cachedTargets) {
          addFixed(
            component,
            win32.join(toolCache, name),
            description,
            [],
            ["cached-tools"],
          );
        }
      }

      const webdriverTargets: readonly [string, string][] = [
        ["ChromeDriver", "Remove ChromeDriver"],
        ["EdgeDriver", "Remove Edge WebDriver"],
        ["GeckoDriver", "Remove GeckoDriver"],
        ["IEDriver", "Remove Internet Explorer WebDriver"],
      ];
      const addWebdrivers = (component: "browsers" | "webdrivers"): void => {
        for (const [name, description] of webdriverTargets) {
          addFixed(
            component,
            win32.join(paths.drive, "SeleniumWebDrivers", name),
            description,
          );
        }
      };
      const addSelenium = (component: "browsers" | "selenium"): void => {
        addFixed(
          component,
          win32.join(paths.drive, "selenium"),
          "Remove Selenium server",
        );
      };
      const addBaseImageEdge = (): void => {
        operations.push(
          createFunctionOperation({
            id: "windows:unsupported:edge",
            component: "edge",
            description: "Preserve Windows base-image Microsoft Edge",
            phase: "system",
            run: async () => ({
              status: "unsupported",
              detail:
                "Microsoft Edge is part of the Windows base image; only its driver is removable",
            }),
          }),
        );
      };

      const addChrome = (component: "browsers" | "chrome"): void => {
        operations.push(
          msiOperation(
            paths,
            component,
            [/^Google Chrome$/i],
            installedMsiProducts,
            "google-chrome",
            "Uninstall Google Chrome MSI",
          ),
        );
      };
      const addFirefox = (component: "browsers" | "firefox"): void => {
        operations.push(
          executableUninstallOperation({
            context,
            component,
            id: "firefox",
            description: "Uninstall Mozilla Firefox",
            candidates: [paths.programFiles, paths.programFilesX86].map(
              (programFiles) => {
                const installationRoot = win32.join(
                  programFiles,
                  "Mozilla Firefox",
                );
                return {
                  installationRoot,
                  executable: win32.join(
                    installationRoot,
                    "uninstall",
                    "helper.exe",
                  ),
                };
              },
            ),
            args: ["/S"],
          }),
        );
      };

      // Edge itself is supplied by the Windows base image. The runner-image
      // definition installs only EdgeDriver, so do not run the unsupported
      // system-browser removal recipes commonly used on personal machines.
      addChrome("browsers");
      addFirefox("browsers");
      addWebdrivers("browsers");
      addSelenium("browsers");
      addChrome("chrome");
      addBaseImageEdge();
      addFirefox("firefox");
      addWebdrivers("webdrivers");
      addSelenium("selenium");

      operations.push(
        msiOperation(
          paths,
          "powershell",
          [/^PowerShell 7(?:-(?:x64|arm64))?$/i],
          installedMsiProducts,
          "powershell-7",
          "Uninstall PowerShell 7 MSI",
        ),
      );
      operations.push(
        chocolateyOperation(
          paths,
          "julia",
          ["julia"],
          installedChocolateyPackages,
        ),
      );
      operations.push(
        residualPathOperation(
          context,
          "julia",
          win32.join(paths.drive, "Julia"),
          "Remove residual Julia files",
        ),
      );
      operations.push(
        chocolateyOperation(
          paths,
          "aws-cli",
          ["awscli"],
          installedChocolateyPackages,
        ),
      );
      operations.push(
        msiOperation(
          paths,
          "aws-cli",
          [/^AWS Systems Manager Session Manager Plugin$/i],
          installedMsiProducts,
          "aws-session-manager-plugin",
          "Uninstall AWS Session Manager Plugin MSI",
        ),
      );
      operations.push(
        msiOperation(
          paths,
          "aws-sam-cli",
          [/^AWS SAM Command Line Interface(?: \(.+\))?$/i],
          installedMsiProducts,
          "aws-sam-cli",
          "Uninstall AWS SAM CLI MSI",
        ),
      );
      operations.push(
        msiOperation(
          paths,
          "azure-cli",
          [/^Microsoft Azure CLI(?: \(64-bit\))?$/i],
          installedMsiProducts,
          "azure-cli",
          "Uninstall Azure CLI MSI",
        ),
      );
      operations.push(
        msiOperation(
          paths,
          "gh-cli",
          [/^GitHub CLI$/i],
          installedMsiProducts,
          "github-cli",
          "Uninstall GitHub CLI MSI",
        ),
      );

      const chocoComponents: readonly [ComponentId, readonly string[]][] = [
        ["azcopy", ["azcopy10"]],
        ["kubectl", ["kubernetes-cli"]],
        ["helm", ["kubernetes-helm"]],
        ["minikube", ["minikube"]],
        ["maven", ["maven"]],
        ["gradle", ["gradle"]],
        ["ant", ["ant"]],
        ["php", ["composer", "php"]],
        ["apache", ["apache-httpd"]],
        ["nginx", ["nginx"]],
      ];
      for (const [component, packageNames] of chocoComponents) {
        operations.push(
          chocolateyOperation(
            paths,
            component,
            packageNames,
            installedChocolateyPackages,
          ),
        );
      }
      operations.push(
        residualPathOperation(
          context,
          "php",
          win32.join(paths.drive, "tools", "php"),
          "Remove residual PHP files",
        ),
      );
      operations.push(
        residualPathOperation(
          context,
          "apache",
          win32.join(paths.drive, "tools", "Apache24"),
          "Remove residual Apache files",
        ),
      );
      if (plan.enabled.has("nginx")) {
        const toolsRoot = win32.join(paths.drive, "tools");
        const nginxVersions = await versionedDirectories(
          toolsRoot,
          /^nginx-\d+(?:\.\d+){1,3}$/i,
        );
        for (const versionPath of nginxVersions) {
          operations.push(
            residualPathOperation(
              context,
              "nginx",
              versionPath,
              `Remove residual Nginx ${win32.basename(versionPath)}`,
            ),
          );
        }
      }

      operations.push(
        msiOperation(
          paths,
          "mysql",
          [/^MySQL Server 8\.0$/i],
          installedMsiProducts,
          "mysql-server-8",
          "Uninstall MySQL Server MSI",
        ),
      );

      if (plan.enabled.has("postgresql")) {
        const programRoot = win32.join(paths.programFiles, "PostgreSQL");
        const dataRoot = win32.join(paths.drive, "PostgreSQL");
        const [programVersions, dataVersions] = await Promise.all([
          versionedDirectories(programRoot, /^\d+(?:\.\d+)*$/),
          versionedDirectories(dataRoot, /^\d+(?:\.\d+)*$/),
        ]);
        if (programVersions.length === 0 && dataVersions.length === 0) {
          operations.push(
            notFoundOperation(
              "postgresql",
              "postgresql",
              "Locate runner-image PostgreSQL versions",
            ),
          );
        }
        for (const versionPath of dataVersions) {
          operations.push(
            versionedPathOperation(
              context,
              "postgresql",
              dataRoot,
              versionPath,
              `Remove PostgreSQL data ${win32.basename(versionPath)}`,
            ),
          );
        }
        for (const versionPath of programVersions) {
          operations.push(
            executableUninstallOperation({
              context,
              component: "postgresql",
              id: `postgresql-${win32.basename(versionPath)}`,
              description: `Uninstall PostgreSQL ${win32.basename(versionPath)}`,
              candidates: [
                {
                  installationRoot: versionPath,
                  executable: win32.join(
                    versionPath,
                    "uninstall-postgresql.exe",
                  ),
                },
              ],
              args: ["--mode", "unattended"],
              timeoutMs: 30 * 60_000,
            }),
          );
        }
      }

      operations.push(dockerImagesOperation(paths));
      operations.push(
        createRemovePathOperation({
          id: "windows:docker:data",
          component: "docker-engine",
          description: "Remove Windows Docker data",
          target: win32.join(paths.programData, "docker"),
          allowedParents: [paths.programData],
          context,
          blockedBy: ["docker-images"],
        }),
      );
      operations.push(dockerEngineOperation(context, paths));

      // A successful complete Visual Studio uninstall includes its SDK
      // workloads. Keep the narrower SDK operation as an outcome-dependent
      // fallback so an absent or failed broad uninstall does not suppress an
      // explicitly selected SDK cleanup.
      operations.push(visualStudioOperation(paths, visualStudioInstances));
      operations.push(windowsSdkOperation(paths, visualStudioInstances));

      // Retaining Visual Studio while stripping one of its definition-owned
      // SDK/toolchain roots can leave the selected instance unusable.  A
      // `max` skip is a preservation request, so conservatively keep those
      // overlapping payloads with Visual Studio.  Custom mode has no skips and
      // can still remove any of the components independently.
      if (plan.skipped.has("visual-studio")) {
        const protectedComponents = new Set<ComponentId>([
          "visual-studio",
          ...VISUAL_STUDIO_OVERLAPS,
        ]);
        return operations.filter(
          (operation) => !protectedComponents.has(operation.component),
        );
      }

      return operations;
    },
  };
}
