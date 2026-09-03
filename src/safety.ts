import { lstat, readFile, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { RuntimeContext } from "./types.js";
import {
  isWindowsReparsePoint,
  observeStableWindowsPaths,
  readWindowsFileAttributes,
} from "./windows-path.js";

export { readWindowsFileAttributes } from "./windows-path.js";

type PathApi = typeof posix;

export type LinuxMountInfoReader = () => Promise<string>;

export interface InspectTargetDependencies {
  readonly platform?: RuntimeContext["platform"];
  readonly lstat?: typeof lstat;
  readonly realpath?: typeof realpath;
  readonly readWindowsFileAttributes?: typeof readWindowsFileAttributes;
}

export interface ExistingTargetDependencies extends InspectTargetDependencies {
  readonly readLinuxMountInfo?: LinuxMountInfoReader;
  readonly inspectTarget?: typeof inspectTarget;
}

const NODE_LINUX_MOUNT_INFO_READER: LinuxMountInfoReader = async () =>
  await readFile("/proc/self/mountinfo", "utf8");

const LINUX_MOUNT_POINT_ESCAPES = {
  "040": " ",
  "011": "\t",
  "012": "\n",
  "134": "\\",
} as const;

export function parseLinuxMountPoints(mountInfo: string): readonly string[] {
  const mountPoints: string[] = [];
  const lines = mountInfo.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const sections = line.split(" - ");
    const preSeparator = sections[0];
    const postSeparator = sections[1];
    if (
      sections.length !== 2 ||
      preSeparator === undefined ||
      postSeparator === undefined ||
      postSeparator === ""
    ) {
      throw new Error(`Malformed Linux mountinfo record at line ${index + 1}.`);
    }

    const preSeparatorFields = preSeparator.split(" ");
    const postSeparatorFields = postSeparator.split(" ");
    const encodedMountPoint = preSeparatorFields[4];
    if (
      preSeparatorFields.length < 6 ||
      postSeparatorFields.length !== 3 ||
      encodedMountPoint === undefined ||
      encodedMountPoint === "" ||
      preSeparatorFields.some((field) => field === "") ||
      postSeparatorFields.some((field) => field === "")
    ) {
      throw new Error(`Malformed Linux mountinfo record at line ${index + 1}.`);
    }

    const mountPoint = encodedMountPoint.replace(
      /\\(040|011|012|134)/g,
      (match, escape: string) =>
        LINUX_MOUNT_POINT_ESCAPES[
          escape as keyof typeof LINUX_MOUNT_POINT_ESCAPES
        ] ?? match,
    );
    if (!posix.isAbsolute(mountPoint)) {
      throw new Error(`Malformed Linux mountinfo record at line ${index + 1}.`);
    }
    mountPoints.push(mountPoint);
  }
  return mountPoints;
}

function pathApi(context: RuntimeContext): PathApi {
  return context.platform === "windows" ? win32 : posix;
}

function canonicalLexical(value: string, api: PathApi): string {
  const normalized = api.normalize(api.resolve(value));
  return api === win32 ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate: string, parent: string, api: PathApi): boolean {
  const difference = api.relative(parent, candidate);
  return (
    difference !== "" &&
    !difference.startsWith(`..${api.sep}`) &&
    difference !== ".." &&
    !api.isAbsolute(difference)
  );
}

function protectedPathSets(
  context: RuntimeContext,
  api: PathApi,
): {
  readonly exact: readonly string[];
  readonly recursive: readonly string[];
} {
  const root = canonicalLexical(api.parse(context.home).root, api);
  const runtimeExecutable = api.isAbsolute(context.runtimeExecutable)
    ? context.runtimeExecutable
    : undefined;
  const exact = [root, context.home, runtimeExecutable]
    .filter((value): value is string => value !== undefined && value !== "")
    .map((value) => canonicalLexical(value, api));
  const recursive = [context.temp, context.workspace, context.actionPath]
    .filter((value): value is string => value !== undefined && value !== "")
    .map((value) => canonicalLexical(value, api));
  return { exact, recursive };
}

function overlapsProtected(
  candidate: string,
  context: RuntimeContext,
  api: PathApi,
): boolean {
  const protectedPaths = protectedPathSets(context, api);
  return (
    protectedPaths.exact.some(
      (protectedPath) =>
        candidate === protectedPath || isWithin(protectedPath, candidate, api),
    ) ||
    protectedPaths.recursive.some(
      (protectedPath) =>
        candidate === protectedPath ||
        isWithin(candidate, protectedPath, api) ||
        isWithin(protectedPath, candidate, api),
    )
  );
}

export function assertSafeRemovalTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): string {
  const api = pathApi(context);
  if (target.trim() === "" || !api.isAbsolute(target)) {
    throw new Error(`Refusing non-absolute cleanup target: '${target}'.`);
  }

  const candidate = canonicalLexical(target, api);
  if (overlapsProtected(candidate, context, api)) {
    throw new Error(`Refusing protected cleanup target: '${target}'.`);
  }

  const canonicalParents = allowedParents.map((value) =>
    canonicalLexical(value, api),
  );
  if (!canonicalParents.some((parent) => isWithin(candidate, parent, api))) {
    throw new Error(
      `Cleanup target '${target}' is outside its definition-derived allowlist.`,
    );
  }

  return api.normalize(api.resolve(target));
}

export interface TargetIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface AncestorInspection {
  readonly path: string;
  readonly identity: TargetIdentity;
  readonly kind: "directory" | "file" | "link" | "other";
  readonly fileAttributes?: number;
}

export type TargetInspection =
  | {
      readonly exists: false;
      readonly isLink: false;
    }
  | {
      readonly exists: true;
      readonly isLink: boolean;
      readonly realPath?: string;
      readonly identity: TargetIdentity;
      readonly fileAttributes?: number;
      readonly ancestors?: readonly AncestorInspection[];
    };

function sameStableWindowsTargetGeneration(
  left: StablePathStats,
  leftAttributes: number,
  right: StablePathStats,
  rightAttributes: number,
): boolean {
  const observedKind = (
    stats: StablePathStats,
    fileAttributes: number,
  ): AncestorInspection["kind"] =>
    stats.isSymbolicLink() || isWindowsReparsePoint(fileAttributes)
      ? "link"
      : filesystemPathKind(stats);
  return (
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino) &&
    observedKind(left, leftAttributes) === observedKind(right, rightAttributes)
  );
}

export async function inspectTarget(
  target: string,
  dependencies: InspectTargetDependencies = {},
): Promise<TargetInspection> {
  const inspectPath = async (path: string): Promise<StablePathStats> =>
    await (dependencies.lstat ?? lstat)(path, { bigint: true });
  const resolvePath = dependencies.realpath ?? realpath;
  let initial: StablePathStats;
  try {
    initial = await inspectPath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, isLink: false };
    }
    throw error;
  }

  const isWindows =
    dependencies.platform === "windows" ||
    (dependencies.platform === undefined && process.platform === "win32");
  if (!isWindows) {
    const initialIdentity = {
      device: BigInt(initial.dev),
      inode: BigInt(initial.ino),
    };
    if (initial.isSymbolicLink()) {
      return { exists: true, isLink: true, identity: initialIdentity };
    }
    const resolvedTarget = await resolvePath(target);
    let closing: StablePathStats;
    try {
      closing = await inspectPath(target);
    } catch {
      throw new Error(
        `Cleanup target changed while resolving its real path: '${target}'.`,
      );
    }
    if (
      initialIdentity.device !== BigInt(closing.dev) ||
      initialIdentity.inode !== BigInt(closing.ino) ||
      filesystemPathKind(initial) !== filesystemPathKind(closing)
    ) {
      throw new Error(
        `Cleanup target identity or kind changed while resolving its real path: '${target}'.`,
      );
    }
    return {
      exists: true,
      isLink: false,
      realPath: resolvedTarget,
      identity: {
        device: BigInt(closing.dev),
        inode: BigInt(closing.ino),
      },
    };
  }

  const readAttributes =
    dependencies.readWindowsFileAttributes ?? readWindowsFileAttributes;
  const beforeRealpath = (
    await observeStableWindowsPaths(
      [{ path: target, stats: initial }],
      inspectPath,
      readAttributes,
    )
  )[0];
  if (beforeRealpath === undefined) {
    throw new Error("Windows file attribute probe returned malformed output.");
  }
  const beforeIdentity = {
    device: BigInt(beforeRealpath.stats.dev),
    inode: BigInt(beforeRealpath.stats.ino),
  };
  if (
    beforeRealpath.stats.isSymbolicLink() ||
    isWindowsReparsePoint(beforeRealpath.fileAttributes)
  ) {
    return {
      exists: true,
      isLink: true,
      identity: beforeIdentity,
      fileAttributes: beforeRealpath.fileAttributes,
    };
  }

  const resolvedTarget = await resolvePath(target);
  let closingInitial: StablePathStats;
  try {
    closingInitial = await inspectPath(target);
  } catch {
    throw new Error(
      `Cleanup target changed while resolving its real path: '${target}'.`,
    );
  }
  const afterRealpath = (
    await observeStableWindowsPaths(
      [{ path: target, stats: closingInitial }],
      inspectPath,
      readAttributes,
    )
  )[0];
  if (afterRealpath === undefined) {
    throw new Error("Windows file attribute probe returned malformed output.");
  }
  if (
    !sameStableWindowsTargetGeneration(
      beforeRealpath.stats,
      beforeRealpath.fileAttributes,
      afterRealpath.stats,
      afterRealpath.fileAttributes,
    )
  ) {
    throw new Error(
      `Cleanup target identity or kind changed while resolving its real path: '${target}'.`,
    );
  }
  return {
    exists: true,
    isLink: false,
    realPath: resolvedTarget,
    identity: {
      device: BigInt(afterRealpath.stats.dev),
      inode: BigInt(afterRealpath.stats.ino),
    },
    fileAttributes: afterRealpath.fileAttributes,
  };
}

type StablePathStats = Awaited<ReturnType<typeof lstat>>;

function filesystemPathKind(
  stats: StablePathStats,
): AncestorInspection["kind"] {
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function ancestorPathsForTarget(
  target: string,
  api: PathApi,
): readonly string[] {
  const parsed = api.parse(target);
  const relativeParts = target
    .slice(parsed.root.length)
    .split(api.sep)
    .filter(Boolean);
  const ancestorPaths = [parsed.root];
  let prefix = parsed.root;
  for (const part of relativeParts.slice(0, -1)) {
    prefix = api.join(prefix, part);
    ancestorPaths.push(prefix);
  }
  return ancestorPaths;
}

function sameAncestorInspections(
  left: readonly AncestorInspection[],
  right: readonly AncestorInspection[],
): boolean {
  return (
    left.length === right.length &&
    left.every((ancestor, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        ancestor.path === other.path &&
        ancestor.kind === other.kind &&
        ancestor.identity.device === other.identity.device &&
        ancestor.identity.inode === other.identity.inode
      );
    })
  );
}

async function snapshotRemovalAncestors(
  normalizedTarget: string,
  target: string,
  context: RuntimeContext,
  dependencies: ExistingTargetDependencies,
): Promise<readonly AncestorInspection[]> {
  const api = pathApi(context);
  const inspectPath = async (path: string): Promise<StablePathStats> =>
    await (dependencies.lstat ?? lstat)(path, { bigint: true });
  const initial: { readonly path: string; readonly stats: StablePathStats }[] =
    [];
  for (const ancestorPath of ancestorPathsForTarget(normalizedTarget, api)) {
    try {
      const stats = await inspectPath(ancestorPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Refusing cleanup target with a redirected ancestor: '${target}'.`,
        );
      }
      initial.push({ path: ancestorPath, stats });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  const observed =
    context.platform === "windows"
      ? await observeStableWindowsPaths(
          initial,
          inspectPath,
          dependencies.readWindowsFileAttributes ?? readWindowsFileAttributes,
        )
      : initial.map(({ path, stats }) => ({ path, stats }));
  return observed.map(({ path, stats, ...attribute }) => {
    const fileAttributes =
      "fileAttributes" in attribute ? attribute.fileAttributes : undefined;
    if (
      stats.isSymbolicLink() ||
      (fileAttributes !== undefined && isWindowsReparsePoint(fileAttributes))
    ) {
      throw new Error(
        fileAttributes !== undefined && isWindowsReparsePoint(fileAttributes)
          ? `Refusing cleanup target with a reparse-point ancestor: '${target}'.`
          : `Refusing cleanup target with a redirected ancestor: '${target}'.`,
      );
    }
    return {
      path,
      kind: filesystemPathKind(stats),
      identity: { device: BigInt(stats.dev), inode: BigInt(stats.ino) },
      ...(fileAttributes === undefined ? {} : { fileAttributes }),
    };
  });
}

async function authorizedRemovalBoundaries(
  allowedParents: readonly string[],
  context: RuntimeContext,
  dependencies: ExistingTargetDependencies,
): Promise<readonly string[]> {
  const api = pathApi(context);
  const boundaries = new Set(
    allowedParents.map((parent) => canonicalLexical(parent, api)),
  );
  const resolvePath = dependencies.realpath ?? realpath;
  for (const parent of allowedParents) {
    try {
      boundaries.add(
        canonicalLexical(
          await resolvePath(api.normalize(api.resolve(parent))),
          api,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...boundaries];
}

async function stabilizeWindowsTargetInspection(
  target: string,
  inspected: Exclude<TargetInspection, { readonly exists: false }>,
  dependencies: ExistingTargetDependencies,
): Promise<Exclude<TargetInspection, { readonly exists: false }>> {
  if (inspected.fileAttributes !== undefined) {
    if (
      !Number.isSafeInteger(inspected.fileAttributes) ||
      inspected.fileAttributes < 0
    ) {
      throw new Error(
        "Windows file attribute probe returned malformed output.",
      );
    }
    if (isWindowsReparsePoint(inspected.fileAttributes) && !inspected.isLink) {
      const { realPath: _realPath, ...withoutRealPath } = inspected;
      return { ...withoutRealPath, isLink: true };
    }
    return inspected;
  }

  const inspectPath = async (path: string): Promise<StablePathStats> =>
    await (dependencies.lstat ?? lstat)(path, { bigint: true });
  let initial: StablePathStats;
  try {
    initial = await inspectPath(target);
  } catch {
    throw new Error(
      `Cleanup target changed during Windows attribute inspection: '${target}'.`,
    );
  }
  if (
    BigInt(initial.dev) !== inspected.identity.device ||
    BigInt(initial.ino) !== inspected.identity.inode ||
    initial.isSymbolicLink() !== inspected.isLink
  ) {
    throw new Error(
      `Cleanup target identity or kind changed during Windows attribute inspection: '${target}'.`,
    );
  }
  const observed = await observeStableWindowsPaths(
    [{ path: target, stats: initial }],
    inspectPath,
    dependencies.readWindowsFileAttributes ?? readWindowsFileAttributes,
  );
  const stable = observed[0];
  if (stable === undefined) {
    throw new Error("Windows file attribute probe returned malformed output.");
  }
  const identity = {
    device: BigInt(stable.stats.dev),
    inode: BigInt(stable.stats.ino),
  };
  const isLink =
    stable.stats.isSymbolicLink() ||
    isWindowsReparsePoint(stable.fileAttributes);
  const { realPath, ...withoutRealPath } = inspected;
  return isLink
    ? {
        ...withoutRealPath,
        identity,
        isLink: true,
        fileAttributes: stable.fileAttributes,
      }
    : {
        ...withoutRealPath,
        ...(realPath === undefined ? {} : { realPath }),
        identity,
        isLink: false,
        fileAttributes: stable.fileAttributes,
      };
}

async function observeRemovalTarget(
  target: string,
  context: RuntimeContext,
  dependencies: ExistingTargetDependencies,
): Promise<TargetInspection> {
  let inspected =
    dependencies.inspectTarget === undefined
      ? await inspectTarget(target, {
          platform: context.platform,
          ...(dependencies.lstat === undefined
            ? {}
            : { lstat: dependencies.lstat }),
          ...(dependencies.realpath === undefined
            ? {}
            : { realpath: dependencies.realpath }),
          ...(dependencies.readWindowsFileAttributes === undefined
            ? {}
            : {
                readWindowsFileAttributes:
                  dependencies.readWindowsFileAttributes,
              }),
        })
      : await dependencies.inspectTarget(target);
  if (context.platform === "windows" && inspected.exists) {
    inspected = await stabilizeWindowsTargetInspection(
      target,
      inspected,
      dependencies,
    );
  }
  return inspected;
}

function assertSameTargetGeneration(
  left: TargetInspection,
  right: TargetInspection,
  target: string,
): void {
  if (left.exists !== right.exists) {
    throw new Error(
      `Refusing cleanup target because it changed during validation: '${target}'.`,
    );
  }
  if (!left.exists || !right.exists) return;
  if (left.isLink !== right.isLink) {
    throw new Error(
      `Refusing cleanup target because its kind changed during validation: '${target}'.`,
    );
  }
  if (
    left.identity.device !== right.identity.device ||
    left.identity.inode !== right.identity.inode
  ) {
    throw new Error(
      `Refusing cleanup target because its identity changed during validation: '${target}'.`,
    );
  }
}

function assertResolvedTargetIsAuthorized(
  target: string,
  inspected: TargetInspection,
  allowedBoundaries: readonly string[],
  context: RuntimeContext,
  api: PathApi,
): void {
  if (!inspected.exists || inspected.isLink) return;
  if (inspected.realPath === undefined) {
    throw new Error(`Unable to resolve cleanup target safely: '${target}'.`);
  }
  const resolved = canonicalLexical(inspected.realPath, api);
  if (overlapsProtected(resolved, context, api)) {
    throw new Error(
      `Refusing cleanup target resolving to a protected path: '${target}'.`,
    );
  }
  if (!allowedBoundaries.some((parent) => isWithin(resolved, parent, api))) {
    throw new Error(
      `Refusing cleanup target resolving outside its definition-derived allowlist: '${target}'.`,
    );
  }
}

async function assertSafeExistingTargetWithoutMountBoundary(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
  dependencies: ExistingTargetDependencies = {},
): Promise<TargetInspection> {
  const api = pathApi(context);
  assertSafeRemovalTarget(target, allowedParents, context);
  const normalizedTarget = api.normalize(api.resolve(target));
  const beforeAncestors = await snapshotRemovalAncestors(
    normalizedTarget,
    target,
    context,
    dependencies,
  );
  const allowedBoundaries = await authorizedRemovalBoundaries(
    allowedParents,
    context,
    dependencies,
  );

  const targetBeforeAncestors = await observeRemovalTarget(
    target,
    context,
    dependencies,
  );
  if (!targetBeforeAncestors.exists) return targetBeforeAncestors;

  const afterAncestors = await snapshotRemovalAncestors(
    normalizedTarget,
    target,
    context,
    dependencies,
  );
  if (!sameAncestorInspections(beforeAncestors, afterAncestors)) {
    throw new Error(
      `Refusing cleanup target because an ancestor changed during validation: '${target}'.`,
    );
  }

  const authoritativeTarget = await observeRemovalTarget(
    target,
    context,
    dependencies,
  );
  assertSameTargetGeneration(
    targetBeforeAncestors,
    authoritativeTarget,
    target,
  );

  assertResolvedTargetIsAuthorized(
    target,
    authoritativeTarget,
    allowedBoundaries,
    context,
    api,
  );
  assertSafeRemovalTarget(target, allowedParents, context);
  return authoritativeTarget.exists
    ? { ...authoritativeTarget, ancestors: afterAncestors }
    : authoritativeTarget;
}

export async function assertSafeExistingTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
  dependencies: ExistingTargetDependencies = {},
): Promise<TargetInspection> {
  const inspected = await assertSafeExistingTargetWithoutMountBoundary(
    target,
    allowedParents,
    context,
    dependencies,
  );
  if (
    context.platform !== "linux" ||
    !inspected.exists ||
    inspected.isLink ||
    inspected.realPath === undefined
  ) {
    return inspected;
  }

  const readLinuxMountInfo =
    dependencies.readLinuxMountInfo ?? NODE_LINUX_MOUNT_INFO_READER;
  const allowedBoundaries = await authorizedRemovalBoundaries(
    allowedParents,
    context,
    dependencies,
  );
  const mountPoints = parseLinuxMountPoints(await readLinuxMountInfo());
  const normalizedTarget = posix.normalize(posix.resolve(target));
  const afterMountAncestors = await snapshotRemovalAncestors(
    normalizedTarget,
    target,
    context,
    dependencies,
  );
  if (
    inspected.ancestors === undefined ||
    !sameAncestorInspections(inspected.ancestors, afterMountAncestors)
  ) {
    throw new Error(
      `Refusing cleanup target because an ancestor changed during validation: '${target}'.`,
    );
  }

  const closingTarget = await observeRemovalTarget(
    target,
    context,
    dependencies,
  );
  assertSameTargetGeneration(inspected, closingTarget, target);
  assertResolvedTargetIsAuthorized(
    target,
    closingTarget,
    allowedBoundaries,
    context,
    posix,
  );
  if (!closingTarget.exists || closingTarget.realPath === undefined) {
    throw new Error(`Unable to resolve cleanup target safely: '${target}'.`);
  }
  const canonicalTarget = canonicalLexical(closingTarget.realPath, posix);
  const offendingMountPoint = mountPoints.find((mountPoint) => {
    const canonicalMountPoint = canonicalLexical(mountPoint, posix);
    return (
      canonicalMountPoint === canonicalTarget ||
      isWithin(canonicalMountPoint, canonicalTarget, posix)
    );
  });
  if (offendingMountPoint !== undefined) {
    throw new Error(
      `Refusing cleanup target '${target}' containing mounted path '${offendingMountPoint}'.`,
    );
  }
  assertSafeRemovalTarget(target, allowedParents, context);
  return { ...closingTarget, ancestors: afterMountAncestors };
}

/** Validate a directory that will be created or reused without following a link. */
export async function assertSafeDirectoryTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<void> {
  const inspected = await assertSafeExistingTargetWithoutMountBoundary(
    target,
    allowedParents,
    context,
  );
  if (inspected.exists && inspected.isLink) {
    throw new Error(
      `Refusing to create a directory through a non-directory target: '${target}'.`,
    );
  }
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Refusing to create a directory through a non-directory target: '${target}'.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export type ExactTargetExpectation =
  "directory" | "regular-file" | "absent-or-regular-file";

/**
 * Validate a path that a later command will follow rather than unlink.
 *
 * Unlike cleanup targets, a final link is unsafe here because tools such as
 * `mv`, `sed`, and `tee` follow it. The expectation also prevents a device,
 * socket, or directory from being treated as an ordinary file.
 */
export async function assertSafeExactTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
  expectation: ExactTargetExpectation,
): Promise<void> {
  const inspected = await assertSafeExistingTargetWithoutMountBoundary(
    target,
    allowedParents,
    context,
  );
  if (inspected.exists && inspected.isLink) {
    throw new Error(
      `Refusing follow-through mutation of a symbolic link or reparse point: '${target}'.`,
    );
  }

  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing follow-through mutation of a symbolic link: '${target}'.`,
      );
    }

    const expectsDirectory = expectation === "directory";
    if (
      (expectsDirectory && !stat.isDirectory()) ||
      (!expectsDirectory && !stat.isFile())
    ) {
      throw new Error(
        `Refusing follow-through mutation of an unexpected target type: '${target}'.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (expectation === "absent-or-regular-file") return;
      throw new Error(
        `Required definition target does not exist: '${target}'.`,
      );
    }
    throw error;
  }
}
