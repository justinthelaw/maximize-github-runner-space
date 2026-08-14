# Maximize GitHub Runner Space

Reclaim disk space on standard GitHub-hosted Linux, macOS, and Windows runners
before a large build, test, or container job. The action detects the runner
platform and architecture automatically.

> [!WARNING]
> This action is intentionally destructive. It removes preinstalled tools,
> SDKs, services, and caches that later workflow steps might need. Run it near
> the start of a job and explicitly retain every component your workflow uses.

## Quick start

Calling the action without `with:` uses the aggressive `max` profile, which
removes every applicable component unless it is protected.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Free runner space
        uses: justinthelaw/maximize-github-runner-space@v0.12.1
        with:
          skip-components: java,browsers,docker-engine,docker-images
          swapfile-size: 2GiB
      - run: ./build.sh
```

For a new workflow, begin with the conservative `custom` profile and opt in
only to components you have measured as disposable:

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
        uses: justinthelaw/maximize-github-runner-space@v0.12.1
        with:
          cleanup-profile: custom
          remove-codeql: "true"
          remove-cached-go: "true"
      - run: echo "Reclaimed ${{ steps.cleanup.outputs.reclaimed-bytes }} bytes"
```

Quote `remove-*` values: `custom` selects a component only when its input is
exactly the string `"true"`.

## Profiles at a glance

- `max` is the default. It enables all components that apply to the detected
  platform, except component IDs listed in `skip-components`.
- `custom` enables only the `remove-*` inputs set to `"true"`; it ignores
  `skip-components` for compatibility.
- `swapfile-size` is separate from both profiles. It is supported only on a
  privileged Linux VM; omit it to leave swap unchanged.

`max` can remove the default PowerShell 7 shell on Windows, unselected Xcode
installations on macOS, and Docker data or build tools on Linux and Windows.
Use `custom` first on a new platform integration, or protect required tools
with `skip-components`.

## Runner support

The action supports ephemeral standard GitHub-hosted Ubuntu, Windows, and
macOS runner images, including the supported x64 and arm64 families. It also
supports GitHub's `ubuntu-slim` container with capability-aware cleanup; that
environment cannot manage swap, mounts, or a Docker daemon.

Self-hosted runners, larger runners, and arbitrary job containers are outside
the support contract. The action validates the fixed runner-image metadata
before it schedules cleanup. A component absent from a supported image is
reported as a no-op or unsupported result rather than an error.

See [runner support](docs/RUNNER-SUPPORT.md) for the exact supported-label
matrix, platform caveats, and image-drift policy.

## Outputs

| Output | Meaning |
| --- | --- |
| `available-bytes-before` | Available bytes on the runner system volume before cleanup. |
| `available-bytes-after` | Available bytes on the runner system volume after cleanup. |
| `reclaimed-bytes` | Net additional available bytes after cleanup. |
| `failed-operations` | Number of best-effort cleanup operations that failed. |
| `platform` | Detected platform: `linux`, `macos`, or `windows`. |
| `architecture` | Detected architecture: `x64` or `arm64`. |

## Documentation

- [Configuration reference](docs/CONFIGURATION.md): all inputs, component
  applicability, precedence, swap behavior, outputs, and failure semantics.
- [Runner support](docs/RUNNER-SUPPORT.md): supported labels, runtime image
  validation, platform constraints, and CI coverage.
- [Migration notes](docs/MIGRATIONS.md): actionable upgrade guidance.
- [Contributing](docs/CONTRIBUTING.md): local development and change guidance.
- [Security policy](docs/SECURITY.md): vulnerability reporting and disclosure.
- [Support](docs/SUPPORT.md): help and issue-routing guidance.
- [License](LICENSE): project license terms.
