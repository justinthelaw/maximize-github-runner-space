import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { win32 } from "node:path";
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
} from "../operations.js";
import {
  assertSafeDirectoryTarget,
  captureSafeRemovalBoundary,
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

const SUPPORTED = new Set<ComponentId>(
  COMPONENTS.filter((component) =>
    component.platforms.some((platform) => platform === "windows"),
  ).map((component) => component.id),
);

const MSI_ABSENT_EXIT_CODES = new Set([1605, 1614]);
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

export interface WindowsPathIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs?: bigint;
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
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.contentSha256 === right.contentSha256
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
  readonly executable?: string;
  readonly executableIdentity?: WindowsPathIdentity;
  readonly configuration?: string;
}

export interface WindowsServiceControl {
  exists(): Promise<boolean>;
  inspectExecutable?(
    executable: string,
  ): Promise<WindowsPathIdentity | undefined>;
  inventory(): Promise<CommandResult>;
  query(serviceName: string): Promise<CommandResult>;
  config?(serviceName: string): Promise<CommandResult>;
  stop(serviceName: string): Promise<CommandResult>;
  start?(serviceName: string): Promise<CommandResult>;
  delete(serviceName: string): Promise<CommandResult>;
  wait?(milliseconds: number): Promise<void>;
}

export interface WindowsDockerServiceLifecycle {
  isRegistrationFinalized(): boolean;
  finalizeRegistration(): void;
}

export function createWindowsDockerServiceLifecycle(): WindowsDockerServiceLifecycle {
  let registrationFinalized = false;
  return {
    isRegistrationFinalized: () => registrationFinalized,
    finalizeRegistration: () => {
      registrationFinalized = true;
    },
  };
}
export function windowsInstallerExitDisposition(
  exitCode: number,
): "completed" | "restart-initiated" | "failed" {
  if (exitCode === 0 || exitCode === 3010) return "completed";
  if (exitCode === 1641) return "restart-initiated";
  return "failed";
}

function restartInitiatedResult(executable: string): OperationResult {
  return {
    status: "failed",
    detail: `${executable} exited 1641 after initiating a system restart; refusing further cleanup`,
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
      await inspectWindowsExecutable(executable),
    exists: async () => {
      try {
        await assertStableExecutable();
        return true;
      } catch {
        return false;
      }
    },
    inventory: async () => {
      await assertStableExecutable();
      return await runCommand(
        paths.serviceControl,
        POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
        {
          env: paths.commandEnvironment,
          silent: true,
          timeoutMs: 30_000,
        },
      );
    },
    query: async (serviceName) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["query", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: 30_000,
      });
    },
    config: async (serviceName) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["qc", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: 30_000,
      });
    },
    stop: async (serviceName) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["stop", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: 30_000,
      });
    },
    start: async (serviceName) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["start", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: 30_000,
      });
    },
    delete: async (serviceName) => {
      await assertStableExecutable();
      return await runCommand(paths.serviceControl, ["delete", serviceName], {
        env: paths.commandEnvironment,
        silent: true,
        timeoutMs: 30_000,
      });
    },
  };
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

function isWindowsPathAtOrBelow(candidate: string, parent: string): boolean {
  return (
    sameWindowsPath(candidate, parent) ||
    isStrictWindowsDescendant(candidate, parent)
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
  const accepted =
    component === "docker-engine"
      ? sameWindowsPath(executable, win32.join(paths.system32, "dockerd.exe"))
      : component === "apache"
        ? win32.basename(executable).toLowerCase() === "httpd.exe" &&
          isWindowsPathAtOrBelow(
            executable,
            win32.join(paths.drive, "tools", "Apache24"),
          )
        : component === "nginx"
          ? win32.basename(executable).toLowerCase() === "nginx.exe" &&
            isWindowsPathAtOrBelow(executable, win32.join(paths.drive, "tools"))
          : component === "postgresql"
            ? win32.basename(executable).toLowerCase() === "pg_ctl.exe" &&
              isWindowsPathAtOrBelow(
                executable,
                win32.join(paths.programFiles, "PostgreSQL"),
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

function normalizedWindowsServiceConfiguration(output: string): string {
  return output.trim().replace(/\r\n/g, "\n");
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
    const result = await control.query(target.serviceName);
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
    if (
      control.config === undefined ||
      control.inspectExecutable === undefined
    ) {
      throw new Error(
        `${target.serviceName}: service configuration and executable identity cannot be verified`,
      );
    }
    const config = await control.config(target.serviceName);
    assertCompleteWindowsCommandOutput(
      config,
      `${target.serviceName} service configuration`,
    );
    if (config.exitCode !== 0) {
      throw windowsServiceFailure(paths, target.serviceName, config);
    }
    executable = parseAndValidateWindowsServiceExecutable(
      paths,
      target.component,
      target.serviceName,
      config.stdout,
    );
    executableIdentity = await control.inspectExecutable(executable);
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
      ...(executable === undefined ? {} : { executable }),
      ...(executableIdentity === undefined ? {} : { executableIdentity }),
      ...(configuration === undefined ? {} : { configuration }),
    });
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
        target.state === right[index]?.state &&
        target.executable === right[index]?.executable &&
        sameOptionalWindowsPathIdentity(
          target.executableIdentity,
          right[index]?.executableIdentity,
        ) &&
        target.configuration === right[index]?.configuration,
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
  if (stop.exitCode !== 0 && stop.exitCode !== 1062) {
    throw windowsServiceFailure(paths, target.serviceName, stop);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await control.query(target.serviceName);
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${target.serviceName} did not stop within 30 seconds`);
}

export function createWindowsServiceCoordinator(
  paths: WindowsPaths,
  plan: CleanupPlan,
  control: WindowsServiceControl = windowsServiceControl(paths),
  dockerLifecycle?: WindowsDockerServiceLifecycle,
): Operation | undefined {
  const fixed = selectedFixedWindowsServices(plan);
  if (fixed.length === 0 && !plan.enabled.has("postgresql")) return undefined;
  const component = fixed[0]?.component ?? "postgresql";
  const wait =
    control.wait ??
    (async (milliseconds: number) =>
      await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let validated: readonly WindowsServiceSnapshot[] | undefined;
  let stoppedByAction: WindowsServiceSnapshot[] = [];
  let rollbackInFlight: Promise<void> | undefined;
  const validate = async (): Promise<void> => {
    validated = await discoverWindowsServices(paths, plan, control);
  };
  const performRollback = async (): Promise<void> => {
    assertCommandTerminationConfirmed();
    if (stoppedByAction.length === 0) return;
    const pending = [...stoppedByAction];
    const restored = new Set<WindowsServiceSnapshot>();
    const failures: string[] = [];
    for (const target of [...pending].reverse()) {
      assertCommandTerminationConfirmed();
      try {
        if (
          target.component === "docker-engine" &&
          dockerLifecycle?.isRegistrationFinalized() === true
        ) {
          restored.add(target);
          continue;
        }
        const current = await control.query(target.serviceName);
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
        if (currentState === 4) {
          restored.add(target);
          continue;
        }
        if (currentState !== 1) {
          throw new Error(
            `${target.serviceName} entered an unsafe state before restart`,
          );
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
        const configuration = await control.config(target.serviceName);
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
        const executableIdentity = await control.inspectExecutable(executable);
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

        const started = await control.start(target.serviceName);
        if (started.exitCode !== 0 && started.exitCode !== 1056) {
          throw windowsServiceFailure(paths, target.serviceName, started);
        }

        let running = false;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const currentResult = await control.query(target.serviceName);
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
          await wait(500);
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
    stoppedByAction = pending.filter((target) => !restored.has(target));
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
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
  return createFunctionOperation({
    id: "windows:services:stop",
    component,
    description: "Stop selected Windows services before cleanup",
    phase: "preflight",
    dedupeKey: "windows:services:stop",
    fatal: true,
    validate,
    rollback,
    run: async (): Promise<OperationResult> => {
      if (stoppedByAction.length !== 0) {
        return await failWithRollback(
          "Windows service rollback state remained before execution",
        );
      }
      try {
        validated ??= await discoverWindowsServices(paths, plan, control);
        const immediate = await discoverWindowsServices(paths, plan, control);
        if (!sameWindowsServiceSnapshot(validated, immediate)) {
          return await failWithRollback(
            "Windows service inventory changed after plan validation",
          );
        }
        for (const target of immediate) {
          if (target.status === "present" && target.state !== 1) {
            stoppedByAction.push(target);
          }
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
              target.executable !== immediate[index]?.executable ||
              !sameOptionalWindowsPathIdentity(
                target.executableIdentity,
                immediate[index]?.executableIdentity,
              ) ||
              target.configuration !== immediate[index]?.configuration ||
              (target.status === "present" && target.state !== 1),
          )
        ) {
          return await failWithRollback(
            "Windows service inventory changed or reactivated after stop",
          );
        }
        // Preflight never unregisters a service. A later component-owned
        // operation may remove registration only after its payload cleanup and
        // postconditions have succeeded.
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
    const selected = entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          pattern.test(entry.name),
      )
      .map((entry) => win32.join(parent, entry.name))
      .sort((left, right) => left.localeCompare(right));
    if (selected.length > MAX_VERSIONED_CHILDREN) {
      throw new Error(
        `versioned directory inventory under '${parent}' exceeded ${MAX_VERSIONED_CHILDREN} entries`,
      );
    }
    return selected;
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

export async function listChocolateyPackages(
  executable: string,
  environment: NodeJS.ProcessEnv = windowsPaths().chocolateyEnvironment,
  dependencies: WindowsInventoryDependencies = {},
): Promise<WindowsChocolateyInventory> {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const executableIdentity = await inspect(executable);
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
      timeoutMs: 2 * 60_000,
    },
  );
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
      throw new Error("Chocolatey returned an unsafe package inventory record");
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const version = line.slice(separator + 1).trim();
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) ||
      version === "" ||
      version.length > 128
    ) {
      throw new Error("Chocolatey returned an unsafe package inventory record");
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
            ...dependencies,
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
        if (disposition === "restart-initiated") {
          return restartInitiatedResult(paths.chocolatey);
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
            ...dependencies,
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
  const records: WindowsUninstallRecord[] = [];
  let currentKey: string | undefined;
  let values = new Map<string, string>();
  const flush = (): void => {
    if (currentKey === undefined) return;
    const displayName = values.get("displayname");
    const displayVersion = values.get("displayversion");
    const bundleCachePath = values.get("bundlecachepath");
    const windowsInstallerText = values.get("windowsinstaller");
    const windowsInstaller =
      windowsInstallerText === undefined
        ? undefined
        : /^0x[0-9a-f]+$/i.test(windowsInstallerText)
          ? Number.parseInt(windowsInstallerText.slice(2), 16)
          : /^\d+$/.test(windowsInstallerText)
            ? Number.parseInt(windowsInstallerText, 10)
            : undefined;
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
      continue;
    }
    if (currentKey === undefined) continue;
    const value =
      /^\s*([^\s]+)\s+REG_(?:SZ|EXPAND_SZ|DWORD|QWORD)\s+(.*?)\s*$/i.exec(line);
    const name = value?.[1];
    const contents = value?.[2];
    if (name !== undefined && contents !== undefined) {
      values.set(name.toLowerCase(), contents);
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
  const registryExecutable = await inspect(paths.reg);
  if (registryExecutable === undefined) {
    throw new Error(`reg.exe is unavailable at ${paths.reg}`);
  }
  const byKey = new Map<string, WindowsUninstallRecord>();
  for (const root of UNINSTALL_REGISTRY_ROOTS) {
    const result = await execute(paths.reg, ["query", root, "/s"], {
      env: paths.commandEnvironment,
      silent: true,
      timeoutMs: 2 * 60_000,
    });
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
    if (result.stdoutTruncated === true || result.stderrTruncated === true) {
      throw new Error(
        "uninstall registry inventory exceeded the safe output bound",
      );
    }
    for (const record of parseWindowsUninstallRecords(result.stdout)) {
      byKey.set(win32.normalize(record.registryKey).toLowerCase(), record);
    }
  }
  const currentRegistryExecutable = await inspect(paths.reg);
  if (!sameWindowsPathIdentity(registryExecutable, currentRegistryExecutable)) {
    throw new Error("reg.exe changed while reading the installed product list");
  }
  return {
    records: [...byKey.values()],
    registryExecutable,
  };
}

export async function listMsiProducts(
  paths: WindowsPaths,
  dependencies: WindowsInventoryDependencies = {},
): Promise<WindowsMsiInventory> {
  const inventory = await listWindowsUninstallRecords(paths, dependencies);
  const byCode = new Map<string, MsiProduct>();
  for (const record of inventory.records) {
    const product = msiProductFromRecord(record);
    if (product !== undefined) {
      byCode.set(product.productCode.toLowerCase(), product);
    }
  }
  return {
    products: [...byCode.values()],
    registryExecutable: inventory.registryExecutable,
  };
}

async function readExactUninstallRecord(
  paths: WindowsPaths,
  registryKey: string,
  expectedRegistryExecutable: WindowsPathIdentity,
  dependencies: WindowsInventoryDependencies,
): Promise<WindowsUninstallRecord | undefined> {
  const inspect = dependencies.inspectExecutable ?? inspectWindowsExecutable;
  const execute = dependencies.runCommand ?? runCommand;
  const before = await inspect(paths.reg);
  if (!sameWindowsPathIdentity(expectedRegistryExecutable, before)) {
    throw new Error("reg.exe changed before exact product verification");
  }
  const result = await execute(paths.reg, ["query", registryKey], {
    env: paths.commandEnvironment,
    silent: true,
    timeoutMs: 30_000,
  });
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
    if (result.stdoutTruncated === true || result.stderrTruncated === true) {
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
  if (!sameWindowsPathIdentity(expectedRegistryExecutable, after)) {
    throw new Error("reg.exe changed during exact product verification");
  }
  return record;
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
            dependencies,
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
        if (disposition === "restart-initiated") {
          return restartInitiatedResult(paths.msiexec);
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
            dependencies,
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
  ) => Promise<OperationResult>;
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
    (async (target: string) =>
      await removeExactTarget(options.context, target));
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
            if (disposition === "restart-initiated") {
              return restartInitiatedResult(snapshot.candidate.executable);
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
          const residualRemoval = await removeInstallationRoot(
            snapshot.candidate.installationRoot,
          );
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
  const vswhereExecutable = await inspect(vswhere);
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
      timeoutMs: 2 * 60_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(failureDetail(result.stderr, vswhere, result.exitCode));
  }
  if (result.stdoutTruncated === true || result.stderrTruncated === true) {
    throw new Error("vswhere inventory exceeded the safe output bound");
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("vswhere returned invalid JSON");
  const roots = [
    win32.join(paths.programFiles, "Microsoft Visual Studio"),
    win32.join(paths.programFilesX86, "Microsoft Visual Studio"),
  ];
  const instances: VisualStudioInstance[] = [];
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
    const installationIdentity = await assertWindowsDirectoryChain(
      normalizedInstallationPath,
      definitionRoot,
      dependencies.pathProbe ?? NODE_WINDOWS_PATH_PROBE,
    );
    instances.push({
      installationPath: normalizedInstallationPath,
      definitionRoot,
      installationIdentity,
      installationVersion,
      productId,
    });
  }
  const byPath = new Map<string, VisualStudioInstance>();
  for (const instance of instances) {
    const key = instance.installationPath.toLowerCase();
    if (byPath.has(key)) {
      throw new Error(
        `vswhere returned a duplicate Visual Studio instance: ${instance.installationPath}`,
      );
    }
    byPath.set(key, instance);
  }
  if (byPath.size > 8) {
    throw new Error("Visual Studio inventory exceeded 8 instances");
  }
  const currentVswhereExecutable = await inspect(vswhere);
  if (!sameWindowsPathIdentity(vswhereExecutable, currentVswhereExecutable)) {
    throw new Error(
      "vswhere.exe changed while reading Visual Studio instances",
    );
  }
  return {
    instances: [...byPath.values()].sort((left, right) =>
      left.installationPath.localeCompare(right.installationPath),
    ),
    vswhereExecutable,
  };
}

async function verifyVisualStudioInstance(
  instance: VisualStudioInstance,
  dependencies: WindowsVisualStudioDependencies = {},
): Promise<boolean> {
  try {
    const current = await assertWindowsDirectoryChain(
      instance.installationPath,
      instance.definitionRoot,
      dependencies.pathProbe ?? NODE_WINDOWS_PATH_PROBE,
    );
    return sameWindowsPathIdentity(instance.installationIdentity, current);
  } catch {
    return false;
  }
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
          ...dependencies,
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
        if (!(await verifyVisualStudioInstance(instance, dependencies))) {
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
        if (disposition === "restart-initiated") {
          return restartInitiatedResult(setup);
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
          ...dependencies,
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
        if (!sameVisualStudioInstances(expected, after.instances)) {
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
          ...dependencies,
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
            ...dependencies,
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
            ...dependencies,
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
        if (!(await verifyVisualStudioInstance(instance, dependencies))) {
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
        if (disposition === "restart-initiated") {
          return restartInitiatedResult(setup);
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
            ...dependencies,
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
          ...dependencies,
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
        if (!sameVisualStudioInstance(instance, preservedInstance)) {
          return {
            status: "failed",
            detail: `Visual Studio instance identity changed during Windows SDK removal: ${instance.installationPath}`,
          };
        }
        if (
          !sameVisualStudioInstances(
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
  let validated: readonly WindowsSdkBundleSnapshot[] | undefined;
  const inspectSelected = async (): Promise<
    readonly WindowsSdkBundleSnapshot[]
  > => {
    const source = await inventory();
    const snapshots: WindowsSdkBundleSnapshot[] = [];
    for (const record of source.records) {
      const snapshot = await inspectWindowsSdkBundle(
        paths,
        record,
        dependencies,
      );
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    if (snapshots.length > 16) {
      throw new Error("Windows SDK bundle inventory exceeded 16 records");
    }
    return snapshots;
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
            dependencies,
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
          const immediate = await inspectWindowsSdkBundle(
            paths,
            currentRecord,
            dependencies,
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
          if (disposition === "restart-initiated") {
            return restartInitiatedResult(snapshot.executable);
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
            dependencies,
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
      const entries = await readdir(path);
      if (entries.length !== 0) {
        throw new Error("isolated Docker configuration is not empty");
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
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<WindowsPathIdentity | undefined>;
  readonly execute?: (
    executable: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
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
        const disposition = windowsInstallerExitDisposition(result.exitCode);
        if (disposition === "restart-initiated") {
          return restartInitiatedResult(executable);
        }
        if (disposition === "failed") {
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

export interface WindowsDockerEngineDependencies {
  readonly control?: WindowsServiceControl;
  readonly lifecycle?: WindowsDockerServiceLifecycle;
  readonly validateTarget?: (target: string) => Promise<void>;
  readonly removeTarget?: (target: string) => Promise<OperationResult>;
}

function sameDockerServiceRegistrationIdentity(
  left: WindowsServiceSnapshot,
  right: WindowsServiceSnapshot,
): boolean {
  return (
    left.component === "docker-engine" &&
    right.component === "docker-engine" &&
    left.serviceName === "docker" &&
    right.serviceName === "docker" &&
    left.status === right.status &&
    left.executable === right.executable &&
    sameOptionalWindowsPathIdentity(
      left.executableIdentity,
      right.executableIdentity,
    ) &&
    left.configuration === right.configuration
  );
}

async function inspectDockerServiceRegistration(
  paths: WindowsPaths,
  control: WindowsServiceControl,
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
  if (current.status === "present" && current.state !== 1) {
    throw new Error("docker service was not stopped before terminal cleanup");
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
  const validateTarget =
    dependencies.validateTarget ??
    (async (target: string) => await validateExactTarget(context, target));
  const removeTarget =
    dependencies.removeTarget ??
    (async (target: string) => await removeExactTarget(context, target));
  const serviceExecutable = win32.join(paths.system32, "dockerd.exe");
  const payloadTargets = [
    win32.join(paths.system32, "docker.exe"),
    win32.join(paths.systemRoot, "SysWOW64", "docker.exe"),
    win32.join(paths.programData, "docker", "cli-plugins"),
  ];
  const targets = [...payloadTargets, serviceExecutable];
  let validatedRegistration: WindowsServiceSnapshot | undefined;
  return createFunctionOperation({
    id: "windows:docker:engine",
    component: "docker-engine",
    description: "Remove runner-image Docker Engine binaries",
    phase: "system",
    dedupeKey: "windows:docker:engine",
    validate: async () => {
      for (const target of targets) {
        await validateTarget(target);
      }
      validatedRegistration = await inspectDockerServiceRegistration(
        paths,
        control,
      );
    },
    run: async (): Promise<OperationResult> => {
      try {
        validatedRegistration ??= await inspectDockerServiceRegistration(
          paths,
          control,
        );
        const beforePayload = await inspectDockerServiceRegistration(
          paths,
          control,
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
        const result = await removeTarget(target);
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
        const immediate = await inspectDockerServiceRegistration(
          paths,
          control,
        );
        assertDockerServiceReadyForPayloadMutation(
          validatedRegistration,
          immediate,
        );
        if (immediate.status === "missing") {
          lifecycle.finalizeRegistration();
        } else {
          const deletion = await control.delete("docker");
          assertCompleteWindowsCommandOutput(
            deletion,
            "docker service deletion",
          );
          if (
            deletion.exitCode !== 0 &&
            !isMissingWindowsService(deletion) &&
            !isWindowsServiceDeletionPending(deletion)
          ) {
            return {
              status: "failed",
              detail: failureDetail(
                deletion.stderr || deletion.stdout,
                paths.serviceControl,
                deletion.exitCode,
              ),
            };
          }

          const wait =
            control.wait ??
            (async (milliseconds: number) =>
              await new Promise((resolve) =>
                setTimeout(resolve, milliseconds),
              ));
          let registrationRemoved = false;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const current = await control.query("docker");
            assertCompleteWindowsCommandOutput(
              current,
              "docker service deletion verification",
            );
            if (isMissingWindowsService(current)) {
              lifecycle.finalizeRegistration();
              registrationRemoved = true;
              removed = true;
              break;
            }
            if (isWindowsServiceDeletionPending(current)) {
              await wait(500);
              continue;
            }
            if (current.exitCode !== 0) {
              return {
                status: "failed",
                detail: failureDetail(
                  current.stderr || current.stdout,
                  paths.serviceControl,
                  current.exitCode,
                ),
              };
            }
            await wait(500);
          }
          if (!registrationRemoved) {
            return {
              status: "failed",
              detail: "docker service remained registered after deletion",
            };
          }
        }

        const executableRemoval = await removeTarget(serviceExecutable);
        if (executableRemoval.status === "failed") {
          return {
            status: "failed",
            detail: `${serviceExecutable}: ${executableRemoval.detail ?? "removal failed"}`,
          };
        }
        if (executableRemoval.status === "removed") removed = true;
        const finalRegistration = await inspectDockerServiceRegistration(
          paths,
          control,
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
    const byCode = new Map<string, MsiProduct>();
    for (const record of inventory.records) {
      const product = msiProductFromRecord(record);
      if (product !== undefined) {
        byCode.set(product.productCode.toLowerCase(), product);
      }
    }
    return {
      products: [...byCode.values()],
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

      operations.push(
        createWindowsDockerPruneOperation(paths, {
          context,
        }),
      );
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
      operations.push(
        createWindowsDockerEngineOperation(context, paths, {
          control: serviceControl,
          lifecycle: dockerServiceLifecycle,
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
