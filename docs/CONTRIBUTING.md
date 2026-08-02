# Contributing

Thanks for helping improve **Maximize GitHub Runner Space**.

This document is for action maintainers and contributors. If you only need to use the action, start in the root [README](/README.md).

## Project goals

- Keep cleanup behavior predictable and explicit.
- Keep dangerous/destructive operations tightly scoped.
- Keep docs and tests aligned with action behavior.

## Repository structure

- `action.yml`: Composite action inputs and cleanup implementation.
- `.github/workflows/test.yml`: Matrix tests for input behavior, max-profile skip behavior, and grouped/subgroup precedence interactions.
- `.github/workflows/lint.yml`: Pre-commit checks in CI.
- `README.md`: End-user usage and input documentation.
- `docs/MIGRATIONS.md`: Migration notes for breaking changes between releases.

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
   - Include targeted interaction coverage whenever you change grouped logic (`browsers` vs subcomponents, `cached-tools` vs per-language caches, or `max` + `skip-components` precedence).
3. Update the root `README.md` input docs/examples if behavior changed.
4. Update `docs/MIGRATIONS.md` if the change is breaking or materially alters defaults.

Important safety notes:

- This project intentionally runs destructive commands (`rm -rf`, apt purges, swap removal).
- Keep operations idempotent where possible.
- Avoid broad deletions outside expected runner paths.

## Validation checklist

Run before pushing:

```bash
pre-commit run --all-files --hook-stage pre-push
```

At minimum, ensure:

- Markdown and YAML lint pass.
- Workflow lint (`actionlint`) passes.
- Docs match current action inputs and behavior.

## Commit guidance

Use conventional-style commits when possible to keep project history and release notes clear:

- `feat:` for user-facing enhancements.
- `fix:` for bug fixes.
- `docs:` for documentation-only changes.
- `chore:` for maintenance tasks.

## Pull request expectations

Include in each PR:

- What changed and why.
- Any risk from removed packages/paths/toolchains.
- Validation results (`pre-commit run --all-files --hook-stage pre-push`).
- Documentation updates when behavior changed.
