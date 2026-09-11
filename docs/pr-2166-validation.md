# PR #2166 Validation Checklist

> **Story:** T1.4 — Validate PR 2166
> **PR:** [diplodoc-platform/cli#2166](https://github.com/diplodoc-platform/cli/pull/2166)
> **PR title:** `chore(deps): bump js-yaml from 4.1.0 to 4.3.1`
> **PR branch:** `dependabot/npm_and_yarn/js-yaml-4.3.1`
> **Author:** Dependabot (`app/dependabot`)
> **Changed files:** `package.json`, `package-lock.json`
> **Date:** 2026-08-23

---

## 1. Purpose

This document defines the validation steps to confirm that the T1.1–T1.3
changes (Dependabot secrets, fixed workflow templates, and infra distribution)
resolve the CI failures on Dependabot PRs. PR #2166 in the `cli` repo is the
primary test case: it is a Dependabot PR that currently **fails** on two
workflows because the Dependabot secret store is empty and the `cli` repo has
not yet received the updated workflow templates.

### Current Failure State (pre-fix)

| Check                             | Status     | Failure reason                                                                                             |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `Test coverage`                   | ❌ fail    | `SONAR_TOKEN` is empty → SonarCloud scan returns "Not authorized or project not found"                     |
| `Update package-lock.json`        | ❌ fail    | `YC_UI_BOT_GITHUB_TOKEN` is empty → `actions/checkout` fails with "Input required and not supplied: token" |
| `Security audit`                  | ✅ pass    | No secret dependency                                                                                       |
| `test (ubuntu/macos/windows, 24)` | ✅ pass    | No secret dependency                                                                                       |
| `integration test (…)`            | ✅ pass    | No secret dependency                                                                                       |
| `auto-approve`                    | ⏭ skipping | Not applicable                                                                                             |

> **Root cause:** GitHub runs Dependabot PRs in an isolated context where
> regular Actions secrets are unavailable. The `SONAR_TOKEN` and
> `YC_UI_BOT_GITHUB_TOKEN` must exist in the **Dependabot secret store** (a
> separate store from Actions secrets). Additionally, the `cli` repo's
> `coverage.yml` and `package-lock.yml` are the **pre-T1.2** versions that
> lack the early secret-validation steps, so failures surface as confusing
> downstream errors instead of clear `::error` messages.

### Prerequisites

Before running validation, the following must be complete:

1. **T1.1 — Dependabot secrets configured** (manual, org-owner):
   - `SONAR_TOKEN` added to the org Dependabot secret store with `cli` in the
     selected-repositories list.
   - `YC_UI_BOT_GITHUB_TOKEN` added to the org Dependabot secret store with
     `cli` in the selected-repositories list.
   - See `docs/dependabot-secrets-runbook.md` for the procedure.

2. **T1.2 + T1.3 — Updated workflows distributed to `cli`**:
   - `@diplodoc/infra@2.3.0` released and distributed.
   - `cli` repo's `.github/workflows/coverage.yml` contains the
     `Validate SonarCloud token` step.
   - `cli` repo's `.github/workflows/package-lock.yml` contains the
     `Validate bot token` step.
   - Verify distribution landed:
     ```bash
     gh api repos/diplodoc-platform/cli/contents/.github/workflows/coverage.yml \
       --jq '.content' | base64 -d | grep "Validate SonarCloud token"
     gh api repos/diplodoc-platform/cli/contents/.github/workflows/package-lock.yml \
       --jq '.content' | base64 -d | grep "Validate bot token"
     ```

3. **Re-trigger PR #2166 CI** after secrets + distribution are in place:
   ```bash
   gh pr comment 2166 --repo diplodoc-platform/cli \
     --body "@dependabot rebase"
   ```
   (A rebase re-runs all CI checks against the updated workflows.)

---

## 2. Validation Scenarios

### Scenario 1 — Coverage passes with Sonar scan

**What:** The `coverage.yml` workflow should run `test:coverage`, upload the
coverage artifact, validate the SonarCloud token, and complete the Sonar scan
successfully on the Dependabot PR.

**Why it was failing:** `SONAR_TOKEN` was empty in the Dependabot context.
SonarCloud scan returned "Not authorized or project not found".

**Steps:**

- [ ] Re-trigger PR #2166 CI (rebase or close/reopen).
- [ ] Open the `Test coverage` check run:
      https://github.com/diplodoc-platform/cli/actions/workflows/coverage.yml
- [ ] Confirm the `Run tests with coverage` step completes (tests pass).
- [ ] Confirm the `Upload coverage artifact` step uploads `coverage/`.
- [ ] Confirm the `Validate SonarCloud token` step **passes** (token is
      non-empty — proves the Dependabot secret is wired).
- [ ] Confirm the `SonarCloud Scan` step completes with
      `EXECUTION SUCCESS` (no "Not authorized" error).
- [ ] Confirm the overall `Test coverage` check is ✅ pass on PR #2166.

**Verification commands:**

```bash
# Check the latest coverage run for PR #2166
gh run list --repo diplodoc-platform/cli \
  --workflow coverage.yml \
  --branch dependabot/npm_and_yarn/js-yaml-4.3.1 \
  --limit 1

# View the SonarCloud step log
gh run view <run-id> --repo diplodoc-platform/cli --log \
  | grep -E "SONAR_TOKEN|Not authorized|EXECUTION SUCCESS|Validate SonarCloud"
```

**Pass criteria:** `Test coverage` check is green; Sonar scan succeeds.

---

### Scenario 2 — package-lock workflow succeeds

**What:** The `package-lock.yml` workflow should check out the Dependabot
branch, validate the bot token, regenerate `package-lock.json`, and either
complete without changes (lockfile already normalized) or push the normalized
lockfile back to the same branch.

**Why it was failing:** `YC_UI_BOT_GITHUB_TOKEN` was empty. `actions/checkout`
failed with "Input required and not supplied: token" before any lockfile work.

**Steps:**

- [ ] Re-trigger PR #2166 CI (rebase or close/reopen).
- [ ] Open the `Update package-lock.json` check run:
      https://github.com/diplodoc-platform/cli/actions/workflows/package-lock.yml
- [ ] Confirm the `Validate bot token` step **passes** (token is non-empty —
      proves the Dependabot secret is wired).
- [ ] Confirm the `Checkout code` step succeeds (no "Input required: token"
      error).
- [ ] Confirm the `Regenerate package-lock.json` step runs
      `npm install --no-workspaces --package-lock-only --ignore-scripts`.
- [ ] Confirm the `Commit and push changes` step completes: - If lockfile unchanged: `::info::Nothing to update` → exit 0. - If lockfile changed: `::notice::Pushed amended lockfile commit` or
      a regular commit pushed to the branch.
- [ ] Confirm the overall `Update package-lock.json` check is ✅ pass on
      PR #2166.

**Verification commands:**

```bash
# Check the latest package-lock run for PR #2166
gh run list --repo diplodoc-platform/cli \
  --workflow package-lock.yml \
  --branch dependabot/npm_and_yarn/js-yaml-4.3.1 \
  --limit 1

# View the checkout + lockfile step logs
gh run view <run-id> --repo diplodoc-platform/cli --log \
  | grep -E "Validate bot token|Input required|Nothing to update|Pushed|package-lock"
```

**Pass criteria:** `Update package-lock.json` check is green; no token error.

---

### Scenario 3 — Internal PR still uses Actions secrets

**What:** A normal (non-Dependabot) internal PR should continue to work
exactly as before, using the Actions secret store. The workflow changes must
not regress internal-PR behavior.

**Steps:**

- [ ] Open any recent internal PR on `cli` (or create a test PR).
- [ ] Confirm `Test coverage` runs and the `Validate SonarCloud token` step
      passes (Actions `SONAR_TOKEN` is available).
- [ ] Confirm `SonarCloud Scan` completes successfully.
- [ ] Confirm `Update package-lock.json` runs (if the PR touches
      `package.json` or `package-lock.json`) and the `Validate bot token`
      step passes (Actions `YC_UI_BOT_GITHUB_TOKEN` is available).
- [ ] Confirm no new failures or behavior changes compared to pre-T1.2.

**Verification commands:**

```bash
# List recent internal PRs (non-Dependabot authors)
gh pr list --repo diplodoc-platform/cli --state all --limit 10 \
  --json number,title,author --jq '.[] | select(.author.login != "app/dependabot")'

# Check the latest coverage run on an internal PR
gh run list --repo diplodoc-platform/cli \
  --workflow coverage.yml --limit 3
```

**Pass criteria:** Internal PR CI is green; secrets resolve from the Actions
store; no regression.

---

### Scenario 4 — Fork PR correctly skips restricted jobs

**What:** A PR from a fork should have the SonarCloud scan and the
branch-modifying `package-lock` job skipped (no secrets, no push access), while
all other safe checks continue to run.

**Why this matters:** Fork PRs cannot access any secrets (Actions or
Dependabot). The `head.repo.full_name == github.repository` condition must be
false for fork PRs, causing both restricted jobs to skip.

**Steps:**

- [ ] Identify or create a fork PR on `cli` (a contributor PR from a forked
      repo).
- [ ] Confirm `Test coverage`: - `Run tests with coverage` runs (no secret needed). - `Upload coverage artifact` runs. - `Validate SonarCloud token` step is **skipped** (condition false). - `SonarCloud Scan` step is **skipped** (condition false). - Overall `Test coverage` check passes (continue-on-error: true).
- [ ] Confirm `Update package-lock.json`: - The entire job is **skipped** (`if` condition false — fork PR). - No "Input required: token" error.
- [ ] Confirm other checks (`test`, `integration test`, `Security audit`)
      run normally.
- [ ] Confirm the fork PR is not blocked by the skipped checks (they should
      not be required, or should report as skipped/success).

**Verification commands:**

```bash
# List recent fork PRs
gh pr list --repo diplodoc-platform/cli --state all --limit 20 \
  --json number,title,headRepository --jq \
  '.[] | select(.headRepository.owner != "diplodoc-platform") | .number'

# Check if the package-lock job was skipped
gh run list --repo diplodoc-platform/cli \
  --workflow package-lock.yml --limit 5
```

**Pass criteria:** Fork PR has restricted jobs skipped; safe checks pass;
no secret leakage or confusing errors.

---

### Scenario 5 — Spot-check Dependabot PRs from packages/extensions/devops

**What:** After rollout to all 28 repos, verify that at least one Dependabot
PR from each category (`packages`, `extensions`, `devops`) has green CI on the
`coverage` and `package-lock` workflows.

**Steps:**

- [ ] **Packages category** — pick one Dependabot PR from a `packages/*` repo
      (e.g. `cli`, `transform`, `client`):
      `bash
  gh pr list --repo diplodoc-platform/transform \
    --author "app/dependabot" --state open --limit 3
  ` - [ ] `Test coverage` passes (Sonar scan succeeds). - [ ] `Update package-lock.json` passes.

- [ ] **Extensions category** — pick one Dependabot PR from an `extensions/*`
      repo (e.g. `tabs-extension`, `cut-extension`):
      `bash
  gh pr list --repo diplodoc-platform/tabs-extension \
    --author "app/dependabot" --state open --limit 3
  ` - [ ] `Test coverage` passes (Sonar scan succeeds). - [ ] `Update package-lock.json` passes.

- [ ] **Devops category** — pick one Dependabot PR from a `devops/*` repo
      (e.g. `package-template`, `testpack`):
      `bash
  gh pr list --repo diplodoc-platform/package-template \
    --author "app/dependabot" --state open --limit 3
  ` - [ ] `Test coverage` passes (Sonar scan succeeds). - [ ] `Update package-lock.json` passes.

**Verification commands (per repo):**

```bash
REPO="diplodoc-platform/<repo-name>"
gh run list --repo "$REPO" --workflow coverage.yml --limit 3
gh run list --repo "$REPO" --workflow package-lock.yml --limit 3
```

**Pass criteria:** At least one Dependabot PR from each of the three
categories has green `coverage` and `package-lock` checks.

---

## 3. Summary Checklist

| #   | Scenario                                 | Pass criteria                                       | Status |
| --- | ---------------------------------------- | --------------------------------------------------- | ------ |
| 1   | Coverage passes with Sonar scan          | `Test coverage` green; Sonar scan succeeds          | ☐      |
| 2   | package-lock workflow succeeds           | `Update package-lock.json` green; no token error    | ☐      |
| 3   | Internal PR uses Actions secrets         | Internal PR CI green; no regression                 | ☐      |
| 4   | Fork PR skips restricted jobs            | Sonar + package-lock skipped; safe checks pass      | ☐      |
| 5   | Spot-check Dependabot PRs (3 categories) | One green PR each from packages, extensions, devops | ☐      |

---

## 4. Rollback / Troubleshooting

If validation fails after secrets + distribution:

| Symptom                                                 | Likely cause                                                            | Fix                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Validate SonarCloud token` fails with `::error`        | Dependabot secret `SONAR_TOKEN` not configured for this repo            | Re-run T1.1 runbook; add repo to selected-repositories list                                 |
| `Validate bot token` fails with `::error`               | Dependabot secret `YC_UI_BOT_GITHUB_TOKEN` not configured for this repo | Re-run T1.1 runbook; add repo to selected-repositories list                                 |
| `Validate SonarCloud token` passes but Sonar scan fails | Token has wrong scope or SonarCloud project not configured              | Check SonarCloud project settings; verify token has `project: analysis` scope               |
| `Validate bot token` passes but checkout/push fails     | Token lacks `repo` scope or branch protection blocks push               | Verify token scopes; check that `yc-ui-bot` is in CODEOWNERS                                |
| Workflow not updated (no `Validate *` step)             | Distribution did not reach this repo                                    | Run `infra sync --repo <name>` manually; verify `@diplodoc/infra` version in `package.json` |
| Fork PR still fails with "Input required: token"        | Workflow condition not applied                                          | Verify `if: github.event.pull_request.head.repo.full_name == github.repository` is present  |

---

## 5. References

- [PR #2166](https://github.com/diplodoc-platform/cli/pull/2166) — Dependabot PR (js-yaml 4.1.0 → 4.3.1)
- `docs/dependabot-secrets-runbook.md` — T1.1: org-level Dependabot secrets setup
- `docs/release-preparation.md` — T1.3: infra release + distribution matrix
- `devops/infra/scaffolding/.github/workflows/coverage.yml` — T1.2: coverage workflow template
- `devops/infra/scaffolding/.github/workflows/package-lock.yml` — T1.2: package-lock workflow template
- [Epic E1](https://github.com/diplodoc-platform/diplodoc) — Dependabot Automation
