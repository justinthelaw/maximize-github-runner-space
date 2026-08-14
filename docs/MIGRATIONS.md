# Migrations

This document captures breaking changes and notable behavior shifts between releases so users can migrate safely.

## Table of Contents

- [0.11.x -> 0.12.0](#011x---0120)
- [0.12.0 -> 0.12.1](#0120---0121)
- [0.6.x -> 0.7.0](#06x---070)
- [0.7.x -> 0.8.0](#07x---080)
- [0.8.x -> 0.9.0](#08x---090)

## 0.11.x -> 0.12.0

> [!NOTE]
> `v0.12.0` introduced the cross-platform capability changes described in this
> section. It is the stable baseline for migrations from `v0.11.x`.

This release changes the implementation from an Ubuntu-only composite action to a bundled Node action with native Linux, macOS, and Windows adapters.

Existing Ubuntu workflows remain compatible:

- Every historical input retains its name, default, and optional status.
- Calling the action without a `with:` block still selects the aggressive `max` profile.
- `custom` still enables only inputs whose value is exactly `"true"`.
- Omitting `swapfile-size` still leaves swap unchanged.
- Existing component names and skip behavior remain supported; broader operations now yield when necessary to honor protected components.

The new `remove-xcode`, `remove-visual-studio`, and `remove-windows-sdk` inputs are additive. They apply only to their named operating systems and do not change Ubuntu cleanup.

For a new macOS or Windows workflow, start with `cleanup-profile: custom` and enable only measured, disposable components. The default `max` profile is intentionally destructive: it includes unselected Xcodes on macOS and eligible Visual Studio and Windows SDK payloads on Windows. Windows `max` also removes PowerShell 7, the default shell for later Windows `run` steps. Use `skip-components` to protect every toolchain and shell the rest of the job requires.

Linux `remove-homebrew` is intentionally more conservative than v0.11. The runner-image definition installs no formulae or casks, so the action now verifies the fixed Linuxbrew executable and runs native stale-artifact cleanup while preserving the prefix and workflow-installed packages. Workflows that depended on deleting the entire Linuxbrew installation should expect less reclaimed space rather than unsafe ownership of files added before the action runs.

The action now rejects self-hosted runners, arbitrary job containers, and hosted image identities outside the supported Ubuntu, macOS, and Windows runner-image definitions before cleanup. VM authorization reads the fixed runner-images image-data record instead of trusting workflow-overridable `ImageOS` or `ImageVersion` values. This compatibility gate is not signed attestation and does not prove a runner's billing or size class, so larger runners remain unsupported and outside the tested contract rather than being guaranteed rejection cases. These checks apply to both `max` and `custom`; selecting `custom` does not extend the support boundary. See [Runner support](/docs/RUNNER-SUPPORT.md) for exact labels and limitations.

## 0.12.0 -> 0.12.1

This maintenance release consolidates the current dependency updates and refreshes
the workflow's pinned Node setup action. Runtime cleanup behavior, public inputs,
outputs, and the supported runner contract remain unchanged.

No workflow migration is required. Continue pinning the full commit SHA while the
`v0.12.1` tag is being prepared.

## 0.8.x -> 0.9.0

Invalid `cleanup-profile` values and unknown `skip-components` entries now fail before cleanup begins. Correct misspelled or obsolete values instead of relying on them being ignored.

## 0.7.x -> 0.8.0

Swapfile management is now explicitly opt-in through `swapfile-size`:

- Replace `remove-swapfile: "true"` with `swapfile-size: 0`.
- Remove `swapfile` from `skip-components`; omitting `swapfile-size` now leaves the runner swapfile unchanged.
- To resize swap instead of removing it, set a positive size such as `2G`.

## 0.6.x -> 0.7.0

**Summary**

`cleanup-profile: max` now removes a much wider set of preinstalled tools. If your workflows rely on any of the components listed below, add them to `skip-components` or switch to `cleanup-profile: custom` and opt in to specific `remove-*` toggles.

**Breaking changes and behavior shifts**

- **Max profile scope expanded**. The default `max` profile now enables all removal toggles, including cloud CLIs, Kubernetes tooling, container tooling, build tools, databases, and services. If you previously used `max` and expected these tools to remain available, you must explicitly keep them.
- **New skip-components values**. Many new component names are available for `skip-components` (see `README.md`). If you want to keep a specific tool, you must now include its component name.
- **Browser and toolcache grouping behavior**. Listing any browser subcomponent (`chrome`, `chromium`, `edge`, `firefox`, `webdrivers`, `selenium`) or toolcache subcomponent (`cached-go`, `cached-node`, `cached-python`, `cached-pypy`, `cached-ruby`) in `skip-components` automatically disables the group removal (`browsers` or `cached-tools`). This ensures granular control but changes the default behavior when you skip a single subcomponent.
- **Docker availability**. `remove-docker-engine` is new and enabled by `max`. If you need Docker for build or test steps, add `docker-engine` to `skip-components`.

**New toggles introduced in 0.7.0**

- Cloud and DevOps tooling: `remove-aws-cli`, `remove-aws-sam-cli`, `remove-azure-cli`, `remove-gh-cli`, `remove-gcloud-cli`, `remove-azcopy`, `remove-kubectl`, `remove-helm`, `remove-kind`, `remove-minikube`, `remove-kustomize`.
- Container tooling: `remove-docker-engine`, `remove-buildah`, `remove-podman`.
- Build tools: `remove-maven`, `remove-gradle`, `remove-ant`.
- Languages and package managers: `remove-rust`, `remove-miniconda`, `remove-homebrew`, `remove-vcpkg`.
- Browsers and drivers: `remove-chrome`, `remove-chromium`, `remove-edge`, `remove-firefox`, `remove-webdrivers`, `remove-selenium`.
- toolcache subsets: `remove-cached-go`, `remove-cached-node`, `remove-cached-python`, `remove-cached-pypy`, `remove-cached-ruby`.
- Databases and services: `remove-postgresql`, `remove-mysql`, `remove-apache`, `remove-nginx`.

**Migration checklist**

- If you use `cleanup-profile: max`, add all required tools to `skip-components`.
- If you want stricter control, switch to `cleanup-profile: custom` and enable only the `remove-*` toggles you need.
- Review the `Inputs reference` section in `README.md` to confirm what each toggle removes.
