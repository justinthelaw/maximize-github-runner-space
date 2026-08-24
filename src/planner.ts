import {
  BROWSER_CHILDREN,
  COMPONENTS,
  COMPONENT_ID_SET,
  LARGE_PACKAGE_OVERLAPS,
  TOOLCACHE_CHILDREN,
  TOOLCACHE_OWNERS,
} from "./components.js";
import type { CleanupPlan, ComponentId } from "./types.js";

export type InputReader = (name: string) => string;

const MAX_SWAPFILE_SIZE_INPUT_LENGTH = 128;
const MAX_SWAPFILE_SIZE_DIGITS = 64;

function normalizeCsv(value: string): string {
  return value.toLowerCase().replace(/\s/g, "");
}

function containsAny(
  values: ReadonlySet<ComponentId>,
  candidates: readonly ComponentId[],
): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function parseProfile(raw: string): "max" | "custom" {
  const normalized = normalizeCsv(raw);
  if (normalized === "max" || normalized === "custom") {
    return normalized;
  }

  throw new Error(
    `Invalid cleanup-profile '${raw}'. Supported values: max,custom.`,
  );
}

function parseSkipped(raw: string): Set<ComponentId> {
  const normalized = normalizeCsv(raw);
  const skipped = new Set<ComponentId>();
  const invalid: string[] = [];

  for (const value of normalized.split(",")) {
    if (value === "") continue;
    if (!COMPONENT_ID_SET.has(value as ComponentId)) {
      invalid.push(value);
      continue;
    }
    skipped.add(value as ComponentId);
  }

  if (invalid.length > 0) {
    throw new Error(
      `Invalid skip-components value(s): ${invalid.join(",")}. Supported components: ${[
        ...COMPONENT_ID_SET,
      ].join(",")}.`,
    );
  }

  return skipped;
}

export function parseSwapfileSize(rawValue: string): bigint | undefined {
  if (rawValue.length > MAX_SWAPFILE_SIZE_INPUT_LENGTH) {
    throw new Error("swapfile-size is too long.");
  }
  const raw = rawValue.replace(/\s/g, "");
  if (raw === "") return undefined;

  const match = /^([0-9]+)(?:\.([0-9]+))?([kmgt]i?b?)?$/i.exec(raw);
  if (match === null) {
    throw new Error(
      `Invalid swapfile-size '${rawValue}'. Use values like 0, 1.5GiB, 512MiB, or 2.`,
    );
  }

  const whole = match[1];
  const fraction = match[2] ?? "";
  const unit = (match[3] ?? "gib").toLowerCase();
  if (whole === undefined) {
    throw new Error(`Invalid swapfile-size '${rawValue}'.`);
  }
  if (whole.length + fraction.length > MAX_SWAPFILE_SIZE_DIGITS) {
    throw new Error("swapfile-size is too long.");
  }

  const multipliers: Readonly<Record<string, bigint>> = {
    k: 1024n,
    kb: 1024n,
    ki: 1024n,
    kib: 1024n,
    m: 1024n ** 2n,
    mb: 1024n ** 2n,
    mi: 1024n ** 2n,
    mib: 1024n ** 2n,
    g: 1024n ** 3n,
    gb: 1024n ** 3n,
    gi: 1024n ** 3n,
    gib: 1024n ** 3n,
    t: 1024n ** 4n,
    tb: 1024n ** 4n,
    ti: 1024n ** 4n,
    tib: 1024n ** 4n,
  };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`Invalid swapfile-size '${rawValue}'.`);
  }

  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  const scaled = numerator * multiplier;
  const bytes = (scaled + denominator / 2n) / denominator;

  if (numerator !== 0n && bytes < 1024n ** 2n) {
    throw new Error("Positive swapfile-size values must be at least 1 MiB.");
  }
  if (bytes > 2n ** 63n - 1n) {
    throw new Error("swapfile-size exceeds signed 64-bit byte arithmetic.");
  }

  return bytes;
}

export function createPlan(readInput: InputReader): CleanupPlan {
  const profile = parseProfile(readInput("cleanup-profile"));
  const requestedSkips = parseSkipped(readInput("skip-components"));
  const skipped =
    profile === "max" ? new Set(requestedSkips) : new Set<ComponentId>();
  // A skipped umbrella protects everything it owns. A skipped child only
  // disables the broad operation, allowing its siblings to be reclaimed.
  if (skipped.has("browsers")) {
    for (const component of BROWSER_CHILDREN) skipped.add(component);
  }
  if (skipped.has("cached-tools")) {
    for (const component of TOOLCACHE_CHILDREN) skipped.add(component);
  }
  const enabled = new Set<ComponentId>();

  for (const component of COMPONENTS) {
    const shouldEnable =
      profile === "max"
        ? !skipped.has(component.id)
        : readInput(component.input) === "true";
    if (shouldEnable) enabled.add(component.id);
  }

  if (profile === "max") {
    if (skipped.has("browsers") || containsAny(skipped, BROWSER_CHILDREN)) {
      enabled.delete("browsers");
    }
    if (skipped.has("cached-tools") || containsAny(skipped, TOOLCACHE_OWNERS)) {
      enabled.delete("cached-tools");
    }
    if (containsAny(skipped, LARGE_PACKAGE_OVERLAPS)) {
      enabled.delete("large-packages");
    }
  }

  if (enabled.has("browsers")) {
    for (const component of BROWSER_CHILDREN) enabled.delete(component);
  }
  if (enabled.has("cached-tools")) {
    for (const component of TOOLCACHE_CHILDREN) enabled.delete(component);
  }
  // Removing the engine also removes its image store. Avoid starting the
  // daemon merely to run a redundant prune first.
  if (enabled.has("docker-engine")) enabled.delete("docker-images");

  return {
    profile,
    enabled,
    skipped,
    swapfileBytes: parseSwapfileSize(readInput("swapfile-size")),
  };
}
