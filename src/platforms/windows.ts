import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, opendir } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertCommandTerminationConfirmed,
  inspectExecutable,
  runCommand,
  type CommandOptions,
  UnconfirmedCommandTerminationError,
} from "../command.js";
import { COMPONENTS } from "../components.js";
import {
  createFunctionOperation,
  createRemovePathOperation,
  removePathTarget,
  validateRemovePathTarget,
  type RemovePathDependencies,
} from "../operations.js";
import {
  assertSafeDirectoryTarget,
  captureSafeRemovalBoundary,
  type RemovalBoundarySnapshot,
} from "../safety.js";
import type {
  Adapter,
  Architecture,
  CleanupPlan,
  CommandResult,
  ComponentId,
  Operation,
  OperationResult,
  RuntimeContext,
} from "../types.js";
import { listBoundedVersionedDirectoryEntries } from "../versioned-directories.js";

const SUPPORTED = new Set<ComponentId>(
  COMPONENTS.filter((component) =>
    component.platforms.some((platform) => platform === "windows"),
  ).map((component) => component.id),
);

const MSI_ABSENT_EXIT_CODES = new Set([1605, 1614]);
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
    if (byCanonicalName.size > 16) {
      return {
        status: "unsafe",
        detail: "PostgreSQL service inventory exceeded 16 services",
      };
    }
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
  readonly ctimeNs?: bigint;
  readonly birthtimeNs?: bigint;
  readonly mode?: bigint;
  readonly uid?: bigint;
  readonly gid?: bigint;
}

export interface WindowsPathProbe {
  lstat(path: string): Promise<WindowsPathStats>;
}

export type WindowsManagedPathProbe = WindowsPathProbe;

export interface WindowsPathIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs?: bigint;
  readonly birthtimeNs?: bigint;
  readonly mode?: bigint;
  readonly uid?: bigint;
  readonly gid?: bigint;
  readonly contentSha256?: string;
}

export interface WindowsInventoryDependencies {
  readonly expectedInventoryExecutable?: WindowsPathIdentity;
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<WindowsPathIdentity | undefined>;
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  readonly now?: () => number;
  readonly inventoryBudget?: WindowsInventoryBudget;
}

export interface WindowsInventoryBudget {
  run<T>(
    description: string,
    task: (remaining: () => number) => Promise<T>,
  ): Promise<T>;
}

export interface WindowsDockerDependencies {
  readonly captureConfigBoundary?: typeof captureSafeRemovalBoundary;
  readonly context?: RuntimeContext;
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<WindowsPathIdentity | undefined>;
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  readonly createConfigDirectory?: (prefix: string) => Promise<string>;
  readonly inspectConfigDirectory?: (
    path: string,
  ) => Promise<WindowsPathIdentity>;
  readonly removeConfigDirectory?: (
    path: string,
    expectedIdentity: WindowsPathIdentity,
  ) => Promise<void>;
  readonly removeConfigTarget?: typeof removePathTarget;
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
    ...(stats.ctimeNs === undefined ? {} : { ctimeNs: stats.ctimeNs }),
    ...(stats.birthtimeNs === undefined
      ? {}
      : { birthtimeNs: stats.birthtimeNs }),
    ...(stats.mode === undefined ? {} : { mode: stats.mode }),
    ...(stats.uid === undefined ? {} : { uid: stats.uid }),
    ...(stats.gid === undefined ? {} : { gid: stats.gid }),
  };
}

function sameWindowsPathIdentity(
  left: WindowsPathIdentity | undefined,
  right: WindowsPathIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.contentSha256 === right.contentSha256
  );
}

function sameWindowsObjectIdentity(
  left: WindowsPathIdentity | undefined,
  right: WindowsPathIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameOptionalWindowsPathIdentity(
  left: WindowsPathIdentity | undefined,
  right: WindowsPathIdentity | undefined,
): boolean {
  return (
    (left === undefined && right === undefined) ||
    sameWindowsPathIdentity(left, right)
  );
}

interface WindowsServiceSnapshot extends WindowsServiceTarget {
  readonly status: "present" | "missing";
  readonly state: number;
  readonly startType?: 2 | 3 | 4;
  readonly startSetting?: WindowsServiceStartSetting;
  readonly executable?: string;
  readonly executableIdentity?: WindowsPathIdentity;
  readonly configuration?: string;
}

type WindowsServiceStartSetting =
  "auto" | "delayed-auto" | "demand" | "disabled";

export interface WindowsServiceControl {
  exists(): Promise<boolean>;
  inspectExecutable?(
    executable: string,
  ): Promise<WindowsPathIdentity | undefined>;
  inventory(timeoutMs?: number): Promise<CommandResult>;
  query(serviceName: string, timeoutMs?: number): Promise<CommandResult>;
  config?(serviceName: string, timeoutMs?: number): Promise<CommandResult>;
  stop(serviceName: string, timeoutMs?: number): Promise<CommandResult>;
  configureStart?(
    serviceName: string,
    startType: WindowsServiceStartSetting,
    timeoutMs?: number,
  ): Promise<CommandResult>;
  start?(serviceName: string, timeoutMs?: number): Promise<CommandResult>;
  delete(serviceName: string, timeoutMs?: number): Promise<CommandResult>;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
}

export interface WindowsServiceCoordinatorOperation extends Operation {
  readonly assertQuiesced: (options?: {
    readonly allowMissingTransitions?: boolean;
  }) => Promise<void>;
}

export function guardWindowsServiceOperation(
  operation: Operation,
  coordinator: WindowsServiceCoordinatorOperation,
): Operation {
  return {
    ...operation,
    validateBeforeRun: async () => {
      await operation.validateBeforeRun?.();
      await coordinator.assertQuiesced({ allowMissingTransitions: true });
    },
  };
}

export interface WindowsServiceRegistrationLifecycle {
  isRegistrationFinalized(component?: ComponentId): boolean;
  finalizeRegistration(component?: ComponentId): void;
}

export type WindowsDockerServiceLifecycle = WindowsServiceRegistrationLifecycle;

export function createWindowsServiceRegistrationLifecycle(): WindowsServiceRegistrationLifecycle {
  const finalized = new Set<ComponentId>();
  return {
    isRegistrationFinalized: (component = "docker-engine") =>
      finalized.has(component),
    finalizeRegistration: (component = "docker-engine") => {
      finalized.add(component);
    },
  };
}

export function createWindowsDockerServiceLifecycle(): WindowsDockerServiceLifecycle {
  return createWindowsServiceRegistrationLifecycle();
}
export function windowsInstallerExitDisposition(
  exitCode: number,
): "completed" | "restart-required" | "restart-initiated" | "failed" {
  if (exitCode === 0) return "completed";
  if (exitCode === 3010) return "restart-required";
  if (exitCode === 1641) return "restart-initiated";
  return "failed";
}

function restartResult(
  executable: string,
  disposition: "restart-required" | "restart-initiated",
): OperationResult {
  const exitCode = disposition === "restart-required" ? 3010 : 1641;
  const detail =
    disposition === "restart-required"
      ? "because a system restart is required and immediate payload removal cannot be verified"
      : "after initiating a system restart";
  return {
    status: "failed",
    detail: `${executable} exited ${exitCode} ${detail}; refusing further cleanup`,
    abortAction: true,
  };
}

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
  readonly commandEnvironment: NodeJS.ProcessEnv;
  readonly chocolateyEnvironment: NodeJS.ProcessEnv;
  readonly installerEnvironment: NodeJS.ProcessEnv;
}

export interface MsiProduct {
  readonly registryKey: string;
  readonly productCode: string;
  readonly displayName: string;
  readonly windowsInstaller: 1;
}

export interface WindowsUninstallRecord {
  readonly registryKey: string;
  readonly displayName?: string;
  readonly displayVersion?: string;
  readonly bundleCachePath?: string;
  readonly windowsInstaller?: number;
}

interface VisualStudioInstance {
  readonly installationPath: string;
  readonly definitionRoot: string;
  readonly installationIdentity: WindowsPathIdentity;
  readonly installationVersion: string;
  readonly productId: "Microsoft.VisualStudio.Product.Enterprise";
}

interface WindowsVisualStudioInventory {
  readonly instances: readonly VisualStudioInstance[];
  readonly vswhereExecutable: WindowsPathIdentity;
}

export interface WindowsVisualStudioDependencies extends WindowsInventoryDependencies {
  readonly pathProbe?: WindowsPathProbe;
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

export function windowsPaths(
  home = "C:\\Users\\runneradmin",
  architecture: Architecture = "x64",
): WindowsPaths {
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
  const normalizedHome = win32.normalize(home);
  const homePath = normalizedHome
    .toLowerCase()
    .startsWith(`${drive.toLowerCase()}\\`)
    ? normalizedHome.slice(drive.length)
    : "\\Users\\runneradmin";
  const systemPath = [
    system32,
    win32.join(system32, "Wbem"),
    win32.join(system32, "WindowsPowerShell", "v1.0"),
    win32.join(systemRoot, "System"),
    systemRoot,
  ].join(";");
  const commandEnvironment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: drive,
    ProgramFiles: programFiles,
    "ProgramFiles(x86)": programFilesX86,
    ProgramData: programData,
    CommonProgramFiles: commonProgramFiles,
    USERPROFILE: normalizedHome,
    HOMEDRIVE: drive,
    HOMEPATH: homePath.startsWith("\\") ? homePath : `\\${homePath}`,
    PATH: systemPath,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: win32.join(system32, "cmd.exe"),
    TEMP: win32.join(systemRoot, "Temp"),
    TMP: win32.join(systemRoot, "Temp"),
    NoDefaultCurrentDirectoryInExePath: "1",
  };
  const installerEnvironment: NodeJS.ProcessEnv = {
    ...commandEnvironment,
    ProgramW6432: programFiles,
    CommonProgramW6432: commonProgramFiles,
    PROCESSOR_ARCHITECTURE: architecture === "arm64" ? "ARM64" : "AMD64",
    LOCALAPPDATA: win32.join(normalizedHome, "AppData", "Local"),
    APPDATA: win32.join(normalizedHome, "AppData", "Roaming"),
    ALLUSERSPROFILE: programData,
  };
  const chocolateyEnvironment: NodeJS.ProcessEnv = {
    ...installerEnvironment,
    ChocolateyInstall: chocolateyInstall,
    ChocolateyToolsLocation: win32.join(drive, "tools"),
    PATH: `${systemPath};${win32.join(chocolateyInstall, "bin")}`,
  };

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
    commandEnvironment,
    chocolateyEnvironment,
    installerEnvironment,
  };
}

async function inspectWindowsExecutable(
  target: string,
  probe: WindowsPathProbe = NODE_WINDOWS_PATH_PROBE,
): Promise<WindowsPathIdentity | undefined> {
  if (probe === NODE_WINDOWS_PATH_PROBE) {
    const identity = await inspectExecutable(target);
    return identity === undefined
      ? undefined
      : {
          dev: identity.device,
          ino: identity.inode,
          size: identity.size,
          mtimeNs: identity.modifiedNanoseconds,
          ...(identity.changedNanoseconds === undefined
            ? {}
            : { ctimeNs: identity.changedNanoseconds }),
          ...(identity.mode === undefined ? {} : { mode: identity.mode }),
          ...(identity.userId === undefined ? {} : { uid: identity.userId }),
          ...(identity.groupId === undefined ? {} : { gid: identity.groupId }),
          ...(identity.contentSha256 === undefined
            ? {}
            : { contentSha256: identity.contentSha256 }),
        };
  }
  try {
    const stats = await probe.lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
    return windowsPathIdentity(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inspectWindowsServiceExecutable(
  paths: WindowsPaths,
  executable: string,
  probe: WindowsPathProbe = NODE_WINDOWS_PATH_PROBE,
): Promise<WindowsPathIdentity | undefined> {
  try {
    await assertWindowsDirectoryChain(
      win32.dirname(executable),
      `${paths.drive}\\`,
      probe,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return await inspectWindowsExecutable(executable, probe);
}

function failureDetail(
  stderr: string,
  executable: string,
  exitCode: number,
): string {
  return stderr.trim() || `${win32.basename(executable)} exited ${exitCode}`;
}

function windowsServiceControl(paths: WindowsPaths): WindowsServiceControl {
  let validatedExecutable: WindowsPathIdentity | undefined;
  const assertStableExecutable = async (): Promise<void> => {
    const current = await inspectWindowsExecutable(paths.serviceControl);
    if (current === undefined) throw new Error("sc.exe is unavailable");
    if (
      validatedExecutable !== undefined &&
      !sameWindowsPathIdentity(validatedExecutable, current)
    ) {
      throw new Error("sc.exe changed after plan validation");
    }
    validatedExecutable ??= current;
  };
  return {
    inspectExecutable: async (executable) =>
      await inspectWindowsServiceExecutable(paths, executable),
    exists: async () => {
      try {
        await assertStableExecutable();
        return true;
      } catch {
        return false;
      }
    },
    inventory: async (timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(
        paths.serviceControl,
        POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
        {
          env: paths.commandEnvironment,
          silent: true,
          timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
        },
      );
    },
    query: async (serviceName, timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["query", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
      });
    },
    config: async (serviceName, timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["qc", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
      });
    },
    stop: async (serviceName, timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["stop", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
      });
    },
    configureStart: async (serviceName, startType, timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(
        paths.serviceControl,
        ["config", serviceName, "start=", startType],
        {
          env: paths.commandEnvironment,
          silent: true,
          timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
        },
      );
    },
    start: async (serviceName, timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["start", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
      });
    },
    delete: async (serviceName, timeoutMs = 30_000) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["delete", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(timeoutMs))),
      });
    },
  };
}

const WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS = 30_000;
const WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS = 2 * 60_000;
const WINDOWS_INVENTORY_TIMEOUT_MS = 2 * 60_000;

function windowsInventoryClock(
  dependencies: WindowsInventoryDependencies,
): () => number {
  return dependencies.now ?? (() => performance.now());
}

function windowsInventoryRemainingMilliseconds(
  now: () => number,
  deadline: number,
  description: string,
): number {
  const remaining = Math.ceil(deadline - now());
  if (remaining <= 0) {
    throw new Error(
      `${description} exceeded its two-minute aggregate deadline`,
    );
  }
  return remaining;
}

export function createWindowsInventoryBudget(
  dependencies: Pick<WindowsInventoryDependencies, "now"> = {},
): WindowsInventoryBudget {
  const now = windowsInventoryClock(dependencies);
  let remainingMilliseconds = WINDOWS_INVENTORY_TIMEOUT_MS;
  let active = false;
  return {
    run: async <T>(
      description: string,
      task: (remaining: () => number) => Promise<T>,
    ): Promise<T> => {
      if (active) {
        throw new Error(`${description} attempted a nested inventory budget`);
      }
      const startedAt = now();
      if (!Number.isFinite(startedAt) || remainingMilliseconds <= 0) {
        throw new Error(
          `${description} exceeded its two-minute aggregate deadline`,
        );
      }
      const deadline = startedAt + remainingMilliseconds;
      const remaining = (): number =>
        windowsInventoryRemainingMilliseconds(now, deadline, description);
      active = true;
      try {
        remaining();
        const result = await task(remaining);
        remaining();
        return result;
      } finally {
        const elapsed = now() - startedAt;
        remainingMilliseconds =
          Number.isFinite(elapsed) && elapsed >= 0
            ? Math.max(0, remainingMilliseconds - elapsed)
            : 0;
        active = false;
      }
    },
  };
}

function windowsServiceClock(control: WindowsServiceControl): () => number {
  return control.now ?? (() => performance.now());
}

function windowsServiceRemainingMilliseconds(
  now: () => number,
  deadline: number,
  description: string,
): number {
  const remaining = Math.ceil(deadline - now());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error(`${description} did not complete within 30 seconds`);
  }
  return Math.min(WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS, remaining);
}

function windowsServiceCoordinationRemainingMilliseconds(
  now: () => number,
  deadline: number,
  description: string,
): number {
  const remaining = Math.ceil(deadline - now());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error(
      `${description} exceeded its two-minute aggregate deadline`,
    );
  }
  return Math.min(WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS, remaining);
}

async function runWindowsDeadlineTask<T>(
  remaining: () => number,
  task: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = remaining();
  let result: T;
  try {
    result = await task(timeoutMs);
  } catch (taskError) {
    try {
      remaining();
    } catch (deadlineError) {
      throw combinedWindowsTaskDeadlineError(taskError, deadlineError);
    }
    throw taskError;
  }
  remaining();
  return result;
}

function combinedWindowsTaskDeadlineError(
  taskError: unknown,
  deadlineError: unknown,
): Error {
  const taskDetail =
    taskError instanceof Error ? taskError.message : String(taskError);
  const deadlineDetail =
    deadlineError instanceof Error
      ? deadlineError.message
      : String(deadlineError);
  const detail = `${taskDetail}; deadline: ${deadlineDetail}`;
  const causes = new AggregateError([taskError, deadlineError], detail);
  if (taskError instanceof UnconfirmedCommandTerminationError) {
    const combined = new UnconfirmedCommandTerminationError(detail);
    Object.defineProperty(combined, "cause", {
      configurable: true,
      value: causes,
    });
    return combined;
  }
  return causes;
}

function selectedFixedWindowsServices(
  plan: CleanupPlan,
): readonly WindowsServiceTarget[] {
  const definitions = [
    {
      component: "docker-engine",
      serviceName: "docker",
      // Service registration is retained until Docker engine removal has
      // completed. Preflight owns only the reversible stop transition.
      unregister: false,
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

function assertCompleteWindowsCommandOutput(
  result: CommandResult,
  description: string,
): void {
  if (result.stdoutTruncated === true || result.stderrTruncated === true) {
    throw new Error(`${description} exceeded the safe output bound`);
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return (
    win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
  );
}

function executableFromWindowsServiceCommandLine(commandLine: string): string {
  const value = commandLine.trim();
  if (value.startsWith('"')) {
    const closingQuote = value.indexOf('"', 1);
    if (closingQuote <= 1) {
      throw new Error("service returned an unterminated executable path");
    }
    return value.slice(1, closingQuote);
  }
  const executable = /^(\S+?\.exe)(?:\s|$)/i.exec(value)?.[1];
  if (executable === undefined) {
    throw new Error("service returned an unsafe unquoted executable path");
  }
  return executable;
}

export function parseAndValidateWindowsServiceExecutable(
  paths: WindowsPaths,
  component: ComponentId,
  serviceName: string,
  output: string,
): string {
  const commandLine = /^\s*BINARY_PATH_NAME\s*:\s*(.+?)\s*$/im.exec(
    output,
  )?.[1];
  if (commandLine === undefined) {
    throw new Error(`${serviceName}: sc.exe returned no binary path`);
  }
  const executable = win32.normalize(
    executableFromWindowsServiceCommandLine(commandLine),
  );
  const postgreSqlVersion = /^postgresql-x64-(\d+(?:\.\d+)*)$/i.exec(
    serviceName,
  )?.[1];
  const nginxVersionRoot = win32.basename(win32.dirname(executable));
  const accepted =
    component === "docker-engine"
      ? sameWindowsPath(executable, win32.join(paths.system32, "dockerd.exe"))
      : component === "apache"
        ? sameWindowsPath(
            executable,
            win32.join(paths.drive, "tools", "Apache24", "bin", "httpd.exe"),
          )
        : component === "nginx"
          ? /^nginx-\d+(?:\.\d+){1,3}$/i.test(nginxVersionRoot) &&
            sameWindowsPath(
              executable,
              win32.join(paths.drive, "tools", nginxVersionRoot, "nginx.exe"),
            )
          : component === "postgresql"
            ? postgreSqlVersion !== undefined &&
              sameWindowsPath(
                executable,
                win32.join(
                  paths.programFiles,
                  "PostgreSQL",
                  postgreSqlVersion,
                  "bin",
                  "pg_ctl.exe",
                ),
              )
            : false;
  if (!accepted) {
    throw new Error(
      `${serviceName}: service executable is outside its runner-image installation root`,
    );
  }
  return executable;
}

function windowsServiceState(result: CommandResult): number | undefined {
  const stateText = /^\s*STATE\s*:\s*(\d+)\s+[A-Z_]+\b/im.exec(
    result.stdout,
  )?.[1];
  const state = stateText === undefined ? undefined : Number(stateText);
  return state !== undefined && Number.isSafeInteger(state) ? state : undefined;
}

function windowsServiceStartConfiguration(output: string):
  | {
      readonly startType: 2 | 3 | 4;
      readonly startSetting: WindowsServiceStartSetting;
    }
  | undefined {
  const match =
    /^\s*START_TYPE\s*:\s*([234])\s+([A-Z_]+)(?:\s+\(([^)]+)\))?\s*$/im.exec(
      output,
    );
  if (match === null) return undefined;
  const startType = Number(match[1]);
  const label = match[2];
  const qualifier = match[3];
  if (startType === 2 && label === "AUTO_START") {
    if (qualifier === undefined) return { startType, startSetting: "auto" };
    if (qualifier === "DELAYED") {
      return { startType, startSetting: "delayed-auto" };
    }
    return undefined;
  }
  if (startType === 3 && label === "DEMAND_START" && qualifier === undefined) {
    return { startType, startSetting: "demand" };
  }
  if (startType === 4 && label === "DISABLED" && qualifier === undefined) {
    return { startType, startSetting: "disabled" };
  }
  return undefined;
}

function windowsServiceStartType(output: string): 2 | 3 | 4 | undefined {
  return windowsServiceStartConfiguration(output)?.startType;
}

function normalizedWindowsServiceConfiguration(output: string): string {
  return output.trim().replace(/\r\n/g, "\n");
}

function windowsServiceConfigurationWithoutStartType(output: string): string {
  return normalizedWindowsServiceConfiguration(output)
    .split("\n")
    .filter((line) => !/^\s*START_TYPE\s*:/i.test(line))
    .join("\n");
}

async function discoverWindowsServices(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl,
  deadline = windowsServiceClock(control)() +
    WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
): Promise<readonly WindowsServiceSnapshot[]> {
  const now = windowsServiceClock(control);
  const remaining = (description: string): number =>
    windowsServiceCoordinationRemainingMilliseconds(now, deadline, description);
  const serviceControlExists = await control.exists();
  remaining("Windows service discovery");
  if (!serviceControlExists) throw new Error("sc.exe is unavailable");

  const targets = [...selectedFixedWindowsServices(plan)];
  if (plan.enabled.has("postgresql")) {
    const inventory = await control.inventory(
      remaining("Windows service discovery"),
    );
    remaining("Windows service discovery");
    assertCompleteWindowsCommandOutput(inventory, "Windows service inventory");
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
    const result = await control.query(
      target.serviceName,
      remaining("Windows service discovery"),
    );
    remaining("Windows service discovery");
    assertCompleteWindowsCommandOutput(
      result,
      `${target.serviceName} service query`,
    );
    if (isMissingWindowsService(result)) {
      snapshots.push({ ...target, status: "missing", state: 0 });
      continue;
    }
    if (result.exitCode !== 0) {
      throw windowsServiceFailure(paths, target.serviceName, result);
    }
    const state = windowsServiceState(result);
    if (state === undefined) {
      throw new Error(
        `${target.serviceName}: sc.exe returned no service state`,
      );
    }
    if (state !== 1 && state !== 4) {
      throw new Error(
        `${target.serviceName}: service must be in a stable STOPPED or RUNNING state before cleanup`,
      );
    }
    let executable: string | undefined;
    let executableIdentity: WindowsPathIdentity | undefined;
    let configuration: string | undefined;
    let startType: 2 | 3 | 4 | undefined;
    let startSetting: WindowsServiceStartSetting | undefined;
    if (
      control.config === undefined ||
      control.inspectExecutable === undefined
    ) {
      throw new Error(
        `${target.serviceName}: service configuration and executable identity cannot be verified`,
      );
    }
    const config = await control.config(
      target.serviceName,
      remaining("Windows service discovery"),
    );
    remaining("Windows service discovery");
    assertCompleteWindowsCommandOutput(
      config,
      `${target.serviceName} service configuration`,
    );
    if (config.exitCode !== 0) {
      throw windowsServiceFailure(paths, target.serviceName, config);
    }
    const startConfiguration = windowsServiceStartConfiguration(config.stdout);
    if (startConfiguration === undefined) {
      throw new Error(
        `${target.serviceName}: sc.exe returned no supported service start type`,
      );
    }
    startType = startConfiguration.startType;
    startSetting = startConfiguration.startSetting;
    if (state === 4 && startSetting === "disabled") {
      throw new Error(
        `${target.serviceName}: unsafe reactivation left a disabled service running`,
      );
    }
    executable = parseAndValidateWindowsServiceExecutable(
      paths,
      target.component,
      target.serviceName,
      config.stdout,
    );
    executableIdentity = await control.inspectExecutable(executable);
    remaining("Windows service discovery");
    if (executableIdentity === undefined) {
      throw new Error(
        `${target.serviceName}: registered service executable is unavailable`,
      );
    }
    configuration = normalizedWindowsServiceConfiguration(config.stdout);
    snapshots.push({
      ...target,
      status: "present",
      state,
      startType,
      startSetting,
      ...(executable === undefined ? {} : { executable }),
      ...(executableIdentity === undefined ? {} : { executableIdentity }),
      ...(configuration === undefined ? {} : { configuration }),
    });
  }
  remaining("Windows service discovery");
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
        target.state === right[index]?.state &&
        target.startType === right[index]?.startType &&
        target.startSetting === right[index]?.startSetting &&
        target.executable === right[index]?.executable &&
        sameOptionalWindowsPathIdentity(
          target.executableIdentity,
          right[index]?.executableIdentity,
        ) &&
        target.configuration === right[index]?.configuration,
    )
  );
}

function sameQuiescedWindowsService(
  expected: WindowsServiceSnapshot,
  current: WindowsServiceSnapshot | undefined,
): boolean {
  if (
    current === undefined ||
    expected.component !== current.component ||
    expected.serviceName !== current.serviceName ||
    expected.unregister !== current.unregister ||
    expected.status !== current.status
  ) {
    return false;
  }
  if (expected.status === "missing") return true;
  return (
    current.state === 1 &&
    current.startSetting === "disabled" &&
    expected.executable === current.executable &&
    sameOptionalWindowsPathIdentity(
      expected.executableIdentity,
      current.executableIdentity,
    ) &&
    expected.configuration !== undefined &&
    current.configuration !== undefined &&
    windowsServiceConfigurationWithoutStartType(expected.configuration) ===
      windowsServiceConfigurationWithoutStartType(current.configuration)
  );
}

async function assertWindowsServicesQuiesced(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl,
  expected: readonly WindowsServiceSnapshot[],
  lifecycle?: WindowsServiceRegistrationLifecycle,
  allowMissingTransitions = false,
  deadline?: number,
): Promise<void> {
  const now = windowsServiceClock(control);
  const current = await discoverWindowsServices(
    paths,
    plan,
    control,
    deadline ?? now() + WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
  );
  const key = ({ component, serviceName }: WindowsServiceTarget): string =>
    `${component}\0${serviceName.toLowerCase()}`;
  const expectedByKey = new Map(
    expected.map((target) => [key(target), target]),
  );
  const currentByKey = new Map(current.map((target) => [key(target), target]));
  const unsafeExpected = expected.some((target) => {
    const currentTarget = currentByKey.get(key(target));
    if (lifecycle?.isRegistrationFinalized(target.component) === true) {
      return currentTarget?.status === "present";
    }
    if (
      allowMissingTransitions &&
      target.status === "present" &&
      (currentTarget === undefined || currentTarget.status === "missing")
    ) {
      return false;
    }
    return !sameQuiescedWindowsService(target, currentTarget);
  });
  const unexpectedCurrent = current.some(
    (target) => !expectedByKey.has(key(target)),
  );
  if (unsafeExpected || unexpectedCurrent) {
    throw new Error(
      "Windows service inventory changed or reactivated, or lost its disabled latch",
    );
  }
}

async function stopWindowsService(
  paths: WindowsPaths,
  target: WindowsServiceSnapshot,
  control: WindowsServiceControl,
  aggregateDeadline = windowsServiceClock(control)() +
    WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
  aggregateDescription = "Windows service coordination",
): Promise<void> {
  if (target.status === "missing") return;
  const now = windowsServiceClock(control);
  const deadline = Math.min(
    aggregateDeadline,
    now() + WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS,
  );
  const description = `${target.serviceName} service stop`;
  const remaining = (): number => {
    windowsServiceCoordinationRemainingMilliseconds(
      now,
      aggregateDeadline,
      aggregateDescription,
    );
    return windowsServiceRemainingMilliseconds(now, deadline, description);
  };
  const stop = await runWindowsDeadlineTask(
    remaining,
    async (timeoutMs) => await control.stop(target.serviceName, timeoutMs),
  );
  if (isMissingWindowsService(stop)) return;
  if (stop.exitCode !== 0 && stop.exitCode !== 1062) {
    throw windowsServiceFailure(paths, target.serviceName, stop);
  }
  const wait =
    control.wait ??
    (async (milliseconds: number) =>
      await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await runWindowsDeadlineTask(
      remaining,
      async (timeoutMs) => await control.query(target.serviceName, timeoutMs),
    );
    assertCompleteWindowsCommandOutput(
      status,
      `${target.serviceName} service query`,
    );
    if (isMissingWindowsService(status) || isStoppedWindowsService(status)) {
      return;
    }
    if (status.exitCode !== 0) {
      throw windowsServiceFailure(paths, target.serviceName, status);
    }
    await runWindowsDeadlineTask(
      remaining,
      async (timeoutMs) => await wait(Math.min(500, timeoutMs)),
    );
  }
  throw new Error(`${target.serviceName} did not stop within 30 seconds`);
}

export function createWindowsServiceCoordinator(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl = windowsServiceControl(paths),
  lifecycle?: WindowsServiceRegistrationLifecycle,
): WindowsServiceCoordinatorOperation | undefined {
  const fixed = selectedFixedWindowsServices(plan);
  if (fixed.length === 0 && !plan.enabled.has("postgresql")) return undefined;
  const component = fixed[0]?.component ?? "postgresql";
  const wait =
    control.wait ??
    (async (milliseconds: number) =>
      await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let validated: readonly WindowsServiceSnapshot[] | undefined;
  let quiescedExpected: readonly WindowsServiceSnapshot[] | undefined;
  let stoppedByAction: WindowsServiceSnapshot[] = [];
  let disabledByAction: WindowsServiceSnapshot[] = [];
  let rollbackInFlight: Promise<void> | undefined;
  const validate = async (): Promise<void> => {
    const now = windowsServiceClock(control);
    validated = await discoverWindowsServices(
      paths,
      plan,
      control,
      now() + WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
    );
  };
  const performRollback = async (): Promise<void> => {
    assertCommandTerminationConfirmed();
    if (stoppedByAction.length === 0 && disabledByAction.length === 0) return;
    const pending = [...stoppedByAction];
    const pendingDisabled = [...disabledByAction];
    const restored = new Set<WindowsServiceSnapshot>();
    const startTypesRestored = new Set<WindowsServiceSnapshot>();
    const failures: string[] = [];
    const rollbackNow = windowsServiceClock(control);
    const rollbackDeadline =
      rollbackNow() + WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS;
    const rollbackRemaining = (): number =>
      windowsServiceCoordinationRemainingMilliseconds(
        rollbackNow,
        rollbackDeadline,
        "Windows service rollback",
      );
    const rollbackTask = async <T>(
      task: (timeoutMs: number) => Promise<T>,
    ): Promise<T> => await runWindowsDeadlineTask(rollbackRemaining, task);
    for (const target of [...pendingDisabled].reverse()) {
      assertCommandTerminationConfirmed();
      try {
        if (
          target.component === "docker-engine" &&
          lifecycle?.isRegistrationFinalized(target.component) === true
        ) {
          startTypesRestored.add(target);
          continue;
        }
        if (
          target.startType === undefined ||
          target.startSetting === undefined ||
          target.configuration === undefined ||
          target.executable === undefined ||
          target.executableIdentity === undefined ||
          control.config === undefined ||
          control.configureStart === undefined ||
          control.inspectExecutable === undefined
        ) {
          throw new Error(
            `${target.serviceName} start mode cannot be restored safely`,
          );
        }
        const before = await rollbackTask(
          async (timeoutMs) =>
            await control.config?.(target.serviceName, timeoutMs),
        );
        if (before === undefined) {
          throw new Error(`${target.serviceName} configuration is unavailable`);
        }
        assertCompleteWindowsCommandOutput(
          before,
          `${target.serviceName} rollback configuration`,
        );
        if (before.exitCode !== 0) {
          throw windowsServiceFailure(paths, target.serviceName, before);
        }
        const beforeExecutable = parseAndValidateWindowsServiceExecutable(
          paths,
          target.component,
          target.serviceName,
          before.stdout,
        );
        if (
          !sameWindowsPath(beforeExecutable, target.executable) ||
          windowsServiceConfigurationWithoutStartType(before.stdout) !==
            windowsServiceConfigurationWithoutStartType(target.configuration)
        ) {
          throw new Error(
            `${target.serviceName} configuration changed before start-mode rollback`,
          );
        }
        const beforeIdentity = await rollbackTask(
          async () => await control.inspectExecutable?.(beforeExecutable),
        );
        if (
          !sameWindowsPathIdentity(target.executableIdentity, beforeIdentity)
        ) {
          throw new Error(
            `${target.serviceName} executable identity changed before start-mode rollback`,
          );
        }
        const restoredStart = await rollbackTask(
          async (timeoutMs) =>
            await control.configureStart?.(
              target.serviceName,
              target.startSetting!,
              timeoutMs,
            ),
        );
        if (restoredStart === undefined) {
          throw new Error(
            `${target.serviceName} start mode cannot be restored safely`,
          );
        }
        assertCompleteWindowsCommandOutput(
          restoredStart,
          `${target.serviceName} start-mode rollback`,
        );
        if (restoredStart.exitCode !== 0) {
          throw windowsServiceFailure(paths, target.serviceName, restoredStart);
        }
        const after = await rollbackTask(
          async (timeoutMs) =>
            await control.config?.(target.serviceName, timeoutMs),
        );
        if (after === undefined) {
          throw new Error(`${target.serviceName} configuration is unavailable`);
        }
        assertCompleteWindowsCommandOutput(
          after,
          `${target.serviceName} restored configuration`,
        );
        if (
          after.exitCode !== 0 ||
          windowsServiceStartType(after.stdout) !== target.startType ||
          windowsServiceStartConfiguration(after.stdout)?.startSetting !==
            target.startSetting ||
          normalizedWindowsServiceConfiguration(after.stdout) !==
            target.configuration
        ) {
          throw new Error(
            `${target.serviceName} did not return to its original start mode`,
          );
        }
        startTypesRestored.add(target);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    const remainingDisabled = pendingDisabled.filter(
      (target) => !startTypesRestored.has(target),
    );
    for (const target of [...pending].reverse()) {
      assertCommandTerminationConfirmed();
      try {
        if (
          target.component === "docker-engine" &&
          lifecycle?.isRegistrationFinalized(target.component) === true
        ) {
          restored.add(target);
          continue;
        }
        if (remainingDisabled.includes(target)) {
          throw new Error(
            `${target.serviceName} start mode was not restored before restart`,
          );
        }
        const current = await rollbackTask(
          async (timeoutMs) =>
            await control.query(target.serviceName, timeoutMs),
        );
        assertCompleteWindowsCommandOutput(
          current,
          `${target.serviceName} rollback query`,
        );
        if (isMissingWindowsService(current)) {
          throw new Error(`${target.serviceName} disappeared before restart`);
        }
        if (current.exitCode !== 0) {
          throw windowsServiceFailure(paths, target.serviceName, current);
        }
        const currentState = windowsServiceState(current);
        if (currentState !== 1 && currentState !== 4) {
          throw new Error(
            `${target.serviceName} entered an unsafe state before restart`,
          );
        }
        if (target.state === 1) {
          if (currentState === 4) {
            await stopWindowsService(
              paths,
              { ...target, state: currentState },
              control,
              rollbackDeadline,
              "Windows service rollback",
            );
            const stopped = await rollbackTask(
              async (timeoutMs) =>
                await control.query(target.serviceName, timeoutMs),
            );
            assertCompleteWindowsCommandOutput(
              stopped,
              `${target.serviceName} stopped-state rollback query`,
            );
            if (
              isMissingWindowsService(stopped) ||
              !isStoppedWindowsService(stopped)
            ) {
              throw new Error(
                `${target.serviceName} did not return to its original stopped state`,
              );
            }
          }
          restored.add(target);
          continue;
        }
        if (currentState === 4) {
          restored.add(target);
          continue;
        }
        if (control.start === undefined) {
          throw new Error(`${target.serviceName} could not be restarted`);
        }
        if (
          target.configuration === undefined ||
          target.executable === undefined ||
          target.executableIdentity === undefined ||
          control.config === undefined ||
          control.inspectExecutable === undefined
        ) {
          throw new Error(
            `${target.serviceName} configuration and executable identity cannot be revalidated before restart`,
          );
        }
        const configuration = await rollbackTask(
          async (timeoutMs) =>
            await control.config?.(target.serviceName, timeoutMs),
        );
        if (configuration === undefined) {
          throw new Error(`${target.serviceName} configuration is unavailable`);
        }
        assertCompleteWindowsCommandOutput(
          configuration,
          `${target.serviceName} rollback configuration`,
        );
        if (configuration.exitCode !== 0) {
          throw windowsServiceFailure(paths, target.serviceName, configuration);
        }
        const executable = parseAndValidateWindowsServiceExecutable(
          paths,
          target.component,
          target.serviceName,
          configuration.stdout,
        );
        if (
          !sameWindowsPath(executable, target.executable) ||
          normalizedWindowsServiceConfiguration(configuration.stdout) !==
            target.configuration
        ) {
          throw new Error(
            `${target.serviceName} configuration changed before rollback`,
          );
        }
        const executableIdentity = await rollbackTask(
          async () => await control.inspectExecutable?.(executable),
        );
        if (
          !sameWindowsPathIdentity(
            target.executableIdentity,
            executableIdentity,
          )
        ) {
          throw new Error(
            `${target.serviceName} executable identity changed before rollback`,
          );
        }

        const now = windowsServiceClock(control);
        const deadline = Math.min(
          rollbackDeadline,
          now() + WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS,
        );
        const description = `${target.serviceName} service restart`;
        const transitionRemaining = (): number => {
          rollbackRemaining();
          return windowsServiceRemainingMilliseconds(
            now,
            deadline,
            description,
          );
        };
        const started = await runWindowsDeadlineTask(
          transitionRemaining,
          async (timeoutMs) =>
            await control.start?.(target.serviceName, timeoutMs),
        );
        if (started === undefined) {
          throw new Error(`${target.serviceName} could not be restarted`);
        }
        if (started.exitCode !== 0 && started.exitCode !== 1056) {
          throw windowsServiceFailure(paths, target.serviceName, started);
        }

        let running = false;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const currentResult = await runWindowsDeadlineTask(
            transitionRemaining,
            async (timeoutMs) =>
              await control.query(target.serviceName, timeoutMs),
          );
          assertCompleteWindowsCommandOutput(
            currentResult,
            `${target.serviceName} rollback query`,
          );
          if (isMissingWindowsService(currentResult)) {
            throw new Error(
              `${target.serviceName} disappeared while restarting`,
            );
          }
          if (currentResult.exitCode !== 0) {
            throw windowsServiceFailure(
              paths,
              target.serviceName,
              currentResult,
            );
          }
          const state = windowsServiceState(currentResult);
          if (state === 4) {
            running = true;
            break;
          }
          if (state !== 2 && state !== 3) break;
          await runWindowsDeadlineTask(
            transitionRemaining,
            async (timeoutMs) => await wait(Math.min(500, timeoutMs)),
          );
        }
        if (!running) {
          throw new Error(
            `${target.serviceName} did not reach RUNNING during rollback`,
          );
        }
        restored.add(target);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    const remainingStopped = pending.filter((target) => !restored.has(target));
    if (failures.length > 0) {
      disabledByAction = remainingDisabled;
      stoppedByAction = remainingStopped;
      throw new Error(failures.join("; "));
    }
    rollbackRemaining();
    disabledByAction = remainingDisabled;
    stoppedByAction = remainingStopped;
    quiescedExpected = undefined;
  };
  const rollback = async (): Promise<void> => {
    if (rollbackInFlight !== undefined) {
      await rollbackInFlight;
      return;
    }
    const currentRollback = performRollback();
    rollbackInFlight = currentRollback;
    try {
      await currentRollback;
    } finally {
      if (rollbackInFlight === currentRollback) rollbackInFlight = undefined;
    }
  };
  const failWithRollback = async (detail: string): Promise<OperationResult> => {
    try {
      await rollback();
      return { status: "failed", detail };
    } catch (error) {
      const rollbackDetail =
        error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        detail: `${detail}; rollback: ${rollbackDetail}`,
      };
    }
  };
  const assertQuiesced = async (options?: {
    readonly allowMissingTransitions?: boolean;
  }): Promise<void> => {
    if (quiescedExpected === undefined) {
      throw new Error("Windows services have not completed safe quiescence");
    }
    await assertWindowsServicesQuiesced(
      paths,
      plan,
      control,
      quiescedExpected,
      lifecycle,
      options?.allowMissingTransitions === true,
    );
  };
  const operation = createFunctionOperation({
    id: "windows:services:stop",
    component,
    description: "Stop selected Windows services before cleanup",
    phase: "preflight",
    dedupeKey: "windows:services:stop",
    fatal: true,
    validate,
    validateAfterPreflight: async () => await assertQuiesced(),
    validateAfterPreflightLast: true,
    rollback,
    run: async (): Promise<OperationResult> => {
      if (stoppedByAction.length !== 0 || disabledByAction.length !== 0) {
        return await failWithRollback(
          "Windows service rollback state remained before execution",
        );
      }
      try {
        const now = windowsServiceClock(control);
        const deadline = now() + WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS;
        validated ??= await discoverWindowsServices(
          paths,
          plan,
          control,
          deadline,
        );
        const immediate = await discoverWindowsServices(
          paths,
          plan,
          control,
          deadline,
        );
        if (!sameWindowsServiceSnapshot(validated, immediate)) {
          return await failWithRollback(
            "Windows service inventory changed after plan validation",
          );
        }
        for (const target of immediate) {
          if (target.status === "present") {
            // Record restoration intent before any command. Disabling an
            // originally stopped service can race an in-flight SCM start, and
            // even a failed command can have changed service state.
            stoppedByAction.push(target);
          }
          if (target.status === "present" && target.startType !== 4) {
            if (control.configureStart === undefined) {
              return await failWithRollback(
                `${target.serviceName} start mode cannot be disabled safely`,
              );
            }
            // Record before the command: sc.exe can change the start mode and
            // still report a failure or lose its output channel.
            disabledByAction.push(target);
            const coordinationRemaining = (): number =>
              windowsServiceCoordinationRemainingMilliseconds(
                now,
                deadline,
                "Windows service coordination",
              );
            const disabled = await runWindowsDeadlineTask(
              coordinationRemaining,
              async (timeoutMs) =>
                await control.configureStart?.(
                  target.serviceName,
                  "disabled",
                  timeoutMs,
                ),
            );
            if (disabled === undefined) {
              return await failWithRollback(
                `${target.serviceName} start mode cannot be disabled safely`,
              );
            }
            assertCompleteWindowsCommandOutput(
              disabled,
              `${target.serviceName} start-mode latch`,
            );
            if (disabled.exitCode !== 0) {
              return await failWithRollback(
                failureDetail(
                  disabled.stderr || disabled.stdout,
                  paths.serviceControl,
                  disabled.exitCode,
                ),
              );
            }
          }
          await stopWindowsService(paths, target, control, deadline);
        }
        await assertWindowsServicesQuiesced(
          paths,
          plan,
          control,
          immediate,
          lifecycle,
          false,
          deadline,
        );
        quiescedExpected = immediate;
        // Preflight never unregisters a service. Docker owns its terminal
        // registration transition; the package-phase finalizer removes exact
        // Apache, Nginx, and PostgreSQL registrations after uninstallers run.
        return immediate.some(({ status }) => status === "present")
          ? { status: "removed" }
          : { status: "not-found" };
      } catch (error) {
        return await failWithRollback(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
  return Object.assign(operation, { assertQuiesced });
}

const WINDOWS_SERVICE_REGISTRATION_COMPONENTS = new Set<ComponentId>([
  "apache",
  "nginx",
  "postgresql",
]);

const WINDOWS_SERVICE_GUARDED_COMPONENTS = new Set<ComponentId>([
  "docker-engine",
  ...WINDOWS_SERVICE_REGISTRATION_COMPONENTS,
]);

function windowsServiceRegistrationPlan(plan: CleanupPlan): CleanupPlan {
  return {
    ...plan,
    enabled: new Set(
      [...plan.enabled].filter((component) =>
        WINDOWS_SERVICE_REGISTRATION_COMPONENTS.has(component),
      ),
    ),
  };
}

async function currentPostgreSqlServiceNames(
  paths: WindowsPaths,
  control: WindowsServiceControl,
  deadline = windowsServiceClock(control)() +
    WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
): Promise<readonly string[]> {
  const now = windowsServiceClock(control);
  const remaining = (): number =>
    windowsServiceCoordinationRemainingMilliseconds(
      now,
      deadline,
      "Windows service registration cleanup",
    );
  const inventory = await runWindowsDeadlineTask(
    remaining,
    async (timeoutMs) => await control.inventory(timeoutMs),
  );
  assertCompleteWindowsCommandOutput(inventory, "Windows service inventory");
  if (inventory.exitCode !== 0) {
    throw windowsServiceFailure(paths, "PostgreSQL inventory", inventory);
  }
  const classified = classifyPostgreSqlServiceInventory(
    `${inventory.stdout}\n${inventory.stderr}`,
  );
  if (classified.status === "unsafe") throw new Error(classified.detail);
  remaining();
  return classified.serviceNames;
}

async function assertWindowsServiceReadyForRegistrationDeletion(
  paths: WindowsPaths,
  expected: WindowsServiceSnapshot,
  control: WindowsServiceControl,
  aggregateDeadline = windowsServiceClock(control)() +
    WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
): Promise<"missing" | "present"> {
  const aggregateNow = windowsServiceClock(control);
  const remaining = (): number =>
    windowsServiceCoordinationRemainingMilliseconds(
      aggregateNow,
      aggregateDeadline,
      "Windows service registration cleanup",
    );
  const current = await runWindowsDeadlineTask(
    remaining,
    async (timeoutMs) => await control.query(expected.serviceName, timeoutMs),
  );
  assertCompleteWindowsCommandOutput(
    current,
    `${expected.serviceName} service query`,
  );
  if (isMissingWindowsService(current)) return "missing";
  if (isWindowsServiceDeletionPending(current)) {
    const wait =
      control.wait ??
      (async (milliseconds: number) =>
        await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const now = windowsServiceClock(control);
    const deadline = Math.min(
      aggregateDeadline,
      now() + WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS,
    );
    const transitionRemaining =
      (description: string): (() => number) =>
      () => {
        remaining();
        return windowsServiceRemainingMilliseconds(now, deadline, description);
      };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const description = `${expected.serviceName} service registration deletion`;
      const taskRemaining = transitionRemaining(description);
      await runWindowsDeadlineTask(
        taskRemaining,
        async (timeoutMs) => await wait(Math.min(500, timeoutMs)),
      );
      const pending = await runWindowsDeadlineTask(
        taskRemaining,
        async (timeoutMs) =>
          await control.query(expected.serviceName, timeoutMs),
      );
      assertCompleteWindowsCommandOutput(
        pending,
        `${expected.serviceName} service deletion verification`,
      );
      if (isMissingWindowsService(pending)) return "missing";
      if (!isWindowsServiceDeletionPending(pending)) {
        throw new Error(
          `${expected.serviceName}: pending service deletion changed state before completion`,
        );
      }
    }
    throw new Error(
      `${expected.serviceName}: service remained marked for deletion after 30 seconds`,
    );
  }
  if (current.exitCode !== 0) {
    throw windowsServiceFailure(paths, expected.serviceName, current);
  }
  if (expected.status === "missing") {
    throw new Error(
      `${expected.serviceName}: service registration appeared after plan validation`,
    );
  }
  if (!isStoppedWindowsService(current)) {
    throw new Error(
      `${expected.serviceName}: service reactivated before registration cleanup`,
    );
  }
  if (
    expected.configuration === undefined ||
    expected.executable === undefined ||
    expected.executableIdentity === undefined ||
    control.config === undefined ||
    control.inspectExecutable === undefined
  ) {
    throw new Error(
      `${expected.serviceName}: validated service identity is unavailable`,
    );
  }
  const configuration = await runWindowsDeadlineTask(
    remaining,
    async (timeoutMs) =>
      await control.config?.(expected.serviceName, timeoutMs),
  );
  if (configuration === undefined) {
    throw new Error(
      `${expected.serviceName}: service configuration is unavailable`,
    );
  }
  assertCompleteWindowsCommandOutput(
    configuration,
    `${expected.serviceName} service configuration`,
  );
  if (configuration.exitCode !== 0) {
    throw windowsServiceFailure(paths, expected.serviceName, configuration);
  }
  const executable = parseAndValidateWindowsServiceExecutable(
    paths,
    expected.component,
    expected.serviceName,
    configuration.stdout,
  );
  if (windowsServiceStartType(configuration.stdout) !== 4) {
    throw new Error(
      `${expected.serviceName}: service lost its disabled latch before registration cleanup`,
    );
  }
  if (
    !sameWindowsPath(executable, expected.executable) ||
    windowsServiceConfigurationWithoutStartType(configuration.stdout) !==
      windowsServiceConfigurationWithoutStartType(expected.configuration)
  ) {
    throw new Error(
      `${expected.serviceName}: service configuration changed after plan validation`,
    );
  }
  const executableIdentity = await runWindowsDeadlineTask(
    remaining,
    async () => await control.inspectExecutable?.(executable),
  );
  if (
    executableIdentity !== undefined &&
    !sameWindowsPathIdentity(expected.executableIdentity, executableIdentity)
  ) {
    throw new Error(
      `${expected.serviceName}: service executable changed after plan validation`,
    );
  }
  return "present";
}

export function createWindowsServiceRegistrationCleanup(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl = windowsServiceControl(paths),
  lifecycle?: WindowsServiceRegistrationLifecycle,
): Operation | undefined {
  const registrationPlan = windowsServiceRegistrationPlan(plan);
  const fixed = selectedFixedWindowsServices(registrationPlan);
  if (fixed.length === 0 && !registrationPlan.enabled.has("postgresql")) {
    return undefined;
  }
  const component = fixed[0]?.component ?? "postgresql";
  const wait =
    control.wait ??
    (async (milliseconds: number) =>
      await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let validated: readonly WindowsServiceSnapshot[] | undefined;

  const validate = async (): Promise<void> => {
    const now = windowsServiceClock(control);
    validated = await discoverWindowsServices(
      paths,
      registrationPlan,
      control,
      now() + WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
    );
  };

  const preflightDeletion = async (
    deadline = windowsServiceClock(control)() +
      WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
  ): Promise<readonly WindowsServiceSnapshot[]> => {
    validated ??= await discoverWindowsServices(
      paths,
      registrationPlan,
      control,
      deadline,
    );
    let currentPostgreSqlNames: readonly string[] = [];
    if (registrationPlan.enabled.has("postgresql")) {
      currentPostgreSqlNames = await currentPostgreSqlServiceNames(
        paths,
        control,
        deadline,
      );
      const expectedNames = new Set(
        validated
          .filter(({ component }) => component === "postgresql")
          .map(({ serviceName }) => serviceName.toLowerCase()),
      );
      const unexpected = currentPostgreSqlNames.find(
        (serviceName) => !expectedNames.has(serviceName.toLowerCase()),
      );
      if (unexpected !== undefined) {
        throw new Error(
          `PostgreSQL service inventory changed after plan validation: ${unexpected}`,
        );
      }
    }
    const currentPostgreSqlSet = new Set(
      currentPostgreSqlNames.map((serviceName) => serviceName.toLowerCase()),
    );
    const present: WindowsServiceSnapshot[] = [];
    for (const expected of validated) {
      const status = await assertWindowsServiceReadyForRegistrationDeletion(
        paths,
        expected,
        control,
        deadline,
      );
      if (
        status === "present" &&
        expected.component === "postgresql" &&
        !currentPostgreSqlSet.has(expected.serviceName.toLowerCase())
      ) {
        throw new Error(
          `${expected.serviceName}: service inventory omitted a registered PostgreSQL service`,
        );
      }
      if (status === "present") present.push(expected);
    }
    return present;
  };

  return createFunctionOperation({
    id: "windows:services:unregister",
    component,
    description: "Remove selected stale Windows service registrations",
    phase: "package",
    dedupeKey: "windows:services:unregister",
    validate,
    run: async (): Promise<OperationResult> => {
      try {
        const now = windowsServiceClock(control);
        const aggregateDeadline =
          now() + WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS;
        const remaining = (): number =>
          windowsServiceCoordinationRemainingMilliseconds(
            now,
            aggregateDeadline,
            "Windows service registration cleanup",
          );
        const present = await preflightDeletion(aggregateDeadline);
        let removed = false;
        for (const expected of present) {
          assertCommandTerminationConfirmed();
          const immediate =
            await assertWindowsServiceReadyForRegistrationDeletion(
              paths,
              expected,
              control,
              aggregateDeadline,
            );
          if (immediate === "missing") continue;
          const transitionNow = windowsServiceClock(control);
          const description = `${expected.serviceName} service registration deletion`;
          const deadline = Math.min(
            aggregateDeadline,
            transitionNow() + WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS,
          );
          const transitionRemaining = (): number => {
            remaining();
            return windowsServiceRemainingMilliseconds(
              transitionNow,
              deadline,
              description,
            );
          };
          const deletion = await runWindowsDeadlineTask(
            transitionRemaining,
            async (timeoutMs) =>
              await control.delete(expected.serviceName, timeoutMs),
          );
          assertCompleteWindowsCommandOutput(
            deletion,
            `${expected.serviceName} service deletion`,
          );
          if (
            deletion.exitCode !== 0 &&
            !isMissingWindowsService(deletion) &&
            !isWindowsServiceDeletionPending(deletion)
          ) {
            throw windowsServiceFailure(paths, expected.serviceName, deletion);
          }

          let absent = false;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const current = await runWindowsDeadlineTask(
              transitionRemaining,
              async (timeoutMs) =>
                await control.query(expected.serviceName, timeoutMs),
            );
            assertCompleteWindowsCommandOutput(
              current,
              `${expected.serviceName} service deletion verification`,
            );
            if (isMissingWindowsService(current)) {
              absent = true;
              removed = true;
              break;
            }
            if (
              current.exitCode !== 0 &&
              !isWindowsServiceDeletionPending(current)
            ) {
              throw windowsServiceFailure(paths, expected.serviceName, current);
            }
            await runWindowsDeadlineTask(
              transitionRemaining,
              async (timeoutMs) => await wait(Math.min(500, timeoutMs)),
            );
          }
          if (!absent) {
            throw new Error(
              `${expected.serviceName}: service remained registered after deletion`,
            );
          }
        }

        const finalPresent = await preflightDeletion(aggregateDeadline);
        remaining();
        if (finalPresent.length !== 0) {
          throw new Error(
            `Windows service registration reappeared after cleanup: ${finalPresent
              .map(({ serviceName }) => serviceName)
              .join(", ")}`,
          );
        }
        for (const component of WINDOWS_SERVICE_REGISTRATION_COMPONENTS) {
          if (registrationPlan.enabled.has(component)) {
            lifecycle?.finalizeRegistration(component);
          }
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

export async function listWindowsVersionedDirectories(
  parent: string,
  pattern: RegExp,
): Promise<readonly string[]> {
  const description = `versioned directory inventory under '${parent}'`;
  if (process.platform !== "win32" && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(parent)) {
    return [];
  }
  const hostPathStyle = process.platform === "win32" ? "win32" : "posix";
  const normalizedParent =
    hostPathStyle === "win32"
      ? win32.normalize(parent)
      : posix.normalize(parent);
  const entries = await listBoundedVersionedDirectoryEntries(
    normalizedParent,
    pattern,
    hostPathStyle,
    description,
  );
  return entries.map(({ name }) =>
    hostPathStyle === "win32"
      ? win32.join(parent, name)
      : posix.join(parent, name),
  );
}

export async function listChocolateyPackages(
  executable: string,
  environment: NodeJS.ProcessEnv = windowsPaths().chocolateyEnvironment,
  dependencies: WindowsInventoryDependencies = {},
): Promise<WindowsChocolateyInventory> {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const budget =
    dependencies.inventoryBudget ?? createWindowsInventoryBudget(dependencies);
  return await budget.run("Chocolatey package inventory", async (remaining) => {
    const executableIdentity = await inspect(executable);
    remaining();
    if (executableIdentity === undefined) {
      throw new Error(`Chocolatey executable is unavailable: ${executable}`);
    }
    if (
      dependencies.expectedInventoryExecutable !== undefined &&
      !sameWindowsPathIdentity(
        dependencies.expectedInventoryExecutable,
        executableIdentity,
      )
    ) {
      throw new Error("Chocolatey executable changed before package inventory");
    }
    const result = await execute(
      executable,
      // Chocolatey 2 made `list` local-only and removed --local-only. Hosted
      // Windows images use Chocolatey 2+, so avoid the removed compatibility flag.
      ["list", "--limit-output", "--no-color"],
      {
        env: environment,
        silent: true,
        timeoutMs: remaining(),
      },
    );
    remaining();
    if (result.exitCode !== 0) {
      throw new Error(
        failureDetail(
          result.stderr || result.stdout,
          executable,
          result.exitCode,
        ),
      );
    }
    if (result.stdoutTruncated === true || result.stderrTruncated === true) {
      throw new Error(
        "Chocolatey package inventory exceeded the safe output bound",
      );
    }
    const currentExecutable = await inspect(executable);
    remaining();
    if (!sameWindowsPathIdentity(executableIdentity, currentExecutable)) {
      throw new Error(
        "Chocolatey executable changed while reading package inventory",
      );
    }

    const versions = new Map<string, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const separator = line.indexOf("|");
      if (separator === -1 || separator !== line.lastIndexOf("|")) {
        throw new Error(
          "Chocolatey returned an unsafe package inventory record",
        );
      }
      const name = line.slice(0, separator).trim().toLowerCase();
      const version = line.slice(separator + 1).trim();
      if (
        !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) ||
        version === "" ||
        version.length > 128
      ) {
        throw new Error(
          "Chocolatey returned an unsafe package inventory record",
        );
      }
      const existing = versions.get(name);
      if (existing !== undefined && existing !== version) {
        throw new Error(`Chocolatey returned conflicting versions for ${name}`);
      }
      versions.set(name, version);
    }
    return {
      packages: new Set(versions.keys()),
      versions,
      executable: executableIdentity,
    };
  });
}

export interface WindowsChocolateyInventory {
  readonly packages: ReadonlySet<string>;
  readonly versions: ReadonlyMap<string, string>;
  readonly executable: WindowsPathIdentity;
}

export function createWindowsChocolateyOperation(
  paths: WindowsPaths,
  component: ComponentId,
  packageNames: readonly string[],
  installedPackages: AsyncValue<WindowsChocolateyInventory>,
  dedupeKey?: string,
  dependencies: WindowsInventoryDependencies = {},
): Operation {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const inventoryDependencies: WindowsInventoryDependencies = {
    ...dependencies,
    inventoryBudget: createWindowsInventoryBudget(dependencies),
  };
  return createFunctionOperation({
    id: `windows:choco:${component}:${packageNames.join(",")}`,
    component,
    description: `Uninstall ${packageNames.join(", ")} with Chocolatey`,
    phase: "package",
    dedupeKey: dedupeKey ?? `windows:choco:${packageNames.join(",")}`,
    validate: async () => {
      await installedPackages();
    },
    run: async (): Promise<OperationResult> => {
      const installed = await installedPackages();
      const current = await inspect(paths.chocolatey);
      if (!sameWindowsPathIdentity(installed.executable, current)) {
        return {
          status: "failed",
          detail: "Chocolatey executable changed after plan validation",
        };
      }
      const selected = packageNames.filter((name) =>
        installed.packages.has(name.toLowerCase()),
      );
      if (selected.length === 0) return { status: "not-found" };

      let removed = 0;
      for (const name of selected) {
        const canonicalName = name.toLowerCase();
        const expectedVersion = installed.versions.get(canonicalName);
        if (expectedVersion === undefined) {
          return {
            status: "failed",
            detail: `Chocolatey inventory has no version for ${name}`,
          };
        }
        const fresh = await listChocolateyPackages(
          paths.chocolatey,
          paths.chocolateyEnvironment,
          {
            ...inventoryDependencies,
            expectedInventoryExecutable: installed.executable,
          },
        );
        if (fresh.versions.get(canonicalName) !== expectedVersion) {
          return {
            status: "failed",
            detail: `Chocolatey package ${name} changed after plan validation`,
          };
        }
        const beforeSpawn = await inspect(paths.chocolatey);
        if (!sameWindowsPathIdentity(installed.executable, beforeSpawn)) {
          return {
            status: "failed",
            detail: "Chocolatey executable changed immediately before spawn",
          };
        }
        const result = await execute(
          paths.chocolatey,
          [
            "uninstall",
            name,
            "--version",
            expectedVersion,
            "--exact",
            "--yes",
            "--no-progress",
            "--limit-output",
          ],
          {
            env: paths.chocolateyEnvironment,
            silent: false,
            timeoutMs: 20 * 60_000,
          },
        );
        const disposition = windowsInstallerExitDisposition(result.exitCode);
        if (
          disposition === "restart-required" ||
          disposition === "restart-initiated"
        ) {
          return restartResult(paths.chocolatey, disposition);
        }
        if (disposition === "failed") {
          return {
            status: "failed",
            detail: failureDetail(
              result.stderr,
              paths.chocolatey,
              result.exitCode,
            ),
          };
        }
        const after = await listChocolateyPackages(
          paths.chocolatey,
          paths.chocolateyEnvironment,
          {
            ...inventoryDependencies,
            expectedInventoryExecutable: installed.executable,
          },
        );
        if (after.packages.has(canonicalName)) {
          return {
            status: "failed",
            detail: `Chocolatey package ${name} remained installed after uninstall`,
          };
        }
        removed += 1;
      }
      return removed === 0
        ? { status: "not-found" }
        : { status: "removed", detail: selected.join(", ") };
    },
  });
}

export const UNINSTALL_REGISTRY_ROOTS = Object.freeze([
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const);

export function parseWindowsUninstallRecords(
  output: string,
): readonly WindowsUninstallRecord[] {
  const classificationFields = new Set([
    "displayname",
    "displayversion",
    "bundlecachepath",
    "windowsinstaller",
  ]);
  const records: WindowsUninstallRecord[] = [];
  let currentKey: string | undefined;
  let values = new Map<string, string>();
  let valueTypes = new Map<string, string>();
  const flush = (): void => {
    if (currentKey === undefined) return;
    const displayName = values.get("displayname");
    const displayVersion = values.get("displayversion");
    const bundleCachePath = values.get("bundlecachepath");
    const windowsInstallerText = values.get("windowsinstaller");
    let windowsInstaller: number | undefined;
    if (windowsInstallerText !== undefined) {
      if (valueTypes.get("windowsinstaller") !== "DWORD") {
        throw new Error(
          `WindowsInstaller has an unsupported registry type in '${currentKey}'`,
        );
      }
      windowsInstaller = /^0x[0-9a-f]+$/i.test(windowsInstallerText)
        ? Number.parseInt(windowsInstallerText.slice(2), 16)
        : /^\d+$/.test(windowsInstallerText)
          ? Number.parseInt(windowsInstallerText, 10)
          : undefined;
      if (windowsInstaller === undefined) {
        throw new Error(
          `WindowsInstaller has an invalid registry value in '${currentKey}'`,
        );
      }
    }
    records.push({
      registryKey: currentKey,
      ...(displayName === undefined ? {} : { displayName }),
      ...(displayVersion === undefined ? {} : { displayVersion }),
      ...(bundleCachePath === undefined ? {} : { bundleCachePath }),
      ...(windowsInstaller === undefined ? {} : { windowsInstaller }),
    });
  };

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^HKEY_[A-Z_]+\\/i.test(trimmed)) {
      flush();
      currentKey = trimmed;
      values = new Map<string, string>();
      valueTypes = new Map<string, string>();
      continue;
    }
    if (currentKey === undefined) continue;
    const value = /^\s*([^\s]+)\s+REG_([A-Z0-9_]+)\s+(.*?)\s*$/i.exec(line);
    const name = value?.[1];
    const type = value?.[2];
    const contents = value?.[3];
    if (name !== undefined && type !== undefined && contents !== undefined) {
      const normalizedName = name.toLowerCase();
      if (!classificationFields.has(normalizedName)) continue;
      if (values.has(normalizedName)) {
        throw new Error(
          `${name} has a duplicate registry value in '${currentKey}'`,
        );
      }
      const normalizedType = type.toUpperCase();
      if (
        normalizedName === "windowsinstaller"
          ? normalizedType !== "DWORD"
          : normalizedType !== "SZ" && normalizedType !== "EXPAND_SZ"
      ) {
        throw new Error(
          `${name} has an unsupported registry type in '${currentKey}'`,
        );
      }
      values.set(normalizedName, contents);
      valueTypes.set(normalizedName, normalizedType);
      continue;
    }
    const malformedName = /^\s*([^\s]+)/.exec(line)?.[1];
    if (
      malformedName !== undefined &&
      classificationFields.has(malformedName.toLowerCase())
    ) {
      throw new Error(
        `${malformedName} has a malformed registry value in '${currentKey}'`,
      );
    }
  }
  flush();
  return records;
}

function msiProductFromRecord(
  record: WindowsUninstallRecord,
): MsiProduct | undefined {
  const productCode = win32.basename(record.registryKey);
  if (
    !/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(
      productCode,
    ) ||
    record.displayName === undefined ||
    record.windowsInstaller !== 1
  ) {
    return undefined;
  }
  return {
    registryKey: record.registryKey,
    productCode,
    displayName: record.displayName,
    windowsInstaller: 1,
  };
}

export interface WindowsMsiInventory {
  readonly products: readonly MsiProduct[];
  readonly registryExecutable: WindowsPathIdentity;
}

export interface WindowsUninstallInventory {
  readonly records: readonly WindowsUninstallRecord[];
  readonly registryExecutable: WindowsPathIdentity;
}

function isMissingRegistryValue(result: CommandResult): boolean {
  return (
    result.exitCode === 1 &&
    /The system was unable to find the specified registry key or value\.?/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

export async function listWindowsUninstallRecords(
  paths: WindowsPaths,
  dependencies: WindowsInventoryDependencies = {},
): Promise<WindowsUninstallInventory> {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const budget =
    dependencies.inventoryBudget ?? createWindowsInventoryBudget(dependencies);
  return await budget.run(
    "Windows uninstall registry inventory",
    async (remaining) => {
      const registryExecutable = await inspect(paths.reg);
      remaining();
      if (registryExecutable === undefined) {
        throw new Error(`reg.exe is unavailable at ${paths.reg}`);
      }
      const byKey = new Map<string, WindowsUninstallRecord>();
      for (const root of UNINSTALL_REGISTRY_ROOTS) {
        remaining();
        const result = await execute(paths.reg, ["query", root, "/s"], {
          env: paths.commandEnvironment,
          silent: true,
          timeoutMs: remaining(),
        });
        remaining();
        if (isMissingRegistryValue(result)) continue;
        if (result.exitCode !== 0) {
          throw new Error(
            failureDetail(
              result.stderr || result.stdout,
              paths.reg,
              result.exitCode,
            ),
          );
        }
        if (
          result.stdoutTruncated === true ||
          result.stderrTruncated === true
        ) {
          throw new Error(
            "uninstall registry inventory exceeded the safe output bound",
          );
        }
        for (const record of parseWindowsUninstallRecords(result.stdout)) {
          const key = win32.normalize(record.registryKey).toLowerCase();
          const existing = byKey.get(key);
          if (
            existing !== undefined &&
            !sameWindowsUninstallRecord(existing, record)
          ) {
            throw new Error(
              `uninstall registry returned conflicting records for '${record.registryKey}'`,
            );
          }
          byKey.set(key, record);
        }
      }
      remaining();
      const currentRegistryExecutable = await inspect(paths.reg);
      remaining();
      if (
        !sameWindowsPathIdentity(registryExecutable, currentRegistryExecutable)
      ) {
        throw new Error(
          "reg.exe changed while reading the installed product list",
        );
      }
      return {
        records: [...byKey.values()],
        registryExecutable,
      };
    },
  );
}

export async function listMsiProducts(
  paths: WindowsPaths,
  dependencies: WindowsInventoryDependencies = {},
): Promise<WindowsMsiInventory> {
  const inventory = await listWindowsUninstallRecords(paths, dependencies);
  return {
    products: msiProductsFromRecords(inventory.records),
    registryExecutable: inventory.registryExecutable,
  };
}

function msiProductsFromRecords(
  records: readonly WindowsUninstallRecord[],
): readonly MsiProduct[] {
  const byCode = new Map<string, MsiProduct>();
  for (const record of records) {
    const product = msiProductFromRecord(record);
    if (product !== undefined) {
      const key = product.productCode.toLowerCase();
      const existing = byCode.get(key);
      if (
        existing !== undefined &&
        (win32.normalize(existing.registryKey).toLowerCase() !==
          win32.normalize(product.registryKey).toLowerCase() ||
          existing.displayName !== product.displayName ||
          existing.windowsInstaller !== product.windowsInstaller)
      ) {
        throw new Error(
          `uninstall registry returned conflicting MSI product code '${product.productCode}'`,
        );
      }
      byCode.set(key, product);
    }
  }
  return [...byCode.values()];
}

async function readExactUninstallRecord(
  paths: WindowsPaths,
  registryKey: string,
  expectedRegistryExecutable: WindowsPathIdentity,
  dependencies: WindowsInventoryDependencies,
): Promise<WindowsUninstallRecord | undefined> {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const budget =
    dependencies.inventoryBudget ?? createWindowsInventoryBudget(dependencies);
  return await budget.run(
    "Windows exact uninstall inventory",
    async (remaining) => {
      const before = await inspect(paths.reg);
      remaining();
      if (!sameWindowsPathIdentity(expectedRegistryExecutable, before)) {
        throw new Error("reg.exe changed before exact product verification");
      }
      const result = await execute(paths.reg, ["query", registryKey], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: Math.min(30_000, remaining()),
      });
      remaining();
      let record: WindowsUninstallRecord | undefined;
      if (!isMissingRegistryValue(result)) {
        if (result.exitCode !== 0) {
          throw new Error(
            failureDetail(
              result.stderr || result.stdout,
              paths.reg,
              result.exitCode,
            ),
          );
        }
        if (
          result.stdoutTruncated === true ||
          result.stderrTruncated === true
        ) {
          throw new Error("exact product query exceeded the safe output bound");
        }
        const matches = parseWindowsUninstallRecords(result.stdout).filter(
          ({ registryKey: candidate }) =>
            win32.normalize(candidate).toLowerCase() ===
            win32.normalize(registryKey).toLowerCase(),
        );
        if (matches.length !== 1) {
          throw new Error(
            `exact product query returned ${matches.length} matching records`,
          );
        }
        record = matches[0];
      }
      const after = await inspect(paths.reg);
      remaining();
      if (!sameWindowsPathIdentity(expectedRegistryExecutable, after)) {
        throw new Error("reg.exe changed during exact product verification");
      }
      return record;
    },
  );
}

function sameMsiProduct(left: MsiProduct, right: MsiProduct): boolean {
  return (
    win32.normalize(left.registryKey).toLowerCase() ===
      win32.normalize(right.registryKey).toLowerCase() &&
    left.productCode.toLowerCase() === right.productCode.toLowerCase() &&
    left.displayName === right.displayName &&
    left.windowsInstaller === right.windowsInstaller
  );
}

export function createWindowsMsiOperation(
  paths: WindowsPaths,
  component: ComponentId,
  displayNamePatterns: readonly RegExp[],
  products: AsyncValue<WindowsMsiInventory>,
  id: string,
  description: string,
  dependencies: WindowsInventoryDependencies = {},
): Operation {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const inventoryDependencies: WindowsInventoryDependencies = {
    ...dependencies,
    inventoryBudget: createWindowsInventoryBudget(dependencies),
  };
  let validatedMsiexec: WindowsPathIdentity | undefined;
  let msiexecValidationComplete = false;
  return createFunctionOperation({
    id: `windows:msi:${component}:${id}`,
    component,
    description,
    phase: "package",
    dedupeKey: `windows:msi:${id}`,
    validate: async () => {
      const inventory = await products();
      const selected = inventory.products.filter((product) =>
        displayNamePatterns.some((pattern) =>
          pattern.test(product.displayName),
        ),
      );
      if (selected.length > 16) {
        throw new Error("Windows MSI inventory exceeded 16 products");
      }
      if (selected.length !== 0 && inventory.registryExecutable === undefined) {
        throw new Error("reg.exe identity is unavailable for MSI products");
      }
      validatedMsiexec = await inspect(paths.msiexec);
      if (selected.length !== 0 && validatedMsiexec === undefined) {
        throw new Error(`msiexec.exe is unavailable at ${paths.msiexec}`);
      }
      msiexecValidationComplete = true;
    },
    run: async (): Promise<OperationResult> => {
      const inventory = await products();
      const selected = inventory.products.filter((product) =>
        displayNamePatterns.some((pattern) =>
          pattern.test(product.displayName),
        ),
      );
      if (selected.length > 16) {
        return {
          status: "failed",
          detail: "Windows MSI inventory exceeded 16 products",
        };
      }
      if (selected.length === 0) return { status: "not-found" };
      if (inventory.registryExecutable === undefined) {
        return {
          status: "failed",
          detail: "reg.exe identity is unavailable for MSI products",
        };
      }
      const msiexec = await inspect(paths.msiexec);
      if (
        msiexecValidationComplete &&
        validatedMsiexec === undefined &&
        msiexec === undefined
      ) {
        return {
          status: "failed",
          detail: `msiexec.exe is unavailable at ${paths.msiexec}`,
        };
      }
      if (
        msiexecValidationComplete &&
        !sameWindowsPathIdentity(validatedMsiexec, msiexec)
      ) {
        return {
          status: "failed",
          detail: "msiexec.exe changed after plan validation",
        };
      }
      if (msiexec === undefined) {
        return {
          status: "failed",
          detail: `msiexec.exe is unavailable at ${paths.msiexec}`,
        };
      }
      const registry = await inspect(paths.reg);
      if (
        inventory.registryExecutable !== undefined &&
        !sameWindowsPathIdentity(inventory.registryExecutable, registry)
      ) {
        return {
          status: "failed",
          detail: "reg.exe changed after product discovery",
        };
      }
      let removed = 0;
      for (const product of selected) {
        let exact: MsiProduct | undefined;
        try {
          const record = await readExactUninstallRecord(
            paths,
            product.registryKey,
            inventory.registryExecutable,
            inventoryDependencies,
          );
          exact =
            record === undefined ? undefined : msiProductFromRecord(record);
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (exact === undefined || !sameMsiProduct(product, exact)) {
          return {
            status: "failed",
            detail: `${product.displayName} registry identity changed before uninstall`,
          };
        }
        const beforeSpawn = await inspect(paths.msiexec);
        if (!sameWindowsPathIdentity(msiexec, beforeSpawn)) {
          return {
            status: "failed",
            detail: "msiexec.exe changed immediately before spawn",
          };
        }
        const result = await execute(
          paths.msiexec,
          ["/x", product.productCode, "/qn", "/norestart"],
          {
            env: paths.installerEnvironment,
            silent: true,
            timeoutMs: 30 * 60_000,
          },
        );
        const disposition = windowsInstallerExitDisposition(result.exitCode);
        if (
          disposition === "restart-required" ||
          disposition === "restart-initiated"
        ) {
          return restartResult(paths.msiexec, disposition);
        }
        if (
          disposition === "failed" &&
          !MSI_ABSENT_EXIT_CODES.has(result.exitCode)
        ) {
          return {
            status: "failed",
            detail: `${product.displayName}: ${failureDetail(
              result.stderr,
              paths.msiexec,
              result.exitCode,
            )}`,
          };
        }
        let after: WindowsUninstallRecord | undefined;
        try {
          after = await readExactUninstallRecord(
            paths,
            product.registryKey,
            inventory.registryExecutable,
            inventoryDependencies,
          );
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (after !== undefined) {
          return {
            status: "failed",
            detail: `${product.displayName} remained registered after msiexec exited ${result.exitCode}`,
          };
        }
        if (disposition === "completed") removed += 1;
      }
      return removed === 0
        ? { status: "not-found" }
        : {
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
  inspectFile?: (
    executable: string,
  ) => Promise<WindowsPathIdentity | undefined>,
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
  const executableIdentity =
    inspectFile === undefined
      ? windowsPathIdentity(executable)
      : await inspectFile(candidate.executable);
  if (executableIdentity === undefined) {
    throw new Error(
      `Unable to establish executable content identity: '${candidate.executable}'.`,
    );
  }
  return {
    candidate,
    status: "present",
    root: windowsPathIdentity(root),
    executable: executableIdentity,
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
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<WindowsPathIdentity | undefined>;
  readonly execute?: (
    executable: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
  readonly removeInstallationRoot?: (
    target: string,
    expectedBoundary?: RemovalBoundarySnapshot,
  ) => Promise<OperationResult>;
  readonly captureInstallationBoundary?: typeof captureSafeRemovalBoundary;
  readonly removalDependencies?: RemovePathDependencies;
}): Operation {
  const probe = options.probe ?? NODE_WINDOWS_PATH_PROBE;
  const inspectFile =
    options.inspectExecutable ??
    (probe === NODE_WINDOWS_PATH_PROBE
      ? async (target: string) => await inspectWindowsExecutable(target)
      : undefined);
  const execute =
    options.execute ??
    (async (executable: string, args: readonly string[]) =>
      await runCommand(executable, args, {
        env: windowsPaths(options.context.home, options.context.architecture)
          .installerEnvironment,
        silent: true,
        timeoutMs: options.timeoutMs ?? 20 * 60_000,
      }));
  const removeInstallationRoot =
    options.removeInstallationRoot ??
    (async (target: string, expectedBoundary?: RemovalBoundarySnapshot) =>
      await removeExactTarget(options.context, target, expectedBoundary));
  const captureInstallationBoundary =
    options.captureInstallationBoundary ??
    (options.removeInstallationRoot === undefined
      ? captureSafeRemovalBoundary
      : undefined);
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
  const residualRemovalOperations =
    options.removeInstallationRoot === undefined
      ? new Map(
          candidates.map((candidate) => [
            candidate.installationRoot,
            createRemovePathOperation(
              {
                id: `windows:uninstall-residual:${options.component}:${candidate.installationRoot}`,
                component: options.component,
                description: `Remove residual ${options.component} installation root`,
                target: candidate.installationRoot,
                allowedParents: [win32.dirname(candidate.installationRoot)],
                context: options.context,
                phase: "package",
              },
              options.removalDependencies,
            ),
          ]),
        )
      : undefined;
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
            inspectFile,
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
      if (residualRemovalOperations !== undefined) {
        for (const snapshot of validated) {
          if (snapshot.status !== "root-absent") {
            await residualRemovalOperations
              .get(snapshot.candidate.installationRoot)
              ?.validate?.();
          }
        }
      }
    },
    validateAfterPreflight: async () => {
      validated ??= await inspectAll();
      if (residualRemovalOperations === undefined) return;
      for (const snapshot of validated) {
        if (snapshot.status === "root-absent") continue;
        await residualRemovalOperations
          .get(snapshot.candidate.installationRoot)
          ?.validateAfterPreflight?.();
      }
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
          if (snapshot.status === "root-absent") continue;
          if (snapshot.status === "present") {
            const beforeSpawn = await inspectExecutableUninstallCandidate(
              options.context,
              snapshot.candidate,
              probe,
              inspectFile,
            );
            if (!sameExecutableUninstallSnapshot(snapshot, beforeSpawn)) {
              return {
                status: "failed",
                detail:
                  "executable uninstaller changed immediately before spawn",
              };
            }
            const result = await execute(
              snapshot.candidate.executable,
              options.args,
            );
            const disposition = windowsInstallerExitDisposition(
              result.exitCode,
            );
            if (
              disposition === "restart-required" ||
              disposition === "restart-initiated"
            ) {
              return restartResult(snapshot.candidate.executable, disposition);
            }
            if (disposition === "failed") {
              return {
                status: "failed",
                detail: failureDetail(
                  result.stderr,
                  snapshot.candidate.executable,
                  result.exitCode,
                ),
              };
            }
          }
          const afterUninstall = await inspectExecutableUninstallCandidate(
            options.context,
            snapshot.candidate,
            probe,
            inspectFile,
          );
          if (afterUninstall.status === "root-absent") {
            removed = true;
            continue;
          }
          if (!sameWindowsObjectIdentity(snapshot.root, afterUninstall.root)) {
            return {
              status: "failed",
              detail: `installation root changed after uninstall: '${snapshot.candidate.installationRoot}'`,
            };
          }
          const plannedRemoval = residualRemovalOperations?.get(
            snapshot.candidate.installationRoot,
          );
          const residualBoundary =
            plannedRemoval !== undefined ||
            captureInstallationBoundary === undefined
              ? undefined
              : await captureInstallationBoundary(
                  snapshot.candidate.installationRoot,
                  [win32.dirname(snapshot.candidate.installationRoot)],
                  options.context,
                );
          if (
            residualBoundary !== undefined &&
            !boundaryEndsWithWindowsIdentity(
              residualBoundary,
              afterUninstall.root,
            )
          ) {
            return {
              status: "failed",
              detail: `installation root changed before locked removal: '${snapshot.candidate.installationRoot}'`,
            };
          }
          const residualRemoval =
            plannedRemoval === undefined
              ? await removeInstallationRoot(
                  snapshot.candidate.installationRoot,
                  residualBoundary,
                )
              : await plannedRemoval.run();
          if (residualRemoval.status === "failed") {
            return {
              status: "failed",
              detail: `could not remove residual installation root '${snapshot.candidate.installationRoot}': ${residualRemoval.detail ?? "removal failed"}`,
            };
          }
          const verified = await inspectExecutableUninstallCandidate(
            options.context,
            snapshot.candidate,
            probe,
            inspectFile,
          );
          if (verified.status !== "root-absent") {
            return {
              status: "failed",
              detail: `installation root remained after cleanup: '${snapshot.candidate.installationRoot}'`,
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

export async function assertWindowsDirectoryChain(
  candidate: string,
  parent: string,
  probe: WindowsPathProbe = NODE_WINDOWS_PATH_PROBE,
): Promise<WindowsPathIdentity> {
  if (!isStrictWindowsDescendant(candidate, parent)) {
    throw new Error(`'${candidate}' is outside '${parent}'`);
  }
  const relative = win32.relative(
    win32.resolve(parent),
    win32.resolve(candidate),
  );
  const paths = [parent];
  let current = parent;
  for (const segment of relative.split(win32.sep)) {
    current = win32.join(current, segment);
    paths.push(current);
  }
  let identity: WindowsPathIdentity | undefined;
  for (const path of paths) {
    const stats = await probe.lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing Windows directory path containing a reparse point: '${path}'`,
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(`Refusing non-directory Windows path: '${path}'`);
    }
    identity = windowsPathIdentity(stats);
  }
  if (identity === undefined) {
    throw new Error(`Unable to inspect Windows directory path '${candidate}'`);
  }
  return identity;
}

export async function listVisualStudioInstances(
  paths: WindowsPaths,
  dependencies: WindowsVisualStudioDependencies = {},
  requiredComponents: readonly string[] = [],
): Promise<WindowsVisualStudioInventory> {
  const vswhere = paths.vswhere;
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const budget =
    dependencies.inventoryBudget ?? createWindowsInventoryBudget(dependencies);
  return await budget.run("Visual Studio inventory", async (remaining) => {
    const vswhereExecutable = await inspect(vswhere);
    remaining();
    if (vswhereExecutable === undefined) {
      throw new Error(`vswhere.exe is unavailable at ${vswhere}`);
    }
    if (
      dependencies.expectedInventoryExecutable !== undefined &&
      !sameWindowsPathIdentity(
        dependencies.expectedInventoryExecutable,
        vswhereExecutable,
      )
    ) {
      throw new Error("vswhere.exe changed before Visual Studio inventory");
    }
    const result = await execute(
      vswhere,
      [
        "-all",
        "-prerelease",
        "-products",
        "*",
        ...(requiredComponents.length === 0
          ? []
          : ["-requiresAny", "-requires", ...requiredComponents]),
        "-format",
        "json",
        "-utf8",
      ],
      {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: remaining(),
      },
    );
    remaining();
    if (result.exitCode !== 0) {
      throw new Error(failureDetail(result.stderr, vswhere, result.exitCode));
    }
    if (result.stdoutTruncated === true || result.stderrTruncated === true) {
      throw new Error("vswhere inventory exceeded the safe output bound");
    }

    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed))
      throw new Error("vswhere returned invalid JSON");
    if (parsed.length > 256) {
      throw new Error("vswhere inventory exceeded 256 raw records");
    }
    const roots = [
      win32.join(paths.programFiles, "Microsoft Visual Studio"),
      win32.join(paths.programFilesX86, "Microsoft Visual Studio"),
    ];
    const candidates: Omit<VisualStudioInstance, "installationIdentity">[] = [];
    for (const [index, value] of parsed.entries()) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
          `vswhere returned an unclassified Visual Studio record at index ${index}`,
        );
      }
      const record = value as Record<string, unknown>;
      const installationPath = record.installationPath;
      const installationVersion = record.installationVersion;
      const productId = record.productId;
      if (
        typeof productId === "string" &&
        productId !== "Microsoft.VisualStudio.Product.Enterprise"
      ) {
        continue;
      }
      if (productId !== "Microsoft.VisualStudio.Product.Enterprise") {
        throw new Error(
          `vswhere returned an unclassified Visual Studio record at index ${index}`,
        );
      }
      const definitionRoot =
        typeof installationPath === "string"
          ? roots.find((root) =>
              isStrictWindowsDescendant(installationPath, root),
            )
          : undefined;
      if (
        typeof installationPath !== "string" ||
        !win32.isAbsolute(installationPath) ||
        definitionRoot === undefined ||
        typeof installationVersion !== "string" ||
        !/^(?:17|18)\./.test(installationVersion)
      ) {
        throw new Error(
          `vswhere returned a malformed Visual Studio Enterprise record at index ${index}`,
        );
      }
      const normalizedInstallationPath = win32.normalize(installationPath);
      candidates.push({
        installationPath: normalizedInstallationPath,
        definitionRoot,
        installationVersion,
        productId,
      });
    }
    const byPath = new Map<
      string,
      Omit<VisualStudioInstance, "installationIdentity">
    >();
    for (const candidate of candidates) {
      const key = candidate.installationPath.toLowerCase();
      if (byPath.has(key)) {
        throw new Error(
          `vswhere returned a duplicate Visual Studio instance: ${candidate.installationPath}`,
        );
      }
      byPath.set(key, candidate);
    }
    if (byPath.size > 8) {
      throw new Error("Visual Studio inventory exceeded 8 instances");
    }
    const instances: VisualStudioInstance[] = [];
    for (const candidate of byPath.values()) {
      remaining();
      const installationIdentity = await assertWindowsDirectoryChain(
        candidate.installationPath,
        candidate.definitionRoot,
        dependencies.pathProbe ?? NODE_WINDOWS_PATH_PROBE,
      );
      remaining();
      instances.push({ ...candidate, installationIdentity });
    }
    const currentVswhereExecutable = await inspect(vswhere);
    remaining();
    if (!sameWindowsPathIdentity(vswhereExecutable, currentVswhereExecutable)) {
      throw new Error(
        "vswhere.exe changed while reading Visual Studio instances",
      );
    }
    return {
      instances: instances.sort((left, right) =>
        left.installationPath.localeCompare(right.installationPath),
      ),
      vswhereExecutable,
    };
  });
}

async function verifyVisualStudioInstance(
  instance: VisualStudioInstance,
  dependencies: WindowsVisualStudioDependencies = {},
): Promise<boolean> {
  const budget =
    dependencies.inventoryBudget ?? createWindowsInventoryBudget(dependencies);
  return await budget.run(
    "Visual Studio instance verification",
    async (remaining) => {
      try {
        const current = await assertWindowsDirectoryChain(
          instance.installationPath,
          instance.definitionRoot,
          dependencies.pathProbe ?? NODE_WINDOWS_PATH_PROBE,
        );
        remaining();
        return sameWindowsPathIdentity(instance.installationIdentity, current);
      } catch (error) {
        remaining();
        if (
          error instanceof Error &&
          /two-minute aggregate deadline/.test(error.message)
        ) {
          throw error;
        }
        return false;
      }
    },
  );
}

function sameVisualStudioInstance(
  left: VisualStudioInstance,
  right: VisualStudioInstance,
): boolean {
  return (
    left.installationPath.toLowerCase() ===
      right.installationPath.toLowerCase() &&
    left.definitionRoot.toLowerCase() === right.definitionRoot.toLowerCase() &&
    left.installationVersion === right.installationVersion &&
    left.productId === right.productId &&
    sameWindowsPathIdentity(
      left.installationIdentity,
      right.installationIdentity,
    )
  );
}

function sameVisualStudioInstanceObject(
  left: VisualStudioInstance,
  right: VisualStudioInstance,
): boolean {
  return (
    left.installationPath.toLowerCase() ===
      right.installationPath.toLowerCase() &&
    left.definitionRoot.toLowerCase() === right.definitionRoot.toLowerCase() &&
    left.installationVersion === right.installationVersion &&
    left.productId === right.productId &&
    sameWindowsObjectIdentity(
      left.installationIdentity,
      right.installationIdentity,
    )
  );
}

function sameVisualStudioInstances(
  left: readonly VisualStudioInstance[],
  right: readonly VisualStudioInstance[],
): boolean {
  return (
    left.length === right.length &&
    left.every((instance, index) => {
      const other = right[index];
      return other !== undefined && sameVisualStudioInstance(instance, other);
    })
  );
}

function sameVisualStudioInstanceObjects(
  left: readonly VisualStudioInstance[],
  right: readonly VisualStudioInstance[],
): boolean {
  return (
    left.length === right.length &&
    left.every((instance, index) => {
      const other = right[index];
      return (
        other !== undefined && sameVisualStudioInstanceObject(instance, other)
      );
    })
  );
}

function usesVisualStudioInventoryExecutable(
  expected: WindowsPathIdentity | undefined,
  inventory: WindowsVisualStudioInventory,
): boolean {
  return sameWindowsPathIdentity(expected, inventory.vswhereExecutable);
}

const VISUAL_STUDIO_INVENTORY_EXECUTABLE_CHANGED =
  "vswhere.exe changed after Visual Studio inventory validation";

function changedVisualStudioInventoryExecutable(): OperationResult {
  return {
    status: "failed",
    detail: VISUAL_STUDIO_INVENTORY_EXECUTABLE_CHANGED,
  };
}

export function createWindowsVisualStudioOperation(
  paths: WindowsPaths,
  instances: AsyncValue<WindowsVisualStudioInventory>,
  dependencies: WindowsVisualStudioDependencies = {},
): Operation {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const inventoryDependencies: WindowsVisualStudioDependencies = {
    ...dependencies,
    inventoryBudget: createWindowsInventoryBudget(dependencies),
  };
  let validatedSetup: WindowsPathIdentity | undefined;
  let validatedInstances: readonly VisualStudioInstance[] | undefined;
  let validatedVswhereExecutable: WindowsPathIdentity | undefined;
  let setupValidationComplete = false;
  return createFunctionOperation({
    id: "windows:visual-studio:uninstall",
    component: "visual-studio",
    description: "Uninstall runner-image Visual Studio instances",
    phase: "package",
    dedupeKey: "windows:visual-studio:uninstall",
    blockedBy: VISUAL_STUDIO_OVERLAPS,
    validate: async () => {
      const inventory = await instances();
      validatedInstances = inventory.instances;
      validatedVswhereExecutable = inventory.vswhereExecutable;
      validatedSetup = await inspect(
        win32.join(paths.visualStudioInstaller, "setup.exe"),
      );
      if (validatedInstances.length !== 0 && validatedSetup === undefined) {
        throw new Error(
          "Visual Studio setup.exe is unavailable for discovered instances",
        );
      }
      setupValidationComplete = true;
    },
    run: async (): Promise<OperationResult> => {
      const setup = win32.join(paths.visualStudioInstaller, "setup.exe");
      if (
        validatedInstances === undefined ||
        validatedVswhereExecutable === undefined
      ) {
        const inventory = await instances();
        validatedInstances = inventory.instances;
        validatedVswhereExecutable = inventory.vswhereExecutable;
      }
      if (validatedInstances.length === 0) return { status: "not-found" };
      const setupIdentity = await inspect(setup);
      if (
        !setupValidationComplete ||
        !sameWindowsPathIdentity(validatedSetup, setupIdentity)
      ) {
        return {
          status: "failed",
          detail:
            "Visual Studio setup executable changed after plan validation",
        };
      }
      if (setupIdentity === undefined) {
        return {
          status: "failed",
          detail: "Visual Studio setup.exe is unavailable",
        };
      }

      let expected = [...validatedInstances];
      for (const instance of validatedInstances) {
        const fresh = await listVisualStudioInstances(paths, {
          ...inventoryDependencies,
          expectedInventoryExecutable: validatedVswhereExecutable,
        });
        if (
          !usesVisualStudioInventoryExecutable(
            validatedVswhereExecutable,
            fresh,
          )
        ) {
          return changedVisualStudioInventoryExecutable();
        }
        if (!sameVisualStudioInstances(expected, fresh.instances)) {
          return {
            status: "failed",
            detail: "Visual Studio instance inventory changed before uninstall",
          };
        }
        if (
          !(await verifyVisualStudioInstance(instance, inventoryDependencies))
        ) {
          return {
            status: "failed",
            detail: `Visual Studio installation path changed before uninstall: ${instance.installationPath}`,
          };
        }
        const beforeSpawn = await inspect(setup);
        if (!sameWindowsPathIdentity(setupIdentity, beforeSpawn)) {
          return {
            status: "failed",
            detail:
              "Visual Studio setup executable changed immediately before spawn",
          };
        }
        const result = await execute(
          setup,
          [
            "uninstall",
            "--installPath",
            instance.installationPath,
            "--quiet",
            "--norestart",
            "--force",
          ],
          {
            env: paths.installerEnvironment,
            silent: false,
            timeoutMs: 75 * 60_000,
          },
        );
        const disposition = windowsInstallerExitDisposition(result.exitCode);
        if (
          disposition === "restart-required" ||
          disposition === "restart-initiated"
        ) {
          return restartResult(setup, disposition);
        }
        if (disposition === "failed") {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, setup, result.exitCode),
          };
        }
        expected = expected.filter(
          ({ installationPath }) =>
            installationPath.toLowerCase() !==
            instance.installationPath.toLowerCase(),
        );
        const after = await listVisualStudioInstances(paths, {
          ...inventoryDependencies,
          expectedInventoryExecutable: validatedVswhereExecutable,
        });
        if (
          !usesVisualStudioInventoryExecutable(
            validatedVswhereExecutable,
            after,
          )
        ) {
          return changedVisualStudioInventoryExecutable();
        }
        if (!sameVisualStudioInstanceObjects(expected, after.instances)) {
          return {
            status: "failed",
            detail: `Visual Studio instance remained registered or inventory changed after uninstall: ${instance.installationPath}`,
          };
        }
      }
      return {
        status: "removed",
        detail: `${validatedInstances.length} instance(s)`,
      };
    },
  });
}

const WINDOWS_SDK_COMPONENTS = [
  "Microsoft.VisualStudio.Component.Windows10SDK",
  "Microsoft.VisualStudio.Component.Windows10SDK.19041",
  "Microsoft.VisualStudio.Component.Windows11SDK.22621",
  "Microsoft.VisualStudio.Component.Windows11SDK.26100",
  "Component.Microsoft.Windows.DriverKit",
] as const;

// Windows SDK payloads are shared and reference-counted. Use the Visual Studio
// installer component IDs from the image definitions; never delete Windows Kits,
// invoke DISM package removal, or touch WinSxS directly.

export function createWindowsSdkComponentOperation(
  paths: WindowsPaths,
  instances: AsyncValue<WindowsVisualStudioInventory>,
  dependencies: WindowsVisualStudioDependencies = {},
): Operation {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const inventoryDependencies: WindowsVisualStudioDependencies = {
    ...dependencies,
    inventoryBudget: createWindowsInventoryBudget(dependencies),
  };
  let validatedSetup: WindowsPathIdentity | undefined;
  let validatedInstances: readonly VisualStudioInstance[] | undefined;
  let validatedAllInstances: readonly VisualStudioInstance[] | undefined;
  let validatedVswhereExecutable: WindowsPathIdentity | undefined;
  let setupValidationComplete = false;
  return createFunctionOperation({
    id: "windows:windows-sdk:remove-components",
    component: "windows-sdk",
    description: "Remove definition-listed Windows SDK and WDK components",
    phase: "package",
    dedupeKey: "windows:windows-sdk:remove-components",
    validate: async () => {
      const allInventory = await instances();
      validatedAllInstances = allInventory.instances;
      validatedVswhereExecutable = allInventory.vswhereExecutable;
      const componentInventory = await listVisualStudioInstances(
        paths,
        {
          ...inventoryDependencies,
          expectedInventoryExecutable: validatedVswhereExecutable,
        },
        WINDOWS_SDK_COMPONENTS,
      );
      if (
        !usesVisualStudioInventoryExecutable(
          validatedVswhereExecutable,
          componentInventory,
        )
      ) {
        throw new Error(VISUAL_STUDIO_INVENTORY_EXECUTABLE_CHANGED);
      }
      validatedInstances = componentInventory.instances;
      validatedSetup = await inspect(
        win32.join(paths.visualStudioInstaller, "setup.exe"),
      );
      if (validatedInstances.length !== 0 && validatedSetup === undefined) {
        throw new Error(
          "Visual Studio setup.exe is unavailable for SDK components",
        );
      }
      setupValidationComplete = true;
    },
    run: async (): Promise<OperationResult> => {
      const setup = win32.join(paths.visualStudioInstaller, "setup.exe");
      if (
        validatedAllInstances === undefined ||
        validatedVswhereExecutable === undefined
      ) {
        const allInventory = await instances();
        validatedAllInstances = allInventory.instances;
        validatedVswhereExecutable = allInventory.vswhereExecutable;
      }
      if (validatedInstances === undefined) {
        const componentInventory = await listVisualStudioInstances(
          paths,
          {
            ...inventoryDependencies,
            expectedInventoryExecutable: validatedVswhereExecutable,
          },
          WINDOWS_SDK_COMPONENTS,
        );
        if (
          !usesVisualStudioInventoryExecutable(
            validatedVswhereExecutable,
            componentInventory,
          )
        ) {
          return changedVisualStudioInventoryExecutable();
        }
        validatedInstances = componentInventory.instances;
      }
      if (validatedInstances.length === 0) return { status: "not-found" };

      const removeArguments = WINDOWS_SDK_COMPONENTS.flatMap((component) => [
        "--remove",
        component,
      ]);
      let removed = 0;
      for (const instance of validatedInstances) {
        const currentComponents = await listVisualStudioInstances(
          paths,
          {
            ...inventoryDependencies,
            expectedInventoryExecutable: validatedVswhereExecutable,
          },
          WINDOWS_SDK_COMPONENTS,
        );
        if (
          !usesVisualStudioInventoryExecutable(
            validatedVswhereExecutable,
            currentComponents,
          )
        ) {
          return changedVisualStudioInventoryExecutable();
        }
        const current = currentComponents.instances.find(
          ({ installationPath }) =>
            installationPath.toLowerCase() ===
            instance.installationPath.toLowerCase(),
        );
        if (current === undefined) continue;
        if (!sameVisualStudioInstance(instance, current)) {
          return {
            status: "failed",
            detail: `Visual Studio SDK component inventory changed before removal: ${instance.installationPath}`,
          };
        }
        const setupIdentity = await inspect(setup);
        if (
          !setupValidationComplete ||
          !sameWindowsPathIdentity(validatedSetup, setupIdentity)
        ) {
          return {
            status: "failed",
            detail:
              "Visual Studio setup executable changed after plan validation",
          };
        }
        if (
          !(await verifyVisualStudioInstance(instance, inventoryDependencies))
        ) {
          return {
            status: "failed",
            detail: `Visual Studio installation path changed before SDK removal: ${instance.installationPath}`,
          };
        }
        const beforeSpawn = await inspect(setup);
        if (!sameWindowsPathIdentity(setupIdentity, beforeSpawn)) {
          return {
            status: "failed",
            detail:
              "Visual Studio setup executable changed immediately before spawn",
          };
        }
        const result = await execute(
          setup,
          [
            "modify",
            "--installPath",
            instance.installationPath,
            ...removeArguments,
            "--quiet",
            "--norestart",
          ],
          {
            env: paths.installerEnvironment,
            silent: false,
            timeoutMs: 75 * 60_000,
          },
        );
        const disposition = windowsInstallerExitDisposition(result.exitCode);
        if (
          disposition === "restart-required" ||
          disposition === "restart-initiated"
        ) {
          return restartResult(setup, disposition);
        }
        if (disposition === "failed") {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, setup, result.exitCode),
          };
        }
        const residual = await listVisualStudioInstances(
          paths,
          {
            ...inventoryDependencies,
            expectedInventoryExecutable: validatedVswhereExecutable,
          },
          WINDOWS_SDK_COMPONENTS,
        );
        if (
          !usesVisualStudioInventoryExecutable(
            validatedVswhereExecutable,
            residual,
          )
        ) {
          return changedVisualStudioInventoryExecutable();
        }
        if (
          residual.instances.some(
            ({ installationPath }) =>
              installationPath.toLowerCase() ===
              instance.installationPath.toLowerCase(),
          )
        ) {
          return {
            status: "failed",
            detail: `Windows SDK or WDK components remained registered after modify: ${instance.installationPath}`,
          };
        }
        const preservedInventory = await listVisualStudioInstances(paths, {
          ...inventoryDependencies,
          expectedInventoryExecutable: validatedVswhereExecutable,
        });
        if (
          !usesVisualStudioInventoryExecutable(
            validatedVswhereExecutable,
            preservedInventory,
          )
        ) {
          return changedVisualStudioInventoryExecutable();
        }
        const preservedInstance = preservedInventory.instances.find(
          ({ installationPath }) =>
            installationPath.toLowerCase() ===
            instance.installationPath.toLowerCase(),
        );
        if (preservedInstance === undefined) {
          return {
            status: "failed",
            detail: `Visual Studio instance disappeared during Windows SDK removal: ${instance.installationPath}`,
          };
        }
        if (!sameVisualStudioInstanceObject(instance, preservedInstance)) {
          return {
            status: "failed",
            detail: `Visual Studio instance identity changed during Windows SDK removal: ${instance.installationPath}`,
          };
        }
        if (
          !sameVisualStudioInstanceObjects(
            validatedAllInstances,
            preservedInventory.instances,
          )
        ) {
          return {
            status: "failed",
            detail:
              "Visual Studio instance inventory changed during Windows SDK removal",
          };
        }
        removed += 1;
      }
      return removed === 0
        ? { status: "not-found" }
        : { status: "removed", detail: `${removed} instance(s)` };
    },
  });
}

export interface WindowsSdkBundleDependencies extends WindowsInventoryDependencies {
  readonly pathProbe?: WindowsPathProbe;
}

interface WindowsSdkBundleSnapshot {
  readonly record: WindowsUninstallRecord;
  readonly kind: "sdk" | "wdk";
  readonly executable: string;
  readonly executableIdentity: WindowsPathIdentity;
}

function windowsSdkBundleKind(
  displayName: string | undefined,
): "sdk" | "wdk" | undefined {
  if (
    /^Windows Software Development Kit(?:\s+-\s+Windows)?\s+10\.[0-9.]+$/i.test(
      displayName ?? "",
    )
  ) {
    return "sdk";
  }
  if (
    /^Windows Driver Kit(?:\s+-\s+Windows)?\s+10\.[0-9.]+$/i.test(
      displayName ?? "",
    )
  ) {
    return "wdk";
  }
  return undefined;
}

function sameWindowsUninstallRecord(
  left: WindowsUninstallRecord,
  right: WindowsUninstallRecord,
): boolean {
  return (
    win32.normalize(left.registryKey).toLowerCase() ===
      win32.normalize(right.registryKey).toLowerCase() &&
    left.displayName === right.displayName &&
    left.displayVersion === right.displayVersion &&
    left.bundleCachePath === right.bundleCachePath &&
    left.windowsInstaller === right.windowsInstaller
  );
}

async function inspectWindowsSdkBundle(
  paths: WindowsPaths,
  record: WindowsUninstallRecord,
  dependencies: WindowsSdkBundleDependencies,
): Promise<WindowsSdkBundleSnapshot | undefined> {
  const kind = windowsSdkBundleKind(record.displayName);
  if (kind === undefined) return undefined;
  if (record.bundleCachePath === undefined) {
    throw new Error(`${record.displayName} has no BundleCachePath`);
  }
  const executable = win32.normalize(record.bundleCachePath);
  const expectedName = kind === "sdk" ? "winsdksetup.exe" : "wdksetup.exe";
  if (
    !win32.isAbsolute(executable) ||
    win32.basename(executable).toLowerCase() !== expectedName
  ) {
    throw new Error(`${record.displayName} has an unsafe bundle executable`);
  }
  const cacheRoot = win32.join(paths.programData, "Package Cache");
  if (!isStrictWindowsDescendant(executable, cacheRoot)) {
    throw new Error(`${record.displayName} bundle is outside Package Cache`);
  }
  await assertWindowsDirectoryChain(
    win32.dirname(executable),
    cacheRoot,
    dependencies.pathProbe ?? NODE_WINDOWS_PATH_PROBE,
  );
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const executableIdentity = await inspect(executable);
  if (executableIdentity === undefined) {
    throw new Error(`${record.displayName} bundle executable is unavailable`);
  }
  return { record, kind, executable, executableIdentity };
}

export function createWindowsSdkBundleOperation(
  paths: WindowsPaths,
  inventory: AsyncValue<WindowsUninstallInventory>,
  dependencies: WindowsSdkBundleDependencies = {},
): Operation {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const inventoryDependencies: WindowsSdkBundleDependencies = {
    ...dependencies,
    inventoryBudget: createWindowsInventoryBudget(dependencies),
  };
  let validated: readonly WindowsSdkBundleSnapshot[] | undefined;
  const inspectSelected = async (): Promise<
    readonly WindowsSdkBundleSnapshot[]
  > => {
    const budget = inventoryDependencies.inventoryBudget;
    if (budget === undefined) {
      throw new Error("Windows SDK bundle inventory budget is unavailable");
    }
    return await budget.run(
      "Windows SDK bundle inventory",
      async (remaining) => {
        const source = await inventory();
        remaining();
        const selected = source.records.filter(
          (record) => windowsSdkBundleKind(record.displayName) !== undefined,
        );
        if (selected.length > 16) {
          throw new Error("Windows SDK bundle inventory exceeded 16 records");
        }
        const snapshots: WindowsSdkBundleSnapshot[] = [];
        for (const record of selected) {
          remaining();
          const snapshot = await inspectWindowsSdkBundle(
            paths,
            record,
            inventoryDependencies,
          );
          remaining();
          if (snapshot !== undefined) snapshots.push(snapshot);
        }
        return snapshots;
      },
    );
  };
  return createFunctionOperation({
    id: "windows:windows-sdk:standalone-bundles",
    component: "windows-sdk",
    description: "Uninstall standalone Windows SDK and WDK bundles",
    phase: "package",
    dedupeKey: "windows:windows-sdk:standalone-bundles",
    validate: async () => {
      validated = await inspectSelected();
    },
    run: async (): Promise<OperationResult> => {
      try {
        validated ??= await inspectSelected();
        if (validated.length === 0) return { status: "not-found" };
        const source = await inventory();
        let removed = 0;
        for (const snapshot of validated) {
          const currentRecord = await readExactUninstallRecord(
            paths,
            snapshot.record.registryKey,
            source.registryExecutable,
            inventoryDependencies,
          );
          if (
            currentRecord === undefined ||
            !sameWindowsUninstallRecord(snapshot.record, currentRecord)
          ) {
            return {
              status: "failed",
              detail: `${snapshot.record.displayName ?? "Windows SDK bundle"} registry identity changed before uninstall`,
            };
          }
          const budget = inventoryDependencies.inventoryBudget;
          if (budget === undefined) {
            throw new Error(
              "Windows SDK bundle inventory budget is unavailable",
            );
          }
          const immediate = await budget.run(
            "Windows SDK bundle inventory",
            async (remaining) => {
              const snapshot = await inspectWindowsSdkBundle(
                paths,
                currentRecord,
                inventoryDependencies,
              );
              remaining();
              return snapshot;
            },
          );
          if (
            immediate === undefined ||
            immediate.kind !== snapshot.kind ||
            immediate.executable.toLowerCase() !==
              snapshot.executable.toLowerCase() ||
            !sameWindowsPathIdentity(
              snapshot.executableIdentity,
              immediate.executableIdentity,
            )
          ) {
            return {
              status: "failed",
              detail: `${snapshot.record.displayName ?? "Windows SDK bundle"} executable changed before uninstall`,
            };
          }
          const beforeSpawn = await inspect(snapshot.executable);
          if (
            !sameWindowsPathIdentity(snapshot.executableIdentity, beforeSpawn)
          ) {
            return {
              status: "failed",
              detail: `${snapshot.record.displayName ?? "Windows SDK bundle"} executable changed immediately before spawn`,
            };
          }
          const result = await execute(
            snapshot.executable,
            ["/uninstall", "/quiet", "/norestart"],
            {
              env: paths.installerEnvironment,
              silent: false,
              timeoutMs: 45 * 60_000,
            },
          );
          const disposition = windowsInstallerExitDisposition(result.exitCode);
          if (
            disposition === "restart-required" ||
            disposition === "restart-initiated"
          ) {
            return restartResult(snapshot.executable, disposition);
          }
          if (disposition === "failed") {
            return {
              status: "failed",
              detail: failureDetail(
                result.stderr,
                snapshot.executable,
                result.exitCode,
              ),
            };
          }
          const residual = await readExactUninstallRecord(
            paths,
            snapshot.record.registryKey,
            source.registryExecutable,
            inventoryDependencies,
          );
          if (residual !== undefined) {
            return {
              status: "failed",
              detail: `${snapshot.record.displayName ?? "Windows SDK bundle"} remained registered after successful uninstall`,
            };
          }
          removed += 1;
        }
        return {
          status: "removed",
          detail: `${removed} standalone bundle(s)`,
        };
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export function createWindowsDockerPruneOperation(
  paths: WindowsPaths,
  dependencies: WindowsDockerDependencies = {},
): Operation {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const createConfigDirectory = dependencies.createConfigDirectory ?? mkdtemp;
  const dockerTempRoot = win32.join(paths.systemRoot, "Temp");
  const inspectConfigDirectory =
    dependencies.inspectConfigDirectory ??
    (async (path: string): Promise<WindowsPathIdentity> => {
      const identity = await assertWindowsDirectoryChain(path, dockerTempRoot);
      const directory = await opendir(path);
      try {
        if ((await directory.read()) !== null) {
          throw new Error("isolated Docker configuration is not empty");
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      return identity;
    });
  const captureConfigBoundary =
    dependencies.captureConfigBoundary ?? captureSafeRemovalBoundary;
  const removeConfigTarget =
    dependencies.removeConfigTarget ?? removePathTarget;
  const removeConfigDirectory =
    dependencies.removeConfigDirectory ??
    (async (path: string, expectedIdentity: WindowsPathIdentity) => {
      if (dependencies.context === undefined) {
        throw new Error(
          "Windows Docker config cleanup has no locked removal context",
        );
      }
      const removal = await removeConfigTarget(
        path,
        [dockerTempRoot],
        dependencies.context,
        {
          boundary: async (target, allowedParents, context) => {
            const snapshot = await captureConfigBoundary(
              target,
              allowedParents,
              context,
            );
            const targetIdentity = snapshot.entries.at(-1);
            if (
              !snapshot.targetExists ||
              targetIdentity === undefined ||
              targetIdentity.device !== expectedIdentity.dev ||
              targetIdentity.inode !== expectedIdentity.ino
            ) {
              throw new Error(
                "isolated Docker configuration identity changed before locked removal",
              );
            }
            return snapshot;
          },
        },
      );
      if (removal.status !== "removed") {
        throw new Error(
          `locked removal boundary did not remove isolated Docker configuration: ${removal.detail ?? removal.status}`,
        );
      }
    });
  const docker = win32.join(paths.system32, "docker.exe");
  let validated: WindowsPathIdentity | undefined;
  let validationComplete = false;
  return createFunctionOperation({
    id: "windows:docker:prune",
    component: "docker-images",
    description: "Prune unused Windows Docker data",
    phase: "system",
    dedupeKey: "windows:docker:prune",
    // Engine removal deletes the same data root after safely stopping Docker.
    // Do not schedule a redundant daemon call after that stop transition.
    coveredBy: ["docker-engine"],
    validate: async () => {
      validated = await inspect(docker);
      validationComplete = true;
    },
    run: async (): Promise<OperationResult> => {
      const current = await inspect(docker);
      if (
        validationComplete &&
        validated === undefined &&
        current === undefined
      ) {
        return { status: "not-found" };
      }
      if (!validationComplete || !sameWindowsPathIdentity(validated, current)) {
        return {
          status: "failed",
          detail: "Docker executable changed after plan validation",
        };
      }
      if (current === undefined) return { status: "not-found" };
      let configDirectory: string;
      try {
        configDirectory = await createConfigDirectory(
          `${dockerTempRoot}\\maximize-github-runner-space-docker-`,
        );
      } catch (error) {
        return {
          status: "failed",
          detail: `could not create isolated Docker configuration: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      let configIdentity: WindowsPathIdentity | undefined;
      let executionError: unknown;
      try {
        try {
          configIdentity = await inspectConfigDirectory(configDirectory);
        } catch (error) {
          return {
            status: "failed",
            detail: `unsafe isolated Docker configuration: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const localDockerHost = "npipe:////./pipe/docker_engine";
        const environment = {
          ...paths.commandEnvironment,
          DOCKER_CONFIG: configDirectory,
          DOCKER_HOST: localDockerHost,
        };
        const beforeProbe = await inspect(docker);
        if (!sameWindowsPathIdentity(current, beforeProbe)) {
          return {
            status: "failed",
            detail: "Docker executable changed before daemon inspection",
          };
        }
        const responsive = await execute(
          docker,
          ["--host", localDockerHost, "--config", configDirectory, "info"],
          {
            env: environment,
            silent: true,
            timeoutMs: 15_000,
          },
        );
        if (responsive.exitCode !== 0) {
          const output =
            `${responsive.stdout}\n${responsive.stderr}`.toLowerCase();
          const daemonUnavailable =
            responsive.exitCode === 1 &&
            responsive.stdoutTruncated !== true &&
            responsive.stderrTruncated !== true &&
            output.includes("docker_engine") &&
            (output.includes("the system cannot find the file specified") ||
              output.includes("the system cannot find the path specified"));
          return daemonUnavailable
            ? {
                status: "unsupported",
                detail: "local Docker daemon unavailable",
              }
            : {
                status: "failed",
                detail: failureDetail(
                  responsive.stderr,
                  docker,
                  responsive.exitCode,
                ),
              };
        }
        const beforeMutation = await inspect(docker);
        if (!sameWindowsPathIdentity(current, beforeMutation)) {
          return {
            status: "failed",
            detail: "Docker executable changed before image mutation",
          };
        }
        let configBeforeMutation: WindowsPathIdentity;
        try {
          configBeforeMutation = await inspectConfigDirectory(configDirectory);
        } catch (error) {
          return {
            status: "failed",
            detail: `unsafe isolated Docker configuration before mutation: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (!sameWindowsPathIdentity(configIdentity, configBeforeMutation)) {
          return {
            status: "failed",
            detail: "isolated Docker configuration changed before mutation",
          };
        }
        const result = await execute(
          docker,
          [
            "--host",
            localDockerHost,
            "--config",
            configDirectory,
            "system",
            "prune",
            "--all",
            "--volumes",
            "--force",
          ],
          { env: environment, silent: false, timeoutMs: 20 * 60_000 },
        );
        return result.exitCode === 0
          ? { status: "removed" }
          : {
              status: "failed",
              detail: failureDetail(result.stderr, docker, result.exitCode),
            };
      } catch (error) {
        executionError = error;
        throw error;
      } finally {
        // Preserve the original fatal timeout and leave its configuration in
        // place: an escaped launcher may still be reading this directory.
        if (!(executionError instanceof UnconfirmedCommandTerminationError)) {
          assertCommandTerminationConfirmed();
          if (configIdentity !== undefined) {
            await removeConfigDirectory(configDirectory, configIdentity);
          }
        }
      }
    },
  });
}

export interface WindowsToolCacheDependencies {
  readonly createDirectory?: (target: string) => Promise<void>;
  readonly accessDirectory?: (target: string, mode: number) => Promise<void>;
}

export function createWindowsToolCacheRecreateOperation(
  context: RuntimeContext,
  target: string,
  dependencies: WindowsToolCacheDependencies = {},
): Operation {
  const createDirectory =
    dependencies.createDirectory ??
    (async (path: string): Promise<void> => {
      await mkdir(path, { recursive: true });
    });
  const accessDirectory = dependencies.accessDirectory ?? access;
  return createFunctionOperation({
    id: "windows:toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    fatal: true,
    validate: async () =>
      await assertSafeDirectoryTarget(target, [win32.dirname(target)], context),
    run: async () => {
      try {
        await assertSafeDirectoryTarget(
          target,
          [win32.dirname(target)],
          context,
        );
        await createDirectory(target);
        await assertSafeDirectoryTarget(
          target,
          [win32.dirname(target)],
          context,
        );
        await accessDirectory(target, constants.W_OK);
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
  expectedBoundary?: RemovalBoundarySnapshot,
): Promise<OperationResult> {
  return await removePathTarget(target, [win32.dirname(target)], context, {
    ...(expectedBoundary === undefined ? {} : { expectedBoundary }),
  });
}

function boundaryEndsWithWindowsIdentity(
  boundary: RemovalBoundarySnapshot,
  identity: WindowsPathIdentity,
): boolean {
  const target = boundary.entries.at(-1);
  return (
    boundary.targetExists &&
    target !== undefined &&
    target.device === identity.dev &&
    target.inode === identity.ino &&
    (identity.birthtimeNs === undefined ||
      target.birthtimeNanoseconds === identity.birthtimeNs) &&
    (identity.mode === undefined || target.mode === identity.mode) &&
    (identity.uid === undefined || target.userId === identity.uid) &&
    (identity.gid === undefined || target.groupId === identity.gid)
  );
}

async function validateExactTarget(
  context: RuntimeContext,
  target: string,
): Promise<RemovalBoundarySnapshot> {
  return await captureSafeRemovalBoundary(
    target,
    [win32.dirname(target)],
    context,
  );
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
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<WindowsPathIdentity | undefined>;
  readonly execute?: (
    executable: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
  readonly removeInstallationRoot?: (
    target: string,
    expectedBoundary?: RemovalBoundarySnapshot,
  ) => Promise<OperationResult>;
  readonly captureInstallationBoundary?: typeof captureSafeRemovalBoundary;
  readonly removalDependencies?: RemovePathDependencies;
}): Operation {
  const probe = options.probe ?? NODE_WINDOWS_PATH_PROBE;
  const inspectFile =
    options.inspectExecutable ??
    (probe === NODE_WINDOWS_PATH_PROBE
      ? async (target: string) => await inspectWindowsExecutable(target)
      : undefined);
  const execute =
    options.execute ??
    (async (path: string, args: readonly string[]) =>
      await runCommand(path, args, {
        env: windowsPaths(options.context.home, options.context.architecture)
          .installerEnvironment,
        silent: true,
        timeoutMs: 30 * 60_000,
      }));
  const removeInstallationRoot =
    options.removeInstallationRoot ??
    (async (target: string, expectedBoundary?: RemovalBoundarySnapshot) =>
      await removeExactTarget(options.context, target, expectedBoundary));
  const captureInstallationBoundary =
    options.captureInstallationBoundary ??
    (options.removeInstallationRoot === undefined
      ? captureSafeRemovalBoundary
      : undefined);
  const executable = win32.join(options.target, options.uninstaller);
  const residualRemovalOperation =
    options.removeInstallationRoot === undefined
      ? createRemovePathOperation(
          {
            id: `windows:managed-residual:${options.component}:${options.id}`,
            component: options.component,
            description: `Remove residual ${options.component} installation root`,
            target: options.target,
            allowedParents: [win32.dirname(options.target)],
            context: options.context,
            phase: "package",
          },
          options.removalDependencies,
        )
      : undefined;
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
      const uninstallerIdentity =
        inspectFile === undefined
          ? windowsPathIdentity(uninstaller)
          : await inspectFile(executable);
      if (uninstallerIdentity === undefined) {
        throw new Error(
          `Unable to establish managed uninstaller content identity: '${executable}'.`,
        );
      }
      return {
        status: "root-present",
        root: windowsPathIdentity(root),
        uninstaller: uninstallerIdentity,
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
        sameOptionalWindowsPathIdentity(left.uninstaller, right.uninstaller)));
  return createFunctionOperation({
    id: `windows:managed-directory:${options.component}:${options.id}`,
    component: options.component,
    description: options.description,
    phase: "package",
    dedupeKey: `path:${win32.normalize(options.target).toLowerCase()}`,
    validate: async () => {
      validatedState = await inspectManagedTargets();
      if (
        validatedState.status === "root-present" &&
        residualRemovalOperation !== undefined
      ) {
        await residualRemovalOperation.validate?.();
      }
    },
    ...(residualRemovalOperation === undefined
      ? {}
      : {
          validateAfterPreflight: async () => {
            if (validatedState?.status === "root-present") {
              await residualRemovalOperation.validateAfterPreflight?.();
            }
          },
        }),
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
        const disposition = windowsInstallerExitDisposition(result.exitCode);
        if (
          disposition === "restart-required" ||
          disposition === "restart-initiated"
        ) {
          return restartResult(executable, disposition);
        }
        if (disposition === "failed") {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, executable, result.exitCode),
          };
        }
      }

      const afterUninstall = await inspectManagedTargets();
      if (afterUninstall.status === "root-absent") {
        return { status: "removed" };
      }
      if (
        !sameWindowsObjectIdentity(validatedState.root, afterUninstall.root)
      ) {
        return {
          status: "failed",
          detail: `installation root changed after uninstall: '${options.target}'`,
        };
      }
      const residualBoundary =
        residualRemovalOperation !== undefined ||
        captureInstallationBoundary === undefined
          ? undefined
          : await captureInstallationBoundary(
              options.target,
              [win32.dirname(options.target)],
              options.context,
            );
      if (
        residualBoundary !== undefined &&
        !boundaryEndsWithWindowsIdentity(residualBoundary, afterUninstall.root)
      ) {
        return {
          status: "failed",
          detail: `installation root changed before locked removal: '${options.target}'`,
        };
      }

      // Some quiet uninstallers intentionally leave caches behind. The root is
      // fixed by the image definition, so remove only that exact residual tree.
      const residual =
        residualRemovalOperation === undefined
          ? await removeInstallationRoot(options.target, residualBoundary)
          : await residualRemovalOperation.run();
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
  return createRemovePathOperation({
    id: `windows:residual:${component}:${target}`,
    component,
    description,
    target,
    allowedParents: [win32.dirname(target)],
    context,
    phase: "system",
  });
}

export interface WindowsDockerEngineDependencies {
  readonly control?: WindowsServiceControl;
  readonly lifecycle?: WindowsDockerServiceLifecycle;
  readonly createTargetOperation?: (target: string) => Operation;
  readonly removeDockerData?: boolean;
  readonly validateTarget?: (
    target: string,
  ) => Promise<RemovalBoundarySnapshot | undefined>;
  readonly removeTarget?: (
    target: string,
    expectedBoundary?: RemovalBoundarySnapshot,
  ) => Promise<OperationResult>;
}

function sameDockerServiceRegistrationIdentity(
  left: WindowsServiceSnapshot,
  right: WindowsServiceSnapshot,
): boolean {
  const sameRegistration =
    left.component === "docker-engine" &&
    right.component === "docker-engine" &&
    left.serviceName === "docker" &&
    right.serviceName === "docker" &&
    left.status === right.status &&
    left.executable === right.executable &&
    sameOptionalWindowsPathIdentity(
      left.executableIdentity,
      right.executableIdentity,
    );
  if (!sameRegistration || left.status === "missing") {
    return sameRegistration;
  }
  return (
    left.configuration !== undefined &&
    right.configuration !== undefined &&
    windowsServiceConfigurationWithoutStartType(left.configuration) ===
      windowsServiceConfigurationWithoutStartType(right.configuration)
  );
}

async function inspectDockerServiceRegistration(
  paths: WindowsPaths,
  control: WindowsServiceControl,
  deadline = windowsServiceClock(control)() +
    WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS,
): Promise<WindowsServiceSnapshot> {
  const snapshots = await discoverWindowsServices(
    paths,
    {
      profile: "custom",
      enabled: new Set<ComponentId>(["docker-engine"]),
      skipped: new Set<ComponentId>(),
      swapfileBytes: undefined,
    },
    control,
    deadline,
  );
  const snapshot = snapshots[0];
  if (snapshot === undefined || snapshots.length !== 1) {
    throw new Error("Unable to establish the exact docker service identity");
  }
  if (
    snapshot.status === "present" &&
    (snapshot.executable === undefined ||
      snapshot.executableIdentity === undefined ||
      snapshot.configuration === undefined)
  ) {
    throw new Error(
      "Unable to establish the exact docker service configuration and executable identity",
    );
  }
  return snapshot;
}

function assertDockerServiceReadyForPayloadMutation(
  validated: WindowsServiceSnapshot,
  current: WindowsServiceSnapshot,
): void {
  if (!sameDockerServiceRegistrationIdentity(validated, current)) {
    throw new Error(
      "docker service configuration changed after plan validation",
    );
  }
  if (
    current.status === "present" &&
    (current.state !== 1 || current.startType !== 4)
  ) {
    throw new Error(
      "docker service was not stopped and disabled before terminal cleanup",
    );
  }
}

function isWindowsServiceDeletionPending(result: CommandResult): boolean {
  return result.exitCode === 1072;
}

export function createWindowsDockerEngineOperation(
  context: RuntimeContext,
  paths: WindowsPaths,
  dependencies: WindowsDockerEngineDependencies = {},
): Operation {
  const control = dependencies.control ?? windowsServiceControl(paths);
  const lifecycle =
    dependencies.lifecycle ?? createWindowsDockerServiceLifecycle();
  const removeDockerData = dependencies.removeDockerData ?? true;
  const validateTarget =
    dependencies.validateTarget ??
    (async (target: string) => await validateExactTarget(context, target));
  const removeTarget =
    dependencies.removeTarget ??
    (async (target: string, expectedBoundary?: RemovalBoundarySnapshot) =>
      await removeExactTarget(context, target, expectedBoundary));
  const serviceExecutable = win32.join(paths.system32, "dockerd.exe");
  const dockerData = win32.join(paths.programData, "docker");
  const payloadTargets = [
    win32.join(paths.system32, "docker.exe"),
    win32.join(paths.systemRoot, "SysWOW64", "docker.exe"),
    removeDockerData ? dockerData : win32.join(dockerData, "cli-plugins"),
  ];
  const targets = [...payloadTargets, serviceExecutable];
  const createTargetOperation =
    dependencies.createTargetOperation ??
    (dependencies.validateTarget === undefined &&
    dependencies.removeTarget === undefined
      ? (target: string): Operation =>
          createRemovePathOperation({
            id: `windows:docker:locked-target:${target}`,
            component: "docker-engine",
            description: `Remove exact Windows Docker target ${target}`,
            target,
            allowedParents: [win32.dirname(target)],
            context,
            phase: "system",
          })
      : undefined);
  const targetOperations =
    createTargetOperation === undefined
      ? undefined
      : new Map(
          targets.map((target) => [target, createTargetOperation(target)]),
        );
  let validatedRegistration: WindowsServiceSnapshot | undefined;
  let validatedTargets:
    ReadonlyMap<string, RemovalBoundarySnapshot | undefined> | undefined;
  const validateTargets = async (): Promise<
    ReadonlyMap<string, RemovalBoundarySnapshot | undefined>
  > => {
    const snapshots = new Map<string, RemovalBoundarySnapshot | undefined>();
    for (const target of targets) {
      const operation = targetOperations?.get(target);
      if (operation !== undefined) {
        if (operation.validate === undefined) {
          throw new Error(
            `Windows Docker target has no locked-removal preflight: '${target}'`,
          );
        }
        await operation.validate();
        snapshots.set(target, undefined);
      } else {
        snapshots.set(target, await validateTarget(target));
      }
    }
    return snapshots;
  };
  const removeValidatedTarget = async (
    target: string,
  ): Promise<OperationResult> => {
    const operation = targetOperations?.get(target);
    return operation === undefined
      ? await removeTarget(target, validatedTargets?.get(target))
      : await operation.run();
  };
  return createFunctionOperation({
    id: "windows:docker:engine",
    component: "docker-engine",
    description: "Remove runner-image Docker Engine binaries",
    phase: "system",
    dedupeKey: "windows:docker:engine",
    validate: async () => {
      validatedTargets = await validateTargets();
      validatedRegistration = await inspectDockerServiceRegistration(
        paths,
        control,
      );
    },
    ...(targetOperations === undefined
      ? {}
      : {
          validateAfterPreflight: async () => {
            for (const operation of targetOperations.values()) {
              await operation.validateAfterPreflight?.();
            }
          },
        }),
    run: async (): Promise<OperationResult> => {
      const serviceNow = windowsServiceClock(control);
      let serviceBudgetMilliseconds = WINDOWS_SERVICE_COORDINATION_TIMEOUT_MS;
      const withServiceBudget = async <T>(
        description: string,
        task: (deadline: number) => Promise<T>,
      ): Promise<T> => {
        const startedAt = serviceNow();
        if (!Number.isFinite(startedAt) || serviceBudgetMilliseconds <= 0) {
          throw new Error(
            `${description} exceeded its two-minute aggregate deadline`,
          );
        }
        const deadline = startedAt + serviceBudgetMilliseconds;
        windowsServiceCoordinationRemainingMilliseconds(
          serviceNow,
          deadline,
          description,
        );
        let result: T | undefined;
        let taskFailed = false;
        let taskError: unknown;
        try {
          result = await task(deadline);
        } catch (error) {
          taskFailed = true;
          taskError = error;
        }
        let deadlineFailed = false;
        let deadlineError: unknown;
        try {
          windowsServiceCoordinationRemainingMilliseconds(
            serviceNow,
            deadline,
            description,
          );
        } catch (error) {
          deadlineFailed = true;
          deadlineError = error;
        }
        try {
          const completedAt = serviceNow();
          const elapsed = completedAt - startedAt;
          if (!Number.isFinite(elapsed) || elapsed < 0) {
            throw new Error(`${description} observed an invalid service clock`);
          }
          serviceBudgetMilliseconds = Math.max(
            0,
            serviceBudgetMilliseconds - elapsed,
          );
          windowsServiceCoordinationRemainingMilliseconds(
            () => completedAt,
            deadline,
            description,
          );
        } catch (error) {
          serviceBudgetMilliseconds = 0;
          deadlineFailed = true;
          deadlineError = error;
        }
        if (taskFailed) {
          if (deadlineFailed) {
            throw combinedWindowsTaskDeadlineError(taskError, deadlineError);
          }
          throw taskError;
        }
        if (deadlineFailed) throw deadlineError;
        return result as T;
      };
      try {
        validatedTargets ??= await validateTargets();
        validatedRegistration ??= await withServiceBudget(
          "Windows Docker service discovery",
          async (deadline) =>
            await inspectDockerServiceRegistration(paths, control, deadline),
        );
        const beforePayload = await withServiceBudget(
          "Windows Docker service discovery",
          async (deadline) =>
            await inspectDockerServiceRegistration(paths, control, deadline),
        );
        assertDockerServiceReadyForPayloadMutation(
          validatedRegistration,
          beforePayload,
        );
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      let removed = false;
      // Keep the service executable available for coordinator rollback until
      // the exact stopped registration is verified absent.
      for (const target of payloadTargets) {
        try {
          const current = await withServiceBudget(
            "Windows Docker service discovery",
            async (deadline) =>
              await inspectDockerServiceRegistration(paths, control, deadline),
          );
          assertDockerServiceReadyForPayloadMutation(
            validatedRegistration,
            current,
          );
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const result = await removeValidatedTarget(target);
        if (result.status === "removed") removed = true;
        if (result.status === "failed") {
          return {
            status: "failed",
            detail: `${target}: ${result.detail ?? "removal failed"}`,
          };
        }
      }

      try {
        if (validatedRegistration === undefined) {
          throw new Error("docker service validation state is unavailable");
        }
        const immediate = await withServiceBudget(
          "Windows Docker service discovery",
          async (deadline) =>
            await inspectDockerServiceRegistration(paths, control, deadline),
        );
        assertDockerServiceReadyForPayloadMutation(
          validatedRegistration,
          immediate,
        );
        let registrationVerifiedAbsent = immediate.status === "missing";
        if (!registrationVerifiedAbsent) {
          let registrationAbsent = false;
          const registrationFailure = await withServiceBudget(
            "Windows Docker service cleanup",
            async (serviceDeadline): Promise<string | undefined> => {
              const serviceRemaining = (): number =>
                windowsServiceCoordinationRemainingMilliseconds(
                  serviceNow,
                  serviceDeadline,
                  "Windows Docker service cleanup",
                );
              const deadline = Math.min(
                serviceDeadline,
                serviceNow() + WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS,
              );
              const transitionRemaining = (): number => {
                serviceRemaining();
                return windowsServiceRemainingMilliseconds(
                  serviceNow,
                  deadline,
                  "docker service registration deletion",
                );
              };
              const deletion = await runWindowsDeadlineTask(
                transitionRemaining,
                async (timeoutMs) => await control.delete("docker", timeoutMs),
              );
              assertCompleteWindowsCommandOutput(
                deletion,
                "docker service deletion",
              );
              if (
                deletion.exitCode !== 0 &&
                !isMissingWindowsService(deletion) &&
                !isWindowsServiceDeletionPending(deletion)
              ) {
                return failureDetail(
                  deletion.stderr || deletion.stdout,
                  paths.serviceControl,
                  deletion.exitCode,
                );
              }

              const wait =
                control.wait ??
                (async (milliseconds: number) =>
                  await new Promise((resolve) =>
                    setTimeout(resolve, milliseconds),
                  ));
              for (let attempt = 0; attempt < 60; attempt += 1) {
                const current = await runWindowsDeadlineTask(
                  transitionRemaining,
                  async (timeoutMs) => await control.query("docker", timeoutMs),
                );
                assertCompleteWindowsCommandOutput(
                  current,
                  "docker service deletion verification",
                );
                if (isMissingWindowsService(current)) {
                  registrationAbsent = true;
                  return undefined;
                }
                if (isWindowsServiceDeletionPending(current)) {
                  await runWindowsDeadlineTask(
                    transitionRemaining,
                    async (timeoutMs) => await wait(Math.min(500, timeoutMs)),
                  );
                  continue;
                }
                if (current.exitCode !== 0) {
                  return failureDetail(
                    current.stderr || current.stdout,
                    paths.serviceControl,
                    current.exitCode,
                  );
                }
                await runWindowsDeadlineTask(
                  transitionRemaining,
                  async (timeoutMs) => await wait(Math.min(500, timeoutMs)),
                );
              }
              return "docker service remained registered after deletion";
            },
          );
          if (registrationFailure !== undefined) {
            return { status: "failed", detail: registrationFailure };
          }
          if (registrationAbsent) {
            registrationVerifiedAbsent = true;
            removed = true;
          }
        }

        if (!registrationVerifiedAbsent) {
          return {
            status: "failed",
            detail: "docker service absence could not be verified",
          };
        }
        const beforeExecutableRemoval = await withServiceBudget(
          "Windows Docker service discovery",
          async (deadline) =>
            await inspectDockerServiceRegistration(paths, control, deadline),
        );
        if (beforeExecutableRemoval.status !== "missing") {
          return {
            status: "failed",
            detail:
              "docker service was recreated or remained registered before dockerd removal",
          };
        }
        lifecycle.finalizeRegistration();

        const executableRemoval =
          await removeValidatedTarget(serviceExecutable);
        if (executableRemoval.status === "failed") {
          return {
            status: "failed",
            detail: `${serviceExecutable}: ${executableRemoval.detail ?? "removal failed"}`,
          };
        }
        if (executableRemoval.status === "removed") removed = true;
        const finalRegistration = await withServiceBudget(
          "Windows Docker service discovery",
          async (deadline) =>
            await inspectDockerServiceRegistration(paths, control, deadline),
        );
        if (finalRegistration.status !== "missing") {
          return {
            status: "failed",
            detail:
              "docker service was recreated or remained registered after dockerd removal",
          };
        }
        return removed
          ? {
              status: "removed",
              detail: "removed Docker payload and service registration",
            }
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

export async function createWindowsAdapter(
  context: RuntimeContext,
): Promise<Adapter> {
  const normalizedHome = win32.normalize(context.home);
  if (normalizedHome.toLowerCase() !== "c:\\users\\runneradmin") {
    throw new Error(
      `Refusing unexpected Windows runner home '${context.home}'; no cleanup was scheduled.`,
    );
  }
  const paths = windowsPaths(normalizedHome, context.architecture);
  const installedChocolateyPackages = lazyAsync(
    async () =>
      await listChocolateyPackages(
        paths.chocolatey,
        paths.chocolateyEnvironment,
      ),
  );
  const installedUninstallRecords = lazyAsync(
    async () => await listWindowsUninstallRecords(paths),
  );
  const installedMsiProducts = lazyAsync(async () => {
    const inventory = await installedUninstallRecords();
    return {
      products: msiProductsFromRecords(inventory.records),
      registryExecutable: inventory.registryExecutable,
    };
  });
  const visualStudioInstances = lazyAsync(
    async () => await listVisualStudioInstances(paths),
  );

  return {
    supportedComponents: SUPPORTED,
    operations: async (plan: CleanupPlan): Promise<readonly Operation[]> => {
      const operations: Operation[] = [];
      const serviceControl = windowsServiceControl(paths);
      const dockerServiceLifecycle = createWindowsDockerServiceLifecycle();
      const serviceCoordinator = createWindowsServiceCoordinator(
        paths,
        plan,
        serviceControl,
        dockerServiceLifecycle,
      );
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
      const toolCacheComponents = [
        "cached-tools",
        "codeql",
        "cached-go",
        "cached-node",
        "cached-python",
        "cached-pypy",
        "cached-ruby",
        "haskell",
        "java",
      ] as const satisfies readonly ComponentId[];
      if (
        toolCache === undefined &&
        toolCacheComponents.some((component) => plan.enabled.has(component))
      ) {
        throw new Error(
          `RUNNER_TOOL_CACHE must be exactly '${expectedToolCache}' for selected Windows toolcache cleanup`,
        );
      }
      const localAppData = win32.join(normalizedHome, "AppData", "Local");

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
        "dotnet",
        win32.join(normalizedHome, ".dotnet"),
        "Remove runner-user .NET tools",
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
        "android",
        win32.join(normalizedHome, ".android"),
        "Remove Android user state",
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
        "miniconda",
        win32.join(normalizedHome, ".conda"),
        "Remove Conda user cache",
      );
      addFixed(
        "miniconda",
        win32.join(localAppData, "conda"),
        "Remove Conda download cache",
      );
      addFixed(
        "vcpkg",
        win32.join(paths.drive, "vcpkg"),
        "Remove vcpkg checkout",
      );
      addFixed(
        "vcpkg",
        win32.join(normalizedHome, ".vcpkg"),
        "Remove vcpkg user state",
      );
      addFixed(
        "vcpkg",
        win32.join(localAppData, "vcpkg"),
        "Remove vcpkg cache",
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
      if (toolCache !== undefined) {
        addFixed("cached-tools", toolCache, "Remove hosted toolcache");
        operations.push(
          createWindowsToolCacheRecreateOperation(context, toolCache),
        );
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
          createWindowsMsiOperation(
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
        createWindowsMsiOperation(
          paths,
          "powershell",
          [/^PowerShell 7(?:-(?:x64|arm64))?$/i],
          installedMsiProducts,
          "powershell-7",
          "Uninstall PowerShell 7 MSI",
        ),
      );
      operations.push(
        createWindowsChocolateyOperation(
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
        createWindowsChocolateyOperation(
          paths,
          "aws-cli",
          ["awscli"],
          installedChocolateyPackages,
        ),
      );
      operations.push(
        createWindowsMsiOperation(
          paths,
          "aws-cli",
          [/^AWS Systems Manager Session Manager Plugin$/i],
          installedMsiProducts,
          "aws-session-manager-plugin",
          "Uninstall AWS Session Manager Plugin MSI",
        ),
      );
      operations.push(
        createWindowsMsiOperation(
          paths,
          "aws-sam-cli",
          [/^AWS SAM Command Line Interface(?: \(.+\))?$/i],
          installedMsiProducts,
          "aws-sam-cli",
          "Uninstall AWS SAM CLI MSI",
        ),
      );
      operations.push(
        createWindowsMsiOperation(
          paths,
          "azure-cli",
          [/^Microsoft Azure CLI(?: \(64-bit\))?$/i],
          installedMsiProducts,
          "azure-cli",
          "Uninstall Azure CLI MSI",
        ),
      );
      operations.push(
        createWindowsMsiOperation(
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
          createWindowsChocolateyOperation(
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
        const nginxVersions = await listWindowsVersionedDirectories(
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
        createWindowsMsiOperation(
          paths,
          "mysql",
          [/^MySQL Server 8\.0$/i],
          installedMsiProducts,
          "mysql-server-8",
          "Uninstall runner-image MySQL CLI MSI",
        ),
      );

      if (plan.enabled.has("postgresql")) {
        const programRoot = win32.join(paths.programFiles, "PostgreSQL");
        const dataRoot = win32.join(paths.drive, "PostgreSQL");
        const [programVersions, dataVersions] = await Promise.all([
          listWindowsVersionedDirectories(programRoot, /^\d+(?:\.\d+)*$/),
          listWindowsVersionedDirectories(dataRoot, /^\d+(?:\.\d+)*$/),
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

      operations.push(
        createWindowsDockerPruneOperation(paths, {
          context,
        }),
      );
      operations.push(
        createWindowsDockerEngineOperation(context, paths, {
          control: serviceControl,
          lifecycle: dockerServiceLifecycle,
          removeDockerData: !plan.skipped.has("docker-images"),
        }),
      );

      // Visual Studio-owned SDK components and standalone SDK/WDK bundles are
      // independently installed on current runner images, so both cleanup
      // paths remain independently eligible.
      operations.push(
        createWindowsVisualStudioOperation(paths, visualStudioInstances),
      );
      operations.push(
        createWindowsSdkComponentOperation(paths, visualStudioInstances),
      );
      operations.push(
        createWindowsSdkBundleOperation(paths, installedUninstallRecords),
      );

      const serviceRegistrationCleanup =
        createWindowsServiceRegistrationCleanup(
          paths,
          plan,
          serviceControl,
          dockerServiceLifecycle,
        );
      if (serviceRegistrationCleanup !== undefined) {
        operations.push(serviceRegistrationCleanup);
      }

      // Retaining Visual Studio while stripping one of its definition-owned
      // SDK/toolchain roots can leave the selected instance unusable.  A
      // `max` skip is a preservation request, so conservatively keep those
      // overlapping payloads with Visual Studio.  Custom mode has no skips and
      // can still remove any of the components independently.
      const selectedOperations = plan.skipped.has("visual-studio")
        ? operations.filter((operation) => {
            const protectedComponents = new Set<ComponentId>([
              "visual-studio",
              ...VISUAL_STUDIO_OVERLAPS,
            ]);
            return !protectedComponents.has(operation.component);
          })
        : operations;

      if (serviceCoordinator === undefined) return selectedOperations;
      return selectedOperations.map((operation) => {
        if (
          operation === serviceCoordinator ||
          operation.id === "windows:services:unregister" ||
          operation.phase === "preflight" ||
          !WINDOWS_SERVICE_GUARDED_COMPONENTS.has(operation.component)
        ) {
          return operation;
        }
        return guardWindowsServiceOperation(operation, serviceCoordinator);
      });
    },
  };
}
