import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Architecture, Platform, RuntimeContext } from "./types.js";
import { runCommand } from "./command.js";

const UBUNTU_SLIM_IMAGE_DATA = "/imagegeneration/imagedata.json";
const MAX_IMAGE_DATA_BYTES = 256 * 1024;

function detectPlatform(): Platform {
  const runnerOs = (process.env.RUNNER_OS ?? "").toLowerCase();
  if (runnerOs === "linux") return "linux";
  if (runnerOs === "macos") return "macos";
  if (runnerOs === "windows") return "windows";

  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  throw new Error(`Unsupported runner operating system: ${process.platform}`);
}

function detectArchitecture(): Architecture {
  const runnerArchitecture = (process.env.RUNNER_ARCH ?? "").toLowerCase();
  if (runnerArchitecture === "x64") return "x64";
  if (runnerArchitecture === "arm64") return "arm64";
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  throw new Error(`Unsupported runner architecture: ${process.arch}`);
}

export function isOfficialUbuntuSlimContainer(
  isContainer: boolean,
  imageData?: string,
): boolean {
  if (!isContainer) return false;
  if (imageData === undefined) return false;
  try {
    const parsed = JSON.parse(imageData) as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      if (record.group !== "VM Image" || typeof record.detail !== "string") {
        return false;
      }
      const detail = record.detail;
      return (
        /^- OS: Linux \(x64\)$/m.test(detail) &&
        /^- Source: Docker$/m.test(detail) &&
        /^- Name: ubuntu:24\.04$/m.test(detail) &&
        /^- Version: \d+(?:\.\d+)+$/m.test(detail)
      );
    });
  } catch {
    return false;
  }
}

export function definitionActionPath(
  platform: Platform,
  moduleUrl: string,
  configuredPath?: string,
): string {
  const api = platform === "windows" ? win32 : posix;
  const canonical = (value: string): string => {
    const normalized = api.normalize(api.resolve(value));
    return platform === "windows" ? normalized.toLowerCase() : normalized;
  };
  const moduleDirectory = api.normalize(
    api.resolve(api.dirname(fileURLToPath(moduleUrl))),
  );
  if (configuredPath !== undefined && api.isAbsolute(configuredPath)) {
    const configured = api.normalize(api.resolve(configuredPath));
    if (
      canonical(configured) === canonical(moduleDirectory) ||
      canonical(configured) === canonical(api.dirname(moduleDirectory))
    ) {
      return configured;
    }
  }
  return moduleDirectory;
}

export function isDefinitionCompatibleRunnerImage(
  platform: Platform,
  architecture: Architecture,
  environment: NodeJS.ProcessEnv,
  isUbuntuSlim: boolean,
): boolean {
  if (isUbuntuSlim) return platform === "linux" && architecture === "x64";
  const imageVersion = environment.ImageVersion ?? "";
  if (!/^\d+(?:\.\d+)+$/.test(imageVersion)) return false;

  const imageOS = environment.ImageOS ?? "";
  switch (platform) {
    case "linux":
      return architecture === "arm64"
        ? /^ubuntu(?:22|24|26)-arm64$/.test(imageOS)
        : /^ubuntu(?:22|24|26)$/.test(imageOS);
    case "windows":
      return architecture === "arm64"
        ? /^(?:win11-arm64|win11-vs2026-arm64)$/.test(imageOS)
        : /^(?:win22|win25|win25-vs2026)$/.test(imageOS);
    case "macos":
      return /^macos(?:14|15|26)$/.test(imageOS);
  }
}

export async function createRuntimeContext(): Promise<RuntimeContext> {
  const platform = detectPlatform();
  const architecture = detectArchitecture();
  const isContainer =
    platform === "linux" &&
    (existsSync("/run/.containerenv") || existsSync("/.dockerenv"));
  let imageData: string | undefined;
  if (isContainer) {
    try {
      const file = await open(
        UBUNTU_SLIM_IMAGE_DATA,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const metadata = await file.stat();
        if (metadata.isFile() && metadata.size <= MAX_IMAGE_DATA_BYTES) {
          imageData = await file.readFile("utf8");
        }
      } finally {
        await file.close();
      }
    } catch {
      imageData = undefined;
    }
  }
  const isUbuntuSlim = isOfficialUbuntuSlimContainer(isContainer, imageData);
  let hasPasswordlessSudo = false;
  if (platform !== "windows" && typeof process.getuid === "function") {
    if (process.getuid() === 0) {
      hasPasswordlessSudo = true;
    } else {
      try {
        const result = await runCommand("sudo", ["-n", "true"], {
          silent: true,
          timeoutMs: 5_000,
        });
        hasPasswordlessSudo = result.exitCode === 0;
      } catch {
        hasPasswordlessSudo = false;
      }
    }
  }

  return {
    platform,
    architecture,
    home:
      platform === "windows"
        ? (process.env.USERPROFILE ?? process.env.HOME ?? homedir())
        : (process.env.HOME ?? homedir()),
    temp: process.env.RUNNER_TEMP ?? tmpdir(),
    toolCache:
      process.env.RUNNER_TOOL_CACHE ?? process.env.AGENT_TOOLSDIRECTORY,
    workspace: process.env.GITHUB_WORKSPACE,
    runtimeExecutable: process.execPath,
    actionPath: definitionActionPath(
      platform,
      import.meta.url,
      process.env.GITHUB_ACTION_PATH,
    ),
    isContainer,
    isGitHubHosted:
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    isDefinitionCompatibleImage: isDefinitionCompatibleRunnerImage(
      platform,
      architecture,
      process.env,
      isUbuntuSlim,
    ),
    isUbuntuSlim,
    hasPasswordlessSudo,
  };
}
