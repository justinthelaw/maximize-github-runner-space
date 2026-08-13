import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

if (!existsSync("dist/index.js")) {
  throw new Error("dist/index.js was not generated");
}

const diff = git(["diff", "--exit-code", "--", "dist"], {
  stdio: "inherit",
});
if (diff.status !== 0) {
  throw new Error("committed dist files do not match a clean build");
}

const untracked = git([
  "ls-files",
  "--others",
  "--exclude-standard",
  "--",
  "dist",
]);
if (untracked.status !== 0) {
  throw new Error("unable to inspect generated dist files");
}
if (untracked.stdout.trim() !== "") {
  throw new Error(`untracked dist files:\n${untracked.stdout.trim()}`);
}
