# Runner support and implementation notes

This document describes the runner contract for the planned `v0.12.0` release
of Maximize GitHub Runner Space. The runner and image inventory was verified on
2026-08-12 against GitHub's current documentation and
[`actions/runner-images@20f9f7b`](https://github.com/actions/runner-images/tree/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24).

Runner labels and installed software change over time. The pinned image commit
records the evidence used to define cleanup targets; it is not a promise that a
particular package remains present on every later image.

## Table of contents

- [Support contract](#support-contract)
- [Standard runner inventory](#standard-runner-inventory)
- [Billing and CI cost](#billing-and-ci-cost)
- [Runtime detection and path policy](#runtime-detection-and-path-policy)
- [Definition-derived image inventory](#definition-derived-image-inventory)
- [Component applicability](#component-applicability)
- [Safe cleanup rules](#safe-cleanup-rules)
- [Non-applicable and failure behavior](#non-applicable-and-failure-behavior)
- [Versioning and image drift](#versioning-and-image-drift)
- [CI and release validation](#ci-and-release-validation)

## Support contract

The action supports ephemeral, standard GitHub-hosted runners available to
GitHub Free users. It does not support:

- Self-hosted runners, whose files and persistent state are controlled by their
  owner.
- GitHub-hosted larger runners, including larger-runner RHEL images.
- Arbitrary job containers layered on a full hosted VM.

There is no OS input. The action detects `runner.os`, `runner.arch`, hosted
toolcache, home, temporary directory, privilege availability, and container
state. It then builds an operation plan for that environment.

| Environment class | Support level | Important behavior |
| --- | --- | --- |
| Ubuntu x64 full VM | Full and backward-compatible | Existing no-input `max`, component names, skips, and optional swap behavior remain supported. |
| Ubuntu arm64 full VM | Full, capability-aware | Architecture-specific omissions are successful no-ops. |
| `ubuntu-slim` x64 container | Limited | Uses only the permissions and installed tools actually available; mount, swap, low-level kernel, and Docker-daemon operations report unsupported. |
| Windows x64 full VM | Full | Uses Windows-native package, service, path, and process handling. |
| Windows arm64 full VM | Full, capability-aware | Docker, Android SDK, Haskell, Miniconda, and PostgreSQL are absent from current images. |
| macOS Intel full VM | Full | Uses the Intel Homebrew layout and preserves the selected Xcode. |
| macOS arm64 full VM | Full, capability-aware | Uses the Apple Silicon Homebrew layout and preserves the selected Xcode. |

"Full" means the action safely supports the runner family. It does not mean
every logical component is installed on every label. An applicable but absent
component is a no-op.

## Standard runner inventory

GitHub's authoritative tables are [standard runners for public
repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)
and [standard runners for private
repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-private-repositories).
As of the research date:

| OS / architecture | Current workflow labels | Public resources | Private resources |
| --- | --- | --- | --- |
| Linux x64 container | `ubuntu-slim` | 1 CPU, 5 GB RAM, 14 GB SSD | Same |
| Ubuntu x64 VM | `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-26.04` preview | 4 CPU, 16 GB RAM, 14 GB SSD | 2 CPU, 8 GB RAM, 14 GB SSD |
| Ubuntu arm64 VM | `ubuntu-24.04-arm`, `ubuntu-22.04-arm`, `ubuntu-26.04-arm` preview | 4 CPU, 16 GB RAM, 14 GB SSD | 2 CPU, 8 GB RAM, 14 GB SSD |
| Windows x64 VM | `windows-latest`, `windows-2025`, `windows-2022`; public also has `windows-2025-vs2026` | 4 CPU, 16 GB RAM, 14 GB SSD | 2 CPU, 8 GB RAM, 14 GB SSD |
| Windows arm64 VM | `windows-11-arm`, `windows-11-vs2026-arm` preview | 4 CPU, 16 GB RAM, 14 GB SSD | 2 CPU, 8 GB RAM, 14 GB SSD |
| macOS Intel VM | `macos-15-intel`, `macos-26-intel` | 4 CPU, 14 GB RAM, 14 GB SSD | Same |
| macOS M1 arm64 VM | `macos-latest`, `macos-14`, `macos-15`, `macos-26`, `xcode-27` preview | 3 CPU, 7 GB RAM, 14 GB SSD | Same |

GitHub documents that `-latest` means its latest stable image, not necessarily
the operating-system vendor's newest release. Preview and deprecated images are
provided outside the normal SLA.

The [`ubuntu-slim` contract](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners)
is materially different from a VM: it is an unprivileged container on a shared
VM, has a minimal inventory, and has a 15-minute job timeout. Mounting, Docker in
Docker, and low-level kernel operations are unsupported.

GitHub's [administrative privilege
documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)
provides passwordless sudo on full Linux/macOS VMs and administrator execution
with UAC disabled on Windows VMs. The action still checks the actual capability
before scheduling an elevated operation.

On arm64 macOS, GitHub-provided actions are compatible, but community actions
may not be; nested virtualization and static UUIDs are also unavailable. See
[GitHub's arm64 macOS
limitations](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#limitations-for-arm64-macos-runners).

## Billing and CI cost

Use of standard GitHub-hosted runners in public repositories is free and
unlimited. GitHub Free private accounts and organizations receive 2,000 minutes
per month, 500 MB of artifact/package storage, and 10 GB of cache storage per
repository. Larger runners are always billed. See [Free use of GitHub
Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions#free-use-of-github-actions).

GitHub currently publishes direct per-minute rates:

| Standard runner type | USD per minute |
| --- | ---: |
| Linux slim x64 | $0.002 |
| Linux x64 | $0.006 |
| Linux arm64 | $0.005 |
| Windows x64 or arm64 | $0.010 |
| macOS Intel or M1 | $0.062 |

Source: [Actions runner
pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).
Each job's partial minute is rounded up. GitHub's current billing documentation
uses direct rates and no longer publishes the historical Windows/macOS minute
multipliers; those old multipliers are therefore not part of this project's
current runner contract.

This repository is public, so its standard-runner CI does not consume included
minutes. The test plan still minimizes runner count and duration because private
forks, reruns, queue capacity, and developer feedback time remain real costs.

## Runtime detection and path policy

GitHub says hosted-runner VM paths are not static and directs actions to use its
[filesystem environment variables](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#file-systems).
The action follows this resolution order:

1. A documented runner context or environment variable.
2. Native package, service, or application metadata.
3. The resolved location of an installed executable.
4. A tightly bounded fallback taken from the pinned runner-image definition.

Important sources include:

| Value | Source |
| --- | --- |
| OS and architecture | `runner.os` / `RUNNER_OS`, `runner.arch` / `RUNNER_ARCH` |
| Hosted toolcache | `runner.tool_cache`, `RUNNER_TOOL_CACHE`, or `AGENT_TOOLSDIRECTORY` |
| Home | `HOME` or `USERPROFILE`, accepted only when it matches the detected runner-image definition |
| Temporary directory | `runner.temp` or `RUNNER_TEMP` |
| Workspace/action paths | `GITHUB_WORKSPACE` and `GITHUB_ACTION_PATH`, which are protected from deletion |
| Installed roots | `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `CONDA`, `VCPKG_INSTALLATION_ROOT`, driver variables, database variables, and native package metadata |

The [runner context
reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#runner-context)
defines `runner.os`, `runner.arch`, `runner.tool_cache`, `runner.temp`, and
`runner.environment`.

Every composite `run` step requires an explicit shell. Although GitHub exposes
`bash`, `pwsh`, and `python` on all current standard platforms, Windows `bash` is
Git for Windows Bash; it does not provide Ubuntu package managers or filesystem
layout. See the [composite shell
requirement](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runsstepsshell)
and [workflow shell
table](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell).
The action uses platform adapters rather than treating a shared shell as a
portable operating-system API.

## Definition-derived image inventory

The paths below are implementation evidence. Runtime environment variables and
package metadata take precedence whenever available.

### Ubuntu x64 and arm64

Pinned manifests:

- [Ubuntu 22.04 x64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/Ubuntu2204-Readme.md)
  and [arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/Ubuntu2204-Arm64-Readme.md)
- [Ubuntu 24.04 x64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/Ubuntu2404-Readme.md)
  and [arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/Ubuntu2404-Arm64-Readme.md)
- [Ubuntu 26.04 x64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/Ubuntu2604-Readme.md)
  and [arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/Ubuntu2604-Arm64-Readme.md)

| Component | Definition-derived location or manager | Image differences |
| --- | --- | --- |
| .NET | `/usr/share/dotnet`; `/usr/bin/dotnet` link ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-dotnetcore-sdk.sh)) | Present on x64 and arm64 |
| Android | `$ANDROID_SDK_ROOT` / `$ANDROID_HOME`, currently `/usr/local/lib/android/sdk` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-android-sdk.sh)) | Absent on arm64 |
| Haskell | `/usr/local/.ghcup`, plus user Cabal/Stack caches ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-haskell.sh)) | Absent on arm64 |
| CodeQL | Hosted toolcache `CodeQL` directory ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-codeql-bundle.sh)) | Absent on arm64 |
| Swift | `/usr/share/swift` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-swift.sh)) | Present on Ubuntu 22/24 x64 and arm64; absent on Ubuntu 26 |
| Julia | Versioned `/usr/local/julia<VERSION>` and resolved `julia` link ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-julia.sh)) | Absent on arm64 and Ubuntu 26 |
| Java/build tools | `/usr/lib/jvm/temurin-*`, hosted Java toolcache, versioned Maven/Gradle under `/usr/share` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-java-tools.sh)) | Versions vary by label |
| PowerShell | `/opt/microsoft/powershell/7` or apt package ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-powershell.sh)) | Installer mode can vary |
| Miniconda | `$CONDA`, currently `/usr/share/miniconda` | Absent on arm64 and Ubuntu 26 |
| Homebrew | `/home/linuxbrew/.linuxbrew` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-homebrew.sh)) | Not added to PATH by default |
| vcpkg | `$VCPKG_INSTALLATION_ROOT`, currently `/usr/local/share/vcpkg` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-vcpkg.sh)) | Present on x64 and arm64 |
| Browsers | apt packages plus manifest driver variables and `$SELENIUM_JAR_PATH` | arm64 has Firefox/Selenium but no Chrome, Chromium, or Edge |
| Cloud/Kubernetes | apt packages or resolved `/usr/local/bin` tools; Ubuntu 26 arm64 GCloud uses `/opt/google-cloud-sdk` ([GCloud installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-google-cloud-cli.sh)) | Capability discovery is required |
| Containers | apt packages and image-defined CLI plugins ([container installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu/scripts/build/install-container-tools.sh)) | Ubuntu 22/24 Podman uses a static bundle spread across system directories; broad path deletion is unsafe |
| Databases/web servers | apt packages/services; manifest configs under `/etc` and data under `/var/lib` | Package versions vary weekly |

Ubuntu arm64 currently omits Android, Haskell, CodeQL, Miniconda, Julia,
Chrome, Chromium, Edge, and PostgreSQL. Ubuntu 26 also omits Swift. Those
differences are capabilities, not errors.

### `ubuntu-slim`

The pinned [slim
manifest](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu-slim/ubuntu-slim-Readme.md)
and [Dockerfile](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/ubuntu-slim/Dockerfile)
show a minimal image with selected cloud CLIs, PowerShell, and Docker client
plugins, but not the full VM SDK, toolcache, service, or container-engine
families. `max` therefore mostly produces successful no-op/unsupported results.
Ordinary package and file cleanup is capability-checked at runtime. The action
never tries to create swap or mount storage, and it treats the absent Docker
daemon as unsupported in this unprivileged container.

### macOS Intel and arm64

Pinned manifests:

- [macOS 14 arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/macos-14-arm64-Readme.md)
- [macOS 15 Intel](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/macos-15-Readme.md)
  and [arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/macos-15-arm64-Readme.md)
- [macOS 26 Intel](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/macos-26-Readme.md)
  and [arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/macos-26-arm64-Readme.md)
- [Xcode 27 arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/xcode-27-arm64-Readme.md)

| Component | Definition-derived location or manager | Architecture rule |
| --- | --- | --- |
| Homebrew | Resolve `brew --prefix` and `brew --cache` | `/usr/local` on Intel; `/opt/homebrew` on arm64. Never recursively delete either prefix. |
| .NET | `$HOME/.dotnet`; resolved `/usr/local/bin/dotnet` link ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/scripts/build/install-dotnet.sh)) | Same user root on both architectures |
| Android | `$ANDROID_SDK_ROOT`, currently `$HOME/Library/Android/sdk` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/scripts/build/install-android-sdk.sh)) | Same user-relative root |
| CodeQL | Hosted toolcache `CodeQL` directory ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/scripts/build/install-codeql-bundle.sh)) | Use runner toolcache, not a fixed `/opt` path |
| Java | Hosted Java toolcache plus links under `/Library/Java/JavaVirtualMachines` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/scripts/build/install-openjdk.sh)) | JDK environment variables encode architecture |
| vcpkg | `/usr/local/share/vcpkg` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/scripts/build/install-vcpkg.sh)) | Same definition on both architectures |
| Rust | Homebrew-managed Rustup plus `$HOME/.cargo` and `$HOME/.rustup` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/scripts/build/install-rust.sh)) | Package-aware uninstall first |
| Drivers | Chrome `/usr/local/share/chromedriver-mac-{x64,arm64}`; Edge `/usr/local/share/edge_driver`; Gecko through `brew --prefix geckodriver` | Never guess the Gecko Homebrew prefix |
| Xcode | Dynamically enumerate `/Applications/Xcode_*.app`; resolve the selected developer directory with `xcode-select -p`; versions come from the pinned [15](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/toolsets/toolset-15.json) and [26](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/macos/toolsets/toolset-26.json) toolsets | Preserve the selected Xcode and `/Applications/Xcode.app` relationship |

Many macOS project tools and CLIs are Homebrew formulae or casks. They are
removed by exact package identity followed by `brew cleanup`, not by deleting
the Homebrew prefix. Current macOS manifests omit GCloud, Kubernetes tools,
Docker/Buildah/Podman, Miniconda, Haskell, PostgreSQL, MySQL, Apache, and Nginx.
PHP is present only on current Intel manifests.

### Windows x64 and arm64

Pinned manifests:

- [Windows Server 2022](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/Windows2022-Readme.md)
- [Windows Server 2025](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/Windows2025-Readme.md)
  and [VS 2026 variant](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/Windows2025-VS2026-Readme.md)
- [Windows 11 arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/Windows11-Arm64-Readme.md)
  and [VS 2026 arm64](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/Windows11-VS2026-Arm64-Readme.md)

| Component | Definition-derived location or manager | Image differences |
| --- | --- | --- |
| .NET | `C:\Program Files\dotnet` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-DotnetSDK.ps1)) | Present on x64 and arm64 |
| Android | `$ANDROID_SDK_ROOT`, currently `C:\Android\android-sdk` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-AndroidSDK.ps1)) | Standalone SDK absent on arm64 |
| Haskell | Image-defined GHCup/Cabal roots ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-Haskell.ps1)) | x64 only; runtime discovery takes precedence over build-time user paths |
| CodeQL/Java | Hosted toolcache `CodeQL` and `Java_Temurin-Hotspot_jdk` ([CodeQL installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-CodeQLBundle.ps1)) | Present on x64 and arm64 |
| Miniconda | `$CONDA`, currently `C:\Miniconda` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-Miniconda.ps1)) | Absent on arm64 |
| vcpkg | `$VCPKG_INSTALLATION_ROOT`, currently `C:\vcpkg` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-Vcpkg.ps1)) | Present on x64 and arm64 |
| Rust | `$CARGO_HOME`, `$RUSTUP_HOME`, then the runtime user's home ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-Rust.ps1)) | Never hard-code the build-time `C:\Users\Default` seed location |
| Drivers/Selenium | Manifest variables, currently `C:\SeleniumWebDrivers\*Driver` and `C:\selenium\selenium-server.jar` | Present on x64 and arm64 |
| Kubernetes | Package metadata; current kind root `C:\ProgramData\kind` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-KubernetesTools.ps1)) | Current images do not include Kustomize |
| PostgreSQL | `PGROOT`, `PGDATA`, and `postgresql-*` services; current data root is versioned below `C:\PostgreSQL` ([installer](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/scripts/build/Install-PostgreSQL.ps1)) | x64 only; discover version at runtime |
| Apache/Nginx | Apache `C:\tools\Apache24`; versioned Nginx child below `C:\tools`; native services | Enumerate only inside the verified parent; do not pin a version |
| Visual Studio/SDKs | Visual Studio Installer/package metadata and guarded, definition-derived roots | Never recursively delete `Program Files`; preserve selected/required toolsets through skips |

The architecture split is explicit in the [Windows 2025 x64 image
template](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/templates/build.windows-2025.pkr.hcl)
and [Windows 11 arm64 image
template](https://github.com/actions/runner-images/blob/20f9f7b2d2dbcf53e5c5a7e133f4867e8a555c24/images/windows/templates/build.windows-11-arm64.pkr.hcl).
Current arm64 images omit Docker, Android SDK, Haskell, Miniconda, and
PostgreSQL, while retaining PHP, MySQL client tools, web servers, browsers,
cloud/Kubernetes tools, Java, Rust, and CodeQL.

Microsoft Edge itself belongs to the Windows base image rather than the
runner-image software layer. The action preserves that system browser and
reports its removal as unsupported; the separately installed Edge WebDriver is
still removable.

## Component applicability

This table describes logical adapter coverage. "Applicable" means the platform
adapter knows how to discover and clean the component if the runner image has
it. It is not an installation guarantee.

| Components | Linux | macOS | Windows |
| --- | --- | --- | --- |
| `dotnet`, `android`, `codeql`, `cached-tools`, `cached-go`, `cached-node`, `cached-python`, `cached-ruby`, `java`, `browsers`, `chrome`, `edge`, `firefox`, `webdrivers`, `selenium`, `powershell`, `vcpkg`, `aws-cli`, `aws-sam-cli`, `azure-cli`, `gh-cli`, `azcopy`, `kubectl`, `helm`, `kind`, `maven`, `gradle`, `ant`, `php`, `rust` | Applicable | Applicable | Applicable |
| `haskell`, `cached-pypy`, `julia`, `miniconda`, `minikube`, `kustomize`, `docker-engine`, `postgresql`, `mysql`, `apache`, `docker-images` | Applicable | — | Applicable |
| `homebrew` | Applicable | Applicable | — |
| `swift`, `chromium`, `gcloud-cli`, `buildah`, `podman`, `large-packages` | Applicable | — | — |
| `nginx` | Applicable | Applicable if installed | Applicable |
| `xcode` | — | Applicable | — |
| `visual-studio`, `windows-sdk` | — | — | Applicable |

Additional rules:

- `remove-swift` is the standalone Ubuntu Swift component. It never aliases
  Xcode deletion.
- `remove-xcode` preserves the Xcode selected by `xcode-select`; use
  `skip-components: xcode` under `max` to keep all runner-image Xcodes.
- `remove-visual-studio` and `remove-windows-sdk` use guarded adapter
  definitions. Protect them under Windows `max` whenever later build steps
  depend on Visual Studio or an SDK. Protecting `visual-studio` also retains its
  definition-owned Android, .NET, vcpkg, and Windows SDK payloads.
- On `ubuntu-slim`, logical Linux applicability yields `unsupported` for
  operations requiring privileges or a daemon.

## Safe cleanup rules

### Cross-platform rules

- Validate every input and build the complete plan before mutation.
- Refuse empty, relative, filesystem-root, home, workspace, action, runtime, and
  other protected deletion targets.
- Resolve environment-defined paths only within component-specific allowlists.
- Treat symlinks and Windows junction/reparse boundaries conservatively.
- Invoke executables with argument arrays, never interpolated user input.
- Serialize package managers and service operations; use bounded concurrency
  only for independent filesystem targets.
- Stop a service before removing its package or data.
- Report `removed`, `not-found`, `unsupported`, and `failed` accurately.

### Ubuntu and apt

The [Ubuntu `apt-get`
manual](https://manpages.ubuntu.com/manpages/noble/en/man8/apt-get.8.html)
defines `apt-get clean` as removal of downloaded package files while retaining
the archive lock. It does not require `apt-get update`. `autoremove` changes the
dependency graph and can remove tools needed by a later step, so the action does
not use it as an unqualified cache-cleaning shortcut.

All apt/dpkg operations are serialized to avoid lock races. Static archives
spread across system directories, such as Ubuntu 22/24's Podman bundle, are not
removed by guessing broad roots. On those two images, `remove-podman` therefore
removes the package when registered, the verified executable, and bounded
container storage, but deliberately leaves other static-bundle entries whose
ownership cannot be proved independently.

### Docker

Docker documents `docker system prune` as removal of unused containers,
networks, images, and build cache; `--all` expands image removal and `--volumes`
is a separate destructive choice. See [Docker system
prune](https://docs.docker.com/reference/cli/docker/system/prune/) and [pruning
unused objects](https://docs.docker.com/engine/manage-resources/pruning/).

The action checks both the CLI and daemon before pruning. It preserves the
legacy Ubuntu `remove-docker-images` volume-cleanup contract. Protect
`docker-images` if later steps depend on any cached or unused Docker data.
`ubuntu-slim` and current Windows arm64 images do not expose a supported Docker
daemon cleanup.

### Homebrew and macOS

Use exact formula/cask identity and Homebrew's supported
[`uninstall`](https://docs.brew.sh/Manpage#uninstall-remove-rm-options-installed_formulainstalled_cask-)
and [`cleanup`](https://docs.brew.sh/Manpage#cleanup-options-formulacask)
operations. Never recursively delete `/usr/local`, `/opt/homebrew`, or the
resolved Homebrew prefix. `--zap` can remove shared files and is not a safe
default.

Apple directs optional Xcode components and simulator runtimes through Xcode's
component management rather than raw deletion of protected runtime stores. See
[Downloading and installing additional Xcode
components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
and the [Xcode simulator runtime
notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes#Simulator).
The action dynamically enumerates runner-image Xcode app bundles and preserves
the active developer directory. It does not reinterpret `remove-swift` as Xcode
cleanup.

### Windows

Use registered package/application metadata or guarded image definitions. Never
recursively delete `C:\Program Files`, `C:\Windows`, or a drive root. PowerShell
and Node filesystem operations use literal, normalized paths after absolute-path
validation.

Microsoft explicitly warns against direct deletion from `WinSxS`. The supported
operation is DISM
[`/StartComponentCleanup`](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/clean-up-the-winsxs-folder?view=windows-11#use-the-startcomponentcleanup-parameter),
and [`/ResetBase`](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/clean-up-the-winsxs-folder?view=windows-11#use-the-resetbase-switch-with-the-startcomponentcleanup-parameter)
makes installed updates non-uninstallable. Consequently, direct WinSxS deletion
and automatic `/ResetBase` cleanup are outside the default action behavior.

The adapter prefers Chocolatey, MSI, registered application uninstallers, and
the Visual Studio Installer when the image definition provides them. For a
future definition registered with WinGet, exact noninteractive
[`winget uninstall`](https://learn.microsoft.com/en-us/windows/package-manager/winget/uninstall)
is the supported package-aware route. Archive installs that are not registered
use only bounded, verified targets.

## Non-applicable and failure behavior

The action distinguishes four operation results:

| Status | Meaning | Job effect |
| --- | --- | --- |
| `removed` | The operation completed and removed or cleaned its target. | Continue |
| `not-found` | The component or target was absent on this image. | Continue |
| `unsupported` | The platform, architecture, privilege, package manager, or daemon cannot safely perform the operation. | Continue |
| `failed` | An applicable best-effort operation failed. | Warn and continue unless the state contract is fatal |

This behavior lets the same `custom` configuration run across a matrix and lets
`max` tolerate normal weekly image variation. It does not hide input mistakes:

- Invalid `cleanup-profile`, unknown `skip-components`, and invalid
  `swapfile-size` fail before cleanup.
- A swap request on a non-privileged-Linux-VM environment fails before cleanup.
- Swap allocation/activation failure is fatal and rolls back because leaving
  swap in an unknown state is unsafe.
- A required service stop that fails is fatal before the adapter removes that
  service's live data.
- Ordinary removal remains best-effort for compatibility with existing Ubuntu
  workflows.

## Versioning and image drift

Two independent versions affect a workflow:

1. The action version determines planning, safety, and removal behavior.
2. The runner label determines the operating system and installed inventory.

Pin the action to a full commit SHA for immutable execution. A semantic release
tag such as `v0.12.0` is easier to read but can only be used after that release
exists. Pull request testers must use the PR commit SHA, not a not-yet-published
tag.

Explicit runner labels such as `ubuntu-24.04` reduce surprise from `-latest`
migration, but they do not freeze the weekly image version. GitHub documents the
[latest-image migration
process](https://github.com/actions/runner-images#latest-migration-process) as a
gradual rollout and the [image support
policy](https://github.com/actions/runner-images#support-policy) as weekly
updates with a limited set of supported images.

Maintenance rules for this project:

- Treat the manifests and build scripts as the deletion-target source of truth.
- Pin research citations to the exact runner-images commit used for a release.
- Prefer runtime environment/package discovery over a versioned directory.
- Add or change a fallback only with a matching manifest/build-script citation
  and a path-safety test.
- Test stable aliases on pull requests and exact versions in scheduled/manual
  canaries.
- Treat preview labels as experimental until GitHub promotes them.

## CI and release validation

Cross-platform support must not multiply every component by every image. The CI
strategy separates deterministic behavior from destructive image tests.

### Pull requests

1. Run one inexpensive quality job first: formatting, type checking, unit and
   contract tests, action metadata validation, security/path tests, and a check
   that generated distribution files are current.
2. Run the full no-input Ubuntu compatibility test on `ubuntu-latest`. This is
   the sentinel that protects historical default `max` behavior.
3. Batch Ubuntu component, skip/overlap, invalid-input, and swap lifecycle cases
   instead of allocating one VM for every toggle.
4. Smoke one representative from each remaining environment class:
   `ubuntu-24.04-arm`, `ubuntu-slim`, `windows-latest`, `windows-11-arm`,
   `macos-latest`, and `macos-15-intel`.
Runtime jobs depend on the quality job, have explicit timeouts, and use bounded
matrix parallelism. Superseded pull-request and branch runs are cancelled.
Static failures therefore do not launch destructive matrices, and force-pushes
do not leave obsolete macOS/Windows jobs running.

### Scheduled and release validation

A separate weekly/manual sweep covers distinct exact image labels without
making every preview image a required pull-request check:

- Linux: `ubuntu-slim`, `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04`,
  `ubuntu-22.04-arm`, `ubuntu-24.04-arm`, `ubuntu-26.04-arm`.
- Windows: `windows-2022`, `windows-2025`, `windows-2025-vs2026`,
  `windows-11-arm`, `windows-11-vs2026-arm`.
- macOS: `macos-14`, `macos-15`, `macos-26`, `xcode-27`,
  `macos-15-intel`, `macos-26-intel`.

Preview rows may report experimental failures during normal development. A
release candidate should receive a deliberate manual sweep, and all stable
runner families must pass before the release tag is created.
