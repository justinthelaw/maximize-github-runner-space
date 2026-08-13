import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import type { Architecture, Platform, RuntimeContext } from "./types.js";
import { runCommand } from "./command.js";

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
  environment: NodeJS.ProcessEnv,
  isContainer: boolean,
  imageData?: string,
): boolean {
  if (!isContainer) return false;
  const environmentIdentity =
    environment.ImageOS === "Linux" &&
    environment.IMAGE_TARGET_PLATFORM === "GitHub" &&
    environment.IMAGEDATA_NAME === "ubuntu:24.04" &&
    /^\d+(?:\.\d+)+$/.test(environment.ImageVersion ?? "");
  if (environmentIdentity) return true;

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

export function isDefinitionCompatibleRunnerImage(
  platform: Platform,
  environment: NodeJS.ProcessEnv,
  isUbuntuSlim: boolean,
): boolean {
  if (isUbuntuSlim) return true;
  const imageVersion = environment.ImageVersion ?? "";
  if (!/^\d+(?:\.\d+)+$/.test(imageVersion)) return false;

  const imageOS = environment.ImageOS ?? "";
  switch (platform) {
    case "linux":
      return /^ubuntu(?:22|24|26)(?:-arm64)?$/.test(imageOS);
    case "windows":
      return /^(?:win22|win25|win25-vs2026|win11-arm64|win11-vs2026-arm64)$/.test(
        imageOS,
      );
    case "macos":
      return /^macos(?:14|15|26)$/.test(imageOS);
  }
}

export async function createRuntimeContext(): Promise<RuntimeContext> {
  const platform = detectPlatform();
  const isContainer =
    platform === "linux" &&
    (existsSync("/run/.containerenv") || existsSync("/.dockerenv"));
  let imageData: string | undefined;
  if (isContainer) {
    try {
      imageData = await readFile("/imagegeneration/imagedata.json", "utf8");
    } catch {
      imageData = undefined;
    }
  }
  const isUbuntuSlim = isOfficialUbuntuSlimContainer(
    process.env,
    isContainer,
    imageData,
  );
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
    architecture: detectArchitecture(),
    home:
      platform === "windows"
        ? (process.env.USERPROFILE ?? process.env.HOME ?? homedir())
        : (process.env.HOME ?? homedir()),
    temp: process.env.RUNNER_TEMP ?? tmpdir(),
    toolCache:
      process.env.RUNNER_TOOL_CACHE ?? process.env.AGENT_TOOLSDIRECTORY,
    workspace: process.env.GITHUB_WORKSPACE,
    actionPath: process.env.GITHUB_ACTION_PATH,
    isContainer,
    isGitHubHosted:
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    isDefinitionCompatibleImage: isDefinitionCompatibleRunnerImage(
      platform,
      process.env,
      isUbuntuSlim,
    ),
    isUbuntuSlim,
    hasPasswordlessSudo,
  };
}
