import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as safetyModule from "../src/safety.js";
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
  assertSafeExistingTarget,
  assertSafeExactTarget,
  assertSafeRemovalTarget,
  inspectTarget,
  parseLinuxMountPoints,
  readWindowsFileAttributes,
  type TargetInspection,
} from "../src/safety.js";
import { contextFor } from "./helpers.js";

function linuxMountInfoLine(mountPoint: string): string {
  const encodedMountPoint = mountPoint
    .replaceAll("\\", "\\134")
    .replaceAll(" ", "\\040")
    .replaceAll("\t", "\\011")
    .replaceAll("\n", "\\012");
  return `36 25 0:32 / ${encodedMountPoint} rw,relatime - ext4 /dev/root rw`;
}

function syntheticDirectoryStats(
  inode = 2n,
): Awaited<ReturnType<typeof import("node:fs/promises").lstat>> {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
    dev: 1n,
    ino: inode,
  } as unknown as Awaited<ReturnType<typeof import("node:fs/promises").lstat>>;
}

test("Linux mountinfo parsing decodes path escapes", () => {
  const mountInfo = String.raw`36 25 0:32 / /opt/tool\040cache\011tab\012line\134slash\999 rw,relatime - ext4 /dev/root rw`;

  assert.deepEqual(parseLinuxMountPoints(mountInfo), [
    "/opt/tool cache\ttab\nline\\slash\\999",
  ]);
});

test("Linux mountinfo parsing rejects malformed records", () => {
  const malformedRecords = [
    "36 25 0:32 / /opt/tool rw,relatime",
    "36 25 0:32 / - ext4 /dev/root rw",
    "36 25 0:32 / /target - ext4 /dev/root rw",
    "36 25 0:32 / /target rw,relatime - ext4 /dev/root",
    "36 25 0:32 / relative rw,relatime - ext4 /dev/root rw",
  ];

  for (const mountInfo of malformedRecords) {
    assert.throws(
      () => parseLinuxMountPoints(mountInfo),
      /malformed Linux mountinfo/i,
      mountInfo,
    );
  }
});

test("recursive removal refuses a target that is a mount point", async () => {
  const root = await mkdtemp(join(tmpdir(), "mount-target-"));
  const target = join(root, "tool");
  await mkdir(target);

  await assert.rejects(
    assertSafeExistingTarget(target, [root], contextFor("linux"), {
      readLinuxMountInfo: async () => linuxMountInfoLine(target),
    }),
    (error: Error) => {
      assert.match(error.message, /mounted path/);
      assert.match(error.message, new RegExp(target.replaceAll("/", "\\/")));
      return true;
    },
  );
});

test("recursive removal refuses a descendant mount before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mount-boundary-"));
  const target = join(root, "tool");
  const mounted = join(target, "cache");
  await mkdir(mounted, { recursive: true });

  await assert.rejects(
    assertSafeExistingTarget(target, [root], contextFor("linux"), {
      readLinuxMountInfo: async () => linuxMountInfoLine(mounted),
    }),
    (error: Error) => {
      assert.match(error.message, /mounted path/);
      assert.ok(error.message.includes(target));
      assert.ok(error.message.includes(mounted));
      return true;
    },
  );
});

test("recursive removal allows a lexical sibling mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "mount-sibling-"));
  const target = join(root, "tool");
  const sibling = join(root, "tool-other");
  await mkdir(target);

  await assert.doesNotReject(
    assertSafeExistingTarget(target, [root], contextFor("linux"), {
      readLinuxMountInfo: async () => linuxMountInfoLine(sibling),
    }),
  );
});

test("Linux recursive removal rejects a target transition during an opening mount read", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-mount-target-drift-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let targetInode = 20n;
  let mountReads = 0;
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () =>
        removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: targetInode },
            },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readLinuxMountInfo: async () => {
        mountReads += 1;
        if (mountReads === 3) targetInode = 99n;
        return "";
      },
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /target.*identity.*changed/i);
  assert.equal(mountReads, 3);
  assert.equal(removeCalls, 0);
});

test("Linux recursive removal leaves its closing mount observation adjacent to mutation", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-mount-target-last-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  const events: string[] = [];
  let targetInspections = 0;
  let removed = false;
  let eventAtRemoval: string | undefined;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () => {
        targetInspections += 1;
        events.push(`target:${targetInspections}`);
        return removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 20n },
            };
      },
      lstat: (async (path: string) => {
        events.push(`ancestor:${path}`);
        return syntheticDirectoryStats();
      }) as unknown as typeof import("node:fs/promises").lstat,
      readLinuxMountInfo: async () => {
        events.push("mountinfo");
        return "";
      },
      remove: async () => {
        eventAtRemoval = events.at(-1);
        removed = true;
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(eventAtRemoval, "mountinfo");
});

test("Linux recursive removal rejects a mount added during its closing target observation", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-late-descendant-mount-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  const mounted = join(target, "late-mount");
  await mkdir(mounted, { recursive: true });
  let targetInspections = 0;
  let mountPresent = false;
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () => {
        targetInspections += 1;
        if (targetInspections === 6) mountPresent = true;
        return removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 20n },
            };
      },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readLinuxMountInfo: async () =>
        mountPresent ? linuxMountInfoLine(mounted) : "",
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /containing mounted path/);
  assert.equal(removeCalls, 0);
});

test("Linux recursive removal rejects an identity transition during authoritative target C realpath", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-linux-closing-realpath-drift-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  let targetInode = 20n;
  let targetRealpaths = 0;
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      lstat: (async (path: string) => {
        if (path === target && removed) {
          throw Object.assign(new Error("target removed"), { code: "ENOENT" });
        }
        return syntheticDirectoryStats(path === target ? targetInode : 2n);
      }) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async (path: string) => {
        if (path === target) {
          targetRealpaths += 1;
          if (targetRealpaths === 6) targetInode = 99n;
        }
        return path;
      }) as unknown as typeof import("node:fs/promises").realpath,
      readLinuxMountInfo: async () => "",
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /identity|kind|changed.*real path/i);
  assert.equal(targetRealpaths, 6);
  assert.equal(removeCalls, 0);
});

test("a final symlink does not read Linux mountinfo", async () => {
  const root = await mkdtemp(join(tmpdir(), "mount-final-link-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(allowed);
  await symlink(join(root, "destination"), target);
  let mountReads = 0;

  await assertSafeExistingTarget(target, [allowed], contextFor("linux"), {
    readLinuxMountInfo: async () => {
      mountReads++;
      return linuxMountInfoLine(target);
    },
  });

  assert.equal(mountReads, 0);
});

test("non-recursive validators ignore Linux mount boundaries", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux mount boundary fixture");
    return;
  }
  const context = contextFor("linux");

  await assertSafeDirectoryTarget("/proc", ["/"], context);
  await assertSafeExactTarget("/etc/hosts", ["/etc"], context, "regular-file");
  await assert.rejects(
    assertSafeExistingTarget("/proc", ["/"], context, {
      readLinuxMountInfo: async () => linuxMountInfoLine("/proc/self"),
    }),
    /mounted path/,
  );
});

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

test("default POSIX target observation rejects an identity transition during realpath", async () => {
  const target = "/opt/hostedtoolcache/tool";
  let targetInode = 3n;
  const events: string[] = [];

  await assert.rejects(
    inspectTarget(target, {
      platform: "linux",
      lstat: (async (path: string) => {
        assert.equal(path, target);
        events.push(`lstat:${targetInode}`);
        return syntheticDirectoryStats(targetInode);
      }) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async (path: string) => {
        assert.equal(path, target);
        events.push("realpath");
        targetInode = 99n;
        return target;
      }) as unknown as typeof import("node:fs/promises").realpath,
    }),
    /identity|kind|changed.*real path/i,
  );
  assert.deepEqual(events, ["lstat:3", "realpath", "lstat:99"]);
});

test("macOS recursive removal rejects a kind transition during authoritative target B realpath", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-macos-authoritative-realpath-drift-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  let targetIsDirectory = true;
  let targetRealpaths = 0;
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("macos"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      lstat: (async (path: string) => {
        if (path === target && removed) {
          throw Object.assign(new Error("target removed"), { code: "ENOENT" });
        }
        if (path !== target) return syntheticDirectoryStats();
        const observedDirectory = targetIsDirectory;
        return {
          isSymbolicLink: () => false,
          isDirectory: () => observedDirectory,
          isFile: () => !observedDirectory,
          dev: 1n,
          ino: 20n,
        } as unknown as Awaited<
          ReturnType<typeof import("node:fs/promises").lstat>
        >;
      }) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async (path: string) => {
        if (path === target) {
          targetRealpaths += 1;
          if (targetRealpaths === 4) targetIsDirectory = false;
        }
        return path;
      }) as unknown as typeof import("node:fs/promises").realpath,
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /identity|kind|changed.*real path/i);
  assert.equal(targetRealpaths, 4);
  assert.equal(removeCalls, 0);
});

test("default Windows target observation rejects a transition during realpath", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let targetInode = 3n;
  const events: string[] = [];

  await assert.rejects(
    inspectTarget(target, {
      platform: "windows",
      lstat: (async (path: string) => {
        assert.equal(path, target);
        events.push(`lstat:${targetInode}`);
        return syntheticDirectoryStats(targetInode);
      }) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async (path: string) => {
        assert.equal(path, target);
        events.push("realpath");
        targetInode = 99n;
        return target;
      }) as unknown as typeof import("node:fs/promises").realpath,
      readWindowsFileAttributes: async (paths) => {
        assert.deepEqual(paths, [target]);
        events.push("attributes");
        return [0];
      },
    }),
    /identity|kind|changed.*realpath/i,
  );
  assert.equal(events.filter((event) => event === "realpath").length, 1);
});

test("default Windows target observation rejects a same-inode reparse transition during realpath", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let realpathCompleted = false;

  await assert.rejects(
    inspectTarget(target, {
      platform: "windows",
      lstat: (async () =>
        syntheticDirectoryStats(
          3n,
        )) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async () => {
        realpathCompleted = true;
        return target;
      }) as unknown as typeof import("node:fs/promises").realpath,
      readWindowsFileAttributes: async () => [realpathCompleted ? 0x400 : 0],
    }),
    /kind|reparse|changed.*realpath/i,
  );
});

test("default Windows target returns a post-realpath explicit-attribute generation", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  const events: string[] = [];
  let attributeCalls = 0;

  const inspected = await inspectTarget(target, {
    platform: "windows",
    lstat: (async (path: string) => {
      assert.equal(path, target);
      events.push("lstat");
      return syntheticDirectoryStats(3n);
    }) as unknown as typeof import("node:fs/promises").lstat,
    realpath: (async (path: string) => {
      assert.equal(path, target);
      events.push("realpath");
      return target;
    }) as unknown as typeof import("node:fs/promises").realpath,
    readWindowsFileAttributes: async (paths) => {
      assert.deepEqual(paths, [target]);
      events.push("attributes");
      attributeCalls += 1;
      return [attributeCalls === 1 ? 0x20 : 0];
    },
  });

  assert.deepEqual(inspected, {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 3n },
    fileAttributes: 0,
  });
  assert.deepEqual(events, [
    "lstat",
    "attributes",
    "lstat",
    "realpath",
    "lstat",
    "attributes",
    "lstat",
  ]);
});

test("Windows recursive removal rejects a default target transition during realpath", async () => {
  const allowed = "C:\\Program Files\\Docker";
  const target = `${allowed}\\cli-plugins`;
  let targetInode = 90n;
  let recursiveRemovals = 0;
  let targetRealpaths = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    contextFor("windows"),
    {
      lstat: (async (path: string) =>
        syntheticDirectoryStats(
          path === target ? targetInode : 2n,
        )) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async (path: string) => {
        if (path === target) {
          targetRealpaths += 1;
          targetInode = 99n;
        }
        return path;
      }) as unknown as typeof import("node:fs/promises").realpath,
      readWindowsFileAttributes: async (paths: readonly string[]) =>
        paths.map(() => 0),
      remove: async () => {
        recursiveRemovals += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /target.*changed|identity.*changed/i);
  assert.equal(targetRealpaths, 1);
  assert.equal(recursiveRemovals, 0);
});

test("Windows recursive removal unlinks an ordinary-looking final reparse target", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  const reparseInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 2n },
    fileAttributes: 0x400,
  } as TargetInspection & { readonly fileAttributes: number };
  const inspections: TargetInspection[] = [
    reparseInspection,
    reparseInspection,
    reparseInspection,
    reparseInspection,
    { exists: false, isLink: false },
  ];
  let removeCalls = 0;
  let unlinkCalls = 0;

  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        const inspection = inspections.shift();
        assert.ok(inspection);
        return inspection;
      },
      remove: async () => {
        removeCalls += 1;
      },
      unlink: async () => {
        unlinkCalls += 1;
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(removeCalls, 0);
  assert.equal(unlinkCalls, 1);
});

test("Windows recursive removal rejects an explicit reparse ancestor", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  const inspection: TargetInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 2n },
  };
  let removeCalls = 0;
  let unlinkCalls = 0;
  const dependencies = {
    inspectTarget: async () => inspection,
    lstat: async () => syntheticDirectoryStats(),
    readWindowsFileAttributes: async (paths: readonly string[]) =>
      paths.map((path) => (path === "C:\\Program Files\\Docker" ? 0x400 : 0)),
    remove: async () => {
      removeCalls += 1;
    },
    unlink: async () => {
      unlinkCalls += 1;
    },
  } as RemovePathDependencies & {
    readonly lstat: typeof import("node:fs/promises").lstat;
    readonly readWindowsFileAttributes: (
      paths: readonly string[],
    ) => Promise<readonly number[]>;
  };

  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /reparse.*ancestor|redirected ancestor/i);
  assert.equal(removeCalls, 0);
  assert.equal(unlinkCalls, 0);
});

test("Windows recursive removal rejects a reparse drive root for a direct child", async () => {
  const target = "C:\\ordinary";
  const inspection: TargetInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 2n },
    fileAttributes: 0,
  };
  const inspections: TargetInspection[] = [
    inspection,
    inspection,
    { exists: false, isLink: false },
  ];
  let mutations = 0;
  const result = await removePathTarget(
    target,
    ["C:\\"],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        const current = inspections.shift();
        assert.ok(current);
        return current;
      },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) =>
        paths.map((path) => (path === "C:\\" ? 0x400 : 0)),
      remove: async () => {
        mutations += 1;
      },
      unlink: async () => {
        mutations += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /reparse.*ancestor/i);
  assert.equal(mutations, 0);
});

test("Windows recursive removal rejects a malformed ancestor attribute batch", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  const inspection: TargetInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 2n },
  };
  let mutations = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => inspection,
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async () => [],
      remove: async () => {
        mutations += 1;
      },
      unlink: async () => {
        mutations += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /attribute probe.*malformed/i);
  assert.equal(mutations, 0);
});

test("Windows recursive removal never hands a final-boundary reparse to recursive rm", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  const ordinary = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 2n },
    fileAttributes: 0,
  } as TargetInspection & { fileAttributes: number };
  const finalBoundary = { ...ordinary };
  const inspections: TargetInspection[] = [
    ordinary,
    finalBoundary,
    { exists: false, isLink: false },
  ];
  let attributeReads = 0;
  let recursiveRemovals = 0;
  let unlinks = 0;

  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        const inspection = inspections.shift();
        assert.ok(inspection);
        return inspection;
      },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        attributeReads += 1;
        if (attributeReads === 2) finalBoundary.fileAttributes = 0x400;
        return paths.map(() => 0);
      },
      remove: async () => {
        recursiveRemovals += 1;
      },
      unlink: async () => {
        unlinks += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /kind changed|reparse/i);
  assert.equal(recursiveRemovals, 0);
  assert.equal(unlinks, 0);
});

test("Windows recursive removal rejects an ancestor identity transition during the attribute probe", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let transitioned = false;
  let removed = false;
  let mutations = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () =>
        removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 90n },
              fileAttributes: 0,
            },
      lstat: (async (path: string) =>
        syntheticDirectoryStats(
          path === "C:\\Program Files\\Docker" && transitioned ? 99n : 2n,
        )) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        transitioned = true;
        return paths.map(() => 0);
      },
      remove: async () => {
        mutations += 1;
        removed = true;
      },
      unlink: async () => {
        mutations += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed|identity.*changed/i);
  assert.equal(mutations, 0);
});

test("Windows recursive removal rejects an ancestor kind transition during the attribute probe", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let transitioned = false;
  let mutations = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => ({
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 90n },
        fileAttributes: 0,
      }),
      lstat: (async (path: string) => {
        const observedTransition = transitioned;
        return {
          isSymbolicLink: () => false,
          isDirectory: () =>
            path !== "C:\\Program Files\\Docker" || !observedTransition,
          isFile: () =>
            path === "C:\\Program Files\\Docker" && observedTransition,
          dev: 1n,
          ino: 2n,
        } as unknown as Awaited<
          ReturnType<typeof import("node:fs/promises").lstat>
        >;
      }) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        transitioned = true;
        return paths.map(() => 0);
      },
      remove: async () => {
        mutations += 1;
      },
      unlink: async () => {
        mutations += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /kind.*changed/i);
  assert.equal(mutations, 0);
});

test("Windows recursive removal rejects a target identity transition during the attribute probe", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let transitioned = false;
  let removed = false;
  let mutations = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () =>
        removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 3n },
            },
      lstat: (async (path: string) =>
        syntheticDirectoryStats(
          path === target && transitioned ? 99n : 3n,
        )) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        if (paths.includes(target)) transitioned = true;
        return paths.map(() => 0);
      },
      remove: async () => {
        mutations += 1;
        removed = true;
      },
      unlink: async () => {
        mutations += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /target.*changed|identity.*changed/i);
  assert.equal(mutations, 0);
});

test("Windows recursive removal rejects a target transition during the final post-target ancestor batch", async () => {
  const allowed = "C:\\Program Files\\Docker";
  const target = `${allowed}\\cli-plugins`;
  let targetInode = 90n;
  let ancestorAttributeBatches = 0;
  let recursiveRemovals = 0;
  const result = await removePathTarget(
    target,
    [allowed],
    contextFor("windows"),
    {
      inspectTarget: async () => ({
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: targetInode },
        fileAttributes: 0,
      }),
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        ancestorAttributeBatches += 1;
        if (ancestorAttributeBatches === 4) targetInode = 99n;
        return paths.map(() => 0);
      },
      remove: async () => {
        recursiveRemovals += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /target.*changed|identity.*changed/i);
  assert.equal(ancestorAttributeBatches, 4);
  assert.equal(recursiveRemovals, 0);
});

test("Windows recursive removal leaves authoritative target B adjacent to mutation", async () => {
  const allowed = "C:\\Program Files\\Docker";
  const target = `${allowed}\\cli-plugins`;
  const events: string[] = [];
  let inspections = 0;
  let removed = false;
  let eventAtRemoval: string | undefined;

  const result = await removePathTarget(
    target,
    [allowed],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        inspections += 1;
        events.push(`target:${inspections}`);
        return removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 90n },
              fileAttributes: 0,
            };
      },
      lstat: (async (path: string) => {
        events.push(`ancestor-lstat:${path}`);
        return syntheticDirectoryStats();
      }) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        events.push("ancestor-attributes");
        return paths.map(() => 0);
      },
      remove: async () => {
        eventAtRemoval = events.at(-1);
        removed = true;
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(eventAtRemoval, "target:4");
});

test("Windows final-link unlink ENOENT is a benign removed postcondition", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let inspectionCalls = 0;
  let unlinkCalls = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () =>
        ++inspectionCalls < 5
          ? {
              exists: true,
              isLink: true,
              identity: { device: 1n, inode: 3n },
              fileAttributes: 0x400,
            }
          : { exists: false, isLink: false },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => paths.map(() => 0),
      remove: async () => assert.fail("a final link must not be recursive"),
      unlink: async () => {
        unlinkCalls += 1;
        throw Object.assign(new Error("already absent"), { code: "ENOENT" });
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(unlinkCalls, 1);
  assert.equal(inspectionCalls, 5);
});

test("final-link ENOENT postcondition inspection errors resolve as failures", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let inspectionCalls = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        inspectionCalls += 1;
        if (inspectionCalls === 5) {
          throw Object.assign(new Error("postcondition denied"), {
            code: "EACCES",
          });
        }
        return {
          exists: true,
          isLink: true,
          identity: { device: 1n, inode: 3n },
          fileAttributes: 0x400,
        };
      },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => paths.map(() => 0),
      remove: async () => assert.fail("a final link must not be recursive"),
      unlink: async () => {
        throw Object.assign(new Error("already absent"), { code: "ENOENT" });
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /postcondition denied/);
  assert.equal(inspectionCalls, 5);
});

test("final-link unlink errors other than ENOENT remain failures", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let inspectionCalls = 0;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        inspectionCalls += 1;
        return {
          exists: true,
          isLink: true,
          identity: { device: 1n, inode: 3n },
          fileAttributes: 0x400,
        };
      },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => paths.map(() => 0),
      remove: async () => assert.fail("a final link must not be recursive"),
      unlink: async () => {
        throw Object.assign(new Error("access denied"), { code: "EPERM" });
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /access denied/);
  assert.equal(inspectionCalls, 4);
});

test("Unix final-link permission errors retain elevated unlink fallback", async () => {
  const target = "/usr/local/bin/maximize-space-link";
  let inspectionCalls = 0;
  let elevatedCalls = 0;
  let elevatedDone = false;
  const result = await removePathTarget(
    target,
    ["/usr/local/bin"],
    contextFor("linux"),
    {
      inspectTarget: async () => {
        inspectionCalls += 1;
        return elevatedDone
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: true,
              identity: { device: 1n, inode: 3n },
            };
      },
      unlink: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      },
      remove: async () => assert.fail("a final link must not be recursive"),
      readLinuxMountInfo: async () => "",
      runElevated: async (_context, executable, args) => {
        elevatedCalls += 1;
        assert.equal(executable, "/bin/rm");
        assert.deepEqual(args, ["-f", "--", target]);
        elevatedDone = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(inspectionCalls, 7);
  assert.equal(elevatedCalls, 1);
});

test("benign Windows target attribute changes do not impersonate identity drift", async () => {
  const target = "C:\\Program Files\\Docker\\cli-plugins";
  let inspectionCalls = 0;
  let removed = false;
  const result = await removePathTarget(
    target,
    ["C:\\Program Files\\Docker"],
    contextFor("windows"),
    {
      inspectTarget: async () => {
        inspectionCalls += 1;
        if (removed) return { exists: false, isLink: false };
        return {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 3n },
          fileAttributes: inspectionCalls === 1 ? 0 : 0x20,
        };
      },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => paths.map(() => 0),
      remove: async () => {
        removed = true;
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(inspectionCalls, 5);
});

test("benign Windows ancestor attribute changes do not impersonate generation drift", async () => {
  const allowed = "C:\\Program Files\\Docker";
  const target = `${allowed}\\cli-plugins`;
  let attributeCalls = 0;
  let removed = false;
  const result = await removePathTarget(
    target,
    [allowed],
    contextFor("windows"),
    {
      inspectTarget: async () =>
        removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 3n },
              fileAttributes: 0,
            },
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      readWindowsFileAttributes: async (paths) => {
        attributeCalls += 1;
        return paths.map((path) =>
          path === allowed && attributeCalls >= 2 ? 0x20 : 0,
        );
      },
      remove: async () => {
        removed = true;
      },
    },
  );

  assert.equal(result.status, "removed");
  assert.equal(attributeCalls, 4);
});

test("recursive removal rejects an ancestor transition during the target probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-ancestor-drift-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let generation = 1n;
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      lstat: (async (path: string) =>
        syntheticDirectoryStats(
          path === allowed ? generation : 10n,
        )) as unknown as typeof import("node:fs/promises").lstat,
      inspectTarget: async () => {
        if (removed) return { exists: false, isLink: false };
        generation += 1n;
        return {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 20n },
        };
      },
      readLinuxMountInfo: async () => "",
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed/i);
  assert.equal(removeCalls, 0);
});

test("recursive removal compares ancestor generations across complete safety passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-pass-drift-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let allowedReads = 0;
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("macos"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      lstat: (async (path: string) => {
        if (path !== allowed) return syntheticDirectoryStats(10n);
        allowedReads += 1;
        return syntheticDirectoryStats(allowedReads <= 2 ? 20n : 99n);
      }) as unknown as typeof import("node:fs/promises").lstat,
      inspectTarget: async () =>
        removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: target,
              identity: { device: 1n, inode: 30n },
            },
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed/i);
  assert.equal(allowedReads, 4);
  assert.equal(removeCalls, 0);
});

test("recursive removal rechecks ancestor generations after reading mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-mount-ancestor-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let generation = 20n;
  let removeCalls = 0;
  let mountReads = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      lstat: (async (path: string) =>
        syntheticDirectoryStats(
          path === allowed ? generation : 10n,
        )) as unknown as typeof import("node:fs/promises").lstat,
      inspectTarget: async () => ({
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 30n },
      }),
      readLinuxMountInfo: async () => {
        mountReads += 1;
        generation = 99n;
        return "";
      },
      remove: async () => {
        removeCalls += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed/i);
  assert.equal(mountReads, 1);
  assert.equal(removeCalls, 0);
});

test("elevated removal compares ancestor generations with the local boundary", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-elevated-ancestor-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let allowedReads = 0;
  let removeCalls = 0;
  let elevatedCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      lstat: (async (path: string) => {
        if (path !== allowed) return syntheticDirectoryStats(10n);
        allowedReads += 1;
        return syntheticDirectoryStats(allowedReads <= 6 ? 20n : 99n);
      }) as unknown as typeof import("node:fs/promises").lstat,
      inspectTarget: async () => ({
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 30n },
      }),
      readLinuxMountInfo: async () => "",
      remove: async () => {
        removeCalls += 1;
        throw new Error("permission denied");
      },
      runElevated: async () => {
        elevatedCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /ancestor.*changed/i);
  assert.equal(allowedReads, 9);
  assert.equal(removeCalls, 1);
  assert.equal(elevatedCalls, 0);
});

test("recursive removal rejects an ordinary target resolving outside its allowlist", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-resolved-boundary-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  const outside = join(root, "outside", "target");
  await mkdir(target, { recursive: true });
  let removed = false;
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () =>
        removed
          ? { exists: false, isLink: false }
          : {
              exists: true,
              isLink: false,
              realPath: outside,
              identity: { device: 1n, inode: 20n },
            },
      readLinuxMountInfo: async () => "",
      remove: async () => {
        removeCalls += 1;
        removed = true;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /resolv.*outside.*allowlist/i);
  assert.equal(removeCalls, 0);
});

test("ordinary targets accept the resolved spelling of an authorized boundary", async () => {
  const allowed = "/definition/alias";
  const target = `${allowed}/target`;
  const resolvedParent = "/physical/allowed";

  await assert.doesNotReject(
    assertSafeExistingTarget(target, [allowed], contextFor("linux"), {
      lstat: (async () =>
        syntheticDirectoryStats()) as unknown as typeof import("node:fs/promises").lstat,
      realpath: (async (path: string) =>
        path === allowed
          ? resolvedParent
          : `${resolvedParent}/target`) as unknown as typeof import("node:fs/promises").realpath,
      inspectTarget: async () => ({
        exists: true,
        isLink: false,
        realPath: `${resolvedParent}/target`,
        identity: { device: 1n, inode: 20n },
      }),
      readLinuxMountInfo: async () => "",
    }),
  );
});

test("Windows file attributes use a fixed executable and carry hostile paths only in stdin", async () => {
  type AttributeRunner = (
    executable: string,
    args: readonly string[],
    options: { readonly input?: string },
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  }>;
  const reader = (
    safetyModule as unknown as {
      readonly readWindowsFileAttributes?: (
        paths: readonly string[],
        run?: AttributeRunner,
      ) => Promise<readonly number[]>;
    }
  ).readWindowsFileAttributes;
  assert.ok(reader, "Windows attribute reader is missing");
  const paths = [
    "C:\\Program Files\\ordinary",
    "C:\\hostile\\résumé-$()'; Write-Output pwned; #",
  ];
  let calls = 0;
  let expectedPaths = paths;
  const encodedCommands: string[] = [];

  const runner: AttributeRunner = async (executable, args, options) => {
    calls += 1;
    assert.equal(
      executable,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    assert.deepEqual(args.slice(0, -1), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
    ]);
    const encodedCommand = args.at(-1) ?? "";
    assert.match(encodedCommand, /^[A-Za-z0-9+/]+=*$/);
    encodedCommands.push(encodedCommand);
    assert.equal(
      args.some((argument) => expectedPaths.includes(argument)),
      false,
    );
    assert.equal(
      options.input,
      Buffer.from(JSON.stringify(expectedPaths), "utf8").toString("base64"),
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify(expectedPaths.map((_, index) => index * 1024)),
      stderr: "",
    };
  };

  const attributes = await reader(paths, runner);
  expectedPaths = ["C:\\another\\路径-$env:TEMP"];
  const secondAttributes = await reader(expectedPaths, runner);

  assert.equal(calls, 2);
  assert.deepEqual(attributes, [0, 0x400]);
  assert.deepEqual(secondAttributes, [0]);
  assert.equal(encodedCommands[0], encodedCommands[1]);
});

test("Windows file attribute probing fails closed on incomplete or malformed output", async () => {
  const unsafeResults = [
    { exitCode: 1, stdout: "[0]", stderr: "" },
    { exitCode: 0, stdout: "[0]", stderr: "", stdoutTruncated: true },
    { exitCode: 0, stdout: "[0]", stderr: "", stderrTruncated: true },
    { exitCode: 0, stdout: "not-json", stderr: "warning" },
    { exitCode: 0, stdout: "0", stderr: "" },
    { exitCode: 0, stdout: "[0,1024]", stderr: "" },
    { exitCode: 0, stdout: "[-1]", stderr: "" },
  ];
  for (const result of unsafeResults) {
    await assert.rejects(
      readWindowsFileAttributes(["C:\\ordinary"], async () => result),
      /Windows file attribute|read complete Windows/i,
    );
  }
  await assert.rejects(
    readWindowsFileAttributes(["C:\\ordinary"], async () => ({
      exitCode: 7,
      stdout: "",
      stderr: "path-bearing diagnostics stay private",
    })),
    /exit code 7/,
  );

  let calls = 0;
  assert.deepEqual(
    await readWindowsFileAttributes([], async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }),
    [],
  );
  assert.equal(calls, 0);
});

test("Windows file attribute probing accepts bounded host diagnostics after valid output", async () => {
  const progressDiagnostic = [
    "#< CLIXML",
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
    '<Obj S="progress"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj>',
    "</Objs>",
  ].join("\n");

  assert.deepEqual(
    await readWindowsFileAttributes(["C:\\ordinary"], async () => ({
      exitCode: 0,
      stdout: "[0]",
      stderr: progressDiagnostic,
    })),
    [0],
  );
});

test("Windows file attribute probing reports only a whitelisted failure stage", async () => {
  await assert.rejects(
    readWindowsFileAttributes(["C:\\ordinary"], async () => ({
      exitCode: 1,
      stdout: "maximize-space-probe-error:decode-input",
      stderr: "C:\\ordinary should remain private",
    })),
    (error: unknown) => {
      assert.match(String(error), /probe stage decode-input/);
      assert.doesNotMatch(String(error), /C:\\ordinary|remain private/);
      return true;
    },
  );
  await assert.rejects(
    readWindowsFileAttributes(["C:\\ordinary"], async () => ({
      exitCode: 1,
      stdout: "maximize-space-probe-error:C:\\ordinary",
      stderr: "",
    })),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /C:\\ordinary/);
      return true;
    },
  );
});

test(
  "native Windows PowerShell probe returns one attribute per hostile path",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "maximize-space-windows-attributes-"),
    );
    const directory = join(root, "résumé-$()';");
    const file = join(root, "路径.txt");
    try {
      await mkdir(directory);
      await writeFile(file, "fixture");

      const attributes = await readWindowsFileAttributes([directory, file]);

      assert.deepEqual(
        attributes.map((value) => (value & 0x10) !== 0),
        [true, false],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test("swap removal reports a failed reactivation after the backup move fails", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const calls: LinuxSwapCommandInvocation[] = [];
  const operation = createSwapOperation(context, 0n, root, {
    commandRunner: async (invocation) => {
      calls.push(invocation);
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
        invocation.args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: `${swapfile}\n` };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.test) return success;
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = invocation.args[0];
        assert.ok(template);
        return { ...success, stdout: `${template.slice(0, -6)}ABC123\n` };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.mv) {
        return { ...success, exitCode: 1, stderr: "move failed" };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.swapon) {
        return { ...success, exitCode: 17, stderr: "reactivation failed" };
      }
      return success;
    },
  });

  const result = await operation.run();

  assert.equal(operation.fatal, true);
  assert.equal(
    result.detail,
    "move failed; rollback swapon failed: reactivation failed",
  );
  assert.equal(
    calls.filter(
      ({ executable }) => executable === LINUX_SWAP_EXECUTABLES.swapon,
    ).length,
    2,
  );
  assert.equal(calls.at(-1)?.executable, LINUX_SWAP_EXECUTABLES.swapon);
  assert.equal(
    calls.some(({ executable }) => executable === LINUX_SWAP_EXECUTABLES.sed),
    false,
  );
});

test("swap resize reports the exit code when reactivation has no diagnostic", async () => {
  const { context, root } = await createSwapFixture();
  const swapfile = join(root, "mnt", "swapfile");
  const calls: LinuxSwapCommandInvocation[] = [];
  const operation = createSwapOperation(context, 1024n ** 2n, root, {
    commandRunner: async (invocation) => {
      calls.push(invocation);
      const success = { exitCode: 0, stdout: "", stderr: "" };
      if (
        invocation.executable === LINUX_SWAP_EXECUTABLES.swapon &&
        invocation.args[0] === "--show=NAME"
      ) {
        return { ...success, stdout: `${swapfile}\n` };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.test) return success;
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.grep) return success;
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.df) {
        return { ...success, stdout: "Avail\n2147483648\n" };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.mktemp) {
        const template = invocation.args[0];
        assert.ok(template);
        return { ...success, stdout: `${template.slice(0, -6)}ABC123\n` };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.mv) {
        return { ...success, exitCode: 1, stderr: "move failed" };
      }
      if (invocation.executable === LINUX_SWAP_EXECUTABLES.swapon) {
        return { ...success, exitCode: 23, stderr: "" };
      }
      return success;
    },
  });

  const result = await operation.run();

  assert.equal(operation.fatal, true);
  assert.equal(
    result.detail,
    "move failed; rollback swapon failed: swapon exited 23",
  );
  assert.equal(
    calls.filter(({ executable }) => executable === LINUX_SWAP_EXECUTABLES.mv)
      .length,
    1,
  );
  assert.equal(
    calls.filter(
      ({ executable }) => executable === LINUX_SWAP_EXECUTABLES.swapon,
    ).length,
    2,
  );
  assert.equal(
    calls.some(
      ({ executable }) =>
        executable === LINUX_SWAP_EXECUTABLES.tee ||
        executable === LINUX_SWAP_EXECUTABLES.sed,
    ),
    false,
  );
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

const driftScenarios: readonly {
  readonly name: string;
  readonly expectedDetail: RegExp;
  readonly localRemovalFails: boolean;
  readonly expectedRemoveCalls: number;
  readonly inspections: (target: string) => TargetInspection[];
}[] = [
  {
    name: "path removal refuses a target whose kind changes after validation",
    expectedDetail: /kind changed/,
    localRemovalFails: false,
    expectedRemoveCalls: 0,
    inspections: (target) => [
      {
        exists: true,
        isLink: true,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: true,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
    ],
  },
  {
    name: "path removal refuses a target whose identity changes after validation",
    expectedDetail: /identity changed/,
    localRemovalFails: false,
    expectedRemoveCalls: 0,
    inspections: (target) => [
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 2n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 2n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 2n },
      },
    ],
  },
  {
    name: "path removal rechecks target identity before elevated removal",
    expectedDetail: /identity changed/,
    localRemovalFails: true,
    expectedRemoveCalls: 1,
    inspections: (target) => [
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 1n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 2n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 2n },
      },
      {
        exists: true,
        isLink: false,
        realPath: target,
        identity: { device: 1n, inode: 2n },
      },
    ],
  },
];

for (const scenario of driftScenarios) {
  test(scenario.name, async () => {
    const root = await mkdtemp(join(tmpdir(), "maximize-space-drift-"));
    const allowed = join(root, "allowed");
    const target = join(allowed, "target");
    await mkdir(target, { recursive: true });
    const inspections = scenario.inspections(target);
    let removeCalls = 0;
    let unlinkCalls = 0;
    let elevatedCalls = 0;
    const dependencies: RemovePathDependencies = {
      inspectTarget: async () => {
        const inspected = inspections.shift();
        assert.ok(inspected);
        return inspected;
      },
      remove: async () => {
        removeCalls++;
        if (scenario.localRemovalFails) throw new Error("permission denied");
      },
      unlink: async () => {
        unlinkCalls++;
      },
      runElevated: async () => {
        elevatedCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await removePathTarget(
      target,
      [allowed],
      {
        ...contextFor("linux"),
        temp: join(root, "runner-temp"),
        workspace: undefined,
      },
      dependencies,
    );

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", scenario.expectedDetail);
    assert.equal(removeCalls, scenario.expectedRemoveCalls);
    assert.equal(unlinkCalls, 0);
    assert.equal(elevatedCalls, 0);
  });
}

test("path removal rechecks mounts immediately before local removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-mount-drift-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  const mounted = join(target, "mounted");
  const sentinel = join(mounted, "sentinel");
  await mkdir(mounted, { recursive: true });
  await writeFile(sentinel, "preserve me");
  let mountReads = 0;
  let removeCalls = 0;
  let elevatedCalls = 0;
  const inspection: TargetInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 1n },
  };

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () => inspection,
      readLinuxMountInfo: async () => {
        mountReads++;
        return mountReads < 3 ? "" : linuxMountInfoLine(mounted);
      },
      remove: async () => {
        removeCalls++;
      },
      runElevated: async () => {
        elevatedCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /mounted path/);
  assert.equal(mountReads, 4);
  assert.equal(removeCalls, 0);
  assert.equal(elevatedCalls, 0);
  assert.equal(await readFile(sentinel, "utf8"), "preserve me");
});

test("path removal rechecks mounts immediately before elevated removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-elevated-mount-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  const mounted = join(target, "mounted");
  const sentinel = join(mounted, "sentinel");
  await mkdir(mounted, { recursive: true });
  await writeFile(sentinel, "preserve me");
  let mountReads = 0;
  let removeCalls = 0;
  let elevatedCalls = 0;
  const inspection: TargetInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 1n },
  };

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () => inspection,
      readLinuxMountInfo: async () => {
        mountReads++;
        return mountReads < 5 ? "" : linuxMountInfoLine(mounted);
      },
      remove: async () => {
        removeCalls++;
        throw new Error("permission denied");
      },
      runElevated: async () => {
        elevatedCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /mounted path/);
  assert.equal(mountReads, 6);
  assert.equal(removeCalls, 1);
  assert.equal(elevatedCalls, 0);
  assert.equal(await readFile(sentinel, "utf8"), "preserve me");
});

test("path removal runs a pre-mutation guard adjacent to local removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-local-guard-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  const events: string[] = [];
  let removed = false;
  let eventAtRemoval: string | undefined;
  const dependencies = {
    inspectTarget: async () => {
      events.push("inspect");
      return removed
        ? ({ exists: false, isLink: false } as const)
        : ({
            exists: true,
            isLink: false,
            realPath: target,
            identity: { device: 1n, inode: 1n },
          } as const);
    },
    readLinuxMountInfo: async () => {
      events.push("mountinfo");
      return "";
    },
    beforeMutation: async (boundary) => {
      events.push(`guard:${boundary}`);
    },
    remove: async () => {
      eventAtRemoval = events.at(-1);
      removed = true;
    },
  } as RemovePathDependencies;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    dependencies,
  );

  assert.equal(result.status, "removed");
  assert.equal(eventAtRemoval, "guard:local");
});

test("path removal aborts when its pre-mutation guard fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-failed-guard-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let removeCalls = 0;
  let elevatedCalls = 0;
  const dependencies = {
    beforeMutation: async () => {
      throw new Error("selection changed at mutation boundary");
    },
    remove: async () => {
      removeCalls += 1;
    },
    runElevated: async () => {
      elevatedCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as RemovePathDependencies;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /selection changed at mutation boundary/);
  assert.equal(removeCalls, 0);
  assert.equal(elevatedCalls, 0);
});

test("path removal bounds pre-mutation guard failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-bounded-guard-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let removeCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      beforeMutation: async () => {
        throw new Error("x".repeat(4_000));
      },
      remove: async () => {
        removeCalls += 1;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.detail?.length, 2_000);
  assert.equal(removeCalls, 0);
});

test("path removal reruns its pre-mutation guard adjacent to elevation", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximize-space-elevated-guard-"));
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  const events: string[] = [];
  let guardCalls = 0;
  let removed = false;
  let eventAtElevation: string | undefined;
  const dependencies = {
    inspectTarget: async () => {
      events.push("inspect");
      return removed
        ? ({ exists: false, isLink: false } as const)
        : ({
            exists: true,
            isLink: false,
            realPath: target,
            identity: { device: 1n, inode: 1n },
          } as const);
    },
    readLinuxMountInfo: async () => {
      events.push("mountinfo");
      return "";
    },
    beforeMutation: async (boundary) => {
      guardCalls += 1;
      events.push(`guard:${boundary}:${guardCalls}`);
    },
    remove: async () => {
      events.push("local-remove");
      throw new Error("permission denied");
    },
    runElevated: async () => {
      eventAtElevation = events.at(-1);
      removed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as RemovePathDependencies;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    dependencies,
  );

  assert.equal(result.status, "removed");
  assert.equal(guardCalls, 2);
  assert.equal(eventAtElevation, "guard:elevated:2");
});

test("path removal aborts when its elevated pre-mutation guard fails", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-failed-elevated-guard-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  const boundaries: string[] = [];
  let removeCalls = 0;
  let elevatedCalls = 0;

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      beforeMutation: async (boundary) => {
        boundaries.push(boundary);
        if (boundary === "elevated") {
          throw new Error("selection changed before elevation");
        }
      },
      remove: async () => {
        removeCalls += 1;
        throw new Error("permission denied");
      },
      runElevated: async () => {
        elevatedCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /selection changed before elevation/);
  assert.deepEqual(boundaries, ["local", "elevated"]);
  assert.equal(removeCalls, 1);
  assert.equal(elevatedCalls, 0);
});

test("elevated removal exit 0 still fails when the target exists", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maximize-space-elevated-postcondition-"),
  );
  const allowed = join(root, "allowed");
  const target = join(allowed, "target");
  await mkdir(target, { recursive: true });
  let elevatedCalls = 0;
  const inspection: TargetInspection = {
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 1n },
  };

  const result = await removePathTarget(
    target,
    [allowed],
    {
      ...contextFor("linux"),
      temp: join(root, "runner-temp"),
      workspace: undefined,
    },
    {
      inspectTarget: async () => inspection,
      readLinuxMountInfo: async () => "",
      remove: async () => {
        throw new Error("permission denied");
      },
      runElevated: async () => {
        elevatedCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /still exists/);
  assert.equal(elevatedCalls, 1);
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
  const inspections: TargetInspection[] = Array.from({ length: 7 }, () => ({
    exists: true,
    isLink: false,
    realPath: target,
    identity: { device: 1n, inode: 1n },
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
