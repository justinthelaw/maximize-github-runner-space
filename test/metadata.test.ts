import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
