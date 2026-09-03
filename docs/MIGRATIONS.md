# Migrations

Use these notes when moving between action releases. See the [configuration reference](CONFIGURATION.md) for the current input catalog.

## v0.12.2 to v0.12.3

`v0.12.3` is a safety and compatibility hardening release. It has no new inputs
and no breaking changes: existing profiles, component IDs, defaults, outputs,
and supported runner classes remain compatible.

Linux recursive removal now refuses targets that are mount points or contain a
mounted descendant before any cleanup mutation. Skipping `maven` under `max`
also implicitly preserves Java, and swap replacement performs stronger
rollback checks. macOS cleanup revalidates targets at mutation time and uses a
validated snapshot of the selected Xcode. macOS Android cleanup explicitly
owns the SDK/NDK, `.android`, and its Gradle cache when Gradle is not protected;
Azure CLI cleanup also owns the Azure DevOps extension. Windows Docker cleanup
covers the current runner-image helper paths, while Windows SDK cleanup handles
both Visual Studio-owned components and eligible standalone installer bundles
through exact registered metadata.

Release validation now separates the scheduled bounded 18-label sweep from a
dispatch-only seven-class no-input `max` matrix on fresh runners. The generated
distribution job is a dependency of that matrix, whose destructive smoke steps
assert numeric outputs and zero failed operations.

No input or workflow-syntax changes are required. Workflows that intentionally
mount content below a cleanup target must unmount it first or preserve that
component.

## v0.11.x to v0.12.0

`v0.12.0` introduced cross-platform support and the three OS-specific inputs: `remove-xcode`, `remove-visual-studio`, and `remove-windows-sdk`.

Existing Ubuntu workflows remain compatible: historical inputs retain their names, defaults, and optional status; no `with:` block still selects `max`; `custom` still requires exact `"true"` values; and omitted `swapfile-size` leaves swap unchanged.

For a new macOS or Windows workflow, start with `cleanup-profile: custom` and enable only measured disposable components. Under `max`, macOS can remove unselected Xcodes and Windows can remove eligible Visual Studio/SDK payloads and PowerShell 7. Use `skip-components` to protect each toolchain and shell needed by later steps.

Linux Homebrew cleanup is more conservative: it preserves the prefix and workflow-installed packages. If a workflow depended on deleting all of Linuxbrew, expect less reclaimed space.

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

Skipping a browser child (`chrome`, `chromium`, `edge`, `firefox`, `webdrivers`, or `selenium`) disables the broad `browsers` operation. Skipping a toolcache child (`cached-go`, `cached-node`, `cached-python`, `cached-pypy`, or `cached-ruby`) disables broad `cached-tools` cleanup. `remove-docker-engine` also became part of `max`; preserve `docker-engine` when later steps use Docker.
