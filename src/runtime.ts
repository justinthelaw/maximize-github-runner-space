import { constants, existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Architecture, Platform, RuntimeContext } from "./types.js";
import {
  runCommand,
  TRUSTED_UNIX_PATH,
  UNIX_SUDO_EXECUTABLE,
} from "./command.js";

const MAX_IMAGE_DATA_BYTES = 256 * 1024;

const DEFINITION_IMAGE_DATA_PATHS: Readonly<Record<Platform, string>> = {
  linux: "/imagegeneration/imagedata.json",
  macos: "/Users/runner/imagedata.json",
  windows: "C:\\imagedata.json",
};

interface SupportedVmImage {
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly sourceRef: string;
  readonly readme: string;
}

const SUPPORTED_VM_IMAGES: Readonly<Record<string, SupportedVmImage>> = {
  "ubuntu-22.04": {
    platform: "linux",
    architecture: "x64",
    sourceRef: "ubuntu22",
    readme: "images/ubuntu/Ubuntu2204-Readme.md",
  },
  "ubuntu-24.04": {
    platform: "linux",
    architecture: "x64",
    sourceRef: "ubuntu24",
    readme: "images/ubuntu/Ubuntu2404-Readme.md",
  },
  "ubuntu-26.04": {
    platform: "linux",
    architecture: "x64",
    sourceRef: "ubuntu26",
    readme: "images/ubuntu/Ubuntu2604-Readme.md",
  },
  "ubuntu-22.04-arm": {
    platform: "linux",
    architecture: "arm64",
    sourceRef: "ubuntu22-arm64",
    readme: "images/ubuntu/Ubuntu2204-Arm64-Readme.md",
  },
  "ubuntu-24.04-arm": {
    platform: "linux",
    architecture: "arm64",
    sourceRef: "ubuntu24-arm64",
    readme: "images/ubuntu/Ubuntu2404-Arm64-Readme.md",
  },
  "ubuntu-26.04-arm": {
    platform: "linux",
    architecture: "arm64",
    sourceRef: "ubuntu26-arm64",
    readme: "images/ubuntu/Ubuntu2604-Arm64-Readme.md",
  },
  "windows-2022": {
    platform: "windows",
    architecture: "x64",
    sourceRef: "win22",
    readme: "images/windows/Windows2022-Readme.md",
  },
  "windows-2025": {
    platform: "windows",
    architecture: "x64",
    sourceRef: "win25",
    readme: "images/windows/Windows2025-Readme.md",
  },
  "windows-2025-vs2026": {
    platform: "windows",
    architecture: "x64",
    sourceRef: "win25-vs2026",
    readme: "images/windows/Windows2025-VS2026-Readme.md",
  },
  "windows-11-arm64": {
    platform: "windows",
    architecture: "arm64",
    sourceRef: "win11-arm64",
    readme: "images/windows/Windows11-Arm64-Readme.md",
  },
  "windows-11-vs2026-arm64": {
    platform: "windows",
    architecture: "arm64",
    sourceRef: "win11-vs2026-arm64",
    readme: "images/windows/Windows11-VS2026-Arm64-Readme.md",
  },
  "macos-15": {
    platform: "macos",
    architecture: "x64",
    sourceRef: "macos-15",
    readme: "images/macos/macos-15-Readme.md",
  },
  "macos-26": {
    platform: "macos",
    architecture: "x64",
    sourceRef: "macos-26",
    readme: "images/macos/macos-26-Readme.md",
  },
  "macos-14-arm64": {
    platform: "macos",
    architecture: "arm64",
    sourceRef: "macos-14-arm64",
    readme: "images/macos/macos-14-arm64-Readme.md",
  },
  "macos-15-arm64": {
    platform: "macos",
    architecture: "arm64",
    sourceRef: "macos-15-arm64",
    readme: "images/macos/macos-15-arm64-Readme.md",
  },
  "macos-26-arm64": {
    platform: "macos",
    architecture: "arm64",
    sourceRef: "macos-26-arm64",
    readme: "images/macos/macos-26-arm64-Readme.md",
  },
  "xcode-27-arm64": {
    platform: "macos",
    architecture: "arm64",
    sourceRef: "xcode-27-arm64",
    readme: "images/macos/xcode-27-arm64-Readme.md",
  },
};

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

function parseImageData(
  imageData?: string,
): readonly Record<string, unknown>[] {
  if (imageData === undefined) return [];
  try {
    const parsed = JSON.parse(imageData) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  } catch {
    return [];
  }
}

export function isOfficialUbuntuSlimContainer(
  isContainer: boolean,
  imageData?: string,
): boolean {
  if (!isContainer) return false;
  const records = parseImageData(imageData);
  const record = records[0];
  if (
    records.length !== 1 ||
    record?.group !== "VM Image" ||
    typeof record.detail !== "string"
  ) {
    return false;
  }
  return /^- OS: Linux \(x64\)\n- Source: Docker\n- Name: ubuntu:24\.04\n- Version: \d+(?:\.\d+)+\n(?:[\s\S]*)$/.test(
    record.detail,
  );
}

interface RunnerImageIdentity {
  readonly label: string;
  readonly version: string;
  readonly sourceRef: string;
  readonly readme: string;
}

function runnerImageIdentity(
  imageData?: string,
): RunnerImageIdentity | undefined {
  const records = parseImageData(imageData).filter(
    (record) => record.group === "Runner Image",
  );
  const record = records[0];
  if (records.length !== 1 || typeof record?.detail !== "string") {
    return undefined;
  }
  const match = record.detail.match(
    /^Image: ([a-z0-9.-]+)\nVersion: (\d+(?:\.\d+)+)\nIncluded Software: https:\/\/github\.com\/actions\/runner-images\/blob\/([a-z0-9.-]+)\/(\d+\.\d+)\/(images\/(?:ubuntu|windows|macos)\/[A-Za-z0-9.-]+-Readme\.md)\nImage Release: https:\/\/github\.com\/actions\/runner-images\/releases\/tag\/([a-z0-9.-]+)%2F(\d+\.\d+)$/,
  );
  const label = match?.[1];
  const version = match?.[2];
  const sourceRef = match?.[3];
  const sourceVersion = match?.[4];
  const readme = match?.[5];
  const releaseTag = match?.[6];
  const releaseVersion = match?.[7];
  const versionPrefix = version?.split(".", 2).join(".");
  if (
    label === undefined ||
    version === undefined ||
    sourceRef === undefined ||
    readme === undefined ||
    releaseTag === undefined ||
    sourceRef !== releaseTag ||
    sourceVersion !== versionPrefix ||
    releaseVersion !== versionPrefix
  ) {
    return undefined;
  }
  return { label, version, sourceRef, readme };
}

export function definitionImageDataPath(platform: Platform): string {
  return DEFINITION_IMAGE_DATA_PATHS[platform];
}

function isSameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    isSameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function readDefinitionImageData(
  platform: Platform,
  path = definitionImageDataPath(platform),
): Promise<string | undefined> {
  try {
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > MAX_IMAGE_DATA_BYTES
    ) {
      return undefined;
    }
    const flags =
      platform === "windows"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    const file = await open(path, flags);
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.size > MAX_IMAGE_DATA_BYTES ||
        !isSameFileSnapshot(before, opened)
      ) {
        return undefined;
      }

      const buffer = Buffer.alloc(MAX_IMAGE_DATA_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await file.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_IMAGE_DATA_BYTES) return undefined;

      const [afterPath, afterHandle] = await Promise.all([
        lstat(path),
        file.stat(),
      ]);
      if (
        !afterPath.isFile() ||
        !isSameFileSnapshot(opened, afterPath) ||
        !isSameFileSnapshot(opened, afterHandle)
      ) {
        return undefined;
      }
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
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
  isContainer: boolean,
  imageData: string | undefined,
): boolean {
  if (isContainer) {
    return (
      platform === "linux" &&
      architecture === "x64" &&
      isOfficialUbuntuSlimContainer(true, imageData)
    );
  }
  const identity = runnerImageIdentity(imageData);
  if (identity === undefined) return false;
  const expected = SUPPORTED_VM_IMAGES[identity.label];
  return (
    expected !== undefined &&
    platform === expected.platform &&
    architecture === expected.architecture &&
    identity.sourceRef === expected.sourceRef &&
    identity.readme === expected.readme
  );
}

export async function createRuntimeContext(): Promise<RuntimeContext> {
  const platform = detectPlatform();
  const architecture = detectArchitecture();
  const isContainer =
    platform === "linux" &&
    (existsSync("/run/.containerenv") || existsSync("/.dockerenv"));
  const imageData = await readDefinitionImageData(platform);
  const isUbuntuSlim = isOfficialUbuntuSlimContainer(isContainer, imageData);
  let hasPasswordlessSudo = false;
  if (platform !== "windows" && typeof process.getuid === "function") {
    if (process.getuid() === 0) {
      hasPasswordlessSudo = true;
    } else {
      try {
        const result = await runCommand(
          UNIX_SUDO_EXECUTABLE,
          ["-n", "--", "/usr/bin/true"],
          {
            env: {
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
              PATH: TRUSTED_UNIX_PATH,
            },
            silent: true,
            timeoutMs: 5_000,
          },
        );
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
      isContainer,
      imageData,
    ),
    isUbuntuSlim,
    hasPasswordlessSudo,
  };
}
