import { constants, type Dirent } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { runCommand, TRUSTED_UNIX_PATH } from "../command.js";
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
  readonly inspectBrewConfig?: BrewConfigProbe;
  readonly createBrewConfigRoot?: BrewConfigRootCreator;
  readonly removeBrewConfigRoot?: BrewConfigRootRemover;
  readonly validateBrewConfigRoot?: BrewConfigRootValidator;
  readonly runXcodeSelect?: () => Promise<CommandResult>;
  readonly resolveXcodePath?: (path: string) => Promise<string | undefined>;
  readonly listApplications?: () => Promise<readonly Dirent[]>;
  readonly validateXcodeRemoval?: typeof validateRemovePathTarget;
  readonly removeXcodeTarget?: typeof removePathTarget;
}

export type BrewConfigRootCreator = (prefix: string) => Promise<string>;
export type BrewConfigRootRemover = (path: string) => Promise<void>;
export type BrewConfigRootValidator = (
  path: string,
  requireEmpty: boolean,
) => Promise<void>;

export interface BrewConfigRootStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
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

// A fixed system temporary parent avoids workflow-selected paths. mkdtemp
// creates a new directory atomically, so Homebrew never shares configuration
// state with the invoking workflow or a previous action invocation.
const NODE_BREW_CONFIG_ROOT_CREATOR: BrewConfigRootCreator = async (prefix) =>
  await mkdtemp(prefix);

const NODE_BREW_CONFIG_ROOT_REMOVER: BrewConfigRootRemover = async (path) =>
  await rm(path, { recursive: true, force: true, maxRetries: 3 });

const NODE_BREW_CONFIG_ROOT_PROBE: BrewConfigRootProbe = {
  lstat: async (path) => await lstat(path),
  readdir: async (path) => await readdir(path),
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
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(
      `Refusing unowned Homebrew configuration directory '${path}'.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing shared Homebrew configuration directory permissions '${path}'.`,
    );
  }
  if (requireEmpty && (await probe.readdir(path)).length !== 0) {
    throw new Error(
      `Refusing non-empty Homebrew configuration directory '${path}'.`,
    );
  }
}

function checkedBrewConfigRoot(path: string): string {
  const normalized = normalize(path);
  if (
    dirname(normalized) !== MACOS_BREW_TEMP ||
    !normalized.startsWith(MACOS_BREW_CONFIG_PREFIX) ||
    normalized.length <= MACOS_BREW_CONFIG_PREFIX.length
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
  } catch {
    return undefined;
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
  executable: string | undefined,
  execute: MacOSBrewRunner,
  environment: BrewEnvironmentProvider,
): BrewState {
  let pending: Promise<BrewInventory> | undefined;
  return {
    inventory: () => {
      pending ??= (async () => {
        if (executable === undefined) {
          return { formulae: new Set<string>(), casks: new Set<string>() };
        }

        const formulae = await execute(
          executable,
          ["list", "--formula", "--full-name"],
          environment(),
          { silent: true, timeoutMs: 60_000 },
        );
        if (formulae.exitCode !== 0) {
          throw new Error(
            formulae.stderr.trim() ||
              `brew formula inventory exited ${formulae.exitCode}`,
          );
        }

        const casks = await execute(
          executable,
          ["list", "--cask", "--full-name"],
          environment(),
          { silent: true, timeoutMs: 60_000 },
        );
        if (casks.exitCode !== 0) {
          throw new Error(
            casks.stderr.trim() ||
              `brew cask inventory exited ${casks.exitCode}`,
          );
        }

        return {
          formulae: parseBrewInventory(formulae.stdout, "formula"),
          casks: parseBrewInventory(casks.stdout, "cask"),
        };
      })();
      return pending;
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

      const installed = inventoryForKind(inventory, definition.kind);
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

      for (const match of matches) installed.delete(match);
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
): string[] {
  const selected = new Set<string>();
  for (const definition of BREW_PACKAGES) {
    if (definition.kind !== kind) continue;
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
): Operation {
  return createFunctionOperation({
    id: "brew:definition-packages",
    component: "homebrew",
    description: "Uninstall definition-listed Homebrew formulae and casks",
    phase: "package",
    dedupeKey: "brew:definition-packages",
    blockedBy: BREW_OWNER_COMPONENTS,
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
        ["cask", definitionListedPackages(inventory, "cask")],
        ["formula", definitionListedPackages(inventory, "formula")],
      ];
      let removed = 0;
      const failures: string[] = [];

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
            failures.push(
              result.stderr.trim() ||
                `brew ${kind} uninstall exited ${result.exitCode}`,
            );
            continue;
          }
          const installed = inventoryForKind(inventory, kind);
          for (const name of batch) installed.delete(name);
          removed += batch.length;
        }
      }

      if (failures.length > 0) {
        return {
          status: "failed",
          detail: failures.join("; ").slice(0, 2000),
        };
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
        failures.push(error instanceof Error ? error.message : String(error));
      }

      try {
        await releaseEnvironment();
      } catch (error) {
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

function recreateToolCacheOperation(
  context: RuntimeContext,
  target: string,
): Operation {
  return createFunctionOperation({
    id: "macos:toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    run: async () => {
      try {
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
        await mkdir(target, { recursive: true });
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
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

async function resolvedPath(value: string): Promise<string | undefined> {
  try {
    return normalize(await realpath(value));
  } catch {
    return undefined;
  }
}

interface XcodeSelection {
  readonly developerDirectory: string;
  readonly selectedSpellingBundle: string;
  readonly selectedBundle: string;
}

type XcodeSelectionSnapshot =
  { readonly selection: XcodeSelection } | { readonly failure: string };

function boundedXcodeFailure(detail: string): string {
  return detail.slice(0, 2_000);
}

async function discoverXcodeSelection(
  runXcodeSelect: () => Promise<CommandResult>,
  resolveXcodePath: (path: string) => Promise<string | undefined>,
): Promise<XcodeSelectionSnapshot> {
  let selected: CommandResult;
  try {
    selected = await runXcodeSelect();
  } catch (error) {
    return {
      failure: boundedXcodeFailure(
        `Unable to identify the current Xcode selection; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
      ),
    };
  }

  const value = selected.stdout.trim();
  if (
    selected.exitCode !== 0 ||
    value === "" ||
    value.length > 1024 ||
    !isAbsolute(value)
  ) {
    return {
      failure:
        "Unable to identify the current Xcode selection; no Xcode bundle was removed.",
    };
  }

  const developerDirectory = normalize(value);
  const selectedSpellingBundle = xcodeBundleFromPath(developerDirectory);
  if (selectedSpellingBundle === undefined) {
    return {
      failure:
        "Unable to identify the selected Xcode bundle; no Xcode bundle was removed.",
    };
  }

  let resolvedDeveloper: string | undefined;
  let resolvedSpellingBundle: string | undefined;
  try {
    resolvedDeveloper = await resolveXcodePath(developerDirectory);
    resolvedSpellingBundle = await resolveXcodePath(selectedSpellingBundle);
  } catch (error) {
    return {
      failure: boundedXcodeFailure(
        `Unable to resolve the current Xcode selection; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
      ),
    };
  }
  const developerBundle =
    resolvedDeveloper === undefined
      ? undefined
      : xcodeBundleFromPath(normalize(resolvedDeveloper));
  const selectedBundle =
    resolvedSpellingBundle === undefined
      ? undefined
      : xcodeBundleFromPath(normalize(resolvedSpellingBundle));
  if (
    developerBundle === undefined ||
    selectedBundle === undefined ||
    normalize(developerBundle) !== normalize(selectedBundle)
  ) {
    return {
      failure:
        "Xcode selection changed or could not be resolved safely; no Xcode bundle was removed.",
    };
  }

  return {
    selection: {
      developerDirectory,
      selectedSpellingBundle: normalize(selectedSpellingBundle),
      selectedBundle: normalize(selectedBundle),
    },
  };
}

function xcodeSelectionChanged(
  expected: XcodeSelection,
  current: XcodeSelection,
): boolean {
  return (
    expected.developerDirectory !== current.developerDirectory ||
    expected.selectedBundle !== current.selectedBundle
  );
}

async function xcodeOperations(
  context: RuntimeContext,
  dependencies: Required<
    Pick<
      MacOSAdapterDependencies,
      | "runXcodeSelect"
      | "resolveXcodePath"
      | "listApplications"
      | "validateXcodeRemoval"
      | "removeXcodeTarget"
    >
  >,
): Promise<readonly Operation[]> {
  const initial = await discoverXcodeSelection(
    dependencies.runXcodeSelect,
    dependencies.resolveXcodePath,
  );
  if ("failure" in initial) return [xcodeFailureOperation(initial.failure)];

  const preserved = new Set<string>([join(APPLICATIONS_ROOT, "Xcode.app")]);
  preserved.add(initial.selection.selectedSpellingBundle);
  preserved.add(initial.selection.selectedBundle);

  // Preserve both the selected spelling and its real bundle. Xcode.app is a
  // runner-image convenience alias, so its selected target is preserved too.
  for (const path of [
    initial.selection.selectedSpellingBundle,
    "/Applications/Xcode.app",
  ]) {
    let resolved: string | undefined;
    try {
      resolved = await dependencies.resolveXcodePath(path);
    } catch {
      continue;
    }
    if (resolved === undefined) continue;
    const bundle = xcodeBundleFromPath(resolved);
    if (bundle !== undefined) preserved.add(normalize(bundle));
  }

  let entries;
  try {
    entries = await dependencies.listApplications();
  } catch (error) {
    return [
      xcodeFailureOperation(
        `Unable to inspect ${APPLICATIONS_ROOT}; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  const operations: Operation[] = [];
  for (const entry of entries) {
    if (
      (!entry.isDirectory() && !entry.isSymbolicLink()) ||
      !/^Xcode_[0-9][A-Za-z0-9._-]{0,63}\.app$/.test(entry.name)
    ) {
      continue;
    }

    const target = normalize(join(APPLICATIONS_ROOT, entry.name));
    let targetRealPath: string | undefined;
    try {
      targetRealPath = await dependencies.resolveXcodePath(target);
    } catch {
      // Keep the operation so its run-time guard reports a bounded failure if
      // the target still cannot be resolved immediately before removal.
    }
    if (
      preserved.has(target) ||
      (targetRealPath !== undefined && preserved.has(targetRealPath))
    ) {
      continue;
    }

    let validationSnapshot: XcodeSelectionSnapshot | undefined;
    operations.push({
      id: `xcode:${entry.name}`,
      component: "xcode",
      description: `Remove non-selected ${entry.name}`,
      phase: "filesystem",
      dedupeKey: `path:${target}`,
      validate: async () => {
        await dependencies.validateXcodeRemoval(
          target,
          [APPLICATIONS_ROOT],
          context,
        );
        validationSnapshot ??= await discoverXcodeSelection(
          dependencies.runXcodeSelect,
          dependencies.resolveXcodePath,
        );
      },
      run: async (): Promise<OperationResult> => {
        if (validationSnapshot === undefined) {
          return {
            status: "failed",
            detail:
              "Xcode plan-validation snapshot is unavailable; no Xcode bundle was removed.",
          };
        }
        if ("failure" in validationSnapshot) {
          return { status: "failed", detail: validationSnapshot.failure };
        }

        let resolvedTarget: string | undefined;
        try {
          resolvedTarget = await dependencies.resolveXcodePath(target);
        } catch (error) {
          return {
            status: "failed",
            detail: boundedXcodeFailure(
              `Unable to resolve the Xcode removal target; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
            ),
          };
        }
        if (resolvedTarget === undefined) {
          return {
            status: "failed",
            detail:
              "Unable to resolve the Xcode removal target; no Xcode bundle was removed.",
          };
        }
        try {
          await dependencies.validateXcodeRemoval(
            target,
            [APPLICATIONS_ROOT],
            context,
          );
        } catch (error) {
          return {
            status: "failed",
            detail: boundedXcodeFailure(
              `Unable to validate the Xcode removal target; no Xcode bundle was removed (${error instanceof Error ? error.message : String(error)})`,
            ),
          };
        }

        // Take the final selected-Xcode sample only after every candidate path
        // resolution and validation step. Nothing may resolve or validate a
        // candidate between this snapshot and the removal boundary.
        const current = await discoverXcodeSelection(
          dependencies.runXcodeSelect,
          dependencies.resolveXcodePath,
        );
        if ("failure" in current) {
          return { status: "failed", detail: current.failure };
        }
        if (
          xcodeSelectionChanged(validationSnapshot.selection, current.selection)
        ) {
          return {
            status: "failed",
            detail:
              "Xcode selection changed after plan validation; no Xcode bundle was removed.",
          };
        }
        const normalizedResolvedTarget = normalize(resolvedTarget);
        if (
          target === current.selection.selectedSpellingBundle ||
          target === current.selection.selectedBundle ||
          normalizedResolvedTarget ===
            current.selection.selectedSpellingBundle ||
          normalizedResolvedTarget === current.selection.selectedBundle
        ) {
          return {
            status: "failed",
            detail:
              "Xcode selection changed or the removal target now aliases the selected bundle; no Xcode bundle was removed.",
          };
        }

        return await dependencies.removeXcodeTarget(
          target,
          [APPLICATIONS_ROOT],
          context,
        );
      },
    });
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
  const executeBrew = dependencies.executeBrew ?? NODE_MACOS_BREW_RUNNER;
  const inspectBrewConfig =
    dependencies.inspectBrewConfig ?? NODE_BREW_CONFIG_PROBE;
  const createBrewConfigRoot =
    dependencies.createBrewConfigRoot ?? NODE_BREW_CONFIG_ROOT_CREATOR;
  const removeBrewConfigRoot =
    dependencies.removeBrewConfigRoot ?? NODE_BREW_CONFIG_ROOT_REMOVER;
  const validateBrewConfigRoot =
    dependencies.validateBrewConfigRoot ?? validateDefinitionBrewConfigRoot;
  const xcodeDependencies = {
    runXcodeSelect:
      dependencies.runXcodeSelect ??
      (async () =>
        await runCommand("/usr/bin/xcode-select", ["--print-path"], {
          silent: true,
          timeoutMs: 10_000,
        })),
    resolveXcodePath: dependencies.resolveXcodePath ?? resolvedPath,
    listApplications:
      dependencies.listApplications ??
      (async () => await readdir(APPLICATIONS_ROOT, { withFileTypes: true })),
    validateXcodeRemoval:
      dependencies.validateXcodeRemoval ?? validateRemovePathTarget,
    removeXcodeTarget: dependencies.removeXcodeTarget ?? removePathTarget,
  };
  const brew = await resolveBrew(context.architecture);
  let brewConfigRoot: string | undefined;
  const environment = (): NodeJS.ProcessEnv => brewEnvironment(brewConfigRoot);
  const brewState = createBrewState(brew, executeBrew, environment);
  let validatedBrewConfig: string | undefined;

  const validateBrewConfiguration = async (): Promise<void> => {
    if (brew === undefined) return;
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
    await recheckBrewConfiguration();
    if (brewConfigRoot === undefined) {
      const configRoot = checkedBrewConfigRoot(
        await createBrewConfigRoot(MACOS_BREW_CONFIG_PREFIX),
      );
      await validateBrewConfigRoot(configRoot, true);
      brewConfigRoot = configRoot;
    }
  };

  const releaseBrewEnvironment = async (): Promise<void> => {
    if (brewConfigRoot === undefined) return;
    const configRoot = checkedBrewConfigRoot(brewConfigRoot);
    await validateBrewConfigRoot(configRoot, false);
    await removeBrewConfigRoot(configRoot);
    brewConfigRoot = undefined;
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
          "android",
          join(safeHome, ".gradle"),
          [safeHome],
          "Remove Android Gradle cache",
          ["gradle"],
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
        [
          "azure-cli",
          join(safeHome, ".azure", "cliextensions", "azure-devops"),
          [safeHome],
          "Remove Azure DevOps CLI extension",
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
        operations.push(recreateToolCacheOperation(context, toolCache));
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
          const javaLinks = await readdir("/Library/Java/JavaVirtualMachines", {
            withFileTypes: true,
          });
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
        } catch {
          // The directory is absent on images without a runner-installed JDK.
        }
      }

      if (plan.enabled.has("xcode")) {
        operations.push(...(await xcodeOperations(context, xcodeDependencies)));
      }

      const usesHomebrew =
        plan.enabled.has("homebrew") ||
        BREW_OWNER_COMPONENTS.some((component) => plan.enabled.has(component));
      if (usesHomebrew) {
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
                return {
                  status: "failed",
                  detail:
                    error instanceof Error ? error.message : String(error),
                };
              }
            },
          }),
        );
      }

      const broadHomebrewAllowed =
        plan.enabled.has("homebrew") &&
        !BREW_OWNER_COMPONENTS.some((component) => plan.skipped.has(component));

      if (broadHomebrewAllowed) {
        operations.push(
          removeDefinitionHomebrewPackagesOperation(
            brew,
            brewState,
            executeBrew,
            environment,
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

      // Place cleanup after every uninstall operation. prepareOperations keeps
      // only the first enabled operation with this dedupe key.
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
              brewCleanupOperation(
                brew,
                component,
                executeBrew,
                environment,
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
