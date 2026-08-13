import * as core from "@actions/core";
import { COMPONENTS } from "./components.js";
import {
  executeOperations,
  prepareOperations,
  createUnsupportedOperation,
} from "./operations.js";
import { createPlan } from "./planner.js";
import { readActionInput } from "./inputs.js";
import { createLinuxAdapter } from "./platforms/linux.js";
import { createMacOSAdapter } from "./platforms/macos.js";
import { createWindowsAdapter } from "./platforms/windows.js";
import { availableBytes, humanBytes, reportResults } from "./reporting.js";
import { createRuntimeContext } from "./runtime.js";
import type {
  Adapter,
  ComponentId,
  Operation,
  RuntimeContext,
} from "./types.js";

async function adapterForPlatform(context: RuntimeContext): Promise<Adapter> {
  switch (context.platform) {
    case "linux":
      return await createLinuxAdapter(context);
    case "macos":
      return await createMacOSAdapter(context);
    case "windows":
      return await createWindowsAdapter(context);
  }
}

async function run(): Promise<void> {
  const plan = createPlan(readActionInput);
  const context = await createRuntimeContext();

  if (!context.isGitHubHosted) {
    throw new Error(
      "This destructive action supports only ephemeral standard GitHub-hosted runners (RUNNER_ENVIRONMENT=github-hosted).",
    );
  }
  if (context.isContainer && !context.isUbuntuSlim) {
    throw new Error(
      "Arbitrary job containers are unsupported. Only GitHub's standard ubuntu-slim runner image may run in container mode.",
    );
  }
  if (!context.isDefinitionCompatibleImage) {
    throw new Error(
      "This GitHub-hosted image does not match a supported runner-images Ubuntu, macOS, or Windows definition. No cleanup was scheduled.",
    );
  }

  if (
    plan.swapfileBytes !== undefined &&
    (context.platform !== "linux" ||
      context.isContainer ||
      !context.hasPasswordlessSudo)
  ) {
    throw new Error(
      "swapfile-size is supported only on privileged Linux VM runners. The existing swapfile was not changed.",
    );
  }

  // Do not even initialize a platform package manager or inventory on an
  // unsupported runner or for invalid swap configuration.
  const adapter = await adapterForPlatform(context);

  const before = await availableBytes(context);
  core.info(
    `Runner: ${context.platform}/${context.architecture}${context.isContainer ? " (container)" : ""}`,
  );
  core.info(`Available storage before cleanup: ${humanBytes(before)}`);
  core.info(`Cleanup profile: ${plan.profile}`);
  if (plan.skipped.size > 0) {
    core.info(`Protected components: ${[...plan.skipped].join(", ")}`);
  }

  const requestedForPlatform = new Set<ComponentId>(
    [...plan.enabled].filter((component) =>
      (
        COMPONENTS.find((definition) => definition.id === component)
          ?.platforms as readonly string[] | undefined
      )?.includes(context.platform),
    ),
  );
  const rawOperations: Operation[] = [...(await adapter.operations(plan))];
  for (const component of requestedForPlatform) {
    if (!adapter.supportedComponents.has(component)) {
      rawOperations.push(
        createUnsupportedOperation(
          component,
          "not present on this runner image family",
        ),
      );
    }
  }
  const operations = prepareOperations(rawOperations, plan);
  core.info(`Scheduled operations: ${operations.length}`);

  const results = await executeOperations(operations);
  reportResults(results);

  const after = await availableBytes(context);
  const reclaimed = after > before ? after - before : 0n;
  core.info(`Available storage after cleanup: ${humanBytes(after)}`);
  core.info(`Storage reclaimed: ${humanBytes(reclaimed)}`);

  core.setOutput("available-bytes-before", before.toString());
  core.setOutput("available-bytes-after", after.toString());
  core.setOutput("reclaimed-bytes", reclaimed.toString());
  core.setOutput("platform", context.platform);
  core.setOutput("architecture", context.architecture);

  const failures = results.filter((result) => result.status === "failed");
  if (failures.length > 0) {
    core.warning(
      `${failures.length} cleanup operation(s) failed. Cleanup remains best-effort for backward compatibility.`,
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
