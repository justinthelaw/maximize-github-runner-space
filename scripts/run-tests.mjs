import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const testRoot = resolve(process.argv[2] ?? "build/test");

async function discoverTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...(await discoverTests(path)));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      discovered.push(path);
    }
  }

  return discovered;
}

let testFiles;
try {
  testFiles = await discoverTests(testRoot);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Unable to discover compiled tests in ${testRoot}: ${detail}`);
  process.exitCode = 1;
}

if (testFiles !== undefined) {
  testFiles.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (testFiles.length === 0) {
    console.error(`No compiled test files found in ${testRoot}`);
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, ["--test", ...testFiles], {
      shell: false,
      stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
