# AGENTS

## Purpose

- Composite GitHub Action that frees disk space on `ubuntu-latest` runners by removing optional preinstalled software and caches.
- Main implementation lives in `action.yml` and is intended to run early in a workflow.
- Supports `cleanup-profile` modes (`custom` and `max`) plus `skip-components` to keep specific toolchains.

## Repository Map

- `action.yml`: Action metadata, inputs, and all cleanup logic.
- `.github/workflows/test.yml`: CI matrix tests; each run enables exactly one removal input and verifies expected state.
- `README.md`: User-facing usage and caveats.

## Scripts / Execution Surfaces

- There are no standalone repo scripts (`scripts/`, `package.json`, Makefile, etc.).
- Effective execution surfaces are:
  - GitHub Action runtime in `action.yml` (bash blocks under `runs.steps[*].run`).
  - CI workflow steps in `.github/workflows/test.yml`.

## Development Notes

- Environment assumptions: GitHub-hosted Ubuntu runner, `bash`, `sudo`, `apt-get`, `docker` available.
- Operations are destructive (`rm -rf`, package purges, swap disable/removal). Keep changes tightly scoped and idempotent.
- The action uses parallel cleanup jobs and temporary progress files in `/tmp` (`/tmp/total_ops`, `/tmp/completed_ops`, `/tmp/component_flags.env`).
- Inputs default to `'false'`; CI validates behavior one input at a time via matrix.
- When changing removal targets, update both:
  - `action.yml` removal logic
  - `.github/workflows/test.yml` verification checks

## Important Caveats

- Intended only for runners with disk pressure; can break builds if required toolchains are removed.
- Use as an early workflow step so reclaimed space is available before expensive steps.
