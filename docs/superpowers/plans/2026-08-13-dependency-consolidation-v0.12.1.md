# Dependency Consolidation v0.12.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one reviewable branch that contains every currently open dependency PR, verified dependency state, and documentation prepared for the v0.12.1 release.

**Architecture:** Start from `main`, preserve both open Dependabot heads in one consolidation branch, then make only repository-wide dependency and release-documentation edits. The committed `dist/` bundle remains synchronized with `src/`; no runtime behavior changes are introduced.

**Tech Stack:** Git, GitHub connector, Node.js 24/npm 11, TypeScript, Node test runner, Prettier, ncc, pre-commit, GitHub Actions.

## Global Constraints

- Include all open PRs found in `justinthelaw/maximize-github-runner-space` at the start of the task.
- Update all declared dependency ecosystems that are stale; retain exact lockfile reproducibility.
- Keep the TypeScript 7 build compatible with ncc by compiling TypeScript to JavaScript before bundling.
- Change planned-release documentation references from `v0.12.0`/`0.12.0` to `v0.12.1`/`0.12.1` while preserving historical `v0.11.0` migration context.
- Keep destructive action behavior unchanged.
- Run the repository validation commands from `AGENTS.md` before publishing.
- Do not close superseded PRs until the replacement branch is pushed and its PR is created.
- Do not claim completion without fresh local and GitHub verification evidence.

---

### Task 1: Create the consolidation branch and merge open PRs

**Files:**
- Modify: none initially; merge commits will include the PR-owned files.

**Interfaces:**
- Consumes: `main`, `origin/dependabot/github_actions/github-actions-5c183d6ffa`, and `origin/dependabot/npm_and_yarn/javascript-action-f07d571036`.
- Produces: `agent/consolidate-dependencies-v0.12.1` containing both PR diffs.

- [ ] **Step 1: Create the branch from the current default branch**

```bash
git switch -c agent/consolidate-dependencies-v0.12.1 main
```

- [ ] **Step 2: Merge PR #45 without flattening its history**

```bash
git merge --no-ff origin/dependabot/github_actions/github-actions-5c183d6ffa \
  -m "Merge PR #45: update actions/setup-node"
```

Expected changed file: `.github/workflows/test.yml`.

- [ ] **Step 3: Merge PR #46 without flattening its history**

```bash
git merge --no-ff origin/dependabot/npm_and_yarn/javascript-action-f07d571036 \
  -m "Merge PR #46: update TypeScript dependencies"
```

Expected changed files: `package.json` and `package-lock.json`.

- [ ] **Step 4: Verify both PR diffs are present**

```bash
git diff --stat main...HEAD
git diff -- .github/workflows/test.yml package.json | sed -n '1,220p'
```

Expected: setup-node is pinned to the PR #45 SHA/comment, TypeScript is 7.0.2, and Node types are 26.2.0.

---

### Task 2: Record the plan and update release-facing dependency documentation

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-dependency-consolidation-v0.12.1.md`
- Modify: `README.md`
- Modify: `docs/RUNNER-SUPPORT.md`
- Modify: `docs/MIGRATIONS.md`
- Modify: `package.json`
- Create: `tsconfig.build.json`
- Modify: dependency manifests only if verification finds a stale declared version.

**Interfaces:**
- Consumes: merged dependency state from Task 1.
- Produces: docs whose current planned-release references use v0.12.1 and a lockfile matching manifests.

- [ ] **Step 1: Update planned-release references**

Replace only the current planned-release references:

```text
v0.12.0 -> v0.12.1
0.12.0  -> 0.12.1
```

Do not rewrite historical `v0.11.0` references or the historical `0.11.x -> 0.12.0` migration heading.

- [ ] **Step 2: Check declared dependency versions against the merged lockfile**

```bash
node -e "const p=require('./package.json'); console.log(JSON.stringify({dependencies:p.dependencies,devDependencies:p.devDependencies},null,2))"
node -e "const p=require('./package-lock.json'); console.log(JSON.stringify(p.packages[''],null,2))"
```

Expected: manifests and lockfile agree; no unrelated dependency is downgraded.

- [ ] **Step 3: Keep the TypeScript 7 and ncc build boundary explicit**

The ncc TypeScript loader is not compatible with the TypeScript 7 compiler API. Compile source files with `tsconfig.build.json` into `build/action`, then bundle `build/action/index.js` with ncc. Keep the test `tsconfig.json` unchanged so tests continue to compile into `build/test`.

- [ ] **Step 4: Check the version-reference scope**

```bash
rg -n --hidden -g '!node_modules' -g '!.git' 'v0\\.12\\.0|0\\.12\\.0' README.md docs
```

Expected: no planned-release reference remains; any retained historical reference is explicitly justified in the diff.

---

### Task 3: Run local validation

**Files:**
- Modify: `dist/` only if `npm run check-dist` proves the committed bundle is stale.

**Interfaces:**
- Consumes: the complete consolidation branch.
- Produces: fresh local evidence for typechecking, tests, formatting, bundle parity, and pre-commit checks.

- [ ] **Step 1: Install locked dependencies without lifecycle scripts**

```bash
npm ci --ignore-scripts
```

- [ ] **Step 2: Run tests and formatting checks**

```bash
npm test
npm run format:check
```

Expected: exit code 0 and no test failures or formatting changes.

- [ ] **Step 3: Verify the committed action bundle**

```bash
npm run check-dist
```

Expected: generated `dist/` matches the committed bundle.

- [ ] **Step 4: Run repository pre-commit validation**

```bash
pre-commit run --all-files --hook-stage pre-push
```

Expected: every configured hook passes.

- [ ] **Step 5: Inspect the final local diff**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: no whitespace errors and only consolidation, dependency, plan, and release-documentation changes.

---

### Task 4: Publish one review PR and retire superseded PRs

**Files:**
- Modify: remote branch `agent/consolidate-dependencies-v0.12.1`.
- Create: one GitHub pull request targeting `main`.
- Close: PRs #45 and #46 after the replacement PR exists.

**Interfaces:**
- Consumes: verified branch and validation evidence from Task 3.
- Produces: one open, ready-for-review PR with a complete validation summary.

- [ ] **Step 1: Commit the plan, docs, and any dependency corrections**

```bash
git add .
git commit -m "chore: consolidate dependencies for v0.12.1"
```

- [ ] **Step 2: Push the branch**

```bash
git push -u origin agent/consolidate-dependencies-v0.12.1
```

- [ ] **Step 3: Create the replacement PR**

Use the GitHub connector with base `main`, head `agent/consolidate-dependencies-v0.12.1`, and a body that lists the two superseded PRs plus every local validation command and result.

- [ ] **Step 4: Close PRs #45 and #46**

Close them through the GitHub connector only after the replacement PR URL and head SHA are confirmed.

- [ ] **Step 5: Mark the replacement PR ready for review**

If created as a draft, call the ready-for-review mutation and verify the PR is open, non-draft, and targets `main`.

---

### Task 5: Review, repair, and monitor the published PR

**Files:**
- Modify: only files required by verified CI failures or actionable review threads.

**Interfaces:**
- Consumes: replacement PR metadata, checks, reviews, and review threads.
- Produces: an open PR with all required checks green and no unresolved actionable review comments.

- [ ] **Step 1: Request a focused Codex code review of the final diff**

Review the diff from `main` to the PR head for dependency integrity, release-documentation correctness, lockfile reproducibility, and accidental behavior changes.

- [ ] **Step 2: Inspect GitHub checks and logs**

Use the GitHub connector for PR metadata/status and `gh` if available; otherwise use the connector's workflow-run and job-log surfaces. Distinguish queued/in-progress, failed, skipped, and external checks.

- [ ] **Step 3: Fix each actionable failure or comment with root-cause verification**

For every change, reproduce locally where possible, make the smallest fix, rerun affected checks, commit, and push.

- [ ] **Step 4: Repeat monitoring until stable**

Poll the PR head checks and unresolved review threads after each push. Stop only when checks are green, the Codex review has no actionable comments, and the PR remains ready for review.

---

### Task 6: Final handoff

**Files:**
- Modify: none.

**Interfaces:**
- Consumes: final remote PR state.
- Produces: a concise handoff with PR URL, branch, head SHA, validation evidence, and any residual external-check caveats.

- [ ] **Step 1: Verify final repository state**

Confirm the replacement PR is open, non-draft, based on `main`, all required checks are successful, PRs #45 and #46 are closed, and no unresolved actionable threads remain.

- [ ] **Step 2: Notify the user to review the replacement PR**

Include the exact PR link and a short summary of what was consolidated and validated.
