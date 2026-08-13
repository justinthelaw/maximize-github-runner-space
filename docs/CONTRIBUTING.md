# Contributing

Thanks for helping improve **Maximize GitHub Runner Space**.

This document is for action maintainers and contributors. If you only need to use the action, start in the root [README](/README.md).

## Project goals

- Keep cleanup behavior predictable and explicit.
- Keep dangerous/destructive operations tightly scoped.
- Keep docs and tests aligned with action behavior.

## Repository structure

- `action.yml`: Public action inputs, outputs, branding, and the Node runtime entrypoint.
- `src/`: TypeScript planning, safety, reporting, and native Linux, macOS, and Windows adapters.
- `test/`: Deterministic unit and contract tests for metadata, planning, platform behavior, and path safety.
- `dist/`: Committed JavaScript action bundle generated from `src/`.
- `scripts/check-dist.mjs`: Cross-platform verification that the generated
  bundle exactly matches committed `dist/` files.
- `.github/workflows/test.yml`: Pull-request quality, one ordered Ubuntu compatibility job, and representative platform tests.
- `.github/workflows/compatibility.yml`: Weekly/manual exact-label runner compatibility sweep.
- `.github/actions/platform-smoke/action.yml`: Shared bounded cleanup and output assertions used by both runner workflows.
- `.github/workflows/lint.yml`: Pre-commit checks in CI.
- `README.md`: End-user usage and input documentation.
- `docs/RUNNER-SUPPORT.md`: Runner-image research, supported labels, deletion-target evidence, and CI policy.
- `docs/MIGRATIONS.md`: Migration notes for breaking changes between releases.

## Local setup

Development requires Node.js 22 or newer and npm. CI deliberately runs the
quality gate on Node.js 22, the minimum version declared by `package.json`.

1. Create a branch from `main`.
2. Install locked dependencies with `npm ci --ignore-scripts`.
3. Install pre-commit.
4. Install hooks.

```bash
pre-commit install --hook-type pre-commit --hook-type pre-push
```

## Making changes safely

When you change cleanup behavior:

1. Update the relevant planning, safety, or platform adapter code in `src/`.
2. Add deterministic coverage in `test/` and update the representative hosted-runner checks in `.github/workflows/test.yml` when runtime behavior changes.
   - Include targeted interaction coverage whenever you change grouped logic (`browsers` vs subcomponents, `cached-tools` vs per-language caches, or `max` + `skip-components` precedence).
3. Update `.github/workflows/compatibility.yml` and `docs/RUNNER-SUPPORT.md` when supported labels, runner-image definitions, architecture differences, or bounded deletion targets change.
4. Update `action.yml` and the root `README.md` together for public input, output, or behavior changes.
5. Rebuild `dist/` and verify that the committed bundle exactly matches `src/`.
6. Update `docs/MIGRATIONS.md` if the change is breaking or materially alters defaults.

Important safety notes:

- This project intentionally runs destructive commands (`rm -rf`, apt purges, swap removal).
- Keep operations idempotent and capability-aware where possible.
- Derive targets from runner contexts, package metadata, or a cited runner-image definition; do not add broad paths or infer home identities that are absent from the cited definition.
- Preserve home, workspace, action, runtime, filesystem-root, and unsafe link boundaries.
- Keep package managers and service operations serialized, and stop services before deleting live data.

## Validation checklist

Run before pushing:

```bash
npm ci --ignore-scripts
npm test
npm run format:check
npm run check-dist
pre-commit run --all-files --hook-stage pre-push
```

At minimum, ensure:

- Markdown and YAML lint pass.
- Workflow lint (`actionlint`) passes.
- TypeScript compiles and all deterministic tests pass.
- `dist/` is current and contains no untracked generated files.
- Representative runner tests and the exact-label compatibility sweep remain aligned with the support contract.
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
