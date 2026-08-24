import { randomBytes } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { access, lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import {
  assertCommandTerminationConfirmed,
  inspectExecutable,
  runCommand,
  sameCommandFileIdentity,
  trustedUnixCommandEnvironment,
  TRUSTED_UNIX_PATH,
  UnconfirmedCommandTerminationError,
  type CommandFileIdentity,
} from "../command.js";
import { COMPONENTS } from "../components.js";
import {
  createFunctionOperation,
  createRemovePathOperation,
} from "../operations.js";
import { assertSafeDirectoryTarget } from "../safety.js";
import { listBoundedVersionedDirectoryEntries } from "../versioned-directories.js";
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

const APPLICATIONS_ROOT = "/Applications";
const LOCAL_ROOT = "/usr/local";
const LOCAL_BIN = `${LOCAL_ROOT}/bin`;
const LOCAL_SHARE = `${LOCAL_ROOT}/share`;
const MACOS_RUNNER_HOME = "/Users/runner";
const MACOS_BREW_TEMP = "/private/tmp";
const MACOS_BREW_CONFIG_PREFIX = `${MACOS_BREW_TEMP}/maximize-github-runner-space-homebrew-`;
const MACOS_BREW_CONFIG_TOKEN_BYTES = 16;
const MACOS_BREW_CONFIG_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MACOS_SUDO = "/usr/bin/sudo";
const MACOS_MKDIR = "/bin/mkdir";
const MACOS_RMDIR = "/bin/rmdir";
const MAX_MACOS_DIRECTORY_INSPECTIONS = 256;

const SUPPORTED = new Set<ComponentId>(
  COMPONENTS.filter((component) =>
    component.platforms.some((platform) => platform === "macos"),
  ).map((component) => component.id),
);

type BrewPackageKind = "formula" | "cask";

interface BrewPackageDefinition {
  readonly kind: BrewPackageKind;
  readonly aliases: readonly string[];
  readonly tap?: string;
  readonly components: readonly ComponentId[];
  readonly description: string;
}

// These names come from the macOS runner-image toolsets and installation
// scripts. Aliases are alternatives (for example, versioned PHP formulae), not
// shell patterns.
const BREW_PACKAGES = [
  {
    kind: "cask",
    aliases: ["google-chrome"],
    components: ["chrome", "browsers"],
    description: "Remove Google Chrome with Homebrew",
  },
  {
    kind: "cask",
    aliases: ["microsoft-edge"],
    components: ["edge", "browsers"],
    description: "Remove Microsoft Edge with Homebrew",
  },
  {
    kind: "cask",
    aliases: ["firefox"],
    components: ["firefox", "browsers"],
    description: "Remove Firefox with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["geckodriver"],
    components: ["webdrivers", "browsers"],
    description: "Remove GeckoDriver with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["selenium-server"],
    components: ["selenium", "browsers"],
    description: "Remove Selenium Server with Homebrew",
  },
  {
    kind: "cask",
    aliases: ["session-manager-plugin"],
    components: ["aws-cli"],
    description: "Remove AWS Session Manager plugin with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["aws-sam-cli"],
    tap: "aws/tap",
    components: ["aws-sam-cli"],
    description: "Remove AWS SAM CLI with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["azure-cli"],
    components: ["azure-cli"],
    description: "Remove Azure CLI with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["gh"],
    components: ["gh-cli"],
    description: "Remove GitHub CLI with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["kubectl"],
    components: ["kubectl"],
    description: "Remove kubectl with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["helm"],
    components: ["helm"],
    description: "Remove Helm with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["kind"],
    components: ["kind"],
    description: "Remove kind with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["maven"],
    components: ["maven"],
    description: "Remove Maven with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["gradle"],
    components: ["gradle"],
    description: "Remove Gradle with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["ant"],
    components: ["ant"],
    description: "Remove Ant with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["php", "php@8.5"],
    components: ["php"],
    description: "Remove PHP with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["composer"],
    components: ["php"],
    description: "Remove Composer with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["rustup"],
    components: ["rust"],
    description: "Remove Rustup with Homebrew",
  },
  {
    kind: "formula",
    aliases: ["nginx"],
    components: ["nginx"],
    description: "Remove Nginx with Homebrew",
  },
] as const satisfies readonly BrewPackageDefinition[];

// Exact union of the common Homebrew payload declared by the current official
// macOS 14, 15, and 26 runner-image toolsets. Default-tap matching below keeps
// workflow-installed packages and basename collisions outside this ownership.
const RUNNER_IMAGE_COMMON_BREW_FORMULAE = [
  "ant",
  "aria2",
  "azure-cli",
  "bazelisk",
  "carthage",
  "cmake",
  "gh",
  "gnupg",
  "gnu-tar",
  "kotlin",
  "libpq",
  "libsodium",
  "openssl",
  "p7zip",
  "packer",
  "perl",
  "pkgconf",
  "swiftformat",
  "tcl-tk@8",
  "zstd",
  "ninja",
  "gmp",
  "yq",
  "unxip",
  "xcbeautify",
  "xcodes",
] as const;

const RUNNER_IMAGE_COMMON_BREW_CASKS = ["parallels"] as const;

function commonBrewPackageDefinition(
  kind: BrewPackageKind,
  alias: string,
): BrewPackageDefinition {
  const dedicated = BREW_PACKAGES.find(
    (definition) =>
      definition.kind === kind &&
      (definition.aliases as readonly string[]).includes(alias),
  );
  return {
    kind,
    aliases:
      kind === "formula" && alias === "openssl"
        ? ["openssl", "openssl@3"]
        : [alias],
    components: dedicated?.components ?? [],
    description: `Remove runner-image Homebrew ${alias}`,
  };
}

const DEFINITION_BREW_PACKAGES: readonly BrewPackageDefinition[] = [
  ...BREW_PACKAGES,
  ...RUNNER_IMAGE_COMMON_BREW_FORMULAE.map((alias) =>
    commonBrewPackageDefinition("formula", alias),
  ),
  ...RUNNER_IMAGE_COMMON_BREW_CASKS.map((alias) =>
    commonBrewPackageDefinition("cask", alias),
  ),
];

// Broad Homebrew cleanup must yield to every component whose installation it
// could otherwise remove. This is deliberately wider than the common-package
// list because browsers and AWS tools are installed as casks/tapped formulae.
const BREW_OWNER_COMPONENTS = [
  ...new Set<ComponentId>(
    BREW_PACKAGES.flatMap((definition) => definition.components),
  ),
] as const;

interface BrewInventory {
  readonly formulae: Set<string>;
  readonly casks: Set<string>;
}

interface BrewState {
  readonly inventory: () => Promise<BrewInventory>;
  readonly refresh: () => Promise<BrewInventory>;
}

interface BrewExecutionOptions {
  readonly silent: boolean;
  readonly timeoutMs: number;
}

type BrewEnvironmentProvider = () => NodeJS.ProcessEnv;

export type MacOSBrewRunner = (
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: BrewExecutionOptions,
) => Promise<CommandResult>;

export interface MacOSAdapterDependencies {
  readonly resolveBrewExecutable?: (
    architecture: Architecture,
  ) => Promise<string | undefined>;
  readonly executeBrew?: MacOSBrewRunner;
  readonly inspectBrewExecutable?: (
    executable: string,
  ) => Promise<CommandFileIdentity | undefined>;
  readonly inspectBrewSystemExecutable?: (
    executable: string,
  ) => Promise<CommandFileIdentity | undefined>;
  readonly inspectBrewConfig?: BrewConfigProbe;
  /** Return an uncreated candidate; native code performs the atomic mkdir. */
  readonly createBrewConfigRoot?: BrewConfigRootCandidateFactory;
  readonly runBrewConfigSystemUtility?: BrewConfigSystemUtilityRunner;
  readonly removeBrewConfigRoot?: BrewConfigRootRemover;
  readonly validateBrewConfigRoot?: BrewConfigRootValidator;
  readonly readJavaDirectory?: MacOSDirectoryReader;
  readonly createToolCacheDirectory?: (target: string) => Promise<void>;
  readonly accessToolCacheDirectory?: (
    target: string,
    mode: number,
  ) => Promise<void>;
  readonly runXcodeSelect?: () => Promise<CommandResult>;
  readonly readXcodeApplications?: () => Promise<
    readonly MacOSXcodeDirectoryEntry[]
  >;
  readonly resolveXcodePath?: (path: string) => Promise<string | undefined>;
  readonly inspectXcodeBundleIdentity?: MacOSXcodeBundleIdentityInspector;
  readonly validateXcodeTarget?: (target: string) => Promise<void>;
  readonly removeXcodeTarget?: (target: string) => Promise<OperationResult>;
}

export interface MacOSDirectoryEntry {
  readonly name: string;
  isSymbolicLink(): boolean;
}

export type MacOSDirectoryReader = (
  path: string,
) => Promise<readonly MacOSDirectoryEntry[]>;

export interface MacOSXcodeDirectoryEntry extends MacOSDirectoryEntry {
  isDirectory(): boolean;
}

async function readBoundedMacOSDirectory(
  path: string,
  description: string,
): Promise<readonly Dirent[]> {
  const entries = await listBoundedVersionedDirectoryEntries(
    normalize(path),
    /(?:)/,
    "posix",
    description,
    MAX_MACOS_DIRECTORY_INSPECTIONS,
  );
  return entries.map(
    ({ name, directory, symbolicLink }) =>
      ({
        name,
        isDirectory: () => directory,
        isSymbolicLink: () => symbolicLink,
      }) as Dirent,
  );
}

function boundedMacOSDirectoryEntries<T extends MacOSDirectoryEntry>(
  entries: readonly T[],
  description: string,
): readonly T[] {
  if (entries.length > MAX_MACOS_DIRECTORY_INSPECTIONS) {
    throw new Error(
      `${description} exceeded ${MAX_MACOS_DIRECTORY_INSPECTIONS} inspected entries`,
    );
  }
  return [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export interface MacOSXcodeBundleIdentity {
  readonly kind: "directory" | "symbolic-link";
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly userId: bigint;
  readonly groupId: bigint;
  readonly linkCount: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
}

export type MacOSXcodeBundleIdentityInspector = (
  path: string,
) => Promise<MacOSXcodeBundleIdentity | undefined>;

export type BrewConfigRootCandidateFactory = (
  prefix: string,
) => Promise<string>;
export type BrewConfigSystemUtilityRunner = (
  executable: string,
  args: readonly string[],
  description: string,
) => Promise<void>;
export type BrewConfigRootRemover = (path: string) => Promise<void>;
export type BrewConfigRootValidator = (
  path: string,
  requireEmpty: boolean,
) => Promise<void>;

export interface BrewConfigRootStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface BrewConfigRootProbe {
  lstat(path: string): Promise<BrewConfigRootStats>;
  readdir(path: string): Promise<readonly string[]>;
}

interface BrewPathStats {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface BrewPathProbe {
  lstat(path: string): Promise<BrewPathStats>;
  realpath(path: string): Promise<string>;
  access(path: string, mode: number): Promise<void>;
}

interface BrewDefinition {
  readonly candidate: string;
  readonly candidateKind: "file" | "symlink";
  readonly executable: string;
}

const BREW_DEFINITIONS: Readonly<Record<Architecture, BrewDefinition>> = {
  arm64: {
    candidate: "/opt/homebrew/bin/brew",
    candidateKind: "file",
    executable: "/opt/homebrew/bin/brew",
  },
  x64: {
    candidate: "/usr/local/bin/brew",
    candidateKind: "symlink",
    executable: "/usr/local/Homebrew/bin/brew",
  },
};

const NODE_BREW_PATH_PROBE: BrewPathProbe = {
  lstat: async (path) => await lstat(path),
  realpath: async (path) => await realpath(path),
  access: async (path, mode) => await access(path, mode),
};

const BREW_CONFIG_FILES: Readonly<Record<Architecture, readonly string[]>> = {
  arm64: ["/etc/homebrew/brew.env", "/opt/homebrew/etc/homebrew/brew.env"],
  x64: ["/etc/homebrew/brew.env", "/usr/local/etc/homebrew/brew.env"],
};

export type BrewConfigProbe = (
  path: string,
) => Promise<BrewPathStats | undefined>;

const NODE_BREW_CONFIG_PROBE: BrewConfigProbe = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

// Select a high-entropy candidate without creating it as the runner user. A
// fixed root-owned mkdir below is the only operation allowed to create it.
const NODE_BREW_CONFIG_ROOT_CANDIDATE: BrewConfigRootCandidateFactory = async (
  prefix,
) => `${prefix}${randomBytes(MACOS_BREW_CONFIG_TOKEN_BYTES).toString("hex")}`;

const NODE_BREW_CONFIG_ROOT_PROBE: BrewConfigRootProbe = {
  lstat: async (path) => await lstat(path),
  readdir: async (path) => {
    const directory = await opendir(path);
    try {
      const entry = await directory.read();
      return entry === null ? [] : [entry.name];
    } finally {
      await directory.close().catch(() => undefined);
    }
  },
};

export async function validateDefinitionBrewConfigRoot(
  path: string,
  requireEmpty: boolean,
  probe: BrewConfigRootProbe = NODE_BREW_CONFIG_ROOT_PROBE,
): Promise<void> {
  checkedBrewConfigRoot(path);
  const stat = await probe.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Refusing non-directory Homebrew configuration target '${path}'.`,
    );
  }
  if (stat.uid !== 0 || stat.gid !== 0) {
    throw new Error(
      `Refusing unprotected Homebrew configuration directory ownership '${path}'.`,
    );
  }
  if ((stat.mode & 0o777) !== 0o555) {
    throw new Error(
      `Refusing writable Homebrew configuration directory permissions '${path}'.`,
    );
  }
  if (requireEmpty && (await probe.readdir(path)).length !== 0) {
    throw new Error(
      `Refusing non-empty Homebrew configuration directory '${path}'.`,
    );
  }
}

function assertTrustedMacOSSystemExecutable(
  executable: string,
  identity: CommandFileIdentity | undefined,
): asserts identity is CommandFileIdentity {
  if (
    identity === undefined ||
    identity.userId !== 0n ||
    identity.mode === undefined ||
    (identity.mode & 0o170000n) !== 0o100000n ||
    (identity.mode & 0o022n) !== 0n
  ) {
    throw new Error(
      `Refusing untrusted macOS system executable '${executable}'.`,
    );
  }
}

async function runPrivilegedMacOSSystemUtility(
  context: RuntimeContext,
  executable: string,
  args: readonly string[],
  description: string,
): Promise<void> {
  const [sudoBefore, executableBefore] = await Promise.all([
    inspectExecutable(MACOS_SUDO),
    inspectExecutable(executable),
  ]);
  assertTrustedMacOSSystemExecutable(MACOS_SUDO, sudoBefore);
  assertTrustedMacOSSystemExecutable(executable, executableBefore);
  const result = await runCommand(
    MACOS_SUDO,
    ["-n", "--", executable, ...args],
    {
      env: trustedUnixCommandEnvironment(context),
      silent: true,
      timeoutMs: 10_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `${description} exited ${result.exitCode}`,
    );
  }
  const [sudoAfter, executableAfter] = await Promise.all([
    inspectExecutable(MACOS_SUDO),
    inspectExecutable(executable),
  ]);
  if (
    !sameCommandFileIdentity(sudoBefore, sudoAfter) ||
    !sameCommandFileIdentity(executableBefore, executableAfter)
  ) {
    throw new Error(`A trusted executable changed during ${description}.`);
  }
}

function checkedBrewConfigRoot(path: string): string {
  const normalized = normalize(path);
  const token = normalized.slice(MACOS_BREW_CONFIG_PREFIX.length);
  if (
    dirname(normalized) !== MACOS_BREW_TEMP ||
    !normalized.startsWith(MACOS_BREW_CONFIG_PREFIX) ||
    !MACOS_BREW_CONFIG_TOKEN_PATTERN.test(token)
  ) {
    throw new Error(
      `Refusing unexpected Homebrew configuration directory '${path}'.`,
    );
  }
  return normalized;
}

async function findBrewConfig(
  architecture: Architecture,
  probe: BrewConfigProbe,
): Promise<string | undefined> {
  for (const path of BREW_CONFIG_FILES[architecture]) {
    if ((await probe(path)) !== undefined) return path;
  }
  return undefined;
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
    isAbsolute(value) &&
    allowed.some((candidate) => normalize(value) === normalize(candidate))
  ) {
    return normalize(value);
  }
  return normalize(fallback);
}

function removeOperation(
  context: RuntimeContext,
  component: ComponentId,
  target: string | undefined,
  allowedParents: readonly string[],
  description: string,
): Operation | undefined {
  if (target === undefined || target.trim() === "") return undefined;
  return createRemovePathOperation({
    id: `${component}:${target}`,
    component,
    description,
    target,
    allowedParents,
    context,
  });
}

export async function resolveDefinitionBrewExecutable(
  architecture: Architecture,
  probe: BrewPathProbe = NODE_BREW_PATH_PROBE,
): Promise<string | undefined> {
  const definition = BREW_DEFINITIONS[architecture];
  try {
    // The official installer creates an architecture-specific regular file on
    // Apple Silicon and a fixed link on Intel. Resolve that definition path
    // without executing anything and require its exact target; an executable
    // found on workflow-controlled PATH is never considered.
    const candidate = await probe.lstat(definition.candidate);
    const candidateMatchesDefinition =
      definition.candidateKind === "symlink"
        ? candidate.isSymbolicLink()
        : candidate.isFile() && !candidate.isSymbolicLink();
    if (!candidateMatchesDefinition) return undefined;

    const resolved = normalize(await probe.realpath(definition.candidate));
    if (resolved !== normalize(definition.executable)) return undefined;

    // Execute the resolved repository file instead of traversing the link
    // again after verification. The definition target itself must not be a
    // link and must be an executable regular file.
    if (definition.executable !== definition.candidate) {
      const executable = await probe.lstat(definition.executable);
      if (executable.isSymbolicLink() || !executable.isFile()) return undefined;
    }
    await probe.access(definition.executable, constants.X_OK);
    return definition.executable;
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
  }
}

const NODE_MACOS_BREW_RUNNER: MacOSBrewRunner = async (
  executable,
  args,
  environment,
  options,
) =>
  await runCommand(executable, args, {
    env: environment,
    silent: options.silent,
    timeoutMs: options.timeoutMs,
  });

function brewEnvironment(configRoot: string | undefined): NodeJS.ProcessEnv {
  if (configRoot === undefined) {
    throw new Error(
      "Homebrew environment was requested before its fatal preflight completed.",
    );
  }
  return {
    CI: "1",
    HOME: MACOS_RUNNER_HOME,
    LANG: "en_US.UTF-8",
    LOGNAME: "runner",
    PATH: TRUSTED_UNIX_PATH,
    SHELL: "/bin/bash",
    TERM: "dumb",
    TMPDIR: MACOS_BREW_TEMP,
    USER: "runner",
    // Homebrew otherwise derives `$XDG_CONFIG_HOME/homebrew` and tries to
    // create that child directory. The isolated root is already created and
    // protected by the root-owned preflight, so pin the exact config path.
    HOMEBREW_CONFIG_HOME: configRoot,
    // Homebrew otherwise loads a workflow-created ~/.homebrew/brew.env. Its
    // bin/brew bootstrap also consults PATH and several HOMEBREW_* executable
    // overrides before it filters the environment, so pass an allowlist rather
    // than inheriting arbitrary workflow state.
    XDG_CONFIG_HOME: configRoot,
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_AUTOREMOVE: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
  };
}

function parseBrewInventory(output: string, label: string): Set<string> {
  const values = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length > 4096) {
    throw new Error(`Refusing unexpectedly large Homebrew ${label} inventory.`);
  }

  const safeName = /^[A-Za-z0-9][A-Za-z0-9@+._/-]{0,255}$/;
  for (const value of values) {
    if (!safeName.test(value) || value.includes("//")) {
      throw new Error(`Refusing unexpected Homebrew ${label} name '${value}'.`);
    }
  }
  return new Set(values);
}

function createBrewState(
  executable: () => string | undefined,
  execute: MacOSBrewRunner,
  environment: BrewEnvironmentProvider,
): BrewState {
  let pending: Promise<BrewInventory> | undefined;
  const readInventory = async (): Promise<BrewInventory> => {
    const currentExecutable = executable();
    if (currentExecutable === undefined) {
      return { formulae: new Set<string>(), casks: new Set<string>() };
    }

    const formulae = await execute(
      currentExecutable,
      ["list", "--formula", "--full-name"],
      environment(),
      { silent: true, timeoutMs: 60_000 },
    );
    if (
      formulae.stdoutTruncated === true ||
      formulae.stderrTruncated === true
    ) {
      throw new Error(
        "Homebrew formula inventory exceeded the safe output bound",
      );
    }
    if (formulae.exitCode !== 0) {
      throw new Error(
        formulae.stderr.trim() ||
          `brew formula inventory exited ${formulae.exitCode}`,
      );
    }

    const casks = await execute(
      currentExecutable,
      ["list", "--cask", "--full-name"],
      environment(),
      { silent: true, timeoutMs: 60_000 },
    );
    if (casks.stdoutTruncated === true || casks.stderrTruncated === true) {
      throw new Error("Homebrew cask inventory exceeded the safe output bound");
    }
    if (casks.exitCode !== 0) {
      throw new Error(
        casks.stderr.trim() || `brew cask inventory exited ${casks.exitCode}`,
      );
    }

    return {
      formulae: parseBrewInventory(formulae.stdout, "formula"),
      casks: parseBrewInventory(casks.stdout, "cask"),
    };
  };
  return {
    inventory: () => {
      pending ??= readInventory();
      return pending;
    },
    refresh: async () => {
      const current = await readInventory();
      pending = Promise.resolve(current);
      return current;
    },
  };
}

function installedPackageMatches(
  installed: string,
  definition: BrewPackageDefinition,
): boolean {
  const tap =
    definition.tap ??
    (definition.kind === "formula" ? "homebrew/core" : "homebrew/cask");
  return definition.aliases.some(
    (alias) => installed === alias || installed === `${tap}/${alias}`,
  );
}

function inventoryForKind(
  inventory: BrewInventory,
  kind: BrewPackageKind,
): Set<string> {
  return kind === "formula" ? inventory.formulae : inventory.casks;
}

function matchingInstalledPackages(
  inventory: BrewInventory,
  definition: BrewPackageDefinition,
): string[] {
  return [...inventoryForKind(inventory, definition.kind)].filter((name) =>
    installedPackageMatches(name, definition),
  );
}

function brewPackageOperation(
  executable: string | undefined,
  state: BrewState,
  definition: BrewPackageDefinition,
  component: ComponentId,
  execute: MacOSBrewRunner,
  environment: BrewEnvironmentProvider,
): Operation {
  return createFunctionOperation({
    id: `brew:${definition.kind}:${definition.aliases.join("|")}:${component}`,
    component,
    description: definition.description,
    phase: "package",
    dedupeKey: `brew:${definition.kind}:${definition.aliases.join("|")}`,
    run: async (): Promise<OperationResult> => {
      if (executable === undefined) return { status: "not-found" };

      let inventory: BrewInventory;
      try {
        inventory = await state.inventory();
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      const matches = matchingInstalledPackages(inventory, definition);
      if (matches.length === 0) return { status: "not-found" };

      const args = [
        "uninstall",
        `--${definition.kind}`,
        "--force",
        ...(definition.kind === "formula" ? ["--ignore-dependencies"] : []),
        ...matches,
      ];
      const result = await execute(executable, args, environment(), {
        silent: false,
        timeoutMs: 10 * 60_000,
      });
      if (result.exitCode !== 0) {
        return {
          status: "failed",
          detail:
            result.stderr.trim() || `brew uninstall exited ${result.exitCode}`,
        };
      }

      let current: BrewInventory;
      try {
        current = await state.refresh();
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      const remaining = matchingInstalledPackages(current, definition);
      if (remaining.length !== 0) {
        return {
          status: "failed",
          detail: `${remaining.join(", ")} remained installed after Homebrew reported success`,
        };
      }
      return { status: "removed", detail: matches.join(", ") };
    },
  });
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function definitionListedPackages(
  inventory: BrewInventory,
  kind: BrewPackageKind,
  skipped: ReadonlySet<ComponentId>,
): string[] {
  const selected = new Set<string>();
  for (const definition of DEFINITION_BREW_PACKAGES) {
    if (definition.kind !== kind) continue;
    if (definition.components.some((component) => skipped.has(component))) {
      continue;
    }
    for (const name of matchingInstalledPackages(inventory, definition)) {
      selected.add(name);
    }
  }
  return [...selected];
}

function removeDefinitionHomebrewPackagesOperation(
  executable: string | undefined,
  state: BrewState,
  execute: MacOSBrewRunner,
  environment: BrewEnvironmentProvider,
  skipped: ReadonlySet<ComponentId>,
): Operation {
  return createFunctionOperation({
    id: "brew:definition-packages",
    component: "homebrew",
    description: "Uninstall definition-listed Homebrew formulae and casks",
    phase: "package",
    dedupeKey: "brew:definition-packages",
    run: async (): Promise<OperationResult> => {
      if (executable === undefined) return { status: "not-found" };

      let inventory: BrewInventory;
      try {
        inventory = await state.inventory();
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      const work: readonly [BrewPackageKind, readonly string[]][] = [
        ["cask", definitionListedPackages(inventory, "cask", skipped)],
        ["formula", definitionListedPackages(inventory, "formula", skipped)],
      ];
      let removed = 0;

      // A fixed chunk size bounds argv while avoiding one expensive Homebrew
      // startup per package. Only finite runner-definition identities are
      // selected; unknown workflow-installed packages remain outside our
      // ownership. Casks go first so listed formulae can follow.
      for (const [kind, selected] of work) {
        for (const batch of chunks(selected, 24)) {
          const result = await execute(
            executable,
            [
              "uninstall",
              `--${kind}`,
              "--force",
              ...(kind === "formula" ? ["--ignore-dependencies"] : []),
              ...batch,
            ],
            environment(),
            { silent: false, timeoutMs: 15 * 60_000 },
          );
          if (result.exitCode !== 0) {
            return {
              status: "failed",
              detail: (
                result.stderr.trim() ||
                `brew ${kind} uninstall exited ${result.exitCode}`
              ).slice(0, 2000),
            };
          }
          let current: BrewInventory;
          try {
            current = await state.refresh();
          } catch (error) {
            return {
              status: "failed",
              detail: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 2000),
            };
          }
          const remaining = batch.filter((name) =>
            DEFINITION_BREW_PACKAGES.some(
              (definition) =>
                definition.kind === kind &&
                !definition.components.some((component) =>
                  skipped.has(component),
                ) &&
                installedPackageMatches(name, definition) &&
                matchingInstalledPackages(current, definition).length > 0,
            ),
          );
          if (remaining.length !== 0) {
            return {
              status: "failed",
              detail:
                `${remaining.join(", ")} remained installed after Homebrew reported success`.slice(
                  0,
                  2000,
                ),
            };
          }
          removed += batch.length;
        }
      }

      return removed === 0
        ? { status: "not-found" }
        : {
            status: "removed",
            detail: `${removed} definition-listed Homebrew packages`,
          };
    },
  });
}

function brewCleanupOperation(
  executable: string | undefined,
  component: ComponentId,
  execute: MacOSBrewRunner,
  environment: BrewEnvironmentProvider,
  releaseEnvironment: () => Promise<void>,
): Operation {
  return createFunctionOperation({
    id: `brew:cleanup:${component}`,
    component,
    description: "Clean stale Homebrew versions and cached downloads",
    phase: "package",
    dedupeKey: "brew:cleanup",
    run: async (): Promise<OperationResult> => {
      if (executable === undefined) return { status: "not-found" };

      // Explicit autoremove can claim an otherwise unknown package installed by
      // the workflow. Native cleanup keeps current formulae and casks installed
      // while reclaiming old versions and downloads.
      const failures: string[] = [];
      try {
        const cleanup = await execute(
          executable,
          ["cleanup", "--prune=all", "-s"],
          environment(),
          {
            silent: false,
            timeoutMs: 10 * 60_000,
          },
        );
        if (cleanup.exitCode !== 0) {
          failures.push(
            cleanup.stderr.trim() || `brew cleanup exited ${cleanup.exitCode}`,
          );
        }
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        failures.push(error instanceof Error ? error.message : String(error));
      }

      try {
        assertCommandTerminationConfirmed();
        await releaseEnvironment();
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        failures.push(
          `Unable to remove isolated Homebrew configuration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (failures.length > 0) {
        return {
          status: "failed",
          detail: failures.join("; ").slice(0, 2000),
        };
      }
      return { status: "removed" };
    },
  });
}

function brewConfigurationReleaseOperation(
  executable: string | undefined,
  component: ComponentId,
  releaseEnvironment: () => Promise<void>,
): Operation {
  return createFunctionOperation({
    id: `brew:configuration-release:${component}`,
    component,
    description: "Release isolated Homebrew configuration",
    phase: "package",
    dedupeKey: "brew:configuration-release",
    run: async (): Promise<OperationResult> => {
      if (executable === undefined) return { status: "not-found" };

      try {
        assertCommandTerminationConfirmed();
        await releaseEnvironment();
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        return {
          status: "failed",
          detail: `Unable to remove isolated Homebrew configuration: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 2000),
        };
      }
      return { status: "removed" };
    },
  });
}

function recreateToolCacheOperation(
  context: RuntimeContext,
  target: string,
  createDirectory: (target: string) => Promise<void> = async (path) => {
    await mkdir(path, { recursive: true });
  },
  accessDirectory: (target: string, mode: number) => Promise<void> = async (
    path,
    mode,
  ) => await access(path, mode),
): Operation {
  const validate = async (): Promise<void> =>
    await assertSafeDirectoryTarget(target, [dirname(target)], context);
  return createFunctionOperation({
    id: "macos:toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    fatal: true,
    validate,
    run: async () => {
      try {
        await validate();
        await createDirectory(target);
        await validate();
        await accessDirectory(target, constants.W_OK | constants.X_OK);
        await validate();
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

function xcodeFailureOperation(detail: string): Operation {
  return createFunctionOperation({
    id: "xcode:inventory",
    component: "xcode",
    description: "Discover removable Xcode bundles",
    phase: "filesystem",
    validate: async () => {
      throw new Error(detail);
    },
    run: async () => ({ status: "failed", detail }),
  });
}

function xcodeBundleFromPath(value: string): string | undefined {
  const normalized = normalize(value);
  const prefix = `${APPLICATIONS_ROOT}${sep}`;
  if (!normalized.startsWith(prefix)) return undefined;

  const firstComponent = normalized.slice(prefix.length).split(sep)[0];
  if (
    firstComponent === undefined ||
    !/^Xcode(?:_[0-9][A-Za-z0-9._-]{0,63})?\.app$/.test(firstComponent)
  ) {
    return undefined;
  }
  return join(APPLICATIONS_ROOT, firstComponent);
}

export async function resolveMacOSDefinitionPath(
  value: string,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<string | undefined> {
  try {
    return normalize(await resolve(value));
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
  }
}

interface XcodeSelectionSnapshot {
  readonly selectedDeveloper: string;
  readonly preservedBundles: readonly XcodeBundleSnapshot[];
}

interface XcodeBundleSnapshot {
  readonly path: string;
  readonly identity: MacOSXcodeBundleIdentity | undefined;
}

function sameXcodeBundleIdentity(
  left: MacOSXcodeBundleIdentity,
  right: MacOSXcodeBundleIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.userId === right.userId &&
    left.groupId === right.groupId &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

function sameOptionalXcodeBundleIdentity(
  left: MacOSXcodeBundleIdentity | undefined,
  right: MacOSXcodeBundleIdentity | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameXcodeBundleIdentity(left, right);
}

function xcodeSelectionDifference(
  left: XcodeSelectionSnapshot,
  right: XcodeSelectionSnapshot,
): "Xcode selection changed" | "Xcode bundle identity changed" | undefined {
  if (
    left.selectedDeveloper !== right.selectedDeveloper ||
    left.preservedBundles.length !== right.preservedBundles.length ||
    !left.preservedBundles.every(
      (bundle, index) => bundle.path === right.preservedBundles[index]?.path,
    )
  ) {
    return "Xcode selection changed";
  }
  return left.preservedBundles.every((bundle, index) =>
    sameOptionalXcodeBundleIdentity(
      bundle.identity,
      right.preservedBundles[index]?.identity,
    ),
  )
    ? undefined
    : "Xcode bundle identity changed";
}

export async function inspectMacOSXcodeBundleIdentity(
  path: string,
): Promise<MacOSXcodeBundleIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isSymbolicLink()
        ? "symbolic-link"
        : undefined;
    if (kind === undefined) {
      throw new Error(`Refusing non-bundle Xcode target '${path}'.`);
    }
    return {
      kind,
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      userId: stats.uid,
      groupId: stats.gid,
      linkCount: stats.nlink,
      size: stats.size,
      modifiedNanoseconds: stats.mtimeNs,
      changedNanoseconds: stats.ctimeNs,
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
  }
}

async function inspectXcodeSelection(
  runXcodeSelect: () => Promise<CommandResult>,
  resolveXcodePath: (path: string) => Promise<string | undefined>,
  inspectXcodeBundleIdentity: MacOSXcodeBundleIdentityInspector,
  requireExistingBundles = false,
): Promise<XcodeSelectionSnapshot> {
  const selected = await runXcodeSelect();
  const selectedDeveloper = selected.stdout.trim();
  if (
    selected.exitCode !== 0 ||
    selectedDeveloper === "" ||
    selectedDeveloper.length > 1024 ||
    !isAbsolute(selectedDeveloper)
  ) {
    throw new Error(
      "Unable to identify the xcode-select developer directory; no Xcode bundle was removed.",
    );
  }

  const preserved = new Set<string>([join(APPLICATIONS_ROOT, "Xcode.app")]);
  const required = new Set<string>();
  const selectedBundle = xcodeBundleFromPath(selectedDeveloper);
  if (selectedBundle !== undefined) {
    const normalized = normalize(selectedBundle);
    preserved.add(normalized);
    required.add(normalized);
  }

  // Preserve both the selected spelling and its real bundle. Xcode.app is a
  // runner-image convenience symlink; preserving its target avoids leaving it
  // dangling when xcode-select points at CommandLineTools instead.
  for (const path of [
    selectedDeveloper,
    selectedBundle,
    "/Applications/Xcode.app",
  ]) {
    if (path === undefined) continue;
    const resolved = await resolveXcodePath(path);
    if (resolved === undefined) continue;
    const pathBundle = xcodeBundleFromPath(path);
    if (pathBundle !== undefined) required.add(normalize(pathBundle));
    const bundle = xcodeBundleFromPath(resolved);
    if (bundle !== undefined) {
      const normalized = normalize(bundle);
      preserved.add(normalized);
      required.add(normalized);
    }
  }
  const preservedBundles = await Promise.all(
    [...preserved].sort().map(async (path) => ({
      path,
      identity: await inspectXcodeBundleIdentity(path),
    })),
  );
  for (const bundle of preservedBundles) {
    if (
      requireExistingBundles &&
      required.has(bundle.path) &&
      bundle.identity === undefined
    ) {
      throw new Error(
        `Required preserved Xcode bundle '${bundle.path}' is missing.`,
      );
    }
  }
  return {
    selectedDeveloper,
    preservedBundles,
  };
}

async function xcodeOperations(
  context: RuntimeContext,
  dependencies: MacOSAdapterDependencies,
): Promise<readonly Operation[]> {
  const runXcodeSelect =
    dependencies.runXcodeSelect ??
    (async () =>
      await runCommand("/usr/bin/xcode-select", ["--print-path"], {
        env: trustedUnixCommandEnvironment(context),
        silent: true,
        timeoutMs: 10_000,
      }));
  const resolveXcodePath =
    dependencies.resolveXcodePath ??
    (async (path: string) => await resolveMacOSDefinitionPath(path));
  const inspectXcodeBundleIdentity =
    dependencies.inspectXcodeBundleIdentity ?? inspectMacOSXcodeBundleIdentity;
  const readXcodeApplications =
    dependencies.readXcodeApplications ??
    (async () =>
      await readBoundedMacOSDirectory(
        APPLICATIONS_ROOT,
        "Xcode application inventory",
      ));

  let discoveredSelection: XcodeSelectionSnapshot;
  try {
    discoveredSelection = await inspectXcodeSelection(
      runXcodeSelect,
      resolveXcodePath,
      inspectXcodeBundleIdentity,
      true,
    );
  } catch (error) {
    return [
      xcodeFailureOperation(
        `xcode-select is unavailable or unsafe; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  let entries: readonly MacOSXcodeDirectoryEntry[];
  try {
    entries = boundedMacOSDirectoryEntries(
      await readXcodeApplications(),
      "Xcode application inventory",
    );
  } catch (error) {
    return [
      xcodeFailureOperation(
        `Unable to inspect ${APPLICATIONS_ROOT}; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  const preserved = new Set(
    discoveredSelection.preservedBundles.map(({ path }) => path),
  );
  let validatedSelection: XcodeSelectionSnapshot | undefined;

  const operations: Operation[] = [];
  for (const entry of entries) {
    if (
      (!entry.isDirectory() && !entry.isSymbolicLink()) ||
      !/^Xcode_[0-9][A-Za-z0-9._-]{0,63}\.app$/.test(entry.name)
    ) {
      continue;
    }

    const target = normalize(join(APPLICATIONS_ROOT, entry.name));
    const targetRealPath = await resolveXcodePath(target);
    let discoveredTargetIdentity: MacOSXcodeBundleIdentity | undefined;
    try {
      discoveredTargetIdentity = await inspectXcodeBundleIdentity(target);
    } catch (error) {
      return [
        xcodeFailureOperation(
          `Unable to inspect Xcode bundle '${target}'; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
        ),
      ];
    }
    if (discoveredTargetIdentity === undefined) {
      return [
        xcodeFailureOperation(
          `Xcode removal target '${target}' disappeared during discovery; no Xcode bundle was removed.`,
        ),
      ];
    }
    if (
      preserved.has(target) ||
      (targetRealPath !== undefined && preserved.has(targetRealPath))
    ) {
      continue;
    }
    if (
      discoveredSelection.preservedBundles.some(
        ({ identity }) =>
          identity !== undefined &&
          sameXcodeBundleIdentity(identity, discoveredTargetIdentity),
      )
    ) {
      return [
        xcodeFailureOperation(
          `Xcode removal target '${target}' unexpectedly has a preserved bundle identity; no Xcode bundle was removed.`,
        ),
      ];
    }

    let validatedTargetIdentity: MacOSXcodeBundleIdentity | undefined;

    const removeXcodeTarget = dependencies.removeXcodeTarget;
    const removal =
      removeXcodeTarget === undefined
        ? createRemovePathOperation({
            id: `xcode:${entry.name}:removal`,
            component: "xcode",
            description: `Remove non-selected ${entry.name}`,
            target,
            allowedParents: [APPLICATIONS_ROOT],
            context,
          })
        : createFunctionOperation({
            id: `xcode:${entry.name}:removal`,
            component: "xcode",
            description: `Remove non-selected ${entry.name}`,
            phase: "filesystem",
            ...(dependencies.validateXcodeTarget === undefined
              ? {}
              : {
                  validate: async () =>
                    await dependencies.validateXcodeTarget?.(target),
                }),
            run: async () => await removeXcodeTarget(target),
          });
    operations.push(
      createFunctionOperation({
        id: `xcode:${entry.name}`,
        component: "xcode",
        description: `Remove non-selected ${entry.name}`,
        phase: "filesystem",
        validate: async () => {
          const current = await inspectXcodeSelection(
            runXcodeSelect,
            resolveXcodePath,
            inspectXcodeBundleIdentity,
          );
          const discoveryDifference = xcodeSelectionDifference(
            discoveredSelection,
            current,
          );
          if (discoveryDifference !== undefined) {
            throw new Error(`${discoveryDifference} after cleanup discovery`);
          }
          const validationDifference =
            validatedSelection === undefined
              ? undefined
              : xcodeSelectionDifference(validatedSelection, current);
          if (validationDifference !== undefined) {
            throw new Error(`${validationDifference} during plan validation`);
          }
          validatedSelection ??= current;
          const targetIdentity = await inspectXcodeBundleIdentity(target);
          if (targetIdentity === undefined) {
            throw new Error(
              `Xcode removal target '${target}' disappeared during plan validation`,
            );
          }
          if (
            !sameXcodeBundleIdentity(
              discoveredTargetIdentity,
              targetIdentity,
            ) ||
            (validatedTargetIdentity !== undefined &&
              !sameXcodeBundleIdentity(validatedTargetIdentity, targetIdentity))
          ) {
            throw new Error(
              `Xcode bundle identity changed during plan validation for '${target}'`,
            );
          }
          validatedTargetIdentity ??= targetIdentity;
          await removal.validate?.();
        },
        run: async (): Promise<OperationResult> => {
          try {
            validatedSelection ??= await inspectXcodeSelection(
              runXcodeSelect,
              resolveXcodePath,
              inspectXcodeBundleIdentity,
            );
            const discoveryDifference = xcodeSelectionDifference(
              discoveredSelection,
              validatedSelection,
            );
            if (discoveryDifference !== undefined) {
              return {
                status: "failed",
                detail: `${discoveryDifference} after cleanup discovery`,
              };
            }
            validatedTargetIdentity ??=
              await inspectXcodeBundleIdentity(target);
            if (validatedTargetIdentity === undefined) {
              return {
                status: "failed",
                detail: `Xcode removal target '${target}' disappeared after cleanup discovery`,
              };
            }
            if (
              !sameXcodeBundleIdentity(
                discoveredTargetIdentity,
                validatedTargetIdentity,
              )
            ) {
              return {
                status: "failed",
                detail: `Xcode bundle identity changed after cleanup discovery for '${target}'`,
              };
            }
            const immediate = await inspectXcodeSelection(
              runXcodeSelect,
              resolveXcodePath,
              inspectXcodeBundleIdentity,
            );
            const immediateDifference = xcodeSelectionDifference(
              validatedSelection,
              immediate,
            );
            if (immediateDifference !== undefined) {
              return {
                status: "failed",
                detail: `${immediateDifference} before bundle deletion`,
              };
            }
            const immediateTargetIdentity =
              await inspectXcodeBundleIdentity(target);
            if (immediateTargetIdentity === undefined) {
              return {
                status: "failed",
                detail: `Xcode removal target '${target}' disappeared before bundle deletion`,
              };
            }
            if (
              !sameXcodeBundleIdentity(
                validatedTargetIdentity,
                immediateTargetIdentity,
              )
            ) {
              return {
                status: "failed",
                detail: `Xcode bundle identity changed before bundle deletion for '${target}'`,
              };
            }
            let result: OperationResult | undefined;
            let removalError: unknown;
            try {
              result = await removal.run();
            } catch (error) {
              removalError = error;
            }
            const after = await inspectXcodeSelection(
              runXcodeSelect,
              resolveXcodePath,
              inspectXcodeBundleIdentity,
            );
            const afterDifference = xcodeSelectionDifference(immediate, after);
            if (afterDifference !== undefined) {
              return {
                status: "failed",
                detail: `${afterDifference} during bundle deletion; the target may already have been removed`,
              };
            }
            const afterTargetIdentity =
              await inspectXcodeBundleIdentity(target);
            if (removalError !== undefined) {
              return {
                status: "failed",
                detail:
                  removalError instanceof Error
                    ? removalError.message
                    : String(removalError),
              };
            }
            if (result?.status !== "removed") {
              if (afterTargetIdentity === undefined) {
                return {
                  status: "failed",
                  detail: `Xcode removal target '${target}' disappeared without a verified action removal`,
                };
              }
              if (
                !sameXcodeBundleIdentity(
                  immediateTargetIdentity,
                  afterTargetIdentity,
                )
              ) {
                return {
                  status: "failed",
                  detail: `Xcode bundle identity changed during bundle deletion for '${target}'`,
                };
              }
              return result?.status === "failed"
                ? result
                : {
                    status: "failed",
                    detail: `Xcode removal of '${target}' was not verified`,
                  };
            }
            if (afterTargetIdentity !== undefined) {
              return {
                status: "failed",
                detail: sameXcodeBundleIdentity(
                  immediateTargetIdentity,
                  afterTargetIdentity,
                )
                  ? `Xcode removal target '${target}' remained after removal reported success`
                  : `Xcode bundle identity changed during bundle deletion for '${target}'`,
              };
            }
            return result;
          } catch (error) {
            return {
              status: "failed",
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    );
  }

  if (operations.length === 0) {
    operations.push(
      createFunctionOperation({
        id: "xcode:none",
        component: "xcode",
        description: "Remove non-selected versioned Xcode bundles",
        phase: "filesystem",
        run: async () => ({ status: "not-found" }),
      }),
    );
  }
  return operations;
}

export async function createMacOSAdapter(
  context: RuntimeContext,
  dependencies: MacOSAdapterDependencies = {},
): Promise<Adapter> {
  const resolveBrew =
    dependencies.resolveBrewExecutable ?? resolveDefinitionBrewExecutable;
  const executeBrewRaw = dependencies.executeBrew ?? NODE_MACOS_BREW_RUNNER;
  const inspectBrewExecutable =
    dependencies.inspectBrewExecutable ??
    (dependencies.resolveBrewExecutable === undefined
      ? inspectExecutable
      : undefined);
  const inspectBrewConfig =
    dependencies.inspectBrewConfig ?? NODE_BREW_CONFIG_PROBE;
  const inspectBrewSystemExecutable =
    dependencies.inspectBrewSystemExecutable ??
    (dependencies.runBrewConfigSystemUtility === undefined
      ? inspectExecutable
      : undefined);
  const createBrewConfigRootCandidate =
    dependencies.createBrewConfigRoot ?? NODE_BREW_CONFIG_ROOT_CANDIDATE;
  const runBrewConfigSystemUtilityRaw =
    dependencies.runBrewConfigSystemUtility ??
    (async (
      executable: string,
      args: readonly string[],
      description: string,
    ): Promise<void> => {
      if (!context.hasPasswordlessSudo) {
        throw new Error(
          "Passwordless sudo is required to create and remove isolated Homebrew configuration",
        );
      }
      await runPrivilegedMacOSSystemUtility(
        context,
        executable,
        args,
        description,
      );
    });
  const validateBrewConfigRoot =
    dependencies.validateBrewConfigRoot ??
    (async (path, requireEmpty) =>
      await validateDefinitionBrewConfigRoot(
        path,
        requireEmpty,
        NODE_BREW_CONFIG_ROOT_PROBE,
      ));
  const readJavaDirectory =
    dependencies.readJavaDirectory ??
    (async (path: string) =>
      await readBoundedMacOSDirectory(path, "Java directory inventory"));
  let brew: string | undefined;
  let createdBrewConfigRoot: string | undefined;
  let brewConfigRoot: string | undefined;
  let validatedBrewIdentity: CommandFileIdentity | undefined;
  let validatedBrewSystemExecutables:
    ReadonlyMap<string, CommandFileIdentity> | undefined;
  let brewInitialization: Promise<void> | undefined;
  const initializeBrew = async (): Promise<void> => {
    brewInitialization ??= (async () => {
      const resolved = await resolveBrew(context.architecture);
      const identity =
        resolved === undefined || inspectBrewExecutable === undefined
          ? undefined
          : await inspectBrewExecutable(resolved);
      brew = resolved;
      validatedBrewIdentity = identity;
    })();
    await brewInitialization;
  };
  const verifyBrewExecutable = async (): Promise<void> => {
    await initializeBrew();
    if (brew === undefined) return;
    const current = await resolveBrew(context.architecture);
    if (current !== brew) {
      throw new Error("Homebrew executable changed after plan validation");
    }
    if (inspectBrewExecutable !== undefined) {
      const currentIdentity = await inspectBrewExecutable(brew);
      if (!sameCommandFileIdentity(validatedBrewIdentity, currentIdentity)) {
        throw new Error("Homebrew executable changed after plan validation");
      }
    }
  };
  const validateBrewSystemExecutables = async (): Promise<void> => {
    if (inspectBrewSystemExecutable === undefined) return;
    const paths = [MACOS_SUDO, MACOS_MKDIR, MACOS_RMDIR] as const;
    const current = new Map<string, CommandFileIdentity>();
    for (const executable of paths) {
      const identity = await inspectBrewSystemExecutable(executable);
      assertTrustedMacOSSystemExecutable(executable, identity);
      current.set(executable, identity);
    }
    if (validatedBrewSystemExecutables !== undefined) {
      for (const executable of paths) {
        if (
          !sameCommandFileIdentity(
            validatedBrewSystemExecutables.get(executable),
            current.get(executable),
          )
        ) {
          throw new Error(
            `A trusted macOS system executable changed after plan validation: '${executable}'.`,
          );
        }
      }
    }
    validatedBrewSystemExecutables ??= current;
  };
  const runBrewConfigSystemUtility: BrewConfigSystemUtilityRunner = async (
    executable,
    args,
    description,
  ) => {
    await validateBrewSystemExecutables();
    await runBrewConfigSystemUtilityRaw(executable, args, description);
  };
  const removeBrewConfigRoot =
    dependencies.removeBrewConfigRoot ??
    (async (path: string): Promise<void> => {
      // The protected root must be empty. rmdir deliberately cannot recurse
      // into an unexpected entry if configuration state changed.
      await runBrewConfigSystemUtility(
        MACOS_RMDIR,
        [path],
        "Homebrew configuration removal",
      );
    });
  const executeBrew: MacOSBrewRunner = async (
    executable,
    args,
    environment,
    options,
  ) => {
    await verifyBrewExecutable();
    await recheckBrewConfiguration();
    if (brewConfigRoot === undefined) {
      throw new Error(
        "Homebrew command was requested before isolated configuration was prepared",
      );
    }
    await validateBrewConfigRoot(brewConfigRoot, true);
    return await executeBrewRaw(executable, args, environment, options);
  };
  const environment = (): NodeJS.ProcessEnv => brewEnvironment(brewConfigRoot);
  const brewState = createBrewState(() => brew, executeBrew, environment);
  let validatedBrewConfig: string | undefined;

  const validateBrewConfiguration = async (): Promise<void> => {
    if (brew === undefined) return;
    await verifyBrewExecutable();
    await validateBrewSystemExecutables();
    validatedBrewConfig = await findBrewConfig(
      context.architecture,
      inspectBrewConfig,
    );
    if (validatedBrewConfig !== undefined) {
      throw new Error(
        `Homebrew configuration can override cleanup paths (${validatedBrewConfig})`,
      );
    }
  };

  const recheckBrewConfiguration = async (): Promise<void> => {
    if (brew === undefined) return;
    const config = await findBrewConfig(
      context.architecture,
      inspectBrewConfig,
    );
    if (config !== undefined || validatedBrewConfig !== undefined) {
      throw new Error(
        `Homebrew configuration can override cleanup paths (${config ?? validatedBrewConfig})`,
      );
    }
  };

  const prepareBrewEnvironment = async (): Promise<void> => {
    if (brew === undefined) return;
    await verifyBrewExecutable();
    await recheckBrewConfiguration();
    if (brewConfigRoot === undefined) {
      if (createdBrewConfigRoot !== undefined) {
        throw new Error(
          "A previously created Homebrew configuration directory was not safely prepared or removed",
        );
      }
      const configRoot = checkedBrewConfigRoot(
        await createBrewConfigRootCandidate(MACOS_BREW_CONFIG_PREFIX),
      );
      try {
        // No -p: a collision, including a symlink, must make mkdir fail. The
        // path is not accepted or eligible for removal until this exact
        // root-owned creation reports success.
        await runBrewConfigSystemUtility(
          MACOS_MKDIR,
          ["-m", "0555", configRoot],
          "Homebrew configuration directory creation",
        );
        createdBrewConfigRoot = configRoot;
        await validateBrewConfigRoot(configRoot, true);
        brewConfigRoot = configRoot;
      } catch (error) {
        if (error instanceof UnconfirmedCommandTerminationError) throw error;
        assertCommandTerminationConfirmed();
        try {
          await releaseBrewEnvironment();
        } catch (cleanupError) {
          if (cleanupError instanceof UnconfirmedCommandTerminationError) {
            throw cleanupError;
          }
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; unable to remove isolated Homebrew configuration: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        throw error;
      }
    }
  };

  const releaseBrewEnvironment = async (): Promise<void> => {
    // Revoke command use before validation or removal. A failed preparation or
    // cleanup can retain the created path for a later safe rollback, but can
    // never promote it into Brew's environment.
    brewConfigRoot = undefined;
    if (createdBrewConfigRoot === undefined) return;
    const configRoot = checkedBrewConfigRoot(createdBrewConfigRoot);
    await validateBrewConfigRoot(configRoot, true);
    assertCommandTerminationConfirmed();
    await removeBrewConfigRoot(configRoot);
    createdBrewConfigRoot = undefined;
  };

  return {
    supportedComponents: SUPPORTED,
    operations: async (plan: CleanupPlan): Promise<readonly Operation[]> => {
      const operations: Operation[] = [];
      const add = (operation: Operation | undefined): void => {
        if (operation !== undefined && plan.enabled.has(operation.component)) {
          operations.push(operation);
        }
      };
      const addRemoval = (
        component: ComponentId,
        target: string | undefined,
        parents: readonly string[],
        description: string,
      ): void => {
        if (!plan.enabled.has(component)) return;
        add(removeOperation(context, component, target, parents, description));
      };

      const home = normalize(context.home);
      if (home !== MACOS_RUNNER_HOME) {
        throw new Error(
          `Refusing unexpected macOS runner home '${context.home}'; no cleanup was scheduled.`,
        );
      }
      const safeHome = home;
      const defaultToolCache = join(safeHome, "hostedtoolcache");
      const toolCache = exactDefinitionPath(
        context.toolCache,
        defaultToolCache,
      );
      const androidParent = join(safeHome, "Library", "Android");
      const androidRoot = exactDefinitionPath(
        process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME,
        join(androidParent, "sdk"),
      );
      const vcpkgRoot = exactDefinitionPath(
        process.env.VCPKG_INSTALLATION_ROOT,
        join(LOCAL_SHARE, "vcpkg"),
      );

      const fixedPaths: readonly [
        ComponentId,
        string,
        readonly string[],
        string,
        (readonly ComponentId[] | undefined)?,
        (readonly ComponentId[] | undefined)?,
      ][] = [
        ["dotnet", join(safeHome, ".dotnet"), [safeHome], "Remove .NET SDKs"],
        [
          "dotnet",
          join(LOCAL_BIN, "dotnet"),
          [LOCAL_BIN],
          "Remove .NET executable link",
        ],
        ["android", androidRoot, [androidParent], "Remove Android SDK and NDK"],
        [
          "android",
          join(safeHome, ".android"),
          [safeHome],
          "Remove Android user state",
        ],
        [
          "codeql",
          join(toolCache, "CodeQL"),
          [toolCache],
          "Remove CodeQL bundle",
          [],
          ["cached-tools"],
        ],
        [
          "cached-tools",
          toolCache,
          [dirname(toolCache)],
          "Remove hosted toolcache",
        ],
        [
          "cached-go",
          join(toolCache, "Go"),
          [toolCache],
          "Remove cached Go versions",
          ["cached-tools"],
        ],
        [
          "cached-node",
          join(toolCache, "Node"),
          [toolCache],
          "Remove cached Node.js versions",
          ["cached-tools"],
        ],
        [
          "cached-python",
          join(toolCache, "Python"),
          [toolCache],
          "Remove cached Python versions",
          ["cached-tools"],
        ],
        [
          "cached-ruby",
          join(toolCache, "Ruby"),
          [toolCache],
          "Remove cached Ruby versions",
          ["cached-tools"],
        ],
        [
          "java",
          join(toolCache, "Java_Temurin-Hotspot_jdk"),
          [toolCache],
          "Remove cached Temurin JDKs",
          [],
          ["cached-tools"],
        ],
        [
          "powershell",
          join(LOCAL_ROOT, "microsoft", "powershell"),
          [join(LOCAL_ROOT, "microsoft")],
          "Remove PowerShell runtime",
        ],
        [
          "powershell",
          join(LOCAL_SHARE, "powershell"),
          [LOCAL_SHARE],
          "Remove PowerShell modules",
        ],
        [
          "powershell",
          join(LOCAL_BIN, "pwsh"),
          [LOCAL_BIN],
          "Remove pwsh executable link",
        ],
        [
          "powershell",
          join(LOCAL_BIN, "powershell"),
          [LOCAL_BIN],
          "Remove powershell executable link",
        ],
        ["vcpkg", vcpkgRoot, [LOCAL_SHARE], "Remove vcpkg installation"],
        [
          "vcpkg",
          join(safeHome, ".cache", "vcpkg"),
          [safeHome],
          "Remove vcpkg cache",
        ],
        [
          "vcpkg",
          join(safeHome, ".vcpkg"),
          [safeHome],
          "Remove vcpkg user data",
        ],
        [
          "vcpkg",
          join(LOCAL_BIN, "vcpkg"),
          [LOCAL_BIN],
          "Remove vcpkg executable link",
        ],
        [
          "aws-cli",
          join(LOCAL_ROOT, "aws-cli"),
          [LOCAL_ROOT],
          "Remove AWS CLI",
        ],
        [
          "aws-cli",
          join(LOCAL_BIN, "aws"),
          [LOCAL_BIN],
          "Remove AWS CLI executable link",
        ],
        [
          "aws-cli",
          join(LOCAL_BIN, "aws_completer"),
          [LOCAL_BIN],
          "Remove AWS CLI completer link",
        ],
        [
          "azcopy",
          join(LOCAL_BIN, "azcopy"),
          [LOCAL_BIN],
          "Remove AzCopy executable",
        ],
        ["rust", join(safeHome, ".cargo"), [safeHome], "Remove Cargo home"],
        [
          "rust",
          join(safeHome, ".rustup"),
          [safeHome],
          "Remove Rustup toolchains",
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
        if (!plan.enabled.has(component)) continue;
        operations.push(
          createRemovePathOperation({
            id: `${component}:${target}`,
            component,
            description,
            target,
            allowedParents: parents,
            context,
            ...(blockedBy === undefined ? {} : { blockedBy }),
            ...(coveredBy === undefined ? {} : { coveredBy }),
          }),
        );
      }

      if (plan.enabled.has("cached-tools")) {
        operations.push(
          recreateToolCacheOperation(
            context,
            toolCache,
            dependencies.createToolCacheDirectory,
            dependencies.accessToolCacheDirectory,
          ),
        );
      }

      const browserPaths: readonly [
        readonly ComponentId[],
        string,
        readonly string[],
        string,
      ][] = [
        [
          ["chrome", "browsers"],
          join(APPLICATIONS_ROOT, "Google Chrome.app"),
          [APPLICATIONS_ROOT],
          "Remove Google Chrome application",
        ],
        [
          ["chrome", "browsers"],
          join(APPLICATIONS_ROOT, "Google Chrome for Testing.app"),
          [APPLICATIONS_ROOT],
          "Remove Google Chrome for Testing application",
        ],
        [
          ["edge", "browsers"],
          join(APPLICATIONS_ROOT, "Microsoft Edge.app"),
          [APPLICATIONS_ROOT],
          "Remove Microsoft Edge application",
        ],
        [
          ["firefox", "browsers"],
          join(APPLICATIONS_ROOT, "Firefox.app"),
          [APPLICATIONS_ROOT],
          "Remove Firefox application",
        ],
      ];
      for (const [components, target, parents, description] of browserPaths) {
        for (const component of components) {
          addRemoval(component, target, parents, description);
        }
      }

      const chromeDriver = exactDefinitionPath(
        process.env.CHROMEWEBDRIVER,
        join(
          LOCAL_SHARE,
          `chromedriver-mac-${context.architecture === "arm64" ? "arm64" : "x64"}`,
        ),
      );
      const edgeDriver = exactDefinitionPath(
        process.env.EDGEWEBDRIVER,
        join(LOCAL_SHARE, "edge_driver"),
      );
      const driverPaths: readonly [string, readonly string[], string][] = [
        [chromeDriver, [LOCAL_SHARE], "Remove ChromeDriver files"],
        [edgeDriver, [LOCAL_SHARE], "Remove Edge WebDriver files"],
        [
          join(LOCAL_BIN, "chromedriver"),
          [LOCAL_BIN],
          "Remove ChromeDriver executable link",
        ],
        [
          join(LOCAL_BIN, "msedgedriver"),
          [LOCAL_BIN],
          "Remove Edge WebDriver executable link",
        ],
      ];
      for (const [target, parents, description] of driverPaths) {
        for (const component of ["webdrivers", "browsers"] as const) {
          addRemoval(component, target, parents, description);
        }
      }

      if (plan.enabled.has("java")) {
        try {
          const javaLinks = boundedMacOSDirectoryEntries(
            await readJavaDirectory("/Library/Java/JavaVirtualMachines"),
            "Java directory inventory",
          );
          for (const entry of javaLinks) {
            if (
              entry.isSymbolicLink() &&
              /^Temurin-Hotspot-[0-9]+\.jdk$/.test(entry.name)
            ) {
              addRemoval(
                "java",
                join("/Library/Java/JavaVirtualMachines", entry.name),
                ["/Library/Java/JavaVirtualMachines"],
                `Remove runner-image Java link ${entry.name}`,
              );
            }
          }
        } catch (error) {
          if (
            error instanceof Error &&
            ["ENOENT", "ENOTDIR"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            // The directory is absent on images without a runner-installed JDK.
          } else {
            throw error;
          }
        }
      }

      if (plan.enabled.has("xcode")) {
        operations.push(...(await xcodeOperations(context, dependencies)));
      }

      const usesHomebrew =
        !plan.skipped.has("homebrew") &&
        (plan.enabled.has("homebrew") ||
          BREW_OWNER_COMPONENTS.some((component) =>
            plan.enabled.has(component),
          ));
      if (!usesHomebrew) return operations;

      await initializeBrew();
      operations.push(
        createFunctionOperation({
          id: "macos:brew:configuration",
          component: plan.enabled.has("homebrew")
            ? "homebrew"
            : (BREW_OWNER_COMPONENTS.find((component) =>
                plan.enabled.has(component),
              ) ?? "homebrew"),
          description:
            "Validate Homebrew configuration and prepare isolated state",
          phase: "preflight",
          dedupeKey: "macos:brew:configuration",
          fatal: true,
          validate: validateBrewConfiguration,
          rollback: releaseBrewEnvironment,
          rollbackAfterPayloadMutation: true,
          run: async (): Promise<OperationResult> => {
            try {
              await prepareBrewEnvironment();
              return brew === undefined
                ? { status: "not-found" }
                : {
                    status: "removed",
                    detail: "prepared isolated Homebrew configuration",
                  };
            } catch (error) {
              if (error instanceof UnconfirmedCommandTerminationError) {
                throw error;
              }
              assertCommandTerminationConfirmed();
              return {
                status: "failed",
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          },
        }),
      );

      const broadHomebrewAllowed = plan.enabled.has("homebrew");

      if (broadHomebrewAllowed) {
        operations.push(
          removeDefinitionHomebrewPackagesOperation(
            brew,
            brewState,
            executeBrew,
            environment,
            plan.skipped,
          ),
        );
      } else {
        for (const definition of BREW_PACKAGES) {
          for (const component of definition.components) {
            if (plan.enabled.has(component)) {
              operations.push(
                brewPackageOperation(
                  brew,
                  brewState,
                  definition,
                  component,
                  executeBrew,
                  environment,
                ),
              );
            }
          }
        }
      }

      // Place finalization after every uninstall operation. Broad Homebrew
      // cleanup and narrow configuration release each deduplicate separately.
      if (plan.enabled.has("homebrew")) {
        operations.push(
          brewCleanupOperation(
            brew,
            "homebrew",
            executeBrew,
            environment,
            releaseBrewEnvironment,
          ),
        );
      } else {
        for (const component of BREW_OWNER_COMPONENTS) {
          if (plan.enabled.has(component)) {
            operations.push(
              brewConfigurationReleaseOperation(
                brew,
                component,
                releaseBrewEnvironment,
              ),
            );
          }
        }
      }

      return operations;
    },
  };
}
