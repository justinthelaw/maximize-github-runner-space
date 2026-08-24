# Runner support

This action supports ephemeral standard GitHub-hosted runners. It does not
support self-hosted runners, larger runners, or arbitrary job containers. A
larger runner can look like a standard runner at runtime, so the action cannot
always reject it.

## Supported runner families

| Environment class           | Support                | Important behavior                                                                                                         |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu x64 VM               | Full                   | Existing no-input `max`, component names, skips, and optional swap inputs remain supported; review migration notes.        |
| Ubuntu arm64 VM             | Full, capability-aware | Architecture-specific omissions are successful no-ops.                                                                     |
| `ubuntu-slim` x64 container | Limited                | Uses only available permissions and tools; swap, mounts, low-level kernel work, and Docker-daemon cleanup are unsupported. |
| Windows x64 VM              | Full                   | Uses Windows-native package, service, path, and process handling.                                                          |
| Windows arm64 VM            | Full, capability-aware | Components absent from the image are not errors.                                                                           |
| macOS Intel VM              | Full                   | Uses the Intel Homebrew layout and preserves the selected Xcode.                                                           |
| macOS arm64 VM              | Full, capability-aware | Uses the Apple Silicon Homebrew layout and preserves the selected Xcode.                                                   |

"Full" means the runner family is supported; it does not mean every component
is installed on every label. A safely confirmed-absent target reports
`not-found` or `unsupported`. A missing required utility or incomplete
inventory fails closed.

The pull-request, weekly, and manual compatibility sweep exercises these exact
labels:

<!-- compatibility-labels:start -->

- Linux: `ubuntu-slim`, `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04`,
  `ubuntu-22.04-arm`, `ubuntu-24.04-arm`, `ubuntu-26.04-arm`.
- Windows: `windows-2022`, `windows-2025`, `windows-2025-vs2026`,
  `windows-11-arm`, `windows-11-vs2026-arm`.
- macOS: `macos-14`, `macos-15`, `macos-26`, `xcode-27`,
  `macos-15-intel`, `macos-26-intel`.

<!-- compatibility-labels:end -->

GitHub's [standard public-runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) and [standard private-runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-private-repositories) tables are the authoritative current source for hosted-runner labels and resources. GitHub's `-latest` labels are moving aliases. Pin an explicit runner label when you need to control the operating-system image family, while recognizing that the installed image version can still change.

## Runtime image validation

The action ignores workflow-overridable image claims such as `ImageOS` and
`ImageVersion`. It reads the fixed runner-image record instead:

- Ubuntu: `/imagegeneration/imagedata.json`
- macOS: `/Users/runner/imagedata.json`
- Windows: `C:\imagedata.json`

For a VM, the record must contain one supported identity. Its label, version,
source, manifest, operating system, and architecture must agree. Missing,
linked, oversized, duplicate, malformed, or mismatched records fail before
cleanup. `RUNNER_OS` and `RUNNER_ARCH` must also agree with the operating system
and architecture of the action process. Container mode accepts only the
runner-images `ubuntu:24.04` identity used by `ubuntu-slim`.

This proves image compatibility, not runner authenticity or size. Run cleanup
before checkout when possible. If checkout must run first, pin it, disable
credential persistence, and do not execute repository code before cleanup.
The action separately requires the standard runner `HOME`; overriding it makes
the action fail closed because user-cache paths would not be trustworthy.

## Platform constraints and destructive caveats

[`ubuntu-slim`](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners) is an unprivileged, minimal container with a 15-minute job timeout. Its missing inventory and Docker daemon are normal conditions; the action never creates swap or mounts there.

On Windows, `max` can remove PowerShell 7, the default shell for later workflow `run` steps. Protect `powershell`, use `custom`, or choose a remaining shell explicitly. Windows SDK cleanup handles both definition-listed Visual Studio components and registered standalone SDK/WDK bundles through their verified installers. Windows base-image Microsoft Edge is preserved; a directly selected `edge` operation reports unsupported, while broad browser cleanup has no separate Edge result. Its separately installed WebDriver can be removed.

On macOS, Xcode cleanup removes unselected versioned Xcode applications while preserving the Xcode selected by `xcode-select`; it checks the selected and removable bundle identities before and after each removal. Homebrew cleanup verifies the architecture-specific executable, uses an empty root-owned read-only configuration directory, and does not recursively delete either Homebrew prefix or unknown packages installed by earlier workflow steps. A narrow component uninstalls only its exact package and does not run global Homebrew cleanup.

On Linux, Linuxbrew cleanup never runs `brew`. It removes only the exact
`~/.cache/Homebrew` cache, while preserving the Linuxbrew
prefix and every installed package. `swapfile-size` works only on a privileged
VM. Container, macOS, and Windows requests fail before cleanup and leave
existing swap unchanged. Apt finalization clears downloaded package archives
but does not globally autoremove dependencies. See the
[configuration reference](CONFIGURATION.md#swapfile-size) for accepted values.

Docker image cleanup uses a fixed local-daemon endpoint and isolated client configuration. `docker system prune --volumes` removes unused anonymous volumes, not named volumes. Docker Engine cleanup is broader because it removes the runner's Docker data root; skip both `docker-engine` and `docker-images` when any existing Docker state must survive.

## Safety and result semantics

The action validates the complete plan before mutation. It rejects unsafe paths,
uses fixed executable paths and restricted environments, isolates Docker and
macOS Homebrew configuration, bounds native inventories, and checks destructive
postconditions. Executables validated early are content-identity-checked again
before use.

| Result                                                                             | What happens                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Invalid input, unsupported identity, unsafe plan, or incomplete required inventory | Fails before cleanup.                                                                      |
| Any cleanup failure                                                                | Stops later operations and fails. Preflight-only failures roll back safe reversible state. |
| Safely confirmed-absent target on a supported image                                | Reports `not-found` or `unsupported`.                                                      |

Timeout handling attempts native process-tree termination, then stops because
an escaped child cannot be ruled out. It does not start rollback commands after
an unconfirmed termination; a service already stopped by that command can stay
stopped until the ephemeral runner is discarded. Swap changes verify kernel
state and use exact, atomically committed `fstab` content. On uncertain
recovery, the action keeps any active swap and every backing file needed by a
possible live entry.

Once payload cleanup starts, stopped services remain stopped on failure. This
avoids restarting a service from a partly removed installation. State-neutral
housekeeping, such as deleting the action's private configuration directory,
can still roll back safely.

Unix recursive deletion uses no-follow directory handles so an ancestor swap
cannot redirect traversal. It blocks device changes on Linux and macOS, plus
same-device bind mounts on Linux. Windows recursive deletion locks the
validated ancestors and target, removes each entry by native handle, and
deletes reparse points without following them. Other concurrent changes can
still invalidate package, service, installer, and swap transactions; those
checks stop when detected. The action also trusts hosted-image package hooks,
transitive installer code, vendor uninstallers, and children intentionally
left running by a successful vendor launcher. It is not a sandbox or signed
attestation.

## Image drift and CI coverage

Runner images change independently of action releases. Use a full action commit SHA for immutable execution; `v0.12.2` is the latest published release tag and can predate behavior documented on `main`. Pinning an explicit runner label reduces surprises from `-latest`, but does not freeze GitHub's regularly refreshed image inventory. Track the official runner-images [latest-image migration process](https://github.com/actions/runner-images#latest-migration-process), [support policy](https://github.com/actions/runner-images#support-policy), and [available images](https://github.com/actions/runner-images#available-images). Treat an absent component as a normal image variation and re-measure reclaimed space after image changes.

Pull requests run deterministic quality checks, Ubuntu swap/skip coverage,
representative destructive smoke tests, and the exact-label compatibility sweep
above. Ubuntu smoke creates disposable Docker container, image, network, and
volume fixtures, verifies that pruning removes only the disposable state, keeps
a named volume, and leaves no client-config directory. The Ubuntu quality job
also creates a same-device bind mount and requires both Unix deletion helpers
to reject it. Windows x64 and arm64
jobs directly exercise locked-handle deletion with a path longer than 320
characters and a junction that points outside the target. Windows smoke also
verifies a registered GitHub CLI MSI uninstall; macOS smoke verifies a fixed
Homebrew package uninstall. Each platform smoke records its image-provided
runtimes before cleanup, then checks Bash, `/bin/sh`, Node.js, and optional
Python and Perl on Unix, or PowerShell, `cmd.exe`, Node.js, and optional Python
on Windows. Platform smokes install no test dependency. The Ubuntu `max` job
requires positive measured reclamation and then re-executes `/bin/bash`,
`/bin/sh`, and optional OS Python and Perl. Cached Node is intentionally
removable by `max`, so Node is checked in the bounded platform smoke instead.
The same exact-label sweep also runs
weekly and on demand. Fast tests cover the full component registry without
running every component against every image.
