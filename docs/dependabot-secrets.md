# Dependabot workflow secrets

GitHub Actions runs initiated by Dependabot cannot access Actions secrets. GitHub
populates the `secrets` context from the separate Dependabot secret store instead.
Workflows shared by regular pull requests and Dependabot pull requests should
therefore use the same secret name in both stores.

The distributed Diplodoc workflows require these Dependabot secrets:

- `SONAR_TOKEN` — permits analysis of the selected SonarCloud projects.
- `YC_UI_BOT_GITHUB_TOKEN` — permits `package-lock.yml` to update the pull request
  branch. Grant only the repository contents permissions required by that workflow.

## Repository access

Create the secrets at organization level with `Selected repositories` visibility.
Grant access only to these 28 repositories:

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

This list is the `distribution.yml` repository set plus the `infra` source
repository itself. Keep it synchronized when repositories are added to or removed
from infrastructure distribution.

## Configuration

An organization owner can configure the secrets in GitHub under **Organization
settings → Security → Secrets and variables → Dependabot**. Create both names,
select the repositories above, and enter values from the approved credential
source. Existing Actions secret values cannot be read back from GitHub; obtain
the original values or rotate the credentials.

The equivalent GitHub CLI flow is:

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

Each command prompts for the secret value. Do not place secret values in shell
history, repository files, workflow inputs, or issue and pull request text.

## Expected behavior

- Regular internal pull requests read identically named Actions secrets.
- Dependabot pull requests read identically named Dependabot secrets and run both
  SonarCloud analysis and lockfile regeneration.
- Pull requests from forks skip SonarCloud analysis and the lockfile update job.
- If a required secret is missing for an eligible run, the workflow fails before
  checkout or scanning with an explicit configuration error.

After configuring the secrets, re-run an existing Dependabot workflow or ask
Dependabot to rebase its pull request to verify the setup.
