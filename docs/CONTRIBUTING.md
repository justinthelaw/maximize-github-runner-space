# Contributing

Thanks for contributing to Justin's GitHub Action projects.

## Ground Rules

- Keep changes narrowly scoped.
- Preserve safety around destructive cleanup behavior.
- Update docs and tests whenever input behavior changes.

## Development Workflow

1. Branch from `master`.
2. Make focused changes in `action.yml` and matching test assertions in `.github/workflows/test.yml`.
3. Run checks locally.
4. Open a pull request with validation notes.

## Validation

Run before pushing:

```bash
pre-commit run --all-files
```

For logic changes, verify test matrix expectations in `.github/workflows/test.yml` still match behavior.

## Pre-commit

Install hooks once per clone:

```bash
pre-commit install --hook-type pre-commit --hook-type pre-push
```

## Pull Request Expectations

- Explain behavior impact and risk.
- Call out removed paths/packages and expected space savings.
- Confirm docs and tests were updated.
