# Migrations

Use these notes when moving between action releases. See the [configuration reference](CONFIGURATION.md) for the current input catalog.

## Unreleased hardening after v0.12.2

The next release changes failure handling and several cleanup boundaries:

Before upgrading:

- Start with `custom`; enable only components the job does not need.
- If a later step needs Docker, keep `docker-engine`. In `max`, also keep
  `docker-images` to preserve existing Docker data. In `custom`, selecting
  Engine cleanup deletes the whole runner Docker data root.
- On Windows, keep `powershell`, `windows-sdk`, or `visual-studio` when later
  steps need them. Installer restart codes now fail the cleanup step.
- Run cleanup before checkout and test the exact commit SHA on every runner
  family your workflow uses.

Key changes:

- Incomplete or changed package, service, and installer inventories fail closed.
- Any cleanup failure now fails the step and stops later cleanup. A
  preflight-only failure restarts safely stopped services. Once payload cleanup
  starts, services stay stopped to avoid restarting a partly removed install.
- Destructive executables are content-identity-checked again before use.
- Supported uninstallers must pass a bounded removal postcondition.
- Every command timeout or aggregate filesystem deadline stops all later cleanup.
- If timeout handling cannot confirm the process tree ended, no rollback
  command is started; a service already stopped can remain stopped until the
  ephemeral runner is discarded.
- Filesystem removals run serially, so no second deletion is already in flight
  when a timeout stops the action.
- Unix recursive deletion is anchored to validated no-follow directory handles.
  It blocks device changes on Linux and macOS, plus same-device bind mounts on
  Linux.
  Windows recursive deletion locks the validated path and removes entries by
  native handle, including reparse points.
- Each recursive traversal is capped at 2,000,000 entries, depth 256, and 10
  minutes of traversal work.
  Versioned-directory discovery inspects at most 256 entries for 10 seconds.
- Recreated broad hosted-toolcache directories must be writable.

Windows changes:

- `windows-sdk` also removes registered standalone SDK/WDK bundles. Preserve
  that component when a later step needs either standalone or Visual Studio
  SDK payloads.
- Installer exit `3010` or `1641` stops all later cleanup. The action never
  continues after an installer requests or starts a restart.
- Executable uninstallers verify their exact residual installation root.
- Selected Chocolatey cleanup fails preflight when its fixed executable or
  inventory cannot be verified.
- Windows `mysql` uninstalls the runner-image CLI MSI; unlike Linux cleanup, it
  does not claim a MySQL server data root.
- PowerShell and Maven cleanup preserve the shared all-users module store and
  `C:\ProgramData\m2` cache.
- .NET, Android, Miniconda, and vcpkg cleanup now remove their exact
  runner-user tool, state, and cache roots under `C:\Users\runneradmin`.
- Windows Docker cleanup removes non-service payloads first, unregisters and
  verifies the exact stopped service, then removes its service executable.
- Selected Windows services are disabled before they are stopped. Pre-payload
  rollback restores original start modes before restarting services that were
  running. Later service-owned operations recheck the disabled, stopped state.
- Apache, Nginx, and PostgreSQL service registrations may disappear through
  their verified uninstallers. Cleanup accepts absence, finalizes it, and
  rejects any later recreation.
- Locked descendant checks run after reversible service stops and before any
  package or filesystem payload is removed.
- Selected toolcache cleanup requires the standard
  `C:\hostedtoolcache\windows` runner context.
- Visual Studio and SDK checks keep using the same verified `vswhere.exe`.

macOS changes:

- `homebrew` cleanup covers the package union in the current official macOS
  14, 15, and 26 runner-image toolsets while preserving unknown packages.
- Homebrew commands use an empty root-owned, read-only configuration directory
  created atomically for the action. Cleanup stops at the first failed package
  batch or removal check.
- Homebrew package matching includes the current `openssl@3` formula name.
- Android cleanup also removes `/Users/runner/.android`.
- Xcode cleanup checks the selected Xcode before and after every bundle
  removal. A selection change fails the action.

Linux and Docker changes:

- Apt cleanup no longer runs global `autoremove`. It removes selected packages
  and clears downloaded archives, which may reclaim less space. A selection
  above 512 packages now fails before elevation.
- Linuxbrew cleanup no longer runs `brew` or removes installed packages. It
  removes only the exact `~/.cache/Homebrew` cache and preserves the prefix.
- Android cleanup preserves the general `~/.gradle` cache.
- Apache cleanup preserves the shared `/var/www` document root.
- Shared Podman/Buildah storage is removed only when both components are
  selected.
- Selected systemd units are stopped and runtime-masked before payload cleanup.
  Pre-payload rollback removes the masks and restores originally active units.
- Docker image pruning removes anonymous volumes but keeps named volumes.
- Docker Engine removal still deletes the runner Docker data root.
- If Engine and image cleanup are both selected, Engine removal covers the data
  root and the separate prune is skipped.

Swap changes:

- Kernel state is checked after every `swapon` and `swapoff` attempt.
- `/mnt` and `/etc` must have stable, trusted, non-writable ownership. Every
  private mode-`0600` staging file is identity-checked before mutation.
- The atomic `fstab` helper rechecks the pinned `/etc` identity and mount ID at
  the final commit point.
- Exact `fstab` content is staged and atomically exchanged with the live file
  for both additions and removals.
- The new live file and displaced original are verified after the exchange,
  including content, identity, mode, and owner. Unrelated concurrent changes
  are preserved and stop the transaction.
- Swapfile backup, installation, and restoration moves are accepted only when
  the destination has the exact captured file identity. Ambiguous `fstab`
  commits are classified by exact file identity and content.
- Private swap and `fstab` cleanup quarantines the captured inode before
  unlinking it. Under the protected-parent boundary, a replacement detected at
  that commit point is retained and fails safely.
- Failed commits restore and verify the captured original before backing files
  are removed. If recovery cannot be proven, needed files are retained and the
  action stops.

`v0.12.2` does not acquire these changes retroactively. Until a follow-up
release is published, an intentionally reviewed full commit SHA is the only
immutable reference to the unreleased behavior.

## v0.11.x to v0.12.0

`v0.12.0` introduced cross-platform support and the three OS-specific inputs: `remove-xcode`, `remove-visual-studio`, and `remove-windows-sdk`.

Existing Ubuntu workflows remain compatible: historical inputs retain their names, defaults, and optional status; no `with:` block still selects `max`; `custom` still requires exact `"true"` values; and omitted `swapfile-size` leaves swap unchanged.

For a new macOS or Windows workflow, start with `cleanup-profile: custom` and enable only measured disposable components. Under `max`, macOS can remove unselected Xcodes and Windows can remove eligible Visual Studio/SDK payloads and PowerShell 7. Use `skip-components` to protect each toolchain and shell needed by later steps.

Linux Homebrew cleanup is more conservative: it preserves the prefix and all
installed packages, and removes only `~/.cache/Homebrew`. If a workflow depended
on deleting Linuxbrew packages, expect less reclaimed space.

The action now rejects self-hosted runners, arbitrary job containers, and unrecognized runner-image identities before cleanup. Review the supported environment before upgrading: [runner support](RUNNER-SUPPORT.md).

## v0.8.x to v0.9.0

Invalid `cleanup-profile` values and unknown `skip-components` entries now fail before cleanup begins. Correct misspelled or obsolete values instead of relying on them being ignored.

## v0.7.x to v0.8.0

Swapfile management became explicitly opt-in through `swapfile-size`:

- Replace `remove-swapfile: "true"` with `swapfile-size: 0`.
- Remove `swapfile` from `skip-components`; omitting `swapfile-size` now leaves runner swap unchanged.
- To resize swap, set a positive value such as `2G`.

## v0.6.x to v0.7.0

The default `cleanup-profile: max` began removing a wider set of preinstalled tools: cloud and Kubernetes CLIs, container tooling, build tools, package managers, browsers, toolcache subsets, databases, and services.

If an existing `max` workflow needs any of those tools, add its component ID to `skip-components`. For tighter control, switch to `cleanup-profile: custom` and set only the required `remove-*` inputs to `"true"`.

Skipping a browser child (`chrome`, `chromium`, `edge`, `firefox`, `webdrivers`, or `selenium`) disables the broad `browsers` operation. Skipping a toolcache child (`cached-go`, `cached-node`, `cached-python`, `cached-pypy`, or `cached-ruby`) disables broad `cached-tools` cleanup. `remove-docker-engine` also became part of `max`; skip `docker-engine` when later steps need the daemon, and also skip `docker-images` when existing images, containers, volumes, or build cache must survive.
