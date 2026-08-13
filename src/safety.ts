import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { RuntimeContext } from "./types.js";

type PathApi = typeof posix;

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
  const runtimeExecutable =
    context.platform === "windows"
      ? win32.isAbsolute(process.execPath)
        ? process.execPath
        : undefined
      : posix.isAbsolute(process.execPath)
        ? process.execPath
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

export async function inspectTarget(target: string): Promise<{
  readonly exists: boolean;
  readonly isLink: boolean;
  readonly realPath?: string;
}> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      return { exists: true, isLink: true };
    }
    return { exists: true, isLink: false, realPath: await realpath(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, isLink: false };
    }
    throw error;
  }
}

export async function assertSafeExistingTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<void> {
  const api = pathApi(context);
  assertSafeRemovalTarget(target, allowedParents, context);
  const normalizedTarget = api.normalize(api.resolve(target));

  // Refuse redirected ancestors. The final target may itself be a symlink or
  // junction: removing that entry unlinks it rather than traversing it. Every
  // existing prefix before it must be a real directory, however, or a trusted
  // lexical allowlist can be redirected outside its boundary.
  const parsed = api.parse(normalizedTarget);
  const relativeParts = normalizedTarget
    .slice(parsed.root.length)
    .split(api.sep)
    .filter(Boolean);
  let prefix = parsed.root;
  for (const part of relativeParts.slice(0, -1)) {
    prefix = api.join(prefix, part);
    try {
      const stat = await lstat(prefix);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Refusing cleanup target with a redirected ancestor: '${target}'.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  const inspected = await inspectTarget(target);
  if (!inspected.exists) return;

  if (!inspected.isLink && inspected.realPath !== undefined) {
    const resolved = canonicalLexical(inspected.realPath, api);
    if (overlapsProtected(resolved, context, api)) {
      throw new Error(
        `Refusing cleanup target resolving to a protected path: '${target}'.`,
      );
    }
  }

  // Re-run lexical validation immediately before mutation. This does not make
  // filesystem deletion atomic, but closes ordinary image/workflow races on an
  // ephemeral runner and keeps the final-link unlink behavior above.
  assertSafeRemovalTarget(target, allowedParents, context);
}

/** Validate a directory that will be created or reused without following a link. */
export async function assertSafeDirectoryTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<void> {
  await assertSafeExistingTarget(target, allowedParents, context);
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
