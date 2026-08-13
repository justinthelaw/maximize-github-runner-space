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
} from "../src/operations.js";
import { createSwapOperation } from "../src/platforms/linux.js";
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
