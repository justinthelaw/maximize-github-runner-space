import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("the official Ubuntu slim image requires every positive identity marker", () => {
  assert.equal(isOfficialUbuntuSlimContainer(officialSlimIdentity, true), true);
  assert.equal(
    isOfficialUbuntuSlimContainer(officialSlimIdentity, false),
    false,
  );

  for (const marker of [
    "ImageOS",
    "IMAGE_TARGET_PLATFORM",
    "IMAGEDATA_NAME",
    "ImageVersion",
  ] as const) {
    const incompleteIdentity = { ...officialSlimIdentity };
    delete incompleteIdentity[marker];
    assert.equal(
      isOfficialUbuntuSlimContainer(incompleteIdentity, true),
      false,
      marker,
    );
  }
});

test("an arbitrary GitHub Actions job container is not Ubuntu slim", () => {
  assert.equal(
    isOfficialUbuntuSlimContainer(
      {
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "ubuntu24",
        ImageVersion: "20260805.1",
      },
      true,
    ),
    false,
  );
  assert.equal(
    isOfficialUbuntuSlimContainer(
      { ...officialSlimIdentity, IMAGEDATA_NAME: "ubuntu:24.04-custom" },
      true,
    ),
    false,
  );
});

test("the definition-owned image record identifies ubuntu-slim", () => {
  assert.equal(
    isOfficialUbuntuSlimContainer({}, true, officialSlimImageData),
    true,
  );
  assert.equal(
    isOfficialUbuntuSlimContainer({}, false, officialSlimImageData),
    false,
  );
  for (const changed of [
    officialSlimImageData.replace("Docker", "Podman"),
    officialSlimImageData.replace("ubuntu:24.04", "ubuntu:24.04-custom"),
    officialSlimImageData.replace("20260728.2.1", "latest"),
    "not JSON",
  ]) {
    assert.equal(isOfficialUbuntuSlimContainer({}, true, changed), false);
  }
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
      { ImageOS: "rhel9", ImageVersion: "20260805.1" },
      false,
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "windows",
      { ImageOS: "custom-windows", ImageVersion: "20260805.1" },
      false,
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "windows",
      { ImageOS: "win22-vs2026", ImageVersion: "20260805.1" },
      false,
    ),
    false,
  );
});
