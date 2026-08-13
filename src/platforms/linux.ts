import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  commandExists,
  findCommandPath,
  runCommand,
  runElevated,
} from "../command.js";
import { COMPONENTS } from "../components.js";
import {
  createFunctionOperation,
  createRemovePathOperation,
} from "../operations.js";
import { assertSafeDirectoryTarget } from "../safety.js";
import type {
  Adapter,
  CleanupPlan,
  CommandResult,
  ComponentId,
  Operation,
  RuntimeContext,
} from "../types.js";

const SUPPORTED = new Set<ComponentId>(
  COMPONENTS.filter((component) =>
    (component.platforms as readonly string[]).includes("linux"),
  ).map((component) => component.id),
);

export function existingFileState(
  exitCode: number,
): "present" | "absent" | "failed" {
  if (exitCode === 0) return "present";
  if (exitCode === 1) return "absent";
  return "failed";
}

export function isStoppedSystemdUnit(result: CommandResult): boolean {
  if (result.exitCode !== 0) return false;
  const state = result.stdout.trim();
  return state === "inactive" || state === "failed";
}

const APT_PACKAGES: Readonly<Partial<Record<ComponentId, readonly string[]>>> =
  {
    java: ["^openjdk-.*", "^temurin-.*"],
    browsers: [
      "google-chrome-stable",
      "microsoft-edge-stable",
      "firefox",
      "chromium",
      "chromium-browser",
      "chromium-codecs-ffmpeg-extra",
    ],
    chrome: ["google-chrome-stable"],
    chromium: ["chromium", "chromium-browser", "chromium-codecs-ffmpeg-extra"],
    edge: ["microsoft-edge-stable"],
    firefox: ["firefox"],
    powershell: ["powershell"],
    "aws-cli": ["session-manager-plugin"],
    "azure-cli": ["azure-cli"],
    "gh-cli": ["gh"],
    "gcloud-cli": ["google-cloud-cli", "google-cloud-sdk"],
    kubectl: ["kubectl"],
    buildah: ["buildah"],
    podman: ["podman"],
    "docker-engine": [
      "docker-ce",
      "docker-ce-cli",
      "containerd.io",
      "docker-buildx-plugin",
      "docker-compose-plugin",
      "moby-engine",
      "moby-cli",
    ],
    maven: ["maven"],
    gradle: ["gradle"],
    ant: ["ant", "ant-optional"],
    php: ["^php.*", "composer", "phpunit"],
    postgresql: [
      "postgresql",
      "postgresql-common",
      "postgresql-client-common",
      "^postgresql-.*",
    ],
    mysql: ["mysql-common", "^mysql-.*", "^mariadb-.*"],
    apache: ["apache2", "apache2-utils", "apache2-bin", "apache2-data"],
    nginx: ["nginx", "nginx-common", "nginx-core"],
    "large-packages": [
      "^aspnetcore-.*",
      "^dotnet-.*",
      "^llvm-.*",
      "^php.*",
      "^mongodb-.*",
      "^mysql-.*",
      "azure-cli",
      "google-cloud-sdk",
      "google-cloud-cli",
      "google-chrome-stable",
      "microsoft-edge-stable",
      "firefox",
      "chromium",
      "chromium-browser",
      "chromium-codecs-ffmpeg-extra",
      "powershell",
      "mono-devel",
      "libgl1-mesa-dri",
    ],
  };

function exactDefinitionPath(
  value: string | undefined,
  fallback: string,
  allowed: readonly string[] = [fallback],
): string {
  if (
    value !== undefined &&
    value.trim() !== "" &&
    value.length <= 1024 &&
    posix.isAbsolute(value)
  ) {
    const normalized = posix.normalize(value);
    if (
      allowed.some((candidate) => posix.normalize(candidate) === normalized)
    ) {
      return normalized;
    }
  }
  return posix.normalize(fallback);
}

function trustedToolCache(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const expected = "/opt/hostedtoolcache";
  return posix.normalize(value) === expected ? expected : undefined;
}

function removeOperation(
  context: RuntimeContext,
  component: ComponentId,
  target: string | undefined,
  allowedParents: readonly string[],
  description: string,
  blockedBy?: readonly ComponentId[],
  coveredBy?: readonly ComponentId[],
): Operation | undefined {
  if (target === undefined || target.trim() === "") return undefined;
  return createRemovePathOperation({
    id: `${component}:${target}`,
    component,
    target,
    allowedParents,
    context,
    description,
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(coveredBy === undefined ? {} : { coveredBy }),
  });
}

async function versionedChildren(
  parent: string,
  pattern: RegExp,
): Promise<readonly string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          pattern.test(entry.name),
      )
      .map((entry) => join(parent, entry.name))
      .slice(0, 64);
  } catch {
    return [];
  }
}

function aptBatchOperation(
  context: RuntimeContext,
  plan: CleanupPlan,
  markDirty: () => void,
): Operation {
  return createFunctionOperation({
    id: "apt:selected-packages",
    component: "large-packages",
    description: "Remove selected runner-image packages with apt",
    phase: "package",
    dedupeKey: "apt:selected-packages",
    always: true,
    run: async () => {
      const specifications = [
        ...new Set(
          (
            Object.entries(APT_PACKAGES) as [ComponentId, readonly string[]][]
          ).flatMap(([component, packages]) =>
            plan.enabled.has(component) ? packages : [],
          ),
        ),
      ];
      if (specifications.length === 0) return { status: "not-found" };
      if (context.isContainer && !context.hasPasswordlessSudo) {
        return {
          status: "unsupported",
          detail: "unprivileged Linux container",
        };
      }
      if (!(await commandExists("apt-get"))) return { status: "not-found" };
      const query = await runCommand(
        "dpkg-query",
        ["-W", "-f=${binary:Package}\\n"],
        { silent: true },
      );
      if (query.exitCode !== 0)
        return { status: "unsupported", detail: "dpkg database unavailable" };
      const installed = query.stdout.split(/\r?\n/).filter(Boolean);
      const selected = installed.filter((name) =>
        specifications.some((specification) => {
          if (!specification.includes("*") && !specification.startsWith("^")) {
            return (
              name === specification || name.startsWith(`${specification}:`)
            );
          }
          try {
            return new RegExp(specification).test(name);
          } catch {
            return false;
          }
        }),
      );
      if (selected.length === 0) return { status: "not-found" };
      const result = await runElevated(
        context,
        "apt-get",
        ["purge", "-y", "--no-install-recommends", ...selected],
        { silent: false, timeoutMs: 15 * 60_000 },
      );
      if (result.exitCode === 0) markDirty();
      return result.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: result.stderr.trim() || `apt exited ${result.exitCode}`,
          };
    },
  });
}

async function commandRemoval(
  context: RuntimeContext,
  component: ComponentId,
  command: string,
): Promise<Operation> {
  // Resolve PATH links while the image is intact. Package and filesystem
  // cleanup can otherwise leave a dangling link that can no longer be found.
  const path = await findCommandPath(command);
  const description = `Remove runner-image ${command} executable`;
  if (path !== undefined) {
    const trustedBinDirectories = ["/usr/local/bin", "/usr/bin"];
    if (trustedBinDirectories.includes(dirname(path))) {
      return createRemovePathOperation({
        id: `binary:${component}:${command}`,
        component,
        description,
        target: path,
        allowedParents: [dirname(path)],
        context,
      });
    }
  }
  return createFunctionOperation({
    id: `binary:${component}:${command}`,
    component,
    description,
    phase: "filesystem",
    dedupeKey: `binary:${command}`,
    run: async () => {
      if (path === undefined) return { status: "not-found" };
      return {
        status: "unsupported",
        detail: `unexpected executable path ${path}`,
      };
    },
  });
}

function dockerPruneOperation(context: RuntimeContext): Operation {
  return createFunctionOperation({
    id: "docker:prune",
    component: "docker-images",
    description: "Prune unused Docker data",
    phase: "system",
    dedupeKey: "docker:prune",
    run: async () => {
      if (!(await commandExists("docker"))) return { status: "not-found" };
      const responsive = await runCommand("docker", ["info"], {
        silent: true,
        timeoutMs: 10_000,
      });
      if (responsive.exitCode !== 0) {
        return { status: "unsupported", detail: "Docker daemon unavailable" };
      }
      const result = await runElevated(
        context,
        "docker",
        ["system", "prune", "--all", "--volumes", "--force"],
        {
          silent: false,
          timeoutMs: 10 * 60_000,
        },
      );
      return result.exitCode === 0
        ? { status: "removed" }
        : { status: "failed", detail: result.stderr.trim() };
    },
  });
}

function serviceStopOperation(
  context: RuntimeContext,
  component: ComponentId,
  services: readonly string[],
  options: { readonly id?: string; readonly description?: string } = {},
): Operation {
  return createFunctionOperation({
    id: options.id ?? `service:stop:${component}`,
    component,
    description:
      options.description ?? `Stop ${component} services before cleanup`,
    phase: "preflight",
    fatal: true,
    run: async () => {
      if (context.isContainer) {
        return { status: "unsupported", detail: "systemd unavailable" };
      }
      if (!(await commandExists("systemctl"))) {
        return { status: "failed", detail: "systemd is unavailable" };
      }
      let stopped = false;
      for (const service of services) {
        const unit = `${service}.service`;
        const discovered = await runElevated(
          context,
          "systemctl",
          ["show", unit, "--property=LoadState", "--value"],
          { silent: true, timeoutMs: 30_000 },
        );
        if (discovered.exitCode !== 0) {
          return {
            status: "failed",
            detail:
              discovered.stderr.trim() ||
              `could not inspect systemd unit ${unit}`,
          };
        }
        const loadState = discovered.stdout.trim();
        if (loadState === "not-found") continue;
        if (loadState === "") {
          return {
            status: "failed",
            detail: `systemd returned no LoadState for ${unit}`,
          };
        }

        const result = await runElevated(context, "systemctl", ["stop", unit], {
          silent: true,
          timeoutMs: 60_000,
        });
        if (result.exitCode !== 0) {
          return {
            status: "failed",
            detail: result.stderr.trim() || `could not stop ${unit}`,
          };
        }
        const activeState = await runElevated(
          context,
          "systemctl",
          ["show", unit, "--property=ActiveState", "--value"],
          { silent: true, timeoutMs: 30_000 },
        );
        if (!isStoppedSystemdUnit(activeState)) {
          return {
            status: "failed",
            detail:
              activeState.stderr.trim() ||
              `${unit} did not reach a terminal stopped state`,
          };
        }
        stopped = true;
      }
      return stopped ? { status: "removed" } : { status: "not-found" };
    },
  });
}

function recreateToolCacheOperation(
  context: RuntimeContext,
  target: string | undefined,
): Operation | undefined {
  if (target === undefined) return undefined;
  return createFunctionOperation({
    id: "toolcache:recreate",
    component: "cached-tools",
    description: "Recreate the hosted toolcache directory",
    phase: "system",
    run: async () => {
      try {
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let needsElevatedCreation = false;
      try {
        await mkdir(target, { recursive: true });
      } catch {
        needsElevatedCreation = true;
      }
      if (needsElevatedCreation) {
        const created = await runElevated(
          context,
          "mkdir",
          ["-p", "--", target],
          {
            silent: true,
          },
        );
        if (created.exitCode !== 0) {
          return { status: "failed", detail: created.stderr.trim() };
        }
      }
      try {
        await assertSafeDirectoryTarget(target, [dirname(target)], context);
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        needsElevatedCreation &&
        typeof process.getuid === "function" &&
        typeof process.getgid === "function"
      ) {
        const ownership = await runElevated(
          context,
          "chown",
          [`${process.getuid()}:${process.getgid()}`, target],
          { silent: true },
        );
        if (ownership.exitCode !== 0) {
          return { status: "failed", detail: ownership.stderr.trim() };
        }
      }
      return { status: "removed" };
    },
  });
}

function aptFinalizeOperation(
  context: RuntimeContext,
  isDirty: () => boolean,
): Operation {
  return createFunctionOperation({
    id: "apt:finalize",
    component: "large-packages",
    description: "Remove unused apt dependencies and cached archives",
    phase: "package",
    always: true,
    run: async () => {
      if (
        !(await commandExists("apt-get")) ||
        (context.isContainer && !context.hasPasswordlessSudo)
      ) {
        return { status: "unsupported", detail: "apt cleanup unavailable" };
      }
      if (!isDirty()) return { status: "not-found" };
      const autoremove = await runElevated(
        context,
        "apt-get",
        ["autoremove", "-y"],
        {
          silent: false,
          timeoutMs: 15 * 60_000,
        },
      );
      const clean = await runElevated(context, "apt-get", ["clean"], {
        silent: true,
        timeoutMs: 5 * 60_000,
      });
      return autoremove.exitCode === 0 && clean.exitCode === 0
        ? { status: "removed" }
        : {
            status: "failed",
            detail: autoremove.stderr.trim() || clean.stderr.trim(),
          };
    },
  });
}

function swapOperation(context: RuntimeContext, requested: bigint): Operation {
  return createFunctionOperation({
    id: "swapfile",
    component: "large-packages",
    description:
      requested === 0n ? "Remove /mnt/swapfile" : "Configure /mnt/swapfile",
    phase: "system",
    always: true,
    fatal: true,
    run: async () => {
      if (context.isContainer || !context.hasPasswordlessSudo) {
        return {
          status: "unsupported",
          detail: "swap requires a privileged Linux VM",
        };
      }

      const makeTemporaryFile = async (
        prefix: "/mnt/swapfile.new." | "/mnt/swapfile.previous.",
      ): Promise<
        | { readonly path: string; readonly detail?: never }
        | { readonly path?: never; readonly detail: string }
      > => {
        const created = await runElevated(
          context,
          "mktemp",
          [`${prefix}XXXXXX`],
          { silent: true },
        );
        const path = created.stdout.trim();
        const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : "";
        if (
          created.exitCode !== 0 ||
          suffix.length !== 6 ||
          !/^[A-Za-z0-9]+$/.test(suffix)
        ) {
          return {
            detail:
              created.stderr.trim() || "mktemp returned an unsafe swap path",
          };
        }
        return { path };
      };

      const removeTemporaryFile = async (path: string): Promise<void> => {
        await runElevated(context, "/bin/rm", ["-f", "--", path], {
          silent: true,
        });
      };

      const updateFstab = async (): Promise<
        | { readonly status: "present" | "absent" }
        | { readonly status: "failed"; readonly detail: string }
      > => {
        const result = await runCommand(
          "grep",
          [
            "-Eq",
            "^/mnt/swapfile[[:space:]]+none[[:space:]]+swap[[:space:]]",
            "/etc/fstab",
          ],
          { silent: true },
        );
        if (result.exitCode === 0) return { status: "present" };
        if (result.exitCode === 1) return { status: "absent" };
        return {
          status: "failed",
          detail: result.stderr.trim() || "unable to inspect /etc/fstab",
        };
      };

      const removeFstabEntry = async () =>
        await runElevated(
          context,
          "sed",
          [
            "-i",
            "\\|^/mnt/swapfile[[:space:]]\\+none[[:space:]]\\+swap[[:space:]]|d",
            "/etc/fstab",
          ],
          { silent: true },
        );

      const active = await runCommand(
        "swapon",
        ["--show=NAME", "--noheadings"],
        {
          silent: true,
        },
      );
      if (active.exitCode !== 0) {
        return {
          status: "failed",
          detail: active.stderr.trim() || "unable to inspect active swap",
        };
      }
      const isActive = active.stdout.split(/\s+/).includes("/mnt/swapfile");
      const existing = await runCommand(
        "/usr/bin/test",
        ["-e", "/mnt/swapfile"],
        { silent: true },
      );
      const fileState = existingFileState(existing.exitCode);
      if (fileState === "failed") {
        return {
          status: "failed",
          detail:
            existing.stderr.trim() || "unable to inspect existing swapfile",
        };
      }
      const hadExistingFile = fileState === "present";
      const fstabBefore = await updateFstab();
      if (fstabBefore.status === "failed") {
        return { status: "failed", detail: fstabBefore.detail };
      }

      if (requested === 0n) {
        let backup: string | undefined;
        if (hadExistingFile) {
          const temporary = await makeTemporaryFile("/mnt/swapfile.previous.");
          if (temporary.path === undefined) {
            return { status: "failed", detail: temporary.detail };
          }
          backup = temporary.path;
        }
        if (isActive) {
          const off = await runElevated(context, "swapoff", ["/mnt/swapfile"], {
            silent: true,
          });
          if (off.exitCode !== 0) {
            if (backup !== undefined) await removeTemporaryFile(backup);
            return { status: "failed", detail: off.stderr.trim() };
          }
        }
        if (backup !== undefined) {
          const backedUp = await runElevated(
            context,
            "mv",
            ["/mnt/swapfile", backup],
            { silent: true },
          );
          if (backedUp.exitCode !== 0) {
            await removeTemporaryFile(backup);
            if (isActive) {
              await runElevated(context, "swapon", ["/mnt/swapfile"], {
                silent: true,
              });
            }
            return {
              status: "failed",
              detail:
                backedUp.stderr.trim() || "unable to back up existing swap",
            };
          }
        }

        const fstabRemoved = await removeFstabEntry();
        if (fstabRemoved.exitCode !== 0) {
          const rollback: string[] = [];
          if (backup !== undefined) {
            const restored = await runElevated(
              context,
              "mv",
              [backup, "/mnt/swapfile"],
              { silent: true },
            );
            if (restored.exitCode !== 0) {
              rollback.push(`restore failed: ${restored.stderr.trim()}`);
            } else if (isActive) {
              const enabled = await runElevated(
                context,
                "swapon",
                ["/mnt/swapfile"],
                { silent: true },
              );
              if (enabled.exitCode !== 0) {
                rollback.push(`swapon failed: ${enabled.stderr.trim()}`);
              }
            }
          }
          return {
            status: "failed",
            detail: [
              fstabRemoved.stderr.trim() || "unable to update /etc/fstab",
              ...rollback,
            ].join("; "),
          };
        }

        if (backup !== undefined) {
          const removed = await runElevated(
            context,
            "/bin/rm",
            ["-f", "--", backup],
            { silent: true },
          );
          if (removed.exitCode !== 0) {
            return { status: "failed", detail: removed.stderr.trim() };
          }
        }
        return { status: "removed" };
      }

      const stat = await runCommand("df", ["--output=avail", "-B1", "/mnt"], {
        silent: true,
      });
      const rawAvailable = stat.stdout.trim().split(/\s+/).at(-1) ?? "";
      if (stat.exitCode !== 0 || !/^[0-9]+$/.test(rawAvailable)) {
        return {
          status: "failed",
          detail: stat.stderr.trim() || "unable to inspect /mnt free space",
        };
      }
      const available = BigInt(rawAvailable);
      if (requested > available - 512n * 1024n * 1024n) {
        return {
          status: "failed",
          detail:
            "requested swap exceeds safe /mnt free space; existing swap left unchanged",
        };
      }
      const temporary = await makeTemporaryFile("/mnt/swapfile.new.");
      if (temporary.path === undefined) {
        return { status: "failed", detail: temporary.detail };
      }
      const replacement = temporary.path;
      const allocate = await runElevated(
        context,
        "fallocate",
        ["-l", requested.toString(), replacement],
        { silent: true },
      );
      if (allocate.exitCode !== 0) {
        const mebibytes = (requested + 1024n ** 2n - 1n) / 1024n ** 2n;
        const fallback = await runElevated(
          context,
          "dd",
          [
            "if=/dev/zero",
            `of=${replacement}`,
            "bs=1M",
            `count=${mebibytes}`,
            "status=none",
          ],
          { silent: true, timeoutMs: 15 * 60_000 },
        );
        if (fallback.exitCode !== 0) {
          await runElevated(context, "/bin/rm", ["-f", replacement], {
            silent: true,
          });
          return {
            status: "failed",
            detail: fallback.stderr.trim() || allocate.stderr.trim(),
          };
        }
        const truncated = await runElevated(
          context,
          "truncate",
          ["-s", requested.toString(), replacement],
          { silent: true },
        );
        if (truncated.exitCode !== 0) {
          await runElevated(context, "/bin/rm", ["-f", replacement], {
            silent: true,
          });
          return { status: "failed", detail: truncated.stderr.trim() };
        }
      }
      const mode = await runElevated(context, "chmod", ["600", replacement], {
        silent: true,
      });
      if (mode.exitCode !== 0) {
        await runElevated(context, "/bin/rm", ["-f", replacement], {
          silent: true,
        });
        return { status: "failed", detail: mode.stderr.trim() };
      }
      const formatted = await runElevated(context, "mkswap", [replacement], {
        silent: true,
      });
      if (formatted.exitCode !== 0) {
        await runElevated(context, "/bin/rm", ["-f", replacement], {
          silent: true,
        });
        return { status: "failed", detail: formatted.stderr.trim() };
      }

      let backup: string | undefined;
      if (hadExistingFile) {
        const previous = await makeTemporaryFile("/mnt/swapfile.previous.");
        if (previous.path === undefined) {
          await removeTemporaryFile(replacement);
          return { status: "failed", detail: previous.detail };
        }
        backup = previous.path;
      }

      const rollbackReplacement = async (
        replacementIsActive: boolean,
        removeAddedFstabEntry: boolean,
      ): Promise<string> => {
        const details: string[] = [];
        if (replacementIsActive) {
          const disabled = await runElevated(
            context,
            "swapoff",
            ["/mnt/swapfile"],
            { silent: true },
          );
          if (disabled.exitCode !== 0) {
            return `rollback swapoff failed: ${disabled.stderr.trim()}`;
          }
        }

        const removed = await runElevated(
          context,
          "/bin/rm",
          ["-f", "--", "/mnt/swapfile", replacement],
          { silent: true },
        );
        if (removed.exitCode !== 0) {
          return `rollback cleanup failed: ${removed.stderr.trim()}`;
        }

        if (backup !== undefined) {
          const restored = await runElevated(
            context,
            "mv",
            [backup, "/mnt/swapfile"],
            { silent: true },
          );
          if (restored.exitCode !== 0) {
            details.push(`rollback move failed: ${restored.stderr.trim()}`);
          } else if (isActive) {
            const reenabled = await runElevated(
              context,
              "swapon",
              ["/mnt/swapfile"],
              { silent: true },
            );
            if (reenabled.exitCode !== 0) {
              details.push(
                `rollback swapon failed: ${reenabled.stderr.trim()}`,
              );
            }
          }
        }

        if (removeAddedFstabEntry) {
          const reverted = await removeFstabEntry();
          if (reverted.exitCode !== 0) {
            details.push(
              `fstab rollback failed: ${reverted.stderr.trim() || `sed exited ${reverted.exitCode}`}`,
            );
          }
        }
        return details.join("; ");
      };

      if (isActive) {
        const off = await runElevated(context, "swapoff", ["/mnt/swapfile"], {
          silent: true,
        });
        if (off.exitCode !== 0) {
          await removeTemporaryFile(replacement);
          if (backup !== undefined) await removeTemporaryFile(backup);
          return {
            status: "failed",
            detail: off.stderr.trim() || "unable to disable existing swap",
          };
        }
      }
      if (backup !== undefined) {
        const backedUp = await runElevated(
          context,
          "mv",
          ["/mnt/swapfile", backup],
          { silent: true },
        );
        if (backedUp.exitCode !== 0) {
          if (isActive) {
            await runElevated(context, "swapon", ["/mnt/swapfile"], {
              silent: true,
            });
          }
          await removeTemporaryFile(replacement);
          await removeTemporaryFile(backup);
          return {
            status: "failed",
            detail: backedUp.stderr.trim() || "unable to back up existing swap",
          };
        }
      }
      const moved = await runElevated(
        context,
        "mv",
        [replacement, "/mnt/swapfile"],
        { silent: true },
      );
      const enabled =
        moved.exitCode === 0
          ? await runElevated(context, "swapon", ["/mnt/swapfile"], {
              silent: true,
            })
          : moved;
      if (enabled.exitCode !== 0) {
        const rollbackDetail = await rollbackReplacement(false, false);
        return {
          status: "failed",
          detail: [
            enabled.stderr.trim() || "unable to enable replacement swap",
            rollbackDetail,
          ]
            .filter(Boolean)
            .join("; "),
        };
      }

      if (fstabBefore.status === "absent") {
        const appended = await runElevated(
          context,
          "/usr/bin/tee",
          ["-a", "/etc/fstab"],
          {
            silent: true,
            input: "/mnt/swapfile none swap sw 0 0\n",
          },
        );
        if (appended.exitCode !== 0) {
          const rollbackDetail = await rollbackReplacement(true, true);
          return {
            status: "failed",
            detail: [
              appended.stderr.trim() || "unable to update /etc/fstab",
              rollbackDetail,
            ]
              .filter(Boolean)
              .join("; "),
          };
        }
      }

      if (backup !== undefined) {
        const removed = await runElevated(
          context,
          "/bin/rm",
          ["-f", "--", backup],
          { silent: true },
        );
        if (removed.exitCode !== 0) {
          return {
            status: "failed",
            detail:
              removed.stderr.trim() || "unable to remove previous swap backup",
          };
        }
      }
      return { status: "removed" };
    },
  });
}

export async function createLinuxAdapter(
  context: RuntimeContext,
): Promise<Adapter> {
  const normalizedHome = posix.normalize(context.home);
  const trustedHome =
    normalizedHome === "/home/runner" ||
    (context.isUbuntuSlim &&
      (normalizedHome === "/root" || normalizedHome === "/github/home"));
  if (!trustedHome) {
    throw new Error(
      `Refusing unexpected Linux runner home '${context.home}'; no cleanup was scheduled.`,
    );
  }

  return {
    supportedComponents: SUPPORTED,
    operations: async (plan: CleanupPlan): Promise<readonly Operation[]> => {
      const operations: Operation[] = [];
      const add = (operation: Operation | undefined): void => {
        if (operation !== undefined) operations.push(operation);
      };
      const home = context.home;
      const cache = trustedToolCache(context.toolCache);
      let aptDirty = false;
      const androidRoot = exactDefinitionPath(
        process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME,
        "/usr/local/lib/android/sdk",
      );
      const condaRoot = exactDefinitionPath(
        process.env.CONDA,
        "/usr/share/miniconda",
      );
      const vcpkgRoot = exactDefinitionPath(
        process.env.VCPKG_INSTALLATION_ROOT,
        "/usr/local/share/vcpkg",
      );
      const seleniumRoot = exactDefinitionPath(
        process.env.SELENIUM_JAR_PATH,
        "/usr/share/java/selenium-server.jar",
      );

      operations.push(
        serviceStopOperation(
          context,
          "docker-engine",
          ["docker", "containerd"],
          {
            id: "docker:stop",
            description:
              "Stop Docker and containerd before removing their data",
          },
        ),
      );
      operations.push(
        serviceStopOperation(context, "postgresql", ["postgresql"]),
        serviceStopOperation(context, "mysql", ["mysql", "mariadb"]),
        serviceStopOperation(context, "apache", ["apache2"]),
        serviceStopOperation(context, "nginx", ["nginx"]),
      );

      const fixedPaths: readonly [
        component: ComponentId,
        target: string | undefined,
        parents: readonly string[],
        description: string,
        blockedBy?: readonly ComponentId[],
        coveredBy?: readonly ComponentId[],
      ][] = [
        ["dotnet", "/usr/share/dotnet", ["/usr/share"], "Remove .NET SDKs"],
        [
          "dotnet",
          "/usr/lib/dotnet",
          ["/usr/lib"],
          "Remove .NET runtime libraries",
        ],
        ["dotnet", "/etc/dotnet", ["/etc"], "Remove .NET configuration"],
        ["dotnet", join(home, ".dotnet"), [home], "Remove user .NET tools"],
        [
          "dotnet",
          "/etc/skel/.dotnet",
          ["/etc/skel"],
          "Remove seeded .NET user tools",
        ],
        [
          "android",
          androidRoot,
          ["/usr/local/lib/android"],
          "Remove Android SDK",
        ],
        [
          "android",
          join(home, ".android"),
          [home],
          "Remove Android user state",
        ],
        [
          "android",
          join(home, ".gradle"),
          [home],
          "Remove Android Gradle cache",
          ["gradle"],
        ],
        [
          "haskell",
          "/usr/local/.ghcup",
          ["/usr/local"],
          "Remove GHCup toolchains",
        ],
        [
          "haskell",
          join(home, ".ghcup"),
          [home],
          "Remove user GHCup toolchains",
        ],
        ["haskell", join(home, ".cabal"), [home], "Remove Cabal cache"],
        ["haskell", join(home, ".stack"), [home], "Remove Stack cache"],
        [
          "codeql",
          cache === undefined ? undefined : join(cache, "CodeQL"),
          cache === undefined ? [] : [cache],
          "Remove CodeQL bundles",
          [],
          ["cached-tools"],
        ],
        [
          "cached-tools",
          cache,
          cache === undefined ? [] : [dirname(cache)],
          "Remove hosted toolcache",
        ],
        [
          "cached-go",
          cache === undefined ? undefined : join(cache, "go"),
          cache === undefined ? [] : [cache],
          "Remove cached Go versions",
        ],
        [
          "cached-go",
          cache === undefined ? undefined : join(cache, "Go"),
          cache === undefined ? [] : [cache],
          "Remove cached Go versions",
        ],
        [
          "cached-node",
          cache === undefined ? undefined : join(cache, "node"),
          cache === undefined ? [] : [cache],
          "Remove cached Node.js versions",
        ],
        [
          "cached-node",
          cache === undefined ? undefined : join(cache, "Node"),
          cache === undefined ? [] : [cache],
          "Remove cached Node.js versions",
        ],
        [
          "cached-python",
          cache === undefined ? undefined : join(cache, "Python"),
          cache === undefined ? [] : [cache],
          "Remove cached Python versions",
        ],
        [
          "cached-python",
          cache === undefined ? undefined : join(cache, "python"),
          cache === undefined ? [] : [cache],
          "Remove cached Python versions",
        ],
        [
          "cached-pypy",
          cache === undefined ? undefined : join(cache, "PyPy"),
          cache === undefined ? [] : [cache],
          "Remove cached PyPy versions",
        ],
        [
          "cached-pypy",
          cache === undefined ? undefined : join(cache, "pypy"),
          cache === undefined ? [] : [cache],
          "Remove cached PyPy versions",
        ],
        [
          "cached-ruby",
          cache === undefined ? undefined : join(cache, "Ruby"),
          cache === undefined ? [] : [cache],
          "Remove cached Ruby versions",
        ],
        [
          "cached-ruby",
          cache === undefined ? undefined : join(cache, "ruby"),
          cache === undefined ? [] : [cache],
          "Remove cached Ruby versions",
        ],
        ["swift", "/usr/share/swift", ["/usr/share"], "Remove Swift toolchain"],
        [
          "swift",
          "/usr/local/share/swift",
          ["/usr/local/share"],
          "Remove local Swift toolchain",
        ],
        [
          "swift",
          "/usr/lib/swift",
          ["/usr/lib"],
          "Remove Swift runtime libraries",
        ],
        [
          "julia",
          "/usr/share/julia",
          ["/usr/share"],
          "Remove Julia shared data",
        ],
        ["java", "/usr/lib/jvm", ["/usr/lib"], "Remove Java installations"],
        [
          "java",
          "/usr/local/lib/jvm",
          ["/usr/local/lib"],
          "Remove local Java installations",
        ],
        ["miniconda", condaRoot, ["/usr/share"], "Remove Miniconda"],
        ["miniconda", join(home, ".conda"), [home], "Remove Conda user cache"],
        [
          "miniconda",
          join(home, ".cache", "conda"),
          [home],
          "Remove Conda download cache",
        ],
        [
          "homebrew",
          "/home/linuxbrew/.linuxbrew",
          ["/home/linuxbrew"],
          "Remove Linuxbrew installation",
        ],
        ["vcpkg", vcpkgRoot, ["/usr/local/share"], "Remove vcpkg"],
        ["vcpkg", join(home, ".cache", "vcpkg"), [home], "Remove vcpkg cache"],
        ["vcpkg", join(home, ".vcpkg"), [home], "Remove vcpkg user state"],
        [
          "rust",
          "/usr/local/cargo",
          ["/usr/local"],
          "Remove system Cargo home",
        ],
        [
          "rust",
          "/usr/local/rustup",
          ["/usr/local"],
          "Remove system Rustup home",
        ],
        ["rust", "/etc/skel/.cargo", ["/etc/skel"], "Remove seeded Cargo home"],
        [
          "rust",
          "/etc/skel/.rustup",
          ["/etc/skel"],
          "Remove seeded Rustup toolchains",
        ],
        ["rust", join(home, ".cargo"), [home], "Remove Cargo home"],
        ["rust", join(home, ".rustup"), [home], "Remove Rustup home"],
        [
          "selenium",
          seleniumRoot,
          ["/usr/share/java"],
          "Remove Selenium server",
        ],
        [
          "powershell",
          "/opt/microsoft/powershell/7",
          ["/opt/microsoft/powershell"],
          "Remove PowerShell archive installation",
        ],
        [
          "browsers",
          "/opt/google/chrome",
          ["/opt/google"],
          "Remove Google Chrome",
        ],
        [
          "browsers",
          "/opt/microsoft/msedge",
          ["/opt/microsoft"],
          "Remove Microsoft Edge",
        ],
        ["browsers", "/usr/lib/chromium", ["/usr/lib"], "Remove Chromium"],
        [
          "browsers",
          "/usr/local/share/chromium",
          ["/usr/local/share"],
          "Remove runner-image Chromium",
        ],
        ["browsers", "/usr/lib/firefox", ["/usr/lib"], "Remove Firefox"],
        [
          "browsers",
          "/usr/local/share/chromedriver-linux64",
          ["/usr/local/share"],
          "Remove ChromeDriver",
        ],
        [
          "browsers",
          "/usr/local/share/edge_driver",
          ["/usr/local/share"],
          "Remove Edge WebDriver",
        ],
        [
          "browsers",
          "/usr/local/share/gecko_driver",
          ["/usr/local/share"],
          "Remove GeckoDriver",
        ],
        [
          "browsers",
          "/usr/share/java/selenium-server.jar",
          ["/usr/share/java"],
          "Remove Selenium server",
        ],
        [
          "chrome",
          "/opt/google/chrome",
          ["/opt/google"],
          "Remove Google Chrome",
        ],
        ["chromium", "/usr/lib/chromium", ["/usr/lib"], "Remove Chromium"],
        [
          "chromium",
          "/usr/local/share/chromium",
          ["/usr/local/share"],
          "Remove runner-image Chromium",
        ],
        [
          "edge",
          "/opt/microsoft/msedge",
          ["/opt/microsoft"],
          "Remove Microsoft Edge",
        ],
        ["firefox", "/usr/lib/firefox", ["/usr/lib"], "Remove Firefox"],
        [
          "webdrivers",
          "/usr/local/share/chromedriver-linux64",
          ["/usr/local/share"],
          "Remove ChromeDriver",
        ],
        [
          "webdrivers",
          "/usr/local/share/edge_driver",
          ["/usr/local/share"],
          "Remove Edge WebDriver",
        ],
        [
          "webdrivers",
          "/usr/local/share/gecko_driver",
          ["/usr/local/share"],
          "Remove GeckoDriver",
        ],
        ["aws-cli", "/usr/local/aws-cli", ["/usr/local"], "Remove AWS CLI"],
        [
          "aws-cli",
          "/usr/local/sessionmanagerplugin",
          ["/usr/local"],
          "Remove AWS Session Manager plugin",
        ],
        [
          "aws-sam-cli",
          "/usr/local/aws-sam-cli",
          ["/usr/local"],
          "Remove AWS SAM CLI",
        ],
        ["azure-cli", "/opt/az", ["/opt"], "Remove Azure CLI archive install"],
        [
          "gcloud-cli",
          "/usr/lib/google-cloud-sdk",
          ["/usr/lib"],
          "Remove Google Cloud SDK",
        ],
        [
          "gcloud-cli",
          "/opt/google-cloud-sdk",
          ["/opt"],
          "Remove Google Cloud SDK archive install",
        ],
        [
          "gcloud-cli",
          "/opt/google-cloud-cli",
          ["/opt"],
          "Remove Google Cloud CLI archive install",
        ],
        [
          "maven",
          "/usr/share/maven",
          ["/usr/share"],
          "Remove Maven shared installation",
        ],
        [
          "gradle",
          "/usr/share/gradle",
          ["/usr/share"],
          "Remove Gradle shared installation",
        ],
        [
          "ant",
          "/usr/share/ant",
          ["/usr/share"],
          "Remove Ant shared installation",
        ],
        ["php", "/etc/php", ["/etc"], "Remove PHP configuration"],
        [
          "php",
          "/usr/share/php",
          ["/usr/share"],
          "Remove PHP shared libraries",
        ],
        [
          "postgresql",
          "/var/lib/postgresql",
          ["/var/lib"],
          "Remove PostgreSQL data",
        ],
        [
          "postgresql",
          "/etc/postgresql",
          ["/etc"],
          "Remove PostgreSQL configuration",
        ],
        [
          "postgresql",
          "/usr/lib/postgresql",
          ["/usr/lib"],
          "Remove PostgreSQL libraries",
        ],
        ["mysql", "/var/lib/mysql", ["/var/lib"], "Remove MySQL data"],
        ["mysql", "/etc/mysql", ["/etc"], "Remove MySQL configuration"],
        ["apache", "/etc/apache2", ["/etc"], "Remove Apache configuration"],
        [
          "apache",
          "/var/www",
          ["/var"],
          "Remove Apache document root",
          ["nginx"],
        ],
        ["nginx", "/etc/nginx", ["/etc"], "Remove Nginx configuration"],
        [
          "podman",
          "/var/lib/containers",
          ["/var/lib"],
          "Remove Podman storage",
          ["buildah"],
        ],
        [
          "docker-engine",
          "/var/lib/docker",
          ["/var/lib"],
          "Remove Docker data",
          ["docker-images"],
        ],
        [
          "docker-engine",
          "/var/lib/containerd",
          ["/var/lib"],
          "Remove containerd data",
          ["docker-images"],
        ],
        [
          "docker-engine",
          "/etc/docker",
          ["/etc"],
          "Remove Docker configuration",
        ],
        [
          "docker-engine",
          "/usr/lib/docker",
          ["/usr/lib"],
          "Remove Docker libraries",
        ],
        [
          "docker-engine",
          "/usr/libexec/docker",
          ["/usr/libexec"],
          "Remove Docker helpers",
        ],
        [
          "docker-engine",
          "/usr/local/lib/docker",
          ["/usr/local/lib"],
          "Remove local Docker libraries",
        ],
      ];
      for (const [
        component,
        target,
        parents,
        description,
        blockedBy,
        coveredBy,
      ] of fixedPaths) {
        add(
          removeOperation(
            context,
            component,
            target,
            parents,
            description,
            blockedBy,
            coveredBy,
          ),
        );
      }

      if (cache !== undefined) {
        for (const component of [
          "dotnet",
          "haskell",
          "swift",
          "julia",
          "java",
        ] as const) {
          const names: Record<typeof component, readonly string[]> = {
            dotnet: ["dotnet"],
            haskell: ["ghc", "GHC"],
            swift: ["swift", "Swift"],
            julia: ["Julia", "julia"],
            java: ["Java_Temurin-Hotspot_jdk"],
          };
          for (const name of names[component]) {
            add(
              removeOperation(
                context,
                component,
                join(cache, name),
                [cache],
                `Remove ${component} toolcache entries`,
                [],
                ["cached-tools"],
              ),
            );
          }
        }
      }

      for (const path of await versionedChildren(
        "/usr/local",
        /^julia\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "julia",
            path,
            ["/usr/local"],
            "Remove Julia installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/local",
        /^apache-maven-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "maven",
            path,
            ["/usr/local"],
            "Remove Maven installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/local",
        /^gradle-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "gradle",
            path,
            ["/usr/local"],
            "Remove Gradle installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/share",
        /^apache-maven-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "maven",
            path,
            ["/usr/share"],
            "Remove versioned Maven installation",
          ),
        );
      }
      for (const path of await versionedChildren(
        "/usr/share",
        /^gradle-\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/,
      )) {
        add(
          removeOperation(
            context,
            "gradle",
            path,
            ["/usr/share"],
            "Remove versioned Gradle installation",
          ),
        );
      }

      const driverTargets: readonly [ComponentId, string, string][] = [
        [
          "webdrivers",
          exactDefinitionPath(
            process.env.CHROMEWEBDRIVER,
            "/usr/local/share/chromedriver-linux64",
          ),
          "Remove ChromeDriver",
        ],
        [
          "webdrivers",
          exactDefinitionPath(
            process.env.EDGEWEBDRIVER,
            "/usr/local/share/edge_driver",
          ),
          "Remove Edge WebDriver",
        ],
        [
          "webdrivers",
          exactDefinitionPath(
            process.env.GECKOWEBDRIVER,
            "/usr/local/share/gecko_driver",
          ),
          "Remove GeckoDriver",
        ],
      ];
      for (const [component, target, description] of driverTargets) {
        add(
          removeOperation(
            context,
            component,
            target,
            ["/usr/local/share"],
            description,
          ),
        );
      }

      operations.push(
        aptBatchOperation(context, plan, () => {
          aptDirty = true;
        }),
      );
      operations.push(aptFinalizeOperation(context, () => aptDirty));

      const commands: Readonly<
        Partial<Record<ComponentId, readonly string[]>>
      > = {
        dotnet: ["dotnet"],
        haskell: ["ghc", "ghcup", "cabal", "stack"],
        swift: ["swift", "swiftc", "sourcekit-lsp"],
        julia: ["julia"],
        browsers: [
          "google-chrome",
          "google-chrome-stable",
          "chromium",
          "chromium-browser",
          "microsoft-edge",
          "microsoft-edge-stable",
          "firefox",
          "chromedriver",
          "msedgedriver",
          "geckodriver",
        ],
        chrome: ["google-chrome", "google-chrome-stable"],
        chromium: ["chromium", "chromium-browser"],
        edge: ["microsoft-edge", "microsoft-edge-stable"],
        firefox: ["firefox"],
        webdrivers: ["chromedriver", "msedgedriver", "geckodriver"],
        powershell: ["pwsh"],
        miniconda: ["conda"],
        vcpkg: ["vcpkg"],
        "aws-cli": ["aws", "session-manager-plugin"],
        "aws-sam-cli": ["sam"],
        "azure-cli": ["az"],
        "gh-cli": ["gh"],
        "gcloud-cli": ["gcloud", "gsutil", "bq"],
        azcopy: ["azcopy", "azcopy10"],
        kubectl: ["kubectl"],
        helm: ["helm"],
        kind: ["kind"],
        minikube: ["minikube"],
        kustomize: ["kustomize"],
        "docker-engine": [
          "docker",
          "docker-compose",
          "docker-buildx",
          "docker-credential-ecr-login",
        ],
        buildah: ["buildah"],
        podman: ["podman"],
        maven: ["mvn"],
        gradle: ["gradle"],
        ant: ["ant"],
        php: ["php", "composer", "phpunit"],
        rust: [
          "rustc",
          "cargo",
          "rustup",
          "rustdoc",
          "rustfmt",
          "cargo-clippy",
          "clippy-driver",
        ],
        postgresql: ["psql", "pg_config"],
        mysql: ["mysql", "mysqld", "mariadb"],
        apache: ["apache2"],
        nginx: ["nginx"],
      };
      const commandOperations: Promise<Operation>[] = [];
      for (const [component, names] of Object.entries(commands) as [
        ComponentId,
        readonly string[],
      ][]) {
        // Do not inspect or validate unrelated PATH entries. Besides making
        // custom cleanup cheaper, this prevents a protected runtime-owned
        // executable for a disabled component from blocking the active plan.
        if (!plan.enabled.has(component)) continue;
        for (const name of names) {
          commandOperations.push(commandRemoval(context, component, name));
        }
      }
      operations.push(...(await Promise.all(commandOperations)));

      operations.push(dockerPruneOperation(context));
      add(recreateToolCacheOperation(context, cache));
      if (plan.swapfileBytes !== undefined) {
        operations.push(swapOperation(context, plan.swapfileBytes));
      }
      return operations;
    },
  };
}
