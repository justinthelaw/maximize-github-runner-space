export const PLATFORMS = ["linux", "macos", "windows"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ARCHITECTURES = ["x64", "arm64"] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

export interface RuntimeContext {
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly home: string;
  readonly temp: string;
  readonly toolCache: string | undefined;
  readonly workspace: string | undefined;
  /** Node executable that is running this action, not the workflow PATH entry. */
  readonly runtimeExecutable: string;
  /** Definition-derived action directory containing the executing module. */
  readonly actionPath: string;
  readonly isContainer: boolean;
  readonly isGitHubHosted: boolean;
  readonly isDefinitionCompatibleImage: boolean;
  readonly isUbuntuSlim: boolean;
  readonly hasPasswordlessSudo: boolean;
}

export interface CleanupPlan {
  readonly profile: "max" | "custom";
  readonly enabled: ReadonlySet<ComponentId>;
  readonly skipped: ReadonlySet<ComponentId>;
  readonly swapfileBytes: bigint | undefined;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when captured stdout exceeded the bounded in-memory result. */
  readonly stdoutTruncated?: boolean;
  /** True when captured stderr exceeded the bounded in-memory result. */
  readonly stderrTruncated?: boolean;
  /** True when timeout handling could not confirm that the process tree ended. */
  readonly terminationUnconfirmed?: boolean;
}

export type OperationPhase = "preflight" | "filesystem" | "package" | "system";

export interface OperationResult {
  readonly status: "removed" | "not-found" | "unsupported" | "failed";
  readonly detail?: string;
  /** Explicitly marks a failed result as terminal for older operation callers. */
  readonly abortAction?: boolean;
}

export interface Operation {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly phase: OperationPhase;
  readonly dedupeKey?: string;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
  /**
   * Skip this narrower fallback only after one of the named operations reports
   * that it removed the payload. Missing, not-found, unsupported, and failed
   * covering operations leave the fallback eligible to run.
   */
  readonly coveredBySuccessfulOperations?: readonly string[];
  /** Run independently of component selection (currently used for swap). */
  readonly always?: boolean;
  /** Abort the action when the operation cannot preserve its state contract. */
  readonly fatal?: boolean;
  /** Read-only complete-plan validation, run before any operation mutates state. */
  readonly validate?: () => Promise<void>;
  /** Restore reversible preflight state when a later operation fails. */
  readonly rollback?: () => Promise<void>;
  /**
   * Allow only state-neutral housekeeping rollback after a payload operation
   * may have partially mutated the runner. Service restarts must leave this
   * false so they cannot revive a damaged installation.
   */
  readonly rollbackAfterPayloadMutation?: boolean;
  run(): Promise<OperationResult>;
}

export interface Adapter {
  readonly supportedComponents: ReadonlySet<ComponentId>;
  operations(plan: CleanupPlan): Promise<readonly Operation[]>;
}

export type ComponentId =
  | "dotnet"
  | "android"
  | "haskell"
  | "codeql"
  | "cached-tools"
  | "cached-go"
  | "cached-node"
  | "cached-python"
  | "cached-pypy"
  | "cached-ruby"
  | "swift"
  | "julia"
  | "java"
  | "browsers"
  | "chrome"
  | "chromium"
  | "edge"
  | "firefox"
  | "webdrivers"
  | "selenium"
  | "powershell"
  | "miniconda"
  | "homebrew"
  | "vcpkg"
  | "aws-cli"
  | "aws-sam-cli"
  | "azure-cli"
  | "gh-cli"
  | "gcloud-cli"
  | "azcopy"
  | "kubectl"
  | "helm"
  | "kind"
  | "minikube"
  | "kustomize"
  | "docker-engine"
  | "buildah"
  | "podman"
  | "maven"
  | "gradle"
  | "ant"
  | "php"
  | "rust"
  | "postgresql"
  | "mysql"
  | "apache"
  | "nginx"
  | "docker-images"
  | "large-packages"
  | "xcode"
  | "visual-studio"
  | "windows-sdk";
