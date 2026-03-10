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
          skip-components: java,browsers

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

### `cleanup-profile: custom`

- Nothing is removed unless a `remove-*` input is set to `'true'`.
- Best choice when you want precise control.

`skip-components` accepts a comma-separated list. Current component names:

- `dotnet`
- `android`
- `haskell`
- `codeql`
- `cached-tools`
- `swapfile`
- `swift`
- `julia`
- `java`
- `browsers`
- `powershell`
- `docker-images`
- `large-packages`

## Inputs reference

Estimated savings are based on the latest passing CI matrix runs for this repository and should be treated as directional guidance (runner image updates can shift these numbers over time).

| Input                   | Default | Description                                                    |
| ----------------------- | ------- | -------------------------------------------------------------- |
| `cleanup-profile`       | `max`   | Cleanup mode: `max` (default) or `custom`.                     |
| `skip-components`       | N/A     | Comma-separated components to keep when `cleanup-profile=max`. |
| `remove-dotnet`         | `false` | Remove .NET runtime and libraries (~1.5–2.0 GB).              |
| `remove-android`        | `false` | Remove Android SDKs and tools (~10–14 GB).                    |
| `remove-haskell`        | `false` | Remove GHC (Haskell) artifacts (~2–4 GB).                     |
| `remove-codeql`         | `false` | Remove CodeQL action bundles (~2–3 GB).                       |
| `remove-cached-tools`   | `false` | Remove setup-action tool cache (~5–8 GB).                     |
| `remove-swapfile`       | `false` | Disable and remove swapfile (~4 GB).                          |
| `remove-swift`          | `false` | Remove Swift toolchain files (~2.0–2.5 GB).                   |
| `remove-julia`          | `false` | Remove Julia binaries and libraries (~300–700 MB).            |
| `remove-java`           | `false` | Purge OpenJDK packages (~1.0–1.5 GB).                         |
| `remove-browsers`       | `false` | Purge browsers and webdriver packages (~1.5–2.0 GB).          |
| `remove-powershell`     | `false` | Purge the PowerShell package (~150–250 MB).                   |
| `remove-docker-images`  | `false` | Remove cached Docker images (~3–6 GB).                        |
| `remove-large-packages` | `false` | Purge additional large apt packages (~1–3 GB).                |

## Compatibility

- Designed for **GitHub-hosted Ubuntu runners**.
- Uses system tools such as `bash`, `sudo`, `apt-get`, and `docker`.
- Not intended for Windows or macOS runners.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for development and release workflow details.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the security policy and reporting guidance.

## Support

See [docs/SUPPORT.md](docs/SUPPORT.md) for help and support guidance.

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
