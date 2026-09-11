# @diplodoc/infra Release Preparation

> **Story:** T1.3 — Sync Infra Workflows
> **Current version:** 2.2.3
> **Expected next version:** 2.3.0 (minor bump — includes `feat` commits)
> **Date:** 2026-08-23

---

## 1. Overview

This document describes the release preparation for the next stable version
of `@diplodoc/infra`. It covers:

1. **Sync verification** — infra's own workflows match the scaffolding templates.
2. **Release changes** — what is included in this release.
3. **Release process** — how release-please and the publish/distribute pipelines work.
4. **Distribution matrix** — all 28 target repositories and their per-repo settings.
5. **Post-release verification** — steps to confirm successful rollout.

---

## 2. Sync Verification

The infra repository maintains two copies of every workflow template:

| Copy            | Path                                  | Purpose                           |
| --------------- | ------------------------------------- | --------------------------------- |
| **Scaffolding** | `scaffolding/.github/workflows/*.yml` | Distributed to all consumer repos |
| **Infra's own** | `.github/workflows/*.yml`             | Used by the infra repo itself     |

Both copies **must be identical**. The following verification was performed:

| Workflow                | Scaffolding ↔ Own | Status                |
| ----------------------- | ----------------- | --------------------- |
| `coverage.yml`          | `diff` empty      | ✅ Synced             |
| `package-lock.yml`      | `diff` empty      | ✅ Synced             |
| `dependency-review.yml` | `diff` empty      | ✅ Synced             |
| `release.yml`           | `diff` empty      | ✅ Synced (unchanged) |
| `release-please.yml`    | `diff` empty      | ✅ Synced (unchanged) |
| `security.yml`          | `diff` empty      | ✅ Synced (unchanged) |
| `tests.yml`             | `diff` empty      | ✅ Synced (unchanged) |
| `update-deps.yml`       | `diff` empty      | ✅ Synced (unchanged) |
| `auto-approve.yml`      | `diff` empty      | ✅ Synced (unchanged) |

All YAML files validated with `js-yaml`. All 109 infra tests pass.

---

## 3. Release Changes

The following changes are included in this release (all currently uncommitted
in the infra working tree, ready for the release PR):

### 3.1. Workflow Template Changes (from T1.2)

#### `coverage.yml`

- **Allow same-repo Dependabot PRs:** The SonarCloud scan and token validation
  now run when `github.event.pull_request.head.repo.full_name == github.repository`,
  which is true for Dependabot PRs (same-repo branches) and false for fork PRs.
- **Early secret validation:** A new `Validate SonarCloud token` step checks
  that `SONAR_TOKEN` is non-empty before the scan step, emitting `::error` and
  exiting 1 if it is missing. This replaces the old silent-skip behavior.
- **Comment update:** Comments now explicitly describe the distinction between
  Actions secrets and Dependabot secrets.

#### `package-lock.yml`

- **Allow same-repo Dependabot PRs:** The `if` condition
  `github.event.pull_request.head.repo.full_name == github.repository`
  allows Dependabot PRs while still skipping fork PRs.
- **Early secret validation:** A new `Validate bot token` step checks that
  `YC_UI_BOT_GITHUB_TOKEN` is non-empty before checkout, emitting `::error`
  and exiting 1 if it is missing.
- **Comment update:** Comments now explicitly describe the distinction between
  Actions secrets and Dependabot secrets.

### 3.2. New Workflow (from T6.4)

#### `dependency-review.yml`

- **Purpose:** Runs `actions/dependency-review-action@v4` on every pull request
  to check for vulnerable dependencies and denylisted licenses.
- **Configuration:** `fail-on-severity: high` (blocks high + critical), license
  checks enabled with `deny-licenses` for copyleft licenses (AGPL, GPL, LGPL, SSPL).
- **Required check:** Auto-discovered by `sync-ci-gate.js` as a required status
  check (not in `exclude_checks` in `distribution.yml`).

### 3.3. New File (from T4.1)

#### `dependency-policy.yml`

- Central dependency policy registry with `schema-version: "1.0"`.
- Contains `DEP-0001` entry for `svgo` (pinned `3.3.2` in `cli` and `transform`)
  with all mandatory fields: `reason`, `owner`, `evidence`, `verification-profile`,
  `review-after`, `expires-at`, `exit-criteria`.
- No indefinite exceptions (all entries have `expires-at`).

### 3.4. Documentation

#### `README.md`

- Updated the SonarCloud setup section to mention the Dependabot secret and
  link to the new `docs/dependabot-secrets.md` runbook.

#### `docs/dependabot-secrets-runbook.md` (from T1.1)

- Runbook for adding org-level Dependabot secrets (`SONAR_TOKEN`,
  `YC_UI_BOT_GITHUB_TOKEN`) with the 28-repo visibility list.

#### `docs/dependabot-secrets.md`

- Short note linking to the full runbook.

### 3.5. Commit Message Conventions

Release-please uses [Conventional Commits](https://www.conventionalcommits.org/)
to determine the version bump. The recommended commit messages for this release:

| Type   | Scope  | Example message                                                                   |
| ------ | ------ | --------------------------------------------------------------------------------- |
| `feat` | ci     | `feat(ci): allow same-repo Dependabot PRs in coverage and package-lock workflows` |
| `feat` | ci     | `feat(ci): add dependency-review workflow for vulnerability and license checks`   |
| `feat` | policy | `feat(policy): add dependency-policy.yml registry with DEP-0001 (svgo)`           |
| `docs` | —      | `docs: update README with Dependabot secret instructions`                         |

At least one `feat` commit → **minor version bump** (2.2.3 → 2.3.0).

---

## 4. Release Process

The infra repo uses [release-please](https://github.com/googleapis/release-please)
for automated versioning and releases. The full pipeline is:

```
  Changes merged to master
          │
          ▼
  release-please.yml
  (creates release PR with version bump + CHANGELOG)
          │
          ▼
  Merge release PR
          │
          ▼
  GitHub Release created (tag vX.Y.Z)
          │
          ├──────────────────┐
          ▼                  ▼
  release.yml           distribute-infra.yml
  (npm publish)         (PRs to 27 target repos)
```

### 4.1. Step-by-Step

1. **Commit changes** to the infra repo's master branch:

   ```bash
   cd devops/infra
   git add -A
   git commit -m "feat(ci): allow same-repo Dependabot PRs in coverage and package-lock workflows"
   git commit -m "feat(ci): add dependency-review workflow for vulnerability and license checks"
   git commit -m "feat(policy): add dependency-policy.yml registry with DEP-0001 (svgo)"
   git commit -m "docs: update README with Dependabot secret instructions"
   ```

2. **Release-please creates a release PR** automatically on push to `master`:
   - Bumps `package.json` version (2.2.3 → 2.3.0)
   - Updates `.release-please-manifest.json`
   - Updates `CHANGELOG.md`
   - Opens a PR titled `chore(master): release 2.3.0`

3. **Merge the release PR** (reviewers: `@diplodoc-platform/team`):
   - This creates a git tag `v2.3.0` and a GitHub Release.
   - The release must be a **stable** release (not prerelease, not draft) for
     distribution to proceed.

4. **`release.yml` triggers** on the `release` event:
   - Verifies `package.json` version matches the release tag.
   - Runs `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.
   - Publishes to npm: `npm publish --provenance --access public`.
   - Requires `NPM_TOKEN` secret.

5. **`distribute-infra.yml` triggers** on the `release` event:
   - Waits for `@diplodoc/infra@2.3.0` to appear on the npm registry
     (polls up to 10 minutes).
   - Builds the repo list from `distribution.yml` (27 repos).
   - For each repo (matrix, `max-parallel: 5`):
     1. Clones the target repo (shallow).
     2. Runs `node bin/infra.js sync --target ./target --repo <name> --config ./distribution.yml`.
     3. Updates `@diplodoc/infra` version in `package.json`.
     4. Refreshes `package-lock.json` (`npm install --package-lock-only --ignore-scripts`).
     5. If changes detected: commits, pushes branch `infra/update-v2.3.0`,
        creates PR, auto-approves via `diplodoc-bot`, enables auto-merge.
   - Generates a summary table in the workflow run.

### 4.2. Secrets Required

| Secret                   | Store                | Used by                                  | Purpose                                      |
| ------------------------ | -------------------- | ---------------------------------------- | -------------------------------------------- |
| `NPM_TOKEN`              | Actions              | `release.yml`                            | Publish to npmjs.org                         |
| `INFRA_APP_ID`           | Actions              | `distribute-infra.yml`                   | GitHub App for PR creation                   |
| `INFRA_APP_PRIVATE_KEY`  | Actions              | `distribute-infra.yml`                   | GitHub App private key                       |
| `INFRA_APPROVER_PAT`     | Actions              | `distribute-infra.yml`                   | diplodoc-bot PAT for auto-approve            |
| `YC_UI_BOT_GITHUB_TOKEN` | Actions + Dependabot | `release-please.yml`, `package-lock.yml` | Bot token for release PRs + lockfile commits |
| `SONAR_TOKEN`            | Actions + Dependabot | `coverage.yml`                           | SonarCloud scan                              |

> **Note:** `SONAR_TOKEN` and `YC_UI_BOT_GITHUB_TOKEN` must exist in **both**
> the Actions secret store and the Dependabot secret store under the same name.
> See `docs/dependabot-secrets-runbook.md` for the setup procedure.

---

## 5. Distribution Matrix

The distribution covers **28 repositories**: 27 listed in `distribution.yml`
plus the `infra` repo itself (which is the source, not a consumer).

### 5.1. Distribution Target Repos (27)

| #   | Repository                   | Category  | `auto_merge`     | `exclude` | CI-gate excludes                                        |
| --- | ---------------------------- | --------- | ---------------- | --------- | ------------------------------------------------------- |
| 1   | `cli`                        | package   | `true` (default) | —         | —                                                       |
| 2   | `client`                     | package   | `true`           | —         | —                                                       |
| 3   | `components`                 | package   | `true`           | —         | `Create GitHub Comment`, `deploy`, `update-screenshots` |
| 4   | `directive`                  | package   | `true`           | —         | —                                                       |
| 5   | `liquid`                     | package   | `true`           | —         | —                                                       |
| 6   | `sentenizer`                 | package   | `true`           | —         | —                                                       |
| 7   | `transform`                  | package   | `true`           | —         | —                                                       |
| 8   | `translation`                | package   | `true`           | —         | —                                                       |
| 9   | `utils`                      | package   | `true`           | —         | —                                                       |
| 10  | `yfmlint`                    | package   | `true`           | —         | —                                                       |
| 11  | `vsc`                        | package   | `true`           | —         | —                                                       |
| 12  | `ajv`                        | package   | `true`           | —         | —                                                       |
| 13  | `algolia-extension`          | extension | `true`           | —         | —                                                       |
| 14  | `color-extension`            | extension | `true`           | —         | —                                                       |
| 15  | `cut-extension`              | extension | `true`           | —         | —                                                       |
| 16  | `file-extension`             | extension | `true`           | —         | —                                                       |
| 17  | `folding-headings-extension` | extension | `true`           | —         | —                                                       |
| 18  | `html-extension`             | extension | `true`           | —         | —                                                       |
| 19  | `latex-extension`            | extension | `true`           | —         | —                                                       |
| 20  | `mermaid-extension`          | extension | `true`           | —         | —                                                       |
| 21  | `openapi-extension`          | extension | `true`           | —         | —                                                       |
| 22  | `page-constructor-extension` | extension | `true`           | —         | —                                                       |
| 23  | `quote-link-extension`       | extension | `true`           | —         | —                                                       |
| 24  | `search-extension`           | extension | `true`           | —         | —                                                       |
| 25  | `tabs-extension`             | extension | `true`           | —         | —                                                       |
| 26  | `package-template`           | devops    | `true`           | —         | —                                                       |
| 27  | `testpack`                   | devops    | `false`          | —         | —                                                       |

### 5.2. Source Repository (1)

| #   | Repository | Role                                                                                  |
| --- | ---------- | ------------------------------------------------------------------------------------- |
| 28  | `infra`    | Source — not a distribution consumer; receives changes directly via merge to `master` |

### 5.3. Per-Repo Exclusions

No repository has any path-level `exclude` entries in `distribution.yml`.
All 27 consumer repos will receive the full scaffolding set, including the
new `dependency-review.yml` workflow.

The `testpack` repo has `auto_merge: false`, meaning its distribution PR will
be created but **not** auto-approved or auto-merged — a human must review and
merge it manually.

### 5.4. CI Gate Contexts

The `sync-ci-gate.js` script auto-discovers required status checks from
workflow YAML files. Every job in a workflow that triggers on `pull_request`
becomes a required check unless matched by `exclude_checks`.

Global `exclude_checks` (applied to all repos):

| Pattern                | Workflow               | Reason                                |
| ---------------------- | ---------------------- | ------------------------------------- |
| `SonarCloud*`          | `sonarcloud.yml`       | Runs only when coverage was generated |
| `release-please*`      | `release-please.yml`   | Release PRs, not a PR gate            |
| `Update Dependencies*` | `update-deps.yml`      | Manual dispatch                       |
| `Distribute*`          | `distribute-infra.yml` | Distribution workflow (infra only)    |
| `Publish*`             | `release.yml`          | Runs on release/tag                   |
| `Dependabot*`          | `dependabot.yml`       | Dependabot checks, not CI gate        |
| `auto-approve*`        | `auto-approve.yml`     | Infra meta-workflow                   |

The new `Dependency Review` job (from `dependency-review.yml`) is **not** in
`exclude_checks`, so it will automatically become a required check on all 27
consumer repos after distribution.

---

## 6. Post-Release Verification

After the release and distribution complete:

1. **Check the distribution summary** in the `Distribute Infrastructure`
   workflow run — verify all 27 repos show ✅ Updated or ⊘ Skipped (none ❌ Failed).

2. **Verify npm publication:**

   ```bash
   npm view @diplodoc/infra@2.3.0 version
   ```

3. **Verify a sample consumer repo** (e.g. `cli`) received the updates:
   - `.github/workflows/coverage.yml` contains the `Validate SonarCloud token` step.
   - `.github/workflows/package-lock.yml` contains the `Validate bot token` step.
   - `.github/workflows/dependency-review.yml` exists.
   - `package.json` has `@diplodoc/infra` at `2.3.0` (or `^2.3.0`).

4. **Verify CI gate** includes `Dependency Review` as a required check:

   ```bash
   gh api repos/diplodoc-platform/cli/rules/branches/master --jq '.[] | .required_status_checks.contexts[]' | grep -i dependency
   ```

5. **Test a Dependabot PR** (on a consumer repo) to confirm:
   - `coverage.yml` runs (not skipped) and the `Validate SonarCloud token` step passes.
   - `package-lock.yml` runs (not skipped) and the `Validate bot token` step passes.
   - `dependency-review.yml` runs and reports dependency review results.

6. **Test a fork PR** (on a consumer repo) to confirm:
   - `coverage.yml` skips SonarCloud scan (fork PR, no secrets).
   - `package-lock.yml` is skipped entirely (fork PR condition).
   - `dependency-review.yml` still runs (it does not check for secrets).

---

## 7. Rollback

If the release causes issues:

1. **Deprecate the version:**

   ```bash
   # Via the release.yml workflow (workflow_dispatch, type=deprecate)
   # Or manually:
   npm deprecate @diplodoc/infra@2.3.0 "Rolled back — see issue"
   ```

2. **Revert the merge** in affected consumer repos (close distribution PRs).

3. **Pin to previous version** in consumer repos:

   ```bash
   npm install --save-dev @diplodoc/infra@2.2.3
   ```

4. **Revert the changes** in the infra repo and cut a new release (2.3.1 or 2.2.4).
