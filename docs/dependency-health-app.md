# Dependency Health — GitHub App Integration

> Companion doc for the `Dependency Health Audit` workflow (T8.1).

The central Dependency Health workflow runs **daily** in the `infra` repository
and audits all 28 Diplodoc platform repositories for open Dependabot PRs against
the platform SLA. Because the workflow must read PRs and check statuses across
**every** repository, it cannot use the default `GITHUB_TOKEN` (scoped to a
single repo). It uses a **GitHub App** installation token, the same App already
provisioned for `distribute-infra.yml`, `sync-ci-gate.yml`, and
`check-pat-expiry.yml` (see ADR-002).

## Why a GitHub App?

- A PAT scoped to `repo` would work, but App installation tokens are
  per-repo, short-lived, and revocable without password rotation — the same
  rationale documented in the infra `AGENTS.md` "GitHub Tokens" section.
- The existing `INFRA_APP_ID` + `INFRA_APP_PRIVATE_KEY` secrets are reused, so
  no new credential provisioning is required for T8.1.

## Required App permissions

The App is installed **org-wide** on `diplodoc-platform`. The following
repository permissions are required for the health audit (in addition to those
already needed by distribution / CI-gate sync):

| Permission      | Level | Used for                                                                          |
| --------------- | ----- | --------------------------------------------------------------------------------- |
| Contents        | Read  | (already required) — list PR metadata                                             |
| Metadata        | Read  | (default) — base repo access                                                      |
| Pull requests   | Read  | List open Dependabot PRs (`GET /repos/{owner}/{repo}/pulls`)                      |
| Commit statuses | Read  | Read combined status for each PR head SHA (`GET /repos/.../commits/{sha}/status`) |

> No `write` permissions are needed for the audit. The audit only **reads**;
> it never creates issues/PRs/comments on its own (that is T8.2 / T8.3). The
> `issues: write` workflow permission is reserved for future Daily Summary /
> auto-assign behaviour (T8.2/T8.3).

### Org permissions

None beyond what `check-pat-expiry.yml` already needs (org PAT: read,
Members: read). The audit uses repository-scoped REST endpoints, not org-level
endpoints, so it works with a repo-scoped installation token.

## Setup (one-time, already done for existing infra workflows)

1. **App creation** — an org owner creates the GitHub App under
   `diplodoc-platform` (or reuses the existing infra App). See ADR-002 for the
   canonical App definition.
2. **Installation** — install the App on **all repositories** of the org
   (org-wide installation). The health audit reads from all 28 repos, so a
   per-repo installation would miss any repo not on the list.
3. **Secrets** — store the App credentials as **repository secrets** in the
   `infra` repo (already present from existing workflows):
   - `INFRA_APP_ID` — the App's numeric ID.
   - `INFRA_APP_PRIVATE_KEY` — the PEM-encoded private key.
4. **Re-approval** — when new repositories are added to the org, the App
   installation must be re-approved to cover them. Org-wide installations
   cover new repos automatically; per-repo installations do not.

## Audited repositories

The audit covers **28 repositories**: the 27 consumers in `distribution.yml`
plus the `infra` source repo itself (matching the convention established in
T1.1 / T9.1). The repo list is derived by `parseRepoList()` in
`export-pr-inventory.js`, so it stays in sync with `distribution.yml`
automatically.

| #   | Source                             | Count                                       |
| --- | ---------------------------------- | ------------------------------------------- |
| 1   | `distribution.yml` `repos` keys    | 27 (12 packages + 13 extensions + 2 devops) |
| 2   | `infra` source repo (always added) | 1                                           |
|     | **Total**                          | **28**                                      |

## How the token is minted

The workflow uses `actions/create-github-app-token@v3` with `owner:
diplodoc-platform` (org-level, no `repositories` constraint) so the resulting
token is valid for every repo in the org:

```yaml
- name: Generate App token (org-wide audit access)
  id: app-token
  uses: actions/create-github-app-token@v3
  with:
    app-id: ${{ secrets.INFRA_APP_ID }}
    private-key: ${{ secrets.INFRA_APP_PRIVATE_KEY }}
    owner: diplodoc-platform
```

The token is passed to `scripts/dependency-health.js` via the `GH_TOKEN`
environment variable. The script forwards it to the GitHub REST API calls
inside `export-pr-inventory.js` (`listDependabotPrs`, `getPrCheckStatus`).

## SLA rules

The SLA is encoded as a constant table in `scripts/dependency-health.js`
(`SLA_RULES`). Security PRs use **business days** (Mon–Fri); routine version
bumps use **calendar days**:

| Category          | Deadline | Counting      | Selected when                                                   |
| ----------------- | -------- | ------------- | --------------------------------------------------------------- |
| Critical security | 1 day    | business days | security PR with `risk: critical`                               |
| Other security    | 3 days   | business days | security PR (non-critical risk)                                 |
| Patch             | 7 days   | calendar days | `updateType: patch`                                             |
| Minor             | 14 days  | calendar days | `updateType: minor`                                             |
| Major             | 30 days  | calendar days | `updateType: major`                                             |
| Unknown           | 14 days  | calendar days | update type cannot be derived (conservative — treated as minor) |
| Exception review  | 90 days  | calendar days | registry entry `review-after` cadence                           |

A PR is **breaching** when the current time is past its SLA deadline computed
from `created_at`. Exception entries are **overdue** when `review-after` is in
the past, and **expiring** when within 14 days of `review-after`.

## Workflow behaviour

- **Schedule**: `0 7 * * 1-5` (07:00 UTC, weekdays only). Weekends are skipped
  because business-day SLAs do not accrue and calendar-day breaches are caught
  on Monday.
- **Manual trigger**: `workflow_dispatch` with an optional `skip_checks`
  input for faster re-runs (skips the per-PR check-status lookup).
- **Exit code**: the script exits non-zero when any PR breaches SLA or any
  registry exception is overdue, so the daily run appears as a **failing**
  workflow run in the infra repo. The workflow captures the exit code and
  uploads the report artifact **before** failing, so the report is always
  available for inspection.
- **Artifacts**: `dependency-health-report` (JSON + markdown) is uploaded with
  30-day retention.
- **Job summary**: a markdown summary is written to the run's summary page.

## Verification

After the first run, verify:

1. The workflow run appears under the `infra` repo's **Actions** tab
   (`Dependency Health Audit`).
2. The `dependency-health-report` artifact contains both
   `dependency-health.json` and `dependency-health.md`.
3. The JSON `summary` block reports `totalPrs` > 0 (open Dependabot PRs
   exist) and the expected repo count (up to 28).
4. If any PR is breaching, the run is marked **failed** and the job summary
   lists the breach counts.

## Manual run

```bash
# From the infra repo working tree (requires network + token):
GH_TOKEN=<app-token> node scripts/dependency-health.js --all --markdown health.md

# Or via the infra CLI:
GH_TOKEN=<app-token> infra health audit --all --markdown health.md
```

## Relationship to T8.2 / T8.3

- **T8.1** (this story) delivers the workflow + SLA engine + audit.
- **T8.2** (Daily Summary) builds the 7 summary categories on top of this
  audit's output (new PRs without owner, failed checks, PRs older than SLA,
  expiring exceptions, pinned versions missing from policy, policy entries not
  matching manifest, repos at PR limit).
- **T8.3** (Auto-assign owner on SLA breach) adds owner assignment and
  tracking-issue creation on SLA violation.
