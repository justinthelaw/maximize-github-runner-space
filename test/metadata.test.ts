import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { COMPONENTS } from "../src/components.js";
import {
  isWindowsReparsePoint,
  observeStableWindowsPaths,
  readWindowsFileAttributes,
} from "../src/windows-path.js";

function keysInSection(document: string, start: string, end: string): string[] {
  const section =
    document.split(`${start}:\n`)[1]?.split(`\n${end}:\n`)[0] ?? "";
  return [...section.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(
    (match) => match[1] ?? "",
  );
}

function assertLocalActionEntryIsNotSymlink(
  entry: { readonly isSymbolicLink: () => boolean },
  path: string,
): void {
  if (entry.isSymbolicLink()) {
    throw new Error(`Refusing symlinked local action entry: '${path}'.`);
  }
}

interface LocalActionPathInspection {
  readonly kind: "directory" | "file" | "other";
  readonly isLink: boolean;
  readonly isReparsePoint: boolean;
}

interface LocalActionPathStats {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface LocalActionPathProbe {
  readonly platform?: NodeJS.Platform;
  readonly lstat?: (path: string) => Promise<LocalActionPathStats>;
  readonly fileAttributes?: (
    paths: readonly string[],
  ) => Promise<readonly number[]>;
}

interface LocalActionDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface LocalActionDiscoveryDependencies {
  readonly inspectPath?: (path: string) => Promise<LocalActionPathInspection>;
  readonly readDirectory?: (
    path: string,
  ) => Promise<readonly LocalActionDirectoryEntry[]>;
}

async function inspectLocalActionPath(
  path: string,
  dependencies: LocalActionPathProbe = {},
): Promise<LocalActionPathInspection> {
  const inspectPath =
    dependencies.lstat ??
    (async (candidate: string) => await lstat(candidate, { bigint: true }));
  let stats = await inspectPath(path);
  let fileAttributes = 0;
  if ((dependencies.platform ?? process.platform) === "win32") {
    const observed = await observeStableWindowsPaths(
      [{ path, stats }],
      inspectPath,
      dependencies.fileAttributes ?? readWindowsFileAttributes,
    );
    const stable = observed[0];
    if (stable === undefined) {
      throw new Error(
        "Windows file attribute probe returned malformed output.",
      );
    }
    stats = stable.stats;
    fileAttributes = stable.fileAttributes;
  }
  return {
    kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
    isLink: stats.isSymbolicLink(),
    isReparsePoint: isWindowsReparsePoint(fileAttributes),
  };
}

async function localActionDefinitionFiles(
  directory: string,
  dependencies: LocalActionDiscoveryDependencies = {},
): Promise<string[]> {
  const inspectPath = dependencies.inspectPath ?? inspectLocalActionPath;
  const traversalRoot = await inspectPath(directory);
  if (
    traversalRoot.kind !== "directory" ||
    traversalRoot.isLink ||
    traversalRoot.isReparsePoint
  ) {
    throw new Error(
      `Refusing linked or reparse-point local action traversal root: '${directory}'.`,
    );
  }

  const readDirectory =
    dependencies.readDirectory ??
    (async (path: string): Promise<readonly LocalActionDirectoryEntry[]> =>
      await readdir(path, { withFileTypes: true }));
  const entries = await readDirectory(directory);
  for (const entry of entries) {
    assertLocalActionEntryIsNotSymlink(entry, join(directory, entry.name));
  }
  const inspectedEntries = await Promise.all(
    entries.map(
      async (entry) => await inspectPath(join(directory, entry.name)),
    ),
  );
  for (const [index, entry] of entries.entries()) {
    const path = join(directory, entry.name);
    const inspected = inspectedEntries[index];
    if (inspected === undefined) {
      throw new Error(`Unable to inspect local action entry: '${path}'.`);
    }
    if (inspected.isLink || inspected.isReparsePoint) {
      throw new Error(
        `Refusing linked or reparse local action entry: '${path}'.`,
      );
    }
    if (
      (entry.isDirectory() && inspected.kind !== "directory") ||
      (entry.isFile() && inspected.kind !== "file")
    ) {
      throw new Error(
        `Local action entry changed during discovery: '${path}'.`,
      );
    }
  }
  const nested = await Promise.all(
    entries.map(async (entry, index) => {
      const path = join(directory, entry.name);
      const inspected = inspectedEntries[index];
      if (entry.isDirectory() && inspected?.kind === "directory")
        return await localActionDefinitionFiles(path, dependencies);
      const isActionMetadata =
        entry.name === "action.yml" || entry.name === "action.yaml";
      return entry.isFile() && inspected?.kind === "file" && isActionMetadata
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

async function actionDefinitionFiles(): Promise<string[]> {
  const workflows = (await readdir(".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => `.github/workflows/${file}`);

  return [
    ...workflows,
    ...(await localActionDefinitionFiles(".github/actions")).map((path) =>
      path.split(sep).join("/"),
    ),
  ].sort();
}

function actionReferences(document: string): string[] {
  const references: string[] = [];
  let blockScalarIndentation: number | undefined;
  for (const line of document.split("\n")) {
    if (blockScalarIndentation !== undefined) {
      if (line.trim() === "") continue;
      if (leadingSpaces(line) > blockScalarIndentation) continue;
      blockScalarIndentation = undefined;
    }
    if (/:[ \t]*[|>][+-]?(?:[ \t]+#.*)?$/.test(line)) {
      blockScalarIndentation = leadingSpaces(line);
      continue;
    }
    const match = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)/.exec(line);
    if (match?.[1] !== undefined) references.push(match[1]);
  }
  return references;
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function uniqueLine(
  document: string,
  predicate: (line: string) => boolean,
  description: string,
): { readonly lines: string[]; readonly index: number } {
  const lines = document.split("\n");
  const matches = lines.flatMap((line, index) =>
    predicate(line) ? [index] : [],
  );
  assert.equal(matches.length, 1, `expected exactly one ${description}`);
  return { lines, index: matches[0] ?? -1 };
}

function indentedSection(
  document: string,
  header: string,
  indentation: number,
): string {
  const expected = `${" ".repeat(indentation)}${header}`;
  const { lines, index: start } = uniqueLine(
    document,
    (line) => line === expected,
    `${header} at indentation ${indentation}`,
  );
  let end = start + 1;
  while (
    end < lines.length &&
    (lines[end] === "" || leadingSpaces(lines[end] ?? "") > indentation)
  ) {
    end += 1;
  }
  while (end > start + 1 && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

function workflowJob(document: string, name: string): string {
  return indentedSection(document, `${name}:`, 2);
}

function workflowJobNames(document: string): string[] {
  const jobs = indentedSection(document, "jobs:", 0);
  return jobs.split("\n").flatMap((line) => {
    const match = /^  (\S[^:]*):(?:\s.*)?$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function stepBlocks(document: string, indentation: number): string[] {
  const lines = document.split("\n");
  const prefix = `${" ".repeat(indentation)}- `;
  const starts = lines.flatMap((line, index) =>
    line.startsWith(prefix) ? [index] : [],
  );
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    return lines.slice(start, end).join("\n").trimEnd();
  });
}

function stepName(step: string, indentation: number): string {
  const prefix = `${" ".repeat(indentation)}- name: `;
  const first = step.split("\n")[0] ?? "";
  assert.ok(first.startsWith(prefix), `unnamed step: ${first}`);
  return first.slice(prefix.length);
}

function stepNames(document: string, indentation: number): string[] {
  return stepBlocks(document, indentation).map((step) =>
    stepName(step, indentation),
  );
}

interface LocalActionInvocation {
  readonly scope: string;
  readonly step: string;
  readonly uses: string;
  readonly with: Record<string, string>;
}

function localActionInvocations(
  document: string,
  scope: string,
  stepIndentation: number,
): LocalActionInvocation[] {
  return stepBlocks(document, stepIndentation).flatMap((step) => {
    const uses = directValues(step, "uses", stepIndentation + 2);
    assert.ok(uses.length <= 1, `duplicate uses in ${scope}`);
    const reference = uses[0];
    if (reference === undefined || !reference.startsWith("./")) return [];
    const withValues = directValues(step, "with", stepIndentation + 2);
    assert.ok(withValues.length <= 1, `duplicate with in ${scope}`);
    return [
      {
        scope,
        step: stepName(step, stepIndentation),
        uses: reference,
        with:
          withValues.length === 0
            ? {}
            : directMapping(step, "with", stepIndentation + 2),
      },
    ];
  });
}

function assertNoFailureMasking(
  document: string,
  stepIndentation: number,
): void {
  assert.deepEqual(directValues(document, "continue-on-error", 4), []);
  for (const step of stepBlocks(document, stepIndentation)) {
    assert.deepEqual(
      directValues(step, "continue-on-error", stepIndentation + 2),
      [],
    );
  }
}

function matrixInclude(job: string): string {
  const strategy = indentedSection(job, "strategy:", 4);
  const matrix = indentedSection(strategy, "matrix:", 6);
  return indentedSection(matrix, "include:", 8);
}

function assertWorkflowTopology(
  compatibility: string,
  pullRequest: string,
  lint: string,
  smokeAction: string,
): void {
  assert.deepEqual(workflowJobNames(compatibility), [
    "exact-image-smoke",
    "generated-dist",
    "default-max",
  ]);
  assert.deepEqual(workflowJobNames(pullRequest), [
    "static-validation",
    "ubuntu-x64",
    "platform-smoke",
  ]);
  assert.deepEqual(workflowJobNames(lint), ["pre-commit"]);

  const exactImage = workflowJob(compatibility, "exact-image-smoke");
  const generatedDist = workflowJob(compatibility, "generated-dist");
  const defaultMax = workflowJob(compatibility, "default-max");
  const staticValidation = workflowJob(pullRequest, "static-validation");
  const ubuntu = workflowJob(pullRequest, "ubuntu-x64");
  const platformSmoke = workflowJob(pullRequest, "platform-smoke");
  const preCommit = workflowJob(lint, "pre-commit");

  assert.deepEqual(stepNames(exactImage, 6), [
    "Checkout",
    "Use the minimum supported Node.js version for the native Windows probe",
    "Install locked dependencies for the native Windows probe",
    "Compile the native Windows probe regression",
    "Exercise the native Windows PowerShell probe",
    "Validate native Visual Studio inventory without mutation",
    "Exercise the native adapter",
  ]);
  assert.deepEqual(stepNames(generatedDist, 6), [
    "Checkout",
    "Use the minimum supported Node.js version",
    "Install locked dependencies",
    "Verify committed action bundle",
  ]);
  assert.deepEqual(stepNames(defaultMax, 6), [
    "Checkout",
    "Run no-input default max",
    "Verify default-max outputs on Unix",
    "Verify default-max outputs on Windows",
  ]);
  assert.deepEqual(stepNames(staticValidation, 6), [
    "Checkout",
    "Use the minimum supported Node.js version",
    "Install locked dependencies",
    "Typecheck and unit tests",
    "Formatting",
    "Verify committed action bundle",
  ]);
  assert.deepEqual(stepNames(ubuntu, 6), [
    "Checkout",
    "Prepare a mounted Swift cleanup boundary",
    "Refuse Swift cleanup across a mounted descendant",
    "Verify mounted Swift cleanup failed before mutation",
    "Remove mounted Swift cleanup fixture",
    "Prepare untrusted swap utility shims",
    "Resize swapfile with the historical fractional syntax",
    "Verify configured swapfile",
    "Reject an unsafe oversized replacement",
    "Verify oversized request rolled back",
    "Assert protected and removable fixtures exist",
    "Preserve exact custom-toggle semantics",
    "Verify non-lowercase toggle stayed disabled",
    "Reject an invalid profile before mutation",
    "Reject an invalid skip before mutation",
    "Verify validation failures and fixtures",
    "Exercise normalized max skips and toolcache precedence",
    "Verify skipped children survived and sibling cleanup ran",
    "Remove the managed swapfile",
    "Verify swapfile removal",
  ]);
  assert.deepEqual(stepNames(platformSmoke, 6), [
    "Checkout",
    "Use the minimum supported Node.js version for the native Windows probe",
    "Install locked dependencies for the native Windows probe",
    "Compile the native Windows probe regression",
    "Exercise the native Windows PowerShell probe",
    "Validate native Visual Studio inventory without mutation",
    "Assert Windows PostgreSQL fixture and service exist",
    "Exercise Windows PostgreSQL cleanup",
    "Verify Windows PostgreSQL cleanup",
    "Exercise the native adapter",
  ]);
  assert.deepEqual(stepNames(smokeAction, 4), [
    "Assert AzCopy fixture exists on Unix",
    "Assert AzCopy fixture exists on Windows",
    "Run a bounded native cleanup",
    "Verify runtime and outputs on Unix",
    "Verify runtime and outputs on Windows",
    "Prepare an untrusted Homebrew PATH shim on macOS",
    "Exercise verified Homebrew cleanup on macOS",
    "Verify the Homebrew package and prefix boundary on macOS",
  ]);
  assert.deepEqual(stepNames(preCommit, 6), [
    "Checkout",
    "Setup Python",
    "Install Pre-Commit",
    "Run Pre-Commits",
  ]);

  const invocations = [
    ...localActionInvocations(exactImage, "compatibility/exact-image-smoke", 6),
    ...localActionInvocations(generatedDist, "compatibility/generated-dist", 6),
    ...localActionInvocations(defaultMax, "compatibility/default-max", 6),
    ...localActionInvocations(staticValidation, "test/static-validation", 6),
    ...localActionInvocations(ubuntu, "test/ubuntu-x64", 6),
    ...localActionInvocations(platformSmoke, "test/platform-smoke", 6),
    ...localActionInvocations(preCommit, "lint/pre-commit", 6),
    ...localActionInvocations(smokeAction, "platform-smoke composite", 4),
  ];
  assert.deepEqual(invocations, [
    {
      scope: "compatibility/exact-image-smoke",
      step: "Exercise the native adapter",
      uses: "./.github/actions/platform-smoke",
      with: {
        "expected-platform": "${{ matrix.platform }}",
        "expected-architecture": "${{ matrix.architecture }}",
      },
    },
    {
      scope: "compatibility/default-max",
      step: "Run no-input default max",
      uses: "./",
      with: {},
    },
    {
      scope: "test/ubuntu-x64",
      step: "Refuse Swift cleanup across a mounted descendant",
      uses: "./",
      with: { "cleanup-profile": "custom", "remove-swift": '"true"' },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Resize swapfile with the historical fractional syntax",
      uses: "./",
      with: { "cleanup-profile": "custom", "swapfile-size": "1.5GiB" },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Reject an unsafe oversized replacement",
      uses: "./",
      with: { "cleanup-profile": "custom", "swapfile-size": "100TiB" },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Preserve exact custom-toggle semantics",
      uses: "./",
      with: { "cleanup-profile": "custom", "remove-azcopy": '"TRUE"' },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Reject an invalid profile before mutation",
      uses: "./",
      with: { "cleanup-profile": "invalid-profile" },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Reject an invalid skip before mutation",
      uses: "./",
      with: {
        "cleanup-profile": "max",
        "skip-components": "dotnet,not-a-component",
      },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Exercise normalized max skips and toolcache precedence",
      uses: "./",
      with: {
        "cleanup-profile": '" MaX "',
        "skip-components": '" DotNet , Cached-Node , Firefox , Maven "',
      },
    },
    {
      scope: "test/ubuntu-x64",
      step: "Remove the managed swapfile",
      uses: "./",
      with: { "cleanup-profile": "custom", "swapfile-size": '"0"' },
    },
    {
      scope: "test/platform-smoke",
      step: "Exercise Windows PostgreSQL cleanup",
      uses: "./",
      with: {
        "cleanup-profile": "custom",
        "remove-postgresql": '"true"',
      },
    },
    {
      scope: "test/platform-smoke",
      step: "Exercise the native adapter",
      uses: "./.github/actions/platform-smoke",
      with: {
        "expected-platform": "${{ matrix.platform }}",
        "expected-architecture": "${{ matrix.architecture }}",
      },
    },
    {
      scope: "platform-smoke composite",
      step: "Run a bounded native cleanup",
      uses: "./",
      with: { "cleanup-profile": "custom", "remove-azcopy": '"true"' },
    },
    {
      scope: "platform-smoke composite",
      step: "Exercise verified Homebrew cleanup on macOS",
      uses: "./",
      with: { "cleanup-profile": "custom", "remove-gh-cli": '"true"' },
    },
  ]);
  const noInputRoot = invocations.filter(
    ({ uses, with: inputs }) =>
      uses === "./" && Object.keys(inputs).length === 0,
  );
  assert.deepEqual(
    noInputRoot.map(({ scope, step }) => ({ scope, step })),
    [
      {
        scope: "compatibility/default-max",
        step: "Run no-input default max",
      },
    ],
  );

  assert.equal(directValue(exactImage, "runs-on", 4), "${{ matrix.runner }}");
  assert.equal(directValue(exactImage, "timeout-minutes", 4), "12");
  assert.equal(
    directValue(generatedDist, "if", 4),
    "github.event_name == 'workflow_dispatch'",
  );
  assert.equal(directValue(generatedDist, "runs-on", 4), "ubuntu-latest");
  assert.equal(directValue(generatedDist, "timeout-minutes", 4), "15");
  assert.equal(
    directValue(defaultMax, "if", 4),
    "github.event_name == 'workflow_dispatch'",
  );
  assert.equal(directValue(defaultMax, "needs", 4), "generated-dist");
  assert.equal(directValue(defaultMax, "runs-on", 4), "${{ matrix.runner }}");
  assert.equal(
    directValue(defaultMax, "timeout-minutes", 4),
    "${{ matrix.timeout }}",
  );
  assert.equal(directValue(staticValidation, "runs-on", 4), "ubuntu-latest");
  assert.equal(directValue(staticValidation, "timeout-minutes", 4), "10");
  assert.equal(directValue(ubuntu, "needs", 4), "static-validation");
  assert.equal(directValue(ubuntu, "runs-on", 4), "ubuntu-latest");
  assert.equal(directValue(ubuntu, "timeout-minutes", 4), "20");
  assert.equal(directValue(platformSmoke, "needs", 4), "static-validation");
  assert.equal(
    directValue(platformSmoke, "runs-on", 4),
    "${{ matrix.runner }}",
  );
  assert.equal(directValue(platformSmoke, "timeout-minutes", 4), "12");

  const defaultRows = [
    ...matrixInclude(defaultMax).matchAll(
      /^\s+- \{runner: ([a-z0-9.-]+), platform: (linux|windows|macos), architecture: (x64|arm64), timeout: (\d+)\}$/gm,
    ),
  ].map(([, runner, platform, architecture, timeout]) => ({
    runner,
    platform,
    architecture,
    timeout: Number(timeout),
  }));
  assert.deepEqual(defaultRows, [
    {
      runner: "ubuntu-latest",
      platform: "linux",
      architecture: "x64",
      timeout: 30,
    },
    {
      runner: "ubuntu-24.04-arm",
      platform: "linux",
      architecture: "arm64",
      timeout: 30,
    },
    {
      runner: "ubuntu-slim",
      platform: "linux",
      architecture: "x64",
      timeout: 12,
    },
    {
      runner: "windows-latest",
      platform: "windows",
      architecture: "x64",
      timeout: 120,
    },
    {
      runner: "windows-11-arm",
      platform: "windows",
      architecture: "arm64",
      timeout: 120,
    },
    {
      runner: "macos-latest",
      platform: "macos",
      architecture: "arm64",
      timeout: 90,
    },
    {
      runner: "macos-15-intel",
      platform: "macos",
      architecture: "x64",
      timeout: 90,
    },
  ]);
  const exactImageRows = [
    ...matrixInclude(exactImage).matchAll(
      /^\s*- runner: ([a-z0-9.-]+)\n\s+platform: (linux|windows|macos)\n\s+architecture: (x64|arm64)$/gm,
    ),
  ].map(([, runner, platform, architecture]) => ({
    runner,
    platform,
    architecture,
  }));
  assert.deepEqual(exactImageRows, [
    { runner: "ubuntu-slim", platform: "linux", architecture: "x64" },
    { runner: "ubuntu-22.04", platform: "linux", architecture: "x64" },
    { runner: "ubuntu-24.04", platform: "linux", architecture: "x64" },
    { runner: "ubuntu-26.04", platform: "linux", architecture: "x64" },
    { runner: "ubuntu-22.04-arm", platform: "linux", architecture: "arm64" },
    { runner: "ubuntu-24.04-arm", platform: "linux", architecture: "arm64" },
    { runner: "ubuntu-26.04-arm", platform: "linux", architecture: "arm64" },
    { runner: "windows-2022", platform: "windows", architecture: "x64" },
    { runner: "windows-2025", platform: "windows", architecture: "x64" },
    { runner: "windows-2025-vs2026", platform: "windows", architecture: "x64" },
    { runner: "windows-11-arm", platform: "windows", architecture: "arm64" },
    {
      runner: "windows-11-vs2026-arm",
      platform: "windows",
      architecture: "arm64",
    },
    { runner: "macos-15-intel", platform: "macos", architecture: "x64" },
    { runner: "macos-26-intel", platform: "macos", architecture: "x64" },
    { runner: "macos-14", platform: "macos", architecture: "arm64" },
    { runner: "macos-15", platform: "macos", architecture: "arm64" },
    { runner: "macos-26", platform: "macos", architecture: "arm64" },
    { runner: "xcode-27", platform: "macos", architecture: "arm64" },
  ]);
  const platformRows = [
    ...matrixInclude(platformSmoke).matchAll(
      /^\s+- name: (.+)\n\s+runner: ([a-z0-9.-]+)\n\s+platform: (linux|windows|macos)\n\s+architecture: (x64|arm64)$/gm,
    ),
  ].map(([, name, runner, platform, architecture]) => ({
    name,
    runner,
    platform,
    architecture,
  }));
  assert.deepEqual(platformRows, [
    {
      name: "Ubuntu arm64",
      runner: "ubuntu-24.04-arm",
      platform: "linux",
      architecture: "arm64",
    },
    {
      name: "Ubuntu slim",
      runner: "ubuntu-slim",
      platform: "linux",
      architecture: "x64",
    },
    {
      name: "Windows x64",
      runner: "windows-latest",
      platform: "windows",
      architecture: "x64",
    },
    {
      name: "Windows arm64",
      runner: "windows-11-arm",
      platform: "windows",
      architecture: "arm64",
    },
    {
      name: "macOS arm64",
      runner: "macos-latest",
      platform: "macos",
      architecture: "arm64",
    },
    {
      name: "macOS Intel",
      runner: "macos-15-intel",
      platform: "macos",
      architecture: "x64",
    },
  ]);

  for (const job of [exactImage, generatedDist, defaultMax, platformSmoke]) {
    assertNoFailureMasking(job, 6);
  }
  assertNoFailureMasking(smokeAction, 4);
}

function namedStep(document: string, name: string): string {
  const marker = `- name: ${name}`;
  const { lines, index: start } = uniqueLine(
    document,
    (line) => line === `${" ".repeat(leadingSpaces(line))}${marker}`,
    `step named ${name}`,
  );
  const indentation = leadingSpaces(lines[start] ?? "");
  let end = start + 1;
  while (
    end < lines.length &&
    (lines[end] === "" || leadingSpaces(lines[end] ?? "") > indentation)
  ) {
    end += 1;
  }
  while (end > start + 1 && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

function directValues(
  document: string,
  key: string,
  indentation: number,
): string[] {
  const prefix = `${" ".repeat(indentation)}${key}:`;
  return document.split("\n").flatMap((line) => {
    if (!line.startsWith(prefix)) return [];
    const value = line.slice(prefix.length);
    if (value !== "" && !value.startsWith(" ")) return [];
    return [value === "" ? value : value.slice(1)];
  });
}

function directValue(
  document: string,
  key: string,
  indentation: number,
): string {
  const values = directValues(document, key, indentation);
  assert.equal(
    values.length,
    1,
    `expected exactly one ${key} at indentation ${indentation}`,
  );
  return values[0] ?? "";
}

function directMapping(
  document: string,
  key: string,
  indentation: number,
): Record<string, string> {
  assert.equal(directValue(document, key, indentation), "");
  const section = indentedSection(document, `${key}:`, indentation);
  const entryIndentation = indentation + 2;
  const entries: Record<string, string> = {};
  for (const line of section.split("\n").slice(1)) {
    if (leadingSpaces(line) !== entryIndentation) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/);
    assert.ok(match, `invalid direct ${key} entry: ${line}`);
    const entry = match[1] ?? "";
    assert.equal(entries[entry], undefined, `duplicate ${key} entry: ${entry}`);
    entries[entry] = match[2] ?? "";
  }
  return entries;
}

function literalBlock(
  document: string,
  key: string,
  indentation: number,
): string {
  assert.equal(directValue(document, key, indentation), "|");
  const section = indentedSection(document, `${key}: |`, indentation);
  const contentIndentation = " ".repeat(indentation + 2);
  const lines = section.split("\n").slice(1);
  for (const line of lines) {
    assert.ok(
      line === "" || line.startsWith(contentIndentation),
      `${key} content has invalid indentation: ${line}`,
    );
  }
  return lines.map((line) => line.slice(contentIndentation.length)).join("\n");
}

function replaceRequired(
  document: string,
  before: string,
  after: string,
): string {
  if (!document.includes(before)) {
    throw new Error(`mutation source is missing: ${before}`);
  }
  return document.replace(before, after);
}

function survivingMutations(
  mutations: readonly {
    readonly name: string;
    readonly exercise: () => void;
  }[],
): string[] {
  return mutations.flatMap(({ name, exercise }) => {
    try {
      exercise();
      return [name];
    } catch (error) {
      if (error instanceof assert.AssertionError) return [];
      throw error;
    }
  });
}

function assertExactImageSmokeContract(
  exactImageJob: string,
  smokeAction: string,
): void {
  const strategy = indentedSection(exactImageJob, "strategy:", 4);
  assert.equal(directValue(strategy, "fail-fast", 6), "false");
  assert.equal(directValue(strategy, "max-parallel", 6), "3");
  assert.equal(directValue(exactImageJob, "timeout-minutes", 4), "12");

  const exerciseNativeAdapter = namedStep(
    exactImageJob,
    "Exercise the native adapter",
  );
  assert.equal(
    directValue(exerciseNativeAdapter, "uses", 8),
    "./.github/actions/platform-smoke",
  );
  assert.deepEqual(directMapping(exerciseNativeAdapter, "with", 8), {
    "expected-platform": "${{ matrix.platform }}",
    "expected-architecture": "${{ matrix.architecture }}",
  });

  const primaryCleanup = namedStep(smokeAction, "Run a bounded native cleanup");
  assert.equal(directValue(primaryCleanup, "id", 6), "cleanup");
  assert.equal(directValue(primaryCleanup, "uses", 6), "./");
  assert.deepEqual(directMapping(primaryCleanup, "with", 6), {
    "cleanup-profile": "custom",
    "remove-azcopy": '"true"',
  });
}

function assertDefaultMaxOutputContract(defaultMaxJob: string): void {
  const strategy = indentedSection(defaultMaxJob, "strategy:", 4);
  assert.equal(directValue(strategy, "fail-fast", 6), "false");
  assert.equal(directValue(strategy, "max-parallel", 6), "3");
  assert.equal(
    directValue(defaultMaxJob, "timeout-minutes", 4),
    "${{ matrix.timeout }}",
  );

  const cleanup = namedStep(defaultMaxJob, "Run no-input default max");
  assert.equal(directValue(cleanup, "id", 8), "cleanup");
  assert.equal(directValue(cleanup, "uses", 8), "./");
  assert.deepEqual(directValues(cleanup, "with", 8), []);

  const verifyUnix = namedStep(
    defaultMaxJob,
    "Verify default-max outputs on Unix",
  );
  assert.equal(
    directValue(verifyUnix, "if", 8),
    "matrix.platform != 'windows'",
  );
  assert.equal(directValue(verifyUnix, "shell", 8), "bash");
  assert.deepEqual(directMapping(verifyUnix, "env", 8), {
    BEFORE: "${{ steps.cleanup.outputs.available-bytes-before }}",
    AFTER: "${{ steps.cleanup.outputs.available-bytes-after }}",
    RECLAIMED: "${{ steps.cleanup.outputs.reclaimed-bytes }}",
    FAILED_OPERATIONS: "${{ steps.cleanup.outputs.failed-operations }}",
    PLATFORM: "${{ steps.cleanup.outputs.platform }}",
    ARCHITECTURE: "${{ steps.cleanup.outputs.architecture }}",
    EXPECTED_PLATFORM: "${{ matrix.platform }}",
    EXPECTED_ARCHITECTURE: "${{ matrix.architecture }}",
  });
  assert.equal(
    literalBlock(verifyUnix, "run", 8),
    [
      "set -euo pipefail",
      '[[ "$BEFORE" =~ ^[0-9]+$ ]]',
      '[[ "$AFTER" =~ ^[0-9]+$ ]]',
      '[[ "$RECLAIMED" =~ ^[0-9]+$ ]]',
      '[[ "$FAILED_OPERATIONS" == 0 ]]',
      '[[ "$PLATFORM" == "$EXPECTED_PLATFORM" ]]',
      '[[ "$ARCHITECTURE" == "$EXPECTED_ARCHITECTURE" ]]',
    ].join("\n"),
  );

  const verifyWindows = namedStep(
    defaultMaxJob,
    "Verify default-max outputs on Windows",
  );
  assert.equal(
    directValue(verifyWindows, "if", 8),
    "matrix.platform == 'windows'",
  );
  assert.equal(directValue(verifyWindows, "shell", 8), "powershell");
  assert.deepEqual(directMapping(verifyWindows, "env", 8), {
    BEFORE: "${{ steps.cleanup.outputs.available-bytes-before }}",
    AFTER: "${{ steps.cleanup.outputs.available-bytes-after }}",
    RECLAIMED: "${{ steps.cleanup.outputs.reclaimed-bytes }}",
    FAILED_OPERATIONS: "${{ steps.cleanup.outputs.failed-operations }}",
    PLATFORM: "${{ steps.cleanup.outputs.platform }}",
    ARCHITECTURE: "${{ steps.cleanup.outputs.architecture }}",
    EXPECTED_PLATFORM: "${{ matrix.platform }}",
    EXPECTED_ARCHITECTURE: "${{ matrix.architecture }}",
  });
  assert.equal(
    literalBlock(verifyWindows, "run", 8),
    [
      "if ($env:BEFORE -notmatch '^\\d+$') { throw 'Invalid before output.' }",
      "if ($env:AFTER -notmatch '^\\d+$') { throw 'Invalid after output.' }",
      "if ($env:RECLAIMED -notmatch '^\\d+$') { throw 'Invalid reclaimed output.' }",
      "if ($env:FAILED_OPERATIONS -ne '0') { throw 'A default-max operation failed.' }",
      "if ($env:PLATFORM -ne $env:EXPECTED_PLATFORM) { throw 'Platform mismatch.' }",
      "if ($env:ARCHITECTURE -ne $env:EXPECTED_ARCHITECTURE) { throw 'Architecture mismatch.' }",
    ].join("\n"),
  );
}

function assertMountedSwiftAndMavenContract(ubuntuJob: string): void {
  const prepare = namedStep(
    ubuntuJob,
    "Prepare a mounted Swift cleanup boundary",
  );
  assert.equal(directValue(prepare, "shell", 8), "bash");
  assert.equal(
    literalBlock(prepare, "run", 8),
    [
      "set -euo pipefail",
      'source="${RUNNER_TEMP}/maximize-space-swift-source"',
      'target="/usr/share/swift/maximize-space-bind-mount"',
      'marker="/usr/share/swift/maximize-space-ordinary-marker"',
      'owner="${RUNNER_TEMP}/maximize-space-swift-fixture-owned"',
      'test ! -e "$source"',
      'test ! -e "$target"',
      'test ! -e "$marker"',
      'test ! -e "$owner"',
      ': >"$owner"',
      'install -d "$source"',
      "printf '%s\\n' preserve-me >\"${source}/sentinel\"",
      'sudo install -d "$target"',
      'sudo touch "$marker"',
      'sudo mount --bind "$source" "$target"',
    ].join("\n"),
  );

  const refusal = namedStep(
    ubuntuJob,
    "Refuse Swift cleanup across a mounted descendant",
  );
  assert.equal(directValue(refusal, "id", 8), "mounted-swift");
  assert.equal(directValue(refusal, "continue-on-error", 8), "true");
  assert.equal(directValue(refusal, "uses", 8), "./");
  assert.deepEqual(directMapping(refusal, "with", 8), {
    "cleanup-profile": "custom",
    "remove-swift": '"true"',
  });

  const verifyRefusal = namedStep(
    ubuntuJob,
    "Verify mounted Swift cleanup failed before mutation",
  );
  assert.equal(directValue(verifyRefusal, "shell", 8), "bash");
  assert.deepEqual(directMapping(verifyRefusal, "env", 8), {
    OUTCOME: "${{ steps.mounted-swift.outcome }}",
  });
  assert.equal(
    literalBlock(verifyRefusal, "run", 8),
    [
      "set -euo pipefail",
      'source="${RUNNER_TEMP}/maximize-space-swift-source"',
      'target="/usr/share/swift/maximize-space-bind-mount"',
      'marker="/usr/share/swift/maximize-space-ordinary-marker"',
      '[[ "$OUTCOME" == failure ]]',
      'mountpoint -q "$target"',
      'test -f "${source}/sentinel"',
      'test -f "${target}/sentinel"',
      'test -f "$marker"',
      "test -d /usr/share/swift",
    ].join("\n"),
  );

  const cleanup = namedStep(ubuntuJob, "Remove mounted Swift cleanup fixture");
  assert.equal(directValue(cleanup, "if", 8), "always()");
  assert.equal(directValue(cleanup, "shell", 8), "bash");
  assert.equal(
    literalBlock(cleanup, "run", 8),
    [
      "set -euo pipefail",
      'source="${RUNNER_TEMP}/maximize-space-swift-source"',
      'target="/usr/share/swift/maximize-space-bind-mount"',
      'marker="/usr/share/swift/maximize-space-ordinary-marker"',
      'owner="${RUNNER_TEMP}/maximize-space-swift-fixture-owned"',
      'if [[ -f "$owner" ]]; then',
      '  if mountpoint -q "$target"; then',
      '    sudo umount "$target"',
      "  fi",
      '  sudo rm -rf -- "$target" "$marker"',
      '  rm -rf -- "$source" "$owner"',
      "fi",
    ].join("\n"),
  );

  const preconditions = namedStep(
    ubuntuJob,
    "Assert protected and removable fixtures exist",
  );
  const preconditionScript = literalBlock(preconditions, "run", 8);
  assert.match(preconditionScript, /^command -v mvn >\/dev\/null$/m);
  assert.match(preconditionScript, /^command -v java >\/dev\/null$/m);
  const maxSkip = namedStep(
    ubuntuJob,
    "Exercise normalized max skips and toolcache precedence",
  );
  assert.deepEqual(directMapping(maxSkip, "with", 8), {
    "cleanup-profile": '" MaX "',
    "skip-components": '" DotNet , Cached-Node , Firefox , Maven "',
  });
  const verifyMaven = namedStep(
    ubuntuJob,
    "Verify skipped children survived and sibling cleanup ran",
  );
  const mavenScript = literalBlock(verifyMaven, "run", 8);
  assert.match(mavenScript, /^command -v mvn >\/dev\/null$/m);
  assert.match(mavenScript, /^command -v java >\/dev\/null$/m);
  assert.match(mavenScript, /^mvn --batch-mode --version$/m);

  const orderedSteps = [
    prepare,
    refusal,
    verifyRefusal,
    cleanup,
    preconditions,
    maxSkip,
    verifyMaven,
  ];
  for (let index = 1; index < orderedSteps.length; index += 1) {
    assert.ok(
      ubuntuJob.indexOf(orderedSteps[index - 1] ?? "") <
        ubuntuJob.indexOf(orderedSteps[index] ?? ""),
      "mounted Swift and Maven steps are out of order",
    );
  }
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
  const [action, readme, configuration] = await Promise.all([
    readFile("action.yml", "utf8"),
    readFile("README.md", "utf8"),
    readFile("docs/CONFIGURATION.md", "utf8"),
  ]);
  const outputs = [
    "available-bytes-before",
    "available-bytes-after",
    "reclaimed-bytes",
    "failed-operations",
    "platform",
    "architecture",
  ];
  assert.deepEqual(keysInSection(action, "outputs", "runs"), outputs);
  assert.equal(
    action.split("outputs:\n")[1]?.split("\nruns:\n")[0]?.trimEnd(),
    [
      "  available-bytes-before:",
      '    description: "Available bytes on the runner system volume before cleanup"',
      "  available-bytes-after:",
      '    description: "Available bytes on the runner system volume after cleanup"',
      "  reclaimed-bytes:",
      '    description: "Net additional available bytes after cleanup"',
      "  failed-operations:",
      '    description: "Number of best-effort cleanup operations that reported failure"',
      "  platform:",
      '    description: "Detected platform: linux, macos, or windows"',
      "  architecture:",
      '    description: "Detected architecture: x64 or arm64"',
    ].join("\n"),
  );
  for (const output of outputs) {
    const row = new RegExp(`^\\| ${"`"}${output}${"`"} \\|`, "gm");
    assert.equal([...readme.matchAll(row)].length, 1, `${output} README row`);
    assert.equal(
      [...configuration.matchAll(row)].length,
      1,
      `${output} configuration row`,
    );
  }
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

test("action reference discovery covers named and anonymous steps", () => {
  assert.deepEqual(
    actionReferences(
      [
        "steps:",
        "  - uses: owner/anonymous@0123456789012345678901234567890123456789",
        "  - name: Named action",
        "    uses: owner/named@9876543210987654321098765432109876543210",
        "  - name: Script decoy",
        "    run: |",
        "      uses: owner/decoy@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "      jobs:",
        "        hidden:",
      ].join("\n"),
    ),
    [
      "owner/anonymous@0123456789012345678901234567890123456789",
      "owner/named@9876543210987654321098765432109876543210",
    ],
  );
});

test("local action discovery supports action.yaml without admitting near spellings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-actions-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ymlDirectory = join(root, "yml-action");
  const yamlDirectory = join(root, "nested", "yaml-action");
  await mkdir(ymlDirectory, { recursive: true });
  await mkdir(yamlDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(ymlDirectory, "action.yml"), "name: yml\n"),
    writeFile(join(yamlDirectory, "action.yaml"), "name: yaml\n"),
    writeFile(join(yamlDirectory, "action.yaml.bak"), "name: decoy\n"),
    writeFile(join(yamlDirectory, "action.yml.tmp"), "name: decoy\n"),
  ]);

  assert.deepEqual((await localActionDefinitionFiles(root)).sort(), [
    join(yamlDirectory, "action.yaml"),
    join(ymlDirectory, "action.yml"),
  ]);
});

test("local action discovery fails closed on symlinked entries", () => {
  assert.throws(
    () =>
      assertLocalActionEntryIsNotSymlink(
        { isSymbolicLink: () => true },
        ".github/actions/redirected",
      ),
    /refusing symlinked local action entry/i,
  );
});

test("local action path inspection acquires stable explicit Windows reparse attributes", async (t) => {
  const actionRoot = await mkdtemp(
    join(tmpdir(), "maximize-space-action-path-probe-"),
  );
  t.after(async () => await rm(actionRoot, { recursive: true, force: true }));
  const events: string[] = [];

  const inspected = await inspectLocalActionPath(actionRoot, {
    platform: "win32",
    lstat: async (path) => {
      assert.equal(path, actionRoot);
      events.push("lstat");
      return {
        dev: 1n,
        ino: 2n,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    },
    fileAttributes: async (paths) => {
      assert.deepEqual(paths, [actionRoot]);
      events.push("attributes");
      return [0x400];
    },
  });

  assert.deepEqual(inspected, {
    kind: "directory",
    isLink: false,
    isReparsePoint: true,
  });
  assert.deepEqual(events, ["lstat", "attributes", "lstat"]);
});

test("local action discovery rejects a symlinked traversal root", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink creation is not guaranteed on Windows hosts");
    return;
  }
  const fixture = await mkdtemp(
    join(tmpdir(), "maximize-space-action-root-link-"),
  );
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const actionRoot = join(fixture, "real-actions");
  const traversalRoot = join(fixture, "linked-actions");
  await mkdir(join(actionRoot, "sample"), { recursive: true });
  await writeFile(join(actionRoot, "sample", "action.yml"), "name: sample\n");
  await symlink(actionRoot, traversalRoot, "dir");

  await assert.rejects(
    localActionDefinitionFiles(traversalRoot),
    /traversal root.*(link|reparse)|(?:link|reparse).*traversal root/i,
  );
});

test("local action discovery fails closed on an injected reparse traversal root", async (t) => {
  const actionRoot = await mkdtemp(
    join(tmpdir(), "maximize-space-action-root-reparse-"),
  );
  t.after(async () => await rm(actionRoot, { recursive: true, force: true }));
  await writeFile(join(actionRoot, "action.yaml"), "name: sample\n");
  let directoryReads = 0;

  await assert.rejects(
    localActionDefinitionFiles(actionRoot, {
      inspectPath: async (path) => {
        assert.equal(path, actionRoot);
        return {
          kind: "directory",
          isLink: false,
          isReparsePoint: true,
        };
      },
      readDirectory: async () => {
        directoryReads += 1;
        return [];
      },
    }),
    /traversal root.*reparse|reparse.*traversal root/i,
  );
  assert.equal(directoryReads, 0);
});

test("local action discovery rejects an injected reparse manifest entry", async (t) => {
  const actionRoot = await mkdtemp(
    join(tmpdir(), "maximize-space-action-entry-reparse-"),
  );
  t.after(async () => await rm(actionRoot, { recursive: true, force: true }));
  const manifest = join(actionRoot, "action.yaml");
  await writeFile(manifest, "name: sample\n");

  await assert.rejects(
    localActionDefinitionFiles(actionRoot, {
      inspectPath: async (path) => ({
        kind: path === actionRoot ? "directory" : "file",
        isLink: false,
        isReparsePoint: path === manifest,
      }),
    }),
    /reparse.*local action entry|local action entry.*reparse/i,
  );
});

test("workflow structure enumerates every job, step, and local action invocation", async () => {
  assert.deepEqual(await actionDefinitionFiles(), [
    ".github/actions/platform-smoke/action.yml",
    ".github/workflows/compatibility.yml",
    ".github/workflows/lint.yml",
    ".github/workflows/test.yml",
  ]);
  const [compatibility, pullRequest, lint, smokeAction] = await Promise.all([
    readFile(".github/workflows/compatibility.yml", "utf8"),
    readFile(".github/workflows/test.yml", "utf8"),
    readFile(".github/workflows/lint.yml", "utf8"),
    readFile(".github/actions/platform-smoke/action.yml", "utf8"),
  ]);

  assertWorkflowTopology(compatibility, pullRequest, lint, smokeAction);
});

test("the exact-label sweep stays aligned with runner support docs", async () => {
  const [workflow, smokeAction] = await Promise.all([
    readFile(".github/workflows/compatibility.yml", "utf8"),
    readFile(".github/actions/platform-smoke/action.yml", "utf8"),
  ]);
  const documented = await readFile("docs/RUNNER-SUPPORT.md", "utf8");
  const exactImageJob = workflowJob(workflow, "exact-image-smoke");
  const workflowLabels = [
    ...matrixInclude(exactImageJob).matchAll(/^\s*- runner: ([a-z0-9.-]+)$/gm),
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
  assert.equal(workflowLabels.length, 18);
  assert.deepEqual([...workflowLabels].sort(), [...documentedLabels].sort());
  assertExactImageSmokeContract(exactImageJob, smokeAction);
});

test("manual release validation uses fresh runners for all seven classes", async () => {
  const workflow = await readFile(
    ".github/workflows/compatibility.yml",
    "utf8",
  );
  const generatedDistJob = workflowJob(workflow, "generated-dist");
  const defaultMaxJob = workflowJob(workflow, "default-max");
  const entries = [
    ...matrixInclude(defaultMaxJob).matchAll(
      /^\s+- \{runner: ([a-z0-9.-]+), platform: (linux|windows|macos), architecture: (x64|arm64), timeout: (\d+)\}$/gm,
    ),
  ].map(([, runner, platform, architecture, timeout]) => ({
    runner,
    platform,
    architecture,
    timeout: Number(timeout),
  }));

  assert.deepEqual(entries, [
    {
      runner: "ubuntu-latest",
      platform: "linux",
      architecture: "x64",
      timeout: 30,
    },
    {
      runner: "ubuntu-24.04-arm",
      platform: "linux",
      architecture: "arm64",
      timeout: 30,
    },
    {
      runner: "ubuntu-slim",
      platform: "linux",
      architecture: "x64",
      timeout: 12,
    },
    {
      runner: "windows-latest",
      platform: "windows",
      architecture: "x64",
      timeout: 120,
    },
    {
      runner: "windows-11-arm",
      platform: "windows",
      architecture: "arm64",
      timeout: 120,
    },
    {
      runner: "macos-latest",
      platform: "macos",
      architecture: "arm64",
      timeout: 90,
    },
    {
      runner: "macos-15-intel",
      platform: "macos",
      architecture: "x64",
      timeout: 90,
    },
  ]);
  assert.match(
    generatedDistJob,
    /if: github\.event_name == 'workflow_dispatch'[\s\S]*npm run check-dist/,
  );
  assert.match(
    defaultMaxJob,
    /if: github\.event_name == 'workflow_dispatch'\n\s+needs: generated-dist/,
  );
  assertDefaultMaxOutputContract(defaultMaxJob);
});

test("pull-request coverage proves mount refusal and implicit Java preservation", async () => {
  const workflow = await readFile(".github/workflows/test.yml", "utf8");
  const ubuntuJob = workflowJob(workflow, "ubuntu-x64");

  assertMountedSwiftAndMavenContract(ubuntuJob);
});

test("release workflow contracts reject path and ordering decoys", async () => {
  const [compatibility, smokeAction, pullRequest, lint] = await Promise.all([
    readFile(".github/workflows/compatibility.yml", "utf8"),
    readFile(".github/actions/platform-smoke/action.yml", "utf8"),
    readFile(".github/workflows/test.yml", "utf8"),
    readFile(".github/workflows/lint.yml", "utf8"),
  ]);
  const exactImageJob = workflowJob(compatibility, "exact-image-smoke");
  const defaultMaxJob = workflowJob(compatibility, "default-max");
  const ubuntuJob = workflowJob(pullRequest, "ubuntu-x64");
  const cleanup = namedStep(ubuntuJob, "Remove mounted Swift cleanup fixture");

  const hierarchyDecoy = replaceRequired(
    replaceRequired(
      exactImageJob,
      "      fail-fast: false",
      "      fail-fast: true",
    ),
    "      matrix:\n",
    "      matrix:\n        fail-fast: false\n",
  );
  const duplicateSkippedStep = `${exactImageJob}\n      - name: Exercise the native adapter\n        if: false\n        uses: ./.github/actions/platform-smoke\n        with:\n          expected-platform: \${{ matrix.platform }}\n          expected-architecture: \${{ matrix.architecture }}\n`;
  const cleanupTargetChanged = replaceRequired(
    ubuntuJob,
    cleanup,
    replaceRequired(
      cleanup,
      '          target="/usr/share/swift/maximize-space-bind-mount"',
      '          target="/usr/share/swift"',
    ),
  );
  const broadRemovalAdded = replaceRequired(
    ubuntuJob,
    cleanup,
    replaceRequired(
      cleanup,
      '            sudo rm -rf -- "$target" "$marker"',
      '            sudo rm -rf -- "$target" "$marker"\n            sudo rm -rf -- /usr/share/swift',
    ),
  );
  const ownerCreatedBeforePrechecks = replaceRequired(
    ubuntuJob,
    '          test ! -e "$source"\n          test ! -e "$target"\n          test ! -e "$marker"\n          test ! -e "$owner"\n          : >"$owner"',
    '          : >"$owner"\n          test ! -e "$source"\n          test ! -e "$target"\n          test ! -e "$marker"\n          test ! -e "$owner"',
  );
  const literalOutputBinding = replaceRequired(
    defaultMaxJob,
    "          BEFORE: ${{ steps.cleanup.outputs.available-bytes-before }}",
    '          BEFORE: "1"',
  );
  const extraCompatibilityJob = replaceRequired(
    compatibility,
    "\n  generated-dist:\n",
    "\n  decoy-cleanup:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - name: Hidden no-input cleanup\n        uses: ./\n\n  generated-dist:\n",
  );
  const quotedCompatibilityJob = replaceRequired(
    compatibility,
    "\n  generated-dist:\n",
    '\n  "hidden-cleanup":\n    runs-on: ubuntu-latest\n    steps: []\n\n  generated-dist:\n',
  );
  const differentlyNamedCompatibilityStep = replaceRequired(
    compatibility,
    "\n  generated-dist:\n",
    "\n      - name: Extra bounded cleanup\n        uses: ./.github/actions/platform-smoke\n        with:\n          expected-platform: linux\n          expected-architecture: x64\n\n  generated-dist:\n",
  );
  const noInputPullRequestStep = replaceRequired(
    pullRequest,
    "\n  platform-smoke:\n",
    "\n      - name: Extra no-input cleanup\n        uses: ./\n\n  platform-smoke:\n",
  );
  const defaultRowsOutsideInclude = replaceRequired(
    compatibility,
    "      matrix:\n        include:\n          - {runner: ubuntu-latest",
    "      matrix:\n        displaced:\n          - {runner: ubuntu-latest",
  );
  const literalDefaultRowDecoy = replaceRequired(
    replaceRequired(
      compatibility,
      "          - {runner: ubuntu-latest, platform: linux, architecture: x64, timeout: 30}\n",
      "",
    ),
    "        run: npm run check-dist",
    [
      "        run: |",
      "          npm run check-dist",
      "          - {runner: ubuntu-latest, platform: linux, architecture: x64, timeout: 30}",
    ].join("\n"),
  );
  const literalDefaultRunner = replaceRequired(
    compatibility,
    "    runs-on: ${{ matrix.runner }}\n    timeout-minutes: ${{ matrix.timeout }}",
    "    runs-on: ubuntu-latest\n    timeout-minutes: ${{ matrix.timeout }}",
  );
  const removedDefaultDependency = replaceRequired(
    compatibility,
    "    needs: generated-dist\n",
    "",
  );
  const maskedDefaultCleanup = replaceRequired(
    compatibility,
    "      - name: Run no-input default max\n        id: cleanup",
    "      - name: Run no-input default max\n        continue-on-error: true\n        id: cleanup",
  );
  const maskedGeneratedJob = replaceRequired(
    compatibility,
    "  generated-dist:\n    if: github.event_name == 'workflow_dispatch'",
    "  generated-dist:\n    continue-on-error: true\n    if: github.event_name == 'workflow_dispatch'",
  );
  const unboundedCompositeCleanup = replaceRequired(
    smokeAction,
    '      remove-gh-cli: "true"',
    "      cleanup-profile: max",
  );

  assert.deepEqual(
    survivingMutations([
      {
        name: "nested strategy decoy",
        exercise: () =>
          assertExactImageSmokeContract(hierarchyDecoy, smokeAction),
      },
      {
        name: "duplicate skipped exercise step",
        exercise: () =>
          assertExactImageSmokeContract(duplicateSkippedStep, smokeAction),
      },
      {
        name: "cleanup target widened to the Swift root",
        exercise: () =>
          assertMountedSwiftAndMavenContract(cleanupTargetChanged),
      },
      {
        name: "extra broad Swift removal",
        exercise: () => assertMountedSwiftAndMavenContract(broadRemovalAdded),
      },
      {
        name: "owner created before absence prechecks",
        exercise: () =>
          assertMountedSwiftAndMavenContract(ownerCreatedBeforePrechecks),
      },
      {
        name: "literal cleanup output binding",
        exercise: () => assertDefaultMaxOutputContract(literalOutputBinding),
      },
      {
        name: "extra compatibility job",
        exercise: () =>
          assertWorkflowTopology(
            extraCompatibilityJob,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "quoted compatibility job",
        exercise: () =>
          assertWorkflowTopology(
            quotedCompatibilityJob,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "differently named compatibility step",
        exercise: () =>
          assertWorkflowTopology(
            differentlyNamedCompatibilityStep,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "extra no-input pull-request invocation",
        exercise: () =>
          assertWorkflowTopology(
            compatibility,
            noInputPullRequestStep,
            lint,
            smokeAction,
          ),
      },
      {
        name: "default rows moved outside matrix include",
        exercise: () =>
          assertWorkflowTopology(
            defaultRowsOutsideInclude,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "default row hidden in a literal block",
        exercise: () =>
          assertWorkflowTopology(
            literalDefaultRowDecoy,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "literal default runner",
        exercise: () =>
          assertWorkflowTopology(
            literalDefaultRunner,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "removed default dependency gate",
        exercise: () =>
          assertWorkflowTopology(
            removedDefaultDependency,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "default cleanup failure masking",
        exercise: () =>
          assertWorkflowTopology(
            maskedDefaultCleanup,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "generated-dist job failure masking",
        exercise: () =>
          assertWorkflowTopology(
            maskedGeneratedJob,
            pullRequest,
            lint,
            smokeAction,
          ),
      },
      {
        name: "unbounded composite cleanup",
        exercise: () =>
          assertWorkflowTopology(
            compatibility,
            pullRequest,
            lint,
            unboundedCompositeCleanup,
          ),
      },
    ]),
    [],
  );
});

test("public docs describe the v0.12.3 safety and release contracts", async () => {
  const [readme, configuration, migrations, runnerSupport, contributing] =
    await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/CONFIGURATION.md", "utf8"),
      readFile("docs/MIGRATIONS.md", "utf8"),
      readFile("docs/RUNNER-SUPPORT.md", "utf8"),
      readFile("docs/CONTRIBUTING.md", "utf8"),
    ]);

  assert.equal(
    [
      ...readme.matchAll(
        /justinthelaw\/maximize-github-runner-space@v0\.12\.3/g,
      ),
    ].length,
    2,
  );
  assert.doesNotMatch(
    readme,
    /v0\.12\.2|until that tag is published|next readable release tag/,
  );
  assert.match(readme, /release tags?[\s\S]*readable pin/i);
  assert.match(readme, /full commit SHA[\s\S]*immutable pin/i);
  assert.match(configuration, /mount(?:ed)? filesystem[\s\S]*refus/i);
  assert.match(
    configuration,
    /Skipping any of `android`, `maven`, `gradle`, `ant`, or `selenium` implicitly preserves `java`/,
  );
  assert.match(
    configuration,
    /Because `java` owns a hosted-toolcache child, that preservation also disables broad `cached-tools` cleanup/,
  );
  assert.match(
    configuration,
    /Windows SDK\/WDK cleanup covers both definition-listed Visual Studio-owned components and eligible registered standalone Burn bundles/,
  );
  assert.match(
    configuration,
    /`~\/Library\/Android\/sdk`[\s\S]*`~\/\.android`[\s\S]*`~\/\.gradle`/,
  );
  assert.match(
    configuration,
    /Azure DevOps CLI extension under `~\/\.azure\/cliextensions\/azure-devops`/,
  );
  assert.match(
    configuration,
    /PostgreSQL owns `libpq-dev`, `postgresql`, `postgresql-common`, `postgresql-client-common`, and `postgresql-\*`/,
  );
  assert.match(
    configuration,
    /MySQL owns `libmysqlclient-dev`, `mysql-common`, `mysql-\*`, and `mariadb-\*`/,
  );
  assert.match(migrations, /v0\.12\.2 to v0\.12\.3/);
  assert.match(
    migrations,
    /no new inputs[\s\S]*conditional behavior change[\s\S]*mount/i,
  );
  assert.doesNotMatch(migrations, /no breaking changes/i);
  assert.match(
    migrations,
    /fails closed instead of recursively\s+deleting across the mount/i,
  );
  assert.match(migrations, /Linux[\s\S]*macOS[\s\S]*Windows/);
  assert.match(runnerSupport, /seven-class[\s\S]*default-max/i);
  assert.match(runnerSupport, /18-label[\s\S]*bounded compatibility/i);
  assert.match(
    runnerSupport,
    /generated-dist job must pass before the dispatch-only default-max jobs start/i,
  );
  assert.match(
    runnerSupport,
    /numeric output contracts and zero failed operations/i,
  );
  assert.match(
    contributing,
    /PR CI[\s\S]*automated review[\s\S]*seven-class[\s\S]*18-label/i,
  );
  assert.match(
    contributing,
    /generated-dist[\s\S]*dependency[\s\S]*fresh runners/i,
  );
});
