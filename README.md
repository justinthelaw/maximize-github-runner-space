# Maximize GitHub Runner Space

Reclaim disk space on standard GitHub-hosted Linux, macOS, and Windows runners
before a disk-heavy build, test, or Docker image build. The action detects
the runner platform and architecture automatically.

> [!WARNING]
> This action is intentionally destructive. It removes preinstalled tools,
> SDKs, services, and caches. Run it on a fresh hosted runner before repository
> code or other privileged steps. Start with `custom`, and remove only tools
> that later steps do not need.

## Quick start

The examples pin the commit behind `v0.12.2`, the latest published release.
Behavior documented on `main` may not be released yet.

For a new workflow, use `custom` and opt in one component at a time. This
example assumes the job does not use Android or CodeQL:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Free runner space
        id: cleanup
        uses: justinthelaw/maximize-github-runner-space@ab8cbab7abef3d8a2565cc7827c22ffd462202be # v0.12.2
        with:
          cleanup-profile: custom
          remove-android: "true"
          remove-codeql: "true"
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: echo "Reclaimed ${{ steps.cleanup.outputs.reclaimed-bytes }} bytes"
      - run: ./build.sh
```

After the job passes, `max` can reclaim more. List every component the job must
keep. This example keeps Java, browsers, and all existing Docker state; replace
that list with the tools your job needs:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Free runner space
        uses: justinthelaw/maximize-github-runner-space@ab8cbab7abef3d8a2565cc7827c22ffd462202be # v0.12.2
        with:
          cleanup-profile: max
          skip-components: java,browsers,docker-engine,docker-images
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: ./build.sh
```

Run cleanup before checkout when possible, and always before creating build
outputs or caches you want to keep. If checkout must run first, pin it, disable
credential persistence, and do not execute repository code before cleanup.
Quote `remove-*` values: `custom` enables a component only when its value is
exactly `"true"`.

## Profiles at a glance

| Profile  | What it removes                                                                  |
| -------- | -------------------------------------------------------------------------------- |
| `custom` | Only `remove-*` inputs set to `"true"`. Recommended for a new job.               |
| `max`    | Every applicable component except IDs in `skip-components`. This is the default. |

`swapfile-size` is independent of the profile. Omit it to leave swap unchanged,
set it to `0` to remove `/mnt/swapfile`, or set a positive size when a build
needs swap on a privileged Linux VM. Creating or enlarging swap uses disk space
and can reduce `available-bytes-after`.

Important `max` caveats:

- Windows: can remove PowerShell 7, the default shell for later `run` steps.
- macOS: can remove unselected Xcode installations.
- Linux and Windows: can remove Docker and all runner Docker data.
- Windows base-image Edge is preserved; its separate WebDriver can be removed.

See the [component table](docs/CONFIGURATION.md#component-inputs) for IDs to
remove or preserve.

## Runner support

Supported: standard ephemeral GitHub-hosted Ubuntu, Windows, and macOS runners,
plus `ubuntu-slim`. Self-hosted runners, larger runners, and arbitrary job
containers are not supported. `not-found` means a cleanup target was safely
confirmed absent. `unsupported` means the recognized runner cannot safely
perform that operation, so its target can remain. A missing required cleanup
utility or incomplete inventory fails closed.

Before cleanup, the action checks fixed runner-image metadata and validates the
complete plan. Destructive commands use fixed executable paths, restricted
environments, bounded inventories, and removal checks. A command timeout stops
all later cleanup.

This is a safety boundary for a fresh hosted runner, not a sandbox or signed
runner attestation. See [runner support](docs/RUNNER-SUPPORT.md) for exact
labels, platform limits, and the full safety boundary.

## Outputs

| Output                   | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `available-bytes-before` | Available bytes on the runner system volume before cleanup.  |
| `available-bytes-after`  | Available bytes on the runner system volume after cleanup.   |
| `reclaimed-bytes`        | Increase in available bytes after cleanup; `0` if none.      |
| `failed-operations`      | `0` when cleanup succeeds. A cleanup failure fails the step. |
| `platform`               | Detected platform: `linux`, `macos`, or `windows`.           |
| `architecture`           | Detected architecture: `x64` or `arm64`.                     |

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
