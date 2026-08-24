# Configuration reference

All inputs are optional. With no inputs, the action uses the aggressive `max`
profile. For a new workflow, start with `custom` and enable one removal at a
time. The action detects the runner platform automatically.

## Global inputs

| Input             | Default | Behavior                                                                                                                                                       |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanup-profile` | `max`   | `max` enables applicable components except those in `skip-components`; `custom` uses only `remove-*` inputs. Valid values are `max` and `custom`.              |
| `skip-components` | empty   | Comma-separated component IDs to preserve when `cleanup-profile=max`. Names are case-insensitive and whitespace is ignored; unknown names fail before cleanup. |
| `swapfile-size`   | empty   | Optional privileged-Linux swap size. Omit to leave swap unchanged.                                                                                             |

### Profile and skip semantics

With `max`, every applicable component is selected unless its ID appears in
`skip-components`. With `custom`, only a `remove-*` value that is exactly
`"true"` selects a component. Skip names are still validated with `custom`, but
they do not change component selection.

Some broad components overlap narrower ones. Preservation always wins:

| If you preserve...                            | The action also preserves...                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `browsers`                                    | Chrome, Chromium, Edge, Firefox, WebDrivers, and Selenium.                                                    |
| One browser child                             | That child; unrelated browser children may still be removed.                                                  |
| `cached-tools`                                | Every hosted-toolcache child.                                                                                 |
| A toolcache owner or child                    | The broad cache operation that could remove it. Owners include CodeQL, .NET, Haskell, Swift, Julia, and Java. |
| A component covered by Linux `large-packages` | The broad legacy package purge.                                                                               |
| A Windows Visual Studio payload               | Broad Visual Studio removal. Payloads include Android, .NET, vcpkg, and Windows SDK/WDK.                      |
| A macOS Homebrew-owned component              | Broad Homebrew package removal; that owner's Homebrew package survives.                                       |
| `homebrew` on macOS                           | Every Homebrew command. Non-Homebrew paths for other selected components can still be cleaned.                |

On Windows, preserving `visual-studio` also preserves its Android, .NET,
vcpkg, and SDK/WDK payloads, including standalone SDK/WDK bundles. The macOS
Homebrew-owned IDs are `browsers`, `chrome`, `edge`, `firefox`, `webdrivers`,
`selenium`, `aws-cli`, `aws-sam-cli`, `azure-cli`, `gh-cli`, `kubectl`, `helm`,
`kind`, `maven`, `gradle`, `ant`, `php`, `rust`, and `nginx`.

Docker Engine removal in `custom` also deletes all runner Docker data. In `max`,
skipping `docker-images` preserves the data root, but still removes the engine.
Skip both `docker-engine` and `docker-images` to keep usable Docker state. When
Engine removal owns the data root, the action skips the redundant prune.

Linux package cleanup removes selected runner-image packages and clears the apt
download cache. It does not run global `apt autoremove`.

### `swapfile-size`

`swapfile-size` is separate from profile selection:

- Omit it to leave swap unchanged.
- Use `0` to remove `/mnt/swapfile` and its matching `/etc/fstab` entry.
- Use a positive value to create or resize swap on a privileged Linux VM.
- Creating or enlarging swap consumes disk space and can reduce the available
  byte outputs.
- Examples: `512MiB`, `2G`, `1.5GiB`, or `2` (unitless means GiB).
- Units from K through T use binary, 1024-based multipliers. Whitespace and
  unit letter case are ignored.

Positive values must be at least 1 MiB and fit signed 64-bit byte arithmetic.
The input is limited to 128 characters and 64 numeric digits. Invalid values
and unsupported platforms fail before cleanup and leave existing swap
unchanged.

Swap changes are fatal transactions. The action observes kernel swap state,
changes swap through a held no-follow file descriptor, and reverses the kernel
change if the pathname identity drifts. It stages exact `fstab` content and
atomically exchanges it with the live file. If the result is ambiguous, it
never performs a second exchange: a later writer stays live and the original
file stays at the reported private recovery path. The action also keeps every
active swap and backing file needed by a possible live entry. Staging requires
protected `/mnt` and `/etc` parents, a readable bounded `fstab`, and unchanged
mount identities. A separately mounted swapfile or `fstab` is rejected. Each
private mode-`0600` temporary file is rechecked before mutation. Under that
protected-parent boundary, cleanup quarantines the captured inode first. A
replacement detected at that commit point is retained instead of deleted.

## Component inputs

Set an input to `"true"` to select its component in `custom`. In `max`, the same input values are not needed because applicable components are selected by default. Platform applicability below is the component registry's source of truth; an applicable component can still be absent from a particular image.

| Input                   | Component ID     | Platforms             | Effect                                                                                                                             |
| ----------------------- | ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `remove-dotnet`         | `dotnet`         | Linux, macOS, Windows | Removes installed .NET SDKs, runtimes, and user tools.                                                                             |
| `remove-android`        | `android`        | Linux, macOS, Windows | Removes the Android SDK and Android user caches.                                                                                   |
| `remove-haskell`        | `haskell`        | Linux, Windows        | Removes GHCup, GHC, Cabal, and Stack artifacts where installed.                                                                    |
| `remove-codeql`         | `codeql`         | Linux, macOS, Windows | Removes CodeQL Action bundles from the hosted toolcache.                                                                           |
| `remove-cached-tools`   | `cached-tools`   | Linux, macOS, Windows | Removes and recreates the hosted setup-action toolcache.                                                                           |
| `remove-swift`          | `swift`          | Linux                 | Removes standalone Swift toolchain files on Linux; does not remove Xcode.                                                          |
| `remove-julia`          | `julia`          | Linux, Windows        | Removes Julia binaries, libraries, and cached versions where installed.                                                            |
| `remove-java`           | `java`           | Linux, macOS, Windows | Removes installed JDKs and Java toolcache entries.                                                                                 |
| `remove-powershell`     | `powershell`     | Linux, macOS, Windows | Removes PowerShell where separable; preserves Windows all-users modules.                                                           |
| `remove-miniconda`      | `miniconda`      | Linux, Windows        | Removes Miniconda and its user caches where installed.                                                                             |
| `remove-homebrew`       | `homebrew`       | Linux, macOS          | Linux removes only `~/.cache/Homebrew`; macOS removes definition-listed packages. Neither Homebrew prefix is deleted.              |
| `remove-vcpkg`          | `vcpkg`          | Linux, macOS, Windows | Removes the runner-image vcpkg installation and user caches.                                                                       |
| `remove-cached-go`      | `cached-go`      | Linux, macOS, Windows | Removes Go toolcache entries.                                                                                                      |
| `remove-cached-node`    | `cached-node`    | Linux, macOS, Windows | Removes Node.js toolcache entries.                                                                                                 |
| `remove-cached-python`  | `cached-python`  | Linux, macOS, Windows | Removes Python toolcache entries.                                                                                                  |
| `remove-cached-pypy`    | `cached-pypy`    | Linux, Windows        | Removes PyPy toolcache entries.                                                                                                    |
| `remove-cached-ruby`    | `cached-ruby`    | Linux, macOS, Windows | Removes Ruby toolcache entries.                                                                                                    |
| `remove-browsers`       | `browsers`       | Linux, macOS, Windows | Removes supported major browsers, webdrivers, and Selenium artifacts.                                                              |
| `remove-chrome`         | `chrome`         | Linux, macOS, Windows | Removes Google Chrome where installed.                                                                                             |
| `remove-chromium`       | `chromium`       | Linux                 | Removes Chromium where installed.                                                                                                  |
| `remove-edge`           | `edge`           | Linux, macOS, Windows | Removes Microsoft Edge where safely separable. Windows base-image Edge is preserved; its separate WebDriver can be removed.        |
| `remove-firefox`        | `firefox`        | Linux, macOS, Windows | Removes Firefox where installed.                                                                                                   |
| `remove-webdrivers`     | `webdrivers`     | Linux, macOS, Windows | Removes ChromeDriver, GeckoDriver, Edge WebDriver, and IEDriver artifacts.                                                         |
| `remove-selenium`       | `selenium`       | Linux, macOS, Windows | Removes Selenium server artifacts.                                                                                                 |
| `remove-aws-cli`        | `aws-cli`        | Linux, macOS, Windows | Removes AWS CLI v2 and the Session Manager plugin.                                                                                 |
| `remove-aws-sam-cli`    | `aws-sam-cli`    | Linux, macOS, Windows | Removes AWS SAM CLI.                                                                                                               |
| `remove-azure-cli`      | `azure-cli`      | Linux, macOS, Windows | Removes Azure CLI.                                                                                                                 |
| `remove-gh-cli`         | `gh-cli`         | Linux, macOS, Windows | Removes GitHub CLI.                                                                                                                |
| `remove-gcloud-cli`     | `gcloud-cli`     | Linux                 | Removes Google Cloud CLI/SDK where installed.                                                                                      |
| `remove-azcopy`         | `azcopy`         | Linux, macOS, Windows | Removes AzCopy.                                                                                                                    |
| `remove-kubectl`        | `kubectl`        | Linux, macOS, Windows | Removes kubectl.                                                                                                                   |
| `remove-helm`           | `helm`           | Linux, macOS, Windows | Removes Helm.                                                                                                                      |
| `remove-kind`           | `kind`           | Linux, macOS, Windows | Removes kind.                                                                                                                      |
| `remove-minikube`       | `minikube`       | Linux, Windows        | Removes Minikube where installed.                                                                                                  |
| `remove-kustomize`      | `kustomize`      | Linux, Windows        | Removes Kustomize where installed.                                                                                                 |
| `remove-docker-engine`  | `docker-engine`  | Linux, Windows        | Stops and removes Docker Engine and helpers. Data is removed unless `docker-images` is preserved. Windows registration is removed. |
| `remove-buildah`        | `buildah`        | Linux                 | Removes Buildah where installed.                                                                                                   |
| `remove-podman`         | `podman`         | Linux                 | Removes Podman; shared Podman/Buildah storage is removed only when both components are selected.                                   |
| `remove-maven`          | `maven`          | Linux, macOS, Windows | Removes Apache Maven; preserves the shared Windows `C:\ProgramData\m2` cache.                                                      |
| `remove-gradle`         | `gradle`         | Linux, macOS, Windows | Removes Gradle.                                                                                                                    |
| `remove-ant`            | `ant`            | Linux, macOS, Windows | Removes Apache Ant.                                                                                                                |
| `remove-php`            | `php`            | Linux, macOS, Windows | Removes PHP, Composer, and PHPUnit where installed.                                                                                |
| `remove-rust`           | `rust`           | Linux, macOS, Windows | Removes Rustup, Cargo, and Rust toolchains.                                                                                        |
| `remove-postgresql`     | `postgresql`     | Linux, Windows        | Removes PostgreSQL packages, runner data, and exact Windows service registrations where installed.                                 |
| `remove-mysql`          | `mysql`          | Linux, Windows        | Linux removes MySQL/MariaDB packages and data; Windows uninstalls the runner-image MySQL CLI MSI.                                  |
| `remove-apache`         | `apache`         | Linux, Windows        | Removes Apache HTTP Server and its exact Windows service registration where installed.                                             |
| `remove-nginx`          | `nginx`          | Linux, macOS, Windows | Removes Nginx and its exact Windows service registration where installed.                                                          |
| `remove-docker-images`  | `docker-images`  | Linux, Windows        | Prunes unused Docker data when the engine is kept. Named volumes are retained. Engine removal covers this when both are selected.  |
| `remove-large-packages` | `large-packages` | Linux                 | Purges broad apt groups: .NET, LLVM, PHP, MongoDB/MySQL, cloud CLIs, browsers, PowerShell, Mono, and Mesa.                         |
| `remove-xcode`          | `xcode`          | macOS                 | Removes unselected versioned Xcode applications while preserving the selected Xcode.                                               |
| `remove-visual-studio`  | `visual-studio`  | Windows               | Removes eligible runner-image Visual Studio instances through the registered installer.                                            |
| `remove-windows-sdk`    | `windows-sdk`    | Windows               | Removes definition-listed Visual Studio SDK/WDK components and registered standalone SDK/WDK bundles.                              |

## Outputs

| Output                   | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `available-bytes-before` | Available bytes on the runner system volume before cleanup.  |
| `available-bytes-after`  | Available bytes on the runner system volume after cleanup.   |
| `reclaimed-bytes`        | Increase in available bytes after cleanup; `0` if none.      |
| `failed-operations`      | `0` when cleanup succeeds. A cleanup failure fails the step. |
| `platform`               | Detected platform: `linux`, `macos`, or `windows`.           |
| `architecture`           | Detected architecture: `x64` or `arm64`.                     |

Outputs are written after cleanup finishes. A cleanup failure can stop the
action before outputs are available.

## Failure behavior

Every cleanup failure stops later operations and fails the step. Common causes
include:

- invalid inputs or unsupported runner identity;
- incomplete package, service, or installer inventory needed by the plan;
- any command timeout;
- a failed swap transaction or required service stop;
- failure to recreate a selected broad toolcache as a writable directory;
- Windows installer exit `3010` (restart required) or `1641` (restart
  initiated); and
- unsafe macOS Homebrew or Docker configuration isolation.

The action never continues after a Windows installer requests or starts a
restart. A preflight-only failure restores reversible service state. Once
package or filesystem cleanup may have started, services stay stopped to avoid
restarting a partly removed installation. If a timed-out process cannot be
confirmed dead, rollback does not start because it could race that process.

`not-found` means a target was safely confirmed absent. `unsupported` means the
recognized runner cannot safely perform that cleanup, so the target can remain.
See [runner support](RUNNER-SUPPORT.md#safety-and-result-semantics) for service
latching, traversal bounds, concurrency limits, and the complete safety model.
