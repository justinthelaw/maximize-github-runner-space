import assert from "node:assert/strict";
import test from "node:test";
import {
  definitionActionPath,
  isDefinitionCompatibleRunnerImage,
  isOfficialUbuntuSlimContainer,
} from "../src/runtime.js";

const officialSlimIdentity: NodeJS.ProcessEnv = {
  ImageOS: "Linux",
  IMAGE_TARGET_PLATFORM: "GitHub",
  IMAGEDATA_NAME: "ubuntu:24.04",
  ImageVersion: "20260805.1",
};

const officialSlimImageData = JSON.stringify([
  {
    group: "VM Image",
    detail:
      "- OS: Linux (x64)\n- Source: Docker\n- Name: ubuntu:24.04\n- Version: 20260728.2.1\n",
  },
]);

test("workflow environment cannot authorize an Ubuntu slim container", () => {
  const original = new Map(
    Object.keys(officialSlimIdentity).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, officialSlimIdentity);
    assert.equal(isOfficialUbuntuSlimContainer(true), false);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("an arbitrary GitHub Actions job container is not Ubuntu slim", () => {
  assert.equal(isOfficialUbuntuSlimContainer(true), false);
  assert.equal(
    isOfficialUbuntuSlimContainer(true, JSON.stringify(officialSlimIdentity)),
    false,
  );
});

test("the definition-owned image record identifies ubuntu-slim", () => {
  assert.equal(
    isOfficialUbuntuSlimContainer(true, officialSlimImageData),
    true,
  );
  assert.equal(
    isOfficialUbuntuSlimContainer(false, officialSlimImageData),
    false,
  );
  for (const changed of [
    officialSlimImageData.replace("Docker", "Podman"),
    officialSlimImageData.replace("ubuntu:24.04", "ubuntu:24.04-custom"),
    officialSlimImageData.replace("20260728.2.1", "latest"),
    "not JSON",
  ]) {
    assert.equal(isOfficialUbuntuSlimContainer(true, changed), false);
  }
});

test("the action path comes from its module and accepts only a containing runner value", () => {
  const moduleUrl = "file:///opt/action/dist/runtime.js";
  assert.equal(definitionActionPath("linux", moduleUrl), "/opt/action/dist");
  assert.equal(
    definitionActionPath("linux", moduleUrl, "/opt/action"),
    "/opt/action",
  );
  assert.equal(
    definitionActionPath("linux", moduleUrl, "/tmp/workflow-controlled"),
    "/opt/action/dist",
  );
  assert.equal(
    definitionActionPath("linux", moduleUrl, "/opt"),
    "/opt/action/dist",
  );
});

test("only definition-compatible standard image families pass discovery", () => {
  const environments = [
    ["linux", "ubuntu24"],
    ["linux", "ubuntu24-arm64"],
    ["windows", "win25-vs2026"],
    ["windows", "win11-vs2026-arm64"],
    ["macos", "macos26"],
  ] as const;
  for (const [platform, ImageOS] of environments) {
    assert.equal(
      isDefinitionCompatibleRunnerImage(
        platform,
        ImageOS.endsWith("arm64") || platform === "macos" ? "arm64" : "x64",
        { ImageOS, ImageVersion: "20260805.1" },
        false,
      ),
      true,
      `${platform}/${ImageOS}`,
    );
  }
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "linux",
      "x64",
      { ImageOS: "rhel9", ImageVersion: "20260805.1" },
      false,
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "windows",
      "x64",
      { ImageOS: "custom-windows", ImageVersion: "20260805.1" },
      false,
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "windows",
      "x64",
      { ImageOS: "win22-vs2026", ImageVersion: "20260805.1" },
      false,
    ),
    false,
  );
  for (const [platform, architecture, ImageOS] of [
    ["linux", "x64", "ubuntu24-arm64"],
    ["linux", "arm64", "ubuntu24"],
    ["windows", "x64", "win11-arm64"],
    ["windows", "arm64", "win25"],
  ] as const) {
    assert.equal(
      isDefinitionCompatibleRunnerImage(
        platform,
        architecture,
        { ImageOS, ImageVersion: "20260805.1" },
        false,
      ),
      false,
      `${platform}/${architecture} must reject ${ImageOS}`,
    );
  }
});

test("ubuntu-slim metadata is compatible only with its x64 architecture", () => {
  assert.equal(
    isDefinitionCompatibleRunnerImage("linux", "x64", {}, true),
    true,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage("linux", "arm64", {}, true),
    false,
  );
});
