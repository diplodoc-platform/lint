# Auto-Assign Owner on SLA Breach

> Companion doc for the `Auto-assign owners to SLA-breaching PRs` workflow step (T8.3).

When a Dependabot PR exceeds its SLA deadline, the Dependency Health workflow
automatically assigns an **owner** to the PR and maintains a single tracking
issue in the `infra` repository. A known breakage must not remain just a red
PR: either it gets **fixed**, or a **policy exception** is filed.

## Overview

The T8.3 step runs **after** the T8.1 health audit and T8.2 daily summary
within the same `Dependency Health Audit` workflow run. It:

1. Detects SLA breaches (reuses the T8.1 `computeHealth` output).
2. Resolves an owner for each breaching PR:
   - If the changed dependency is covered by a registry entry (`DEP-NNNN`)
     with an `owner` field, that owner is used.
   - Otherwise the fallback owner is `@diplodoc-platform/team` (rendered in
     the tracking-issue body); the assignees API call uses the machine user
     `diplodoc-bot` because GitHub's assignees API accepts user logins, not
     team slugs.
3. Adds the resolved assignee to each breaching PR via the GitHub REST API
   (`POST /repos/{owner}/{repo}/issues/{number}/assignees`). Re-assigning an
   already-assigned PR is a no-op on the GitHub side, so the step is
   idempotent.
4. Creates or updates a **single** tracking issue in the `infra` repo titled
   `SLA Breach Tracking` (stable, date-free title so the same issue is updated
   across daily runs). The issue body groups breaching PRs by owner and
   carries the "fix or file exception" reminder.

## Owner resolution

| Source                                                       | Owner used                | Assignees API login                                              |
| ------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------- |
| Registry entry `owner` field (e.g. DEP-0001 `owner: @alice`) | `@alice`                  | `alice`                                                          |
| Registry entry `owner` is a team mention (`@org/team`)       | `@org/team`               | `diplodoc-bot` (fallback — teams are not assignable via the API) |
| No registry entry for the changed dependency                 | `@diplodoc-platform/team` | `diplodoc-bot` (fallback)                                        |

The registry `owner` field is the canonical source of ownership. The fallback
to `diplodoc-bot` for the API call is a best-effort signal: the tracking issue
still @-mentions the team for human triage. If the platform later provisions a
user-level owner per exception, the registry `owner` field drives both the
mention and the API assignment directly.

## Tracking issue

- **Title**: `SLA Breach Tracking` (stable across runs — no date suffix).
- **Labels**: `dependency-health`, `sla-breach`.
- **Repository**: `infra` (overridable via `--tracking-repo`).
- **Body**: summary table (total breaches, security, critical, distinct
  owners), per-owner sections with the full PR table (repo, #, age, SLA,
  overdue days, security, risk, dependency, from/to, title), and the
  "Reminder — fix or file an exception" section.
- **Idempotency**: the script searches for an open issue with the exact title
  via the search API (`repo:diplodoc-platform/infra is:issue is:open
in:title "SLA Breach Tracking"`) and updates it if found, otherwise creates
  a new one. Re-runs do not duplicate the issue.
- **No breaches**: when there are zero SLA breaches, the issue body states
  "No SLA breaches detected" and the issue remains open as a placeholder. It
  is intentionally **not** closed automatically so the issue number stays
  stable for cross-references.

## Reminder — fix or file an exception

The tracking-issue body explicitly instructs the owner to take one of two
actions for each breaching PR:

1. **Fix the PR** — merge it, close it, or rebase it onto the target branch.
2. **File a policy exception** — add or update a `DEP-NNNN` entry in
   `devops/infra/dependency-policy.yml` with `reason`, `owner`, `evidence`,
   `verification-profile`, `review-after`, and `exit-criteria`. See
   `docs/svgo-exception-tagging.md` for the established procedure.

This ensures a known breakage is never left as just a red PR.

## Required App permissions

The auto-assign step uses the same GitHub App installation token as the rest
of the health audit, with these **additional** repository permissions:

| Permission    | Level | Used for                         |
| ------------- | ----- | -------------------------------- |
| Pull requests | Write | Add assignees to breaching PRs   |
| Issues        | Write | Create/update the tracking issue |

The workflow declares both at the workflow level (`pull-requests: write`,
`issues: write`). The App must be installed org-wide with these permissions
re-approved on each target repository (GitHub requires manual re-approval for
write permissions even on org-wide installations). See ADR-002 for the App
definition.

## Workflow step

```yaml
- name: Auto-assign owners to SLA-breaching PRs
  id: assign
  if: always()
  env:
    GH_TOKEN: ${{ steps.app-token.outputs.token }}
  run: |
    set +e
    node scripts/dependency-assign.js \
      --all \
      --output .status/dependency-assign.json \
      --markdown .status/dependency-assign.md
    echo "exit-code=$?" >> "$GITHUB_OUTPUT"
```

The step runs with `if: always()` so assignments happen even when the audit
or summary steps exited non-zero (SLA breaches are exactly the trigger for
assignment). The assign script itself exits non-zero when breaches are found,
which contributes to the workflow's final "Fail on SLA breach" step.

## CLI usage

```bash
# Dry run (no assignments, no issue post — prints the report):
node scripts/dependency-assign.js --all --dry-run --markdown assign.md

# Live run (assigns + posts/updates tracking issue):
GH_TOKEN=<app-token> node scripts/dependency-assign.js --all --output assign.json

# Single repo:
GH_TOKEN=<app-token> node scripts/dependency-assign.js --repo cli --dry-run

# Via the infra CLI:
GH_TOKEN=<app-token> infra health assign --all --output assign.json
```

## Relationship to T8.1 / T8.2

- **T8.1** delivers the SLA engine and the daily audit (`dependency-health.js`).
- **T8.2** delivers the 7-category daily summary posted as a date-stamped
  issue (`dependency-summary.js`).
- **T8.3** (this story) delivers the auto-assign + single persistent tracking
  issue for SLA breaches (`dependency-assign.js`). It reuses the T8.1
  `computeHealth` output and the T9.1 `exportInventory` network layer — no
  duplication of the audit or API code.

The T8.2 daily-summary issue is date-stamped (`Daily Dependency Health
Summary — YYYY-MM-DD`) and rotated daily, while the T8.3 tracking issue is
stable (`SLA Breach Tracking`) and updated in place. This separation is
intentional: the daily summary is a broad operational snapshot, while the
SLA-breach tracking issue is a focused, persistent accountability artifact.
