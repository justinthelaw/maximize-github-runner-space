import * as core from "@actions/core";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, normalize, posix, win32 } from "node:path";
import {
  assertCommandTerminationConfirmed,
  inspectExecutable,
  runCommand,
  runElevated,
  sameCommandFileIdentity,
  UnconfirmedCommandTerminationError,
  UntrustedUnixExecutableError,
  type CommandFileIdentity,
  type CommandOptions,
} from "./command.js";
import {
  assertSafeExistingTarget,
  assertSafeRemovalTarget,
  captureSafeRemovalBoundary,
  inspectTarget,
  sameRemovalBoundary,
  sameRemovalBoundaryExact,
  type RemovalBoundarySnapshot,
} from "./safety.js";
import type {
  CleanupPlan,
  CommandResult,
  ComponentId,
  Operation,
  OperationExecutionContext,
  OperationPhase,
  OperationResult,
  RuntimeContext,
} from "./types.js";

export interface RemovePathOptions {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly target: string;
  readonly allowedParents: readonly string[];
  readonly context: RuntimeContext;
  readonly phase?: OperationPhase;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
}

export interface RemovePathDependencies {
  readonly inspect?: typeof inspectTarget;
  readonly boundary?: (
    target: string,
    allowedParents: readonly string[],
    context: RuntimeContext,
  ) => Promise<RemovalBoundarySnapshot>;
  readonly anchoredRemove?: typeof removeAnchoredUnixPath;
  readonly windowsLockedRemove?: (
    target: string,
    expectedBoundary: RemovalBoundarySnapshot,
    context: RuntimeContext,
  ) => Promise<void>;
  readonly inspectExecutable?: typeof inspectExecutable;
  readonly resolveExecutable?: ResolveExecutable;
  readonly expectedPrivilegedPythonRuntime?: PrivilegedPythonRuntime;
  readonly expectedWindowsRemovalRuntime?: WindowsRemovalRuntime;
  readonly commandRunner?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly currentRuntimeExecutable?: string;
  readonly expectedBoundary?: RemovalBoundarySnapshot;
  readonly remove?: typeof rm;
  readonly unlink?: typeof unlink;
  readonly elevate?: typeof runElevated;
  readonly traversalLimits?: RemovalTraversalLimits;
  readonly execution?: OperationExecutionContext;
}

export interface RemovalTraversalLimits {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
  /** Test-only monotonic clock override for in-process removal. */
  readonly now?: () => number;
}

const MAX_REMOVAL_ENTRIES = 2_000_000;
const MAX_REMOVAL_DEPTH = 256;
const MAX_REMOVAL_TIMEOUT_MS = 10 * 60_000;
const MAX_FILESYSTEM_CLEANUP_TIMEOUT_MS = 10 * 60_000;

export interface ExecuteOperationsOptions {
  /** Test-only monotonic clock override. */
  readonly now?: () => number;
  /** Test-only override for the aggregate filesystem budget. */
  readonly filesystemTimeoutMs?: number;
}

class FilesystemCleanupDeadlineError extends Error {
  override readonly name = "FilesystemCleanupDeadlineError";

  constructor() {
    super("filesystem cleanup exceeded its aggregate deadline");
  }
}

interface FilesystemCleanupBudget {
  readonly run: <T>(
    task: (execution: OperationExecutionContext) => Promise<T>,
  ) => Promise<T>;
  readonly pause: () => void;
  readonly resume: () => void;
}

function createFilesystemCleanupBudget(
  options: ExecuteOperationsOptions,
): FilesystemCleanupBudget {
  const now = options.now ?? (() => performance.now());
  const timeoutMs =
    options.filesystemTimeoutMs ?? MAX_FILESYSTEM_CLEANUP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_FILESYSTEM_CLEANUP_TIMEOUT_MS
  ) {
    throw new Error(
      `filesystem cleanup timeout must be an integer from 1 to ${MAX_FILESYSTEM_CLEANUP_TIMEOUT_MS}`,
    );
  }
  let activeSince: number | undefined;
  let activeElapsed = 0;
  let active = true;
  let lastNow: number | undefined;
  const readNow = (): number => {
    const current = now();
    if (!Number.isFinite(current)) {
      throw new Error("filesystem cleanup clock returned a non-finite value");
    }
    if (lastNow !== undefined && current < lastNow) {
      throw new Error("filesystem cleanup clock moved backwards");
    }
    lastNow = current;
    return current;
  };
  const elapsedAt = (current: number): number =>
    activeElapsed +
    (active && activeSince !== undefined ? current - activeSince : 0);
  const execution: OperationExecutionContext = {
    remainingMs: () => {
      const current = readNow();
      if (active && activeSince === undefined) activeSince = current;
      const remaining = timeoutMs - elapsedAt(current);
      if (remaining <= 0) throw new FilesystemCleanupDeadlineError();
      return Math.max(1, Math.floor(remaining));
    },
  };
  return {
    run: async <T>(
      task: (context: OperationExecutionContext) => Promise<T>,
    ) => {
      execution.remainingMs();
      const result = await task(execution);
      execution.remainingMs();
      return result;
    },
    pause: () => {
      if (!active) return;
      const current = readNow();
      if (activeSince !== undefined) {
        activeElapsed += current - activeSince;
        activeSince = undefined;
      }
      active = false;
    },
    resume: () => {
      if (active) return;
      const current = readNow();
      active = true;
      activeSince = current;
    },
  };
}

class RemovalTraversalLimitError extends Error {
  override readonly name = "RemovalTraversalLimitError";
}

interface NormalizedRemovalTraversalLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly timeoutMs: number;
  readonly now: () => number;
}

function normalizedRemovalTraversalLimits(
  limits: RemovalTraversalLimits = {},
): NormalizedRemovalTraversalLimits {
  const normalized = {
    maxEntries: limits.maxEntries ?? MAX_REMOVAL_ENTRIES,
    maxDepth: limits.maxDepth ?? MAX_REMOVAL_DEPTH,
    timeoutMs: limits.timeoutMs ?? MAX_REMOVAL_TIMEOUT_MS,
    now: limits.now ?? (() => performance.now()),
  };
  for (const [label, value, maximum] of [
    ["entry", normalized.maxEntries, MAX_REMOVAL_ENTRIES],
    ["depth", normalized.maxDepth, MAX_REMOVAL_DEPTH],
    ["timeout", normalized.timeoutMs, MAX_REMOVAL_TIMEOUT_MS],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(
        `anchored removal ${label} limit must be an integer from 1 to ${maximum}`,
      );
    }
  }
  return normalized;
}

function boundedRemovalTraversalLimits(
  limits: RemovalTraversalLimits = {},
  execution?: OperationExecutionContext,
): RemovalTraversalLimits {
  if (execution === undefined) return limits;
  const normalized = normalizedRemovalTraversalLimits(limits);
  return {
    ...limits,
    timeoutMs: Math.min(normalized.timeoutMs, execution.remainingMs()),
  };
}

const PRIVILEGED_ANCHORED_REMOVE_SOURCE = String.raw`
import { constants } from "node:fs";
import { lstat, open, opendir, readFile, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";

let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 131072) throw new Error("anchored removal input exceeded 128 KiB");
}
const spec = JSON.parse(input.toString("utf8"));
if (
  !Array.isArray(spec.entries) ||
  spec.entries.length === 0 ||
  spec.entries.length > 512
) throw new Error("anchored removal boundary is malformed");
const boundedInteger = (value, maximum, label) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("anchored removal has an invalid " + label + " limit");
  }
  return value;
};
const limits = {
  maxEntries: boundedInteger(spec.limits?.maxEntries, 2000000, "entry"),
  maxDepth: boundedInteger(spec.limits?.maxDepth, 256, "depth"),
  timeoutMs: boundedInteger(spec.limits?.timeoutMs, 600000, "timeout"),
};
const traversalStarted = performance.now();
let traversedEntries = 0;
const checkTraversal = (depth, countEntry = false) => {
  if (depth > limits.maxDepth) {
    throw new Error("anchored removal traversal exceeded depth " + limits.maxDepth);
  }
  if (countEntry) traversedEntries += 1;
  if (traversedEntries > limits.maxEntries) {
    throw new Error("anchored removal traversal exceeded " + limits.maxEntries + " entries");
  }
  if (performance.now() - traversalStarted >= limits.timeoutMs) {
    throw new Error("anchored removal traversal exceeded its time limit");
  }
};
const optionalBigInt = (value, label) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("anchored removal boundary has an invalid " + label);
  }
  return BigInt(value);
};
const expected = new Map(
  spec.entries.map((entry) => [entry.path, {
    device: BigInt(entry.device),
    inode: BigInt(entry.inode),
    mode: BigInt(entry.mode),
    userId: optionalBigInt(entry.userId, "owner"),
    groupId: optionalBigInt(entry.groupId, "group"),
    birthtimeNanoseconds: optionalBigInt(entry.birthtimeNanoseconds, "birth time"),
    changedNanoseconds: optionalBigInt(entry.changedNanoseconds, "change time"),
  }]),
);
const descriptorPath = (fd) =>
  (process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd") + "/" + fd;
const expectedAt = (path) => {
  const entry = expected.get(path);
  if (entry === undefined) throw new Error("cleanup target boundary changed at '" + path + "'");
  return entry;
};
const same = (entry, stat) =>
  entry.device === stat.dev &&
  entry.inode === stat.ino &&
  entry.mode === stat.mode &&
  (entry.userId === undefined || entry.userId === stat.uid) &&
  (entry.groupId === undefined || entry.groupId === stat.gid) &&
  (entry.birthtimeNanoseconds === undefined ||
    entry.birthtimeNanoseconds === stat.birthtimeNs) &&
  (entry.changedNanoseconds === undefined ||
    entry.changedNanoseconds === stat.ctimeNs);
const assertSameFilesystem = (expectedDevice, actualDevice, path) => {
  if (expectedDevice !== actualDevice) {
    throw new Error("refusing cleanup path that crosses a mounted filesystem at '" + path + "'");
  }
};
const descriptorMountId = async (fd) => {
  if (process.platform !== "linux") return undefined;
  const data = await readFile("/proc/self/fdinfo/" + fd, "utf8");
  if (Buffer.byteLength(data, "utf8") > 4096) {
    throw new Error("mount identity metadata exceeded 4 KiB for descriptor " + fd);
  }
  const matches = [...data.matchAll(/^mnt_id:[ \t]+([0-9]+)[ \t]*$/gm)];
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error("unable to verify mount identity for descriptor " + fd);
  }
  return BigInt(matches[0][1]);
};
const assertSameMount = (
  expectedDevice,
  actualDevice,
  expectedMountId,
  actualMountId,
  path,
) => {
  assertSameFilesystem(expectedDevice, actualDevice, path);
  if (
    (expectedMountId === undefined) !== (actualMountId === undefined) ||
    (expectedMountId !== undefined && expectedMountId !== actualMountId)
  ) {
    throw new Error("refusing cleanup path that crosses a mounted filesystem at '" + path + "'");
  }
};
const openDirectory = async (path, displayPath) => {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code ?? "")) {
      throw new Error("cleanup target boundary changed before anchored removal at '" + displayPath + "'");
    }
    throw error;
  }
};
const assertDirectoryAttached = async (
  directory,
  parent,
  name,
  expectedDirectory,
  displayDirectory,
) => {
  const path = posix.join(descriptorPath(parent.fd), name);
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code ?? "")) {
      throw new Error(
        "cleanup directory moved outside its anchored parent at '" +
          displayDirectory +
          "'",
      );
    }
    throw error;
  }
  const opened = await directory.stat({ bigint: true });
  if (
    current.dev !== expectedDirectory.device ||
    current.ino !== expectedDirectory.inode ||
    current.mode !== expectedDirectory.mode ||
    opened.dev !== expectedDirectory.device ||
    opened.ino !== expectedDirectory.inode ||
    opened.mode !== expectedDirectory.mode
  ) {
    throw new Error(
      "cleanup directory moved outside its anchored parent at '" +
        displayDirectory +
        "'",
    );
  }
};
const removeContents = async (
  directory,
  expectedDevice,
  expectedMountId,
  displayDirectory,
  parent,
  name,
  expectedDirectory,
  depth,
) => {
  checkTraversal(depth);
  await assertDirectoryAttached(
    directory,
    parent,
    name,
    expectedDirectory,
    displayDirectory,
  );
  const root = descriptorPath(directory.fd);
  const entries = await opendir(root);
  for await (const entry of entries) {
    checkTraversal(depth, true);
    await assertDirectoryAttached(
      directory,
      parent,
      name,
      expectedDirectory,
      displayDirectory,
    );
    if (entry.name === "." || entry.name === ".." || entry.name.includes("/")) {
      throw new Error("directory returned an unsafe entry name");
    }
    const child = posix.join(root, entry.name);
    const displayChild = posix.join(displayDirectory, entry.name);
    const before = await lstat(child, { bigint: true });
    assertSameFilesystem(expectedDevice, before.dev, displayChild);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      let childHandle;
      try {
        childHandle = await openDirectory(child, displayChild);
        const opened = await childHandle.stat({ bigint: true });
        if (before.dev !== opened.dev || before.ino !== opened.ino || before.mode !== opened.mode) {
          throw new Error("directory entry changed before removal: '" + displayChild + "'");
        }
        const childMountId = await descriptorMountId(childHandle.fd);
        assertSameMount(
          expectedDevice,
          opened.dev,
          expectedMountId,
          childMountId,
          displayChild,
        );
        await removeContents(
          childHandle,
          expectedDevice,
          expectedMountId,
          displayChild,
          directory,
          entry.name,
          { device: opened.dev, inode: opened.ino, mode: opened.mode },
          depth + 1,
        );
        await assertDirectoryAttached(
          directory,
          parent,
          name,
          expectedDirectory,
          displayDirectory,
        );
        checkTraversal(depth);
        await rmdir(child);
      } finally {
        await childHandle?.close().catch(() => undefined);
      }
    } else {
      const immediate = await lstat(child, { bigint: true });
      if (
        before.dev !== immediate.dev ||
        before.ino !== immediate.ino ||
        before.mode !== immediate.mode
      ) {
        throw new Error("directory entry changed before removal: '" + displayChild + "'");
      }
      await assertDirectoryAttached(
        directory,
        parent,
        name,
        expectedDirectory,
        displayDirectory,
      );
      checkTraversal(depth);
      await unlink(child);
    }
  }
  await assertDirectoryAttached(
    directory,
    parent,
    name,
    expectedDirectory,
    displayDirectory,
  );
};

const target = posix.normalize(posix.resolve(spec.target));
const parts = target.split(posix.sep).filter(Boolean);
if (parts.length === 0) throw new Error("refusing to remove the filesystem root");
const handles = [];
let parent;
let prefix = "";
try {
  parent = await openDirectory(posix.sep, posix.sep);
  handles.push(parent);
  for (const part of parts.slice(0, -1)) {
    prefix = posix.join(posix.sep, prefix, part);
    const opened = await openDirectory(posix.join(descriptorPath(parent.fd), part), prefix);
    handles.push(opened);
    if (!same(expectedAt(prefix), await opened.stat({ bigint: true }))) {
      throw new Error("cleanup target boundary changed before anchored removal at '" + prefix + "'");
    }
    parent = opened;
  }
  const name = parts.at(-1);
  if (name === undefined || parent === undefined) throw new Error("invalid removal target");
  const anchoredTarget = posix.join(descriptorPath(parent.fd), name);
  const before = await lstat(anchoredTarget, { bigint: true });
  const parentStat = await parent.stat({ bigint: true });
  assertSameFilesystem(parentStat.dev, before.dev, target);
  const targetExpected = expectedAt(target);
  if (!same(targetExpected, before)) {
    throw new Error("cleanup target boundary changed before anchored removal at '" + target + "'");
  }
  if (before.isDirectory() && !before.isSymbolicLink()) {
    let targetHandle;
    try {
      targetHandle = await openDirectory(anchoredTarget, target);
      const opened = await targetHandle.stat({ bigint: true });
      if (!same(targetExpected, opened)) {
        throw new Error("cleanup target boundary changed before anchored removal at '" + target + "'");
      }
      const parentMountId = await descriptorMountId(parent.fd);
      const targetMountId = await descriptorMountId(targetHandle.fd);
      assertSameMount(
        parentStat.dev,
        opened.dev,
        parentMountId,
        targetMountId,
        target,
      );
      await removeContents(
        targetHandle,
        opened.dev,
        targetMountId,
        target,
        parent,
        name,
        { device: opened.dev, inode: opened.ino, mode: opened.mode },
        0,
      );
      checkTraversal(0);
      await rmdir(anchoredTarget);
    } finally {
      await targetHandle?.close().catch(() => undefined);
    }
  } else {
    checkTraversal(0);
    await unlink(anchoredTarget);
  }
} finally {
  for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
}
`;

const PRIVILEGED_PYTHON_ANCHORED_REMOVE_SOURCE = String.raw`
import ctypes
import errno
import json
import os
import posixpath
import re
import stat
import sys
import time

MAX_INPUT_BYTES = 131072

payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
if len(payload) > MAX_INPUT_BYTES:
    raise RuntimeError("anchored removal input exceeded 128 KiB")
spec = json.loads(payload.decode("utf-8"))
if not isinstance(spec, dict) or not isinstance(spec.get("target"), str):
    raise RuntimeError("anchored removal input is malformed")
if not isinstance(spec.get("entries"), list) or not 1 <= len(spec["entries"]) <= 512:
    raise RuntimeError("anchored removal boundary is malformed")

def bounded_integer(value, maximum, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise RuntimeError("anchored removal has an invalid " + label + " limit")
    return value

limits = spec.get("limits")
if not isinstance(limits, dict):
    raise RuntimeError("anchored removal traversal limits are malformed")
max_entries = bounded_integer(limits.get("maxEntries"), 2000000, "entry")
max_depth = bounded_integer(limits.get("maxDepth"), 256, "depth")
timeout_ms = bounded_integer(limits.get("timeoutMs"), 600000, "timeout")
traversal_started = time.monotonic()
traversed_entries = 0

def check_traversal(depth, count_entry=False):
    global traversed_entries
    if depth > max_depth:
        raise RuntimeError("anchored removal traversal exceeded depth " + str(max_depth))
    if count_entry:
        traversed_entries += 1
    if traversed_entries > max_entries:
        raise RuntimeError("anchored removal traversal exceeded " + str(max_entries) + " entries")
    if (time.monotonic() - traversal_started) * 1000 >= timeout_ms:
        raise RuntimeError("anchored removal traversal exceeded its time limit")

def decimal(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9]+", value) is None:
        raise RuntimeError("anchored removal boundary has an invalid " + label)
    return int(value)

expected = {}
for entry in spec["entries"]:
    if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
        raise RuntimeError("anchored removal boundary entry is malformed")
    path = entry["path"]
    if path in expected:
        raise RuntimeError("anchored removal boundary contains a duplicate path")
    expected[path] = {
        "device": decimal(entry.get("device"), "device"),
        "inode": decimal(entry.get("inode"), "inode"),
        "mode": decimal(entry.get("mode"), "mode"),
        "user_id": None if entry.get("userId") is None else decimal(entry.get("userId"), "owner"),
        "group_id": None if entry.get("groupId") is None else decimal(entry.get("groupId"), "group"),
        "birthtime_ns": None if entry.get("birthtimeNanoseconds") is None else decimal(entry.get("birthtimeNanoseconds"), "birth time"),
        "changed_ns": None if entry.get("changedNanoseconds") is None else decimal(entry.get("changedNanoseconds"), "change time"),
    }

def expected_at(path):
    entry = expected.get(path)
    if entry is None:
        raise RuntimeError("cleanup target boundary changed at '" + path + "'")
    return entry

def stable_identity(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode)

def assert_same(expected_identity, metadata, path):
    actual_birthtime_ns = getattr(metadata, "st_birthtime_ns", None)
    if actual_birthtime_ns is None and hasattr(metadata, "st_birthtime"):
        actual_birthtime_ns = int(metadata.st_birthtime * 1000000000)
    if (
        expected_identity["device"] != metadata.st_dev
        or expected_identity["inode"] != metadata.st_ino
        or expected_identity["mode"] != metadata.st_mode
        or (
            expected_identity["user_id"] is not None
            and expected_identity["user_id"] != metadata.st_uid
        )
        or (
            expected_identity["group_id"] is not None
            and expected_identity["group_id"] != metadata.st_gid
        )
        or (
            expected_identity["birthtime_ns"] is not None
            and expected_identity["birthtime_ns"] != actual_birthtime_ns
        )
        or (
            expected_identity["changed_ns"] is not None
            and expected_identity["changed_ns"] != metadata.st_ctime_ns
        )
    ):
        raise RuntimeError(
            "cleanup target boundary changed before anchored removal at '" + path + "'"
        )

class DarwinFsid(ctypes.Structure):
    _fields_ = [("values", ctypes.c_int32 * 2)]

class DarwinStatfs(ctypes.Structure):
    _fields_ = [
        ("f_bsize", ctypes.c_uint32),
        ("f_iosize", ctypes.c_int32),
        ("f_blocks", ctypes.c_uint64),
        ("f_bfree", ctypes.c_uint64),
        ("f_bavail", ctypes.c_uint64),
        ("f_files", ctypes.c_uint64),
        ("f_ffree", ctypes.c_uint64),
        ("f_fsid", DarwinFsid),
        ("f_owner", ctypes.c_uint32),
        ("f_type", ctypes.c_uint32),
        ("f_flags", ctypes.c_uint32),
        ("f_fssubtype", ctypes.c_uint32),
        ("f_fstypename", ctypes.c_char * 16),
        ("f_mntonname", ctypes.c_char * 1024),
        ("f_mntfromname", ctypes.c_char * 1024),
        ("f_flags_ext", ctypes.c_uint32),
        ("f_reserved", ctypes.c_uint32 * 7),
    ]

def descriptor_mount_id(descriptor):
    if sys.platform == "linux":
        with open("/proc/self/fdinfo/" + str(descriptor), "r", encoding="utf-8") as stream:
            data = stream.read(4097)
        if len(data.encode("utf-8")) > 4096:
            raise RuntimeError(
                "mount identity metadata exceeded 4 KiB for descriptor " + str(descriptor)
            )
        matches = re.findall(r"^mnt_id:[ \t]+([0-9]+)[ \t]*$", data, re.MULTILINE)
        if len(matches) != 1:
            raise RuntimeError("unable to verify mount identity for descriptor " + str(descriptor))
        return ("linux", int(matches[0]))
    if sys.platform == "darwin":
        metadata = DarwinStatfs()
        libc = ctypes.CDLL(None, use_errno=True)
        libc.fstatfs.argtypes = [ctypes.c_int, ctypes.POINTER(DarwinStatfs)]
        libc.fstatfs.restype = ctypes.c_int
        if libc.fstatfs(descriptor, ctypes.byref(metadata)) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        mount_point = bytes(metadata.f_mntonname).split(b"\0", 1)[0]
        return (
            "darwin",
            int(metadata.f_fsid.values[0]),
            int(metadata.f_fsid.values[1]),
            mount_point,
        )
    raise RuntimeError("unsupported platform for mount identity verification")

def assert_same_mount(expected_device, metadata, expected_mount_id, actual_mount_id, path):
    if expected_device != metadata.st_dev:
        raise RuntimeError(
            "refusing cleanup path that crosses a mounted filesystem at '" + path + "'"
        )
    if expected_mount_id != actual_mount_id:
        raise RuntimeError(
            "refusing cleanup path that crosses a mounted filesystem at '" + path + "'"
        )

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def open_directory(name, parent_descriptor, display_path):
    try:
        return os.open(name, directory_flags, dir_fd=parent_descriptor)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            raise RuntimeError(
                "cleanup target boundary changed before anchored removal at '"
                + display_path
                + "'"
            ) from error
        raise

def assert_directory_attached(
    directory_descriptor,
    parent_descriptor,
    name,
    expected_directory,
    display_directory,
):
    try:
        current = os.stat(
            name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            raise RuntimeError(
                "cleanup directory moved outside its anchored parent at '"
                + display_directory
                + "'"
            ) from error
        raise
    opened = os.fstat(directory_descriptor)
    if (
        stable_identity(current) != expected_directory
        or stable_identity(opened) != expected_directory
    ):
        raise RuntimeError(
            "cleanup directory moved outside its anchored parent at '"
            + display_directory
            + "'"
        )

def remove_contents(
    directory_descriptor,
    expected_device,
    expected_mount_id,
    display_directory,
    parent_descriptor,
    directory_name,
    expected_directory,
    depth,
):
    check_traversal(depth)
    while True:
        assert_directory_attached(
            directory_descriptor,
            parent_descriptor,
            directory_name,
            expected_directory,
            display_directory,
        )
        found_entry = False
        with os.scandir(directory_descriptor) as entries:
            for entry in entries:
                check_traversal(depth, True)
                assert_directory_attached(
                    directory_descriptor,
                    parent_descriptor,
                    directory_name,
                    expected_directory,
                    display_directory,
                )
                found_entry = True
                name = entry.name
                if not isinstance(name, str) or name in (".", "..") or "/" in name:
                    raise RuntimeError("directory returned an unsafe entry name")
                display_child = posixpath.join(display_directory, name)
                before = os.stat(
                    name,
                    dir_fd=directory_descriptor,
                    follow_symlinks=False,
                )
                if before.st_dev != expected_device:
                    raise RuntimeError(
                        "refusing cleanup path that crosses a mounted filesystem at '"
                        + display_child
                        + "'"
                    )
                if stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode):
                    child_descriptor = open_directory(
                        name,
                        directory_descriptor,
                        display_child,
                    )
                    try:
                        opened = os.fstat(child_descriptor)
                        if stable_identity(before) != stable_identity(opened):
                            raise RuntimeError(
                                "directory entry changed before removal: '" + display_child + "'"
                            )
                        child_mount_id = descriptor_mount_id(child_descriptor)
                        assert_same_mount(
                            expected_device,
                            opened,
                            expected_mount_id,
                            child_mount_id,
                            display_child,
                        )
                        remove_contents(
                            child_descriptor,
                            expected_device,
                            expected_mount_id,
                            display_child,
                            directory_descriptor,
                            name,
                            stable_identity(opened),
                            depth + 1,
                        )
                        assert_directory_attached(
                            directory_descriptor,
                            parent_descriptor,
                            directory_name,
                            expected_directory,
                            display_directory,
                        )
                        check_traversal(depth)
                        os.rmdir(name, dir_fd=directory_descriptor)
                    finally:
                        os.close(child_descriptor)
                else:
                    immediate = os.stat(
                        name,
                        dir_fd=directory_descriptor,
                        follow_symlinks=False,
                    )
                    if stable_identity(before) != stable_identity(immediate):
                        raise RuntimeError(
                            "directory entry changed before removal: '"
                            + display_child
                            + "'"
                        )
                    assert_directory_attached(
                        directory_descriptor,
                        parent_descriptor,
                        directory_name,
                        expected_directory,
                        display_directory,
                    )
                    check_traversal(depth)
                    os.unlink(name, dir_fd=directory_descriptor)
        if not found_entry:
            assert_directory_attached(
                directory_descriptor,
                parent_descriptor,
                directory_name,
                expected_directory,
                display_directory,
            )
            return

target = posixpath.normpath(posixpath.abspath(spec["target"]))
parts = [part for part in target.split("/") if part]
if not parts:
    raise RuntimeError("refusing to remove the filesystem root")

handles = []
try:
    parent_descriptor = os.open("/", directory_flags)
    handles.append(parent_descriptor)
    prefix = ""
    for part in parts[:-1]:
        prefix = posixpath.join("/", prefix, part)
        opened_descriptor = open_directory(part, parent_descriptor, prefix)
        handles.append(opened_descriptor)
        assert_same(expected_at(prefix), os.fstat(opened_descriptor), prefix)
        parent_descriptor = opened_descriptor

    name = parts[-1]
    before = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    parent_metadata = os.fstat(parent_descriptor)
    if parent_metadata.st_dev != before.st_dev:
        raise RuntimeError(
            "refusing cleanup path that crosses a mounted filesystem at '" + target + "'"
        )
    target_expected = expected_at(target)
    assert_same(target_expected, before, target)
    if stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode):
        target_descriptor = open_directory(name, parent_descriptor, target)
        try:
            opened = os.fstat(target_descriptor)
            assert_same(target_expected, opened, target)
            parent_mount_id = descriptor_mount_id(parent_descriptor)
            target_mount_id = descriptor_mount_id(target_descriptor)
            assert_same_mount(
                parent_metadata.st_dev,
                opened,
                parent_mount_id,
                target_mount_id,
                target,
            )
            remove_contents(
                target_descriptor,
                opened.st_dev,
                target_mount_id,
                target,
                parent_descriptor,
                name,
                stable_identity(opened),
                0,
            )
            check_traversal(0)
            os.rmdir(name, dir_fd=parent_descriptor)
        finally:
            os.close(target_descriptor)
    else:
        check_traversal(0)
        os.unlink(name, dir_fd=parent_descriptor)
finally:
    for descriptor in reversed(handles):
        os.close(descriptor)
`;

const UNIX_PYTHON_EXECUTABLE = "/usr/bin/python3";
const PRIVILEGED_REMOVAL_INPUT_LIMIT_BYTES = 128 * 1024;
const PRIVILEGED_REMOVAL_ENTRY_LIMIT = 512;

interface PrivilegedPythonRuntime {
  readonly executable: string;
  readonly identity: CommandFileIdentity;
}

type ResolveExecutable = (path: string) => Promise<string>;

const WINDOWS_POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
const WINDOWS_REMOVAL_INPUT_LIMIT_BYTES = 128 * 1024;
const WINDOWS_BOUNDARY_VALIDATOR_TIMEOUT_MS = 60_000;
const WINDOWS_REMOVAL_HELPER_GRACE_MS = 60_000;

const WINDOWS_BOUNDARY_VALIDATOR_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { win32 } from "node:path";

const suppliedInput = globalThis.__windowsRemovalInput;
let input = suppliedInput instanceof Uint8Array
  ? Buffer.from(suppliedInput)
  : Buffer.alloc(0);
if (!(suppliedInput instanceof Uint8Array)) {
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    if (input.length > 131072) throw new Error("Windows removal input exceeded 128 KiB");
  }
}
if (input.length > 131072) throw new Error("Windows removal input exceeded 128 KiB");
const spec = JSON.parse(input.toString("utf8"));
if (process.platform !== "win32") throw new Error("Windows removal validator ran on a non-Windows host");
if (
  typeof spec.target !== "string" ||
  typeof spec.runtimeExecutable !== "string" ||
  typeof spec.powershellExecutable !== "string" ||
  !["structure", "locks", "remove"].includes(spec.mode)
) {
  throw new Error("Windows removal input is malformed");
}
for (const [name, maximum] of [
  ["maxEntries", 2000000], ["maxDepth", 256], ["timeoutMs", 600000],
]) {
  const value = spec.limits?.[name];
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("Windows removal limit is invalid: " + name);
  }
}
if (!Array.isArray(spec.entries) || spec.entries.length === 0 || spec.entries.length > 512) {
  throw new Error("Windows removal boundary is malformed");
}
const canonical = (value) => win32.normalize(value).toLowerCase();
if (canonical(process.execPath) !== canonical(spec.runtimeExecutable)) {
  throw new Error("Windows removal validator did not run through the pinned Node executable");
}
const decimal = (value, name) => {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("Windows removal boundary has an invalid " + name);
  }
  return BigInt(value);
};
const assertField = (actual, expected, name) => {
  if (expected !== undefined && actual !== decimal(expected, name)) {
    throw new Error("Windows removal identity changed at " + name);
  }
};
const inspectStableExecutable = async (path, label) => {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(label + " is not a regular file");
  }
  const handle = await open(path, constants.O_RDONLY);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(label + " changed before validation");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    for (const value of [handleAfter, pathAfter]) {
      if (
        value.dev !== opened.dev || value.ino !== opened.ino || value.mode !== opened.mode ||
        value.size !== opened.size || value.mtimeNs !== opened.mtimeNs || value.ctimeNs !== opened.ctimeNs
      ) throw new Error(label + " changed during validation");
    }
    return { stat: before, contentSha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};
const assertExecutable = (actual, expected, label) => {
  if (expected === null || typeof expected !== "object") {
    throw new Error(label + " identity is missing");
  }
  assertField(actual.stat.dev, expected.device, label + " device");
  assertField(actual.stat.ino, expected.inode, label + " inode");
  assertField(actual.stat.mode, expected.mode, label + " mode");
  assertField(actual.stat.size, expected.size, label + " size");
  assertField(actual.stat.mtimeNs, expected.modifiedNanoseconds, label + " mtime");
  assertField(actual.stat.ctimeNs, expected.changedNanoseconds, label + " ctime");
  assertField(actual.stat.uid, expected.userId, label + " owner");
  assertField(actual.stat.gid, expected.groupId, label + " group");
  if (
    typeof expected.contentSha256 !== "string" ||
    actual.contentSha256 !== expected.contentSha256
  ) throw new Error(label + " content changed");
};
const runtime = await inspectStableExecutable(process.execPath, "Windows removal Node executable");
assertExecutable(runtime, spec.runtime, "runtime");
const powershell = await inspectStableExecutable(
  spec.powershellExecutable,
  "fixed Windows PowerShell executable",
);
assertExecutable(powershell, spec.powershell, "PowerShell");

const target = win32.normalize(spec.target);
if (!win32.isAbsolute(target)) throw new Error("Windows removal target is not absolute");
let previous = win32.parse(target).root;
for (const [index, entry] of spec.entries.entries()) {
  if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") {
    throw new Error("Windows removal boundary entry is malformed");
  }
  const path = win32.normalize(entry.path);
  if (canonical(path) !== canonical(entry.path)) {
    throw new Error("Windows removal boundary path is not normalized");
  }
  const relative = win32.relative(previous, path);
  if (
    relative === "" || relative === ".." || relative.startsWith("..\\") ||
    win32.isAbsolute(relative) || relative.includes("\\") || relative.includes("/")
  ) {
    throw new Error("Windows removal boundary omits an ancestor");
  }
  if (index < spec.entries.length - 1) {
    const relativeTarget = win32.relative(path, target);
    if (
      relativeTarget === "" || relativeTarget === ".." ||
      relativeTarget.startsWith("..\\") || win32.isAbsolute(relativeTarget)
    ) throw new Error("Windows removal boundary does not contain the target");
  } else if (canonical(path) !== canonical(target)) {
    throw new Error("Windows removal boundary does not end at the target");
  }
  const actual = await lstat(path, { bigint: true });
  if (
    actual.dev !== decimal(entry.device, "device") ||
    actual.ino !== decimal(entry.inode, "inode") ||
    actual.mode !== decimal(entry.mode, "mode")
  ) throw new Error("Windows removal boundary changed at '" + path + "'");
  assertField(actual.uid, entry.userId, "boundary owner");
  assertField(actual.gid, entry.groupId, "boundary group");
  assertField(actual.birthtimeNs, entry.birthtimeNanoseconds, "boundary birth time");
  assertField(actual.ctimeNs, entry.changedNanoseconds, "boundary change time");
  previous = path;
}
`;

const WINDOWS_BOUNDARY_VALIDATOR_BASE64 = Buffer.from(
  WINDOWS_BOUNDARY_VALIDATOR_SOURCE,
  "utf8",
).toString("base64");

const WINDOWS_LOCKED_REMOVE_POWERSHELL_SOURCE = [
  String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$encodedInput = [Console]::In.ReadToEnd()
if ($encodedInput.Length -gt 174764) { throw 'Windows removal input exceeded its encoded bound' }
$inputBytes = [Convert]::FromBase64String($encodedInput)
if ($inputBytes.Length -gt 131072) { throw 'Windows removal input exceeded 128 KiB' }
$jsonInput = [Text.Encoding]::UTF8.GetString($inputBytes)
$spec = $jsonInput | ConvertFrom-Json
$entries = @($spec.entries)
if ($entries.Count -lt 1 -or $entries.Count -gt 512) { throw 'Windows removal boundary is malformed' }
if ([string]::IsNullOrWhiteSpace([string]$spec.target)) { throw 'Windows removal target is missing' }
if ([string]::IsNullOrWhiteSpace([string]$spec.runtimeExecutable)) { throw 'Windows removal runtime is missing' }
if ([string]::IsNullOrWhiteSpace([string]$spec.powershellExecutable)) { throw 'Windows PowerShell runtime is missing' }
if (@('structure', 'locks', 'remove') -notcontains [string]$spec.mode) { throw 'Windows removal mode is invalid' }

function Get-Bound {
 param($Value,[long]$Maximum)
 [long]$number=$Value
 if ($number -lt 1 -or $number -gt $Maximum) { throw 'Invalid Windows removal limit' }
 $number
}

$script:TraversalLimits = @{
    MaxEntries = Get-Bound $spec.limits.maxEntries 2000000
    MaxDepth = Get-Bound $spec.limits.maxDepth 256
    TimeoutMs = Get-Bound $spec.limits.timeoutMs 600000
}
$script:TraversalEntries = 0L
$script:TraversalClock = $null

function Reset-Traversal {
 $script:TraversalEntries=0L
 if ($null -eq $script:TraversalClock) {
  $script:TraversalClock=[Diagnostics.Stopwatch]::StartNew()
 }
}

function Assert-Traversal {
 param([int]$Depth,[switch]$CountEntry)
 if ($Depth -gt $script:TraversalLimits.MaxDepth) { throw "Windows removal traversal exceeded depth $($script:TraversalLimits.MaxDepth)" }
 if ($CountEntry) { $script:TraversalEntries++; if ($script:TraversalEntries -gt $script:TraversalLimits.MaxEntries) { throw "Windows removal traversal exceeded $($script:TraversalLimits.MaxEntries) entries" } }
 if ($null -eq $script:TraversalClock -or $script:TraversalClock.ElapsedMilliseconds -ge $script:TraversalLimits.TimeoutMs) { throw "Windows removal traversal exceeded $($script:TraversalLimits.TimeoutMs) ms" }
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class LockedRemovalNative {
    private const uint DELETE = 0x00010000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_NO_MORE_FILES = 18;
    private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
    private const int FILE_DISPOSITION_INFO_EX_CLASS = 21;
    private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfoEx {
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FindData {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint Reserved0;
        public uint Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string FileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string AlternateFileName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file, int informationClass, out FileAttributeTagInfo information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file, int informationClass, ref FileDispositionInfoEx information,
        uint bufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string fileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFileW(string fileName, out FindData findData);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextFileW(IntPtr findFile, out FindData findData);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr findFile);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess, SafeFileHandle sourceHandle, IntPtr targetProcess,
        out SafeFileHandle targetHandle, uint desiredAccess, bool inheritHandle,
        uint options);

    private static string Extended(string path) {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static SafeFileHandle OpenCore(string path, uint access, uint shareMode) {
        SafeFileHandle handle = CreateFileW(
            Extended(path), access, shareMode, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Could not lock Windows cleanup path '" + path + "'");
        }
        return handle;
    }

    private static SafeFileHandle OpenTargetWithTimeout(string path, uint access, uint shareMode) {
        object sync = new object();
        SafeFileHandle opened = null;
        Exception failure = null;
        bool timedOut = false;
        Thread worker = new Thread(() => {
            SafeFileHandle candidate = null;
            try {
                candidate = OpenCore(path, access, shareMode);
                lock (sync) {
                    if (timedOut) {
                        candidate.Dispose();
                    } else {
                        opened = candidate;
                    }
                }
            } catch (Exception error) {
                lock (sync) {
                    if (!timedOut) failure = error;
                }
                if (candidate != null) candidate.Dispose();
            }
        });
        worker.IsBackground = true;
        worker.Start();
        if (!worker.Join(5000)) {
            lock (sync) {
                timedOut = true;
                if (opened != null) opened.Dispose();
                opened = null;
            }
            throw new TimeoutException("Timed out while opening locked Windows cleanup path '" + path + "'");
        }
        if (failure != null) throw failure;
        if (opened == null) throw new IOException("Windows cleanup path open returned no handle");
        return opened;
    }

    private static SafeFileHandle OpenTargetWithTimeout(string path) {
        return OpenTargetWithTimeout(
            path,
            FILE_READ_ATTRIBUTES | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }

    private static SafeFileHandle Open(string path, uint access, uint shareMode) {
        return OpenTargetWithTimeout(path, access, shareMode);
    }

    private static SafeFileHandle Open(string path, uint access) {
        return Open(path, access, FILE_SHARE_READ);
    }

    public static SafeFileHandle OpenAnchor(string path) {
        SafeFileHandle handle = Open(path, FILE_READ_ATTRIBUTES);
        try {
            uint attributes = Attributes(handle);
            if (!IsDirectory(attributes) || IsReparsePoint(attributes)) {
                throw new InvalidOperationException(
                    "Windows cleanup ancestor is not a direct directory: '" + path + "'");
            }
            return handle;
        } catch {
            handle.Dispose();
            throw;
        }
    }

    public static SafeFileHandle OpenExecutable(string path) {
        return Open(path, GENERIC_READ | FILE_READ_ATTRIBUTES);
    }

    public static SafeFileHandle OpenTarget(string path) {
        return OpenTargetWithTimeout(path);
    }

    public static SafeFileHandle OpenSharedTarget(string path) {
        return Open(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }

    public static uint Attributes(SafeFileHandle handle) {
        FileAttributeTagInfo information;
        if (!GetFileInformationByHandleEx(
            handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, out information,
            (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect locked Windows cleanup path");
        }
        return information.FileAttributes;
    }

    public static bool IsDirectory(uint attributes) {
        return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    }

    public static bool IsReparsePoint(uint attributes) {
        return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }

    public static void AssertExecutable(SafeFileHandle handle, string label) {
        uint attributes = Attributes(handle);
        if (IsDirectory(attributes) || IsReparsePoint(attributes)) {
            throw new InvalidOperationException(label + " is not a regular file");
        }
    }

    public static string ComputeHash(SafeFileHandle handle, string label) {
        AssertExecutable(handle, label);
        SafeFileHandle duplicate;
        IntPtr process = GetCurrentProcess();
        if (!DuplicateHandle(
            process, handle, process, out duplicate, 0, false,
            DUPLICATE_SAME_ACCESS)) {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Could not duplicate locked " + label + " handle");
        }
        using (FileStream stream = new FileStream(duplicate, FileAccess.Read))
        using (SHA256 sha256 = SHA256.Create()) {
            return BitConverter.ToString(sha256.ComputeHash(stream))
                .Replace("-", "").ToLowerInvariant();
        }
    }

    public static string FirstChild(string path) {
        string extended = Extended(path).TrimEnd('\\') + "\\*";
        FindData data;
        IntPtr find = FindFirstFileW(extended, out data);
        if (find == new IntPtr(-1)) {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_FILE_NOT_FOUND) return null;
            throw new Win32Exception(error, "Could not enumerate locked Windows cleanup path '" + path + "'");
        }
        try {
            while (true) {
                string name = data.FileName;
                if (name != "." && name != "..") {
                    return path.EndsWith("\\", StringComparison.Ordinal)
                        ? path + name
                        : path + "\\" + name;
                }
                if (FindNextFileW(find, out data)) continue;
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NO_MORE_FILES) return null;
                throw new Win32Exception(error, "Could not continue enumerating locked Windows cleanup path '" + path + "'");
            }
        } finally {
            FindClose(find);
        }
    }

    public sealed class ChildCursor : IDisposable {
        private readonly string path;
        private IntPtr find;
        private FindData current;
        private bool hasCurrent;

        internal ChildCursor(string selectedPath) {
            path = selectedPath;
            string extended = Extended(path).TrimEnd('\\') + "\\*";
            find = FindFirstFileW(extended, out current);
            if (find == new IntPtr(-1)) {
                int error = Marshal.GetLastWin32Error();
                find = IntPtr.Zero;
                if (error != ERROR_FILE_NOT_FOUND) {
                    throw new Win32Exception(
                        error,
                        "Could not enumerate locked Windows cleanup path '" + path + "'");
                }
                return;
            }
            hasCurrent = true;
        }

        public string Next() {
            while (find != IntPtr.Zero) {
                if (!hasCurrent) {
                    if (!FindNextFileW(find, out current)) {
                        int error = Marshal.GetLastWin32Error();
                        Dispose();
                        if (error == ERROR_NO_MORE_FILES) return null;
                        throw new Win32Exception(
                            error,
                            "Could not continue enumerating locked Windows cleanup path '" +
                                path + "'");
                    }
                }
                hasCurrent = false;
                string name = current.FileName;
                if (name == "." || name == "..") continue;
                return path.EndsWith("\\", StringComparison.Ordinal)
                    ? path + name
                    : path + "\\" + name;
            }
            return null;
        }

        public void Dispose() {
            if (find == IntPtr.Zero) return;
            FindClose(find);
            find = IntPtr.Zero;
        }
    }

    public static ChildCursor OpenChildren(string path) {
        return new ChildCursor(path);
    }

    public static void MarkDelete(SafeFileHandle handle) {
        FileDispositionInfoEx information = new FileDispositionInfoEx();
        information.Flags = FILE_DISPOSITION_FLAG_DELETE |
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
            FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
        if (!SetFileInformationByHandle(
            handle, FILE_DISPOSITION_INFO_EX_CLASS, ref information,
            (uint)Marshal.SizeOf(typeof(FileDispositionInfoEx)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not mark locked Windows cleanup path for deletion");
        }
    }

    public static void AssertAbsent(string path) {
        uint attributes = GetFileAttributesW(Extended(path));
        if (attributes != INVALID_FILE_ATTRIBUTES) {
            throw new InvalidOperationException("Windows cleanup target remained after locked deletion");
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 2 && error != 3) {
            throw new Win32Exception(error, "Could not confirm Windows cleanup target absence");
        }
    }
}
'@ | Out-Null

function Remove-LockedEntry {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle,
        [int] $Depth = 0
    )
    Assert-Traversal -Depth $Depth
    $attributes = [LockedRemovalNative]::Attributes($Handle)
    if ([LockedRemovalNative]::IsDirectory($attributes) -and
        -not [LockedRemovalNative]::IsReparsePoint($attributes)) {
        while ($true) {
            $childPath = [LockedRemovalNative]::FirstChild($Path)
            if ($null -eq $childPath) { break }
            Assert-Traversal -Depth $Depth -CountEntry
            $childHandle = [LockedRemovalNative]::OpenTarget($childPath)
            try {
                Remove-LockedEntry -Path $childPath -Handle $childHandle -Depth ($Depth + 1)
            } finally {
                $childHandle.Dispose()
            }
            [LockedRemovalNative]::AssertAbsent($childPath)
        }
    }
    Assert-Traversal -Depth $Depth
    [LockedRemovalNative]::MarkDelete($Handle)
}

function Test-LockedEntry {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle,
        [int] $Depth = 0
    )
    Assert-Traversal -Depth $Depth
    $attributes = [LockedRemovalNative]::Attributes($Handle)
    if ([LockedRemovalNative]::IsDirectory($attributes) -and
        -not [LockedRemovalNative]::IsReparsePoint($attributes)) {
        $cursor = [LockedRemovalNative]::OpenChildren($Path)
        try {
            while ($true) {
                $childPath = $cursor.Next()
                if ($null -eq $childPath) { break }
                Assert-Traversal -Depth $Depth -CountEntry
                $childHandle = [LockedRemovalNative]::OpenTarget($childPath)
                try {
                    Test-LockedEntry -Path $childPath -Handle $childHandle -Depth ($Depth + 1)
                } finally {
                    $childHandle.Dispose()
                }
            }
        } finally {
            $cursor.Dispose()
        }
    }
}

function Assert-LockedExecutable {
    param(
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle,
        [Parameter(Mandatory = $true)] $Expected,
        [Parameter(Mandatory = $true)][string] $Label
    )
    $expectedHash = [string]$Expected.contentSha256
    if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
        throw "$Label expected identity is malformed"
    }
    $actualHash = [LockedRemovalNative]::ComputeHash($Handle, $Label)
    if (-not [string]::Equals(
        $actualHash, $expectedHash,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label content changed before launch"
    }
}

$anchors = New-Object System.Collections.ArrayList
$runtimeHandle = $null
$powershellHandle = $null
$targetHandle = $null
try {
    for ($index = 0; $index -lt $entries.Count - 1; $index++) {
        [void]$anchors.Add([LockedRemovalNative]::OpenAnchor([string]$entries[$index].path))
    }
    $runtimeHandle = [LockedRemovalNative]::OpenExecutable([string]$spec.runtimeExecutable)
    $powershellHandle = [LockedRemovalNative]::OpenExecutable([string]$spec.powershellExecutable)
    if ([string]$spec.mode -eq 'structure') {
        $targetHandle = [LockedRemovalNative]::OpenSharedTarget([string]$spec.target)
    } else {
        $targetHandle = [LockedRemovalNative]::OpenTarget([string]$spec.target)
    }
    Assert-LockedExecutable -Handle $runtimeHandle -Expected $spec.runtime -Label 'Node executable'
    Assert-LockedExecutable -Handle $powershellHandle -Expected $spec.powershell -Label 'PowerShell executable'

    $nodeSourceBase64 = '`,
  WINDOWS_BOUNDARY_VALIDATOR_BASE64,
  String.raw`'
    $nodeInput = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($jsonInput))
    $nodeExpression = "globalThis.__windowsRemovalInput=Buffer.from(process.env.MAX_WIN_VALIDATOR_INPUT,'base64');await import('data:text/javascript;base64,'+process.env.MAX_WIN_VALIDATOR_SOURCE)"
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = [string]$spec.runtimeExecutable
    $quote = [char]34
    $startInfo.Arguments = '--input-type=module --eval ' + $quote + $nodeExpression + $quote
    $startInfo.WorkingDirectory = 'C:\Windows\System32'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.Environment["MAX_WIN_VALIDATOR_SOURCE"] = $nodeSourceBase64
    $startInfo.Environment["MAX_WIN_VALIDATOR_INPUT"] = $nodeInput
    $validator = $null
    $validatorStarted = $false
    $validatorDeadline = [Diagnostics.Stopwatch]::StartNew()
    function Get-ValidatorRemainingMilliseconds {
        $remaining = 60000 - [int]$validatorDeadline.ElapsedMilliseconds
        if ($remaining -le 0) { throw 'Pinned Node boundary validation timed out' }
        return $remaining
    }
    try {
        $validator = New-Object System.Diagnostics.Process
        $validator.StartInfo = $startInfo
        if (-not $validator.Start()) { throw 'Could not start the pinned Node boundary validator' }
        $validatorStarted = $true
        $validator.StandardInput.Close()
        if (-not $validator.WaitForExit((Get-ValidatorRemainingMilliseconds))) {
            throw 'Pinned Node boundary validation timed out'
        }
        if ($validator.ExitCode -ne 0) {
            throw "Pinned Node boundary validation exited $($validator.ExitCode)"
        }
    } finally {
        if ($null -ne $validator) {
            try {
                if ($validatorStarted -and -not $validator.HasExited) {
                    $validator.Kill()
                    if (-not $validator.WaitForExit(5000)) {
                        throw 'Pinned Node boundary validator termination is unconfirmed'
                    }
                }
            } finally {
                $validator.Dispose()
            }
        }
    }

    if ([string]$spec.mode -eq 'locks') {
        Reset-Traversal
        Test-LockedEntry -Path ([string]$spec.target) -Handle $targetHandle
    } elseif ([string]$spec.mode -eq 'remove') {
        Reset-Traversal
        Test-LockedEntry -Path ([string]$spec.target) -Handle $targetHandle
        Reset-Traversal
        Remove-LockedEntry -Path ([string]$spec.target) -Handle $targetHandle
        $targetHandle.Dispose()
        $targetHandle = $null
        [LockedRemovalNative]::AssertAbsent([string]$spec.target)
    }
} finally {
    if ($null -ne $targetHandle) { $targetHandle.Dispose() }
    if ($null -ne $powershellHandle) { $powershellHandle.Dispose() }
    if ($null -ne $runtimeHandle) { $runtimeHandle.Dispose() }
    for ($index = $anchors.Count - 1; $index -ge 0; $index--) {
        $anchors[$index].Dispose()
    }
}
`,
].join("");

function trustedWindowsRemovalEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Windows\\Temp",
    TMP: "C:\\Windows\\Temp",
    NoDefaultCurrentDirectoryInExePath: "1",
  };
}

function serializedCommandIdentity(identity: CommandFileIdentity): object {
  return {
    device: identity.device.toString(),
    inode: identity.inode.toString(),
    size: identity.size.toString(),
    modifiedNanoseconds: identity.modifiedNanoseconds.toString(),
    ...(identity.changedNanoseconds === undefined
      ? {}
      : { changedNanoseconds: identity.changedNanoseconds.toString() }),
    ...(identity.mode === undefined ? {} : { mode: identity.mode.toString() }),
    ...(identity.userId === undefined
      ? {}
      : { userId: identity.userId.toString() }),
    ...(identity.groupId === undefined
      ? {}
      : { groupId: identity.groupId.toString() }),
    ...(identity.contentSha256 === undefined
      ? {}
      : { contentSha256: identity.contentSha256 }),
  };
}

function serializedBoundaryIdentity(
  entry: RemovalBoundarySnapshot["entries"][number],
  includeChangedNanoseconds: boolean,
  includeBirthtimeNanoseconds = true,
): object {
  return {
    device: entry.device.toString(),
    inode: entry.inode.toString(),
    mode: entry.mode.toString(),
    ...(entry.userId === undefined ? {} : { userId: entry.userId.toString() }),
    ...(entry.groupId === undefined
      ? {}
      : { groupId: entry.groupId.toString() }),
    ...(!includeBirthtimeNanoseconds || entry.birthtimeNanoseconds === undefined
      ? {}
      : { birthtimeNanoseconds: entry.birthtimeNanoseconds.toString() }),
    ...(!includeChangedNanoseconds || entry.changedNanoseconds === undefined
      ? {}
      : { changedNanoseconds: entry.changedNanoseconds.toString() }),
  };
}

function assertCompleteWindowsBoundary(
  target: string,
  boundary: RemovalBoundarySnapshot,
): void {
  const normalizedTarget = win32.normalize(target);
  if (!win32.isAbsolute(normalizedTarget)) {
    throw new Error("Windows removal target is not absolute");
  }
  let parent = win32.parse(normalizedTarget).root;
  for (const entry of boundary.entries) {
    const path = win32.normalize(entry.path);
    const relative = win32.relative(parent, path);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith("..\\") ||
      win32.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.includes("/")
    ) {
      throw new Error("Windows removal boundary omits an ancestor");
    }
    parent = path;
  }
  if (parent.toLowerCase() !== normalizedTarget.toLowerCase()) {
    throw new Error("Windows removal boundary does not end at the target");
  }
}

export interface WindowsRemovalRuntime {
  readonly runtimeExecutable: string;
  readonly runtimeIdentity: CommandFileIdentity;
  readonly powershellExecutable: string;
  readonly powershellIdentity: CommandFileIdentity;
}

async function captureWindowsRemovalRuntime(
  context: RuntimeContext,
  dependencies: Pick<
    RemovePathDependencies,
    "inspectExecutable" | "hostPlatform" | "currentRuntimeExecutable"
  >,
): Promise<WindowsRemovalRuntime> {
  const hostPlatform = dependencies.hostPlatform ?? process.platform;
  const currentRuntimeExecutable =
    dependencies.currentRuntimeExecutable ?? process.execPath;
  if (hostPlatform !== "win32") {
    throw new Error("refusing Windows removal on a non-Windows host");
  }
  if (
    win32.normalize(context.runtimeExecutable).toLowerCase() !==
    win32.normalize(currentRuntimeExecutable).toLowerCase()
  ) {
    throw new Error(
      "Windows removal runtime does not match the current Node executable",
    );
  }
  const inspect = dependencies.inspectExecutable ?? inspectExecutable;
  const [powershellIdentity, runtimeIdentity] = await Promise.all([
    inspect(WINDOWS_POWERSHELL_EXECUTABLE),
    inspect(context.runtimeExecutable),
  ]);
  if (powershellIdentity?.contentSha256 === undefined) {
    throw new Error(
      "fixed Windows PowerShell executable identity is unavailable",
    );
  }
  if (runtimeIdentity?.contentSha256 === undefined) {
    throw new Error("current Node executable identity is unavailable");
  }
  return {
    runtimeExecutable: win32.normalize(context.runtimeExecutable),
    runtimeIdentity,
    powershellExecutable: WINDOWS_POWERSHELL_EXECUTABLE,
    powershellIdentity,
  };
}

function sameWindowsRemovalRuntime(
  left: WindowsRemovalRuntime,
  right: WindowsRemovalRuntime,
): boolean {
  return (
    left.runtimeExecutable.toLowerCase() ===
      right.runtimeExecutable.toLowerCase() &&
    left.powershellExecutable.toLowerCase() ===
      right.powershellExecutable.toLowerCase() &&
    sameCommandFileIdentity(left.runtimeIdentity, right.runtimeIdentity) &&
    sameCommandFileIdentity(left.powershellIdentity, right.powershellIdentity)
  );
}

async function removeLockedWindowsPath(
  target: string,
  expectedBoundary: RemovalBoundarySnapshot,
  context: RuntimeContext,
  dependencies: Pick<
    RemovePathDependencies,
    | "inspectExecutable"
    | "commandRunner"
    | "hostPlatform"
    | "currentRuntimeExecutable"
    | "expectedWindowsRemovalRuntime"
    | "traversalLimits"
    | "execution"
  >,
  mode: "structure" | "locks" | "remove" = "remove",
): Promise<void> {
  if (!expectedBoundary.targetExists || expectedBoundary.entries.length === 0) {
    throw new Error(
      "Windows removal boundary does not contain an existing target",
    );
  }
  const expectedRuntime =
    dependencies.expectedWindowsRemovalRuntime ??
    (await captureWindowsRemovalRuntime(context, dependencies));
  const immediateRuntime = await captureWindowsRemovalRuntime(
    context,
    dependencies,
  );
  if (
    expectedRuntime.powershellExecutable.toLowerCase() !==
      immediateRuntime.powershellExecutable.toLowerCase() ||
    !sameCommandFileIdentity(
      expectedRuntime.powershellIdentity,
      immediateRuntime.powershellIdentity,
    )
  ) {
    throw new Error(
      "fixed Windows PowerShell executable changed before launch",
    );
  }
  if (
    expectedRuntime.runtimeExecutable.toLowerCase() !==
      immediateRuntime.runtimeExecutable.toLowerCase() ||
    !sameCommandFileIdentity(
      expectedRuntime.runtimeIdentity,
      immediateRuntime.runtimeIdentity,
    )
  ) {
    throw new Error("current Node executable changed before Windows removal");
  }
  const run = dependencies.commandRunner ?? runCommand;
  const boundedLimits = boundedRemovalTraversalLimits(
    dependencies.traversalLimits,
    dependencies.execution,
  );
  const limits = normalizedRemovalTraversalLimits(boundedLimits);
  const traversalPasses = mode === "remove" || mode === "locks" ? 1 : 0;
  const helperTimeoutMs = Math.min(
    WINDOWS_BOUNDARY_VALIDATOR_TIMEOUT_MS +
      traversalPasses * limits.timeoutMs +
      WINDOWS_REMOVAL_HELPER_GRACE_MS,
    dependencies.execution?.remainingMs() ?? Number.MAX_SAFE_INTEGER,
  );

  const serialized = JSON.stringify({
    target: win32.normalize(target),
    runtimeExecutable: expectedRuntime.runtimeExecutable,
    runtime: serializedCommandIdentity(expectedRuntime.runtimeIdentity),
    powershellExecutable: expectedRuntime.powershellExecutable,
    powershell: serializedCommandIdentity(expectedRuntime.powershellIdentity),
    mode,
    limits: {
      maxEntries: limits.maxEntries,
      maxDepth: limits.maxDepth,
      timeoutMs: limits.timeoutMs,
    },
    entries: expectedBoundary.entries.map((entry, index) => ({
      path: win32.normalize(entry.path),
      ...serializedBoundaryIdentity(
        entry,
        index === expectedBoundary.entries.length - 1,
      ),
    })),
  });
  if (
    Buffer.byteLength(serialized, "utf8") > WINDOWS_REMOVAL_INPUT_LIMIT_BYTES
  ) {
    throw new Error("Windows removal boundary exceeded 128 KiB");
  }
  assertCompleteWindowsBoundary(target, expectedBoundary);

  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_LOCKED_REMOVE_POWERSHELL_SOURCE,
  ];
  if (`${WINDOWS_POWERSHELL_EXECUTABLE} ${args.join(" ")}`.length >= 32_000) {
    throw new Error(
      "Windows removal helper exceeded the safe command-line bound",
    );
  }
  assertCommandTerminationConfirmed();
  const result = await run(WINDOWS_POWERSHELL_EXECUTABLE, args, {
    cwd: WINDOWS_SYSTEM32,
    env: trustedWindowsRemovalEnvironment(),
    input: Buffer.from(serialized, "utf8").toString("base64"),
    timeoutMs: helperTimeoutMs,
    silent: true,
  });
  if (result.terminationUnconfirmed === true) {
    throw new UnconfirmedCommandTerminationError(
      "Windows locked removal helper termination is unconfirmed",
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `Windows locked removal helper exited ${result.exitCode}`,
    );
  }
}

const WINDOWS_HELPER_PREFLIGHTS = new Map<string, Promise<void>>();

async function preflightWindowsRemovalHelper(
  target: string,
  boundary: RemovalBoundarySnapshot,
  context: RuntimeContext,
  dependencies: RemovePathDependencies,
  runtime: WindowsRemovalRuntime,
): Promise<void> {
  const run = async (): Promise<void> =>
    await removeLockedWindowsPath(
      target,
      boundary,
      context,
      { ...dependencies, expectedWindowsRemovalRuntime: runtime },
      "structure",
    );
  const cacheable =
    process.platform === "win32" &&
    dependencies.execution === undefined &&
    dependencies.commandRunner === undefined &&
    dependencies.inspectExecutable === undefined &&
    dependencies.hostPlatform === undefined &&
    dependencies.currentRuntimeExecutable === undefined;
  if (!cacheable) {
    await run();
    return;
  }
  const key = [
    runtime.runtimeExecutable.toLowerCase(),
    runtime.runtimeIdentity.contentSha256,
    runtime.powershellExecutable.toLowerCase(),
    runtime.powershellIdentity.contentSha256,
    win32.normalize(target).toLowerCase(),
    JSON.stringify(
      boundary.entries.map((entry, index) => ({
        path: win32.normalize(entry.path).toLowerCase(),
        ...serializedBoundaryIdentity(
          entry,
          index === boundary.entries.length - 1,
        ),
      })),
    ),
  ].join("\0");
  let preflight = WINDOWS_HELPER_PREFLIGHTS.get(key);
  if (preflight === undefined) {
    preflight = run();
    WINDOWS_HELPER_PREFLIGHTS.set(key, preflight);
  }
  try {
    await preflight;
  } catch (error) {
    if (WINDOWS_HELPER_PREFLIGHTS.get(key) === preflight) {
      WINDOWS_HELPER_PREFLIGHTS.delete(key);
    }
    throw error;
  }
}

async function preflightWindowsRemovalLocks(
  target: string,
  boundary: RemovalBoundarySnapshot,
  context: RuntimeContext,
  dependencies: RemovePathDependencies,
  runtime: WindowsRemovalRuntime,
): Promise<void> {
  await removeLockedWindowsPath(
    target,
    boundary,
    context,
    { ...dependencies, expectedWindowsRemovalRuntime: runtime },
    "locks",
  );
}

function serializedRemovalBoundary(
  target: string,
  boundary: RemovalBoundarySnapshot,
  traversalLimits: RemovalTraversalLimits = {},
): string {
  if (
    boundary.entries.length === 0 ||
    boundary.entries.length > PRIVILEGED_REMOVAL_ENTRY_LIMIT
  ) {
    throw new Error(
      `privileged removal boundary must contain 1 to ${PRIVILEGED_REMOVAL_ENTRY_LIMIT} entries`,
    );
  }
  const limits = normalizedRemovalTraversalLimits(traversalLimits);
  const serialized = JSON.stringify({
    target,
    limits: {
      maxEntries: limits.maxEntries,
      maxDepth: limits.maxDepth,
      timeoutMs: limits.timeoutMs,
    },
    entries: boundary.entries.map((entry, index) => ({
      path: entry.path,
      ...serializedBoundaryIdentity(
        entry,
        index === boundary.entries.length - 1,
        false,
      ),
    })),
  });
  if (
    Buffer.byteLength(serialized, "utf8") > PRIVILEGED_REMOVAL_INPUT_LIMIT_BYTES
  ) {
    throw new Error("privileged removal boundary exceeded 128 KiB");
  }
  return serialized;
}

async function assertTrustedPrivilegedPython(
  executable: string,
  identity: CommandFileIdentity,
): Promise<void> {
  if (
    identity.userId !== 0n ||
    identity.mode === undefined ||
    (identity.mode & 0o170000n) !== 0o100000n ||
    (identity.mode & 0o022n) !== 0n
  ) {
    throw new Error(
      "OS Python executable must be a root-owned, non-writable regular file",
    );
  }
  for (const directory of ["/usr", "/usr/bin"]) {
    const metadata = await lstat(directory, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== 0n ||
      (metadata.mode & 0o022n) !== 0n
    ) {
      throw new Error(
        `OS Python executable has an untrusted parent directory: ${directory}`,
      );
    }
  }
  if (posix.dirname(executable) !== "/usr/bin") {
    throw new Error("OS Python executable is outside its trusted directory");
  }
}

async function capturePrivilegedPythonRuntime(
  inspect: typeof inspectExecutable,
  resolve: ResolveExecutable,
): Promise<PrivilegedPythonRuntime> {
  let pythonExecutable: string;
  try {
    pythonExecutable = await resolve(UNIX_PYTHON_EXECUTABLE);
  } catch (error) {
    throw new Error(
      `OS Python is unavailable for anchored removal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!/^\/usr\/bin\/python3(?:\.[0-9]+)*$/.test(pythonExecutable)) {
    throw new Error(
      `OS Python resolved outside the trusted executable path: ${pythonExecutable}`,
    );
  }
  const expectedPython = await inspect(pythonExecutable);
  if (expectedPython?.contentSha256 === undefined) {
    throw new Error("OS Python executable identity is unavailable");
  }
  await assertTrustedPrivilegedPython(pythonExecutable, expectedPython);
  return { executable: pythonExecutable, identity: expectedPython };
}

async function runPrivilegedPythonAnchoredRemoval(
  target: string,
  boundary: RemovalBoundarySnapshot,
  context: RuntimeContext,
  elevate: typeof runElevated,
  inspect: typeof inspectExecutable,
  resolve: ResolveExecutable,
  expectedRuntime?: PrivilegedPythonRuntime,
  traversalLimits: RemovalTraversalLimits = {},
  execution?: OperationExecutionContext,
): Promise<CommandResult> {
  const boundedLimits = boundedRemovalTraversalLimits(
    traversalLimits,
    execution,
  );
  const runtime =
    expectedRuntime ?? (await capturePrivilegedPythonRuntime(inspect, resolve));
  const immediatePython = await inspect(runtime.executable);
  if (!sameCommandFileIdentity(runtime.identity, immediatePython)) {
    throw new Error("OS Python executable changed before anchored removal");
  }
  assertCommandTerminationConfirmed();
  const result = await elevate(
    context,
    runtime.executable,
    ["-I", "-S", "-c", PRIVILEGED_PYTHON_ANCHORED_REMOVE_SOURCE],
    {
      input: serializedRemovalBoundary(target, boundary, boundedLimits),
      silent: true,
      timeoutMs: Math.min(
        normalizedRemovalTraversalLimits(boundedLimits).timeoutMs + 60_000,
        execution?.remainingMs() ?? Number.MAX_SAFE_INTEGER,
      ),
    },
  );
  if (result.terminationUnconfirmed === true) {
    throw new UnconfirmedCommandTerminationError(
      "Python anchored removal helper termination is unconfirmed",
    );
  }
  return result;
}

async function runLocalNodeAnchoredRemoval(
  target: string,
  boundary: RemovalBoundarySnapshot,
  dependencies: RemovePathDependencies,
): Promise<void> {
  const boundedLimits = boundedRemovalTraversalLimits(
    dependencies.traversalLimits,
    dependencies.execution,
  );
  const limits = normalizedRemovalTraversalLimits(boundedLimits);
  // This child is unprivileged. Launch the already-running action runtime by
  // its concrete executable path; elevation performs the stricter trust check
  // separately before crossing a privilege boundary.
  const runtime = process.execPath;
  const run = dependencies.commandRunner ?? runCommand;
  assertCommandTerminationConfirmed();
  const result = await run(
    runtime,
    ["--input-type=module", "--eval", PRIVILEGED_ANCHORED_REMOVE_SOURCE],
    {
      input: serializedRemovalBoundary(target, boundary, boundedLimits),
      silent: true,
      timeoutMs: Math.min(
        limits.timeoutMs + 60_000,
        dependencies.execution?.remainingMs() ?? Number.MAX_SAFE_INTEGER,
      ),
    },
  );
  if (result.terminationUnconfirmed === true) {
    throw new UnconfirmedCommandTerminationError(
      "local anchored removal helper termination is unconfirmed",
    );
  }
  if (result.exitCode === 0) return;
  const detail =
    result.stderr.trim() ||
    `local anchored removal helper exited ${result.exitCode}`;
  if (/anchored removal traversal exceeded/i.test(detail)) {
    throw new RemovalTraversalLimitError(detail);
  }
  throw new Error(detail);
}

function procRuntimeLaunchWasDenied(
  result: CommandResult,
  runtime: string,
): boolean {
  return (
    result.stderr.includes(runtime) &&
    ((result.exitCode === 126 && /permission denied/i.test(result.stderr)) ||
      (result.exitCode === 127 &&
        /no such file|not found/i.test(result.stderr)))
  );
}

function privilegedRemovalRuntime(context: RuntimeContext): string {
  // On Linux, execute the inode already running this action. A concurrent
  // rename of process.execPath cannot substitute code at the sudo boundary.
  return context.platform === "linux"
    ? `/proc/${process.pid}/exe`
    : context.runtimeExecutable;
}

function unixDescriptorPath(descriptor: number): string {
  return `${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${descriptor}`;
}

function sameBoundaryEntry(
  expected: RemovalBoundarySnapshot["entries"][number],
  actual: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly uid: bigint;
    readonly gid: bigint;
    readonly birthtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
  includeChangedNanoseconds = false,
): boolean {
  return (
    expected.device === actual.dev &&
    expected.inode === actual.ino &&
    expected.mode === actual.mode &&
    (expected.userId === undefined || expected.userId === actual.uid) &&
    (expected.groupId === undefined || expected.groupId === actual.gid) &&
    (expected.birthtimeNanoseconds === undefined ||
      expected.birthtimeNanoseconds === actual.birthtimeNs) &&
    (!includeChangedNanoseconds ||
      expected.changedNanoseconds === undefined ||
      expected.changedNanoseconds === actual.ctimeNs)
  );
}

export function assertSameRemovalFilesystem(
  expectedDevice: bigint,
  actualDevice: bigint,
  displayPath: string,
): void {
  if (expectedDevice !== actualDevice) {
    throw new Error(
      `refusing cleanup path that crosses a mounted filesystem at '${displayPath}'`,
    );
  }
}

async function unixDescriptorMountId(
  descriptor: number,
): Promise<bigint | undefined> {
  if (process.platform !== "linux") return undefined;
  const data = await readFile(`/proc/self/fdinfo/${descriptor}`, "utf8");
  if (Buffer.byteLength(data, "utf8") > 4096) {
    throw new Error(
      `mount identity metadata exceeded 4 KiB for descriptor ${descriptor}`,
    );
  }
  const matches = [...data.matchAll(/^mnt_id:[ \t]+([0-9]+)[ \t]*$/gm)];
  const mountId = matches[0]?.[1];
  if (matches.length !== 1 || mountId === undefined) {
    throw new Error(
      `unable to verify mount identity for descriptor ${descriptor}`,
    );
  }
  return BigInt(mountId);
}

export function assertSameRemovalMount(
  expectedDevice: bigint,
  actualDevice: bigint,
  expectedMountId: bigint | undefined,
  actualMountId: bigint | undefined,
  displayPath: string,
): void {
  assertSameRemovalFilesystem(expectedDevice, actualDevice, displayPath);
  if (
    (expectedMountId === undefined) !== (actualMountId === undefined) ||
    (expectedMountId !== undefined && expectedMountId !== actualMountId)
  ) {
    throw new Error(
      `refusing cleanup path that crosses a mounted filesystem at '${displayPath}'`,
    );
  }
}

function boundaryEntryFor(
  snapshot: RemovalBoundarySnapshot,
  path: string,
): RemovalBoundarySnapshot["entries"][number] {
  const expected = snapshot.entries.find((entry) => entry.path === path);
  if (expected === undefined) {
    throw new Error(`cleanup target boundary changed at '${path}'`);
  }
  return expected;
}

async function openBoundaryDirectory(
  path: string,
  displayPath: string,
): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["ELOOP", "ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw new Error(
        `cleanup target boundary changed before anchored removal at '${displayPath}'`,
      );
    }
    throw error;
  }
}

function checkRemovalTraversal(
  traversal: {
    readonly limits: NormalizedRemovalTraversalLimits;
    readonly startedAt: number;
    entries: number;
  },
  depth: number,
  countEntry = false,
): void {
  if (depth > traversal.limits.maxDepth) {
    throw new RemovalTraversalLimitError(
      `anchored removal traversal exceeded depth ${traversal.limits.maxDepth}`,
    );
  }
  if (countEntry) traversal.entries += 1;
  if (traversal.entries > traversal.limits.maxEntries) {
    throw new RemovalTraversalLimitError(
      `anchored removal traversal exceeded ${traversal.limits.maxEntries} entries`,
    );
  }
  if (
    traversal.limits.now() - traversal.startedAt >=
    traversal.limits.timeoutMs
  ) {
    throw new RemovalTraversalLimitError(
      "anchored removal traversal exceeded its time limit",
    );
  }
}

async function removeAnchoredDirectoryContents(
  directory: FileHandle,
  expectedDevice: bigint,
  expectedMountId: bigint | undefined,
  displayDirectory: string,
  parent: FileHandle,
  name: string,
  expectedDirectory: {
    readonly device: bigint;
    readonly inode: bigint;
    readonly mode: bigint;
  },
  traversal: {
    readonly limits: NormalizedRemovalTraversalLimits;
    readonly startedAt: number;
    entries: number;
  },
  depth: number,
): Promise<void> {
  checkRemovalTraversal(traversal, depth);
  const assertAttached = async (): Promise<void> => {
    const path = posix.join(unixDescriptorPath(parent.fd), name);
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      if (
        error instanceof Error &&
        ["ENOENT", "ENOTDIR", "ELOOP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw new Error(
          `cleanup directory moved outside its anchored parent at '${displayDirectory}'`,
        );
      }
      throw error;
    }
    const opened = await directory.stat({ bigint: true });
    if (
      current.dev !== expectedDirectory.device ||
      current.ino !== expectedDirectory.inode ||
      current.mode !== expectedDirectory.mode ||
      opened.dev !== expectedDirectory.device ||
      opened.ino !== expectedDirectory.inode ||
      opened.mode !== expectedDirectory.mode
    ) {
      throw new Error(
        `cleanup directory moved outside its anchored parent at '${displayDirectory}'`,
      );
    }
  };

  await assertAttached();
  const root = unixDescriptorPath(directory.fd);
  const entries = await opendir(root);
  for await (const entry of entries) {
    checkRemovalTraversal(traversal, depth, true);
    await assertAttached();
    if (entry.name === "." || entry.name === ".." || entry.name.includes("/")) {
      throw new Error("directory returned an unsafe entry name");
    }
    const child = posix.join(root, entry.name);
    const displayChild = posix.join(displayDirectory, entry.name);
    const before = await lstat(child, { bigint: true });
    assertSameRemovalFilesystem(expectedDevice, before.dev, displayChild);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      let childHandle: FileHandle | undefined;
      try {
        childHandle = await openBoundaryDirectory(child, displayChild);
        const opened = await childHandle.stat({ bigint: true });
        if (
          before.dev !== opened.dev ||
          before.ino !== opened.ino ||
          before.mode !== opened.mode
        ) {
          throw new Error(
            `directory entry changed before removal: '${displayChild}'`,
          );
        }
        const childMountId = await unixDescriptorMountId(childHandle.fd);
        assertSameRemovalMount(
          expectedDevice,
          opened.dev,
          expectedMountId,
          childMountId,
          displayChild,
        );
        await removeAnchoredDirectoryContents(
          childHandle,
          expectedDevice,
          expectedMountId,
          displayChild,
          directory,
          entry.name,
          {
            device: opened.dev,
            inode: opened.ino,
            mode: opened.mode,
          },
          traversal,
          depth + 1,
        );
        await assertAttached();
        checkRemovalTraversal(traversal, depth);
        await rmdir(child);
      } finally {
        await childHandle?.close().catch(() => undefined);
      }
    } else {
      const immediate = await lstat(child, { bigint: true });
      if (
        before.dev !== immediate.dev ||
        before.ino !== immediate.ino ||
        before.mode !== immediate.mode
      ) {
        throw new Error(
          `directory entry changed before removal: '${displayChild}'`,
        );
      }
      await assertAttached();
      checkRemovalTraversal(traversal, depth);
      await unlink(child);
    }
  }
  await assertAttached();
}

/**
 * Recursively remove a Unix target through no-follow directory handles.
 *
 * The caller's final boundary snapshot is compared to the handles that anchor
 * every ancestor. Once opened, a later pathname swap cannot redirect recursive
 * traversal. Final unlink/rmdir calls are relative to the anchored parent and
 * never recursively follow a replacement entry.
 */
export async function removeAnchoredUnixPath(
  target: string,
  expectedBoundary: RemovalBoundarySnapshot,
  traversalLimits: RemovalTraversalLimits = {},
): Promise<void> {
  const limits = normalizedRemovalTraversalLimits(traversalLimits);
  const traversal = {
    limits,
    startedAt: limits.now(),
    entries: 0,
  };
  if (!expectedBoundary.targetExists) {
    throw new Error("cleanup target disappeared before anchored removal");
  }
  const normalizedTarget = posix.normalize(posix.resolve(target));
  const parts = normalizedTarget.split(posix.sep).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("refusing to remove the filesystem root");
  }

  const handles: FileHandle[] = [];
  let parent: FileHandle | undefined;
  let prefix = "";
  try {
    parent = await openBoundaryDirectory(posix.sep, posix.sep);
    handles.push(parent);

    for (const part of parts.slice(0, -1)) {
      prefix = posix.join(posix.sep, prefix, part);
      const child = posix.join(unixDescriptorPath(parent.fd), part);
      const opened = await openBoundaryDirectory(child, prefix);
      handles.push(opened);
      const actual = await opened.stat({ bigint: true });
      if (
        !sameBoundaryEntry(boundaryEntryFor(expectedBoundary, prefix), actual)
      ) {
        throw new Error(
          `cleanup target boundary changed before anchored removal at '${prefix}'`,
        );
      }
      parent = opened;
    }

    const name = parts.at(-1);
    if (name === undefined || parent === undefined) {
      throw new Error("cleanup target has no removable final entry");
    }
    const anchoredTarget = posix.join(unixDescriptorPath(parent.fd), name);
    const targetPath = posix.join(posix.sep, ...parts);
    const before = await lstat(anchoredTarget, { bigint: true });
    const parentStat = await parent.stat({ bigint: true });
    assertSameRemovalFilesystem(parentStat.dev, before.dev, targetPath);
    const expected = boundaryEntryFor(expectedBoundary, targetPath);
    if (!sameBoundaryEntry(expected, before, true)) {
      throw new Error(
        `cleanup target boundary changed before anchored removal at '${targetPath}'`,
      );
    }

    if (before.isDirectory() && !before.isSymbolicLink()) {
      let targetHandle: FileHandle | undefined;
      try {
        targetHandle = await openBoundaryDirectory(anchoredTarget, targetPath);
        const opened = await targetHandle.stat({ bigint: true });
        if (!sameBoundaryEntry(expected, opened, true)) {
          throw new Error(
            `cleanup target boundary changed before anchored removal at '${targetPath}'`,
          );
        }
        const parentMountId = await unixDescriptorMountId(parent.fd);
        const targetMountId = await unixDescriptorMountId(targetHandle.fd);
        assertSameRemovalMount(
          parentStat.dev,
          opened.dev,
          parentMountId,
          targetMountId,
          targetPath,
        );
        await removeAnchoredDirectoryContents(
          targetHandle,
          opened.dev,
          targetMountId,
          targetPath,
          parent,
          name,
          {
            device: opened.dev,
            inode: opened.ino,
            mode: opened.mode,
          },
          traversal,
          0,
        );
        checkRemovalTraversal(traversal, 0);
        await rmdir(anchoredTarget);
      } finally {
        await targetHandle?.close().catch(() => undefined);
      }
    } else {
      checkRemovalTraversal(traversal, 0);
      await unlink(anchoredTarget);
    }
  } finally {
    for (const handle of handles.reverse()) {
      await handle.close().catch(() => undefined);
    }
  }
}

export async function validateRemovePathTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<void> {
  await assertSafeExistingTarget(target, allowedParents, context);
}

export async function removePathTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
  dependencies: RemovePathDependencies = {},
): Promise<OperationResult> {
  const execution = dependencies.execution;
  const traversalLimits = boundedRemovalTraversalLimits(
    dependencies.traversalLimits,
    execution,
  );
  const inspect = dependencies.inspect ?? inspectTarget;
  const boundary = dependencies.boundary ?? captureSafeRemovalBoundary;
  const anchoredRemove = dependencies.anchoredRemove ?? removeAnchoredUnixPath;
  const windowsLockedRemove =
    dependencies.windowsLockedRemove ??
    (async (
      removalTarget: string,
      expectedBoundary: RemovalBoundarySnapshot,
      runtimeContext: RuntimeContext,
    ) =>
      await removeLockedWindowsPath(
        removalTarget,
        expectedBoundary,
        runtimeContext,
        dependencies,
      ));
  const remove = dependencies.remove ?? rm;
  const unlinkTarget = dependencies.unlink ?? unlink;
  const elevate = dependencies.elevate ?? runElevated;
  const inspected = await inspect(target);
  if (!inspected.exists) {
    const expectedBoundary = dependencies.expectedBoundary;
    if (expectedBoundary?.targetExists !== true) return { status: "not-found" };

    try {
      const currentBoundary = await boundary(target, allowedParents, context);
      const expectedSurvivingPrefix: RemovalBoundarySnapshot = {
        targetExists: false,
        entries: expectedBoundary.entries.slice(
          0,
          currentBoundary.entries.length,
        ),
      };
      if (
        expectedBoundary.entries.length === 0 ||
        currentBoundary.targetExists ||
        currentBoundary.entries.length >= expectedBoundary.entries.length ||
        !sameRemovalBoundary(expectedSurvivingPrefix, currentBoundary)
      ) {
        return {
          status: "failed",
          detail: "cleanup target boundary changed after plan validation",
        };
      }
      return { status: "not-found" };
    } catch {
      return {
        status: "failed",
        detail: "cleanup target boundary changed after plan validation",
      };
    }
  }
  if (dependencies.expectedBoundary?.targetExists === false) {
    return {
      status: "failed",
      detail: "cleanup target appeared after plan validation",
    };
  }
  let validatedBoundary: RemovalBoundarySnapshot;
  try {
    validatedBoundary =
      dependencies.expectedBoundary ??
      (await boundary(target, allowedParents, context));
    if (!validatedBoundary.targetExists) {
      return {
        status: "failed",
        detail: "cleanup target disappeared during boundary validation",
      };
    }
    if (context.platform !== "windows") {
      serializedRemovalBoundary(target, validatedBoundary, traversalLimits);
    }
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let immediateBoundary: RemovalBoundarySnapshot;
  try {
    immediateBoundary = await boundary(target, allowedParents, context);
    if (!sameRemovalBoundary(validatedBoundary, immediateBoundary)) {
      return {
        status: "failed",
        detail: "cleanup target boundary changed immediately before removal",
      };
    }
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let privilegedAttempted = false;
  try {
    if (context.platform === "windows") {
      await windowsLockedRemove(target, immediateBoundary, context);
    } else if (
      context.platform === "macos" &&
      dependencies.anchoredRemove === undefined &&
      dependencies.remove === undefined &&
      dependencies.unlink === undefined
    ) {
      privilegedAttempted = true;
      const result = await runPrivilegedPythonAnchoredRemoval(
        target,
        immediateBoundary,
        context,
        elevate,
        dependencies.inspectExecutable ?? inspectExecutable,
        dependencies.resolveExecutable ?? realpath,
        dependencies.expectedPrivilegedPythonRuntime,
        traversalLimits,
        execution,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `Python anchored removal helper exited ${result.exitCode}`,
        );
      }
    } else if (
      dependencies.remove === undefined &&
      dependencies.unlink === undefined
    ) {
      if (
        context.platform === "linux" &&
        dependencies.anchoredRemove === undefined
      ) {
        await runLocalNodeAnchoredRemoval(
          target,
          immediateBoundary,
          dependencies,
        );
      } else {
        await anchoredRemove(target, immediateBoundary, traversalLimits);
      }
    } else if (inspected.isLink) {
      // Unlink the directory symlink/junction itself. Never give a recursive
      // remover a final link that could be swapped or followed differently.
      await unlinkTarget(target);
    } else {
      await remove(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
    return (await inspect(target)).exists
      ? {
          status: "failed",
          detail: "target remained after filesystem removal reported success",
        }
      : { status: "removed" };
  } catch (nodeError) {
    if (context.platform === "windows") {
      return { status: "failed", detail: (nodeError as Error).message };
    }
    if (privilegedAttempted) {
      return { status: "failed", detail: (nodeError as Error).message };
    }
    if (nodeError instanceof RemovalTraversalLimitError) {
      return { status: "failed", detail: nodeError.message };
    }

    const beforeElevation = await inspect(target);
    if (!beforeElevation.exists) {
      return {
        status: "failed",
        detail:
          nodeError instanceof Error ? nodeError.message : String(nodeError),
      };
    }
    let fallbackBoundary: RemovalBoundarySnapshot;
    try {
      fallbackBoundary = await boundary(target, allowedParents, context);
      if (!fallbackBoundary.targetExists) {
        return {
          status: "failed",
          detail: "cleanup target disappeared before privileged removal",
        };
      }
      if (!sameRemovalBoundary(validatedBoundary, fallbackBoundary)) {
        return {
          status: "failed",
          detail: "cleanup target boundary changed after local removal failed",
        };
      }
      const privilegedBoundary = await boundary(
        target,
        allowedParents,
        context,
      );
      if (
        !sameRemovalBoundaryExact(
          fallbackBoundary,
          privilegedBoundary,
          allowedParents,
          context,
        )
      ) {
        return {
          status: "failed",
          detail: "cleanup target boundary changed before privileged removal",
        };
      }
      fallbackBoundary = privilegedBoundary;
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (beforeElevation.isLink !== inspected.isLink) {
      return {
        status: "failed",
        detail: "target type changed before privileged removal",
      };
    }
    let result: CommandResult;
    try {
      if (context.platform === "macos") {
        result = await runPrivilegedPythonAnchoredRemoval(
          target,
          fallbackBoundary,
          context,
          elevate,
          dependencies.inspectExecutable ?? inspectExecutable,
          dependencies.resolveExecutable ?? realpath,
          dependencies.expectedPrivilegedPythonRuntime,
          traversalLimits,
          execution,
        );
      } else {
        assertCommandTerminationConfirmed();
        const runtime = privilegedRemovalRuntime(context);
        const runPythonFallback = async (): Promise<CommandResult> => {
          const beforePython = await boundary(target, allowedParents, context);
          if (
            !sameRemovalBoundaryExact(
              fallbackBoundary,
              beforePython,
              allowedParents,
              context,
            )
          ) {
            throw new Error(
              "cleanup target boundary changed before Python privileged removal",
            );
          }
          return await runPrivilegedPythonAnchoredRemoval(
            target,
            beforePython,
            context,
            elevate,
            dependencies.inspectExecutable ?? inspectExecutable,
            dependencies.resolveExecutable ?? realpath,
            dependencies.expectedPrivilegedPythonRuntime,
            traversalLimits,
            execution,
          );
        };
        try {
          const traversalTimeoutMs =
            normalizedRemovalTraversalLimits(traversalLimits).timeoutMs;
          result = await elevate(
            context,
            runtime,
            [
              "--input-type=module",
              "--eval",
              PRIVILEGED_ANCHORED_REMOVE_SOURCE,
            ],
            {
              input: serializedRemovalBoundary(
                target,
                fallbackBoundary,
                traversalLimits,
              ),
              silent: true,
              timeoutMs: Math.min(
                traversalTimeoutMs + 60_000,
                execution?.remainingMs() ?? Number.MAX_SAFE_INTEGER,
              ),
            },
          );
        } catch (error) {
          if (
            !(error instanceof UntrustedUnixExecutableError) ||
            error.executable !== runtime
          ) {
            throw error;
          }
          result = await runPythonFallback();
        }
        if (procRuntimeLaunchWasDenied(result, runtime)) {
          result = await runPythonFallback();
        }
      }
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.exitCode === 0) {
      return (await inspect(target)).exists
        ? {
            status: "failed",
            detail: "target remained after privileged removal reported success",
          }
        : { status: "removed" };
    }
    return {
      status: "failed",
      detail: result.stderr.trim() || (nodeError as Error).message,
    };
  }
}

export function createRemovePathOperation(
  options: RemovePathOptions,
  dependencies: RemovePathDependencies = {},
): Operation {
  const target = assertSafeRemovalTarget(
    options.target,
    options.allowedParents,
    options.context,
  );
  let validatedBoundary: RemovalBoundarySnapshot | undefined;
  let validatedPrivilegedPythonRuntime: PrivilegedPythonRuntime | undefined;
  let validatedWindowsRemovalRuntime: WindowsRemovalRuntime | undefined;
  const validate = async (
    execution?: OperationExecutionContext,
  ): Promise<void> => {
    const scopedDependencies =
      execution === undefined ? dependencies : { ...dependencies, execution };
    const boundedLimits = boundedRemovalTraversalLimits(
      dependencies.traversalLimits,
      execution,
    );
    const current = await (dependencies.boundary ?? captureSafeRemovalBoundary)(
      target,
      options.allowedParents,
      options.context,
    );
    if (
      validatedBoundary !== undefined &&
      !sameRemovalBoundary(validatedBoundary, current)
    ) {
      throw new Error("cleanup target boundary changed during plan validation");
    }
    validatedBoundary ??= current;
    if (options.context.platform === "windows" && current.targetExists) {
      const runtime = await captureWindowsRemovalRuntime(
        options.context,
        dependencies,
      );
      if (
        validatedWindowsRemovalRuntime !== undefined &&
        !sameWindowsRemovalRuntime(validatedWindowsRemovalRuntime, runtime)
      ) {
        throw new Error(
          "Windows removal runtime changed after complete-plan validation",
        );
      }
      validatedWindowsRemovalRuntime ??= runtime;
      await preflightWindowsRemovalHelper(
        target,
        current,
        options.context,
        scopedDependencies,
        validatedWindowsRemovalRuntime,
      );
    } else if (current.targetExists) {
      serializedRemovalBoundary(target, current, boundedLimits);
      const pythonRuntime = await capturePrivilegedPythonRuntime(
        dependencies.inspectExecutable ?? inspectExecutable,
        dependencies.resolveExecutable ?? realpath,
      );
      if (
        validatedPrivilegedPythonRuntime !== undefined &&
        (validatedPrivilegedPythonRuntime.executable !==
          pythonRuntime.executable ||
          !sameCommandFileIdentity(
            validatedPrivilegedPythonRuntime.identity,
            pythonRuntime.identity,
          ))
      ) {
        throw new Error(
          "OS Python executable changed after complete-plan validation",
        );
      }
      validatedPrivilegedPythonRuntime ??= pythonRuntime;
    }
  };
  const validateAfterPreflight = async (
    execution?: OperationExecutionContext,
  ): Promise<void> => {
    const scopedDependencies =
      execution === undefined ? dependencies : { ...dependencies, execution };
    if (options.context.platform !== "windows") return;
    if (validatedBoundary === undefined) await validate(execution);
    const expected = validatedBoundary;
    if (expected === undefined) {
      throw new Error("Windows removal boundary was not captured");
    }
    const current = await (dependencies.boundary ?? captureSafeRemovalBoundary)(
      target,
      options.allowedParents,
      options.context,
    );
    if (!sameRemovalBoundary(expected, current)) {
      throw new Error("Windows cleanup target changed after service preflight");
    }
    if (!current.targetExists) return;
    const runtime = validatedWindowsRemovalRuntime;
    if (runtime === undefined) {
      throw new Error("Windows removal runtime was not captured");
    }
    await preflightWindowsRemovalLocks(
      target,
      current,
      options.context,
      scopedDependencies,
      runtime,
    );
  };
  return {
    id: options.id,
    component: options.component,
    description: options.description,
    phase: options.phase ?? "filesystem",
    dedupeKey: `path:${
      options.context.platform === "windows"
        ? win32.normalize(target).toLowerCase()
        : normalize(target)
    }`,
    ...(options.blockedBy === undefined
      ? {}
      : { blockedBy: options.blockedBy }),
    ...(options.coveredBy === undefined
      ? {}
      : { coveredBy: options.coveredBy }),
    validate,
    ...(options.context.platform === "windows"
      ? { validateAfterPreflight }
      : {}),
    run: async (execution?: OperationExecutionContext) => {
      if (validatedBoundary === undefined) {
        try {
          await validate(execution);
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const expectedBoundary = validatedBoundary;
      if (expectedBoundary === undefined) {
        return {
          status: "failed",
          detail: "cleanup target boundary was not captured during validation",
        };
      }
      return await removePathTarget(
        target,
        options.allowedParents,
        options.context,
        {
          ...dependencies,
          ...(execution === undefined ? {} : { execution }),
          expectedBoundary,
          ...(validatedPrivilegedPythonRuntime === undefined
            ? {}
            : {
                expectedPrivilegedPythonRuntime:
                  validatedPrivilegedPythonRuntime,
              }),
          ...(validatedWindowsRemovalRuntime === undefined
            ? {}
            : {
                expectedWindowsRemovalRuntime: validatedWindowsRemovalRuntime,
              }),
        },
      );
    },
  };
}

export function createUnsupportedOperation(
  component: ComponentId,
  detail: string,
): Operation {
  return createFunctionOperation({
    id: `unsupported:${component}`,
    component,
    description: `${component} cleanup is not applicable on this runner`,
    phase: "system",
    run: async () => ({ status: "unsupported", detail }),
  });
}

export function createFunctionOperation(options: {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly phase: OperationPhase;
  readonly dedupeKey?: string;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
  readonly coveredBySuccessfulOperations?: readonly string[];
  readonly always?: boolean;
  readonly fatal?: boolean;
  readonly validate?: (execution?: OperationExecutionContext) => Promise<void>;
  readonly validateAfterPreflight?: (
    execution?: OperationExecutionContext,
  ) => Promise<void>;
  readonly validateAfterPreflightLast?: boolean;
  readonly validateBeforeRun?: (
    execution?: OperationExecutionContext,
  ) => Promise<void>;
  readonly rollback?: () => Promise<void>;
  readonly rollbackAfterPayloadMutation?: boolean;
  readonly run: (
    execution?: OperationExecutionContext,
  ) => Promise<OperationResult>;
}): Operation {
  return {
    id: options.id,
    component: options.component,
    description: options.description,
    phase: options.phase,
    ...(options.dedupeKey === undefined
      ? {}
      : { dedupeKey: options.dedupeKey }),
    ...(options.blockedBy === undefined
      ? {}
      : { blockedBy: options.blockedBy }),
    ...(options.coveredBy === undefined
      ? {}
      : { coveredBy: options.coveredBy }),
    ...(options.coveredBySuccessfulOperations === undefined
      ? {}
      : {
          coveredBySuccessfulOperations: options.coveredBySuccessfulOperations,
        }),
    ...(options.always === undefined ? {} : { always: options.always }),
    ...(options.fatal === undefined ? {} : { fatal: options.fatal }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    ...(options.validateAfterPreflight === undefined
      ? {}
      : { validateAfterPreflight: options.validateAfterPreflight }),
    ...(options.validateAfterPreflightLast === undefined
      ? {}
      : { validateAfterPreflightLast: options.validateAfterPreflightLast }),
    ...(options.validateBeforeRun === undefined
      ? {}
      : { validateBeforeRun: options.validateBeforeRun }),
    ...(options.rollback === undefined ? {} : { rollback: options.rollback }),
    ...(options.rollbackAfterPayloadMutation === undefined
      ? {}
      : {
          rollbackAfterPayloadMutation: options.rollbackAfterPayloadMutation,
        }),
    run: options.run,
  };
}

export function prepareOperations(
  operations: readonly Operation[],
  plan: CleanupPlan,
): readonly Operation[] {
  const byKey = new Map<string, Operation>();
  const prepared: Operation[] = [];
  for (const operation of operations) {
    if (operation.always !== true && !plan.enabled.has(operation.component)) {
      continue;
    }
    if (operation.blockedBy?.some((component) => plan.skipped.has(component))) {
      continue;
    }
    if (operation.coveredBy?.some((component) => plan.enabled.has(component))) {
      continue;
    }
    if (operation.dedupeKey === undefined) {
      prepared.push(operation);
      continue;
    }
    if (!byKey.has(operation.dedupeKey)) {
      byKey.set(operation.dedupeKey, operation);
      prepared.push(operation);
    }
  }
  return prepared;
}

async function runOne(
  operation: Operation,
  execution?: OperationExecutionContext,
): Promise<OperationResult> {
  core.info(`• ${operation.description}`);
  assertCommandTerminationConfirmed();
  let result: OperationResult;
  try {
    result = await operation.run(execution);
  } catch (error) {
    if (error instanceof UnconfirmedCommandTerminationError) throw error;
    assertCommandTerminationConfirmed();
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(`${operation.description} failed: ${detail}`);
    throw error;
  }
  assertCommandTerminationConfirmed();
  const suffix = result.detail === undefined ? "" : `: ${result.detail}`;
  if (result.status === "failed") {
    core.warning(`${operation.description} failed${suffix}`);
    throw new Error(`${operation.description} failed${suffix}`);
  } else if (result.status !== "not-found") {
    core.info(`  ${result.status}${suffix}`);
  }
  return result;
}

const PHASES = ["preflight", "package", "filesystem", "system"] as const;

function assertValidResultCoverage(operations: readonly Operation[]): void {
  const byId = new Map<string, Operation[]>();
  for (const operation of operations) {
    const matching = byId.get(operation.id) ?? [];
    matching.push(operation);
    byId.set(operation.id, matching);
  }

  const executionOrder = new Map<Operation, number>();
  let cursor = 0;
  for (const phase of PHASES) {
    for (const operation of operations) {
      if (operation.phase === phase) executionOrder.set(operation, cursor++);
    }
  }

  for (const operation of operations) {
    for (const coveringId of operation.coveredBySuccessfulOperations ?? []) {
      const covering = byId.get(coveringId) ?? [];
      if (covering.length === 0) continue;
      if (covering.length > 1) {
        throw new Error(
          `${operation.id} has an ambiguous successful-operation coverage dependency on ${coveringId}`,
        );
      }
      const coveringOperation = covering[0];
      if (coveringOperation === undefined) continue;
      const coveringOrder = executionOrder.get(coveringOperation);
      const fallbackOrder = executionOrder.get(operation);
      if (
        coveringOrder === undefined ||
        fallbackOrder === undefined ||
        coveringOrder >= fallbackOrder ||
        (operation.phase === "filesystem" &&
          coveringOperation.phase === "filesystem")
      ) {
        throw new Error(
          `${operation.id} must run after its serialized coverage dependency ${coveringId}`,
        );
      }
    }
  }
}

function successfulCoveringOperation(
  operation: Operation,
  resultsById: ReadonlyMap<string, OperationResult>,
): string | undefined {
  return operation.coveredBySuccessfulOperations?.find(
    (id) => resultsById.get(id)?.status === "removed",
  );
}

function isCoveredBySuccessfulOperation(
  operation: Operation,
  resultsById: ReadonlyMap<string, OperationResult>,
): boolean {
  const coveringId = successfulCoveringOperation(operation, resultsById);
  if (coveringId === undefined) return false;
  core.info(`• ${operation.description} (covered by successful ${coveringId})`);
  return true;
}

export async function executeOperations(
  operations: readonly Operation[],
  options: ExecuteOperationsOptions = {},
): Promise<readonly OperationResult[]> {
  assertCommandTerminationConfirmed();
  assertValidResultCoverage(operations);
  const filesystemBudget = createFilesystemCleanupBudget(options);
  const runFilesystemTask = async <T>(
    operation: Operation,
    task: (execution: OperationExecutionContext) => Promise<T>,
  ): Promise<T> => {
    if (operation.phase !== "filesystem") {
      return await task({ remainingMs: () => Number.MAX_SAFE_INTEGER });
    }
    return await filesystemBudget.run(task);
  };
  const validationFailures: string[] = [];
  for (const operation of operations) {
    if (operation.phase === "filesystem") filesystemBudget.resume();
    else filesystemBudget.pause();
    if (operation.validate === undefined) continue;
    try {
      await runFilesystemTask(operation, async (execution) => {
        await operation.validate?.(
          operation.phase === "filesystem" ? execution : undefined,
        );
      });
      assertCommandTerminationConfirmed();
    } catch (error) {
      if (error instanceof UnconfirmedCommandTerminationError) throw error;
      if (error instanceof FilesystemCleanupDeadlineError) throw error;
      assertCommandTerminationConfirmed();
      const detail = error instanceof Error ? error.message : String(error);
      validationFailures.push(`${operation.description}: ${detail}`);
    }
  }
  if (validationFailures.length > 0) {
    throw new Error(
      `Cleanup plan validation failed before mutation:\n${validationFailures.join("\n")}`,
    );
  }

  // Filesystem validation happens before package mutations so the plan is
  // still fail-closed. Pause the filesystem clock while those package (and
  // other non-filesystem) phases run; only filesystem validation/traversal
  // work consumes the aggregate budget.
  filesystemBudget.pause();
  const results: OperationResult[] = [];
  const resultsById = new Map<string, OperationResult>();
  const reversible: Operation[] = [];
  let payloadMutationMayHaveStarted = false;
  const validateBeforeRun = async (operation: Operation): Promise<void> => {
    if (operation.validateBeforeRun === undefined) return;
    try {
      await runFilesystemTask(operation, async (execution) => {
        await operation.validateBeforeRun?.(
          operation.phase === "filesystem" ? execution : undefined,
        );
      });
      assertCommandTerminationConfirmed();
    } catch (error) {
      if (error instanceof UnconfirmedCommandTerminationError) throw error;
      if (error instanceof FilesystemCleanupDeadlineError) throw error;
      assertCommandTerminationConfirmed();
      throw new Error(
        `${operation.description} failed immediate validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  try {
    for (const phase of PHASES) {
      if (phase === "filesystem") filesystemBudget.resume();
      else filesystemBudget.pause();
      const phaseOperations = operations.filter(
        (operation) => operation.phase === phase,
      );
      if (phaseOperations.length === 0 && phase !== "preflight") continue;
      if (phaseOperations.length > 0) {
        await core.group(`${phase} cleanup`, async () => {
          if (phase === "filesystem") {
            const eligible = phaseOperations.filter(
              (operation) =>
                !isCoveredBySuccessfulOperation(operation, resultsById),
            );
            // Destructive path removals are deliberately serialized. If a command
            // timeout cannot prove its process tree ended, no sibling deletion may
            // already be in flight when the fatal termination latch is observed.
            for (const operation of eligible) {
              await validateBeforeRun(operation);
              payloadMutationMayHaveStarted = true;
              const result = await filesystemBudget.run(
                async (execution) => await runOne(operation, execution),
              );
              results.push(result);
              resultsById.set(operation.id, result);
              if (
                result.status === "removed" &&
                operation.rollback !== undefined
              ) {
                reversible.push(operation);
              }
            }
            return;
          }

          for (const operation of phaseOperations) {
            if (isCoveredBySuccessfulOperation(operation, resultsById))
              continue;
            await validateBeforeRun(operation);
            if (phase !== "preflight") payloadMutationMayHaveStarted = true;
            const result = await runOne(operation);
            results.push(result);
            resultsById.set(operation.id, result);
            if (
              result.status === "removed" &&
              operation.rollback !== undefined
            ) {
              reversible.push(operation);
            }
          }
        });
      }
      if (phase === "preflight") {
        const failures: string[] = [];
        for (const runLast of [false, true]) {
          for (const operation of operations) {
            if (
              operation.validateAfterPreflight === undefined ||
              (operation.validateAfterPreflightLast === true) !== runLast
            ) {
              continue;
            }
            try {
              await runFilesystemTask(operation, async (execution) => {
                await operation.validateAfterPreflight?.(
                  operation.phase === "filesystem" ? execution : undefined,
                );
              });
              assertCommandTerminationConfirmed();
            } catch (error) {
              if (error instanceof UnconfirmedCommandTerminationError) {
                throw error;
              }
              if (error instanceof FilesystemCleanupDeadlineError) {
                throw error;
              }
              assertCommandTerminationConfirmed();
              failures.push(
                `${operation.description}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
        if (failures.length > 0) {
          throw new Error(
            `Cleanup validation failed after reversible preflight and before payload mutation:\n${failures.join("\n")}`,
          );
        }
      }
    }
  } catch (error) {
    // Never start rollback commands while an unconfirmed timed-out process may
    // still be mutating the same runner. The termination error remains primary.
    assertCommandTerminationConfirmed();
    const rollbackFailures: string[] = [];
    for (const operation of [...reversible].reverse()) {
      if (
        payloadMutationMayHaveStarted &&
        operation.rollbackAfterPayloadMutation !== true
      ) {
        continue;
      }
      try {
        assertCommandTerminationConfirmed();
        await operation.rollback?.();
        assertCommandTerminationConfirmed();
      } catch (rollbackError) {
        if (rollbackError instanceof UnconfirmedCommandTerminationError) {
          throw rollbackError;
        }
        assertCommandTerminationConfirmed();
        rollbackFailures.push(
          `${operation.description}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
    }
    if (rollbackFailures.length > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}; rollback failed: ${rollbackFailures.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  assertCommandTerminationConfirmed();
  return results;
}

export function parentOf(target: string): string {
  return dirname(normalize(target));
}
