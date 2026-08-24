import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnconfirmedCommandTerminationError } from "../src/command.js";
import {
  detectArchitecture,
  detectPlatform,
  definitionActionPath,
  definitionImageDataPath,
  isDefinitionCompatibleRunnerImage,
  isOfficialUbuntuSlimContainer,
  probePasswordlessSudo,
  readDefinitionImageData,
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

const VM_IMAGE_LOCATIONS: Readonly<Record<string, readonly [string, string]>> =
  {
    "ubuntu-22.04": ["ubuntu22", "images/ubuntu/Ubuntu2204-Readme.md"],
    "ubuntu-24.04": ["ubuntu24", "images/ubuntu/Ubuntu2404-Readme.md"],
    "ubuntu-26.04": ["ubuntu26", "images/ubuntu/Ubuntu2604-Readme.md"],
    "ubuntu-22.04-arm": [
      "ubuntu22-arm64",
      "images/ubuntu/Ubuntu2204-Arm64-Readme.md",
    ],
    "ubuntu-24.04-arm": [
      "ubuntu24-arm64",
      "images/ubuntu/Ubuntu2404-Arm64-Readme.md",
    ],
    "ubuntu-26.04-arm": [
      "ubuntu26-arm64",
      "images/ubuntu/Ubuntu2604-Arm64-Readme.md",
    ],
    "windows-2022": ["win22", "images/windows/Windows2022-Readme.md"],
    "windows-2025": ["win25", "images/windows/Windows2025-Readme.md"],
    "windows-2025-vs2026": [
      "win25-vs2026",
      "images/windows/Windows2025-VS2026-Readme.md",
    ],
    "windows-11-arm64": [
      "win11-arm64",
      "images/windows/Windows11-Arm64-Readme.md",
    ],
    "windows-11-vs2026-arm64": [
      "win11-vs2026-arm64",
      "images/windows/Windows11-VS2026-Arm64-Readme.md",
    ],
    "macos-15": ["macos-15", "images/macos/macos-15-Readme.md"],
    "macos-26": ["macos-26", "images/macos/macos-26-Readme.md"],
    "macos-14-arm64": [
      "macos-14-arm64",
      "images/macos/macos-14-arm64-Readme.md",
    ],
    "macos-15-arm64": [
      "macos-15-arm64",
      "images/macos/macos-15-arm64-Readme.md",
    ],
    "macos-26-arm64": [
      "macos-26-arm64",
      "images/macos/macos-26-arm64-Readme.md",
    ],
    "xcode-27-arm64": [
      "xcode-27-arm64",
      "images/macos/xcode-27-arm64-Readme.md",
    ],
  };

test("runner OS and architecture claims cannot override the host process", () => {
  assert.throws(
    () => detectPlatform("Windows", "linux"),
    /RUNNER_OS.*does not match.*linux/i,
  );
  assert.throws(
    () => detectArchitecture("ARM64", "x64"),
    /RUNNER_ARCH.*does not match.*x64/i,
  );
  assert.equal(detectPlatform("Linux", "linux"), "linux");
  assert.equal(detectArchitecture("X64", "x64"), "x64");
});

test("an unconfirmed sudo probe timeout is never downgraded to no sudo", async () => {
  await assert.rejects(
    async () =>
      await probePasswordlessSudo(
        "macos",
        () => 501,
        async () => {
          throw new UnconfirmedCommandTerminationError(
            "sudo probe process tree may still be running",
          );
        },
      ),
    UnconfirmedCommandTerminationError,
  );
});

function vmImageData(label: string, version = "20260805.1"): string {
  const [sourceRef, readme] = VM_IMAGE_LOCATIONS[label] ?? [
    label,
    `images/ubuntu/${label}-Readme.md`,
  ];
  const sourceVersion = version.split(".", 2).join(".");
  return JSON.stringify([
    {
      group: "Operating System",
      detail: "definition-owned operating system data",
    },
    {
      group: "Runner Image",
      detail: `Image: ${label}\nVersion: ${version}\nIncluded Software: https://github.com/actions/runner-images/blob/${sourceRef}/${sourceVersion}/${readme}\nImage Release: https://github.com/actions/runner-images/releases/tag/${sourceRef}%2F${sourceVersion}`,
    },
  ]);
}

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
    JSON.stringify([
      ...JSON.parse(officialSlimImageData),
      ...JSON.parse(officialSlimImageData),
    ]),
    JSON.stringify([
      ...JSON.parse(officialSlimImageData),
      { group: "Runner Image", detail: "workflow-supplied" },
    ]),
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

test("image metadata paths come from the runner-image definitions", () => {
  assert.equal(
    definitionImageDataPath("linux"),
    "/imagegeneration/imagedata.json",
  );
  assert.equal(
    definitionImageDataPath("macos"),
    "/Users/runner/imagedata.json",
  );
  assert.equal(definitionImageDataPath("windows"), "C:\\imagedata.json");
});

test("workflow environment cannot authorize a VM runner image", () => {
  const originalImageOS = process.env.ImageOS;
  const originalImageVersion = process.env.ImageVersion;
  try {
    process.env.ImageOS = "ubuntu24";
    process.env.ImageVersion = "20260805.1";
    assert.equal(
      isDefinitionCompatibleRunnerImage("linux", "x64", false, undefined),
      false,
    );
  } finally {
    if (originalImageOS === undefined) delete process.env.ImageOS;
    else process.env.ImageOS = originalImageOS;
    if (originalImageVersion === undefined) delete process.env.ImageVersion;
    else process.env.ImageVersion = originalImageVersion;
  }
});

test("only definition-compatible standard image families pass discovery", () => {
  const identities = [
    ["linux", "x64", "ubuntu-22.04"],
    ["linux", "x64", "ubuntu-24.04"],
    ["linux", "x64", "ubuntu-26.04"],
    ["linux", "arm64", "ubuntu-22.04-arm"],
    ["linux", "arm64", "ubuntu-24.04-arm"],
    ["linux", "arm64", "ubuntu-26.04-arm"],
    ["windows", "x64", "windows-2022"],
    ["windows", "x64", "windows-2025"],
    ["windows", "x64", "windows-2025-vs2026"],
    ["windows", "arm64", "windows-11-arm64"],
    ["windows", "arm64", "windows-11-vs2026-arm64"],
    ["macos", "x64", "macos-15"],
    ["macos", "x64", "macos-26"],
    ["macos", "arm64", "macos-14-arm64"],
    ["macos", "arm64", "macos-15-arm64"],
    ["macos", "arm64", "macos-26-arm64"],
    ["macos", "arm64", "xcode-27-arm64"],
  ] as const;
  for (const [platform, architecture, label] of identities) {
    assert.equal(
      isDefinitionCompatibleRunnerImage(
        platform,
        architecture,
        false,
        vmImageData(label),
      ),
      true,
      `${platform}/${architecture}/${label}`,
    );
  }
});

test("unrecognized or malformed definition metadata fails closed", () => {
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "linux",
      "x64",
      false,
      vmImageData("rhel-9"),
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "windows",
      "x64",
      false,
      vmImageData("custom-windows"),
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "windows",
      "x64",
      false,
      vmImageData("windows-2022-vs2026"),
    ),
    false,
  );
  for (const imageData of [
    undefined,
    "not JSON",
    JSON.stringify({ ImageOS: "ubuntu24", ImageVersion: "20260805.1" }),
    vmImageData("ubuntu-24.04", "latest"),
    vmImageData("ubuntu-24.04").replace(
      "https://github.com/actions/runner-images/blob/",
      "https://example.invalid/",
    ),
    vmImageData("ubuntu-24.04").replace(
      "/ubuntu24/20260805.1/",
      "/ubuntu24/99999999.9/",
    ),
  ]) {
    assert.equal(
      isDefinitionCompatibleRunnerImage("linux", "x64", false, imageData),
      false,
    );
  }
});

test("definition identity must agree with the process platform and architecture", () => {
  for (const [platform, architecture, label] of [
    ["linux", "x64", "ubuntu-24.04-arm"],
    ["linux", "arm64", "ubuntu-24.04"],
    ["windows", "x64", "windows-11-arm64"],
    ["windows", "arm64", "windows-2025"],
    ["macos", "x64", "macos-26-arm64"],
    ["macos", "x64", "macos-14"],
    ["macos", "arm64", "macos-26"],
  ] as const) {
    assert.equal(
      isDefinitionCompatibleRunnerImage(
        platform,
        architecture,
        false,
        vmImageData(label),
      ),
      false,
      `${platform}/${architecture} must reject ${label}`,
    );
  }
});

test("ubuntu-slim metadata is required and compatible only with its container identity", () => {
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "linux",
      "x64",
      true,
      officialSlimImageData,
    ),
    true,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "linux",
      "arm64",
      true,
      officialSlimImageData,
    ),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage("linux", "x64", true, undefined),
    false,
  );
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "linux",
      "x64",
      true,
      vmImageData("ubuntu-24.04"),
    ),
    false,
  );
});

test("duplicate Runner Image records cannot authorize a VM", () => {
  const parsed = JSON.parse(vmImageData("ubuntu-24.04")) as unknown[];
  parsed.push(parsed[1]);
  assert.equal(
    isDefinitionCompatibleRunnerImage(
      "linux",
      "x64",
      false,
      JSON.stringify(parsed),
    ),
    false,
  );
});

test("definition metadata reader accepts only a bounded regular file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-image-data-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const regular = join(root, "imagedata.json");
  const linked = join(root, "linked.json");
  const directory = join(root, "directory");
  const oversized = join(root, "oversized.json");
  await writeFile(regular, vmImageData("ubuntu-24.04"));
  await symlink(regular, linked);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
  await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20));

  assert.equal(
    await readDefinitionImageData("linux", regular),
    vmImageData("ubuntu-24.04"),
  );
  assert.equal(await readDefinitionImageData("linux", linked), undefined);
  assert.equal(await readDefinitionImageData("linux", directory), undefined);
  assert.equal(await readDefinitionImageData("linux", oversized), undefined);
});
