import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  statfs,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  assertCommandTerminationConfirmed,
  inspectExecutable,
  runCommand,
  runElevated,
  sameCommandFileIdentity,
  TRUSTED_UNIX_PATH,
  UNIX_ENV_EXECUTABLE,
  UNIX_SUDO_EXECUTABLE,
  UnconfirmedCommandTerminationError,
  type CommandFileIdentity,
  type CommandOptions,
} from "../command.js";
import { COMPONENTS } from "../components.js";
import {
  createFunctionOperation,
  createRemovePathOperation,
} from "../operations.js";
import { assertSafeDirectoryTarget, assertSafeExactTarget } from "../safety.js";
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

export const LINUX_PACKAGE_EXECUTABLES = Object.freeze({
  aptGet: "/usr/bin/apt-get",
  chown: "/usr/bin/chown",
  docker: "/usr/bin/docker",
  dpkg: "/usr/bin/dpkg",
  dpkgQuery: "/usr/bin/dpkg-query",
  mkdir: "/usr/bin/mkdir",
} as const);

const APT_ISOLATION_ARGUMENTS = Object.freeze([
  "-o",
  "Dir::Etc::main=/dev/null",
  "-o",
  "Dir::Etc::parts=/dev/null",
  "-o",
  `Dir::Bin::dpkg=${LINUX_PACKAGE_EXECUTABLES.dpkg}`,
] as const);

export interface LinuxCommandDependencies {
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<CommandFileIdentity | undefined>;
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  readonly runElevated?: (
    context: RuntimeContext,
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
}

export interface LinuxToolCacheDependencies extends LinuxCommandDependencies {
  readonly createDirectory?: (target: string) => Promise<void>;
  readonly accessDirectory?: (target: string, mode: number) => Promise<void>;
}

export interface LinuxDockerConfigStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export interface LinuxDockerConfigProbe {
  lstat(path: string): Promise<LinuxDockerConfigStats>;
  readdir(path: string): Promise<readonly unknown[]>;
}

export interface LinuxDockerDependencies extends LinuxCommandDependencies {
  /** Return an uncreated high-entropy candidate below the fixed /tmp prefix. */
  readonly createConfigCandidate?: () => Promise<string>;
  readonly validateConfigDirectory?: (
    path: string,
  ) => Promise<CommandFileIdentity>;
}

const LINUX_DOCKER_CONFIG_ROOT = "/tmp";
const LINUX_DOCKER_CONFIG_PREFIX = `${LINUX_DOCKER_CONFIG_ROOT}/maximize-github-runner-space-docker-config-`;

function checkedLinuxDockerConfigDirectory(path: string): string {
  const token = path.slice(LINUX_DOCKER_CONFIG_PREFIX.length);
  if (
    path !== posix.normalize(path) ||
    posix.dirname(path) !== LINUX_DOCKER_CONFIG_ROOT ||
    !path.startsWith(LINUX_DOCKER_CONFIG_PREFIX) ||
    !/^[0-9a-f]{32}$/.test(token)
  ) {
    throw new Error(`Refusing unsafe Docker config directory: '${path}'.`);
  }
  return path;
}

const NODE_LINUX_DOCKER_CONFIG_PROBE: LinuxDockerConfigProbe = {
  lstat: async (path) => await lstat(path, { bigint: true }),
  readdir: async (path) => await readdir(path),
};

export async function validateLinuxDockerConfigMetadata(
  path: string,
  probe: LinuxDockerConfigProbe = NODE_LINUX_DOCKER_CONFIG_PROBE,
): Promise<CommandFileIdentity> {
  checkedLinuxDockerConfigDirectory(path);
  const root = await probe.lstat(LINUX_DOCKER_CONFIG_ROOT);
  if (
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    root.uid !== 0n ||
    root.gid !== 0n ||
    (root.mode & 0o7777n) !== 0o1777n
  ) {
    throw new Error(
      `Refusing unprotected Docker config root: '${LINUX_DOCKER_CONFIG_ROOT}'.`,
    );
  }
  const metadata = await probe.lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing non-directory Docker config target: '${path}'.`);
  }
  if (metadata.uid !== 0n || metadata.gid !== 0n) {
    throw new Error(
      `Refusing unprotected Docker config directory ownership: '${path}'.`,
    );
  }
  if ((metadata.mode & 0o777n) !== 0o555n) {
    throw new Error(
      `Refusing writable Docker config directory permissions: '${path}'.`,
    );
  }
  if ((await probe.readdir(path)).length !== 0) {
    throw new Error(`Refusing non-empty Docker config directory: '${path}'.`);
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
  };
}

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
  start?(unit: string): Promise<CommandResult>;
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

export function linuxPackageCommandEnvironment(
  context: RuntimeContext,
): NodeJS.ProcessEnv {
  return {
    ...linuxSystemCommandEnvironment(context),
    APT_CONFIG: "/dev/null",
    DEBIAN_FRONTEND: "noninteractive",
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
    start: async (unit) =>
      await runElevated(context, SYSTEMCTL, ["start", unit], {
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
    if (
      loadState === "masked" &&
      !["inactive", "failed"].includes(activeState)
    ) {
      throw new Error(
        `masked systemd unit ${target.unit} is ${activeState} and cannot be safely restarted`,
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
      "postgresql",
      "postgresql-common",
      "postgresql-client-common",
      "^postgresql-.*",
    ],
    mysql: ["mysql-common", "^mysql-.*", "^mariadb-.*"],
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

export async function listLinuxVersionedChildren(
  parent: string,
  pattern: RegExp,
): Promise<readonly string[]> {
  try {
    const selected = (await readdir(parent, { withFileTypes: true }))
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          pattern.test(entry.name),
      )
      .map((entry) => join(parent, entry.name))
      .sort((left, right) => left.localeCompare(right));
    if (selected.length > 64) {
      throw new Error(
        `versioned directory inventory under '${parent}' exceeded 64 entries`,
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

interface LinuxAptExecutableState {
  readonly aptGet: CommandFileIdentity | undefined;
  readonly dpkg: CommandFileIdentity | undefined;
  readonly dpkgQuery: CommandFileIdentity | undefined;
}

function commandDependencies(
  dependencies: LinuxCommandDependencies,
): Required<
  Pick<
    LinuxCommandDependencies,
    "inspectExecutable" | "runCommand" | "runElevated"
  >
> {
  return {
    inspectExecutable: dependencies.inspectExecutable ?? inspectExecutable,
    runCommand: dependencies.runCommand ?? runCommand,
    runElevated: dependencies.runElevated ?? runElevated,
  };
}

type LinuxProtectedConfigUtility = "env" | "mkdir" | "rmdir" | "sudo";
type LinuxProtectedConfigUtilityState = Readonly<
  Record<LinuxProtectedConfigUtility, CommandFileIdentity>
>;
type ResolvedLinuxCommandDependencies = ReturnType<typeof commandDependencies>;

const LINUX_PROTECTED_CONFIG_EXECUTABLES: Readonly<
  Record<LinuxProtectedConfigUtility, string>
> = {
  env: UNIX_ENV_EXECUTABLE,
  mkdir: "/usr/bin/mkdir",
  rmdir: "/usr/bin/rmdir",
  sudo: UNIX_SUDO_EXECUTABLE,
};

async function inspectLinuxProtectedConfigUtilities(
  commands: ResolvedLinuxCommandDependencies,
): Promise<LinuxProtectedConfigUtilityState> {
  const identities = {} as Record<
    LinuxProtectedConfigUtility,
    CommandFileIdentity
  >;
  for (const utility of Object.keys(
    LINUX_PROTECTED_CONFIG_EXECUTABLES,
  ) as LinuxProtectedConfigUtility[]) {
    const executable = LINUX_PROTECTED_CONFIG_EXECUTABLES[utility];
    const identity = await commands.inspectExecutable(executable);
    if (
      identity === undefined ||
      identity.userId !== 0n ||
      identity.mode === undefined ||
      (identity.mode & 0o022n) !== 0n
    ) {
      throw new Error(
        `Refusing untrusted protected-config executable '${executable}'.`,
      );
    }
    identities[utility] = identity;
  }
  return identities;
}

function sameLinuxProtectedConfigUtilities(
  left: LinuxProtectedConfigUtilityState,
  right: LinuxProtectedConfigUtilityState,
): boolean {
  return (
    Object.keys(
      LINUX_PROTECTED_CONFIG_EXECUTABLES,
    ) as LinuxProtectedConfigUtility[]
  ).every((utility) => sameCommandFileIdentity(left[utility], right[utility]));
}

async function runLinuxProtectedConfigUtility(
  context: RuntimeContext,
  commands: ResolvedLinuxCommandDependencies,
  validated: LinuxProtectedConfigUtilityState | undefined,
  utility: "mkdir" | "rmdir",
  args: readonly string[],
  description: string,
): Promise<void> {
  if (validated === undefined) {
    throw new Error(
      "Protected-config utilities were not pinned during plan validation",
    );
  }
  const before = await inspectLinuxProtectedConfigUtilities(commands);
  if (!sameLinuxProtectedConfigUtilities(validated, before)) {
    throw new Error(`A trusted executable changed before ${description}.`);
  }
  const result = await commands.runElevated(
    context,
    LINUX_PROTECTED_CONFIG_EXECUTABLES[utility],
    args,
    {
      env: linuxSystemCommandEnvironment(context),
      silent: true,
      timeoutMs: 10_000,
    },
  );
  assertCommandTerminationConfirmed();
  const after = await inspectLinuxProtectedConfigUtilities(commands);
  if (!sameLinuxProtectedConfigUtilities(validated, after)) {
    throw new Error(`A trusted executable changed during ${description}.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `${description} exited ${result.exitCode}`,
    );
  }
}

async function inspectLinuxAptExecutables(
  dependencies: LinuxCommandDependencies,
): Promise<LinuxAptExecutableState> {
  const commands = commandDependencies(dependencies);
  const [aptGet, dpkg, dpkgQuery] = await Promise.all([
    commands.inspectExecutable(LINUX_PACKAGE_EXECUTABLES.aptGet),
    commands.inspectExecutable(LINUX_PACKAGE_EXECUTABLES.dpkg),
    commands.inspectExecutable(LINUX_PACKAGE_EXECUTABLES.dpkgQuery),
  ]);
  return { aptGet, dpkg, dpkgQuery };
}

function sameOptionalCommandFileIdentity(
  left: CommandFileIdentity | undefined,
  right: CommandFileIdentity | undefined,
): boolean {
  return (
    (left === undefined && right === undefined) ||
    sameCommandFileIdentity(left, right)
  );
}

function sameLinuxAptExecutableState(
  left: LinuxAptExecutableState,
  right: LinuxAptExecutableState,
): boolean {
  return (
    sameOptionalCommandFileIdentity(left.aptGet, right.aptGet) &&
    sameOptionalCommandFileIdentity(left.dpkg, right.dpkg) &&
    sameOptionalCommandFileIdentity(left.dpkgQuery, right.dpkgQuery)
  );
}

export function createLinuxAptBatchOperation(
  context: RuntimeContext,
  plan: CleanupPlan,
  markDirty: () => void,
  dependencies: LinuxCommandDependencies = {},
): Operation {
  const commands = commandDependencies(dependencies);
  const environment = linuxPackageCommandEnvironment(context);
  const specifications = [
    ...new Set(
      (
        Object.entries(APT_PACKAGES) as [ComponentId, readonly string[]][]
      ).flatMap(([component, packages]) =>
        plan.enabled.has(component) ? packages : [],
      ),
    ),
  ];
  let validated: LinuxAptExecutableState | undefined;
  let validatedInventory: string | undefined;
  const selectInstalled = (output: string): string[] =>
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((name) =>
        specifications.some((specification) => {
          if (!specification.includes("*") && !specification.startsWith("^")) {
            return (
              name === specification || name.startsWith(`${specification}:`)
            );
          }
          try {
            return new RegExp(specification).test(name);
          } catch {
            return false;
          }
        }),
      );
  return createFunctionOperation({
    id: "apt:selected-packages",
    component: "large-packages",
    description: "Remove selected runner-image packages with apt",
    phase: "package",
    dedupeKey: "apt:selected-packages",
    always: true,
    fatal: true,
    validate: async () => {
      validated = await inspectLinuxAptExecutables(dependencies);
      if (specifications.length > 0) {
        for (const [name, identity] of Object.entries(validated)) {
          if (identity === undefined) {
            const executable =
              name === "aptGet"
                ? "apt-get"
                : name === "dpkgQuery"
                  ? "dpkg-query"
                  : name;
            throw new Error(`${executable} executable is unavailable`);
          }
        }
        const query = await commands.runCommand(
          LINUX_PACKAGE_EXECUTABLES.dpkgQuery,
          ["-W", "-f=${binary:Package}\\n"],
          { env: environment, silent: true },
        );
        if (query.exitCode !== 0 || query.stdoutTruncated === true) {
          throw new Error(
            query.stderr.trim() ||
              (query.stdoutTruncated === true
                ? "dpkg package inventory exceeded the safe output bound"
                : "dpkg database unavailable"),
          );
        }
        validatedInventory = query.stdout;
      }
    },
    run: async () => {
      if (specifications.length === 0) return { status: "not-found" };
      if (context.isContainer && !context.hasPasswordlessSudo) {
        return {
          status: "failed",
          detail:
            "passwordless sudo is required before selected apt-backed components can be cleaned",
        };
      }
      const current = await inspectLinuxAptExecutables(dependencies);
      if (
        validated !== undefined &&
        !sameLinuxAptExecutableState(validated, current)
      ) {
        return {
          status: "failed",
          detail: "apt executable changed after plan validation",
        };
      }
      if (
        current.aptGet === undefined ||
        current.dpkg === undefined ||
        current.dpkgQuery === undefined
      ) {
        return {
          status: "failed",
          detail: "required apt executable inventory became unavailable",
        };
      }
      const query = await commands.runCommand(
        LINUX_PACKAGE_EXECUTABLES.dpkgQuery,
        ["-W", "-f=${binary:Package}\\n"],
        { env: environment, silent: true },
      );
      if (query.exitCode !== 0 || query.stdoutTruncated === true) {
        return {
          status: "failed",
          detail:
            query.stderr.trim() ||
            (query.stdoutTruncated === true
              ? "dpkg package inventory exceeded the safe output bound"
              : "dpkg database unavailable"),
        };
      }
      if (
        validatedInventory !== undefined &&
        query.stdout !== validatedInventory
      ) {
        return {
          status: "failed",
          detail: "dpkg package inventory changed after plan validation",
        };
      }
      const selected = selectInstalled(query.stdout);
      if (selected.length === 0) return { status: "not-found" };
      const beforeMutation = await inspectLinuxAptExecutables(dependencies);
      if (!sameLinuxAptExecutableState(current, beforeMutation)) {
        return {
          status: "failed",
          detail: "apt executable changed before package mutation",
        };
      }
      const result = await commands.runElevated(
        context,
        LINUX_PACKAGE_EXECUTABLES.aptGet,
        [
          ...APT_ISOLATION_ARGUMENTS,
          "purge",
          "-y",
          "--no-install-recommends",
          ...selected,
        ],
        { env: environment, silent: false, timeoutMs: 15 * 60_000 },
      );
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          detail: result.stderr.trim() || `apt exited ${result.exitCode}`,
        };
      }
      markDirty();

      const afterMutation = await inspectLinuxAptExecutables(dependencies);
      if (!sameLinuxAptExecutableState(beforeMutation, afterMutation)) {
        return {
          status: "failed",
          detail: "apt executable changed while verifying package removal",
        };
      }
      const afterQuery = await commands.runCommand(
        LINUX_PACKAGE_EXECUTABLES.dpkgQuery,
        ["-W", "-f=${binary:Package}\\n"],
        { env: environment, silent: true },
      );
      if (afterQuery.exitCode !== 0 || afterQuery.stdoutTruncated === true) {
        return {
          status: "failed",
          detail:
            afterQuery.stderr.trim() ||
            (afterQuery.stdoutTruncated === true
              ? "post-purge dpkg inventory exceeded the safe output bound"
              : "dpkg database unavailable after package purge"),
        };
      }
      const remaining = selectInstalled(afterQuery.stdout);
      if (remaining.length !== 0) {
        const preview = remaining.slice(0, 8).join(", ");
        return {
          status: "failed",
          detail: `${preview}${remaining.length > 8 ? ` and ${remaining.length - 8} more packages` : ""} remained installed after apt reported success`,
        };
      }
      return { status: "removed" };
    },
  });
}

function commandRemovals(
  context: RuntimeContext,
  component: ComponentId,
  command: string,
): readonly Operation[] {
  // Runner-image definitions install command shims in these fixed roots.
  // Never let workflow PATH choose either a deletion target or whether a
  // definition-owned target is scheduled.
  return ["/usr/local/bin", "/usr/bin"].map((directory) =>
    createRemovePathOperation({
      id: `binary:${component}:${command}:${directory.slice(1).replaceAll("/", "-")}`,
      component,
      description: `Remove runner-image ${command} executable from ${directory}`,
      target: posix.join(directory, command),
      allowedParents: [directory],
      context,
    }),
  );
}

export function createLinuxDockerPruneOperation(
  context: RuntimeContext,
  dependencies: LinuxDockerDependencies = {},
): Operation {
  const commands = commandDependencies(dependencies);
  const environmentBase = linuxPackageCommandEnvironment(context);
  const createConfigCandidate =
    dependencies.createConfigCandidate ??
    (async () =>
      `${LINUX_DOCKER_CONFIG_PREFIX}${randomBytes(16).toString("hex")}`);
  const validateConfigDirectory =
    dependencies.validateConfigDirectory ??
    (async (path: string): Promise<CommandFileIdentity> => {
      checkedLinuxDockerConfigDirectory(path);
      await assertSafeDirectoryTarget(
        path,
        [LINUX_DOCKER_CONFIG_ROOT],
        context,
      );
      return await validateLinuxDockerConfigMetadata(path);
    });
  let validated: CommandFileIdentity | undefined;
  let validatedUtilities: LinuxProtectedConfigUtilityState | undefined;
  return createFunctionOperation({
    id: "docker:prune",
    component: "docker-images",
    description: "Prune unused Docker data",
    phase: "system",
    dedupeKey: "docker:prune",
    validate: async () => {
      validated = await commands.inspectExecutable(
        LINUX_PACKAGE_EXECUTABLES.docker,
      );
      if (validated !== undefined) {
        const currentUtilities =
          await inspectLinuxProtectedConfigUtilities(commands);
        if (
          validatedUtilities !== undefined &&
          !sameLinuxProtectedConfigUtilities(
            validatedUtilities,
            currentUtilities,
          )
        ) {
          throw new Error(
            "Docker protected-config executables changed after plan validation",
          );
        }
        validatedUtilities = currentUtilities;
      }
    },
    run: async () => {
      const current = await commands.inspectExecutable(
        LINUX_PACKAGE_EXECUTABLES.docker,
      );
      if (!sameOptionalCommandFileIdentity(validated, current)) {
        return {
          status: "failed",
          detail: "Docker executable changed after plan validation",
        };
      }
      if (current === undefined) return { status: "not-found" };

      let configDirectory: string;
      let configIdentity: CommandFileIdentity;
      try {
        configDirectory = checkedLinuxDockerConfigDirectory(
          await createConfigCandidate(),
        );
        await runLinuxProtectedConfigUtility(
          context,
          commands,
          validatedUtilities,
          "mkdir",
          ["-m", "0555", "--", configDirectory],
          "Docker configuration directory creation",
        );
        configIdentity = await validateConfigDirectory(configDirectory);
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        return {
          status: "failed",
          detail: `could not create isolated Docker configuration: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const environment = {
        ...environmentBase,
        DOCKER_CONFIG: configDirectory,
        DOCKER_HOST: "unix:///var/run/docker.sock",
      };
      let outcome: OperationResult | undefined;
      let executionError: unknown;
      try {
        const beforeProbe = await commands.inspectExecutable(
          LINUX_PACKAGE_EXECUTABLES.docker,
        );
        if (!sameCommandFileIdentity(current, beforeProbe)) {
          return {
            status: "failed",
            detail: "Docker executable changed before daemon inspection",
          };
        }
        let configBeforeProbe: CommandFileIdentity;
        try {
          configBeforeProbe = await validateConfigDirectory(configDirectory);
        } catch (error) {
          return {
            status: "failed",
            detail: `unsafe isolated Docker configuration before inspection: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (!sameCommandFileIdentity(configIdentity, configBeforeProbe)) {
          return {
            status: "failed",
            detail: "isolated Docker configuration changed before inspection",
          };
        }
        const responsive = await commands.runCommand(
          LINUX_PACKAGE_EXECUTABLES.docker,
          [
            "--host",
            "unix:///var/run/docker.sock",
            "--config",
            configDirectory,
            "info",
          ],
          { env: environment, silent: true, timeoutMs: 10_000 },
        );
        if (responsive.exitCode !== 0) {
          const output =
            `${responsive.stdout}\n${responsive.stderr}`.toLowerCase();
          const daemonUnavailable =
            responsive.exitCode === 1 &&
            responsive.stdoutTruncated !== true &&
            responsive.stderrTruncated !== true &&
            (output.includes(
              "cannot connect to the docker daemon at unix:///var/run/docker.sock",
            ) ||
              (output.includes("/var/run/docker.sock") &&
                output.includes("no such file or directory")));
          outcome = daemonUnavailable
            ? {
                status: "unsupported",
                detail: "local Docker daemon unavailable",
              }
            : {
                status: "failed",
                detail:
                  responsive.stderr.trim() ||
                  `docker info exited ${responsive.exitCode}`,
              };
        } else {
          const beforeMutation = await commands.inspectExecutable(
            LINUX_PACKAGE_EXECUTABLES.docker,
          );
          if (!sameCommandFileIdentity(current, beforeMutation)) {
            outcome = {
              status: "failed",
              detail: "Docker executable changed before image mutation",
            };
          } else {
            let configBeforeMutation: CommandFileIdentity;
            try {
              configBeforeMutation =
                await validateConfigDirectory(configDirectory);
            } catch (error) {
              outcome = {
                status: "failed",
                detail: `unsafe isolated Docker configuration before mutation: ${error instanceof Error ? error.message : String(error)}`,
              };
              configBeforeMutation = configIdentity;
            }
            if (
              outcome === undefined &&
              !sameCommandFileIdentity(configIdentity, configBeforeMutation)
            ) {
              outcome = {
                status: "failed",
                detail: "isolated Docker configuration changed before mutation",
              };
            }
            if (outcome === undefined) {
              const result = await commands.runElevated(
                context,
                LINUX_PACKAGE_EXECUTABLES.docker,
                [
                  "--host",
                  "unix:///var/run/docker.sock",
                  "--config",
                  configDirectory,
                  "system",
                  "prune",
                  "--all",
                  "--volumes",
                  "--force",
                ],
                {
                  env: environment,
                  silent: false,
                  timeoutMs: 10 * 60_000,
                },
              );
              outcome =
                result.exitCode === 0
                  ? { status: "removed" }
                  : { status: "failed", detail: result.stderr.trim() };
            }
          }
        }
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        executionError = error;
      }

      let removalError: unknown;
      try {
        assertCommandTerminationConfirmed();
        const configBeforeRemoval =
          await validateConfigDirectory(configDirectory);
        if (!sameCommandFileIdentity(configIdentity, configBeforeRemoval)) {
          throw new Error(
            "isolated Docker configuration changed before removal",
          );
        }
        await runLinuxProtectedConfigUtility(
          context,
          commands,
          validatedUtilities,
          "rmdir",
          ["--", configDirectory],
          "Docker configuration directory removal",
        );
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        removalError = error;
      }

      if (executionError !== undefined) {
        return {
          status: "failed",
          detail: `Docker cleanup could not execute: ${executionError instanceof Error ? executionError.message : String(executionError)}${removalError === undefined ? "" : `; temporary config cleanup failed: ${removalError instanceof Error ? removalError.message : String(removalError)}`}`,
        };
      }
      if (removalError !== undefined) {
        return {
          status: "failed",
          detail: `temporary Docker config cleanup failed: ${removalError instanceof Error ? removalError.message : String(removalError)}`,
        };
      }
      return (
        outcome ?? {
          status: "failed",
          detail: "Docker cleanup returned no operation result",
        }
      );
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
  let stoppedByAction: SystemdUnitSnapshot[] = [];
  const validate = async (): Promise<void> => {
    if (context.isContainer) {
      validatedSnapshot = [];
      return;
    }
    validatedSnapshot = await inspectSystemdUnits(targets, systemctl);
  };

  const restartStoppedUnits = async (): Promise<readonly string[]> => {
    const rollback: string[] = [];
    const stopped = [...stoppedByAction].reverse();
    stoppedByAction = [];
    for (const target of stopped) {
      if (!["active", "activating", "reloading"].includes(target.activeState)) {
        continue;
      }
      if (systemctl.start === undefined) {
        rollback.push(`${target.unit} could not be restarted`);
        continue;
      }
      try {
        const current = await systemctl.show(target.unit, "ActiveState");
        if (current.exitCode === 0 && current.stdout.trim() === "active") {
          continue;
        }
        if (current.exitCode !== 0) {
          rollback.push(
            current.stderr.trim() ||
              `${target.unit} state query failed before restart`,
          );
        }
      } catch (error) {
        rollback.push(
          `${target.unit} state query failed before restart: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let started: CommandResult;
      try {
        started = await systemctl.start(target.unit);
      } catch (error) {
        rollback.push(
          `${target.unit} restart failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (started.exitCode !== 0) {
        rollback.push(started.stderr.trim() || `${target.unit} restart failed`);
        continue;
      }
      try {
        const restored = await systemctl.show(target.unit, "ActiveState");
        if (restored.exitCode !== 0 || restored.stdout.trim() !== "active") {
          rollback.push(
            restored.stderr.trim() ||
              `${target.unit} did not reach active state after restart`,
          );
        }
      } catch (error) {
        rollback.push(
          `${target.unit} state verification failed after restart: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return rollback;
  };

  const restoreStoppedUnits = async (
    detail: string,
  ): Promise<OperationResult> => {
    const rollback = await restartStoppedUnits();
    return {
      status: "failed",
      detail: [detail, ...rollback.map((value) => `rollback: ${value}`)].join(
        "; ",
      ),
    };
  };

  return createFunctionOperation({
    id: "linux:services:stop",
    component: first.component,
    description: "Stop selected Linux services before cleanup",
    phase: "preflight",
    fatal: true,
    validate,
    rollback: async () => {
      const failures = await restartStoppedUnits();
      if (failures.length > 0) {
        throw new Error(failures.join("; "));
      }
    },
    run: async () => {
      if (context.isContainer) {
        return { status: "unsupported", detail: "systemd unavailable" };
      }

      try {
        stoppedByAction = [];
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

        for (const target of immediateSnapshot) {
          const { unit } = target;
          // Stop every loaded unit, including one observed inactive. That
          // closes the avoidable race where an inactive unit becomes active
          // after discovery but before its data is removed.
          // Record the original state before invoking systemctl: a timed-out
          // or otherwise failed stop can still have taken an active unit down.
          stoppedByAction.push(target);
          const result = await systemctl.stop(unit);
          if (result.exitCode !== 0) {
            return await restoreStoppedUnits(
              result.stderr.trim() || `could not stop ${unit}`,
            );
          }
          const stoppedState = await systemctl.show(unit, "ActiveState");
          if (!isStoppedSystemdUnit(stoppedState)) {
            return await restoreStoppedUnits(
              stoppedState.stderr.trim() ||
                `${unit} did not reach a terminal stopped state`,
            );
          }
        }

        // A socket, timer, dependency, or restart policy can reactivate a unit
        // while the remaining services are being stopped. Confirm the entire
        // coordinated set is still terminal before package/data cleanup begins.
        for (const { unit } of immediateSnapshot) {
          const stoppedState = await systemctl.show(unit, "ActiveState");
          if (!isStoppedSystemdUnit(stoppedState)) {
            return await restoreStoppedUnits(
              stoppedState.stderr.trim() ||
                `${unit} reactivated after the coordinated stop`,
            );
          }
        }
        return immediateSnapshot.length === 0
          ? { status: "not-found" }
          : { status: "removed" };
      } catch (error) {
        return await restoreStoppedUnits(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}

export function createLinuxHomebrewCleanupOperation(
  context: RuntimeContext,
): Operation {
  const cacheRoot = posix.join(context.home, ".cache");
  return createRemovePathOperation({
    id: "linux:brew:cache",
    component: "homebrew",
    description: "Remove the Linuxbrew cache",
    target: posix.join(cacheRoot, "Homebrew"),
    allowedParents: [cacheRoot],
    context,
  });
}

export function createLinuxToolCacheRecreateOperation(
  context: RuntimeContext,
  target: string | undefined,
  dependencies: LinuxToolCacheDependencies = {},
): Operation | undefined {
  if (target === undefined) return undefined;
  const commands = commandDependencies(dependencies);
  const createDirectory =
    dependencies.createDirectory ??
    (async (path: string) => await mkdir(path, { recursive: true }));
  const accessDirectory =
    dependencies.accessDirectory ??
    (async (path: string, mode: number) => await access(path, mode));
  type Utility = "mkdir" | "chown";
  const executableFor: Readonly<Record<Utility, string>> = {
    mkdir: LINUX_PACKAGE_EXECUTABLES.mkdir,
    chown: LINUX_PACKAGE_EXECUTABLES.chown,
  };
  let validated: Readonly<Record<Utility, CommandFileIdentity>> | undefined;
  const inspectUtilities = async (): Promise<
    Readonly<Record<Utility, CommandFileIdentity>>
  > => {
    const state = {} as Record<Utility, CommandFileIdentity>;
    for (const utility of Object.keys(executableFor) as Utility[]) {
      const identity = await commands.inspectExecutable(executableFor[utility]);
      if (identity === undefined) {
        throw new Error(`${utility} executable is unavailable`);
      }
      state[utility] = identity;
    }
    return state;
  };
  const sameUtilities = (
    left: Readonly<Record<Utility, CommandFileIdentity>>,
    right: Readonly<Record<Utility, CommandFileIdentity>>,
  ): boolean =>
    (Object.keys(executableFor) as Utility[]).every((utility) =>
      sameCommandFileIdentity(left[utility], right[utility]),
    );
  const validate = async (): Promise<void> => {
    await assertSafeDirectoryTarget(target, [dirname(target)], context);
    const current = await inspectUtilities();
    if (validated === undefined) {
      validated = current;
    } else if (!sameUtilities(validated, current)) {
      throw new Error(
        "toolcache recreation executable changed after validation",
      );
    }
  };
  const recheckUtility = async (utility: Utility): Promise<boolean> => {
    const current = await commands.inspectExecutable(executableFor[utility]);
    return sameCommandFileIdentity(validated?.[utility], current);
  };
  return createFunctionOperation({
    id: "toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    fatal: true,
    validate,
    run: async () => {
      try {
        await validate();
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let needsElevatedCreation = false;
      try {
        await createDirectory(target);
      } catch {
        needsElevatedCreation = true;
      }
      if (needsElevatedCreation) {
        if (!(await recheckUtility("mkdir"))) {
          return {
            status: "failed",
            detail: "mkdir executable changed before use",
          };
        }
        const created = await commands.runElevated(
          context,
          LINUX_PACKAGE_EXECUTABLES.mkdir,
          ["-p", "--", target],
          {
            env: linuxSystemCommandEnvironment(context),
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
      let needsOwnershipRepair = false;
      try {
        await accessDirectory(target, constants.W_OK | constants.X_OK);
      } catch {
        needsOwnershipRepair = true;
      }
      if (needsOwnershipRepair) {
        if (
          typeof process.getuid !== "function" ||
          typeof process.getgid !== "function"
        ) {
          return {
            status: "failed",
            detail:
              "toolcache is not writable and ownership cannot be repaired",
          };
        }
        if (!(await recheckUtility("chown"))) {
          return {
            status: "failed",
            detail: "chown executable changed before use",
          };
        }
        try {
          await assertSafeDirectoryTarget(target, [dirname(target)], context);
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const ownership = await commands.runElevated(
          context,
          LINUX_PACKAGE_EXECUTABLES.chown,
          [`${process.getuid()}:${process.getgid()}`, target],
          { env: linuxSystemCommandEnvironment(context), silent: true },
        );
        if (ownership.exitCode !== 0) {
          return { status: "failed", detail: ownership.stderr.trim() };
        }
      }
      try {
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
        await accessDirectory(target, constants.W_OK | constants.X_OK);
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
      } catch (error) {
        return {
          status: "failed",
          detail: `toolcache is not writable after recreation: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { status: "removed" };
    },
  });
}

export function createLinuxAptFinalizeOperation(
  context: RuntimeContext,
  isDirty: () => boolean,
  dependencies: LinuxCommandDependencies = {},
): Operation {
  const commands = commandDependencies(dependencies);
  const environment = linuxPackageCommandEnvironment(context);
  let validated: CommandFileIdentity | undefined;
  return createFunctionOperation({
    id: "apt:finalize",
    component: "large-packages",
    description: "Clean cached apt package archives",
    phase: "package",
    always: true,
    validate: async () => {
      validated = await commands.inspectExecutable(
        LINUX_PACKAGE_EXECUTABLES.aptGet,
      );
    },
    run: async () => {
      if (context.isContainer && !context.hasPasswordlessSudo) {
        return { status: "unsupported", detail: "apt cleanup unavailable" };
      }
      if (!isDirty()) return { status: "not-found" };
      const current = await commands.inspectExecutable(
        LINUX_PACKAGE_EXECUTABLES.aptGet,
      );
      if (!sameOptionalCommandFileIdentity(validated, current)) {
        return {
          status: "failed",
          detail: "apt executable changed after plan validation",
        };
      }
      if (current === undefined) {
        return { status: "unsupported", detail: "apt cleanup unavailable" };
      }
      const beforeClean = await commands.inspectExecutable(
        LINUX_PACKAGE_EXECUTABLES.aptGet,
      );
      if (!sameCommandFileIdentity(current, beforeClean)) {
        return {
          status: "failed",
          detail: "apt executable changed before cache cleanup",
        };
      }
      const clean = await commands.runElevated(
        context,
        LINUX_PACKAGE_EXECUTABLES.aptGet,
        [...APT_ISOLATION_ARGUMENTS, "clean"],
        { env: environment, silent: true, timeoutMs: 5 * 60_000 },
      );
      return clean.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: clean.stderr.trim(),
          };
    },
  });
}

export const LINUX_SWAP_EXECUTABLES = Object.freeze({
  chmod: "/usr/bin/chmod",
  chown: "/usr/bin/chown",
  dd: "/usr/bin/dd",
  df: "/usr/bin/df",
  fallocate: "/usr/bin/fallocate",
  grep: "/usr/bin/grep",
  mktemp: "/usr/bin/mktemp",
  mkswap: "/usr/sbin/mkswap",
  mv: "/usr/bin/mv",
  python3: "/usr/bin/python3",
  rm: "/usr/bin/rm",
  swapoff: "/usr/sbin/swapoff",
  swapon: "/usr/sbin/swapon",
  tee: "/usr/bin/tee",
  test: "/usr/bin/test",
  truncate: "/usr/bin/truncate",
} as const);

const MAX_FSTAB_BYTES = 1024 * 1024;
const FSTAB_EXCHANGE_SCRIPT = String.raw`
import ctypes
import hashlib
import os
import stat
import sys

MAX_BYTES = 1024 * 1024
AT_FDCWD = -100
RENAME_EXCHANGE = 2

def finish(marker, detail, code):
    print(marker)
    if detail:
        print(detail, file=sys.stderr)
    raise SystemExit(code)

def snapshot(path):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError("path is not a regular file")
        if before.st_size > MAX_BYTES:
            raise RuntimeError("file exceeded the 1 MiB safety bound")
        chunks = []
        length = 0
        while length <= MAX_BYTES:
            chunk = os.read(descriptor, MAX_BYTES + 1 - length)
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
        content = b"".join(chunks)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    identity = lambda value: (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
        stat.S_IMODE(value.st_mode),
        value.st_uid,
        value.st_gid,
    )
    if identity(before) != identity(after) or identity(after) != identity(current):
        raise RuntimeError("path changed while it was read")
    if len(content) > MAX_BYTES or len(content) != after.st_size:
        raise RuntimeError("file changed size while it was read")
    return identity(after) + (hashlib.sha256(content).hexdigest(),)

def expected(values):
    return tuple(int(value) for value in values[:8]) + (values[8],)

def same_after_exchange(observed, wanted):
    return (
        observed[:4] == wanted[:4]
        and observed[5:] == wanted[5:]
    )

if len(sys.argv) != 21:
    finish("NO_EXCHANGE", "invalid exchange arguments", 70)

source_path, target_path = sys.argv[1:3]
source_expected = expected(sys.argv[3:12])
target_expected = expected(sys.argv[12:21])

try:
    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
except AttributeError:
    finish("NO_EXCHANGE", "libc renameat2 is unavailable", 70)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int

def exchange():
    result = renameat2(
        AT_FDCWD,
        os.fsencode(source_path),
        AT_FDCWD,
        os.fsencode(target_path),
        RENAME_EXCHANGE,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))

try:
    if snapshot(source_path) != source_expected:
        finish("NO_EXCHANGE", "staged fstab identity or content changed", 71)
except Exception as error:
    finish("NO_EXCHANGE", "unable to validate staged fstab: " + str(error), 71)

try:
    exchange()
except Exception as error:
    finish("NO_EXCHANGE", "fstab exchange failed: " + str(error), 72)

try:
    displaced = snapshot(source_path)
    live = snapshot(target_path)
    if same_after_exchange(displaced, target_expected) and same_after_exchange(live, source_expected):
        finish("COMMITTED", "", 0)
except Exception as error:
    displaced = None
    verification_error = str(error)
else:
    verification_error = "displaced fstab did not match the expected snapshot"

try:
    exchange()
except Exception as error:
    finish(
        "UNCONFIRMED",
        verification_error + "; fstab rollback exchange failed: " + str(error),
        74,
    )

try:
    restored = snapshot(target_path)
    staged = snapshot(source_path)
    if (
        displaced is not None
        and same_after_exchange(restored, displaced)
        and same_after_exchange(staged, source_expected)
    ):
        finish("ROLLED_BACK", verification_error, 73)

    # A second writer won between the two exchanges. Put that newest observed
    # file back at the live path while retaining the earlier writer at source.
    exchange()
    latest = snapshot(target_path)
    retained = snapshot(source_path)
    if same_after_exchange(latest, staged) and same_after_exchange(retained, restored):
        finish(
            "UNCONFIRMED",
            verification_error + "; a second concurrent fstab update was preserved",
            74,
        )
    finish("UNCONFIRMED", verification_error + "; rollback state changed", 74)
except Exception as error:
    finish(
        "UNCONFIRMED",
        verification_error + "; unable to verify fstab rollback: " + str(error),
        74,
    )
`;

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
  readonly inspectExecutable?: (
    executable: string,
  ) => Promise<CommandFileIdentity | undefined>;
  /** Keeps command-only legacy test doubles isolated from native filesystem checks. */
  readonly nativeFilesystemSemantics?: boolean;
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

interface SwapParentIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly userId: bigint;
  readonly groupId: bigint;
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

async function captureProtectedSwapParents(
  paths: SwapDefinitionPaths,
  definitionRoot: string,
): Promise<readonly SwapParentIdentity[]> {
  const expectedUserId =
    definitionRoot === "/"
      ? 0n
      : typeof process.getuid === "function"
        ? BigInt(process.getuid())
        : undefined;
  const expectedGroupId =
    definitionRoot === "/"
      ? 0n
      : typeof process.getgid === "function"
        ? BigInt(process.getgid())
        : undefined;
  if (expectedUserId === undefined || expectedGroupId === undefined) {
    throw new Error("swap parent ownership cannot be verified on this host");
  }

  const identities: SwapParentIdentity[] = [];
  for (const path of [paths.mountDirectory, paths.etcDirectory]) {
    const metadata = await lstat(path, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== expectedUserId ||
      metadata.gid !== expectedGroupId ||
      (metadata.mode & 0o022n) !== 0n
    ) {
      throw new Error(`Refusing unprotected swap parent '${path}'.`);
    }
    identities.push({
      path,
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      userId: metadata.uid,
      groupId: metadata.gid,
    });
  }
  return identities;
}

function sameSwapParentIdentities(
  left: readonly SwapParentIdentity[],
  right: readonly SwapParentIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.path === other.path &&
        entry.device === other.device &&
        entry.inode === other.inode &&
        entry.mode === other.mode &&
        entry.userId === other.userId &&
        entry.groupId === other.groupId
      );
    })
  );
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
  await captureProtectedSwapParents(paths, definitionRoot);
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
  const inspectSwapExecutable =
    dependencies.inspectExecutable ?? inspectExecutable;
  const nativeFilesystemSemantics =
    dependencies.nativeFilesystemSemantics ??
    (definitionRoot === "/" && dependencies.commandRunner === undefined);
  let validatedExecutables:
    | Readonly<Partial<Record<LinuxSwapUtility, CommandFileIdentity>>>
    | undefined;
  let validatedExecutablePaths:
    Readonly<Partial<Record<LinuxSwapUtility, string>>> | undefined;
  let validatedSwapParents: readonly SwapParentIdentity[] | undefined;
  const requiredSwapUtilities = (
    Object.keys(LINUX_SWAP_EXECUTABLES) as LinuxSwapUtility[]
  ).filter(
    (utility) =>
      utility !== "grep" &&
      (nativeFilesystemSemantics || utility !== "python3"),
  );
  const commandRunner: LinuxSwapCommandRunner =
    dependencies.commandRunner ??
    (async ({ elevated, executable, args, options }) =>
      elevated
        ? await runElevated(context, executable, args, options)
        : await runCommand(executable, args, options));
  const inspectSwapExecutables = async (): Promise<
    Readonly<Partial<Record<LinuxSwapUtility, CommandFileIdentity>>>
  > => {
    if (validatedExecutablePaths === undefined) {
      const executablePaths: Partial<Record<LinuxSwapUtility, string>> = {};
      for (const utility of requiredSwapUtilities) {
        if (utility !== "python3") {
          executablePaths[utility] = LINUX_SWAP_EXECUTABLES[utility];
          continue;
        }
        let resolved: string;
        try {
          resolved = await realpath(LINUX_SWAP_EXECUTABLES.python3);
        } catch (error) {
          throw new Error(
            `python3 swap utility is unavailable at ${LINUX_SWAP_EXECUTABLES.python3}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!/^\/usr\/bin\/python3\.[0-9]+(?:\.[0-9]+)*$/.test(resolved)) {
          throw new Error(
            `python3 resolved outside the trusted versioned executable path: ${resolved}`,
          );
        }
        executablePaths.python3 = resolved;
      }
      validatedExecutablePaths = executablePaths;
    }
    const identities: Partial<Record<LinuxSwapUtility, CommandFileIdentity>> =
      {};
    for (const utility of requiredSwapUtilities) {
      const executable = validatedExecutablePaths[utility];
      if (executable === undefined) {
        throw new Error(`${utility} swap utility path was not resolved`);
      }
      const identity = await inspectSwapExecutable(executable);
      if (identity === undefined) {
        throw new Error(
          `${utility} swap utility is unavailable at ${executable}`,
        );
      }
      identities[utility] = identity;
    }
    return identities;
  };
  const validateSwapExecutables = async (): Promise<void> => {
    const current = await inspectSwapExecutables();
    if (validatedExecutables === undefined) {
      validatedExecutables = current;
      return;
    }
    for (const utility of requiredSwapUtilities) {
      if (
        !sameCommandFileIdentity(
          validatedExecutables[utility],
          current[utility],
        )
      ) {
        throw new Error(
          `${utility} swap utility changed after plan validation`,
        );
      }
    }
  };
  const runSwapUtility = async (
    elevated: boolean,
    utility: LinuxSwapUtility,
    args: readonly string[],
    options: Omit<CommandOptions, "env"> = {},
  ): Promise<CommandResult> => {
    if (validatedExecutables === undefined) await validateSwapExecutables();
    if (!requiredSwapUtilities.includes(utility)) {
      throw new Error(`${utility} swap utility is unavailable in this mode`);
    }
    const executable = validatedExecutablePaths?.[utility];
    if (executable === undefined) {
      throw new Error(`${utility} swap utility path was not resolved`);
    }
    const current = await inspectSwapExecutable(executable);
    if (!sameCommandFileIdentity(validatedExecutables?.[utility], current)) {
      throw new Error(`${utility} swap utility changed before use`);
    }
    return await commandRunner({
      elevated,
      executable,
      args,
      options: { ...options, env: environment },
    });
  };
  const validate = async (): Promise<void> => {
    await validateSwapTargets(context, definitionRoot);
    const currentParents = await captureProtectedSwapParents(
      paths,
      definitionRoot,
    );
    if (
      validatedSwapParents !== undefined &&
      !sameSwapParentIdentities(validatedSwapParents, currentParents)
    ) {
      throw new Error("swap parent identity changed after plan validation");
    }
    validatedSwapParents ??= currentParents;
    await validateSwapExecutables();
    if (requested === 0n) return;
    const filesystem = await statfs(paths.mountDirectory, { bigint: true });
    const totalCapacity = filesystem.blocks * filesystem.bsize;
    const reserve = 512n * 1024n * 1024n;
    if (totalCapacity <= reserve || requested > totalCapacity - reserve) {
      throw new Error(
        `requested swap exceeds safe ${paths.mountDirectory} filesystem capacity`,
      );
    }
  };
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

      interface TrackedSwapTemporaryFile {
        readonly device: bigint;
        readonly inode: bigint;
        readonly mode: bigint;
        readonly userId: bigint;
        readonly groupId: bigint;
      }
      interface TemporaryMetadataTransition {
        readonly permissions?: bigint;
        readonly userId?: bigint;
        readonly groupId?: bigint;
      }
      const trackedTemporaryFiles = new Map<string, TrackedSwapTemporaryFile>();
      const expectedTemporaryUserId =
        definitionRoot === "/"
          ? 0n
          : typeof process.getuid === "function"
            ? BigInt(process.getuid())
            : undefined;
      const expectedTemporaryGroupId =
        definitionRoot === "/"
          ? 0n
          : typeof process.getgid === "function"
            ? BigInt(process.getgid())
            : undefined;
      const inspectTemporaryFile = async (
        path: string,
      ): Promise<
        | {
            readonly identity: TrackedSwapTemporaryFile;
            readonly detail?: never;
          }
        | { readonly identity?: never; readonly detail: string }
      > => {
        try {
          const metadata = await lstat(path, { bigint: true });
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            return {
              detail: `temporary swap path is not a regular file: ${path}`,
            };
          }
          return {
            identity: {
              device: metadata.dev,
              inode: metadata.ino,
              mode: metadata.mode,
              userId: metadata.uid,
              groupId: metadata.gid,
            },
          };
        } catch (error) {
          return {
            detail: `unable to inspect temporary swap file ${path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      };
      const sameTemporaryFileMetadata = (
        left: TrackedSwapTemporaryFile,
        right: TrackedSwapTemporaryFile,
      ): boolean =>
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.userId === right.userId &&
        left.groupId === right.groupId;
      const sameTemporaryFileEntry = (
        left: TrackedSwapTemporaryFile,
        right: TrackedSwapTemporaryFile,
      ): boolean => left.device === right.device && left.inode === right.inode;
      const registerTemporaryFile = async (
        path: string,
      ): Promise<string | undefined> => {
        if (!nativeFilesystemSemantics) return undefined;
        const observed = await inspectTemporaryFile(path);
        if (observed.identity === undefined) return observed.detail;
        if (
          expectedTemporaryUserId === undefined ||
          expectedTemporaryGroupId === undefined ||
          observed.identity.userId !== expectedTemporaryUserId ||
          observed.identity.groupId !== expectedTemporaryGroupId ||
          (observed.identity.mode & 0o7777n) !== 0o600n
        ) {
          return `Refusing temporary swap file with unsafe ownership or permissions at '${path}'; expected mode 0600`;
        }
        trackedTemporaryFiles.set(path, observed.identity);
        return undefined;
      };
      const validateTrackedTemporaryFile = async (
        path: string,
      ): Promise<string | undefined> => {
        if (!nativeFilesystemSemantics) return undefined;
        const expected = trackedTemporaryFiles.get(path);
        if (expected === undefined) {
          return `temporary swap file identity was not captured: ${path}`;
        }
        const observed = await inspectTemporaryFile(path);
        if (
          observed.identity === undefined ||
          !sameTemporaryFileMetadata(expected, observed.identity)
        ) {
          return `temporary swap file identity changed before mutation: ${path}`;
        }
        return undefined;
      };
      const temporaryUtilityFailure = (
        detail: string,
        result?: CommandResult,
      ): CommandResult => ({
        exitCode: result?.exitCode === 0 ? 1 : (result?.exitCode ?? 1),
        stdout: result?.stdout ?? "",
        stderr: [result?.stderr.trim(), detail]
          .filter((value): value is string => Boolean(value))
          .join("; "),
        ...(result?.stdoutTruncated === undefined
          ? {}
          : { stdoutTruncated: result.stdoutTruncated }),
        ...(result?.stderrTruncated === undefined
          ? {}
          : { stderrTruncated: result.stderrTruncated }),
        ...(result?.terminationUnconfirmed === undefined
          ? {}
          : { terminationUnconfirmed: result.terminationUnconfirmed }),
      });
      const runTemporaryFileUtility = async (
        path: string,
        elevated: boolean,
        utility: LinuxSwapUtility,
        args: readonly string[],
        options: Omit<CommandOptions, "env"> = {},
        transition: TemporaryMetadataTransition = {},
      ): Promise<CommandResult> => {
        if (!nativeFilesystemSemantics) {
          return await runSwapUtility(elevated, utility, args, options);
        }
        const expected = trackedTemporaryFiles.get(path);
        const beforeFailure = await validateTrackedTemporaryFile(path);
        if (expected === undefined || beforeFailure !== undefined) {
          return temporaryUtilityFailure(
            beforeFailure ??
              `temporary swap file identity is unavailable: ${path}`,
          );
        }
        const result = await runSwapUtility(elevated, utility, args, options);
        const observed = await inspectTemporaryFile(path);
        if (
          observed.identity === undefined ||
          !sameTemporaryFileEntry(expected, observed.identity)
        ) {
          return temporaryUtilityFailure(
            `temporary swap file identity changed during ${utility}: ${path}`,
            result,
          );
        }
        const expectedPermissions =
          result.exitCode === 0 && transition.permissions !== undefined
            ? transition.permissions
            : expected.mode & 0o7777n;
        const expectedUserId =
          result.exitCode === 0 && transition.userId !== undefined
            ? transition.userId
            : expected.userId;
        const expectedGroupId =
          result.exitCode === 0 && transition.groupId !== undefined
            ? transition.groupId
            : expected.groupId;
        if (
          (observed.identity.mode & 0o7777n) !== expectedPermissions ||
          observed.identity.userId !== expectedUserId ||
          observed.identity.groupId !== expectedGroupId
        ) {
          return temporaryUtilityFailure(
            `temporary swap file metadata changed unexpectedly during ${utility}: ${path}`,
            result,
          );
        }
        trackedTemporaryFiles.set(path, observed.identity);
        return result;
      };

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
          created.stdoutTruncated === true ||
          suffix.length !== 6 ||
          !/^[A-Za-z0-9]+$/.test(suffix)
        ) {
          return {
            detail:
              created.stderr.trim() || "mktemp returned an unsafe swap path",
          };
        }
        const registrationFailure = await registerTemporaryFile(path);
        if (registrationFailure !== undefined) {
          return {
            detail: [
              created.exitCode === 0
                ? undefined
                : created.stderr.trim() || `mktemp exited ${created.exitCode}`,
              registrationFailure,
              `unverified temporary file retained at ${path}`,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        if (created.exitCode !== 0) {
          const cleanupFailure = await removeTemporaryFile(path);
          return {
            detail: [
              created.stderr.trim() || `mktemp exited ${created.exitCode}`,
              cleanupFailure === undefined
                ? undefined
                : `temporary file cleanup failed: ${cleanupFailure}`,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        return { path };
      };

      async function removeTemporaryFile(
        path: string,
      ): Promise<string | undefined> {
        const failures: string[] = [];
        if (trackedTemporaryFiles.has(path)) {
          const unsafe = await validateTrackedTemporaryFile(path);
          if (unsafe !== undefined) return `${unsafe}; file retained`;
        }
        const removed = await runSwapUtility(true, "rm", ["-f", "--", path], {
          silent: true,
        });
        if (removed.exitCode !== 0) {
          failures.push(
            removed.stderr.trim() || `rm exited ${removed.exitCode}`,
          );
        }
        const remaining = await runSwapUtility(false, "test", ["-e", path], {
          silent: true,
        });
        if (remaining.exitCode === 0) {
          failures.push("file remained after removal");
        } else if (remaining.exitCode !== 1) {
          failures.push(
            remaining.stderr.trim() ||
              `existence check exited ${remaining.exitCode}`,
          );
        } else {
          trackedTemporaryFiles.delete(path);
        }
        return failures.length === 0 ? undefined : failures.join("; ");
      }

      const detailWithTemporaryCleanup = async (
        detail: string,
        path: string,
      ): Promise<string> => {
        const cleanupFailure = await removeTemporaryFile(path);
        return [
          detail,
          cleanupFailure === undefined
            ? undefined
            : `temporary file cleanup failed: ${cleanupFailure}`,
        ]
          .filter((value): value is string => Boolean(value))
          .join("; ");
      };

      const removeFstabTemporaryFile = async (
        path: string,
      ): Promise<string | undefined> => {
        const failure = await removeTemporaryFile(path);
        return failure === undefined
          ? undefined
          : `temporary fstab cleanup failed: ${failure}`;
      };

      const makeBackupPath = async (
        prefix: string,
      ): Promise<
        | { readonly path: string; readonly detail?: never }
        | { readonly path?: never; readonly detail: string }
      > => {
        const temporary = await makeTemporaryFile(prefix);
        if (temporary.path === undefined) return temporary;
        const cleanupFailure = await removeTemporaryFile(temporary.path);
        return cleanupFailure === undefined
          ? { path: temporary.path }
          : {
              detail: `unable to prepare swap backup destination: ${cleanupFailure}`,
            };
      };

      const validateFstabMutation = async (): Promise<string | undefined> => {
        try {
          await assertSafeExactTarget(
            paths.fstab,
            [paths.etcDirectory],
            context,
            "regular-file",
          );
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      const verifyExactFstabContent = async (
        expected: Buffer,
      ): Promise<
        | { readonly matches: true; readonly detail?: never }
        | { readonly matches: false; readonly detail: string }
      > => {
        const observed = await readBoundedFstab();
        return observed.snapshot?.content.equals(expected) === true
          ? { matches: true }
          : {
              matches: false,
              detail:
                observed.snapshot === undefined
                  ? observed.detail
                  : `live ${paths.fstab} did not match the expected content`,
            };
      };

      interface AtomicFstabResult extends CommandResult {
        readonly moveAttempted: boolean;
        readonly committed?: FstabSnapshot;
      }

      interface FstabSnapshot {
        readonly content: Buffer;
        readonly device: bigint;
        readonly inode: bigint;
        readonly mode: bigint;
        readonly userId: bigint;
        readonly groupId: bigint;
        readonly size: bigint;
        readonly modifiedNanoseconds: bigint;
        readonly changedNanoseconds: bigint;
      }

      const sameFstabSnapshot = (
        left: FstabSnapshot,
        right: FstabSnapshot,
      ): boolean =>
        left.content.equals(right.content) &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.userId === right.userId &&
        left.groupId === right.groupId &&
        left.size === right.size &&
        left.modifiedNanoseconds === right.modifiedNanoseconds &&
        left.changedNanoseconds === right.changedNanoseconds;

      const sameFstabFileAfterExchange = (
        left: FstabSnapshot,
        right: FstabSnapshot,
      ): boolean =>
        left.content.equals(right.content) &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.userId === right.userId &&
        left.groupId === right.groupId &&
        left.size === right.size &&
        left.modifiedNanoseconds === right.modifiedNanoseconds;

      const withFstabTemporaryCleanup = async (
        result: CommandResult,
        path: string,
      ): Promise<AtomicFstabResult> => {
        const cleanupFailure = await removeFstabTemporaryFile(path);
        return {
          ...result,
          stderr: [result.stderr.trim(), cleanupFailure]
            .filter((value): value is string => Boolean(value))
            .join("; "),
          moveAttempted: false,
        };
      };

      const replaceFstabAtomically = async (
        content: Buffer,
        expectedCurrent: FstabSnapshot,
      ): Promise<AtomicFstabResult> => {
        const unsafe = await validateFstabMutation();
        if (unsafe !== undefined) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: unsafe,
            moveAttempted: false,
          };
        }
        const temporary = await makeTemporaryFile(
          `${paths.fstab}.maximize-github-runner-space.`,
        );
        if (temporary.path === undefined) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: temporary.detail,
            moveAttempted: false,
          };
        }
        const replacement = temporary.path;
        const written = await runTemporaryFileUtility(
          replacement,
          true,
          "tee",
          [replacement],
          {
            silent: true,
            input: content,
          },
        );
        if (written.exitCode !== 0) {
          return await withFstabTemporaryCleanup(written, replacement);
        }
        if (nativeFilesystemSemantics) {
          const owner = await runTemporaryFileUtility(
            replacement,
            true,
            "chown",
            [
              `${expectedCurrent.userId.toString()}:${expectedCurrent.groupId.toString()}`,
              "--",
              replacement,
            ],
            { silent: true },
            {
              userId: expectedCurrent.userId,
              groupId: expectedCurrent.groupId,
            },
          );
          if (owner.exitCode !== 0) {
            return await withFstabTemporaryCleanup(owner, replacement);
          }
          const mode = await runTemporaryFileUtility(
            replacement,
            true,
            "chmod",
            [expectedCurrent.mode.toString(8), "--", replacement],
            { silent: true },
            { permissions: expectedCurrent.mode },
          );
          if (mode.exitCode !== 0) {
            return await withFstabTemporaryCleanup(mode, replacement);
          }
          const staged = await readBoundedRegularFile(replacement);
          if (
            staged.snapshot === undefined ||
            !staged.snapshot.content.equals(content) ||
            staged.snapshot.mode !== expectedCurrent.mode ||
            staged.snapshot.userId !== expectedCurrent.userId ||
            staged.snapshot.groupId !== expectedCurrent.groupId
          ) {
            return await withFstabTemporaryCleanup(
              {
                exitCode: 1,
                stdout: "",
                stderr:
                  staged.snapshot === undefined
                    ? staged.detail
                    : "temporary fstab replacement did not match intended content",
              },
              replacement,
            );
          }
          const snapshotArguments = (snapshot: FstabSnapshot): string[] => [
            snapshot.device.toString(),
            snapshot.inode.toString(),
            snapshot.size.toString(),
            snapshot.modifiedNanoseconds.toString(),
            snapshot.changedNanoseconds.toString(),
            snapshot.mode.toString(),
            snapshot.userId.toString(),
            snapshot.groupId.toString(),
            createHash("sha256").update(snapshot.content).digest("hex"),
          ];
          const unsafeTemporary =
            await validateTrackedTemporaryFile(replacement);
          if (unsafeTemporary !== undefined) {
            return await withFstabTemporaryCleanup(
              { exitCode: 1, stdout: "", stderr: unsafeTemporary },
              replacement,
            );
          }
          const exchanged = await runSwapUtility(
            true,
            "python3",
            [
              "-I",
              "-S",
              "-c",
              FSTAB_EXCHANGE_SCRIPT,
              replacement,
              paths.fstab,
              ...snapshotArguments(staged.snapshot),
              ...snapshotArguments(expectedCurrent),
            ],
            { silent: true },
          );
          const marker = exchanged.stdoutTruncated
            ? "UNCONFIRMED"
            : exchanged.stdout.trim();
          if (exchanged.exitCode === 0 && marker === "COMMITTED") {
            // The exchange moved the staged inode to the live path. The same
            // pathname now contains the independently validated old fstab.
            trackedTemporaryFiles.delete(replacement);
            const [displaced, live] = await Promise.all([
              readBoundedRegularFile(replacement),
              readBoundedFstab(),
            ]);
            if (
              displaced.snapshot === undefined ||
              !sameFstabFileAfterExchange(
                displaced.snapshot,
                expectedCurrent,
              ) ||
              live.snapshot === undefined ||
              !sameFstabFileAfterExchange(live.snapshot, staged.snapshot)
            ) {
              return {
                exitCode: 1,
                stdout: exchanged.stdout,
                stderr: [
                  "fstab exchange postcondition was not confirmed",
                  displaced.snapshot === undefined
                    ? displaced.detail
                    : undefined,
                  live.snapshot === undefined ? live.detail : undefined,
                  `displaced fstab retained at ${replacement}`,
                ]
                  .filter((value): value is string => value !== undefined)
                  .join("; "),
                moveAttempted: true,
              };
            }
            const cleanupFailure = await removeFstabTemporaryFile(replacement);
            if (cleanupFailure !== undefined) {
              return {
                exitCode: 1,
                stdout: exchanged.stdout,
                stderr: cleanupFailure,
                moveAttempted: true,
                committed: live.snapshot,
              };
            }
            return {
              exitCode: 0,
              stdout: exchanged.stdout,
              stderr: exchanged.stderr,
              moveAttempted: true,
              committed: live.snapshot,
            };
          }

          let cleanupFailure: string | undefined;
          if (marker === "ROLLED_BACK" || marker === "NO_EXCHANGE") {
            const retained = await readBoundedRegularFile(replacement);
            const mayRemove =
              retained.snapshot !== undefined &&
              (marker === "ROLLED_BACK"
                ? sameFstabFileAfterExchange(retained.snapshot, staged.snapshot)
                : sameFstabSnapshot(retained.snapshot, staged.snapshot));
            cleanupFailure = mayRemove
              ? await removeFstabTemporaryFile(replacement)
              : `unconfirmed fstab exchange file retained at ${replacement}`;
          }
          return {
            ...exchanged,
            exitCode: exchanged.exitCode === 0 ? 1 : exchanged.exitCode,
            stderr: [
              exchanged.stderr.trim() ||
                (marker === "ROLLED_BACK"
                  ? `live ${paths.fstab} changed during atomic exchange`
                  : `atomic fstab exchange was ${marker.toLowerCase()}`),
              cleanupFailure,
              marker === "UNCONFIRMED"
                ? `exchange state retained for recovery at ${replacement}`
                : undefined,
            ]
              .filter((value): value is string => Boolean(value))
              .join("; "),
            moveAttempted: marker !== "NO_EXCHANGE",
          };
        }
        const stillSafe = await validateFstabMutation();
        if (stillSafe !== undefined) {
          return await withFstabTemporaryCleanup(
            { exitCode: 1, stdout: "", stderr: stillSafe },
            replacement,
          );
        }
        const mode = await runTemporaryFileUtility(
          replacement,
          true,
          "chmod",
          [`--reference=${paths.fstab}`, "--", replacement],
          { silent: true },
        );
        if (mode.exitCode !== 0) {
          return await withFstabTemporaryCleanup(mode, replacement);
        }
        const observed = await readBoundedRegularFile(replacement);
        if (
          observed.snapshot === undefined ||
          !observed.snapshot.content.equals(content)
        ) {
          return await withFstabTemporaryCleanup(
            {
              exitCode: 1,
              stdout: "",
              stderr:
                observed.snapshot === undefined
                  ? observed.detail
                  : "temporary fstab replacement did not match intended content",
            },
            replacement,
          );
        }
        const beforeMove = await validateFstabMutation();
        if (beforeMove !== undefined) {
          return await withFstabTemporaryCleanup(
            { exitCode: 1, stdout: "", stderr: beforeMove },
            replacement,
          );
        }
        const live = await readBoundedFstab();
        if (
          live.snapshot === undefined ||
          !sameFstabSnapshot(expectedCurrent, live.snapshot)
        ) {
          return await withFstabTemporaryCleanup(
            {
              exitCode: 1,
              stdout: "",
              stderr:
                live.snapshot === undefined
                  ? live.detail
                  : `live ${paths.fstab} changed before atomic rename`,
            },
            replacement,
          );
        }
        const moved = await runSwapUtility(
          true,
          "mv",
          [replacement, paths.fstab],
          { silent: true },
        );
        if (moved.exitCode !== 0) {
          const cleanupFailure = await removeFstabTemporaryFile(replacement);
          const live = await verifyExactFstabContent(content);
          return {
            ...moved,
            stderr: [
              moved.stderr.trim() || `mv exited ${moved.exitCode}`,
              live.matches
                ? "mv reported failure after intended fstab content became live"
                : live.detail,
              cleanupFailure,
            ]
              .filter((value): value is string => Boolean(value))
              .join("; "),
            moveAttempted: true,
          };
        }
        const committed = await verifyExactFstabContent(content);
        if (!committed.matches) {
          const cleanupFailure = await removeFstabTemporaryFile(replacement);
          return {
            exitCode: 1,
            stdout: "",
            stderr: [
              `unable to verify committed fstab replacement: ${committed.detail}`,
              cleanupFailure,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
            moveAttempted: true,
          };
        }
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          moveAttempted: true,
        };
      };

      interface AppendFstabResult extends AtomicFstabResult {
        readonly original?: FstabSnapshot;
        readonly intended?: Buffer;
      }

      const readBoundedRegularFile = async (
        path: string,
      ): Promise<
        | { readonly snapshot: FstabSnapshot; readonly detail?: never }
        | { readonly snapshot?: never; readonly detail: string }
      > => {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = await handle.stat({ bigint: true });
          if (!before.isFile()) {
            return { detail: `${path} is not a regular file` };
          }
          if (before.size > BigInt(MAX_FSTAB_BYTES)) {
            return { detail: `${path} exceeded the 1 MiB safety bound` };
          }
          const bounded = Buffer.allocUnsafe(MAX_FSTAB_BYTES + 1);
          let length = 0;
          while (length <= MAX_FSTAB_BYTES) {
            const { bytesRead } = await handle.read(
              bounded,
              length,
              bounded.length - length,
              length,
            );
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          const content = bounded.subarray(0, length);
          const after = await handle.stat({ bigint: true });
          const current = await lstat(path, { bigint: true });
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            after.dev !== current.dev ||
            after.ino !== current.ino ||
            after.size !== current.size ||
            after.mtimeNs !== current.mtimeNs ||
            after.ctimeNs !== current.ctimeNs ||
            BigInt(content.length) !== after.size
          ) {
            return { detail: `${path} changed while it was read` };
          }
          if (content.length > MAX_FSTAB_BYTES) {
            return { detail: `${path} exceeded the 1 MiB safety bound` };
          }
          return {
            snapshot: {
              content: Buffer.from(content),
              device: after.dev,
              inode: after.ino,
              mode: after.mode & 0o7777n,
              userId: after.uid,
              groupId: after.gid,
              size: after.size,
              modifiedNanoseconds: after.mtimeNs,
              changedNanoseconds: after.ctimeNs,
            },
          };
        } catch (error) {
          return {
            detail: `unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
          };
        } finally {
          await handle?.close();
        }
      };

      const readBoundedFstab = async (): Promise<
        | { readonly snapshot: FstabSnapshot; readonly detail?: never }
        | { readonly snapshot?: never; readonly detail: string }
      > => {
        const unsafe = await validateFstabMutation();
        return unsafe === undefined
          ? await readBoundedRegularFile(paths.fstab)
          : { detail: unsafe };
      };

      const isFstabWhitespace = (value: number | undefined): boolean =>
        value === 0x09 ||
        value === 0x0a ||
        value === 0x0b ||
        value === 0x0c ||
        value === 0x0d ||
        value === 0x20;

      const isOwnedFstabLine = (line: Buffer): boolean => {
        const path = Buffer.from(paths.swapfile, "utf8");
        if (
          line.length <= path.length ||
          !line.subarray(0, path.length).equals(path)
        ) {
          return false;
        }
        let offset = path.length;
        const consumeWhitespace = (): boolean => {
          const start = offset;
          while (isFstabWhitespace(line[offset])) offset += 1;
          return offset > start;
        };
        const consumeToken = (token: string): boolean => {
          const value = Buffer.from(token, "ascii");
          if (!line.subarray(offset, offset + value.length).equals(value)) {
            return false;
          }
          offset += value.length;
          return true;
        };
        return (
          consumeWhitespace() &&
          consumeToken("none") &&
          consumeWhitespace() &&
          consumeToken("swap") &&
          consumeWhitespace()
        );
      };

      const withoutOwnedFstabLines = (original: Buffer): Buffer => {
        const retained: Buffer[] = [];
        let start = 0;
        while (start < original.length) {
          const newline = original.indexOf(0x0a, start);
          const end = newline === -1 ? original.length : newline + 1;
          const line = original.subarray(start, end);
          if (!isOwnedFstabLine(line)) retained.push(line);
          start = end;
        }
        return Buffer.concat(retained);
      };

      const setFstabEntryAtomically = async (
        present: boolean,
      ): Promise<AppendFstabResult> => {
        const read = await readBoundedFstab();
        if (read.snapshot === undefined) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: read.detail,
            moveAttempted: false,
          };
        }
        const retained = withoutOwnedFstabLines(read.snapshot.content);
        let content = retained;
        if (present) {
          const separator =
            retained.length === 0 || retained.at(-1) === 0x0a ? "" : "\n";
          content = Buffer.concat([
            retained,
            Buffer.from(
              `${separator}${paths.swapfile} none swap sw 0 0\n`,
              "utf8",
            ),
          ]);
        }
        if (content.equals(read.snapshot.content)) {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            moveAttempted: false,
            committed: read.snapshot,
            original: read.snapshot,
            intended: content,
          };
        }
        return {
          ...(await replaceFstabAtomically(content, read.snapshot)),
          original: read.snapshot,
          intended: content,
        };
      };

      const removeFstabEntryAtomically = async (): Promise<AppendFstabResult> =>
        await setFstabEntryAtomically(false);

      const appendFstabEntryAtomically = async (): Promise<AppendFstabResult> =>
        await setFstabEntryAtomically(true);

      const recoverOriginalFstab = async (
        mutation: AppendFstabResult,
      ): Promise<
        | { readonly confirmed: true; readonly detail?: string }
        | { readonly confirmed: false; readonly detail: string }
      > => {
        if (mutation.original === undefined) {
          return {
            confirmed: false,
            detail: "original content was unavailable",
          };
        }
        let current = await readBoundedFstab();
        const originalIsLive =
          current.snapshot !== undefined &&
          (nativeFilesystemSemantics
            ? sameFstabFileAfterExchange(current.snapshot, mutation.original)
            : current.snapshot.content.equals(mutation.original.content));
        if (originalIsLive) return { confirmed: true };
        if (!mutation.moveAttempted) {
          return {
            confirmed: false,
            detail:
              current.snapshot === undefined
                ? current.detail
                : `live ${paths.fstab} did not match the original snapshot`,
          };
        }
        if (mutation.intended === undefined) {
          return {
            confirmed: false,
            detail: "intended replacement content was unavailable",
          };
        }
        if (
          current.snapshot === undefined ||
          (nativeFilesystemSemantics && mutation.committed === undefined) ||
          (mutation.committed === undefined
            ? !current.snapshot.content.equals(mutation.intended)
            : !sameFstabSnapshot(current.snapshot, mutation.committed))
        ) {
          return {
            confirmed: false,
            detail:
              current.snapshot === undefined
                ? current.detail
                : `live ${paths.fstab} changed after the attempted commit`,
          };
        }
        const restored = await replaceFstabAtomically(
          mutation.original.content,
          current.snapshot,
        );
        current = await readBoundedFstab();
        const restoredIsLive =
          current.snapshot !== undefined &&
          (restored.committed === undefined
            ? current.snapshot.content.equals(mutation.original.content)
            : sameFstabSnapshot(current.snapshot, restored.committed));
        if (!restoredIsLive) {
          return {
            confirmed: false,
            detail: [
              restored.exitCode === 0
                ? undefined
                : restored.stderr.trim() ||
                  `atomic restore exited ${restored.exitCode}`,
              current.snapshot === undefined
                ? current.detail
                : `live ${paths.fstab} did not match the restored snapshot`,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        return restored.exitCode === 0
          ? { confirmed: true }
          : {
              confirmed: true,
              detail:
                restored.stderr.trim() ||
                `atomic restore exited ${restored.exitCode}`,
            };
      };

      type SwapActivity =
        | { readonly status: "known"; readonly active: boolean }
        | { readonly status: "failed"; readonly detail: string };
      const readSwapActivity = async (): Promise<SwapActivity> => {
        const result = await runSwapUtility(
          false,
          "swapon",
          ["--show=NAME", "--noheadings"],
          { silent: true },
        );
        if (result.exitCode !== 0 || result.stdoutTruncated === true) {
          return {
            status: "failed",
            detail:
              result.stderr.trim() ||
              (result.stdoutTruncated === true
                ? "active swap inventory exceeded the safe output bound"
                : "unable to inspect active swap"),
          };
        }
        return {
          status: "known",
          active: result.stdout.split(/\s+/).includes(paths.swapfile),
        };
      };
      type PathPresence =
        | { readonly status: "known"; readonly present: boolean }
        | { readonly status: "failed"; readonly detail: string };
      const readPathPresence = async (path: string): Promise<PathPresence> => {
        const result = await runSwapUtility(false, "test", ["-e", path], {
          silent: true,
        });
        if (result.exitCode === 0) return { status: "known", present: true };
        if (result.exitCode === 1) return { status: "known", present: false };
        return {
          status: "failed",
          detail:
            result.stderr.trim() ||
            `existence check exited ${result.exitCode} for ${path}`,
        };
      };
      type MoveObservation =
        | { readonly status: "moved"; readonly identity?: SwapPathIdentity }
        | { readonly status: "not-moved" }
        | { readonly status: "unknown"; readonly detail: string };
      const observeLegacyMove = async (
        source: string,
        destination: string,
      ): Promise<MoveObservation> => {
        const sourceState = await readPathPresence(source);
        const destinationState = await readPathPresence(destination);
        if (
          sourceState.status === "known" &&
          destinationState.status === "known"
        ) {
          if (!sourceState.present && destinationState.present) {
            return { status: "moved" };
          }
          if (sourceState.present && !destinationState.present) {
            return { status: "not-moved" };
          }
          return {
            status: "unknown",
            detail: `unexpected move state: source ${sourceState.present ? "present" : "absent"}, destination ${destinationState.present ? "present" : "absent"}`,
          };
        }
        return {
          status: "unknown",
          detail: [
            sourceState.status === "failed" ? sourceState.detail : undefined,
            destinationState.status === "failed"
              ? destinationState.detail
              : undefined,
          ]
            .filter((value): value is string => value !== undefined)
            .join("; "),
        };
      };

      interface SwapPathIdentity {
        readonly device: bigint;
        readonly inode: bigint;
        readonly size: bigint;
        readonly mode: bigint;
        readonly userId: bigint;
        readonly groupId: bigint;
        readonly modifiedNanoseconds: bigint;
        readonly changedNanoseconds: bigint;
      }
      type SwapPathState =
        | { readonly status: "present"; readonly identity: SwapPathIdentity }
        | { readonly status: "absent" }
        | { readonly status: "failed"; readonly detail: string };
      const inspectSwapPath = async (path: string): Promise<SwapPathState> => {
        try {
          const metadata = await lstat(path, { bigint: true });
          if (!metadata.isFile()) {
            return {
              status: "failed",
              detail: `${path} is not a regular file`,
            };
          }
          return {
            status: "present",
            identity: {
              device: metadata.dev,
              inode: metadata.ino,
              size: metadata.size,
              mode: metadata.mode,
              userId: metadata.uid,
              groupId: metadata.gid,
              modifiedNanoseconds: metadata.mtimeNs,
              changedNanoseconds: metadata.ctimeNs,
            },
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code === "ENOENT" || code === "ENOTDIR"
            ? { status: "absent" }
            : {
                status: "failed",
                detail: `unable to inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
              };
        }
      };
      const sameSwapPathIdentity = (
        left: SwapPathIdentity,
        right: SwapPathIdentity,
      ): boolean =>
        left.device === right.device &&
        left.inode === right.inode &&
        left.size === right.size &&
        left.mode === right.mode &&
        left.userId === right.userId &&
        left.groupId === right.groupId &&
        left.modifiedNanoseconds === right.modifiedNanoseconds &&
        left.changedNanoseconds === right.changedNanoseconds;
      const sameSwapPathAfterMove = (
        left: SwapPathIdentity,
        right: SwapPathIdentity,
      ): boolean =>
        left.device === right.device &&
        left.inode === right.inode &&
        left.size === right.size &&
        left.mode === right.mode &&
        left.userId === right.userId &&
        left.groupId === right.groupId &&
        left.modifiedNanoseconds === right.modifiedNanoseconds;
      const inspectNativeMovePrecondition = async (
        source: string,
        destination: string,
        expectedSource?: SwapPathIdentity,
      ): Promise<
        | { readonly ready: true; readonly source: SwapPathIdentity }
        | {
            readonly ready: false;
            readonly observation: {
              readonly status: "unknown";
              readonly detail: string;
            };
          }
      > => {
        const [sourceState, destinationState] = await Promise.all([
          inspectSwapPath(source),
          inspectSwapPath(destination),
        ]);
        if (
          sourceState.status === "present" &&
          destinationState.status === "absent" &&
          (expectedSource === undefined ||
            sameSwapPathIdentity(sourceState.identity, expectedSource))
        ) {
          return { ready: true, source: sourceState.identity };
        }
        return {
          ready: false,
          observation: {
            status: "unknown",
            detail: [
              sourceState.status === "absent"
                ? `move source is absent: ${source}`
                : sourceState.status === "failed"
                  ? sourceState.detail
                  : expectedSource !== undefined &&
                      !sameSwapPathIdentity(
                        sourceState.identity,
                        expectedSource,
                      )
                    ? `move source changed after discovery: ${source}`
                    : undefined,
              destinationState.status === "present"
                ? `move destination already exists: ${destination}`
                : destinationState.status === "failed"
                  ? destinationState.detail
                  : undefined,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          },
        };
      };
      const moveAndObserve = async (
        source: string,
        destination: string,
        expectedSource?: SwapPathIdentity,
      ): Promise<{
        readonly command: CommandResult;
        readonly observation: MoveObservation;
      }> => {
        if (!nativeFilesystemSemantics) {
          const command = await runSwapUtility(
            true,
            "mv",
            [source, destination],
            { silent: true },
          );
          return {
            command,
            observation: await observeLegacyMove(source, destination),
          };
        }
        const trackedSource = trackedTemporaryFiles.get(source);
        if (trackedSource !== undefined) {
          const unsafe = await validateTrackedTemporaryFile(source);
          if (unsafe !== undefined) {
            return {
              command: { exitCode: 1, stdout: "", stderr: unsafe },
              observation: { status: "unknown", detail: unsafe },
            };
          }
        }
        const before = await inspectNativeMovePrecondition(
          source,
          destination,
          expectedSource,
        );
        if (!before.ready) {
          return {
            command: {
              exitCode: 1,
              stdout: "",
              stderr: before.observation.detail,
            },
            observation: before.observation,
          };
        }
        let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          sourceHandle = await open(
            source,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          const held = await sourceHandle.stat({ bigint: true });
          const heldIdentity: SwapPathIdentity = {
            device: held.dev,
            inode: held.ino,
            size: held.size,
            mode: held.mode,
            userId: held.uid,
            groupId: held.gid,
            modifiedNanoseconds: held.mtimeNs,
            changedNanoseconds: held.ctimeNs,
          };
          if (
            !held.isFile() ||
            !sameSwapPathIdentity(before.source, heldIdentity)
          ) {
            return {
              command: {
                exitCode: 1,
                stdout: "",
                stderr: `move source identity changed before mutation: ${source}`,
              },
              observation: {
                status: "unknown",
                detail: `move source identity changed before mutation: ${source}`,
              },
            };
          }
          const command = await runSwapUtility(
            true,
            "mv",
            [
              "--no-clobber",
              "--no-target-directory",
              "--",
              source,
              destination,
            ],
            { silent: true },
          );
          const [sourceState, destinationState, heldAfter] = await Promise.all([
            inspectSwapPath(source),
            inspectSwapPath(destination),
            sourceHandle.stat({ bigint: true }),
          ]);
          const heldAfterIdentity: SwapPathIdentity = {
            device: heldAfter.dev,
            inode: heldAfter.ino,
            size: heldAfter.size,
            mode: heldAfter.mode,
            userId: heldAfter.uid,
            groupId: heldAfter.gid,
            modifiedNanoseconds: heldAfter.mtimeNs,
            changedNanoseconds: heldAfter.ctimeNs,
          };
          if (
            sourceState.status === "absent" &&
            destinationState.status === "present" &&
            sameSwapPathAfterMove(heldIdentity, heldAfterIdentity) &&
            sameSwapPathIdentity(heldAfterIdentity, destinationState.identity)
          ) {
            if (trackedSource !== undefined) {
              trackedTemporaryFiles.delete(source);
              trackedTemporaryFiles.set(destination, {
                device: heldAfterIdentity.device,
                inode: heldAfterIdentity.inode,
                mode: heldAfterIdentity.mode,
                userId: heldAfterIdentity.userId,
                groupId: heldAfterIdentity.groupId,
              });
            }
            return {
              command,
              observation: { status: "moved", identity: heldAfterIdentity },
            };
          }
          if (
            sourceState.status === "present" &&
            sameSwapPathIdentity(heldAfterIdentity, sourceState.identity) &&
            destinationState.status === "absent"
          ) {
            return { command, observation: { status: "not-moved" } };
          }
          return {
            command,
            observation: {
              status: "unknown",
              detail:
                destinationState.status === "present" &&
                !sameSwapPathIdentity(
                  heldAfterIdentity,
                  destinationState.identity,
                )
                  ? `move destination identity did not match source identity: ${destination}`
                  : [
                      sourceState.status === "failed"
                        ? sourceState.detail
                        : undefined,
                      destinationState.status === "failed"
                        ? destinationState.detail
                        : undefined,
                      `move identity transition was not confirmed from ${source} to ${destination}`,
                    ]
                      .filter((value): value is string => value !== undefined)
                      .join("; "),
            },
          };
        } catch (error) {
          const detail = `unable to hold move source identity for ${source}: ${error instanceof Error ? error.message : String(error)}`;
          return {
            command: { exitCode: 1, stdout: "", stderr: detail },
            observation: { status: "unknown", detail },
          };
        } finally {
          await sourceHandle?.close();
        }
      };
      const initialActivity = await readSwapActivity();
      if (initialActivity.status === "failed") {
        return { status: "failed", detail: initialActivity.detail };
      }
      const isActive = initialActivity.active;
      const restoreOriginalActiveSwap = async (): Promise<
        string | undefined
      > => {
        if (!isActive) return undefined;
        try {
          const enabled = await runSwapUtility(
            true,
            "swapon",
            [paths.swapfile],
            { silent: true },
          );
          const verified = await readSwapActivity();
          if (verified.status === "failed") {
            return `rollback swapon verification failed: ${verified.detail}`;
          }
          if (!verified.active) {
            return `rollback swapon failed: ${enabled.stderr.trim() || (enabled.exitCode === 0 ? "original swapfile is not active" : `swapon exited ${enabled.exitCode}`)}`;
          }
          return undefined;
        } catch (error) {
          return `rollback swapon failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      const restoreBackupToSwapfile = async (
        backup: string,
        expectedBackup?: SwapPathIdentity,
      ): Promise<
        | { readonly restored: true; readonly detail?: string }
        | { readonly restored: false; readonly detail: string }
      > => {
        let before: MoveObservation;
        if (nativeFilesystemSemantics) {
          const inspected = await inspectNativeMovePrecondition(
            backup,
            paths.swapfile,
            expectedBackup,
          );
          before = inspected.ready
            ? { status: "not-moved" }
            : inspected.observation;
        } else {
          before = await observeLegacyMove(backup, paths.swapfile);
        }
        if (before.status !== "not-moved") {
          return {
            restored: false,
            detail: `rollback move precondition failed: ${before.status === "unknown" ? before.detail : "backup was already moved"}; backup retained at ${backup}`,
          };
        }
        const restored = await moveAndObserve(
          backup,
          paths.swapfile,
          expectedBackup,
        );
        if (restored.observation.status !== "moved") {
          return {
            restored: false,
            detail: [
              restored.command.stderr.trim() ||
                (restored.command.exitCode === 0
                  ? "mv reported success without restoring the swapfile"
                  : `mv exited ${restored.command.exitCode}`),
              restored.observation.status === "unknown"
                ? restored.observation.detail
                : undefined,
              `backup retained at ${backup}`,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        const activityFailure = await restoreOriginalActiveSwap();
        const commandFailure =
          restored.command.exitCode === 0
            ? undefined
            : restored.command.stderr.trim() ||
              `mv exited ${restored.command.exitCode} after restoring the swapfile`;
        if (activityFailure !== undefined) {
          return {
            restored: false,
            detail: [commandFailure, activityFailure]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        return commandFailure === undefined
          ? { restored: true }
          : { restored: true, detail: commandFailure };
      };

      const backUpOriginalSwap = async (
        backup: string,
        expectedOriginal?: SwapPathIdentity,
      ): Promise<
        | {
            readonly backedUp: true;
            readonly backupIdentity?: SwapPathIdentity;
          }
        | { readonly backedUp: false; readonly detail: string }
      > => {
        const moved = await moveAndObserve(
          paths.swapfile,
          backup,
          expectedOriginal,
        );
        if (
          moved.command.exitCode === 0 &&
          moved.observation.status === "moved"
        ) {
          return {
            backedUp: true,
            ...(moved.observation.identity === undefined
              ? {}
              : { backupIdentity: moved.observation.identity }),
          };
        }
        const failure =
          moved.command.stderr.trim() ||
          (moved.command.exitCode === 0
            ? "mv reported success without creating the swap backup"
            : `mv exited ${moved.command.exitCode}`);
        if (moved.observation.status === "moved") {
          const restored = await restoreBackupToSwapfile(
            backup,
            moved.observation.identity,
          );
          return {
            backedUp: false,
            detail: [failure, restored.detail]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        const activityFailure = await restoreOriginalActiveSwap();
        return {
          backedUp: false,
          detail: [
            failure,
            moved.observation.status === "unknown"
              ? moved.observation.detail
              : undefined,
            activityFailure,
            moved.observation.status === "unknown"
              ? `possible backup retained at ${backup}`
              : undefined,
          ]
            .filter((value): value is string => value !== undefined)
            .join("; "),
        };
      };
      const disableOriginalSwap = async (): Promise<
        | { readonly disabled: true }
        | { readonly disabled: false; readonly detail: string }
      > => {
        const off = await runSwapUtility(true, "swapoff", [paths.swapfile], {
          silent: true,
        });
        const observed = await readSwapActivity();
        if (
          off.exitCode === 0 &&
          observed.status === "known" &&
          !observed.active
        ) {
          return { disabled: true };
        }
        let rollbackDetail: string | undefined;
        if (observed.status === "failed" || !observed.active) {
          rollbackDetail = await restoreOriginalActiveSwap();
        }
        return {
          disabled: false,
          detail: [
            off.stderr.trim() ||
              (off.exitCode === 0
                ? "swapoff reported success but the original swap remained active"
                : `swapoff exited ${off.exitCode}`),
            observed.status === "failed"
              ? `post-swapoff verification failed: ${observed.detail}`
              : undefined,
            rollbackDetail,
          ]
            .filter((value): value is string => value !== undefined)
            .join("; "),
        };
      };
      const removeCommittedBackup = async (
        backup: string,
        expectedBackup?: SwapPathIdentity,
      ): Promise<string | undefined> => {
        let lastFailure = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (expectedBackup !== undefined) {
            const current = await inspectSwapPath(backup);
            if (current.status === "absent") return undefined;
            if (
              current.status !== "present" ||
              !sameSwapPathIdentity(current.identity, expectedBackup)
            ) {
              return `backup changed before removal at ${backup}${current.status === "failed" ? ` (${current.detail})` : ""}`;
            }
          }
          const removed = await runSwapUtility(
            true,
            "rm",
            ["-f", "--", backup],
            { silent: true },
          );
          if (removed.exitCode !== 0) {
            lastFailure =
              removed.stderr.trim() || `rm exited ${removed.exitCode}`;
          }
          const remaining = await runSwapUtility(
            false,
            "test",
            ["-e", backup],
            { silent: true },
          );
          if (remaining.exitCode === 1) return undefined;
          if (remaining.exitCode !== 0) {
            lastFailure =
              remaining.stderr.trim() ||
              `backup existence check exited ${remaining.exitCode}`;
          } else if (lastFailure === "") {
            lastFailure = "backup still exists after rm reported success";
          }
        }
        return `stale backup remains at ${backup}${lastFailure === "" ? "" : ` (${lastFailure})`}`;
      };
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
      if (isActive && !hadExistingFile) {
        return {
          status: "failed",
          detail: `active swapfile path is missing: ${paths.swapfile}`,
        };
      }
      let originalSwapIdentity: SwapPathIdentity | undefined;
      if (nativeFilesystemSemantics && hadExistingFile) {
        const original = await inspectSwapPath(paths.swapfile);
        if (original.status !== "present") {
          return {
            status: "failed",
            detail:
              original.status === "failed"
                ? original.detail
                : `existing swapfile disappeared during discovery: ${paths.swapfile}`,
          };
        }
        originalSwapIdentity = original.identity;
      }
      if (requested === 0n) {
        let backup: string | undefined;
        let backupIdentity: SwapPathIdentity | undefined;
        if (hadExistingFile) {
          const temporary = await makeBackupPath(`${paths.swapfile}.previous.`);
          if (temporary.path === undefined) {
            return { status: "failed", detail: temporary.detail };
          }
          backup = temporary.path;
        }
        if (isActive) {
          const disabled = await disableOriginalSwap();
          if (!disabled.disabled) {
            const backupCleanup =
              backup === undefined
                ? undefined
                : await removeTemporaryFile(backup);
            return {
              status: "failed",
              detail: [
                disabled.detail,
                backupCleanup === undefined
                  ? undefined
                  : `temporary backup cleanup failed: ${backupCleanup}`,
              ]
                .filter((value): value is string => Boolean(value))
                .join("; "),
            };
          }
        }
        if (backup !== undefined) {
          const backedUp = await backUpOriginalSwap(
            backup,
            originalSwapIdentity,
          );
          if (!backedUp.backedUp) {
            return {
              status: "failed",
              detail: `unable to back up existing swap: ${backedUp.detail}`,
            };
          }
          backupIdentity = backedUp.backupIdentity;
        }

        const fstabRemoved = await removeFstabEntryAtomically();
        if (fstabRemoved.exitCode !== 0) {
          const rollback: string[] = [];
          const fstabRecovery = await recoverOriginalFstab(fstabRemoved);
          if (!fstabRecovery.confirmed) {
            rollback.push(
              `fstab recovery is unconfirmed: ${fstabRecovery.detail}`,
            );
          } else if (fstabRecovery.detail !== undefined) {
            rollback.push(`fstab recovery warning: ${fstabRecovery.detail}`);
          }
          if (backup !== undefined) {
            const restored = await restoreBackupToSwapfile(
              backup,
              backupIdentity,
            );
            if (!restored.restored) rollback.push(restored.detail);
            else if (restored.detail !== undefined)
              rollback.push(`swap restore warning: ${restored.detail}`);
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
          const backupFailure = await removeCommittedBackup(
            backup,
            backupIdentity,
          );
          if (backupFailure !== undefined) {
            return {
              status: "failed",
              detail: `swap removal committed; ${backupFailure}`,
            };
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
      if (
        stat.exitCode !== 0 ||
        stat.stdoutTruncated === true ||
        !/^[0-9]+$/.test(rawAvailable)
      ) {
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
      const allocate = await runTemporaryFileUtility(
        replacement,
        true,
        "fallocate",
        ["-l", requested.toString(), replacement],
        { silent: true },
      );
      if (allocate.exitCode !== 0) {
        const mebibytes = (requested + 1024n ** 2n - 1n) / 1024n ** 2n;
        const fallback = await runTemporaryFileUtility(
          replacement,
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
          return {
            status: "failed",
            detail: await detailWithTemporaryCleanup(
              fallback.stderr.trim() || allocate.stderr.trim(),
              replacement,
            ),
          };
        }
        const truncated = await runTemporaryFileUtility(
          replacement,
          true,
          "truncate",
          ["-s", requested.toString(), replacement],
          { silent: true },
        );
        if (truncated.exitCode !== 0) {
          return {
            status: "failed",
            detail: await detailWithTemporaryCleanup(
              truncated.stderr.trim() ||
                `truncate exited ${truncated.exitCode}`,
              replacement,
            ),
          };
        }
      }
      const mode = await runTemporaryFileUtility(
        replacement,
        true,
        "chmod",
        ["600", replacement],
        { silent: true },
        { permissions: 0o600n },
      );
      if (mode.exitCode !== 0) {
        return {
          status: "failed",
          detail: await detailWithTemporaryCleanup(
            mode.stderr.trim() || `chmod exited ${mode.exitCode}`,
            replacement,
          ),
        };
      }
      const formatted = await runTemporaryFileUtility(
        replacement,
        true,
        "mkswap",
        [replacement],
        { silent: true },
      );
      if (formatted.exitCode !== 0) {
        return {
          status: "failed",
          detail: await detailWithTemporaryCleanup(
            formatted.stderr.trim() || `mkswap exited ${formatted.exitCode}`,
            replacement,
          ),
        };
      }

      let backup: string | undefined;
      let backupIdentity: SwapPathIdentity | undefined;
      if (hadExistingFile) {
        const previous = await makeBackupPath(`${paths.swapfile}.previous.`);
        if (previous.path === undefined) {
          return {
            status: "failed",
            detail: await detailWithTemporaryCleanup(
              previous.detail,
              replacement,
            ),
          };
        }
        backup = previous.path;
      }

      const rollbackReplacement = async (
        replacementIsActive: boolean,
      ): Promise<string> => {
        const details: string[] = [];
        let replacementCanBeRemoved = true;
        if (replacementIsActive) {
          const disabled = await runSwapUtility(
            true,
            "swapoff",
            [paths.swapfile],
            { silent: true },
          );
          const observed = await readSwapActivity();
          if (observed.status === "known" && !observed.active) {
            if (disabled.exitCode !== 0) {
              details.push(
                `rollback swapoff reported ${disabled.stderr.trim() || `exit ${disabled.exitCode}`} after the replacement became inactive`,
              );
            }
          } else {
            replacementCanBeRemoved = false;
            details.push(
              observed.status === "failed"
                ? `rollback swapoff verification failed: ${observed.detail}`
                : `rollback swapoff failed: ${disabled.stderr.trim() || `swapoff exited ${disabled.exitCode}`}`,
            );
          }
        }

        if (replacementCanBeRemoved) {
          for (const target of new Set([paths.swapfile, replacement])) {
            const cleanupFailure = await removeTemporaryFile(target);
            if (cleanupFailure !== undefined) {
              details.push(
                `rollback cleanup failed for ${target}: ${cleanupFailure}`,
              );
            }
          }
        }

        if (backup !== undefined) {
          if (!replacementCanBeRemoved) {
            details.push(`rollback backup retained at ${backup}`);
          } else {
            const restored = await restoreBackupToSwapfile(
              backup,
              backupIdentity,
            );
            if (!restored.restored) details.push(restored.detail);
            else if (restored.detail !== undefined)
              details.push(`rollback move warning: ${restored.detail}`);
          }
        }
        return details.join("; ");
      };

      if (isActive) {
        const disabled = await disableOriginalSwap();
        if (!disabled.disabled) {
          const details = [
            disabled.detail || "unable to disable existing swap",
            await detailWithTemporaryCleanup("", replacement),
            backup === undefined
              ? undefined
              : await detailWithTemporaryCleanup("", backup),
          ].filter((value): value is string => Boolean(value));
          return {
            status: "failed",
            detail: details.join("; "),
          };
        }
      }
      if (backup !== undefined) {
        const backedUp = await backUpOriginalSwap(backup, originalSwapIdentity);
        if (!backedUp.backedUp) {
          return {
            status: "failed",
            detail: await detailWithTemporaryCleanup(
              `unable to back up existing swap: ${backedUp.detail}`,
              replacement,
            ),
          };
        }
        backupIdentity = backedUp.backupIdentity;
      }
      const moved = await moveAndObserve(replacement, paths.swapfile);
      if (
        moved.command.exitCode !== 0 ||
        moved.observation.status !== "moved"
      ) {
        const moveFailure =
          moved.command.stderr.trim() ||
          (moved.command.exitCode === 0
            ? "mv reported success without installing the replacement"
            : `mv exited ${moved.command.exitCode}`);
        if (moved.observation.status === "unknown") {
          return {
            status: "failed",
            detail: [
              moveFailure,
              moved.observation.detail,
              `replacement staging file retained at ${replacement}`,
              backup === undefined
                ? undefined
                : `original swap backup retained at ${backup}`,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        const rollbackDetail = await rollbackReplacement(false);
        return {
          status: "failed",
          detail: [moveFailure, rollbackDetail].filter(Boolean).join("; "),
        };
      }
      const enabled = await runSwapUtility(true, "swapon", [paths.swapfile], {
        silent: true,
      });
      const replacementActivity = await readSwapActivity();
      if (
        enabled.exitCode !== 0 ||
        replacementActivity.status === "failed" ||
        !replacementActivity.active
      ) {
        const rollbackDetail = await rollbackReplacement(
          replacementActivity.status === "failed"
            ? true
            : replacementActivity.active,
        );
        return {
          status: "failed",
          detail: [
            enabled.stderr.trim() ||
              (replacementActivity.status === "failed"
                ? `replacement swap verification failed: ${replacementActivity.detail}`
                : "unable to enable replacement swap"),
            rollbackDetail,
          ]
            .filter(Boolean)
            .join("; "),
        };
      }

      const unsafe = await validateFstabMutation();
      if (unsafe !== undefined) {
        const rollbackDetail = await rollbackReplacement(true);
        return {
          status: "failed",
          detail: [unsafe, rollbackDetail].filter(Boolean).join("; "),
        };
      }
      const appended = await appendFstabEntryAtomically();
      if (appended.exitCode !== 0) {
        const fstabRecovery = await recoverOriginalFstab(appended);
        if (!fstabRecovery.confirmed) {
          return {
            status: "failed",
            detail: [
              appended.stderr.trim() || `unable to update ${paths.fstab}`,
              `fstab recovery is unconfirmed: ${fstabRecovery.detail}`,
              "replacement swap remains active and its backing file was retained",
              backup === undefined
                ? undefined
                : `original swap backup retained at ${backup}`,
            ]
              .filter((value): value is string => value !== undefined)
              .join("; "),
          };
        }
        const rollbackDetail = await rollbackReplacement(true);
        return {
          status: "failed",
          detail: [
            appended.stderr.trim() || `unable to update ${paths.fstab}`,
            fstabRecovery.detail,
            rollbackDetail,
          ]
            .filter(Boolean)
            .join("; "),
        };
      }

      if (backup !== undefined) {
        const backupFailure = await removeCommittedBackup(
          backup,
          backupIdentity,
        );
        if (backupFailure !== undefined) {
          return {
            status: "failed",
            detail: `replacement active; ${backupFailure}`,
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
        ["nginx", "/etc/nginx", ["/etc"], "Remove Nginx configuration"],
        [
          "podman",
          plan.enabled.has("buildah") ? "/var/lib/containers" : undefined,
          ["/var/lib"],
          "Remove shared Podman and Buildah storage",
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

      for (const path of await listLinuxVersionedChildren(
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
      for (const path of await listLinuxVersionedChildren(
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
      for (const path of await listLinuxVersionedChildren(
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
      for (const path of await listLinuxVersionedChildren(
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
      for (const path of await listLinuxVersionedChildren(
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
        createLinuxAptBatchOperation(context, plan, () => {
          aptDirty = true;
        }),
      );
      operations.push(createLinuxAptFinalizeOperation(context, () => aptDirty));

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
      const commandOperations: Operation[] = [];
      for (const [component, names] of Object.entries(commands) as [
        ComponentId,
        readonly string[],
      ][]) {
        // Do not inspect or validate unrelated PATH entries. Besides making
        // custom cleanup cheaper, this prevents a protected runtime-owned
        // executable for a disabled component from blocking the active plan.
        if (!plan.enabled.has(component)) continue;
        for (const name of names) {
          commandOperations.push(...commandRemovals(context, component, name));
        }
      }
      operations.push(...commandOperations);

      operations.push(createLinuxDockerPruneOperation(context));
      add(createLinuxToolCacheRecreateOperation(context, cache));
      if (plan.swapfileBytes !== undefined) {
        operations.push(createSwapOperation(context, plan.swapfileBytes));
      }
      return operations;
    },
  };
}
