import { COMPONENTS } from "../src/components.js";
import type {
  CleanupPlan,
  ComponentId,
  Platform,
  RuntimeContext,
} from "../src/types.js";

export function planFor(...components: ComponentId[]): CleanupPlan {
  return {
    profile: "custom",
    enabled: new Set(components),
    skipped: new Set(),
    swapfileBytes: undefined,
  };
}

export function allComponentsPlan(platform: Platform): CleanupPlan {
  return planFor(
    ...COMPONENTS.filter((definition) =>
      (definition.platforms as readonly string[]).includes(platform),
    ).map((definition) => definition.id),
  );
}

export function contextFor(platform: Platform): RuntimeContext {
  if (platform === "windows") {
    return {
      platform,
      architecture: "x64",
      home: "C:\\Users\\runneradmin",
      temp: "C:\\Users\\runneradmin\\AppData\\Local\\Temp",
      toolCache: "C:\\hostedtoolcache\\windows",
      workspace: "C:\\a\\repository\\repository",
      runtimeExecutable: "C:\\actions-runner\\externals\\node24\\bin\\node.exe",
      actionPath: "C:\\a\\_actions\\maximize-space",
      isContainer: false,
      isGitHubHosted: true,
      isDefinitionCompatibleImage: true,
      isUbuntuSlim: false,
      hasPasswordlessSudo: false,
    };
  }
  if (platform === "macos") {
    return {
      platform,
      architecture: "arm64",
      home: "/Users/runner",
      temp: "/Users/runner/work/_temp",
      toolCache: "/Users/runner/hostedtoolcache",
      workspace: "/Users/runner/work/repository/repository",
      runtimeExecutable:
        "/Users/runner/runners/current/externals/node24/bin/node",
      actionPath: "/Users/runner/work/_actions/maximize-space",
      isContainer: false,
      isGitHubHosted: true,
      isDefinitionCompatibleImage: true,
      isUbuntuSlim: false,
      hasPasswordlessSudo: true,
    };
  }
  return {
    platform,
    architecture: "x64",
    home: "/home/runner",
    temp: "/home/runner/work/_temp",
    toolCache: "/opt/hostedtoolcache",
    workspace: "/home/runner/work/repository/repository",
    runtimeExecutable: "/home/runner/runners/current/externals/node24/bin/node",
    actionPath: "/home/runner/work/_actions/maximize-space",
    isContainer: false,
    isGitHubHosted: true,
    isDefinitionCompatibleImage: true,
    isUbuntuSlim: false,
    hasPasswordlessSudo: true,
  };
}
