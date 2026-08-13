# Maximize GitHub Runner Space

Reclaim disk space on standard GitHub-hosted Ubuntu, macOS, and Windows runners
before a large build, test, or container job.

The action removes optional runner-image SDKs, toolchains, services, and caches.
It detects the runner operating system, architecture, privileges, and installed
capabilities; callers do not select a platform manually.

> [!WARNING]
> This action is intentionally destructive. It can remove tools that later
> steps expect. Run it near the start of a job and protect every component your
> workflow needs.

> [!IMPORTANT]
> The cross-platform examples describe the planned `v0.12.0` release. Until it
> is published, test this change by pinning the pull request's full commit SHA.
> The current `v0.11.0` release remains Ubuntu-only.

## Table of contents

- [Why use this action?](#why-use-this-action)
- [Quick start](#quick-start)
- [Cleanup profiles](#cleanup-profiles)
- [Runner support](#runner-support)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Safety and failure behavior](#safety-and-failure-behavior)
- [Upgrading and version pinning](#upgrading-and-version-pinning)
- [Project documentation](#project-documentation)

## Why use this action?

Standard GitHub-hosted runners expose 14 GB of SSD storage, while their images
include broad software inventories for many different workloads. That is useful
for general CI, but it can leave too little working space for large images,
Android builds, or monorepos.

This action provides:

- Automatic Linux, macOS, and Windows dispatch, including x64 and arm64 images.
- A backward-compatible aggressive `max` profile and a precise `custom` profile.
- Component-level protection through `skip-components`.
- Definition-derived paths and package-aware removal with exact, validated
  hosted-runner home identities.
- Before/after disk reporting and machine-readable outputs.
- Best-effort cleanup for image variation, while keeping configuration and
  swapfile safety errors fatal.

## Quick start

All examples below use the planned `v0.12.0` tag for readability. Pin a full
commit SHA for immutable or security-sensitive workflows.

### Existing Ubuntu usage remains valid

Calling the action without `with:` still selects the default `max` profile. This
is the historical Ubuntu behavior and remains intentionally aggressive.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Free runner space
        uses: justinthelaw/maximize-github-runner-space@v0.12.0
      - run: ./build.sh
```

### Maximum cleanup with protected tools

`skip-components` is the safest way to keep required tools under `max`.

```yaml
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Free runner space
        uses: justinthelaw/maximize-github-runner-space@v0.12.0
        with:
          skip-components: java,browsers,docker-engine,docker-images
          swapfile-size: 2GiB
      - run: docker build .
```

Protect both `docker-engine` and `docker-images` if later steps need the
preinstalled daemon and its cached data.

### Cross-platform custom cleanup

Start new macOS and Windows integrations with `custom`, measure the result, and
then opt in to more components.

```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Free runner space
        id: cleanup
        uses: justinthelaw/maximize-github-runner-space@v0.12.0
        with:
          cleanup-profile: custom
          remove-codeql: "true"
          remove-cached-go: "true"
      - run: echo "Reclaimed ${{ steps.cleanup.outputs.reclaimed-bytes }} bytes"
```

No input changes are needed for arm64 labels. The action derives the platform
from the runner and treats software absent from that image as a no-op.

## Cleanup profiles

### `cleanup-profile: max`

- This remains the default, including when the action has no `with:` block.
- It enables every component applicable to the detected operating system.
- `skip-components` protects named components and overlapping group operations.
- Components not installed on the particular image report `not-found` or
  `unsupported`; that image variation is not an error.

On Windows, `max` includes the additive `visual-studio` and `windows-sdk`
components. On macOS, it includes the additive `xcode` component, which
preserves the Xcode selected by `xcode-select`. Prefer `custom` until you have
confirmed which platform tools the rest of your job requires.

Windows `max` also removes PowerShell 7, which is the default shell for Windows
workflow `run` steps. Protect `powershell`, use `custom`, or select an explicit
remaining shell for later steps.

### `cleanup-profile: custom`

- No component is selected unless its `remove-*` input is exactly `"true"`.
- `skip-components` only affects `max`; it is accepted but ignored by `custom`
  for backward compatibility.
- Quote boolean-looking YAML values so the action receives strings consistently.

### Group and skip precedence

- `browsers` owns `chrome`, `chromium`, `edge`, `firefox`, `webdrivers`, and
  `selenium`. Protecting a child prevents the broad browser operation from
  deleting it.
- `cached-tools` owns the language toolcache entries. Protecting a cached
  language or another toolcache owner such as `codeql` or `java` prevents broad
  toolcache deletion from bypassing the skip.
- A protected Homebrew-managed component prevents broad Homebrew cleanup from
  deleting it.
- The Linux legacy `large-packages` purge is suppressed when it overlaps a
  protected component.
- On Windows, protecting `visual-studio` also preserves its definition-owned
  Android, .NET, vcpkg, and Windows SDK payloads. Protecting any one of those
  payloads blocks the broad Visual Studio uninstall while allowing unrelated
  cleanup, so neither direction leaves the retained toolchain unusable.

Values in `skip-components` are comma-separated, case-insensitive, and have
whitespace removed. Unknown names fail before cleanup begins.

### Swapfile management

`swapfile-size` is independent of the cleanup profile and remains opt-in:

- Omit it to leave the runner's swapfile unchanged.
- Use `0` to remove `/mnt/swapfile`.
- Use values such as `512MiB`, `2G`, `1.5GiB`, or a plain GiB value such as `2`.
- Positive values must be at least 1 MiB and fit signed 64-bit byte arithmetic.

Swapfile changes are supported only on privileged Linux VM runners. A nonempty
value on macOS, Windows, or the unprivileged `ubuntu-slim` container fails before
cleanup and leaves existing swap unchanged. An unsafe allocation request also
fails with rollback rather than replacing working swap.

## Runner support

| Runner family | Representative labels | Support |
| --- | --- | --- |
| Ubuntu x64 VM | `ubuntu-latest`, `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04` preview | Full; preserves legacy `ubuntu-latest` behavior |
| Ubuntu arm64 VM | `ubuntu-22.04-arm`, `ubuntu-24.04-arm`, `ubuntu-26.04-arm` preview | Full, capability-aware |
| Linux x64 container | `ubuntu-slim` | Capability-aware container cleanup; no swap, mounts, or Docker daemon cleanup |
| Windows x64 VM | `windows-latest`, `windows-2022`, `windows-2025`, and public `windows-2025-vs2026` | Full, Windows-native operations |
| Windows arm64 VM | `windows-11-arm`, `windows-11-vs2026-arm` preview | Full, capability-aware |
| macOS Intel VM | `macos-15-intel`, `macos-26-intel` | Full, Intel Homebrew layout aware |
| macOS M1 arm64 VM | `macos-latest`, `macos-14`, `macos-15`, `macos-26`, `xcode-27` preview | Full, Apple Silicon Homebrew layout aware |

Support means the action can run safely on the family; it does not mean every
component is installed on every image. For the authoritative label/spec table,
architecture-specific inventory, component matrix, billing notes, and cleanup
rules, see [Runner support and implementation notes](docs/RUNNER-SUPPORT.md).

Self-hosted runners and GitHub-hosted larger runners are outside this action's
support contract. Their images, persistent state, and disk layouts are not the
ephemeral standard-runner definitions against which deletion targets are
validated.

Before cleanup, the action reads the fixed image-data record produced by the
runner-images build at `/imagegeneration/imagedata.json`,
`/Users/runner/imagedata.json`, or `C:\imagedata.json`. It validates the image
label, version, source branch, manifest path, operating system, and architecture;
workflow-overridable `ImageOS` and `ImageVersion` values never authorize
cleanup. This is strict compatibility evidence, not cryptographic attestation:
a prior privileged step can alter local state, and a larger runner using the
identical GitHub image remains indistinguishable and unsupported.

## Inputs

The three global inputs and all historical `remove-*` inputs retain their names
and defaults. The three OS-specific inputs at the end are additive in `v0.12.0`.

### Profiles and global options

| Input | Default | Description |
| --- | --- | --- |
| `cleanup-profile` | `max` | `max` removes applicable components unless skipped; `custom` removes only explicitly enabled components. |
| `skip-components` | empty | Comma-separated component IDs to protect under `max`. |
| `swapfile-size` | empty | Optional privileged-Linux swap size; omitted means unchanged. |

### Toolchains, SDKs, and caches

| Input | Component | Platforms | Purpose |
| --- | --- | --- | --- |
| `remove-dotnet` | `dotnet` | Linux, macOS, Windows | Remove runner-image .NET SDKs and user tools. |
| `remove-android` | `android` | Linux, macOS, Windows | Remove the Android SDK and related user caches when installed. |
| `remove-haskell` | `haskell` | Linux, Windows | Remove GHCup, GHC, Cabal, and Stack artifacts when installed. |
| `remove-codeql` | `codeql` | Linux, macOS, Windows | Remove CodeQL bundles from the hosted toolcache. |
| `remove-swift` | `swift` | Linux | Remove the standalone Ubuntu Swift toolchain; it does not remove Xcode. |
| `remove-julia` | `julia` | Linux, Windows | Remove runner-image Julia installations when installed. |
| `remove-java` | `java` | Linux, macOS, Windows | Remove runner-image JDKs and Java toolcache entries. |
| `remove-rust` | `rust` | Linux, macOS, Windows | Remove runner Rustup/Cargo installations and user caches. |
| `remove-cached-tools` | `cached-tools` | Linux, macOS, Windows | Remove the hosted toolcache, subject to component protection. |
| `remove-cached-go` | `cached-go` | Linux, macOS, Windows | Remove cached Go versions. |
| `remove-cached-node` | `cached-node` | Linux, macOS, Windows | Remove cached Node.js versions. |
| `remove-cached-python` | `cached-python` | Linux, macOS, Windows | Remove cached CPython versions. |
| `remove-cached-pypy` | `cached-pypy` | Linux, Windows | Remove cached PyPy versions. |
| `remove-cached-ruby` | `cached-ruby` | Linux, macOS, Windows | Remove cached Ruby versions. |

### Package management, browsers, and project tools

| Input | Component | Platforms | Purpose |
| --- | --- | --- | --- |
| `remove-powershell` | `powershell` | Linux, macOS, Windows | Remove runner-image PowerShell when safely discoverable. |
| `remove-miniconda` | `miniconda` | Linux, Windows | Remove the environment-defined Miniconda installation and user cache. |
| `remove-homebrew` | `homebrew` | Linux, macOS | Run conservative native cleanup for verified Linuxbrew, or uninstall only finite definition-listed macOS identities; preserve both prefixes and unknown workflow-installed packages. |
| `remove-vcpkg` | `vcpkg` | Linux, macOS, Windows | Remove the environment-defined vcpkg installation and cache. |
| `remove-browsers` | `browsers` | Linux, macOS, Windows | Remove applicable browsers, drivers, and Selenium as one group. |
| `remove-chrome` | `chrome` | Linux, macOS, Windows | Remove Google Chrome when installed. |
| `remove-chromium` | `chromium` | Linux | Remove runner-image Chromium when installed. |
| `remove-edge` | `edge` | Linux, macOS, Windows | Remove runner-installed Edge; Windows base-image Edge is preserved and reported unsupported. |
| `remove-firefox` | `firefox` | Linux, macOS, Windows | Remove Firefox when installed. |
| `remove-webdrivers` | `webdrivers` | Linux, macOS, Windows | Remove manifest-defined browser drivers. |
| `remove-selenium` | `selenium` | Linux, macOS, Windows | Remove the manifest-defined Selenium server. |
| `remove-maven` | `maven` | Linux, macOS, Windows | Remove Maven through the platform package/layout definition. |
| `remove-gradle` | `gradle` | Linux, macOS, Windows | Remove Gradle through the platform package/layout definition. |
| `remove-ant` | `ant` | Linux, macOS, Windows | Remove Ant through the platform package/layout definition. |
| `remove-php` | `php` | Linux, macOS, Windows | Remove PHP and image-provided PHP tooling when installed. |

### Cloud, Kubernetes, and containers

| Input | Component | Platforms | Purpose |
| --- | --- | --- | --- |
| `remove-aws-cli` | `aws-cli` | Linux, macOS, Windows | Remove AWS CLI and its image-installed support artifacts. |
| `remove-aws-sam-cli` | `aws-sam-cli` | Linux, macOS, Windows | Remove AWS SAM CLI when installed. |
| `remove-azure-cli` | `azure-cli` | Linux, macOS, Windows | Remove Azure CLI through the native package definition. |
| `remove-gh-cli` | `gh-cli` | Linux, macOS, Windows | Remove GitHub CLI through the native package definition. |
| `remove-gcloud-cli` | `gcloud-cli` | Linux | Remove the apt- or archive-installed Google Cloud CLI. |
| `remove-azcopy` | `azcopy` | Linux, macOS, Windows | Remove the discovered AzCopy executable. |
| `remove-kubectl` | `kubectl` | Linux, macOS, Windows | Remove kubectl when installed. |
| `remove-helm` | `helm` | Linux, macOS, Windows | Remove Helm when installed. |
| `remove-kind` | `kind` | Linux, macOS, Windows | Remove kind when installed. |
| `remove-minikube` | `minikube` | Linux, Windows | Remove Minikube when installed. |
| `remove-kustomize` | `kustomize` | Linux, Windows | Remove Kustomize when installed. |
| `remove-docker-engine` | `docker-engine` | Linux, Windows | Stop and remove the image-provided Docker engine and data where supported. |
| `remove-docker-images` | `docker-images` | Linux, Windows | Prune unused Docker objects, including the legacy Ubuntu volume cleanup. |
| `remove-buildah` | `buildah` | Linux | Remove Buildah through the image package definition. |
| `remove-podman` | `podman` | Linux | Remove Podman packages, its executable, and bounded shared storage. Static Ubuntu 22/24 bundle files outside those targets are preserved. |

### Services and OS-specific components

| Input | Component | Platforms | Purpose |
| --- | --- | --- | --- |
| `remove-postgresql` | `postgresql` | Linux, Windows | Stop and remove runner PostgreSQL packages/data when installed. |
| `remove-mysql` | `mysql` | Linux, Windows | Stop and remove runner MySQL/MariaDB artifacts when installed. |
| `remove-apache` | `apache` | Linux, Windows | Stop and remove runner Apache artifacts when installed. |
| `remove-nginx` | `nginx` | Linux, macOS, Windows | Stop and remove runner Nginx artifacts when installed. |
| `remove-large-packages` | `large-packages` | Linux | Run the backward-compatible legacy bulk apt cleanup. |
| `remove-xcode` | `xcode` | macOS | Remove non-selected runner Xcode installations while preserving the active Xcode. New in `v0.12.0`. |
| `remove-visual-studio` | `visual-studio` | Windows | Remove adapter-defined, guarded Visual Studio installations. New in `v0.12.0`. |
| `remove-windows-sdk` | `windows-sdk` | Windows | Remove adapter-defined, guarded Windows SDK installations. New in `v0.12.0`. |

Every `remove-*` input defaults to `"false"`. Under `max`, those defaults are
intentionally overridden and all applicable components are selected unless
protected. Under `custom`, only the exact string `"true"` enables a component.

## Outputs

| Output | Value |
| --- | --- |
| `available-bytes-before` | Decimal byte count available before cleanup. |
| `available-bytes-after` | Decimal byte count available after cleanup. |
| `reclaimed-bytes` | Nonnegative decimal difference between the two measurements. |
| `failed-operations` | Decimal count of best-effort cleanup operations that reported failure. Fatal failures stop the step instead. |
| `platform` | Detected `linux`, `macos`, or `windows`. |
| `architecture` | Detected `x64` or `arm64`. |

Assign an `id` to the action step to consume outputs, as shown in the
cross-platform example. Human-readable measurements and per-operation statuses
are also written to the job log.

## Safety and failure behavior

- All inputs are parsed and validated before cleanup begins.
- A missing, malformed, linked, oversized, duplicated, or platform-mismatched
  runner-image record is fatal before an adapter or package manager is
  initialized.
- Paths come from runner contexts, documented environment variables, image
  package metadata, or tightly bounded runner-image definitions. Filesystem
  roots, the home directory itself, workspace/action/runtime trees, and unsafe
  link targets are protected. Definition-owned cache and tool directories below
  the fixed hosted-runner home may still be selected explicitly.
- Every planned deletion target is validated before the first mutation. An
  unsafe target is fatal, so no package, filesystem, or system cleanup in that
  plan is attempted.
- Package-manager and system operations are serialized. Independent filesystem
  work uses bounded concurrency.
- A missing component is expected image variation and produces `not-found` or
  `unsupported`, not a failure.
- Ordinary cleanup remains best-effort for backward compatibility: failures are
  reported and summarized without making an otherwise usable job fail.
- Invalid configuration, unsafe service-stop preconditions, and swap operations
  that cannot preserve existing state are fatal before subsequent build steps
  run.

Runner images change weekly. Always verify that required tools still exist after
cleanup, and prefer `custom` for workflows that depend on substantial portions
of an image.

## Upgrading and version pinning

For Ubuntu users moving from `v0.11.0`:

- Existing input names, defaults, `max`/`custom` profile-selection semantics,
  skips, and opt-in swap semantics remain supported.
- No-input usage remains aggressive `max`; it does not become a no-op.
- The new OS-specific components do not apply to Ubuntu.
- Image-absent components now produce explicit no-op statuses.

For new macOS and Windows users, begin with `custom`. In particular, protect or
avoid `xcode`, `visual-studio`, and `windows-sdk` until the job's compiler and SDK
requirements are known.

Use a release tag when you want normal semantic-version updates:

```yaml
- uses: justinthelaw/maximize-github-runner-space@v0.12.0
```

Use the release commit's complete SHA when you require immutable action code:

```yaml
- uses: justinthelaw/maximize-github-runner-space@<40-character-commit-sha>
```

See the [migration guide](docs/MIGRATIONS.md) for earlier release changes and
[Runner support](docs/RUNNER-SUPPORT.md#versioning-and-image-drift) for the image
version policy.

## Project documentation

- [Runner support and implementation notes](docs/RUNNER-SUPPORT.md)
- [Contributing guide](docs/CONTRIBUTING.md)
- [Migration guide](docs/MIGRATIONS.md)
- [Security policy](docs/SECURITY.md)
- [Support instructions](docs/SUPPORT.md)

This project is licensed under the terms of the [LICENSE](LICENSE) file.
