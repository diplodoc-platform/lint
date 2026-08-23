# Runbook — Tag svgo Dependabot PR with DEP-0001

> **Story:** T9.7 — Tag svgo PR with DEP-0001
> **Epic:** E9 — Triage 124 PRs
> **Status:** Operational runbook — applies to live Dependabot PRs
> **Related:** `dependency-policy.yml` (DEP-0001 entry), `docs/pr-2166-validation.md`

## Background

`svgo` is exact-pinned to `3.3.2` in `packages/cli/package.json` and
`packages/transform/package.json` (no `^`/`~`). The pin is recorded in the
central dependency-policy registry as **DEP-0001** with reason _"Newer versions
break large SVG diagrams"_ and evidence at
[svg/svgo#2218](https://github.com/svg/svgo/issues/2218).

Despite the pin, Dependabot periodically opens PRs proposing to bump `svgo`
(e.g. to `3.3.3` or `3.3.4`). These PRs:

- **Pass** standard CI (Quality, Security, E2E), because the current test
  fixtures do not exercise the large SVG diagrams that regress.
- **Break** rendered output for large SVG diagrams — proving that the
  standard CI gate is insufficient on its own for this dependency.

The correct handling is **not** to merge or silently close these PRs, but to:

1. Tag the PR with the `dependency-exception` label.
2. Link the PR to `DEP-0001` in the registry (cross-reference comment).
3. Preserve the reason in the policy (the registry entry already carries the
   reason; do not close the PR without the exception being on record).
4. Keep the PR open (or close it with an explicit `@dependabot close` + a
   comment recording the exception reference) so the constraint remains
   visible and auditable.

## ⚠️ What this runbook is and is not

- **Is:** a documented procedure so any on-call engineer can consistently
  handle the recurring `svgo` Dependabot PRs.
- **Is not:** a substitute for fixing the root cause. DEP-0001 has an
  `expires-at` of `2026-12-01` and `exit-criteria` (upstream fix + rendering
  regression fixture). Until the exit criteria are met, every `svgo` update
  PR must be triaged per this runbook.

## Prerequisites

Confirm before starting:

- [ ] You have `triage`+ (or `write`) access on the affected Diplodoc repos
      (`cli`, `transform`) so you can label and comment on PRs.
- [ ] The central `devops/infra/dependency-policy.yml` contains the
      `DEP-0001` entry (it does as of 2026-08-23; if not, stop and create it
      per T4.1 first).

## Step 1 — Identify the svgo Dependabot PR

The PR appears in the `cli` and/or `transform` repositories. Dependabot PR
titles follow the pattern:

```
chore(deps): bump svgo from 3.3.2 to <proposed-version>
```

Find open svgo PRs across the two affected repos:

```bash
# cli
gh pr list --repo diplodoc-platform/cli \
  --author "app/dependabot" --state open --search "svgo" \
  --json number,title,headRefName,url

# transform
gh pr list --repo diplodoc-platform/transform \
  --author "app/dependabot" --state open --search "svgo" \
  --json number,title,headRefName,url
```

> If no open `svgo` PR exists, this runbook is not currently actionable —
> file the PR number when one appears and proceed from Step 2.

## Step 2 — Verify the proposed version is in `ignored-versions`

`DEP-0001` declares `ignored-versions: [3.3.3, 3.3.4]`. The proposed version
on the PR **must** be one of the ignored versions for the exception to apply
directly. If Dependabot proposes a version **not** in the list (e.g. a future
`3.4.0`), stop and update the registry first (see _Registry maintenance_
below).

Check:

```bash
gh pr view <PR-NUMBER> --repo diplodoc-platform/<repo> --json title
```

Extract the `to` version from the title and confirm it is listed under
`ignored-versions` in `devops/infra/dependency-policy.yml` (DEP-0001).

## Step 3 — Apply the `dependency-exception` label

If the label does not yet exist in the repository, create it first:

```bash
gh label create dependency-exception \
  --repo diplodoc-platform/<repo> \
  --description "PR is covered by a dependency-policy registry exception (DEP-NNNN)" \
  --color "BFD4F2"
```

Then apply it to the PR:

```bash
gh pr edit <PR-NUMBER> --repo diplodoc-platform/<repo> \
  --add-label "dependency-exception"
```

The `dependency-exception` label is the canonical signal that:

- The PR must **not** be auto-merged (T10 auto-merge rules exclude any PR
  with an active exception).
- A registry entry (DEP-NNNN) backs the exception and carries the reason.

## Step 4 — Post the DEP-0001 cross-reference comment

Post a comment on the PR that links it to the registry entry and records the
reason in-band, so the rationale survives even if the registry file is
restructured later. Use this template (replace `<repo>` and `<PR-NUMBER>`):

```bash
gh pr comment <PR-NUMBER> --repo diplodoc-platform/<repo> --body "$(cat <<'EOF'
## Dependency exception — DEP-0001

This PR proposes updating **svgo** to a version covered by the
dependency-policy registry exception **DEP-0001**.

| Field | Value |
| --- | --- |
| Registry entry | `DEP-0001` in `devops/infra/dependency-policy.yml` |
| Dependency | `svgo` |
| Allowed version | `3.3.2` (exact pin) |
| Ignored versions | `3.3.3`, `3.3.4` |
| Risk | `high` |
| Category | `output-regression` |
| Verification profile | `document-rendering` |
| Reason | Newer versions break large SVG diagrams |
| Evidence | https://github.com/svg/svgo/issues/2218 |
| Owner | `diplodoc-platform/team` |
| Review after | 2026-09-01 |
| Expires at | 2026-12-01 |
| Exit criteria | Upstream issue fixed **and** rendering regression fixture passes |

### Why this PR passes CI but is still unsafe

Standard CI (Quality, Security, E2E) does not exercise the large SVG diagrams
that regress with newer `svgo` versions. The `document-rendering`
verification profile (T7.x) is required to validate a `svgo` bump and is not
part of the default gate. Until the exit criteria are met, this PR will be
kept open under the `dependency-exception` label and must not be merged.

### Reason preserved in policy

The reason is recorded in the central registry (`dependency-policy.yml`) and
is not dependent on this PR or this comment. Closing this PR does **not**
remove the exception; the pin and the registry entry remain in force until
the exit criteria are satisfied or the entry expires (`2026-12-01`).
EOF
)"
```

## Step 5 — Decide: hold open or close with exception recorded

Two acceptable outcomes — **do not silently merge or auto-close**:

**Option A — Hold open (preferred):**
Leave the PR open with the `dependency-exception` label so the exception is
visible in the PR queue and the inventory (T9.1 `export-pr-inventory.js`
will flag it). Dependabot will keep the PR up to date with the target branch.
Re-evaluate at the `review-after` date (`2026-09-01`) or when the exit
criteria are met.

```bash
# No action required — label + comment from Steps 3-4 are sufficient.
```

**Option B — Close with exception recorded (when the PR is stale or superseded):**
Close the PR **only** after the exception is on record (Steps 3-4 complete)
and add a closing comment so the history is self-explanatory:

```bash
gh pr close <PR-NUMBER> --repo diplodoc-platform/<repo> \
  --comment "Closing under DEP-0001 (svgo output regression exception). The pin to 3.3.2 and the registry entry remain in force. Re-opened automatically by Dependabot if a new version is released."
```

> ⚠️ **Never** close a `svgo` PR without first completing Steps 3-4. Closing
> without the `dependency-exception` label and the DEP-0001 cross-reference
> loses the audit trail and the reason is not preserved in the PR history.

## Step 6 — Verify

After completing Steps 3-4 (and optionally Step 5):

- [ ] The PR carries the `dependency-exception` label
      (`gh pr view <PR-NUMBER> --json labels`).
- [ ] The PR has a comment referencing `DEP-0001` with the reason table.
- [ ] `devops/infra/dependency-policy.yml` still contains the `DEP-0001`
      entry with `reason`, `owner`, `evidence`, `verification-profile`,
      `review-after`, `expires-at`, and `exit-criteria` (unchanged).
- [ ] The PR was **not** merged (the `svgo` version in `package.json` of
      `cli`/`transform` is still `3.3.2`).

Optional — confirm the PR appears in the T9.1 inventory with the
`dependency-exception` signal:

```bash
node scripts/export-pr-inventory.js --repo <repo> --markdown /tmp/inventory.md
# the PR should be listed; risk category = high (from DEP-0001)
```

## Registry maintenance

If Dependabot proposes a `svgo` version **not** already in `ignored-versions`
(e.g. `3.4.0`), the PR is not automatically covered. Update the registry:

1. Edit `devops/infra/dependency-policy.yml`, append the new version to
   `ignored-versions` under `DEP-0001`.
2. Add evidence (a reproduction or upstream confirmation) to the `evidence`
   block if available.
3. Re-run the policy check (T4.3) and the per-repo generation (T4.2):

   ```bash
   node scripts/enforce-exact-pin.js --repo cli
   node scripts/generate-dependency-policy.js --repo cli
   ```

4. Then proceed with Steps 3-5 of this runbook.

Do **not** extend `DEP-0001` with open-ended ranges (`ignored-versions`
must contain only specific proven-problematic versions — no `>=3.3.3`
wildcards, per the T4.1 schema). If a whole future line is problematic,
create a new `DEP-NNNN` entry rather than widening `DEP-0001`.

## Why the standard CI gate is insufficient

This is the load-bearing observation behind DEP-0001 and this runbook:

- `svgo` `3.3.3`/`3.3.4` produce semantically valid SVG and pass linters,
  type checks, and the existing E2E suite.
- The regression manifests only on **large** SVG diagrams (specific
  optimization passes reorder/collapse paths in a way that changes rendered
  geometry), which are not present in the current testpack fixtures.
- Therefore a green CI on a `svgo` bump PR is **not** evidence that the bump
  is safe. The `document-rendering` verification profile (T7.x golden-file
  comparison on large diagrams) is the required gate, and it is not part of
  the default CI.

Until the rendering regression fixture (T7.2/T7.3) is in place and the exit
criteria are met, every `svgo` Dependabot PR must be triaged via this runbook.

## Audit trail

Record each triage event for traceability (append-only log):

| Date       | Repo | PR # | Proposed version | Action                            | Operator |
| ---------- | ---- | ---- | ---------------- | --------------------------------- | -------- |
| YYYY-MM-DD | cli  | NNNN | 3.3.x            | Held open / Closed under DEP-0001 | @handle  |

Maintain this table in the team's triage notes or the PR comment thread — it
is not required to live in this repository, but the `dependency-exception`
label + DEP-0001 comment on the PR is the canonical record.
