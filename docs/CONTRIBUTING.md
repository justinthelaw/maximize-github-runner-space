# Contributing

Thanks for helping improve **Maximize GitHub Runner Space**.

This document is for action maintainers and contributors. If you only need to use the action, start in the root [README](../README.md).

## Project goals

- Keep cleanup behavior predictable and explicit.
- Keep dangerous/destructive operations tightly scoped.
- Keep docs and tests aligned with action behavior.

## Repository structure

- `action.yml`: Composite action inputs and cleanup implementation.
- `.github/workflows/test.yml`: Matrix tests for input behavior and max-profile skip behavior.
- `.github/workflows/lint.yml`: Pre-commit checks in CI.
- `.github/workflows/release.yml`: Automated release PR and tagging flow.
- `release-please-config.json`: Release Please configuration.
- `.release-please-manifest.json`: Version manifest for Release Please.
- `README.md`: End-user usage and input documentation.

## Local setup

1. Create a branch from `main`.
2. Install pre-commit.
3. Install hooks.

```bash
pre-commit install --hook-type pre-commit --hook-type pre-push
```

## Making changes safely

When you change cleanup behavior:

1. Update cleanup logic in `action.yml`.
2. Update or extend verification logic in `.github/workflows/test.yml`.
3. Update the root `README.md` input docs/examples if behavior changed.

Important safety notes:

- This project intentionally runs destructive commands (`rm -rf`, apt purges, swap removal).
- Keep operations idempotent where possible.
- Avoid broad deletions outside expected runner paths.

## Validation checklist

Run before pushing:

```bash
pre-commit run --all-files
```

At minimum, ensure:

- Markdown and YAML lint pass.
- Workflow lint (`actionlint`) passes.
- Docs match current action inputs and behavior.

## Release process (Release Please)

This repository uses [release-please](https://github.com/googleapis/release-please-action) to automate release PRs and tagging.

### How it works

- Commits merge into `main`.
- The `release-please` workflow opens or updates a release PR.
- The release PR updates `CHANGELOG.md` and version metadata.
- Merging the release PR creates a GitHub release and tag.

### Conventional commit guidance

Use conventional-style commits when possible to generate clearer changelogs:

- `feat:` for user-facing enhancements.
- `fix:` for bug fixes.
- `docs:` for documentation-only changes.
- `chore:` for maintenance tasks.

## Pull request expectations

Include in each PR:

- What changed and why.
- Any risk from removed packages/paths/toolchains.
- Validation results (`pre-commit run --all-files`).
- Documentation updates when behavior changed.
