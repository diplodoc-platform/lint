# Runbook — Share CI Secrets to Dependabot

> **Story:** T1.1 — Share CI Secrets to Dependabot
> **Epic:** E1 — Dependabot Automation
> **Status:** Manual step — requires organization owner permissions
> **Related:** `docs/dependabot-secrets.md` (reference notes for the same topic)

## Background

GitHub runs Dependabot pull requests in an isolated execution context where
regular Actions secrets are **not** available. Instead, GitHub populates the
`secrets` context for Dependabot runs from a separate **Dependabot secret store**.

Workflows shared between regular pull requests and Dependabot pull requests
(coverage/SonarCloud analysis, lockfile regeneration) therefore need
identically named secrets in both stores. Without the Dependabot copies,
`SONAR_TOKEN` and `YC_UI_BOT_GITHUB_TOKEN` resolve to empty strings for
Dependabot PRs and the relevant jobs silently skip or fail.

> **Important:** Existing Actions secret values **cannot be read back** through
> the GitHub API. Obtain the original values from the approved credential store
> or rotate (issue new tokens) before performing this runbook.

## ⚠️ Permissions required

This runbook can only be executed by a **GitHub organization owner** of
`diplodoc-platform`. Creating or modifying organization-level Dependabot
secrets and selecting repository access are owner-only operations.

Confirm before starting:

- [ ] You are an organization owner of `diplodoc-platform`.
- [ ] You have access to the approved credential source for both tokens (or
      authority to issue replacements).

## Secrets to create

Create two organization-level Dependabot secrets with the same names used in
the Actions secret store:

| Secret name              | Purpose                                                                  | Required scope                                                                                              |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `SONAR_TOKEN`            | Permits SonarCloud analysis in `coverage.yml` for all relevant projects. | SonarCloud analysis rights for all Diplodoc projects. Shared token is acceptable.                           |
| `YC_UI_BOT_GITHUB_TOKEN` | Permits `package-lock.yml` to push lockfile updates to the PR branch.    | Minimal write permissions on repository contents for the 28 target repos. Keep scope as narrow as possible. |

Do **not** use organization-wide (`All repositories`) visibility — restrict
each secret to the selected 28 repositories listed below.

## Target repositories (28)

The 28 repositories are the `distribution.yml` repository set (27 repos that
receive `@diplodoc/infra` scaffolding) **plus the `infra` source repository
itself**. Each of these repos contains a `.github/dependabot.yml` and at least
one workflow that consumes one of the two secrets above.

Keep this list synchronized with `distribution.yml` whenever repositories are
added to or removed from infrastructure distribution.

| #   | Repository                   | Group      | Consumes                                |
| --- | ---------------------------- | ---------- | --------------------------------------- |
| 1   | `infra`                      | devops     | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 2   | `package-template`           | devops     | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 3   | `testpack`                   | devops     | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 4   | `ajv`                        | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 5   | `cli`                        | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 6   | `client`                     | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 7   | `components`                 | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 8   | `directive`                  | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 9   | `liquid`                     | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 10  | `sentenizer`                 | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 11  | `transform`                  | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 12  | `translation`                | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 13  | `utils`                      | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 14  | `vsc`                        | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 15  | `yfmlint`                    | packages   | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 16  | `algolia-extension`          | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 17  | `color-extension`            | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 18  | `cut-extension`              | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 19  | `file-extension`             | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 20  | `folding-headings-extension` | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 21  | `html-extension`             | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 22  | `latex-extension`            | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 23  | `mermaid-extension`          | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 24  | `openapi-extension`          | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 25  | `page-constructor-extension` | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 26  | `quote-link-extension`       | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 27  | `search-extension`           | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |
| 28  | `tabs-extension`             | extensions | `SONAR_TOKEN`, `YC_UI_BOT_GITHUB_TOKEN` |

Plain-text list (for the GitHub UI `Selected repositories` picker or CLI):

```text
ajv
algolia-extension
cli
client
color-extension
components
cut-extension
directive
file-extension
folding-headings-extension
html-extension
infra
latex-extension
liquid
mermaid-extension
openapi-extension
package-template
page-constructor-extension
quote-link-extension
search-extension
sentenizer
tabs-extension
testpack
transform
translation
utils
vsc
yfmlint
```

## Procedure

### Option A — GitHub Web UI

1. As an organization owner, open
   `https://github.com/organizations/diplodoc-platform/settings/secrets/dependabot`.
2. Click **New organization secret**.
3. Create `SONAR_TOKEN`:
   - **Name:** `SONAR_TOKEN`
   - **Secret:** value from the approved credential source.
   - **Secret access:** `Selected repositories` → pick all 28 repositories above.
4. Repeat for `YC_UI_BOT_GITHUB_TOKEN` with the same 28 selected repositories.

### Option B — GitHub CLI

```bash
REPOSITORIES='ajv,algolia-extension,cli,client,color-extension,components,cut-extension,directive,file-extension,folding-headings-extension,html-extension,infra,latex-extension,liquid,mermaid-extension,openapi-extension,package-template,page-constructor-extension,quote-link-extension,search-extension,sentenizer,tabs-extension,testpack,transform,translation,utils,vsc,yfmlint'

gh secret set SONAR_TOKEN \
  --org diplodoc-platform \
  --app dependabot \
  --visibility selected \
  --repos "$REPOSITORIES"

gh secret set YC_UI_BOT_GITHUB_TOKEN \
  --org diplodoc-platform \
  --app dependabot \
  --visibility selected \
  --repos "$REPOSITORIES"
```

Each command prompts interactively for the secret value.

> **Security:** Do not place secret values in shell history, repository files,
> workflow inputs, or issue/PR text. Use a credential manager or paste from the
> approved source.

## Verification

After the secrets are created, verify the setup:

- [ ] `SONAR_TOKEN` visible under **Dependabot** secrets (not Actions secrets)
      with `Selected repositories` = 28 repos.
- [ ] `YC_UI_BOT_GITHUB_TOKEN` visible under **Dependabot** secrets with
      `Selected repositories` = 28 repos.
- [ ] Trigger a Dependabot re-run: re-run an existing Dependabot workflow or
      ask Dependabot to rebase one of its open PRs in a target repo.
- [ ] Confirm the `coverage.yml` SonarCloud scan step runs (does not skip with
      "missing SONAR_TOKEN") on the Dependabot PR.
- [ ] Confirm the `package-lock.yml` lockfile-update job succeeds on the
      Dependabot PR (token is non-empty).
- [ ] Confirm fork pull requests still skip both jobs (unchanged behavior).

## Expected behavior

- Regular internal pull requests read identically named **Actions** secrets.
- Dependabot pull requests read identically named **Dependabot** secrets and
  run both SonarCloud analysis and lockfile regeneration.
- Pull requests from forks skip SonarCloud analysis and the lockfile update job.
- If a required secret is missing for an eligible run, the workflow fails
  before checkout or scanning with an explicit configuration error (see T1.2
  for the early `::error` guard).

## Rollback

To revoke access without deleting the values:

1. Edit each secret's repository access in the GitHub UI and deselect the
   relevant repositories, or
2. Delete the secret entirely via the UI or `gh secret delete <NAME> --org
diplodoc-platform --app dependabot`.

Dependabot PRs will then skip the affected jobs (SonarCloud analysis and
lockfile update) until access is restored.
