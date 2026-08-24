import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLinuxAdapter,
  listLinuxVersionedChildren,
} from "../src/platforms/linux.js";
import { contextFor, planFor } from "./helpers.js";

test("Linux rejects workflow overrides that point at broad allowlist parents", async () => {
  const names = [
    "CONDA",
    "VCPKG_INSTALLATION_ROOT",
    "SELENIUM_JAR_PATH",
    "CHROMEWEBDRIVER",
    "EDGEWEBDRIVER",
    "GECKOWEBDRIVER",
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CONDA = "/usr/share";
    process.env.VCPKG_INSTALLATION_ROOT = "/usr/local/share";
    process.env.SELENIUM_JAR_PATH = "/usr/share/java";
    process.env.CHROMEWEBDRIVER = "/usr/local/share";
    process.env.EDGEWEBDRIVER = "/opt";
    process.env.GECKOWEBDRIVER = "/usr/local/share";

    const adapter = await createLinuxAdapter(contextFor("linux"));
    const operations = await adapter.operations(
      planFor("miniconda", "vcpkg", "selenium", "webdrivers"),
    );
    const identifiers = operations.map(({ id }) => id).join("\n");

    for (const broadRoot of [
      "/usr/share",
      "/usr/local/share",
      "/usr/share/java",
      "/opt",
    ]) {
      assert.equal(
        identifiers.split("\n").some((id) => id.endsWith(`:${broadRoot}`)),
        false,
        `scheduled broad deletion ${broadRoot}`,
      );
    }
    assert.match(identifiers, /\/usr\/share\/miniconda/);
    assert.match(identifiers, /\/usr\/local\/share\/vcpkg/);
    assert.match(identifiers, /\/usr\/share\/java\/selenium-server\.jar/);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Linux ignores an untrusted hosted toolcache override", async () => {
  const context = { ...contextFor("linux"), toolCache: "/usr/local" };
  const adapter = await createLinuxAdapter(context);
  const operations = await adapter.operations(planFor("cached-tools"));
  assert.equal(
    operations.some(({ id }) => id.endsWith(":/usr/local")),
    false,
  );
});

test("Linux fails closed for a home outside hosted-runner roots", async () => {
  await assert.rejects(
    async () =>
      await createLinuxAdapter({ ...contextFor("linux"), home: "/usr" }),
    /unexpected Linux runner home/,
  );
  await assert.rejects(
    async () =>
      await createLinuxAdapter({
        ...contextFor("linux"),
        home: "/home/runner/project",
      }),
    /unexpected Linux runner home/,
  );
});

test("Linux accepts the official slim container home layouts", async () => {
  for (const home of ["/root", "/github/home"]) {
    const adapter = await createLinuxAdapter({
      ...contextFor("linux"),
      home,
      isContainer: true,
      isUbuntuSlim: true,
    });
    assert.equal(adapter.supportedComponents.has("azcopy"), true);
  }
});

test("Linux command removals ignore workflow PATH and cover fixed image bins", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-poisoned-path-"));
  const command = join(root, "azcopy");
  await mkdir(root, { recursive: true });
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  try {
    const adapter = await createLinuxAdapter(contextFor("linux"));
    const operations = (await adapter.operations(planFor("azcopy"))).filter(
      ({ id }) => id.startsWith("binary:azcopy:azcopy:"),
    );
    assert.deepEqual(operations.map(({ id }) => id).sort(), [
      "binary:azcopy:azcopy:usr-bin",
      "binary:azcopy:azcopy:usr-local-bin",
    ]);
    assert.equal(await readFile(command, "utf8"), "#!/bin/sh\nexit 0\n");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("Linux resolves command removals only for the active plan", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const operations = await adapter.operations(planFor("azcopy"));
  assert.equal(
    operations.some(({ id }) => id === "binary:haskell:stack"),
    false,
  );
  assert.equal(
    operations.some(({ id }) => id.startsWith("binary:azcopy:azcopy:")),
    true,
  );
});

test("Android cleanup preserves the general Gradle user cache", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const operations = await adapter.operations(planFor("android"));
  assert.equal(
    operations.some(({ id }) => id.endsWith(":/home/runner/.gradle")),
    false,
  );
  assert.equal(
    operations.some(({ id }) => id.endsWith(":/home/runner/.android")),
    true,
  );
});

test("Linux cleanup preserves shared web and container storage unless all owners are selected", async () => {
  const adapter = await createLinuxAdapter(contextFor("linux"));
  const apache = await adapter.operations(planFor("apache"));
  assert.equal(
    apache.some(({ id }) => id.endsWith(":/var/www")),
    false,
  );

  const podman = await adapter.operations(planFor("podman"));
  assert.equal(
    podman.some(({ id }) => id.endsWith(":/var/lib/containers")),
    false,
  );
  const allContainerOwners = await adapter.operations(
    planFor("podman", "buildah"),
  );
  assert.equal(
    allContainerOwners.some(({ id }) => id.endsWith(":/var/lib/containers")),
    true,
  );
});

test("Linux versioned inventories reject rather than truncate excess entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-versions-"));
  try {
    await Promise.all(
      Array.from({ length: 65 }, async (_, index) => {
        await mkdir(join(root, `version-${index}`));
      }),
    );
    await assert.rejects(
      async () => await listLinuxVersionedChildren(root, /^version-\d+$/),
      /exceeded 64 entries/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
