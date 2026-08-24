import assert from "node:assert/strict";
import test from "node:test";
import type { CommandOptions } from "../src/command.js";
import { listBoundedVersionedDirectoryEntries } from "../src/versioned-directories.js";

const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

async function inventoryWithOutput(stdout: string): Promise<void> {
  await listBoundedVersionedDirectoryEntries(
    "/opt/hostedtoolcache/Node",
    VERSION_PATTERN,
    "posix",
    "test version inventory",
    64,
    {
      runCommand: async () => ({ exitCode: 0, stdout, stderr: "" }),
    },
  );
}

test("versioned-directory inventory runs in a killable bounded child", async () => {
  let timeoutMs: number | undefined;
  await assert.rejects(
    async () =>
      await listBoundedVersionedDirectoryEntries(
        "/opt/hostedtoolcache/Node",
        VERSION_PATTERN,
        "posix",
        "test version inventory",
        64,
        {
          runCommand: async (_executable, _args, options) => {
            timeoutMs = options.timeoutMs;
            return {
              exitCode: 124,
              stdout: "",
              stderr: "timed out",
              terminationUnconfirmed: true,
            };
          },
        },
      ),
    /termination is unconfirmed/,
  );
  assert.equal(timeoutMs, 10_000);
});

test("versioned-directory inventory rejects malformed child output", async () => {
  await assert.rejects(
    async () =>
      await listBoundedVersionedDirectoryEntries(
        "/opt/hostedtoolcache/Node",
        VERSION_PATTERN,
        "posix",
        "test version inventory",
        64,
        {
          runCommand: async () => ({
            exitCode: 0,
            stdout:
              '{"status":"ok","entries":[{"name":"../escape","directory":true,"symbolicLink":false}]}',
            stderr: "",
          }),
        },
      ),
    /unsafe entry name/,
  );
});

test("versioned-directory inventory isolates the child environment", async () => {
  let options: CommandOptions | undefined;
  const inheritedNodeOptions = process.env.NODE_OPTIONS;
  const inheritedNodePath = process.env.NODE_PATH;
  const inheritedBashEnv = process.env.BASH_ENV;
  const inheritedEnv = process.env.ENV;
  process.env.NODE_OPTIONS = "--require=/tmp/hostile-startup.cjs";
  process.env.NODE_PATH = "/tmp/hostile-modules";
  process.env.BASH_ENV = "/tmp/hostile-bash-startup";
  process.env.ENV = "/tmp/hostile-shell-startup";
  try {
    await listBoundedVersionedDirectoryEntries(
      "/opt/hostedtoolcache/Node",
      VERSION_PATTERN,
      "posix",
      "test version inventory",
      64,
      {
        runCommand: async (_executable, _args, commandOptions) => {
          options = commandOptions;
          return {
            exitCode: 0,
            stdout: '{"status":"ok","entries":[]}',
            stderr: "",
          };
        },
      },
    );
  } finally {
    if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = inheritedNodeOptions;
    if (inheritedNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = inheritedNodePath;
    if (inheritedBashEnv === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = inheritedBashEnv;
    if (inheritedEnv === undefined) delete process.env.ENV;
    else process.env.ENV = inheritedEnv;
  }

  assert.ok(options?.env);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.NODE_PATH, undefined);
  assert.equal(options.env.BASH_ENV, undefined);
  assert.equal(options.env.ENV, undefined);
  assert.notEqual(options.env, process.env);
});

test("versioned-directory inventory reapplies the requested pattern", async () => {
  await assert.rejects(
    inventoryWithOutput(
      '{"status":"ok","entries":[{"name":"bin","directory":true,"symbolicLink":false}]}',
    ),
    /does not match the requested pattern/,
  );
});

test("versioned-directory inventory rejects duplicate names", async () => {
  await assert.rejects(
    inventoryWithOutput(
      '{"status":"ok","entries":[{"name":"20","directory":true,"symbolicLink":false},{"name":"20","directory":false,"symbolicLink":true}]}',
    ),
    /duplicate entry name/,
  );
});

for (const [description, directory, symbolicLink] of [
  ["both type flags", true, true],
  ["no type flags", false, false],
] as const) {
  test(`versioned-directory inventory rejects ${description}`, async () => {
    await assert.rejects(
      inventoryWithOutput(
        JSON.stringify({
          status: "ok",
          entries: [{ name: "20", directory, symbolicLink }],
        }),
      ),
      /exactly one valid entry type/,
    );
  });
}
