# Runner support

This action supports ephemeral, standard GitHub-hosted runner images. It does not support self-hosted runners, GitHub-hosted larger runners, or arbitrary job containers. A larger runner using the same runner-image family can be indistinguishable at runtime, so it remains unsupported rather than a guaranteed rejection case.

## Supported runner families

| Environment class | Support | Important behavior |
| --- | --- | --- |
| Ubuntu x64 VM | Full and backward-compatible | Existing no-input `max`, component names, skips, and optional swap behavior remain supported. |
| Ubuntu arm64 VM | Full, capability-aware | Architecture-specific omissions are successful no-ops. |
| `ubuntu-slim` x64 container | Limited | Uses only available permissions and tools; swap, mounts, low-level kernel work, and Docker-daemon cleanup are unsupported. |
| Windows x64 VM | Full | Uses Windows-native package, service, path, and process handling. |
| Windows arm64 VM | Full, capability-aware | Components absent from the image are not errors. |
| macOS Intel VM | Full | Uses the Intel Homebrew layout and preserves the selected Xcode. |
| macOS arm64 VM | Full, capability-aware | Uses the Apple Silicon Homebrew layout and preserves the selected Xcode. |

"Full" means the runner family is safely supported; it does not mean every component is installed on every label. An applicable but absent component reports `not-found` or `unsupported`.

The scheduled/manual compatibility sweep exercises these exact labels:

<!-- compatibility-labels:start -->
- Linux: `ubuntu-slim`, `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04`,
  `ubuntu-22.04-arm`, `ubuntu-24.04-arm`, `ubuntu-26.04-arm`.
- Windows: `windows-2022`, `windows-2025`, `windows-2025-vs2026`,
  `windows-11-arm`, `windows-11-vs2026-arm`.
- macOS: `macos-14`, `macos-15`, `macos-26`, `xcode-27`,
  `macos-15-intel`, `macos-26-intel`.
<!-- compatibility-labels:end -->

GitHub's [standard public-runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) and [standard private-runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-private-repositories) tables are the authoritative current source for hosted-runner labels and resources. GitHub's `-latest` labels are moving aliases. Pin an explicit runner label when you need to control the operating-system image family, while recognizing that the installed image version can still change.

## Runtime image validation

The action does not authorize cleanup from workflow-overridable values such as `ImageOS`, `ImageVersion`, `HOME`, or a selected path. Before it initializes an adapter or package manager, it reads the fixed runner-images image-data record:

- Ubuntu: `/imagegeneration/imagedata.json`
- macOS: `/Users/runner/imagedata.json`
- Windows: `C:\imagedata.json`

For a VM, the record must be a single supported `Runner Image` identity whose label, numeric version, source branch, manifest path, operating system, and architecture agree. Missing, malformed, linked, oversized, duplicate, or mismatched records fail before cleanup. Container mode accepts only the runner-images `ubuntu:24.04` Docker identity used by `ubuntu-slim`; other job containers fail before mutation.

This check is compatibility evidence, not signed attestation. A prior privileged workflow step can alter local state, and the check cannot prove a runner's billing or size class.

## Platform constraints and destructive caveats

[`ubuntu-slim`](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#single-cpu-runners) is an unprivileged, minimal container with a 15-minute job timeout. Its missing inventory and Docker daemon are normal conditions; the action never creates swap or mounts there.

On Windows, `max` can remove PowerShell 7, the default shell for later workflow `run` steps. Protect `powershell`, use `custom`, or choose a remaining shell explicitly. Windows base-image Microsoft Edge is preserved and reported as unsupported, although its separately installed WebDriver can be removed.

On macOS, Xcode cleanup removes unselected versioned Xcode applications while preserving the Xcode selected by `xcode-select`. Homebrew cleanup verifies the architecture-specific executable and does not recursively delete either Homebrew prefix or unknown packages installed by earlier workflow steps.

On Linux, `swapfile-size` works only on a privileged VM. Container, macOS, and Windows requests fail before cleanup and leave existing swap unchanged. See the [configuration reference](CONFIGURATION.md#swapfile-size) for accepted values.

## Safety and result semantics

The complete cleanup plan is validated before its first mutation. Deletion targets are derived from runner context, native package metadata, resolved executables, or bounded runner-image definitions; protected roots and unsafe paths are rejected. On Linux, recursive removal also refuses any target that is a mount point or contains a mounted filesystem.

Invalid profile or component names, an unsupported runner identity, an invalid swap request, a failed swap transaction, and a required service stop failure are fatal. Swap replacement rolls back when it cannot safely complete. On macOS, selecting Homebrew cleanup or a Homebrew-owned component makes Homebrew configuration validation and preparation a fatal preflight requirement; failure stops cleanup.

Ordinary removal is best-effort for compatibility with existing workflows. Each operation reports `removed`, `not-found`, `unsupported`, or `failed`; the action continues after ordinary failures, emits a warning, and exposes their count through `failed-operations`.

## Image drift and CI coverage

Runner images change independently of action releases. Use `v0.12.3` as a readable release pin or a full action commit SHA as an immutable pin. Pinning an explicit runner label reduces surprises from `-latest`, but does not freeze GitHub's regularly refreshed image inventory. Track the official runner-images [latest-image migration process](https://github.com/actions/runner-images#latest-migration-process), [support policy](https://github.com/actions/runner-images#support-policy), and [available images](https://github.com/actions/runner-images#available-images). Treat an absent component as a normal image variation and re-measure reclaimed space after image changes.

Pull requests run deterministic quality checks, Ubuntu swap/skip coverage, and representative destructive smoke tests for the remaining runner families. Those smoke jobs assert the numeric output contracts and zero failed operations. The scheduled/manual compatibility workflow keeps the exact 18-label matrix above to bounded native-adapter cleanup; scheduled runs never execute default `max`. A manual dispatch also runs a fresh-runner, seven-class no-input default-max matrix covering `ubuntu-latest`, `ubuntu-24.04-arm`, `ubuntu-slim`, `windows-latest`, `windows-11-arm`, `macos-latest`, and `macos-15-intel`. The generated-dist job must pass before the dispatch-only default-max jobs start, so every default invocation exercises the committed bundle on a fresh runner.

A release requires green PR CI, completed automated review, the manual
seven-class default-max matrix, and the 18-label bounded compatibility sweep.
The project keeps component behavior and safety checks in fast tests rather
than running every component against every operating-system image.
