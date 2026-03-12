# Maximize GitHub Runner Space

Free up disk space on `ubuntu-latest` GitHub-hosted runners before your heavy build, test, or container jobs start.

This action removes optional preinstalled SDKs, toolchains, and caches so your workflow has more space for what it actually needs.

> [!WARNING]
> This action is intentionally destructive. It can remove tools your later steps expect.
> Run it early and only remove components you do not need.

## Table of Contents

- [Why use this action?](#why-use-this-action)
- [Quick start](#quick-start)
- [Cleanup Profiles](#cleanup-profiles)
- [Inputs reference](#inputs-reference)
- [Compatibility](#compatibility)
- [Contributing](#contributing)
- [Migration Guide](#migration-guide)
- [Security](#security)
- [Support](#support)
- [License](#license)

## Why use this action?

GitHub-hosted Ubuntu runners often start with many gigabytes consumed by preinstalled software. That is convenient for general use, but it can block large workflows (for example, Docker image builds, Android/iOS builds, or large monorepo test runs).

This action helps by:

- Reporting disk usage before and after cleanup.
- Supporting an aggressive default `max` mode (remove almost everything, with optional skips).
- Supporting an opt-in `custom` mode (remove only selected components).
- Running cleanup tasks in parallel to reduce runtime.

## Quick start

Use this action near the top of your job, right after checkout, using one of the following [cleanup profiles](#cleanup-profiles):

### Option A: Maximum Cleanup (Default)

```yaml
name: CI
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Free Runner Space
        # NOTE: Use a specific tag or commit shasum for immutability
        uses: justinthelaw/maximize-github-runner-space@latest
        with:
          skip-components: java,browsers,docker-engine

      - name: Continue With Your Build
        run: echo "Build steps go here"
```

### Option B: Custom Cleanup

```yaml
name: CI
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Free Runner Space
        # NOTE: Use a specific tag or commit shasum for immutability
        uses: justinthelaw/maximize-github-runner-space@latest
        with:
          cleanup-profile: custom
          remove-android: "true"
          remove-codeql: "true"
          remove-cached-tools: "true"
          remove-docker-images: "true"

      - name: Continue With Your Build
        run: echo "Build steps go here"
```

## Cleanup Profiles

### `cleanup-profile: max`

- Default behavior.
- Enables all cleanup components.
- Use `skip-components` to keep specific tools.
- Best choice when disk pressure is severe and you know exactly what must remain installed.
- If you need Docker later in your job, keep `docker-engine`.

### `cleanup-profile: custom`

- Nothing is removed unless a `remove-*` input is set to `'true'`.
- Best choice when you want precise control.

`skip-components` accepts a comma-separated list. Current component names:

```text
dotnet
android
haskell
codeql
cached-tools
cached-go
cached-node
cached-python
cached-pypy
cached-ruby
swapfile
swift
julia
java
browsers
chrome
chromium
edge
firefox
webdrivers
selenium
powershell
miniconda
homebrew
vcpkg
aws-cli
aws-sam-cli
azure-cli
gh-cli
gcloud-cli
azcopy
kubectl
helm
kind
minikube
kustomize
docker-engine
buildah
podman
maven
gradle
ant
php
rust
postgresql
mysql
apache
nginx
docker-images
large-packages
```

## Inputs reference

All `remove-*` inputs are optional toggles. In `cleanup-profile: max`, every component below is enabled unless listed in `skip-components`.

### Profiles and global options

| Input             | Default | Description                                                    |
| ----------------- | ------- | -------------------------------------------------------------- |
| `cleanup-profile` | `max`   | Cleanup mode: `max` (default) or `custom`.                     |
| `skip-components` | N/A     | Comma-separated components to keep when `cleanup-profile=max`. |

### Component toggles

Each row lists the `remove-*` input, its `skip-components` name, and the primary removal targets.
For grouped areas like browsers and toolcache, listing a subcomponent in `skip-components` automatically disables the group removal so only non-skipped subcomponents are removed.

**Toolchains and SDKs**

| Input            | Component | Removes                                                                                          |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `remove-dotnet`  | `dotnet`  | `/usr/share/dotnet`, `/usr/lib/dotnet`, `/etc/dotnet`, toolcache `dotnet`, `~/.dotnet`           |
| `remove-android` | `android` | `/usr/local/lib/android`, `/usr/local/share/android`, `/opt/android*`, `~/.android`, `~/.gradle` |
| `remove-haskell` | `haskell` | `/opt/ghc`, `/usr/local/.ghcup`, toolcache `ghc`                                                 |
| `remove-swift`   | `swift`   | `/usr/share/swift`, `/usr/local/share/swift`, `/usr/lib/swift`, toolcache `swift`                |
| `remove-julia`   | `julia`   | `/usr/local/julia*`, `/usr/share/julia`, toolcache `Julia`                                       |
| `remove-java`    | `java`    | `openjdk-*` packages, `/usr/lib/jvm`, toolcache `Java`                                           |
| `remove-rust`    | `rust`    | `/usr/local/rustup`, `/usr/local/cargo`, `~/.cargo`, `~/.rustup`, `rustc/cargo` binaries         |

**Code scanning**

| Input           | Component | Removes                    |
| --------------- | --------- | -------------------------- |
| `remove-codeql` | `codeql`  | toolcache `CodeQL` bundles |

**Toolcache (global and per-language)**

| Input                  | Component       | Removes                                      |
| ---------------------- | --------------- | -------------------------------------------- |
| `remove-cached-tools`  | `cached-tools`  | Entire toolcache directory (recreated empty) |
| `remove-cached-go`     | `cached-go`     | toolcache `Go`                               |
| `remove-cached-node`   | `cached-node`   | toolcache `node`                             |
| `remove-cached-python` | `cached-python` | toolcache `Python`                           |
| `remove-cached-pypy`   | `cached-pypy`   | toolcache `PyPy`                             |
| `remove-cached-ruby`   | `cached-ruby`   | toolcache `Ruby`                             |

**Package managers**

| Input              | Component   | Removes                               |
| ------------------ | ----------- | ------------------------------------- |
| `remove-miniconda` | `miniconda` | `CONDA` root, `~/.conda`, conda cache |
| `remove-homebrew`  | `homebrew`  | `/home/linuxbrew`                     |
| `remove-vcpkg`     | `vcpkg`     | `/usr/local/share/vcpkg`              |

**Browsers and drivers**

| Input               | Component    | Removes                                                                 |
| ------------------- | ------------ | ----------------------------------------------------------------------- |
| `remove-browsers`   | `browsers`   | Chrome, Edge, Firefox, Chromium, webdrivers, Selenium artifacts         |
| `remove-chrome`     | `chrome`     | `google-chrome-stable` package, `/opt/google/chrome`, chrome binaries   |
| `remove-chromium`   | `chromium`   | `chromium-*` packages, `/usr/lib/chromium`, chromium binaries           |
| `remove-edge`       | `edge`       | `microsoft-edge-stable` package, `/opt/microsoft/msedge`, edge binaries |
| `remove-firefox`    | `firefox`    | `firefox` package/snap, `/usr/lib/firefox`, firefox binary              |
| `remove-webdrivers` | `webdrivers` | chromedriver, geckodriver, msedgedriver and driver dirs                 |
| `remove-selenium`   | `selenium`   | `/usr/share/java/selenium-server.jar`                                   |

**Cloud CLIs**

| Input                | Component     | Removes                                                                          |
| -------------------- | ------------- | -------------------------------------------------------------------------------- |
| `remove-aws-cli`     | `aws-cli`     | `/usr/local/aws-cli`, `aws` binary                                               |
| `remove-aws-sam-cli` | `aws-sam-cli` | `/usr/local/aws-sam-cli`, `sam` binary                                           |
| `remove-azure-cli`   | `azure-cli`   | `azure-cli` package, `/opt/az`, `az` binary                                      |
| `remove-gh-cli`      | `gh-cli`      | `gh` package and binary                                                          |
| `remove-gcloud-cli`  | `gcloud-cli`  | `google-cloud-*` packages, `/usr/lib/google-cloud-sdk`, `gcloud/gsutil` binaries |
| `remove-azcopy`      | `azcopy`      | `azcopy` binary                                                                  |

**Kubernetes and DevOps**

| Input              | Component   | Removes            |
| ------------------ | ----------- | ------------------ |
| `remove-kubectl`   | `kubectl`   | `kubectl` binary   |
| `remove-helm`      | `helm`      | `helm` binary      |
| `remove-kind`      | `kind`      | `kind` binary      |
| `remove-minikube`  | `minikube`  | `minikube` binary  |
| `remove-kustomize` | `kustomize` | `kustomize` binary |

**Containers**

| Input                  | Component       | Removes                                                            |
| ---------------------- | --------------- | ------------------------------------------------------------------ |
| `remove-docker-images` | `docker-images` | cached Docker images, build cache, volumes                         |
| `remove-docker-engine` | `docker-engine` | Docker packages, `/var/lib/docker`, `/etc/docker`, `docker` binary |
| `remove-buildah`       | `buildah`       | `buildah` package and binary                                       |
| `remove-podman`        | `podman`        | `podman` package and binary, `/var/lib/containers`                 |

**Project/build tools**

| Input           | Component | Removes                                                     |
| --------------- | --------- | ----------------------------------------------------------- |
| `remove-maven`  | `maven`   | `maven` package, `/usr/share/maven`, `mvn` binary           |
| `remove-gradle` | `gradle`  | `gradle` package, `/usr/share/gradle`, `gradle` binary      |
| `remove-ant`    | `ant`     | `ant` package, `/usr/share/ant`, `ant` binary               |
| `remove-php`    | `php`     | `php*` packages, composer/phpunit, `/etc/php`, `php` binary |

**Services and databases**

| Input               | Component    | Removes                                                          |
| ------------------- | ------------ | ---------------------------------------------------------------- |
| `remove-postgresql` | `postgresql` | `postgresql*` packages, `/var/lib/postgresql`, `/etc/postgresql` |
| `remove-mysql`      | `mysql`      | `mysql*/mariadb*` packages, `/var/lib/mysql`, `/etc/mysql`       |
| `remove-apache`     | `apache`     | `apache2*` packages, `/etc/apache2`, `/var/www`                  |
| `remove-nginx`      | `nginx`      | `nginx*` packages, `/etc/nginx`                                  |

**Misc**

| Input                   | Component        | Removes                                              |
| ----------------------- | ---------------- | ---------------------------------------------------- |
| `remove-powershell`     | `powershell`     | `powershell` package, `pwsh` binary                  |
| `remove-swapfile`       | `swapfile`       | swapfile at `/mnt/swapfile` and swap entry           |
| `remove-large-packages` | `large-packages` | Legacy bulk apt purge (overlaps with several inputs) |

## Compatibility

- Designed for **GitHub-hosted Ubuntu runners**.
- Uses system tools such as `bash`, `sudo`, `apt-get`, and `docker`.
- Not intended for Windows or macOS runners.

## Contributing

See [CONTRIBUTING guide](/docs/CONTRIBUTING.md) for development and release workflow details.

## Migration Guide

See [migration guide](/docs/MIGRATIONS.md) for breaking changes between releases.

## Security

See [security policy](/docs/SECURITY.md) for the security policy and reporting guidance.

## Support

See [support instructions](/docs/SUPPORT.md) for help and support guidance.

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
