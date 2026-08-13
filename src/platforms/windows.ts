import { access, mkdir, readdir } from "node:fs/promises";
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

interface WindowsServiceStopResult {
  readonly status: "stopped" | "missing" | "failed";
  readonly detail?: string;
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

interface WindowsPaths {
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

function windowsPaths(): WindowsPaths {
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

async function ensureWindowsServiceStopped(
  paths: WindowsPaths,
  serviceName: string,
): Promise<WindowsServiceStopResult> {
  const serviceFailure = (result: CommandResult): string =>
    `${serviceName}: ${failureDetail(
      result.stderr || result.stdout,
      paths.serviceControl,
      result.exitCode,
    )}`;
  const initial = await runCommand(
    paths.serviceControl,
    ["query", serviceName],
    { silent: true, timeoutMs: 30_000 },
  );
  if (isMissingWindowsService(initial)) return { status: "missing" };
  if (initial.exitCode !== 0) {
    return { status: "failed", detail: serviceFailure(initial) };
  }
  if (isStoppedWindowsService(initial)) return { status: "stopped" };

  const stop = await runCommand(paths.serviceControl, ["stop", serviceName], {
    silent: true,
    timeoutMs: 30_000,
  });
  if (isMissingWindowsService(stop)) return { status: "missing" };
  if (stop.exitCode !== 0) {
    return { status: "failed", detail: serviceFailure(stop) };
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await runCommand(
      paths.serviceControl,
      ["query", serviceName],
      { silent: true, timeoutMs: 5_000 },
    );
    if (isMissingWindowsService(status)) return { status: "missing" };
    if (status.exitCode !== 0) {
      return { status: "failed", detail: serviceFailure(status) };
    }
    if (isStoppedWindowsService(status)) return { status: "stopped" };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    status: "failed",
    detail: `${serviceName} did not stop within 30 seconds`,
  };
}

function fixedWindowsServiceStopOperation(
  paths: WindowsPaths,
  component: ComponentId,
  serviceName: string,
  description: string,
): Operation {
  return createFunctionOperation({
    id: `windows:${component}:service`,
    component,
    description,
    phase: "preflight",
    dedupeKey: `windows:service:${serviceName.toLowerCase()}`,
    fatal: true,
    run: async (): Promise<OperationResult> => {
      if (!(await pathExists(paths.serviceControl))) {
        return { status: "failed", detail: "sc.exe is unavailable" };
      }
      const result = await ensureWindowsServiceStopped(paths, serviceName);
      if (result.status === "missing") return { status: "not-found" };
      if (result.status === "failed") {
        return {
          status: "failed",
          detail: result.detail ?? `${serviceName}: service stop failed`,
        };
      }
      return { status: "removed", detail: `${serviceName} is stopped` };
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

function executableUninstallOperation(options: {
  readonly component: ComponentId;
  readonly id: string;
  readonly description: string;
  readonly candidates: readonly string[];
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Operation {
  return createFunctionOperation({
    id: `windows:uninstall:${options.component}:${options.id}`,
    component: options.component,
    description: options.description,
    phase: "package",
    dedupeKey: `windows:uninstall:${options.id}`,
    run: async (): Promise<OperationResult> => {
      const candidates = [...new Set(options.candidates)];
      let removed = false;
      for (const executable of candidates) {
        if (!(await pathExists(executable))) continue;
        const result = await runCommand(executable, options.args, {
          silent: true,
          timeoutMs: options.timeoutMs ?? 20 * 60_000,
        });
        if (!SUCCESS_EXIT_CODES.has(result.exitCode)) {
          return {
            status: "failed",
            detail: failureDetail(result.stderr, executable, result.exitCode),
          };
        }
        removed = true;
      }
      return removed ? { status: "removed" } : { status: "not-found" };
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
  coveredBy?: readonly ComponentId[],
): Operation {
  return createFunctionOperation({
    id: "windows:windows-sdk:remove-components",
    component: "windows-sdk",
    description: "Remove definition-listed Windows SDK and WDK components",
    phase: "package",
    dedupeKey: "windows:windows-sdk:remove-components",
    ...(coveredBy === undefined ? {} : { coveredBy }),
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

function managedDirectoryUninstallOperation(options: {
  readonly context: RuntimeContext;
  readonly component: ComponentId;
  readonly id: string;
  readonly description: string;
  readonly target: string;
  readonly uninstaller: string;
  readonly args: readonly string[];
}): Operation {
  return createFunctionOperation({
    id: `windows:managed-directory:${options.component}:${options.id}`,
    component: options.component,
    description: options.description,
    phase: "package",
    dedupeKey: `path:${win32.normalize(options.target).toLowerCase()}`,
    validate: async () =>
      await validateExactTarget(options.context, options.target),
    run: async (): Promise<OperationResult> => {
      try {
        await validateExactTarget(options.context, options.target);
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (!(await pathExists(options.target))) return { status: "not-found" };
      const executable = win32.join(options.target, options.uninstaller);
      if (await pathExists(executable)) {
        const result = await runCommand(executable, options.args, {
          silent: true,
          timeoutMs: 30 * 60_000,
        });
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

function postgresqlServiceOperation(paths: WindowsPaths): Operation {
  return createFunctionOperation({
    id: "windows:postgresql:services",
    component: "postgresql",
    description: "Stop runner-image PostgreSQL services before cleanup",
    phase: "preflight",
    dedupeKey: "windows:postgresql:services",
    fatal: true,
    run: async (): Promise<OperationResult> => {
      if (!(await pathExists(paths.serviceControl))) {
        return { status: "failed", detail: "sc.exe is unavailable" };
      }

      const inventory = await runCommand(
        paths.serviceControl,
        POSTGRESQL_SERVICE_QUERY_ARGUMENTS,
        { silent: true, timeoutMs: 30_000 },
      );
      if (inventory.exitCode !== 0) {
        if (isMissingWindowsService(inventory)) return { status: "not-found" };
        return {
          status: "failed",
          detail: failureDetail(
            inventory.stderr || inventory.stdout,
            paths.serviceControl,
            inventory.exitCode,
          ),
        };
      }

      const classified = classifyPostgreSqlServiceInventory(
        `${inventory.stdout}\n${inventory.stderr}`,
      );
      if (classified.status === "unsafe") {
        return {
          status: "failed",
          detail: classified.detail,
        };
      }
      const { serviceNames } = classified;
      if (serviceNames.length === 0) return { status: "not-found" };

      for (const serviceName of serviceNames) {
        const result = await ensureWindowsServiceStopped(paths, serviceName);
        if (result.status === "failed") {
          return {
            status: "failed",
            detail: result.detail ?? `${serviceName}: service stop failed`,
          };
        }
      }

      return {
        status: "removed",
        detail: `verified ${serviceNames.length} service(s) stopped`,
      };
    },
  });
}

function dockerServiceOperation(paths: WindowsPaths): Operation {
  return createFunctionOperation({
    id: "windows:docker:service",
    component: "docker-engine",
    description: "Stop and unregister the Windows Docker service",
    phase: "preflight",
    dedupeKey: "windows:docker:service",
    fatal: true,
    run: async (): Promise<OperationResult> => {
      if (!(await pathExists(paths.serviceControl))) {
        return { status: "failed", detail: "sc.exe is unavailable" };
      }
      const service = await ensureWindowsServiceStopped(paths, "docker");
      if (service.status === "missing") return { status: "not-found" };
      if (service.status === "failed") {
        return {
          status: "failed",
          detail: service.detail ?? "docker: service stop failed",
        };
      }

      const deleted = await runCommand(
        paths.serviceControl,
        ["delete", "docker"],
        { silent: true, timeoutMs: 30_000 },
      );
      return deleted.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: failureDetail(
              deleted.stderr,
              paths.serviceControl,
              deleted.exitCode,
            ),
          };
    },
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
            component,
            id: "firefox",
            description: "Uninstall Mozilla Firefox",
            candidates: [
              win32.join(
                paths.programFiles,
                "Mozilla Firefox",
                "uninstall",
                "helper.exe",
              ),
              win32.join(
                paths.programFilesX86,
                "Mozilla Firefox",
                "uninstall",
                "helper.exe",
              ),
            ],
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
      operations.push(
        fixedWindowsServiceStopOperation(
          paths,
          "apache",
          PINNED_WINDOWS_WEB_SERVICE_NAMES.apache,
          "Stop and verify the runner-image Apache service",
        ),
        fixedWindowsServiceStopOperation(
          paths,
          "nginx",
          PINNED_WINDOWS_WEB_SERVICE_NAMES.nginx,
          "Stop and verify the runner-image Nginx service",
        ),
      );
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
        operations.push(postgresqlServiceOperation(paths));
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
              component: "postgresql",
              id: `postgresql-${win32.basename(versionPath)}`,
              description: `Uninstall PostgreSQL ${win32.basename(versionPath)}`,
              candidates: [win32.join(versionPath, "uninstall-postgresql.exe")],
              args: ["--mode", "unattended"],
              timeoutMs: 30 * 60_000,
            }),
          );
        }
      }

      operations.push(dockerImagesOperation(paths));
      operations.push(dockerServiceOperation(paths));
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

      // A complete Visual Studio uninstall includes its SDK workloads. Avoid a
      // costly modify pass immediately before removing the same instance, but
      // schedule it when the full uninstall is blocked to honor a protected
      // overlapping toolchain.
      const visualStudioUninstallBlocked = VISUAL_STUDIO_OVERLAPS.some(
        (component) => plan.skipped.has(component),
      );
      operations.push(
        windowsSdkOperation(
          paths,
          visualStudioInstances,
          plan.enabled.has("visual-studio") && !visualStudioUninstallBlocked
            ? ["visual-studio"]
            : undefined,
        ),
      );
      operations.push(visualStudioOperation(paths, visualStudioInstances));

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
