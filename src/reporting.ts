import * as core from "@actions/core";
import { statfs } from "node:fs/promises";
import type { OperationResult, RuntimeContext } from "./types.js";

export async function availableBytes(context: RuntimeContext): Promise<bigint> {
  const target = context.platform === "windows" ? context.home : "/";
  const stats = await statfs(target, { bigint: true });
  return stats.bavail * stats.bsize;
}

export function humanBytes(bytes: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = Number(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

export interface OperationCounts {
  readonly removed: number;
  readonly notFound: number;
  readonly unsupported: number;
  readonly failed: number;
}

export function reportResults(
  results: readonly OperationResult[],
): OperationCounts {
  const counts = new Map<OperationResult["status"], number>();
  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }
  core.info(
    `Operations: removed=${counts.get("removed") ?? 0}, not-found=${counts.get("not-found") ?? 0}, unsupported=${counts.get("unsupported") ?? 0}, failed=${counts.get("failed") ?? 0}`,
  );
  return {
    removed: counts.get("removed") ?? 0,
    notFound: counts.get("not-found") ?? 0,
    unsupported: counts.get("unsupported") ?? 0,
    failed: counts.get("failed") ?? 0,
  };
}
