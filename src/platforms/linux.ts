import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  commandExists,
  findCommandPath,
  runCommand,
  runElevated,
  TRUSTED_UNIX_PATH,
  type CommandOptions,
} from "../command.js";
import { COMPONENTS } from "../components.js";
import {
  createFunctionOperation,
  createRemovePathOperation,
  removePathTarget,
  type RemovePathDependencies,
} from "../operations.js";
import { assertSafeDirectoryTarget, assertSafeExactTarget } from "../safety.js";
import type {
  Adapter,
  CleanupPlan,
  CommandResult,
  ComponentId,
  Operation,
  RuntimeContext,
} from "../types.js";

const SUPPORTED = new Set<ComponentId>(
  COMPONENTS.filter((component) =>
    (component.platforms as readonly string[]).includes("linux"),
  ).map((component) => component.id),
);

export function existingFileState(
  exitCode: number,
): "present" | "absent" | "failed" {
  if (exitCode === 0) return "present";
  if (exitCode === 1) return "absent";
  return "failed";
}

export function isStoppedSystemdUnit(result: CommandResult): boolean {
  if (result.exitCode !== 0) return false;
  const state = result.stdout.trim();
  return state === "inactive" || state === "failed";
}

const SYSTEMCTL = "/usr/bin/systemctl";

const SERVICE_UNITS: Readonly<Partial<Record<ComponentId, readonly string[]>>> =
  {
    "docker-engine": ["docker.socket", "docker.service", "containerd.service"],
    postgresql: ["postgresql.service"],
    mysql: ["mysql.service", "mariadb.service"],
    apache: ["apache2.service"],
    nginx: ["nginx.service"],
  };

interface SystemdUnitTarget {
  readonly component: ComponentId;
  readonly unit: string;
}

interface SystemdUnitSnapshot extends SystemdUnitTarget {
  readonly loadState: string;
  readonly activeState: string;
}

export interface LinuxSystemctl {
  show(
    unit: string,
    property: "LoadState" | "ActiveState",
  ): Promise<CommandResult>;
  stop(unit: string): Promise<CommandResult>;
}

export function linuxSystemCommandEnvironment(
  context: RuntimeContext,
): NodeJS.ProcessEnv {
  return {
    HOME: context.home,
    USER: "runner",
    LOGNAME: "runner",
    PATH: TRUSTED_UNIX_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    SYSTEMD_COLORS: "0",
    SYSTEMD_PAGER: "",
  };
}

function systemctlFor(context: RuntimeContext): LinuxSystemctl {
  const environment = linuxSystemCommandEnvironment(context);
  return {
    show: async (unit, property) =>
      await runCommand(
        SYSTEMCTL,
        ["show", unit, `--property=${property}`, "--value"],
        { env: environment, silent: true, timeoutMs: 30_000 },
      ),
    stop: async (unit) =>
      await runElevated(context, SYSTEMCTL, ["stop", unit], {
        env: environment,
        silent: true,
        timeoutMs: 60_000,
      }),
  };
}

function selectedServiceUnits(plan: CleanupPlan): readonly SystemdUnitTarget[] {
  return (
    Object.entries(SERVICE_UNITS) as [ComponentId, readonly string[]][]
  ).flatMap(([component, units]) =>
    plan.enabled.has(component)
      ? units.map((unit) => ({ component, unit }))
      : [],
  );
}

function systemdFailure(result: CommandResult, detail: string): Error {
  return new Error(result.stderr.trim() || detail);
}

async function inspectSystemdUnits(
  targets: readonly SystemdUnitTarget[],
  systemctl: LinuxSystemctl,
): Promise<readonly SystemdUnitSnapshot[]> {
  const present: SystemdUnitSnapshot[] = [];
  for (const target of targets) {
    const result = await systemctl.show(target.unit, "LoadState");
    if (result.exitCode !== 0) {
      throw systemdFailure(
        result,
        `could not inspect systemd unit ${target.unit}`,
      );
    }
    const loadState = result.stdout.trim();
    if (loadState === "not-found") continue;
    if (loadState !== "loaded" && loadState !== "masked") {
      throw new Error(
        loadState === ""
          ? `systemd returned no LoadState for ${target.unit}`
          : `systemd returned unsafe LoadState '${loadState}' for ${target.unit}`,
      );
    }
    const active = await systemctl.show(target.unit, "ActiveState");
    if (active.exitCode !== 0) {
      throw systemdFailure(
        active,
        `could not inspect active state for systemd unit ${target.unit}`,
      );
    }
    const activeState = active.stdout.trim();
    if (
      ![
        "active",
        "activating",
        "deactivating",
        "failed",
        "inactive",
        "reloading",
      ].includes(activeState)
    ) {
      throw new Error(
        activeState === ""
          ? `systemd returned no ActiveState for ${target.unit}`
          : `systemd returned unsafe ActiveState '${activeState}' for ${target.unit}`,
      );
    }
    present.push({ ...target, loadState, activeState });
  }
  return present;
}

function sameSystemdSnapshot(
  left: readonly SystemdUnitSnapshot[],
  right: readonly SystemdUnitSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (unit, index) =>
        unit.unit === right[index]?.unit &&
        unit.component === right[index]?.component &&
        unit.loadState === right[index]?.loadState &&
        unit.activeState === right[index]?.activeState,
    )
  );
}

const APT_PACKAGES: Readonly<Partial<Record<ComponentId, readonly string[]>>> =
  {
    java: ["^openjdk-.*", "^temurin-.*"],
    browsers: [
      "google-chrome-stable",
      "microsoft-edge-stable",
      "firefox",
      "chromium",
      "chromium-browser",
      "chromium-codecs-ffmpeg-extra",
    ],
    chrome: ["google-chrome-stable"],
    chromium: ["chromium", "chromium-browser", "chromium-codecs-ffmpeg-extra"],
    edge: ["microsoft-edge-stable"],
    firefox: ["firefox"],
    powershell: ["powershell"],
    "aws-cli": ["session-manager-plugin"],
    "azure-cli": ["azure-cli"],
    "gh-cli": ["gh"],
    "gcloud-cli": ["google-cloud-cli", "google-cloud-sdk"],
    kubectl: ["kubectl"],
    buildah: ["buildah"],
    podman: ["podman"],
    "docker-engine": [
      "docker-ce",
      "docker-ce-cli",
      "containerd.io",
      "docker-buildx-plugin",
      "docker-compose-plugin",
      "moby-engine",
      "moby-cli",
    ],
    maven: ["maven"],
    gradle: ["gradle"],
    ant: ["ant", "ant-optional"],
    php: ["^php.*", "composer", "phpunit"],
    postgresql: [
      "libpq-dev",
      "postgresql",
      "postgresql-common",
      "postgresql-client-common",
      "^postgresql-.*",
    ],
    mysql: ["libmysqlclient-dev", "mysql-common", "^mysql-.*", "^mariadb-.*"],
    apache: ["apache2", "apache2-utils", "apache2-bin", "apache2-data"],
    nginx: ["nginx", "nginx-common", "nginx-core"],
    "large-packages": [
      "^aspnetcore-.*",
      "^dotnet-.*",
      "^llvm-.*",
      "^php.*",
      "^mongodb-.*",
      "^mysql-.*",
      "azure-cli",
      "google-cloud-sdk",
      "google-cloud-cli",
      "google-chrome-stable",
      "microsoft-edge-stable",
      "firefox",
      "chromium",
      "chromium-browser",
      "chromium-codecs-ffmpeg-extra",
      "powershell",
      "mono-devel",
      "libgl1-mesa-dri",
    ],
  };

function selectedLinuxAptSpecifications(plan: CleanupPlan): readonly string[] {
  return [
    ...new Set(
      (
        Object.entries(APT_PACKAGES) as [ComponentId, readonly string[]][]
      ).flatMap(([component, packages]) =>
        plan.enabled.has(component) ? packages : [],
      ),
    ),
  ];
}

export function selectLinuxAptPackages(
  plan: CleanupPlan,
  installedPackages: readonly string[],
): readonly string[] {
  const specifications = selectedLinuxAptSpecifications(plan);
  return installedPackages.filter((name) =>
    specifications.some((specification) => {
      if (!specification.includes("*") && !specification.startsWith("^")) {
        return name === specification || name.startsWith(`${specification}:`);
      }
      try {
        return new RegExp(specification).test(name);
      } catch {
        return false;
      }
    }),
  );
}

function exactDefinitionPath(
  value: string | undefined,
  fallback: string,
  allowed: readonly string[] = [fallback],
): string {
  if (
    value !== undefined &&
    value.trim() !== "" &&
    value.length <= 1024 &&
    posix.isAbsolute(value)
  ) {
    const normalized = posix.normalize(value);
    if (
      allowed.some((candidate) => posix.normalize(candidate) === normalized)
    ) {
      return normalized;
    }
  }
  return posix.normalize(fallback);
}

function trustedToolCache(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const expected = "/opt/hostedtoolcache";
  return posix.normalize(value) === expected ? expected : undefined;
}

function removeOperation(
  context: RuntimeContext,
  component: ComponentId,
  target: string | undefined,
  allowedParents: readonly string[],
  description: string,
  blockedBy?: readonly ComponentId[],
  coveredBy?: readonly ComponentId[],
): Operation | undefined {
  if (target === undefined || target.trim() === "") return undefined;
  return createRemovePathOperation({
    id: `${component}:${target}`,
    component,
    target,
    allowedParents,
    context,
    description,
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(coveredBy === undefined ? {} : { coveredBy }),
  });
}

async function versionedChildren(
  parent: string,
  pattern: RegExp,
): Promise<readonly string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          pattern.test(entry.name),
      )
      .map((entry) => join(parent, entry.name))
      .slice(0, 64);
  } catch {
    return [];
  }
}

function aptBatchOperation(
  context: RuntimeContext,
  plan: CleanupPlan,
  markDirty: () => void,
): Operation {
  return createFunctionOperation({
    id: "apt:selected-packages",
    component: "large-packages",
    description: "Remove selected runner-image packages with apt",
    phase: "package",
    dedupeKey: "apt:selected-packages",
    always: true,
    run: async () => {
      const specifications = selectedLinuxAptSpecifications(plan);
      if (specifications.length === 0) return { status: "not-found" };
      if (context.isContainer && !context.hasPasswordlessSudo) {
        return {
          status: "unsupported",
          detail: "unprivileged Linux container",
        };
      }
      if (!(await commandExists("apt-get"))) return { status: "not-found" };
      const query = await runCommand(
        "dpkg-query",
        ["-W", "-f=${binary:Package}\\n"],
        { silent: true },
      );
      if (query.exitCode !== 0)
        return { status: "unsupported", detail: "dpkg database unavailable" };
      const installed = query.stdout.split(/\r?\n/).filter(Boolean);
      const selected = selectLinuxAptPackages(plan, installed);
      if (selected.length === 0) return { status: "not-found" };
      const result = await runElevated(
        context,
        "apt-get",
        ["purge", "-y", "--no-install-recommends", ...selected],
        { silent: false, timeoutMs: 15 * 60_000 },
      );
      if (result.exitCode === 0) markDirty();
      return result.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: result.stderr.trim() || `apt exited ${result.exitCode}`,
          };
    },
  });
}

async function commandRemoval(
  context: RuntimeContext,
  component: ComponentId,
  command: string,
): Promise<Operation> {
  // Resolve PATH links while the image is intact. Package and filesystem
  // cleanup can otherwise leave a dangling link that can no longer be found.
  const path = await findCommandPath(command);
  const description = `Remove runner-image ${command} executable`;
  if (path !== undefined) {
    const trustedBinDirectories = ["/usr/local/bin", "/usr/bin"];
    if (trustedBinDirectories.includes(dirname(path))) {
      return createRemovePathOperation({
        id: `binary:${component}:${command}`,
        component,
        description,
        target: path,
        allowedParents: [dirname(path)],
        context,
      });
    }
  }
  return createFunctionOperation({
    id: `binary:${component}:${command}`,
    component,
    description,
    phase: "filesystem",
    dedupeKey: `binary:${command}`,
    run: async () => {
      if (path === undefined) return { status: "not-found" };
      return {
        status: "unsupported",
        detail: `unexpected executable path ${path}`,
      };
    },
  });
}

function dockerPruneOperation(context: RuntimeContext): Operation {
  return createFunctionOperation({
    id: "docker:prune",
    component: "docker-images",
    description: "Prune unused Docker data",
    phase: "system",
    dedupeKey: "docker:prune",
    run: async () => {
      if (!(await commandExists("docker"))) return { status: "not-found" };
      const responsive = await runCommand("docker", ["info"], {
        silent: true,
        timeoutMs: 10_000,
      });
      if (responsive.exitCode !== 0) {
        return { status: "unsupported", detail: "Docker daemon unavailable" };
      }
      const result = await runElevated(
        context,
        "docker",
        ["system", "prune", "--all", "--volumes", "--force"],
        {
          silent: false,
          timeoutMs: 10 * 60_000,
        },
      );
      return result.exitCode === 0
        ? { status: "removed" }
        : { status: "failed", detail: result.stderr.trim() };
    },
  });
}

export function createLinuxServiceStopOperation(
  context: RuntimeContext,
  plan: CleanupPlan,
  systemctl: LinuxSystemctl = systemctlFor(context),
): Operation | undefined {
  const targets = selectedServiceUnits(plan);
  const first = targets[0];
  if (first === undefined) return undefined;

  let validatedSnapshot: readonly SystemdUnitSnapshot[] | undefined;
  const validate = async (): Promise<void> => {
    if (context.isContainer) {
      validatedSnapshot = [];
      return;
    }
    validatedSnapshot = await inspectSystemdUnits(targets, systemctl);
  };

  return createFunctionOperation({
    id: "linux:services:stop",
    component: first.component,
    description: "Stop selected Linux services before cleanup",
    phase: "preflight",
    fatal: true,
    validate,
    run: async () => {
      if (context.isContainer) {
        return { status: "unsupported", detail: "systemd unavailable" };
      }

      try {
        validatedSnapshot ??= await inspectSystemdUnits(targets, systemctl);
        // Complete-plan validation can precede this phase by several seconds.
        // Re-read every selected unit before the first stop, so a later unit
        // cannot fail discovery after an earlier component was mutated.
        const immediateSnapshot = await inspectSystemdUnits(targets, systemctl);
        if (!sameSystemdSnapshot(validatedSnapshot, immediateSnapshot)) {
          return {
            status: "failed",
            detail: "systemd unit inventory changed after plan validation",
          };
        }

        for (const { unit } of immediateSnapshot) {
          // Stop every loaded unit, including one observed inactive. That
          // closes the avoidable race where an inactive unit becomes active
          // after discovery but before its data is removed.
          const result = await systemctl.stop(unit);
          if (result.exitCode !== 0) {
            return {
              status: "failed",
              detail: result.stderr.trim() || `could not stop ${unit}`,
            };
          }
          const stoppedState = await systemctl.show(unit, "ActiveState");
          if (!isStoppedSystemdUnit(stoppedState)) {
            return {
              status: "failed",
              detail:
                stoppedState.stderr.trim() ||
                `${unit} did not reach a terminal stopped state`,
            };
          }
        }

        // A socket, timer, dependency, or restart policy can reactivate a unit
        // while the remaining services are being stopped. Confirm the entire
        // coordinated set is still terminal before package/data cleanup begins.
        for (const { unit } of immediateSnapshot) {
          const stoppedState = await systemctl.show(unit, "ActiveState");
          if (!isStoppedSystemdUnit(stoppedState)) {
            return {
              status: "failed",
              detail:
                stoppedState.stderr.trim() ||
                `${unit} reactivated after the coordinated stop`,
            };
          }
        }
        return immediateSnapshot.length === 0
          ? { status: "not-found" }
          : { status: "removed" };
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

const LINUXBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const LINUXBREW_CANDIDATE = `${LINUXBREW_PREFIX}/bin/brew`;
const LINUXBREW_EXECUTABLE = `${LINUXBREW_PREFIX}/Homebrew/bin/brew`;
const LINUXBREW_CONFIG_ROOT = "/tmp";
const LINUXBREW_CONFIG_DIRECTORY_PREFIX = `${LINUXBREW_CONFIG_ROOT}/maximize-github-runner-space-brew-config-`;

interface LinuxBrewPathStats {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface LinuxBrewFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
}

export interface LinuxBrewPathProbe {
  lstat(path: string): Promise<LinuxBrewPathStats>;
  realpath(path: string): Promise<string>;
  access(path: string, mode: number): Promise<void>;
  identity?(path: string): Promise<LinuxBrewFileIdentity>;
}

const NODE_LINUX_BREW_PATH_PROBE: LinuxBrewPathProbe = {
  lstat: async (path) => await lstat(path),
  realpath: async (path) => await realpath(path),
  access: async (path, mode) => await access(path, mode),
  identity: async (path) => {
    const stat = await lstat(path, { bigint: true });
    return {
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedNanoseconds: stat.mtimeNs,
    };
  },
};

export interface ResolvedLinuxBrew {
  readonly executable: string;
  readonly identity?: LinuxBrewFileIdentity;
}

async function resolveDefinitionLinuxBrew(
  probe: LinuxBrewPathProbe = NODE_LINUX_BREW_PATH_PROBE,
): Promise<ResolvedLinuxBrew | undefined> {
  try {
    const candidate = await probe.lstat(LINUXBREW_CANDIDATE);
    if (!candidate.isSymbolicLink()) return undefined;
    if (
      posix.normalize(await probe.realpath(LINUXBREW_CANDIDATE)) !==
      LINUXBREW_EXECUTABLE
    ) {
      return undefined;
    }

    const executable = await probe.lstat(LINUXBREW_EXECUTABLE);
    if (executable.isSymbolicLink() || !executable.isFile()) return undefined;
    await probe.access(LINUXBREW_EXECUTABLE, constants.X_OK);
    return {
      executable: LINUXBREW_EXECUTABLE,
      ...(probe.identity === undefined
        ? {}
        : { identity: await probe.identity(LINUXBREW_EXECUTABLE) }),
    };
  } catch {
    return undefined;
  }
}

export async function resolveDefinitionLinuxBrewExecutable(
  probe: LinuxBrewPathProbe = NODE_LINUX_BREW_PATH_PROBE,
): Promise<string | undefined> {
  return (await resolveDefinitionLinuxBrew(probe))?.executable;
}

type LinuxBrewResolver = () => Promise<ResolvedLinuxBrew | undefined>;
type LinuxBrewRunner = (
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<CommandResult>;
type LinuxBrewConfigDirectoryFactory = () => Promise<string>;
type LinuxBrewConfigDirectoryRemover = (path: string) => Promise<void>;

function linuxBrewMutablePaths(context: RuntimeContext): {
  readonly cache: string;
  readonly logs: string;
} {
  const cache = posix.join(context.home, ".cache", "Homebrew");
  return { cache, logs: posix.join(cache, "Logs") };
}

function linuxBrewEnvironment(
  context: RuntimeContext,
  configDirectory: string,
): NodeJS.ProcessEnv {
  const paths = linuxBrewMutablePaths(context);
  return {
    HOME: context.home,
    USER: "runner",
    LOGNAME: "runner",
    SHELL: "/bin/bash",
    PATH: TRUSTED_UNIX_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    CI: "true",
    GITHUB_ACTIONS: "true",
    XDG_CACHE_HOME: posix.join(context.home, ".cache"),
    // Homebrew expects this to be a directory even when no user brew.env is
    // present. The caller creates a fresh action-owned directory for each
    // invocation; system and prefix configuration are separately required
    // absent below.
    XDG_CONFIG_HOME: configDirectory,
    HOMEBREW_PREFIX: LINUXBREW_PREFIX,
    HOMEBREW_REPOSITORY: `${LINUXBREW_PREFIX}/Homebrew`,
    HOMEBREW_CELLAR: `${LINUXBREW_PREFIX}/Cellar`,
    HOMEBREW_CACHE: paths.cache,
    HOMEBREW_LOGS: paths.logs,
    HOMEBREW_TEMP: "/tmp",
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_AUTOREMOVE: "1",
  };
}

async function assertLinuxBrewConfigDirectory(
  path: string,
  context: RuntimeContext,
  requireEmpty = false,
): Promise<void> {
  const normalized = posix.normalize(path);
  const name = posix.basename(normalized);
  const expectedPrefix = posix.basename(LINUXBREW_CONFIG_DIRECTORY_PREFIX);
  if (
    path !== normalized ||
    dirname(normalized) !== LINUXBREW_CONFIG_ROOT ||
    !name.startsWith(expectedPrefix) ||
    name.length <= expectedPrefix.length
  ) {
    throw new Error(`Refusing unsafe Linuxbrew config directory: '${path}'.`);
  }

  await assertSafeDirectoryTarget(path, [LINUXBREW_CONFIG_ROOT], context);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Refusing non-directory Linuxbrew config target: '${path}'.`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Refusing unowned Linuxbrew config directory: '${path}'.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing shared Linuxbrew config directory permissions: '${path}'.`,
    );
  }
  if (requireEmpty && (await readdir(path)).length !== 0) {
    throw new Error(
      `Refusing non-empty Linuxbrew config directory: '${path}'.`,
    );
  }
}

const NODE_LINUX_BREW_CONFIG_DIRECTORY_FACTORY: LinuxBrewConfigDirectoryFactory =
  async () => await mkdtemp(LINUXBREW_CONFIG_DIRECTORY_PREFIX);

const NODE_LINUX_BREW_CONFIG_DIRECTORY_REMOVER: LinuxBrewConfigDirectoryRemover =
  async (path) => await rm(path, { recursive: true, force: true });

const LINUXBREW_CONFIG_FILES = [
  "/etc/homebrew/brew.env",
  `${LINUXBREW_PREFIX}/etc/homebrew/brew.env`,
] as const;

export type LinuxBrewConfigProbe = (
  path: string,
) => Promise<LinuxBrewPathStats | undefined>;

const NODE_LINUX_BREW_CONFIG_PROBE: LinuxBrewConfigProbe = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

async function findLinuxBrewConfig(
  probe: LinuxBrewConfigProbe,
): Promise<string | undefined> {
  for (const path of LINUXBREW_CONFIG_FILES) {
    if ((await probe(path)) !== undefined) return path;
  }
  return undefined;
}

export function createLinuxHomebrewCleanupOperation(
  context: RuntimeContext,
  resolveExecutable: LinuxBrewResolver = async () =>
    await resolveDefinitionLinuxBrew(),
  execute: LinuxBrewRunner = async (executable, args, environment) =>
    await runCommand(executable, args, {
      env: environment,
      silent: false,
      timeoutMs: 10 * 60_000,
    }),
  inspectConfig: LinuxBrewConfigProbe = NODE_LINUX_BREW_CONFIG_PROBE,
  createConfigDirectory: LinuxBrewConfigDirectoryFactory = NODE_LINUX_BREW_CONFIG_DIRECTORY_FACTORY,
  removeConfigDirectory: LinuxBrewConfigDirectoryRemover = NODE_LINUX_BREW_CONFIG_DIRECTORY_REMOVER,
  removeConfigDependencies: Omit<RemovePathDependencies, "remove"> = {},
): Operation {
  let validationComplete = false;
  let validatedExecutable: ResolvedLinuxBrew | undefined;
  let validatedConfig: string | undefined;
  const validateMutablePaths = async (): Promise<void> => {
    const paths = linuxBrewMutablePaths(context);
    await assertSafeDirectoryTarget(paths.cache, [context.home], context);
    await assertSafeDirectoryTarget(paths.logs, [paths.cache], context);
  };
  const validate = async (): Promise<void> => {
    validatedExecutable = await resolveExecutable();
    if (validatedExecutable !== undefined) {
      await validateMutablePaths();
      validatedConfig = await findLinuxBrewConfig(inspectConfig);
    }
    validationComplete = true;
  };
  const sameExecutable = (
    current: ResolvedLinuxBrew | undefined,
    validated: ResolvedLinuxBrew | undefined,
  ): boolean =>
    current?.executable === validated?.executable &&
    current?.identity?.device === validated?.identity?.device &&
    current?.identity?.inode === validated?.identity?.inode &&
    current?.identity?.size === validated?.identity?.size &&
    current?.identity?.modifiedNanoseconds ===
      validated?.identity?.modifiedNanoseconds;

  return createFunctionOperation({
    id: "linux:brew:cleanup",
    component: "homebrew",
    description:
      "Clean stale Linuxbrew artifacts while preserving installed packages",
    phase: "package",
    dedupeKey: "linux:brew:cleanup",
    validate,
    run: async () => {
      if (!validationComplete) await validate();
      const executable = await resolveExecutable();
      if (!sameExecutable(executable, validatedExecutable)) {
        return {
          status: "failed",
          detail: "Linuxbrew executable changed after plan validation",
        };
      }
      if (executable === undefined) return { status: "not-found" };
      await validateMutablePaths();
      const config = await findLinuxBrewConfig(inspectConfig);
      if (config !== undefined || validatedConfig !== undefined) {
        return {
          status: "unsupported",
          detail: `Homebrew configuration can override cleanup paths (${config ?? validatedConfig})`,
        };
      }

      // The pinned runner-image definition installs no formulae or casks.
      // A recursive prefix removal or `uninstall --force` would therefore own
      // workflow additions, not definition content. Native cleanup removes
      // only stale package-manager artifacts and retains current packages.
      let configDirectory: string;
      try {
        configDirectory = await createConfigDirectory();
        await assertLinuxBrewConfigDirectory(configDirectory, context, true);
      } catch (error) {
        return {
          status: "failed",
          detail: `could not create a safe Linuxbrew config directory: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      let result: CommandResult | undefined;
      let executionError: unknown;
      try {
        result = await execute(
          LINUXBREW_CANDIDATE,
          ["cleanup", "--prune=120"],
          linuxBrewEnvironment(context, configDirectory),
        );
      } catch (error) {
        executionError = error;
      }

      let removalError: unknown;
      try {
        await assertLinuxBrewConfigDirectory(configDirectory, context);
        const removal = await removePathTarget(
          configDirectory,
          [LINUXBREW_CONFIG_ROOT],
          context,
          {
            ...removeConfigDependencies,
            remove: async (path) => {
              if (typeof path !== "string") {
                throw new Error("Refusing a non-string Linuxbrew config path.");
              }
              await removeConfigDirectory(path);
            },
          },
        );
        if (removal.status === "failed") {
          removalError = new Error(
            removal.detail ?? "temporary config removal failed",
          );
        }
      } catch (error) {
        removalError = error;
      }

      if (executionError !== undefined) {
        return {
          status: "failed",
          detail: `Linuxbrew cleanup could not execute: ${executionError instanceof Error ? executionError.message : String(executionError)}${removalError === undefined ? "" : `; temporary config cleanup failed: ${removalError instanceof Error ? removalError.message : String(removalError)}`}`,
        };
      }
      if (removalError !== undefined) {
        return {
          status: "failed",
          detail: `temporary Linuxbrew config cleanup failed: ${removalError instanceof Error ? removalError.message : String(removalError)}`,
        };
      }
      if (result === undefined) {
        return {
          status: "failed",
          detail: "Linuxbrew cleanup returned no command result",
        };
      }
      return result.exitCode === 0
        ? {
            status: "removed",
            detail: "installed formulae, casks, and the prefix were preserved",
          }
        : {
            status: "failed",
            detail:
              result.stderr.trim() ||
              `Linuxbrew cleanup exited ${result.exitCode}`,
          };
    },
  });
}

function recreateToolCacheOperation(
  context: RuntimeContext,
  target: string | undefined,
): Operation | undefined {
  if (target === undefined) return undefined;
  return createFunctionOperation({
    id: "toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    run: async () => {
      try {
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let needsElevatedCreation = false;
      try {
        await mkdir(target, { recursive: true });
      } catch {
        needsElevatedCreation = true;
      }
      if (needsElevatedCreation) {
        const created = await runElevated(
          context,
          "mkdir",
          ["-p", "--", target],
          {
            silent: true,
          },
        );
        if (created.exitCode !== 0) {
          return { status: "failed", detail: created.stderr.trim() };
        }
      }
      try {
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        needsElevatedCreation &&
        typeof process.getuid === "function" &&
        typeof process.getgid === "function"
      ) {
        const ownership = await runElevated(
          context,
          "chown",
          [`${process.getuid()}:${process.getgid()}`, target],
          { silent: true },
        );
        if (ownership.exitCode !== 0) {
          return { status: "failed", detail: ownership.stderr.trim() };
        }
      }
      return { status: "removed" };
    },
  });
}

function aptFinalizeOperation(
  context: RuntimeContext,
  isDirty: () => boolean,
): Operation {
  return createFunctionOperation({
    id: "apt:finalize",
    component: "large-packages",
    description: "Remove unused apt dependencies and cached archives",
    phase: "package",
    always: true,
    run: async () => {
      if (
        !(await commandExists("apt-get")) ||
        (context.isContainer && !context.hasPasswordlessSudo)
      ) {
        return { status: "unsupported", detail: "apt cleanup unavailable" };
      }
      if (!isDirty()) return { status: "not-found" };
      const autoremove = await runElevated(
        context,
        "apt-get",
        ["autoremove", "-y"],
        {
          silent: false,
          timeoutMs: 15 * 60_000,
        },
      );
      const clean = await runElevated(context, "apt-get", ["clean"], {
        silent: true,
        timeoutMs: 5 * 60_000,
      });
      return autoremove.exitCode === 0 && clean.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: autoremove.stderr.trim() || clean.stderr.trim(),
          };
    },
  });
}

export const LINUX_SWAP_EXECUTABLES = Object.freeze({
  chmod: "/usr/bin/chmod",
  dd: "/usr/bin/dd",
  df: "/usr/bin/df",
  fallocate: "/usr/bin/fallocate",
  grep: "/usr/bin/grep",
  mktemp: "/usr/bin/mktemp",
  mkswap: "/usr/sbin/mkswap",
  mv: "/usr/bin/mv",
  rm: "/usr/bin/rm",
  sed: "/usr/bin/sed",
  swapoff: "/usr/sbin/swapoff",
  swapon: "/usr/sbin/swapon",
  tee: "/usr/bin/tee",
  test: "/usr/bin/test",
  truncate: "/usr/bin/truncate",
} as const);

type LinuxSwapUtility = keyof typeof LINUX_SWAP_EXECUTABLES;

export interface LinuxSwapCommandInvocation {
  readonly elevated: boolean;
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: CommandOptions & { readonly env: NodeJS.ProcessEnv };
}

export type LinuxSwapCommandRunner = (
  invocation: LinuxSwapCommandInvocation,
) => Promise<CommandResult>;

export interface LinuxSwapDependencies {
  readonly commandRunner?: LinuxSwapCommandRunner;
}

export function linuxSwapCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: TRUSTED_UNIX_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

interface SwapDefinitionPaths {
  readonly root: string;
  readonly mountDirectory: string;
  readonly swapfile: string;
  readonly etcDirectory: string;
  readonly fstab: string;
}

function swapDefinitionPaths(definitionRoot: string): SwapDefinitionPaths {
  if (!posix.isAbsolute(definitionRoot)) {
    throw new Error(
      `Refusing non-absolute swap definition root: '${definitionRoot}'.`,
    );
  }
  const root = posix.normalize(posix.resolve(definitionRoot));
  const mountDirectory = posix.join(root, "mnt");
  const etcDirectory = posix.join(root, "etc");
  return {
    root,
    mountDirectory,
    swapfile: posix.join(mountDirectory, "swapfile"),
    etcDirectory,
    fstab: posix.join(etcDirectory, "fstab"),
  };
}

export async function validateSwapTargets(
  context: RuntimeContext,
  definitionRoot = "/",
): Promise<void> {
  const paths = swapDefinitionPaths(definitionRoot);
  await assertSafeExactTarget(
    paths.mountDirectory,
    [paths.root],
    context,
    "directory",
  );
  await assertSafeExactTarget(
    paths.swapfile,
    [paths.mountDirectory],
    context,
    "absent-or-regular-file",
  );
  await assertSafeExactTarget(
    paths.etcDirectory,
    [paths.root],
    context,
    "directory",
  );
  await assertSafeExactTarget(
    paths.fstab,
    [paths.etcDirectory],
    context,
    "regular-file",
  );
}

function escapeExtendedRegularExpression(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function rollbackSwaponFailure(result: CommandResult): string | undefined {
  if (result.exitCode === 0) return undefined;
  return `rollback swapon failed: ${
    result.stderr.trim() || `swapon exited ${result.exitCode}`
  }`;
}

/** The root override keeps exact-path safety tests isolated from the host. */
export function createSwapOperation(
  context: RuntimeContext,
  requested: bigint,
  definitionRoot = "/",
  dependencies: LinuxSwapDependencies = {},
): Operation {
  const paths = swapDefinitionPaths(definitionRoot);
  const environment = linuxSwapCommandEnvironment();
  const commandRunner: LinuxSwapCommandRunner =
    dependencies.commandRunner ??
    (async ({ elevated, executable, args, options }) =>
      elevated
        ? await runElevated(context, executable, args, options)
        : await runCommand(executable, args, options));
  const runSwapUtility = async (
    elevated: boolean,
    utility: LinuxSwapUtility,
    args: readonly string[],
    options: Omit<CommandOptions, "env"> = {},
  ): Promise<CommandResult> =>
    await commandRunner({
      elevated,
      executable: LINUX_SWAP_EXECUTABLES[utility],
      args,
      options: { ...options, env: environment },
    });
  const validate = async (): Promise<void> =>
    await validateSwapTargets(context, definitionRoot);
  const fstabEntryPattern = `^${escapeExtendedRegularExpression(paths.swapfile)}[[:space:]]+none[[:space:]]+swap[[:space:]]`;
  return createFunctionOperation({
    id: "swapfile",
    component: "large-packages",
    description:
      requested === 0n
        ? `Remove ${paths.swapfile}`
        : `Configure ${paths.swapfile}`,
    phase: "system",
    always: true,
    fatal: true,
    validate,
    run: async () => {
      // Package cleanup may run for several minutes after plan validation.
      // Recheck the exact follow-through targets before the first swap command.
      await validate();
      if (context.isContainer || !context.hasPasswordlessSudo) {
        return {
          status: "unsupported",
          detail: "swap requires a privileged Linux VM",
        };
      }

      const makeTemporaryFile = async (
        prefix: string,
      ): Promise<
        | { readonly path: string; readonly detail?: never }
        | { readonly path?: never; readonly detail: string }
      > => {
        const created = await runSwapUtility(
          true,
          "mktemp",
          [`${prefix}XXXXXX`],
          { silent: true },
        );
        const path = created.stdout.trim();
        const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : "";
        if (
          created.exitCode !== 0 ||
          suffix.length !== 6 ||
          !/^[A-Za-z0-9]+$/.test(suffix)
        ) {
          return {
            detail:
              created.stderr.trim() || "mktemp returned an unsafe swap path",
          };
        }
        return { path };
      };

      const removeTemporaryFile = async (path: string): Promise<void> => {
        await runSwapUtility(true, "rm", ["-f", "--", path], {
          silent: true,
        });
      };

      const updateFstab = async (): Promise<
        | { readonly status: "present" | "absent" }
        | { readonly status: "failed"; readonly detail: string }
      > => {
        const result = await runSwapUtility(
          false,
          "grep",
          ["-Eq", fstabEntryPattern, paths.fstab],
          { silent: true },
        );
        if (result.exitCode === 0) return { status: "present" };
        if (result.exitCode === 1) return { status: "absent" };
        return {
          status: "failed",
          detail: result.stderr.trim() || `unable to inspect ${paths.fstab}`,
        };
      };

      const removeFstabEntry = async () =>
        await runSwapUtility(
          true,
          "sed",
          ["-E", "-i", `\\|${fstabEntryPattern}|d`, paths.fstab],
          { silent: true },
        );

      const active = await runSwapUtility(
        false,
        "swapon",
        ["--show=NAME", "--noheadings"],
        {
          silent: true,
        },
      );
      if (active.exitCode !== 0) {
        return {
          status: "failed",
          detail: active.stderr.trim() || "unable to inspect active swap",
        };
      }
      const isActive = active.stdout.split(/\s+/).includes(paths.swapfile);
      const existing = await runSwapUtility(
        false,
        "test",
        ["-e", paths.swapfile],
        {
          silent: true,
        },
      );
      const fileState = existingFileState(existing.exitCode);
      if (fileState === "failed") {
        return {
          status: "failed",
          detail:
            existing.stderr.trim() || "unable to inspect existing swapfile",
        };
      }
      const hadExistingFile = fileState === "present";
      const fstabBefore = await updateFstab();
      if (fstabBefore.status === "failed") {
        return { status: "failed", detail: fstabBefore.detail };
      }

      if (requested === 0n) {
        let backup: string | undefined;
        if (hadExistingFile) {
          const temporary = await makeTemporaryFile(
            `${paths.swapfile}.previous.`,
          );
          if (temporary.path === undefined) {
            return { status: "failed", detail: temporary.detail };
          }
          backup = temporary.path;
        }
        if (isActive) {
          const off = await runSwapUtility(true, "swapoff", [paths.swapfile], {
            silent: true,
          });
          if (off.exitCode !== 0) {
            if (backup !== undefined) await removeTemporaryFile(backup);
            return { status: "failed", detail: off.stderr.trim() };
          }
        }
        if (backup !== undefined) {
          const backedUp = await runSwapUtility(
            true,
            "mv",
            [paths.swapfile, backup],
            { silent: true },
          );
          if (backedUp.exitCode !== 0) {
            await removeTemporaryFile(backup);
            let rollbackDetail: string | undefined;
            if (isActive) {
              const reenabled = await runSwapUtility(
                true,
                "swapon",
                [paths.swapfile],
                {
                  silent: true,
                },
              );
              rollbackDetail = rollbackSwaponFailure(reenabled);
            }
            return {
              status: "failed",
              detail: [
                backedUp.stderr.trim() || "unable to back up existing swap",
                rollbackDetail,
              ]
                .filter(Boolean)
                .join("; "),
            };
          }
        }

        const fstabRemoved = await removeFstabEntry();
        if (fstabRemoved.exitCode !== 0) {
          const rollback: string[] = [];
          if (backup !== undefined) {
            const restored = await runSwapUtility(
              true,
              "mv",
              [backup, paths.swapfile],
              { silent: true },
            );
            if (restored.exitCode !== 0) {
              rollback.push(`restore failed: ${restored.stderr.trim()}`);
            } else if (isActive) {
              const enabled = await runSwapUtility(
                true,
                "swapon",
                [paths.swapfile],
                { silent: true },
              );
              if (enabled.exitCode !== 0) {
                rollback.push(`swapon failed: ${enabled.stderr.trim()}`);
              }
            }
          }
          return {
            status: "failed",
            detail: [
              fstabRemoved.stderr.trim() || `unable to update ${paths.fstab}`,
              ...rollback,
            ].join("; "),
          };
        }

        if (backup !== undefined) {
          const removed = await runSwapUtility(
            true,
            "rm",
            ["-f", "--", backup],
            { silent: true },
          );
          if (removed.exitCode !== 0) {
            return { status: "failed", detail: removed.stderr.trim() };
          }
        }
        return { status: "removed" };
      }

      const stat = await runSwapUtility(
        false,
        "df",
        ["--output=avail", "-B1", paths.mountDirectory],
        { silent: true },
      );
      const rawAvailable = stat.stdout.trim().split(/\s+/).at(-1) ?? "";
      if (stat.exitCode !== 0 || !/^[0-9]+$/.test(rawAvailable)) {
        return {
          status: "failed",
          detail:
            stat.stderr.trim() ||
            `unable to inspect ${paths.mountDirectory} free space`,
        };
      }
      const available = BigInt(rawAvailable);
      if (requested > available - 512n * 1024n * 1024n) {
        return {
          status: "failed",
          detail: `requested swap exceeds safe ${paths.mountDirectory} free space; existing swap left unchanged`,
        };
      }
      const temporary = await makeTemporaryFile(`${paths.swapfile}.new.`);
      if (temporary.path === undefined) {
        return { status: "failed", detail: temporary.detail };
      }
      const replacement = temporary.path;
      const allocate = await runSwapUtility(
        true,
        "fallocate",
        ["-l", requested.toString(), replacement],
        { silent: true },
      );
      if (allocate.exitCode !== 0) {
        const mebibytes = (requested + 1024n ** 2n - 1n) / 1024n ** 2n;
        const fallback = await runSwapUtility(
          true,
          "dd",
          [
            "if=/dev/zero",
            `of=${replacement}`,
            "bs=1M",
            `count=${mebibytes}`,
            "status=none",
          ],
          { silent: true, timeoutMs: 15 * 60_000 },
        );
        if (fallback.exitCode !== 0) {
          await runSwapUtility(true, "rm", ["-f", replacement], {
            silent: true,
          });
          return {
            status: "failed",
            detail: fallback.stderr.trim() || allocate.stderr.trim(),
          };
        }
        const truncated = await runSwapUtility(
          true,
          "truncate",
          ["-s", requested.toString(), replacement],
          { silent: true },
        );
        if (truncated.exitCode !== 0) {
          await runSwapUtility(true, "rm", ["-f", replacement], {
            silent: true,
          });
          return { status: "failed", detail: truncated.stderr.trim() };
        }
      }
      const mode = await runSwapUtility(true, "chmod", ["600", replacement], {
        silent: true,
      });
      if (mode.exitCode !== 0) {
        await runSwapUtility(true, "rm", ["-f", replacement], {
          silent: true,
        });
        return { status: "failed", detail: mode.stderr.trim() };
      }
      const formatted = await runSwapUtility(true, "mkswap", [replacement], {
        silent: true,
      });
      if (formatted.exitCode !== 0) {
        await runSwapUtility(true, "rm", ["-f", replacement], {
          silent: true,
        });
        return { status: "failed", detail: formatted.stderr.trim() };
      }

      let backup: string | undefined;
      if (hadExistingFile) {
        const previous = await makeTemporaryFile(`${paths.swapfile}.previous.`);
        if (previous.path === undefined) {
          await removeTemporaryFile(replacement);
          return { status: "failed", detail: previous.detail };
        }
        backup = previous.path;
      }

      const rollbackReplacement = async (
        replacementIsActive: boolean,
        removeAddedFstabEntry: boolean,
      ): Promise<string> => {
        const details: string[] = [];
        if (replacementIsActive) {
          const disabled = await runSwapUtility(
            true,
            "swapoff",
            [paths.swapfile],
            { silent: true },
          );
          if (disabled.exitCode !== 0) {
            return `rollback swapoff failed: ${disabled.stderr.trim()}`;
          }
        }

        const removed = await runSwapUtility(
          true,
          "rm",
          ["-f", "--", paths.swapfile, replacement],
          { silent: true },
        );
        if (removed.exitCode !== 0) {
          return `rollback cleanup failed: ${removed.stderr.trim()}`;
        }

        if (backup !== undefined) {
          const restored = await runSwapUtility(
            true,
            "mv",
            [backup, paths.swapfile],
            { silent: true },
          );
          if (restored.exitCode !== 0) {
            details.push(`rollback move failed: ${restored.stderr.trim()}`);
          } else if (isActive) {
            const reenabled = await runSwapUtility(
              true,
              "swapon",
              [paths.swapfile],
              { silent: true },
            );
            if (reenabled.exitCode !== 0) {
              details.push(
                `rollback swapon failed: ${reenabled.stderr.trim()}`,
              );
            }
          }
        }

        if (removeAddedFstabEntry) {
          const reverted = await removeFstabEntry();
          if (reverted.exitCode !== 0) {
            details.push(
              `fstab rollback failed: ${reverted.stderr.trim() || `sed exited ${reverted.exitCode}`}`,
            );
          }
        }
        return details.join("; ");
      };

      if (isActive) {
        const off = await runSwapUtility(true, "swapoff", [paths.swapfile], {
          silent: true,
        });
        if (off.exitCode !== 0) {
          await removeTemporaryFile(replacement);
          if (backup !== undefined) await removeTemporaryFile(backup);
          return {
            status: "failed",
            detail: off.stderr.trim() || "unable to disable existing swap",
          };
        }
      }
      if (backup !== undefined) {
        const backedUp = await runSwapUtility(
          true,
          "mv",
          [paths.swapfile, backup],
          { silent: true },
        );
        if (backedUp.exitCode !== 0) {
          let rollbackDetail: string | undefined;
          if (isActive) {
            const reenabled = await runSwapUtility(
              true,
              "swapon",
              [paths.swapfile],
              {
                silent: true,
              },
            );
            rollbackDetail = rollbackSwaponFailure(reenabled);
          }
          await removeTemporaryFile(replacement);
          await removeTemporaryFile(backup);
          return {
            status: "failed",
            detail: [
              backedUp.stderr.trim() || "unable to back up existing swap",
              rollbackDetail,
            ]
              .filter(Boolean)
              .join("; "),
          };
        }
      }
      const moved = await runSwapUtility(
        true,
        "mv",
        [replacement, paths.swapfile],
        { silent: true },
      );
      const enabled =
        moved.exitCode === 0
          ? await runSwapUtility(true, "swapon", [paths.swapfile], {
              silent: true,
            })
          : moved;
      if (enabled.exitCode !== 0) {
        const rollbackDetail = await rollbackReplacement(false, false);
        return {
          status: "failed",
          detail: [
            enabled.stderr.trim() || "unable to enable replacement swap",
            rollbackDetail,
          ]
            .filter(Boolean)
            .join("; "),
        };
      }

      if (fstabBefore.status === "absent") {
        const appended = await runSwapUtility(
          true,
          "tee",
          ["-a", paths.fstab],
          {
            silent: true,
            input: `${paths.swapfile} none swap sw 0 0\n`,
          },
        );
        if (appended.exitCode !== 0) {
          const rollbackDetail = await rollbackReplacement(true, true);
          return {
            status: "failed",
            detail: [
              appended.stderr.trim() || `unable to update ${paths.fstab}`,
              rollbackDetail,
            ]
              .filter(Boolean)
              .join("; "),
          };
        }
      }

      if (backup !== undefined) {
        const removed = await runSwapUtility(true, "rm", ["-f", "--", backup], {
          silent: true,
        });
        if (removed.exitCode !== 0) {
          return {
            status: "failed",
            detail:
              removed.stderr.trim() || "unable to remove previous swap backup",
          };
        }
      }
      return { status: "removed" };
    },
  });
}

export async function createLinuxAdapter(
  context: RuntimeContext,
): Promise<Adapter> {
  const normalizedHome = posix.normalize(context.home);
  const trustedHome =
    normalizedHome === "/home/runner" ||
    (context.isUbuntuSlim &&
      (normalizedHome === "/root" || normalizedHome === "/github/home"));
  if (!trustedHome) {
    throw new Error(
      `Refusing unexpected Linux runner home '${context.home}'; no cleanup was scheduled.`,
    );
  }

  return {
    supportedComponents: SUPPORTED,
    operations: async (plan: CleanupPlan): Promise<readonly Operation[]> => {
      const operations: Operation[] = [];
      const add = (operation: Operation | undefined): void => {
        if (operation !== undefined) operations.push(operation);
      };
      const home = context.home;
      const cache = trustedToolCache(context.toolCache);
      let aptDirty = false;
      const androidRoot = exactDefinitionPath(
        process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME,
        "/usr/local/lib/android/sdk",
      );
      const condaRoot = exactDefinitionPath(
        process.env.CONDA,
        "/usr/share/miniconda",
      );
      const vcpkgRoot = exactDefinitionPath(
        process.env.VCPKG_INSTALLATION_ROOT,
        "/usr/local/share/vcpkg",
      );
      const seleniumRoot = exactDefinitionPath(
        process.env.SELENIUM_JAR_PATH,
        "/usr/share/java/selenium-server.jar",
      );

      add(createLinuxServiceStopOperation(context, plan));
      operations.push(createLinuxHomebrewCleanupOperation(context));

      const fixedPaths: readonly [
        component: ComponentId,
        target: string | undefined,
        parents: readonly string[],
        description: string,
        blockedBy?: readonly ComponentId[],
        coveredBy?: readonly ComponentId[],
      ][] = [
        ["dotnet", "/usr/share/dotnet", ["/usr/share"], "Remove .NET SDKs"],
        [
          "dotnet",
          "/usr/lib/dotnet",
          ["/usr/lib"],
          "Remove .NET runtime libraries",
        ],
        ["dotnet", "/etc/dotnet", ["/etc"], "Remove .NET configuration"],
        ["dotnet", join(home, ".dotnet"), [home], "Remove user .NET tools"],
        [
          "dotnet",
          "/etc/skel/.dotnet",
          ["/etc/skel"],
          "Remove seeded .NET user tools",
        ],
        [
          "android",
          androidRoot,
          ["/usr/local/lib/android"],
          "Remove Android SDK",
        ],
        [
          "android",
          join(home, ".android"),
          [home],
          "Remove Android user state",
        ],
        [
          "android",
          join(home, ".gradle"),
          [home],
          "Remove Android Gradle cache",
          ["gradle"],
        ],
        [
          "haskell",
          "/usr/local/.ghcup",
          ["/usr/local"],
          "Remove GHCup toolchains",
        ],
        [
          "haskell",
          join(home, ".ghcup"),
          [home],
          "Remove user GHCup toolchains",
        ],
        ["haskell", join(home, ".cabal"), [home], "Remove Cabal cache"],
        ["haskell", join(home, ".stack"), [home], "Remove Stack cache"],
        [
          "codeql",
          cache === undefined ? undefined : join(cache, "CodeQL"),
          cache === undefined ? [] : [cache],
          "Remove CodeQL bundles",
          [],
          ["cached-tools"],
        ],
        [
          "cached-tools",
          cache,
          cache === undefined ? [] : [dirname(cache)],
          "Remove hosted toolcache",
        ],
        [
          "cached-go",
          cache === undefined ? undefined : join(cache, "go"),
          cache === undefined ? [] : [cache],
          "Remove cached Go versions",
        ],
        [
          "cached-go",
          cache === undefined ? undefined : join(cache, "Go"),
          cache === undefined ? [] : [cache],
          "Remove cached Go versions",
        ],
        [
          "cached-node",
          cache === undefined ? undefined : join(cache, "node"),
          cache === undefined ? [] : [cache],
          "Remove cached Node.js versions",
        ],
        [
          "cached-node",
          cache === undefined ? undefined : join(cache, "Node"),
          cache === undefined ? [] : [cache],
          "Remove cached Node.js versions",
        ],
        [
          "cached-python",
          cache === undefined ? undefined : join(cache, "Python"),
          cache === undefined ? [] : [cache],
          "Remove cached Python versions",
        ],
        [
          "cached-python",
          cache === undefined ? undefined : join(cache, "python"),
          cache === undefined ? [] : [cache],
          "Remove cached Python versions",
        ],
        [
          "cached-pypy",
          cache === undefined ? undefined : join(cache, "PyPy"),
          cache === undefined ? [] : [cache],
          "Remove cached PyPy versions",
        ],
        [
          "cached-pypy",
          cache === undefined ? undefined : join(cache, "pypy"),
          cache === undefined ? [] : [cache],
          "Remove cached PyPy versions",
        ],
        [
          "cached-ruby",
          cache === undefined ? undefined : join(cache, "Ruby"),
          cache === undefined ? [] : [cache],
          "Remove cached Ruby versions",
        ],
        [
          "cached-ruby",
          cache === undefined ? undefined : join(cache, "ruby"),
          cache === undefined ? [] : [cache],
          "Remove cached Ruby versions",
        ],
        ["swift", "/usr/share/swift", ["/usr/share"], "Remove Swift toolchain"],
        [
          "swift",
          "/usr/local/share/swift",
          ["/usr/local/share"],
          "Remove local Swift toolchain",
        ],
        [
          "swift",
          "/usr/lib/swift",
          ["/usr/lib"],
          "Remove Swift runtime libraries",
        ],
        [
          "julia",
          "/usr/share/julia",
          ["/usr/share"],
          "Remove Julia shared data",
        ],
        ["java", "/usr/lib/jvm", ["/usr/lib"], "Remove Java installations"],
        [
          "java",
          "/usr/local/lib/jvm",
          ["/usr/local/lib"],
          "Remove local Java installations",
        ],
        ["miniconda", condaRoot, ["/usr/share"], "Remove Miniconda"],
        ["miniconda", join(home, ".conda"), [home], "Remove Conda user cache"],
        [
          "miniconda",
          join(home, ".cache", "conda"),
          [home],
          "Remove Conda download cache",
        ],
        ["vcpkg", vcpkgRoot, ["/usr/local/share"], "Remove vcpkg"],
        ["vcpkg", join(home, ".cache", "vcpkg"), [home], "Remove vcpkg cache"],
        ["vcpkg", join(home, ".vcpkg"), [home], "Remove vcpkg user state"],
        [
          "rust",
          "/usr/local/cargo",
          ["/usr/local"],
          "Remove system Cargo home",
        ],
        [
          "rust",
          "/usr/local/rustup",
          ["/usr/local"],
          "Remove system Rustup home",
        ],
        ["rust", "/etc/skel/.cargo", ["/etc/skel"], "Remove seeded Cargo home"],
        [
          "rust",
          "/etc/skel/.rustup",
          ["/etc/skel"],
          "Remove seeded Rustup toolchains",
        ],
        ["rust", join(home, ".cargo"), [home], "Remove Cargo home"],
        ["rust", join(home, ".rustup"), [home], "Remove Rustup home"],
        [
          "selenium",
          seleniumRoot,
          ["/usr/share/java"],
          "Remove Selenium server",
        ],
        [
          "powershell",
          "/opt/microsoft/powershell/7",
          ["/opt/microsoft/powershell"],
          "Remove PowerShell archive installation",
        ],
        [
          "browsers",
          "/opt/google/chrome",
          ["/opt/google"],
          "Remove Google Chrome",
        ],
        [
          "browsers",
          "/opt/microsoft/msedge",
          ["/opt/microsoft"],
          "Remove Microsoft Edge",
        ],
        ["browsers", "/usr/lib/chromium", ["/usr/lib"], "Remove Chromium"],
        [
          "browsers",
          "/usr/local/share/chromium",
          ["/usr/local/share"],
          "Remove runner-image Chromium",
        ],
        ["browsers", "/usr/lib/firefox", ["/usr/lib"], "Remove Firefox"],
        [
          "browsers",
          "/usr/local/share/chromedriver-linux64",
          ["/usr/local/share"],
          "Remove ChromeDriver",
        ],
        [
          "browsers",
          "/usr/local/share/edge_driver",
          ["/usr/local/share"],
          "Remove Edge WebDriver",
        ],
        [
          "browsers",
          "/usr/local/share/gecko_driver",
          ["/usr/local/share"],
          "Remove GeckoDriver",
        ],
        [
          "browsers",
          "/usr/share/java/selenium-server.jar",
          ["/usr/share/java"],
          "Remove Selenium server",
        ],
        [
          "chrome",
          "/opt/google/chrome",
          ["/opt/google"],
          "Remove Google Chrome",
        ],
        ["chromium", "/usr/lib/chromium", ["/usr/lib"], "Remove Chromium"],
        [
          "chromium",
          "/usr/local/share/chromium",
          ["/usr/local/share"],
          "Remove runner-image Chromium",
        ],
        [
          "edge",
          "/opt/microsoft/msedge",
          ["/opt/microsoft"],
          "Remove Microsoft Edge",
        ],
        ["firefox", "/usr/lib/firefox", ["/usr/lib"], "Remove Firefox"],
        [
          "webdrivers",
          "/usr/local/share/chromedriver-linux64",
          ["/usr/local/share"],
          "Remove ChromeDriver",
        ],
        [
          "webdrivers",
          "/usr/local/share/edge_driver",
          ["/usr/local/share"],
          "Remove Edge WebDriver",
        ],
        [
          "webdrivers",
          "/usr/local/share/gecko_driver",
          ["/usr/local/share"],
          "Remove GeckoDriver",
        ],
        ["aws-cli", "/usr/local/aws-cli", ["/usr/local"], "Remove AWS CLI"],
        [
          "aws-cli",
          "/usr/local/sessionmanagerplugin",
          ["/usr/local"],
          "Remove AWS Session Manager plugin",
        ],
        [
          "aws-sam-cli",
          "/usr/local/aws-sam-cli",
          ["/usr/local"],
          "Remove AWS SAM CLI",
        ],
        ["azure-cli", "/opt/az", ["/opt"], "Remove Azure CLI archive install"],
        [
          "gcloud-cli",
          "/usr/lib/google-cloud-sdk",
          ["/usr/lib"],
          "Remove Google Cloud SDK",
        ],
        [
          "gcloud-cli",
          "/opt/google-cloud-sdk",
          ["/opt"],
          "Remove Google Cloud SDK archive install",
        ],
        [
          "gcloud-cli",
          "/opt/google-cloud-cli",
          ["/opt"],
          "Remove Google Cloud CLI archive install",
        ],
        [
          "maven",
          "/usr/share/maven",
          ["/usr/share"],
          "Remove Maven shared installation",
        ],
        [
          "gradle",
          "/usr/share/gradle",
          ["/usr/share"],
          "Remove Gradle shared installation",
        ],
        [
          "ant",
          "/usr/share/ant",
          ["/usr/share"],
          "Remove Ant shared installation",
        ],
        ["php", "/etc/php", ["/etc"], "Remove PHP configuration"],
        [
          "php",
          "/usr/share/php",
          ["/usr/share"],
          "Remove PHP shared libraries",
        ],
        [
          "postgresql",
          "/var/lib/postgresql",
          ["/var/lib"],
          "Remove PostgreSQL data",
        ],
        [
          "postgresql",
          "/etc/postgresql",
          ["/etc"],
          "Remove PostgreSQL configuration",
        ],
        [
          "postgresql",
          "/usr/lib/postgresql",
          ["/usr/lib"],
          "Remove PostgreSQL libraries",
        ],
        ["mysql", "/var/lib/mysql", ["/var/lib"], "Remove MySQL data"],
        ["mysql", "/etc/mysql", ["/etc"], "Remove MySQL configuration"],
        ["apache", "/etc/apache2", ["/etc"], "Remove Apache configuration"],
        [
          "apache",
          "/var/www",
          ["/var"],
          "Remove Apache document root",
          ["nginx"],
        ],
        ["nginx", "/etc/nginx", ["/etc"], "Remove Nginx configuration"],
        [
          "podman",
          "/var/lib/containers",
          ["/var/lib"],
          "Remove Podman storage",
          ["buildah"],
        ],
        [
          "docker-engine",
          "/var/lib/docker",
          ["/var/lib"],
          "Remove Docker data",
          ["docker-images"],
        ],
        [
          "docker-engine",
          "/var/lib/containerd",
          ["/var/lib"],
          "Remove containerd data",
          ["docker-images"],
        ],
        [
          "docker-engine",
          "/etc/docker",
          ["/etc"],
          "Remove Docker configuration",
        ],
        [
          "docker-engine",
          "/usr/lib/docker",
          ["/usr/lib"],
          "Remove Docker libraries",
        ],
        [
          "docker-engine",
          "/usr/libexec/docker",
          ["/usr/libexec"],
          "Remove Docker helpers",
        ],
        [
          "docker-engine",
          "/usr/local/lib/docker",
          ["/usr/local/lib"],
          "Remove local Docker libraries",
        ],
      ];
      for (const [
        component,
        target,
        parents,
        description,
        blockedBy,
        coveredBy,
      ] of fixedPaths) {
        add(
          removeOperation(
            context,
            component,
            target,
            parents,
            description,
            blockedBy,
            coveredBy,
          ),
        );
      }

      if (cache !== undefined) {
        for (const component of [
          "dotnet",
          "haskell",
          "swift",
          "julia",
          "java",
        ] as const) {
          const names: Record<typeof component, readonly string[]> = {
            dotnet: ["dotnet"],
            haskell: ["ghc", "GHC"],
            swift: ["swift", "Swift"],
            julia: ["Julia", "julia"],
            java: ["Java_Temurin-Hotspot_jdk"],
          };
          for (const name of names[component]) {
            add(
              removeOperation(
                context,
                component,
                join(cache, name),
                [cache],
                `Remove ${component} toolcache entries`,
                [],
                ["cached-tools"],
              ),
            );
          }
        }
      }

      for (const path of await versionedChildren(
        "/usr/local",
        /^julia\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "julia",
            path,
            ["/usr/local"],
            "Remove Julia installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/local",
        /^apache-maven-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "maven",
            path,
            ["/usr/local"],
            "Remove Maven installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/local",
        /^gradle-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "gradle",
            path,
            ["/usr/local"],
            "Remove Gradle installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/share",
        /^apache-maven-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "maven",
            path,
            ["/usr/share"],
            "Remove versioned Maven installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/share",
        /^gradle-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "gradle",
            path,
            ["/usr/share"],
            "Remove versioned Gradle installation",
          ),
        );
      }

      const driverTargets: readonly [ComponentId, string, string][] = [
        [
          "webdrivers",
          exactDefinitionPath(
            process.env.CHROMEWEBDRIVER,
            "/usr/local/share/chromedriver-linux64",
          ),
          "Remove ChromeDriver",
        ],
        [
          "webdrivers",
          exactDefinitionPath(
            process.env.EDGEWEBDRIVER,
            "/usr/local/share/edge_driver",
          ),
          "Remove Edge WebDriver",
        ],
        [
          "webdrivers",
          exactDefinitionPath(
            process.env.GECKOWEBDRIVER,
            "/usr/local/share/gecko_driver",
          ),
          "Remove GeckoDriver",
        ],
      ];
      for (const [component, target, description] of driverTargets) {
        add(
          removeOperation(
            context,
            component,
            target,
            ["/usr/local/share"],
            description,
          ),
        );
      }

      operations.push(
        aptBatchOperation(context, plan, () => {
          aptDirty = true;
        }),
      );
      operations.push(aptFinalizeOperation(context, () => aptDirty));

      const commands: Readonly<
        Partial<Record<ComponentId, readonly string[]>>
      > = {
        dotnet: ["dotnet"],
        haskell: ["ghc", "ghcup", "cabal", "stack"],
        swift: ["swift", "swiftc", "sourcekit-lsp"],
        julia: ["julia"],
        browsers: [
          "google-chrome",
          "google-chrome-stable",
          "chromium",
          "chromium-browser",
          "microsoft-edge",
          "microsoft-edge-stable",
          "firefox",
          "chromedriver",
          "msedgedriver",
          "geckodriver",
        ],
        chrome: ["google-chrome", "google-chrome-stable"],
        chromium: ["chromium", "chromium-browser"],
        edge: ["microsoft-edge", "microsoft-edge-stable"],
        firefox: ["firefox"],
        webdrivers: ["chromedriver", "msedgedriver", "geckodriver"],
        powershell: ["pwsh"],
        miniconda: ["conda"],
        vcpkg: ["vcpkg"],
        "aws-cli": ["aws", "session-manager-plugin"],
        "aws-sam-cli": ["sam"],
        "azure-cli": ["az"],
        "gh-cli": ["gh"],
        "gcloud-cli": ["gcloud", "gsutil", "bq"],
        azcopy: ["azcopy", "azcopy10"],
        kubectl: ["kubectl"],
        helm: ["helm"],
        kind: ["kind"],
        minikube: ["minikube"],
        kustomize: ["kustomize"],
        "docker-engine": [
          "docker",
          "docker-compose",
          "docker-buildx",
          "docker-credential-ecr-login",
        ],
        buildah: ["buildah"],
        podman: ["podman"],
        maven: ["mvn"],
        gradle: ["gradle"],
        ant: ["ant"],
        php: ["php", "composer", "phpunit"],
        rust: [
          "rustc",
          "cargo",
          "rustup",
          "rustdoc",
          "rustfmt",
          "cargo-clippy",
          "clippy-driver",
        ],
        postgresql: ["psql", "pg_config"],
        mysql: ["mysql", "mysqld", "mariadb"],
        apache: ["apache2"],
        nginx: ["nginx"],
      };
      const commandOperations: Promise<Operation>[] = [];
      for (const [component, names] of Object.entries(commands) as [
        ComponentId,
        readonly string[],
      ][]) {
        // Do not inspect or validate unrelated PATH entries. Besides making
        // custom cleanup cheaper, this prevents a protected runtime-owned
        // executable for a disabled component from blocking the active plan.
        if (!plan.enabled.has(component)) continue;
        for (const name of names) {
          commandOperations.push(commandRemoval(context, component, name));
        }
      }
      operations.push(...(await Promise.all(commandOperations)));

      operations.push(dockerPruneOperation(context));
      add(recreateToolCacheOperation(context, cache));
      if (plan.swapfileBytes !== undefined) {
        operations.push(createSwapOperation(context, plan.swapfileBytes));
      }
      return operations;
    },
  };
}
