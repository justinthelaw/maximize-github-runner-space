import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createFunctionOperation,
  createRemovePathOperation,
  executeOperations,
  prepareOperations,
  removePathTarget,
  type RemovePathDependencies,
} from "../src/operations.js";
import {
  createSwapOperation,
  LINUX_SWAP_EXECUTABLES,
  linuxSwapCommandEnvironment,
  type LinuxSwapCommandInvocation,
} from "../src/platforms/linux.js";
import {
  assertSafeDirectoryTarget,
  assertSafeRemovalTarget,
} from "../src/safety.js";
import { contextFor } from "./helpers.js";

test("Linux targets must be absolute, bounded, and non-protected", () => {
  const context = contextFor("linux");
  assert.equal(
    assertSafeRemovalTarget("/usr/share/dotnet", ["/usr/share"], context),
    "/usr/share/dotnet",
  );
  assert.throws(
    () => assertSafeRemovalTarget("dotnet", ["/usr/share"], context),
    /non-absolute/,
  );
  assert.throws(
    () => assertSafeRemovalTarget("/usr/share/../etc", ["/usr/share"], context),
    /outside/,
  );
  assert.throws(
    () => assertSafeRemovalTarget(context.home, [context.home], context),
    /protected/,
  );
  assert.throws(
    () => assertSafeRemovalTarget("/", ["/"], context),
    /protected/,
  );
});

test("Windows paths are validated with win32 semantics on any test host", () => {
  const context = contextFor("windows");
  assert.equal(
    assertSafeRemovalTarget(
      "C:\\Program Files\\dotnet",
      ["C:\\Program Files"],
      context,
    ),
    "C:\\Program Files\\dotnet",
  );
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        "C:\\Program Files\\dotnet\\..\\..\\Windows",
        ["C:\\Program Files\\dotnet"],
        context,
      ),
    /outside/,
  );
  assert.throws(
    () => assertSafeRemovalTarget("C:\\", ["C:\\"], context),
    /protected/,
  );
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        "C:\\Program Files",
        ["C:\\Program Files"],
        context,
      ),
    /outside/,
  );
  assert.throws(
    () => assertSafeRemovalTarget(context.workspace ?? "", ["C:\\a"], context),
    /protected/,
  );
});

test("a target containing a protected workspace is rejected", () => {
  const context = contextFor("linux");
  assert.throws(
    () =>
      assertSafeRemovalTarget("/home/runner/work", ["/home/runner"], context),
    /protected/,
  );
});

test("the Node executable is protected without blocking sibling tools", () => {
  const context = contextFor("linux");
  const runtimeDirectory = dirname(context.runtimeExecutable);
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        context.runtimeExecutable,
        [runtimeDirectory],
        context,
      ),
    /protected/,
  );
  assert.throws(
    () =>
      assertSafeRemovalTarget(
        runtimeDirectory,
        [dirname(runtimeDirectory)],
        context,
      ),
    /protected/,
  );
  const sibling = join(runtimeDirectory, "unrelated-runner-tool");
  assert.equal(
    assertSafeRemovalTarget(sibling, [runtimeDirectory], context),
    sibling,
  );
});

test("realpath validation blocks intermediate symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-safety-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, join(allowed, "link"));

  const context = {
    ...contextFor("linux"),
    home: "/home/runner",
    temp: join(root, "runner-temp"),
    workspace: undefined,
  };
  const operation = createRemovePathOperation({
    id: "escape",
    component: "vcpkg",
    description: "escape fixture",
    target: join(allowed, "link", "sentinel"),
    allowedParents: [allowed],
    context,
  });
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /redirected ancestor/);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("complete-plan path validation aborts before an earlier package mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-plan-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, join(allowed, "redirect"));

  let packageRan = false;
  const packageOperation = createFunctionOperation({
    id: "package-before-path",
    component: "vcpkg",
    description: "package mutation fixture",
    phase: "package",
    run: async () => {
      packageRan = true;
      return { status: "removed" };
    },
  });
  const unsafePathOperation = createRemovePathOperation({
    id: "later-unsafe-path",
    component: "vcpkg",
    description: "redirected path fixture",
    target: join(allowed, "redirect", "sentinel"),
    allowedParents: [allowed],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });

  await assert.rejects(
    async () =>
      await executeOperations([packageOperation, unsafePathOperation]),
    /validation failed before mutation.*redirected ancestor/s,
  );
  assert.equal(packageRan, false);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

async function createSwapFixture(): Promise<{
  readonly root: string;
  readonly context: ReturnType<typeof contextFor>;
}> {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-swap-"));
  await mkdir(join(root, "mnt"));
  await mkdir(join(root, "etc"));
  await writeFile(join(root, "etc", "fstab"), "# test fixture\n");
  return {
    root,
    context: contextFor("linux"),
  };
}

test("the prepared swap operation validates its exact definition targets", async () => {
  const { context, root } = await createSwapFixture();
  const operation = createSwapOperation(context, 0n, root);
  const prepared = prepareOperations([operation], {
    profile: "custom",
    enabled: new Set(),
    skipped: new Set(),
    swapfileBytes: 0n,
  });

  assert.deepEqual(
    prepared.map(({ id }) => id),
    ["swapfile"],
  );
  assert.notEqual(prepared[0]?.validate, undefined);
  await prepared[0]?.validate?.();
});

test("the swap transaction pins every utility and ignores workflow command injection", async () => {
  assert.deepEqual(LINUX_SWAP_EXECUTABLES, {
    chmod: "/usr/bin/chmod",
    dd: "/usr/bin/dd",
    df: "/usr/bin/df",
    fallocate: "/usr/bin/fallocate",
    grep: "/usr/bin/grep",
    mktemp: "/usr/bin/mktemp",
    mkswap: "/usr/sbin/mkswap",
    mv: "/usr/bin/mv",
    rm: "/usr/bin/rm",
    sed: "/usr/bin/sed",
    swapoff: "/usr/sbin/swapoff",
    swapon: "/usr/sbin/swapon",
    tee: "/usr/bin/tee",
    test: "/usr/bin/test",
    truncate: "/usr/bin/truncate",
  });
  assert.deepEqual(linuxSwapCommandEnvironment(), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });

  const { context, root } = await createSwapFixture();
  const calls: LinuxSwapCommandInvocation[] = [];
  const poisonedNames = ["PATH", "BASH_ENV", "ENV", "LD_PRELOAD"] as const;
  const original = new Map(
    poisonedNames.map((name) => [name, process.env[name]]),
  );
  process.env.PATH = "/workflow/untrusted-bin";
  process.env.BASH_ENV = "/workflow/bash-env";
  process.env.ENV = "/workflow/shell-env";
  process.env.LD_PRELOAD = "/workflow/preload.so";

  try {
    const operation = createSwapOperation(context, 1024n ** 2n, root, {
      commandRunner: async (invocation) => {
        calls.push({
          ...invocation,
          args: [...invocation.args],
          options: {
            ...invocation.options,
            env: { ...invocation.options.env },
          },
        });
        const success = { exitCode: 0, stdout: "", stderr: "" };
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.test) {
          return { ...success, exitCode: 1 };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.grep) {
          return { ...success, exitCode: 1 };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.df) {
          return { ...success, stdout: "Avail\n1073741824\n" };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.mktemp) {
          const template = invocation.args[0];
          assert.ok(template !== undefined);
          assert.ok(template.endsWith("XXXXXX"));
          return {
            ...success,
            stdout: `${template.slice(0, -6)}ABC123\n`,
          };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.fallocate) {
          return { ...success, exitCode: 1, stderr: "unsupported filesystem" };
        }
        if (invocation.executable === LINUX_SWAP_EXECUTABLES.tee) {
          return { ...success, exitCode: 1, stderr: "simulated tee failure" };
        }
        return success;
      },
    });
    assert.ok(operation.validate);
    await operation.validate();
    const result = await operation.run();
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /simulated tee failure/);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.deepEqual(
    calls.map(({ executable }) => executable),
    [
      LINUX_SWAP_EXECUTABLES.swapon,
      LINUX_SWAP_EXECUTABLES.test,
      LINUX_SWAP_EXECUTABLES.grep,
      LINUX_SWAP_EXECUTABLES.df,
      LINUX_SWAP_EXECUTABLES.mktemp,
      LINUX_SWAP_EXECUTABLES.fallocate,
      LINUX_SWAP_EXECUTABLES.dd,
      LINUX_SWAP_EXECUTABLES.truncate,
      LINUX_SWAP_EXECUTABLES.chmod,
      LINUX_SWAP_EXECUTABLES.mkswap,
      LINUX_SWAP_EXECUTABLES.mv,
      LINUX_SWAP_EXECUTABLES.swapon,
      LINUX_SWAP_EXECUTABLES.tee,
      LINUX_SWAP_EXECUTABLES.swapoff,
      LINUX_SWAP_EXECUTABLES.rm,
      LINUX_SWAP_EXECUTABLES.sed,
    ],
  );
  assert.deepEqual(
    new Set(calls.map(({ executable }) => executable)),
    new Set(Object.values(LINUX_SWAP_EXECUTABLES)),
  );
  assert.deepEqual(
    calls.map(({ elevated }) => elevated),
    [
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ],
  );
  for (const invocation of calls) {
    assert.equal(invocation.executable.startsWith("/"), true);
    assert.deepEqual(invocation.options.env, linuxSwapCommandEnvironment());
    assert.equal(invocation.options.env.BASH_ENV, undefined);
    assert.equal(invocation.options.env.ENV, undefined);
    assert.equal(invocation.options.env.LD_PRELOAD, undefined);
  }
});

for (const redirectedTarget of ["swapfile", "fstab"] as const) {
  test(`a final ${redirectedTarget} symlink aborts before package mutation`, async () => {
    const { context, root } = await createSwapFixture();
    const target =
      redirectedTarget === "swapfile"
        ? join(root, "mnt", "swapfile")
        : join(root, "etc", "fstab");
    if (redirectedTarget === "fstab") await unlink(target);
    await symlink(join(root, "outside"), target);

    let packageRan = false;
    const packageOperation = createFunctionOperation({
      id: `package-before-${redirectedTarget}`,
      component: "large-packages",
      description: "package mutation fixture",
      phase: "package",
      run: async () => {
        packageRan = true;
        return { status: "removed" };
      },
    });
    const swap = createSwapOperation(context, 0n, root);

    await assert.rejects(
      async () => await executeOperations([packageOperation, swap]),
      /validation failed before mutation.*symbolic link/s,
    );
    assert.equal(packageRan, false);
  });
}

test("a symlinked allowlist parent cannot redirect deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-parent-link-"));
  const outside = join(root, "outside");
  const parentLink = join(root, "allowed");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  await symlink(outside, parentLink);

  const operation = createRemovePathOperation({
    id: "parent-escape",
    component: "vcpkg",
    description: "parent escape fixture",
    target: join(parentLink, "sentinel"),
    allowedParents: [parentLink],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });
  const result = await operation.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /redirected ancestor/);
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("a final symlink is unlinked without deleting its destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-final-link-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  const finalLink = join(allowed, "runner-link");
  await symlink(join(outside, "sentinel"), finalLink);

  const operation = createRemovePathOperation({
    id: "final-link",
    component: "vcpkg",
    description: "final link fixture",
    target: finalLink,
    allowedParents: [allowed],
    context: { ...contextFor("linux"), temp: join(root, "runner-temp") },
  });
  const result = await operation.run();
  assert.equal(result.status, "removed");
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "preserve me",
  );
});

test("path removal refuses a target whose kind changes after validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-type-drift-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  const context = {
    ...contextFor("linux"),
    temp: join(root, "runner-temp"),
    workspace: undefined,
  };
  let unlinkCalls = 0;
  let removeCalls = 0;
  const inspections = [
    { exists: true, isLink: true },
    { exists: true, isLink: false, realPath: target },
  ];

  const dependencies: RemovePathDependencies = {
    inspectTarget: async () => {
      const inspected = inspections.shift();
      assert.ok(inspected);
      return inspected;
    },
    unlink: async () => {
      unlinkCalls++;
    },
    remove: async () => {
      removeCalls++;
    },
  };
  const result = await removePathTarget(
    target,
    [allowed],
    context,
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.equal(unlinkCalls, 0);
  assert.equal(removeCalls, 0);
});

test("path removal fails when the target still exists after removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-postcondition-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  const context = {
    ...contextFor("linux"),
    temp: join(root, "runner-temp"),
    workspace: undefined,
  };
  const inspections = Array.from({ length: 3 }, () => ({
    exists: true,
    isLink: false,
    realPath: target,
  }));
  const dependencies: RemovePathDependencies = {
    inspectTarget: async () => {
      const inspected = inspections.shift();
      assert.ok(inspected);
      return inspected;
    },
    remove: async () => {},
  };

  const result = await removePathTarget(
    target,
    [allowed],
    context,
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /still exists/);
});

test("directory recreation rejects a final symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-recreate-link-"));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  const target = join(allowed, "toolcache");
  await symlink(outside, target);

  await assert.rejects(
    async () =>
      await assertSafeDirectoryTarget(target, [allowed], {
        ...contextFor("linux"),
        temp: join(root, "runner-temp"),
      }),
    /non-directory target/,
  );
});
