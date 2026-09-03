# Contributing

For action use and configuration, start with the root [README](../README.md)
and [configuration reference](CONFIGURATION.md).

## Prerequisites

Development requires Node.js 22 or newer, npm, and pre-commit. Create a branch
from `main`, install locked dependencies, then install the hooks:

```bash
pre-commit install --hook-type pre-commit --hook-type pre-push
```

## Repository map

- `action.yml`: public action metadata, inputs, outputs, and runtime entrypoint.
- `src/`: planning, safety, reporting, and platform adapters.
- `test/`: deterministic unit and contract coverage.
- `dist/`: committed bundle consumed by GitHub Actions.
- `.github/workflows/`: quality, representative smoke, and compatibility runs.
- `docs/CONFIGURATION.md`, `docs/RUNNER-SUPPORT.md`, and `docs/MIGRATIONS.md`:
  public configuration, support, and migration references.

## Safety rules

- Keep destructive targets bounded by runner context, package metadata, or
  pinned runner-image definitions; never infer broad paths or home identities.
- Preserve filesystem-root, home, workspace, action, runtime, and unsafe-link
  boundaries. Stop services before deleting live data.
- Update deterministic tests and representative smoke coverage when cleanup
  behavior changes. Test grouped-component and `max`/`skip-components`
  interactions directly.
- Keep `action.yml`, public documentation, support labels, compatibility
  workflow coverage, and the runtime image-data registry aligned. Rebuild
  `dist/` when source changes it.

## Required validation

Run before pushing:

```bash
npm ci --ignore-scripts
npm test
npm run format:check
npm run check-dist
pre-commit run --all-files --hook-stage pre-push
```

## Pull request expectations

Use a conventional-style commit where practical. Describe the change and its
runner/toolchain risk, include validation results, and update documentation
when public behavior changes.

## Release gate

Before publishing a release, require green PR CI, completed automated review,
the manually dispatched seven-class default-max matrix, and the 18-label
bounded compatibility sweep. The scheduled compatibility run remains bounded;
default `max` release validation runs only on fresh runners from a manual
dispatch. Its `generated-dist` job is an explicit dependency of the no-input
default-max jobs, ensuring they use the committed bundle on fresh runners.
Each destructive smoke must assert numeric outputs and zero failed operations.
