import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPONENTS } from "../src/components.js";

function keysInSection(document: string, start: string, end: string): string[] {
  const section =
    document.split(`${start}:\n`)[1]?.split(`\n${end}:\n`)[0] ?? "";
  return [...section.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(
    (match) => match[1] ?? "",
  );
}

async function actionDefinitionFiles(): Promise<string[]> {
  const workflows = (await readdir(".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => `.github/workflows/${file}`);

  async function localActions(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return await localActions(path);
        return entry.isFile() && entry.name === "action.yml" ? [path] : [];
      }),
    );
    return nested.flat();
  }

  return [...workflows, ...(await localActions(".github/actions"))].sort();
}

function actionReferences(document: string): string[] {
  return [...document.matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)/gm)].map(
    (match) => match[1] ?? "",
  );
}

test("action metadata retains every historical input and adds platform inputs", async () => {
  const action = await readFile("action.yml", "utf8");
  const inputs = keysInSection(action, "inputs", "outputs");
  assert.deepEqual(inputs.slice(0, 3), [
    "cleanup-profile",
    "skip-components",
    "swapfile-size",
  ]);
  assert.deepEqual(
    [...inputs.slice(3)].sort(),
    COMPONENTS.map(({ input }) => input).sort(),
  );
  assert.match(action, /runs:\n  using: "node24"\n  main: "dist\/index\.js"/);

  for (const input of COMPONENTS.map(({ input }) => input)) {
    const block = action.split(`  ${input}:\n`)[1]?.split(/^  [a-z]/m)[0] ?? "";
    assert.match(block, /default: "false"/, `${input} default changed`);
  }
});

test("the public outputs are stable and documented", async () => {
  const action = await readFile("action.yml", "utf8");
  assert.deepEqual(keysInSection(action, "outputs", "runs"), [
    "available-bytes-before",
    "available-bytes-after",
    "reclaimed-bytes",
    "failed-operations",
    "platform",
    "architecture",
  ]);
});

test("runtime discovery does not silently invent a hosted-runner home", async () => {
  const runtime = await readFile("src/runtime.ts", "utf8");
  assert.doesNotMatch(runtime, /\/home\/runner(?:\/|\b)/);
});

test("remote workflow actions use immutable revisions and checkout drops credentials", async () => {
  const expectedCheckout =
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

  for (const file of await actionDefinitionFiles()) {
    const document = await readFile(file, "utf8");
    const references = actionReferences(document);
    for (const reference of references) {
      if (reference.startsWith("./")) continue;
      assert.match(
        reference,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${file} has an unpinned action reference: ${reference}`,
      );
    }

    const checkoutReferences = references.filter((reference) =>
      reference.startsWith("actions/checkout@"),
    );
    assert.deepEqual(
      [...new Set(checkoutReferences)],
      checkoutReferences.length === 0 ? [] : [expectedCheckout],
      `${file} has a stale checkout revision`,
    );
    const hardenedCheckouts = [
      ...document.matchAll(
        /^[ \t]*(?:-[ \t]*)?uses:[ \t]+actions\/checkout@[0-9a-f]{40}[^\n]*\n[ \t]+with:\n[ \t]+persist-credentials: false$/gm,
      ),
    ];
    assert.equal(
      hardenedCheckouts.length,
      checkoutReferences.length,
      `${file} must disable checkout credential persistence`,
    );
  }
});

test("compiled test discovery fails closed when no tests exist", async () => {
  const emptyDirectory = await mkdtemp(join(tmpdir(), "maximize-empty-tests-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/run-tests.mjs", emptyDirectory],
      {
        encoding: "utf8",
        shell: false,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No compiled test files found/);

    const packageDocument = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as { scripts?: Record<string, string> };
    assert.equal(
      packageDocument.scripts?.test,
      "npm run clean && tsc --project tsconfig.json && node scripts/run-tests.mjs build/test",
    );
  } finally {
    await rm(emptyDirectory, { force: true, recursive: true });
  }
});

test("pre-commit hooks use only repository-locked system tools", async () => {
  const configuration = await readFile(".pre-commit-config.yaml", "utf8");
  assert.deepEqual(
    [...configuration.matchAll(/^  - repo: (\S+)$/gm)].map((match) => match[1]),
    ["local"],
  );
  assert.doesNotMatch(configuration, /^    rev:/m);
  assert.doesNotMatch(configuration, /language: (?:python|node|golang)/);
  assert.doesNotMatch(configuration, /additional_dependencies:/);
  assert.equal(
    [...configuration.matchAll(/^      - id:/gm)].length,
    [...configuration.matchAll(/^        language: system$/gm)].length,
  );
  assert.match(configuration, /args: \["--maxkb=1024", "--enforce-all"\]/);
  assert.match(configuration, /entry: node_modules\/\.bin\/markdownlint-cli2/);
  assert.match(configuration, /entry: node_modules\/\.bin\/actionlint/);
});

test("platform smoke covers dependency-free image runtimes", async () => {
  const action = await readFile(
    ".github/actions/platform-smoke/action.yml",
    "utf8",
  );
  const cleanupIndex = action.indexOf("Run a bounded native cleanup");
  const unixRuntimeIndex = action.indexOf(
    "Record dependency-free runtime paths on Unix",
  );
  const windowsRuntimeIndex = action.indexOf(
    "Record dependency-free runtime paths on Windows",
  );
  assert.ok(cleanupIndex > 0);
  assert.ok(unixRuntimeIndex > 0 && unixRuntimeIndex < cleanupIndex);
  assert.ok(windowsRuntimeIndex > 0 && windowsRuntimeIndex < cleanupIndex);
  assert.match(action, /Exercise dependency-free Unix runtime smoke tests/);
  assert.match(action, /Exercise dependency-free Windows runtime smoke tests/);
  assert.doesNotMatch(
    action,
    /(?:apt(?:-get)?|brew|choco|dnf|pip|npm) install|actions\/(?:setup-node|setup-python)/i,
  );
  assert.doesNotMatch(action, /^\s*assert\s+/m);
  assert.match(action, /raise RuntimeError\("Python JSON round trip failed"\)/);
  assert.match(action, /bash_runtime=\/bin\/bash/);
  assert.match(action, /sh_runtime=\/bin\/sh/);
  assert.match(
    action,
    /for candidate_path in \/usr\/bin\/python3 \/usr\/bin\/python/,
  );
  assert.match(action, /perl_runtime=\/usr\/bin\/perl/);
  assert.match(action, /SMOKE_PYTHON_RUNTIME/);
  assert.match(action, /SMOKE_PERL_RUNTIME/);
  assert.match(action, /SMOKE_NODE_RUNTIME/);
  assert.match(action, /SMOKE_CMD_RUNTIME/);
  assert.match(action, /System32\\cmd\.exe/);
  assert.match(action, /Verify dependency-free runtime artifacts on Unix/);
  assert.match(action, /Verify dependency-free runtime artifacts on Windows/);
  assert.match(action, /test -f "\$\{SMOKE_ROOT\}\/sh\.txt"/);
  assert.match(action, /test -f "\$\{SMOKE_ROOT\}\/python\.json"/);
  assert.match(action, /test -f "\$\{SMOKE_ROOT\}\/perl\.txt"/);
  assert.match(action, /Test-Path -LiteralPath \$pythonPath -PathType Leaf/);
  assert.match(action, /@\('cmd\.txt', 'powershell\.json', 'node\.json'\)/);
  assert.match(action, /Exercise verified MSI cleanup on Windows/);
  assert.match(action, /WindowsInstaller -ne 1/);
  assert.match(action, /remove-gh-cli: "true"/);
  assert.match(action, /GitHub CLI MSI registration remains/);
  assert.doesNotMatch(action, /cleanup-profile: max/);

  const workflow = await readFile(".github/workflows/test.yml", "utf8");
  assert.match(workflow, /\(\( RECLAIMED > 0 \)\)/);
  assert.match(workflow, /Prepare disposable Docker prune fixtures/);
  assert.match(workflow, /remove-docker-images: "true"/);
  assert.match(workflow, /DOCKER_PRUNE_ANONYMOUS_VOLUME/);
  assert.match(workflow, /docker volume inspect "\$DOCKER_PRUNE_NAMED_VOLUME"/);
  assert.match(workflow, /maximize-github-runner-space-docker-config-\*/);
  assert.match(workflow, /--test-reporter=tap/);
  assert.match(workflow, /Exercise same-device bind-mount deletion guard/);
  assert.match(workflow, /RUN_NATIVE_BIND_MOUNT_TEST=1/);
  assert.match(
    workflow,
    /Linux hosted smoke rejects a same-device bind mount in both removal helpers/,
  );
  assert.match(workflow, /grep -Fx '# pass 1'/);
  assert.match(workflow, /grep -Fx '# fail 0'/);
  assert.match(workflow, /\^# pass 1\\r\?\$/);
  assert.match(workflow, /\$executedTests\.Count -ne 1/);
  const recordMaxRuntimes = workflow.indexOf(
    "Record dependency-free OS runtimes before no-input max",
  );
  const noInputMax = workflow.indexOf("Run historical no-input max profile");
  const verifyMaxRuntimes = workflow.indexOf(
    "Exercise dependency-free OS runtimes after no-input max",
  );
  assert.ok(recordMaxRuntimes > 0 && recordMaxRuntimes < noInputMax);
  assert.ok(verifyMaxRuntimes > noInputMax);
  assert.match(workflow, /MAX_BASH_RUNTIME=\/bin\/bash/);
  assert.match(workflow, /MAX_SH_RUNTIME=\/bin\/sh/);
  assert.match(workflow, /MAX_PYTHON_RUNTIME/);
  assert.match(workflow, /MAX_PERL_RUNTIME/);
  assert.match(workflow, /Python max-profile JSON round trip failed/);
});

test("lint bootstrap dependencies are exact and hash locked", async () => {
  const workflow = await readFile(".github/workflows/lint.yml", "utf8");
  const requirements = await readFile(
    ".github/requirements/pre-commit.txt",
    "utf8",
  );
  assert.match(workflow, /python-version: "3\.14\.0"/);
  assert.match(workflow, /--require-hashes/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(requirements, /^--only-binary=:all:$/m);
  assert.doesNotMatch(requirements, /^[A-Za-z0-9_.-]+(?:>=|~=|>|<)/m);
  const pins = [...requirements.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)/gm)];
  const hashes = [...requirements.matchAll(/--hash=sha256:[a-f0-9]{64}/g)];
  assert.deepEqual(pins.map((match) => match[1]?.toLowerCase()).sort(), [
    "cfgv",
    "distlib",
    "filelock",
    "fix-smartquotes",
    "identify",
    "nodeenv",
    "pathspec",
    "platformdirs",
    "pre-commit",
    "pre-commit-hooks",
    "python-discovery",
    "pyyaml",
    "ruamel.yaml",
    "virtualenv",
    "yamllint",
  ]);
  assert.ok(hashes.length >= pins.length);
  for (const [index, pin] of pins.entries()) {
    const start = pin.index ?? 0;
    const end = pins[index + 1]?.index ?? requirements.length;
    assert.match(
      requirements.slice(start, end),
      /--hash=sha256:[a-f0-9]{64}/,
      `${pin[1]} is missing a wheel hash`,
    );
  }

  const packageDocument = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const packageLock = JSON.parse(
    await readFile("package-lock.json", "utf8"),
  ) as {
    packages?: Record<
      string,
      { integrity?: string; resolved?: string; version?: string }
    >;
  };
  assert.equal(
    packageDocument.devDependencies?.["markdownlint-cli2"],
    "0.23.2",
  );
  const lockedMarkdownlint =
    packageLock.packages?.["node_modules/markdownlint-cli2"];
  assert.equal(lockedMarkdownlint?.version, "0.23.2");
  assert.equal(
    lockedMarkdownlint?.resolved,
    "https://registry.npmjs.org/markdownlint-cli2/-/markdownlint-cli2-0.23.2.tgz",
  );
  assert.match(lockedMarkdownlint?.integrity ?? "", /^sha512-[A-Za-z0-9+/=]+$/);
});

test("actionlint uses a checksum-locked binary without Go module resolution", async () => {
  const workflow = await readFile(".github/workflows/lint.yml", "utf8");
  assert.match(workflow, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(
    workflow,
    /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/,
  );
  assert.match(
    workflow,
    /c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4/,
  );
  assert.match(workflow, /sha256sum --check --strict/);
  assert.match(workflow, /--no-same-owner --no-same-permissions/);
  assert.match(
    workflow,
    /install_root="\$\{GITHUB_WORKSPACE\}\/node_modules\/\.bin"/,
  );
  assert.doesNotMatch(workflow, /GITHUB_PATH/);
  assert.doesNotMatch(workflow, /\bgo (?:install|build|get|mod)\b/);
});

test("Dependabot maintains the Python lint lock", async () => {
  const dependabot = await readFile(".github/dependabot.yml", "utf8");
  assert.match(
    dependabot,
    /package-ecosystem: pip\n    directory: "\/\.github\/requirements"/,
  );
});

test("action reference discovery covers named and anonymous steps", () => {
  assert.deepEqual(
    actionReferences(
      [
        "steps:",
        "  - uses: owner/anonymous@0123456789012345678901234567890123456789",
        "  - name: Named action",
        "    uses: owner/named@9876543210987654321098765432109876543210",
      ].join("\n"),
    ),
    [
      "owner/anonymous@0123456789012345678901234567890123456789",
      "owner/named@9876543210987654321098765432109876543210",
    ],
  );
});

test("the exact-label sweep stays aligned with runner support docs", async () => {
  const workflow = await readFile(
    ".github/workflows/compatibility.yml",
    "utf8",
  );
  const documented = await readFile("docs/RUNNER-SUPPORT.md", "utf8");
  const workflowLabels = [
    ...workflow.matchAll(/^\s*- runner: ([a-z0-9.-]+)$/gm),
  ].map((match) => match[1] ?? "");
  const markedSection = documented
    .split("<!-- compatibility-labels:start -->")[1]
    ?.split("<!-- compatibility-labels:end -->")[0];
  assert.ok(
    markedSection,
    "runner support compatibility-label section missing",
  );
  const documentedLabels = [...markedSection.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1] ?? "",
  );

  assert.equal(new Set(workflowLabels).size, workflowLabels.length);
  assert.equal(new Set(documentedLabels).size, documentedLabels.length);
  assert.deepEqual([...workflowLabels].sort(), [...documentedLabels].sort());
});
