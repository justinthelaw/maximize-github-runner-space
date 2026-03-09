# Maximize GitHub Runner Space

Free up disk space on `ubuntu-latest` GitHub-hosted runners before your heavy build, test, or container jobs start.

This action removes optional preinstalled SDKs, toolchains, and caches so your workflow has more space for what it actually needs.

> [!WARNING]
> This action is intentionally destructive. It can remove tools your later steps expect.
> Run it early and only remove components you do not need.

## Why use this action?

GitHub-hosted Ubuntu runners often start with many gigabytes consumed by preinstalled software. That is convenient for general use, but it can block large workflows (for example, Docker image builds, Android/iOS builds, or large monorepo test runs).

This action helps by:

- Reporting disk usage before and after cleanup.
- Supporting a safe `custom` mode (opt in only what to remove).
- Supporting an aggressive `max` mode (remove almost everything, with optional skips).
- Running cleanup tasks in parallel to reduce runtime.

## Quick start

Use this action near the top of your job, right after checkout.

### Option A: Maximum cleanup (with selective skips)

```yaml
name: CI
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Free runner space
        uses: justinthelaw/maximize-github-runner-space@master
        with:
          cleanup-profile: max
          skip-components: java,browsers

      - name: Continue with your build
        run: echo "Build steps go here"
```

### Option B: Custom cleanup (explicit toggles)

```yaml
name: CI
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Free runner space
        uses: justinthelaw/maximize-github-runner-space@master
        with:
          cleanup-profile: custom
          remove-android: 'true'
          remove-codeql: 'true'
          remove-cached-tools: 'true'
          remove-docker-images: 'true'

      - name: Continue with your build
        run: echo "Build steps go here"
```

## How cleanup profiles work

### `cleanup-profile: custom` (default)

- Default behavior.
- Nothing is removed unless a `remove-*` input is set to `'true'`.
- Best choice when you want precise control.

### `cleanup-profile: max`

- Enables all cleanup components.
- Use `skip-components` to keep specific tools.
- Best choice when disk pressure is severe and you know exactly what must remain installed.

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

| Input | Default | Description |
| --- | --- | --- |
| `cleanup-profile` | `custom` | Cleanup mode: `custom` or `max`. |
| `skip-components` | `` | Comma-separated components to keep when `cleanup-profile=max`. |
| `remove-dotnet` | `false` | Remove .NET runtime and libraries (~2 GB). |
| `remove-android` | `false` | Remove Android SDKs and tools (~9 GB). |
| `remove-haskell` | `false` | Remove GHC (Haskell) artifacts (~5 GB). |
| `remove-codeql` | `false` | Remove CodeQL action bundles (~5 GB). |
| `remove-cached-tools` | `false` | Remove setup-action tool cache (~8 GB). |
| `remove-swapfile` | `false` | Disable and remove swapfile (~4 GB). |
| `remove-swift` | `false` | Remove Swift toolchain files (~2–3 GB). |
| `remove-julia` | `false` | Remove Julia binaries and libraries (~1 GB). |
| `remove-java` | `false` | Purge OpenJDK packages (~1–2 GB). |
| `remove-browsers` | `false` | Purge browsers and webdriver packages (~1+ GB). |
| `remove-powershell` | `false` | Purge the PowerShell package. |
| `remove-docker-images` | `false` | Remove cached Docker images (~3 GB). |
| `remove-large-packages` | `false` | Purge additional large apt packages (~3 GB). |

## Practical guidance

- **Run early**: put this before dependency restore/build/test steps.
- **Start with `custom`**: remove only what you know you do not need.
- **Move to `max` carefully**: use `skip-components` to preserve required toolchains.
- **Expect tool loss**: later steps may fail if they rely on removed software.

## Compatibility

- Designed for **GitHub-hosted Ubuntu runners**.
- Uses system tools such as `bash`, `sudo`, `apt-get`, and `docker`.
- Not intended for Windows or macOS runners.

## For maintainers and contributors

Development and release process details live in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Security, support, and license

- Security policy: [docs/SECURITY.md](docs/SECURITY.md)
- Support guidance: [docs/SUPPORT.md](docs/SUPPORT.md)
- License: [LICENSE](LICENSE)
