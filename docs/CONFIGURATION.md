# Configuration reference

All inputs are optional. `cleanup-profile` defaults to `max`; every `remove-*` input defaults to `"false"`. The action detects the runner platform and does not schedule an otherwise enabled component when that component does not apply to the platform.

## Global inputs

| Input | Default | Behavior |
| --- | --- | --- |
| `cleanup-profile` | `max` | `max` enables applicable components except those in `skip-components`; `custom` uses only `remove-*` inputs. Valid values are `max` and `custom`. |
| `skip-components` | empty | Comma-separated component IDs to preserve when `cleanup-profile=max`. Names are case-insensitive and whitespace is ignored; unknown names fail before cleanup. |
| `swapfile-size` | empty | Optional privileged-Linux swap size. Omit to leave swap unchanged. |

### Profile and skip semantics

With `max`, every component applicable to the detected platform is selected unless its component ID is skipped. With `custom`, a component is selected only when its input is exactly `"true"`; `skip-components` is accepted but ignored.

- Skipping `browsers` protects `chrome`, `chromium`, `edge`, `firefox`, `webdrivers`, and `selenium`. Skipping one child disables only the broad `browsers` operation so unprotected siblings can still run.
- Skipping `cached-tools` protects its toolcache children. Skipping a toolcache child, or `codeql`, `dotnet`, `haskell`, `swift`, `julia`, or `java`, disables broad `cached-tools` cleanup so the protected toolcache owner is retained.
- Skipping a protected component that overlaps Linux `large-packages` disables that broad legacy package purge.
- When `docker-engine` is selected, its removal covers `docker-images`; the action does not start a daemon to run a redundant image prune.
- On Windows, skipping `visual-studio` preserves its definition-owned Android, .NET, vcpkg, and Windows SDK payloads. Skipping one of those payloads blocks broad Visual Studio removal while allowing unrelated cleanup.
- On macOS, broad Homebrew removal in `max` runs only when `homebrew` is selected and no Homebrew-owned component is skipped. The owner IDs are `browsers`, `chrome`, `edge`, `firefox`, `webdrivers`, `selenium`, `aws-cli`, `aws-sam-cli`, `azure-cli`, `gh-cli`, `kubectl`, `helm`, `kind`, `maven`, `gradle`, `ant`, `php`, `rust`, and `nginx`. Skipping any owner prevents broad Homebrew removal; enabled owners instead use their narrower definition-listed Homebrew operations, so retained packages are not removed by the broad operation.

### `swapfile-size`

`swapfile-size` is independent of profile selection and works only on a privileged Linux VM. `0` removes `/mnt/swapfile`; positive values create or replace it. Accepted examples include `512MiB`, `2G`, `1.5GiB`, and a plain GiB value such as `2`. Positive values must be at least 1 MiB and fit signed 64-bit byte arithmetic. Invalid values, unprivileged/container Linux, macOS, and Windows fail before cleanup and leave existing swap unchanged. A failed replacement is fatal and rolls back.

## Component inputs

Set an input to `"true"` to select its component in `custom`. In `max`, the same input values are not needed because applicable components are selected by default. Platform applicability below is the component registry's source of truth; an applicable component can still be absent from a particular image.

| Input | Component ID | Platforms | Effect |
| --- | --- | --- | --- |
| `remove-dotnet` | `dotnet` | Linux, macOS, Windows | Removes installed .NET SDKs, runtimes, and user tools. |
| `remove-android` | `android` | Linux, macOS, Windows | Removes the Android SDK and Android user caches. |
| `remove-haskell` | `haskell` | Linux, Windows | Removes GHCup, GHC, Cabal, and Stack artifacts where installed. |
| `remove-codeql` | `codeql` | Linux, macOS, Windows | Removes CodeQL Action bundles from the hosted toolcache. |
| `remove-cached-tools` | `cached-tools` | Linux, macOS, Windows | Removes and recreates the hosted setup-action toolcache. |
| `remove-swift` | `swift` | Linux | Removes standalone Swift toolchain files on Linux; does not remove Xcode. |
| `remove-julia` | `julia` | Linux, Windows | Removes Julia binaries, libraries, and cached versions where installed. |
| `remove-java` | `java` | Linux, macOS, Windows | Removes installed JDKs and Java toolcache entries. |
| `remove-powershell` | `powershell` | Linux, macOS, Windows | Removes PowerShell where it is safely separable from the runner. |
| `remove-miniconda` | `miniconda` | Linux, Windows | Removes Miniconda and its user caches where installed. |
| `remove-homebrew` | `homebrew` | Linux, macOS | Runs conservative Linuxbrew cleanup or removes definition-listed macOS packages without deleting either prefix. |
| `remove-vcpkg` | `vcpkg` | Linux, macOS, Windows | Removes the runner-image vcpkg installation and user caches. |
| `remove-cached-go` | `cached-go` | Linux, macOS, Windows | Removes Go toolcache entries. |
| `remove-cached-node` | `cached-node` | Linux, macOS, Windows | Removes Node.js toolcache entries. |
| `remove-cached-python` | `cached-python` | Linux, macOS, Windows | Removes Python toolcache entries. |
| `remove-cached-pypy` | `cached-pypy` | Linux, Windows | Removes PyPy toolcache entries. |
| `remove-cached-ruby` | `cached-ruby` | Linux, macOS, Windows | Removes Ruby toolcache entries. |
| `remove-browsers` | `browsers` | Linux, macOS, Windows | Removes supported major browsers, webdrivers, and Selenium artifacts. |
| `remove-chrome` | `chrome` | Linux, macOS, Windows | Removes Google Chrome where installed. |
| `remove-chromium` | `chromium` | Linux | Removes Chromium where installed. |
| `remove-edge` | `edge` | Linux, macOS, Windows | Removes Microsoft Edge where installed. |
| `remove-firefox` | `firefox` | Linux, macOS, Windows | Removes Firefox where installed. |
| `remove-webdrivers` | `webdrivers` | Linux, macOS, Windows | Removes ChromeDriver, GeckoDriver, and Edge WebDriver artifacts. |
| `remove-selenium` | `selenium` | Linux, macOS, Windows | Removes Selenium server artifacts. |
| `remove-aws-cli` | `aws-cli` | Linux, macOS, Windows | Removes AWS CLI v2 and the Session Manager plugin. |
| `remove-aws-sam-cli` | `aws-sam-cli` | Linux, macOS, Windows | Removes AWS SAM CLI. |
| `remove-azure-cli` | `azure-cli` | Linux, macOS, Windows | Removes Azure CLI. |
| `remove-gh-cli` | `gh-cli` | Linux, macOS, Windows | Removes GitHub CLI. |
| `remove-gcloud-cli` | `gcloud-cli` | Linux | Removes Google Cloud CLI/SDK where installed. |
| `remove-azcopy` | `azcopy` | Linux, macOS, Windows | Removes AzCopy. |
| `remove-kubectl` | `kubectl` | Linux, macOS, Windows | Removes kubectl. |
| `remove-helm` | `helm` | Linux, macOS, Windows | Removes Helm. |
| `remove-kind` | `kind` | Linux, macOS, Windows | Removes kind. |
| `remove-minikube` | `minikube` | Linux, Windows | Removes Minikube where installed. |
| `remove-kustomize` | `kustomize` | Linux, Windows | Removes Kustomize where installed. |
| `remove-docker-engine` | `docker-engine` | Linux, Windows | Stops and removes Docker Engine packages, helpers, and data where installed. |
| `remove-buildah` | `buildah` | Linux | Removes Buildah where installed. |
| `remove-podman` | `podman` | Linux | Removes Podman and its runner storage where installed. |
| `remove-maven` | `maven` | Linux, macOS, Windows | Removes Apache Maven. |
| `remove-gradle` | `gradle` | Linux, macOS, Windows | Removes Gradle. |
| `remove-ant` | `ant` | Linux, macOS, Windows | Removes Apache Ant. |
| `remove-php` | `php` | Linux, macOS, Windows | Removes PHP, Composer, and PHPUnit where installed. |
| `remove-rust` | `rust` | Linux, macOS, Windows | Removes Rustup, Cargo, and Rust toolchains. |
| `remove-postgresql` | `postgresql` | Linux, Windows | Removes PostgreSQL packages and runner data where installed. |
| `remove-mysql` | `mysql` | Linux, Windows | Removes MySQL/MariaDB packages and runner data where installed. |
| `remove-apache` | `apache` | Linux, Windows | Removes Apache HTTP Server where installed. |
| `remove-nginx` | `nginx` | Linux, macOS, Windows | Removes Nginx where installed. |
| `remove-docker-images` | `docker-images` | Linux, Windows | Removes unused Docker containers, images, build cache, networks, and volumes. |
| `remove-large-packages` | `large-packages` | Linux | Purges the legacy set of additional large apt packages on Linux. |
| `remove-xcode` | `xcode` | macOS | Removes unselected versioned Xcode applications while preserving the selected Xcode. |
| `remove-visual-studio` | `visual-studio` | Windows | Removes eligible runner-image Visual Studio instances through the registered installer. |
| `remove-windows-sdk` | `windows-sdk` | Windows | Removes definition-listed Windows SDK/WDK components through the Visual Studio installer. |

## Outputs

| Output | Description |
| --- | --- |
| `available-bytes-before` | Available bytes on the runner system volume before cleanup. |
| `available-bytes-after` | Available bytes on the runner system volume after cleanup. |
| `reclaimed-bytes` | Net additional available bytes after cleanup. |
| `failed-operations` | Number of best-effort cleanup operations that reported failure. |
| `platform` | Detected platform: `linux`, `macos`, or `windows`. |
| `architecture` | Detected architecture: `x64` or `arm64`. |

## Failure behavior

The action fails before mutation for invalid `cleanup-profile` or `skip-components` values, unsupported runner identities and containers, incompatible runner-image metadata, and invalid or unsupported swap requests. Swap failures and failures to stop a required service are also fatal because continuing could leave the machine in an unsafe state. On macOS, when Homebrew cleanup or a Homebrew-owned component is selected, Homebrew configuration validation and preparation are fatal preflight requirements; a failure stops cleanup.

Ordinary component cleanup is best-effort. The action records `removed`, `not-found`, `unsupported`, and `failed` results; ordinary failures do not stop later operations, are emitted as warnings, and increase `failed-operations`.
