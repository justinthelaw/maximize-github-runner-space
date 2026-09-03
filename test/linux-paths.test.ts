import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareOperations } from "../src/operations.js";
import {
  createLinuxAdapter,
  selectLinuxAptPackages,
} from "../src/platforms/linux.js";
import { contextFor, planFor } from "./helpers.js";

const databasePackageCases = [
  {
    component: "postgresql" as const,
    installed: [
      "libpq-dev:amd64",
      "libpq-devtools",
      "postgresql",
      "postgresqlish",
      "postgresql-16",
      "xpostgresql-17",
      "postgresql-common",
      "postgresql-client-common:amd64",
    ],
    selected: [
      "libpq-dev:amd64",
      "postgresql",
      "postgresql-16",
      "postgresql-common",
      "postgresql-client-common:amd64",
    ],
    residualPaths: [
      "/var/lib/postgresql",
      "/etc/postgresql",
      "/usr/lib/postgresql",
    ],
  },
  {
    component: "mysql" as const,
    installed: [
      "libmysqlclient-dev",
      "libmysqlclient-devtools",
      "mysql-common:amd64",
      "mysql-server-8.0",
      "mysqlish",
      "mariadb-server",
      "xmysql-server",
      "xmariadb-server",
    ],
    selected: [
      "libmysqlclient-dev",
      "mysql-common:amd64",
      "mysql-server-8.0",
      "mariadb-server",
    ],
    residualPaths: ["/var/lib/mysql", "/etc/mysql"],
  },
] as const;

for (const {
  component,
  installed,
  selected: expected,
  residualPaths,
} of databasePackageCases) {
  test(`Linux ${component} package cleanup selects only exact database packages before residual paths`, async () => {
    const plan = planFor(component);
    const selected = selectLinuxAptPackages(plan, installed);
    assert.deepEqual(selected, expected);

    const adapter = await createLinuxAdapter(contextFor("linux"));
    const operations = prepareOperations(await adapter.operations(plan), plan);
    const apt = operations.find(({ id }) => id === "apt:selected-packages");
    assert.ok(apt);
    assert.equal(apt.phase, "package");
    for (const path of residualPaths) {
      const residual = operations.find(
        ({ id }) => id === `${component}:${path}`,
      );
      assert.ok(residual, `${component} omitted residual path ${path}`);
      assert.equal(residual.phase, "filesystem");
    }
  });
}

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

test("Linux never deletes a workflow PATH executable from an unrelated tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-poisoned-path-"));
  const command = join(root, "azcopy");
  await mkdir(root, { recursive: true });
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  try {
    const adapter = await createLinuxAdapter(contextFor("linux"));
    const operation = (await adapter.operations(planFor("azcopy"))).find(
      ({ id }) => id === "binary:azcopy:azcopy",
    );
    assert.ok(operation);
    const result = await operation.run();
    assert.equal(result.status, "unsupported");
    assert.match(result.detail ?? "", /unexpected executable path/);
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
    operations.some(({ id }) => id === "binary:azcopy:azcopy"),
    true,
  );
});
