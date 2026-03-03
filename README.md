# Maximize GitHub Runner Space

Forked from [easimon's maximize-build-space action](https://github.com/easimon/maximize-build-space).
Inspiration and additional cleanup ideas from [AdityaGarg8/remove-unwanted-software](https://github.com/AdityaGarg8/remove-unwanted-software).

Public GitHub-hosted `ubuntu-latest` runners ship with many preinstalled SDKs and tools. This action removes selected components to reclaim disk for large builds/tests.

## What this action does

- Reports disk space before/after cleanup.
- Removes selected preinstalled toolchains, packages, caches, Docker artifacts, and optional swap.
- Runs independent cleanup tasks in parallel with progress reporting.

## Supported cleanup modes

- `cleanup-profile: custom` (default): uses per-component `remove-*` flags.
- `cleanup-profile: max`: enables all cleanup components, then honors `skip-components`.

`skip-components` accepts a comma-separated list of component IDs:

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

## Usage

Run this action early in your job (typically before expensive install/build steps).

### Max cleanup with selective skips

```yaml
- name: Maximize runner disk
  uses: justinthelaw/maximize-github-runner-space@master
  with:
    cleanup-profile: max
    skip-components: java,browsers
```

### Custom cleanup (explicit toggles)

```yaml
- name: Maximize runner disk
  uses: justinthelaw/maximize-github-runner-space@master
  with:
    remove-android: 'true'
    remove-codeql: 'true'
    remove-cached-tools: 'true'
    remove-docker-images: 'true'
```

## Inputs

```yaml
cleanup-profile:
  description: "Cleanup mode: custom or max"
  default: "custom"

skip-components:
  description: "Comma-separated components to skip when cleanup-profile=max"
  default: ""

remove-dotnet:         # ~2 GB
remove-android:        # ~9 GB
remove-haskell:        # ~5 GB
remove-codeql:         # ~5 GB
remove-cached-tools:   # ~8 GB
remove-swapfile:       # ~4 GB
remove-swift:          # ~2-3 GB
remove-julia:          # ~1 GB
remove-java:           # ~1-2 GB
remove-browsers:       # ~1+ GB
remove-powershell:
remove-docker-images:  # ~3 GB
remove-large-packages: # ~3 GB
```

## Caveats

- This action is intentionally destructive (`rm -rf`, `apt-get purge`, Docker prune, swap disable).
- Removing dependencies your workflow needs will break subsequent steps.
- Runner images evolve; paths/packages may change over time.

## Upstream runner docs (latest references)

- GitHub-hosted runners reference: <https://docs.github.com/actions/reference/runners/github-hosted-runners>
- Runner images repository: <https://github.com/actions/runner-images>
- Current Ubuntu 24.04 software inventory: <https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md>
