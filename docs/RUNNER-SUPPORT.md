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
is installed on every label. `not-found` means a target was safely confirmed
absent. `unsupported` means the recognized runner cannot safely perform that
operation, so its target can remain. A missing required utility or incomplete
inventory fails closed.

The pull-request, merge-queue, weekly, and manual compatibility sweep exercises
these exact labels:

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

Windows service cleanup binds each selected registration to its exact
runner-image executable and configuration. It disables each service before it
stops it, then checks the disabled, stopped state before service-owned payload
operations. This blocks normal service recovery during cleanup. Before payload
cleanup, rollback restores the original start modes and restarts only services
that were running. Once payload cleanup starts, services stay disabled and
stopped until their verified registrations are removed.

Docker is rechecked before each payload target. Apache, Nginx, and PostgreSQL
registrations are finalized after package cleanup. A new name, changed
configuration, recreated registration, or reactivation stops the action. Each
transition has a 30-second deadline. Service coordination and Windows command
inventories use two-minute aggregate budgets. PostgreSQL discovery accepts at
most 16 matching services. Locked descendant checks run after reversible
service stops and before payload cleanup.

On macOS, Xcode cleanup removes unselected versioned Xcode applications while
preserving the Xcode selected by `xcode-select`. It checks the selected and
removable bundle identities before and after each removal. Homebrew cleanup
verifies the architecture-specific executable, uses an empty root-owned
read-only configuration directory, and does not recursively delete either
Homebrew prefix or unknown packages installed by earlier workflow steps. A
narrow component uninstalls only its exact package and does not run global
Homebrew cleanup.

On Linux, Linuxbrew cleanup never runs `brew`. It removes only the exact
`~/.cache/Homebrew` cache, while preserving the Linuxbrew
prefix and every installed package. `swapfile-size` works only on a privileged
VM. Container, macOS, and Windows requests fail before cleanup and leave
existing swap unchanged. Apt finalization clears downloaded package archives
but does not globally autoremove dependencies. It rejects a selection above
512 packages before elevation. Selected systemd units are stopped and
runtime-masked before payload cleanup. If preflight fails, the action removes
its masks and restarts only units that were originally active. Systemd
inventory, coordination, and rollback each use a two-minute aggregate budget.
See the [configuration reference](CONFIGURATION.md#swapfile-size) for accepted
values.

Supported Unix images must provide `/usr/bin/python3`. Each elevated Unix
executable is resolved to a root-owned regular file below root-owned,
non-writable parents, and that canonical path is launched. For privileged
recursive deletion, Linux uses the verified OS Python helper if the running
Node binary is not trusted for elevation. Cleanup preserves this OS runtime. A
separate cached Python toolcache can still be removed.

Docker image cleanup uses a fixed local-daemon endpoint and isolated client
configuration. `docker system prune --volumes` removes unused anonymous
volumes, not named volumes. This retention applies only to pruning. Docker
Engine cleanup in `custom` removes the whole runner data root, including named
volumes. In `max`, skipping `docker-images` keeps that root, but not the engine;
skip both components to keep usable Docker state. When Engine removal owns the
data root, the separate prune is skipped.

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
| Safely confirmed-absent target on a supported image                                | Reports `not-found`.                                                                       |
| Explicitly unavailable capability on a recognized image                            | Reports `unsupported`; the target can remain.                                              |

Timeout handling attempts native process-tree termination, then stops because
an escaped child cannot be ruled out. It does not start rollback commands after
an unconfirmed termination; a service already stopped by that command can stay
stopped until the ephemeral runner is discarded. Swap changes verify kernel
state and use exact, atomically committed `fstab` content. After an ambiguous
exchange, it never exchanges again: a concurrent writer stays live and the
original remains at the reported recovery path. The action also keeps any
active swap and every backing file needed by a possible live entry.

Once payload cleanup starts, stopped services remain stopped on failure. This
avoids restarting a service from a partly removed installation. Linux runtime
masks also remain after payload cleanup starts. State-neutral housekeeping,
such as deleting the action's private configuration directory, can still roll
back safely.

Unix recursive deletion uses no-follow directory handles so an ancestor swap
cannot redirect traversal. It rechecks each opened directory against its held
parent before destructive steps. A detected move fails the operation; entries
already removed cannot be restored. It blocks device changes
on Linux and macOS, plus same-device bind mounts on Linux. Windows recursive
deletion rejects reparse-point ancestors, opens every descendant with delete
access during preflight, removes each entry by native handle, and deletes
reparse points without following them. The fixed System32 Windows
PowerShell launcher is identity-checked immediately before launch; its helper
then locks and rechecks the Node validator. OS-protected executables and a
root-owned Unix OS Python are trusted boundaries. Each recursive traversal has
limits of 2,000,000 entries, depth 256, and 10 minutes of traversal work.
Version discovery inspects at most 256 directory entries for 10 seconds and
accepts at most 64 matching versions on Linux and Windows. Do not let another
process write to, rename, or remount selected trees or their writable parents
during cleanup. Those changes are outside the threat model. Concurrent
privileged changes to protected files, mounts, Windows service registrations,
or `xcode-select` are also outside it. The action also trusts hosted-image
package hooks, transitive installer code, vendor uninstallers, and children
intentionally left running by a successful vendor launcher. It is not a
sandbox or signed attestation.

## Image drift and CI coverage

Runner images change independently of action releases. Use a full action commit SHA for immutable execution; `v0.12.2` is the latest published release tag and can predate behavior documented on `main`. Pinning an explicit runner label reduces surprises from `-latest`, but does not freeze GitHub's regularly refreshed image inventory. Track the official runner-images [latest-image migration process](https://github.com/actions/runner-images#latest-migration-process), [support policy](https://github.com/actions/runner-images#support-policy), and [available images](https://github.com/actions/runner-images#available-images). Treat an absent component as a normal image variation and re-measure reclaimed space after image changes.

Pull requests run deterministic quality checks, Ubuntu swap/skip coverage,
representative destructive smoke tests, and the exact-label compatibility sweep
above. Ubuntu smoke creates disposable Docker container, image, network, and
volume fixtures, verifies that pruning removes only the disposable state, keeps
a named volume, and leaves no client-config directory. The Ubuntu quality job
also creates a same-device bind mount and requires each Unix deletion path to
reject it. Windows x64 and arm64 jobs directly exercise validation and
locked-handle deletion with a path longer than 320 characters, a nested
junction, a final junction, and a redirected ancestor. macOS Intel and arm64
jobs directly exercise no-follow directory-handle deletion. Windows smoke also
verifies a registered GitHub CLI MSI uninstall; macOS smoke verifies a fixed
Homebrew package uninstall. The dependency-free runtime smoke installs
nothing. Local checks run Node.js, Bash, POSIX `sh`, and available OS Python,
Perl, and `awk`. Hosted Unix checks record those exact runtime paths before
cleanup and run them again afterward. Windows checks PowerShell, `cmd.exe`,
Node.js, and Python when available. Present but broken Python runtimes fail the
test. The Ubuntu `max` job also requires OS Python and positive reclamation.
Cached Node is removable by `max`, so the bounded smoke checks Node separately.
The same exact-label sweep also runs for merge-queue
candidates, weekly, and on demand. Fast tests cover the full component registry without
running every component against every image. A separate weekly and manual deep
smoke runs the default `max` profile on representative Windows x64 and macOS
arm64 images. It verifies positive reclamation, preserved OS runtimes, and the
selected Xcode without adding that long destructive run to pull requests.
