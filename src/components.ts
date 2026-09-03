import type { ComponentId, Platform } from "./types.js";

export interface ComponentDefinition {
  readonly id: ComponentId;
  readonly input: `remove-${string}`;
  readonly platforms: readonly Platform[];
}

const allPlatforms = ["linux", "macos", "windows"] as const;
const unixPlatforms = ["linux", "macos"] as const;

export const COMPONENTS = [
  { id: "dotnet", input: "remove-dotnet", platforms: allPlatforms },
  { id: "android", input: "remove-android", platforms: allPlatforms },
  { id: "haskell", input: "remove-haskell", platforms: ["linux", "windows"] },
  { id: "codeql", input: "remove-codeql", platforms: allPlatforms },
  { id: "cached-tools", input: "remove-cached-tools", platforms: allPlatforms },
  { id: "cached-go", input: "remove-cached-go", platforms: allPlatforms },
  { id: "cached-node", input: "remove-cached-node", platforms: allPlatforms },
  {
    id: "cached-python",
    input: "remove-cached-python",
    platforms: allPlatforms,
  },
  {
    id: "cached-pypy",
    input: "remove-cached-pypy",
    platforms: ["linux", "windows"],
  },
  { id: "cached-ruby", input: "remove-cached-ruby", platforms: allPlatforms },
  { id: "swift", input: "remove-swift", platforms: ["linux"] },
  { id: "julia", input: "remove-julia", platforms: ["linux", "windows"] },
  { id: "java", input: "remove-java", platforms: allPlatforms },
  { id: "browsers", input: "remove-browsers", platforms: allPlatforms },
  { id: "chrome", input: "remove-chrome", platforms: allPlatforms },
  { id: "chromium", input: "remove-chromium", platforms: ["linux"] },
  { id: "edge", input: "remove-edge", platforms: allPlatforms },
  { id: "firefox", input: "remove-firefox", platforms: allPlatforms },
  { id: "webdrivers", input: "remove-webdrivers", platforms: allPlatforms },
  { id: "selenium", input: "remove-selenium", platforms: allPlatforms },
  { id: "powershell", input: "remove-powershell", platforms: allPlatforms },
  {
    id: "miniconda",
    input: "remove-miniconda",
    platforms: ["linux", "windows"],
  },
  { id: "homebrew", input: "remove-homebrew", platforms: unixPlatforms },
  { id: "vcpkg", input: "remove-vcpkg", platforms: allPlatforms },
  { id: "aws-cli", input: "remove-aws-cli", platforms: allPlatforms },
  { id: "aws-sam-cli", input: "remove-aws-sam-cli", platforms: allPlatforms },
  { id: "azure-cli", input: "remove-azure-cli", platforms: allPlatforms },
  { id: "gh-cli", input: "remove-gh-cli", platforms: allPlatforms },
  { id: "gcloud-cli", input: "remove-gcloud-cli", platforms: ["linux"] },
  { id: "azcopy", input: "remove-azcopy", platforms: allPlatforms },
  { id: "kubectl", input: "remove-kubectl", platforms: allPlatforms },
  { id: "helm", input: "remove-helm", platforms: allPlatforms },
  { id: "kind", input: "remove-kind", platforms: allPlatforms },
  { id: "minikube", input: "remove-minikube", platforms: ["linux", "windows"] },
  {
    id: "kustomize",
    input: "remove-kustomize",
    platforms: ["linux", "windows"],
  },
  {
    id: "docker-engine",
    input: "remove-docker-engine",
    platforms: ["linux", "windows"],
  },
  { id: "buildah", input: "remove-buildah", platforms: ["linux"] },
  { id: "podman", input: "remove-podman", platforms: ["linux"] },
  { id: "maven", input: "remove-maven", platforms: allPlatforms },
  { id: "gradle", input: "remove-gradle", platforms: allPlatforms },
  { id: "ant", input: "remove-ant", platforms: allPlatforms },
  { id: "php", input: "remove-php", platforms: allPlatforms },
  { id: "rust", input: "remove-rust", platforms: allPlatforms },
  {
    id: "postgresql",
    input: "remove-postgresql",
    platforms: ["linux", "windows"],
  },
  { id: "mysql", input: "remove-mysql", platforms: ["linux", "windows"] },
  { id: "apache", input: "remove-apache", platforms: ["linux", "windows"] },
  { id: "nginx", input: "remove-nginx", platforms: allPlatforms },
  {
    id: "docker-images",
    input: "remove-docker-images",
    platforms: ["linux", "windows"],
  },
  {
    id: "large-packages",
    input: "remove-large-packages",
    platforms: ["linux"],
  },
  { id: "xcode", input: "remove-xcode", platforms: ["macos"] },
  {
    id: "visual-studio",
    input: "remove-visual-studio",
    platforms: ["windows"],
  },
  { id: "windows-sdk", input: "remove-windows-sdk", platforms: ["windows"] },
] as const satisfies readonly ComponentDefinition[];

export const COMPONENT_IDS = COMPONENTS.map((component) => component.id);
export const COMPONENT_ID_SET: ReadonlySet<ComponentId> = new Set(
  COMPONENT_IDS,
);

export const BROWSER_CHILDREN = [
  "chrome",
  "chromium",
  "edge",
  "firefox",
  "webdrivers",
  "selenium",
] as const satisfies readonly ComponentId[];

export const TOOLCACHE_CHILDREN = [
  "cached-go",
  "cached-node",
  "cached-python",
  "cached-pypy",
  "cached-ruby",
] as const satisfies readonly ComponentId[];

export const PRESERVATION_DEPENDENCIES: Readonly<
  Partial<Record<ComponentId, readonly ComponentId[]>>
> = {
  android: ["java"],
  maven: ["java"],
  gradle: ["java"],
  ant: ["java"],
  selenium: ["java"],
};

// These components own files below RUNNER_TOOL_CACHE. Skipping one must disable
// the broad cached-tools operation so the skip promise remains true.
export const TOOLCACHE_OWNERS = [
  ...TOOLCACHE_CHILDREN,
  "codeql",
  "dotnet",
  "haskell",
  "swift",
  "julia",
  "java",
] as const satisfies readonly ComponentId[];

export const LARGE_PACKAGE_OVERLAPS = [
  "dotnet",
  "php",
  "mysql",
  "azure-cli",
  "gcloud-cli",
  "browsers",
  "chrome",
  "chromium",
  "edge",
  "firefox",
  "powershell",
] as const satisfies readonly ComponentId[];
