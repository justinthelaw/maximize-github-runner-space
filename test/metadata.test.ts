import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMPONENTS } from "../src/components.js";

function keysInSection(document: string, start: string, end: string): string[] {
  const section =
    document.split(`${start}:\n`)[1]?.split(`\n${end}:\n`)[0] ?? "";
  return [...section.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(
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
    "platform",
    "architecture",
  ]);
});

test("runtime discovery does not silently invent a hosted-runner home", async () => {
  const runtime = await readFile("src/runtime.ts", "utf8");
  assert.doesNotMatch(runtime, /\/home\/runner(?:\/|\b)/);
});
