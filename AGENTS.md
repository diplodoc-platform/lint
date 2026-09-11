# AGENTS.md

This file contains instructions for AI agents working with the `@diplodoc/infra` project.

## Common Rules and Standards

**Important**: This package follows common rules and standards defined in the Diplodoc metapackage. When working in metapackage mode, refer to:

- **`.agents/style-and-testing.md`** in the metapackage root for:
  - Code style guidelines
  - Commit message format (Conventional Commits)
  - Pre-commit hooks rules (**CRITICAL**: Never commit with `--no-verify`)
  - Testing standards
  - Documentation requirements
- **`.agents/core.md`** for core concepts
- **`.agents/monorepo.md`** for workspace and dependency management
- **`.agents/dev-infrastructure.md`** for build and CI/CD

**Note**: In standalone mode (when this package is used independently), these rules still apply. If you need to reference the full documentation, check the [Diplodoc metapackage repository](https://github.com/diplodoc-platform/diplodoc).

## Project Description

`@diplodoc/infra` (formerly `@diplodoc/lint`) is the central infrastructure package for the Diplodoc platform. It manages:

- **Linting**: ESLint, Prettier, Stylelint configurations shared across all packages
- **Scaffolding**: Configuration files, CI workflows, Git hooks distributed to all packages
- **Distribution**: Automated PR-based delivery of infrastructure updates to 30+ repositories
- **Blacklisting**: Per-repo exclusions for selective scaffolding (e.g., during Node.js migrations)

Replaces the deprecated `@diplodoc/eslint-config`, `@diplodoc/prettier-config`, and `@diplodoc/lint` packages.

## Architecture Overview

### Two Distribution Models

The package supports two ways of distributing infrastructure to consumer packages:

**Push model (primary, automated)**:
When a new version of `@diplodoc/infra` is released, the `distribute-infra.yml` workflow automatically creates PRs in all target repositories with updated scaffolding files. PRs for non-critical packages are auto-merged when CI passes.

**Manual model (for development/debugging)**:
Developers can run `infra update` locally to apply scaffolding to their current package. This is useful for testing changes before release.

```
┌─────────────────────────────────────────────────┐
│              @diplodoc/infra repo                │
│                                                  │
│  scaffolding/        distribution.yml            │
│  *-config.js         (repo list + blacklist)     │
│  bin/lint.js         bin/infra.js                │
│                                                  │
│  .github/workflows/                              │
│    distribute-infra.yml  (push to all repos)     │
│    integration-test.yml  (pre-release testing)   │
└──────────────────────┬──────────────────────────┘
                       │
            on release / manual trigger
                       │
                       ▼
    ┌──────────────────────────────────┐
    │  For each repo in distribution.yml:        │
    │  1. Clone target repo                      │
    │  2. Read .infrarc.yml (if exists)          │
    │  3. Merge blacklists                       │
    │  4. Apply scaffolding (skip blacklisted)   │
    │  5. Create PR                              │
    │  6. Auto-merge if allowed                  │
    └──────────────────────────────────┘
```

### Two CLI Binaries

The package exposes two binaries:

| Binary  | Purpose                   | Commands                                                      |
| ------- | ------------------------- | ------------------------------------------------------------- |
| `lint`  | Linting operations only   | `lint`, `lint fix`, `lint init`, `lint update`                |
| `infra` | Infrastructure management | `infra init`, `infra update`, `infra sync`, `infra blacklist` |

The `lint` binary is kept for backward compatibility. The `infra` binary is the new primary entry point for scaffolding and distribution.

### Lint Script Behavior

**Default mode** (`lint`):

- Runs ESLint on all JS/TS files (check only)
  - Uses `ESLINT_USE_FLAT_CONFIG=false` to force legacy (ESLint 8-style) config resolution
  - Calls ESLint with `.` and `--ext .js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx`
  - ESLint automatically reads `.eslintrc.js` and `.eslintignore` from package root
  - No additional file filtering in `bin/lint.js`
- Runs Prettier in check mode on all JS/TS files
- Runs Stylelint on CSS/SCSS files (if found and not ignored)

**Fix mode** (`lint fix`):

- Runs ESLint with `--fix` flag (same config as check mode)
- Runs Prettier with `--write` flag (formats files)
- Runs Stylelint with `--fix` flag

### Proxy Scripts

The `bin/` directory contains proxy scripts that redirect to original binaries:

- `eslint` → `eslint/bin/eslint.js`
- `prettier` → `prettier/bin/prettier.cjs`
- `stylelint` → `stylelint/bin/stylelint.mjs`
- `husky` → `husky/bin.js`
- `lint-staged` → `lint-staged/bin/lint-staged.js`
- `svgo` → `svgo/bin/svgo`

How they work: find the source directory of `@diplodoc/infra`, use `require.resolve()` to locate the original package in `node_modules`, then redirect execution.

## Tech Stack

- **Language**: JavaScript (Node.js) — no TypeScript, pure JavaScript
- **Runtime**: Node.js (npm >=11.5.1)
- **Testing**: Custom test setup in `test/` directory (Node.js `assert` and `child_process`, no testing framework)
- **Build**: No build step required (pure JavaScript package)
- **YAML parsing**: `js-yaml` (for `distribution.yml` and `.infrarc.yml`)

## Usage Modes

This package can be used in two different contexts:

### 1. As Part of Metapackage (Workspace Mode)

When `@diplodoc/infra` is part of the Diplodoc metapackage:

- Located at `devops/infra/` in the metapackage
- Linked via npm workspaces
- Dependencies are shared from metapackage root `node_modules`
- Can be developed alongside other packages
- Changes are immediately available to other packages via workspace linking

### 2. As Standalone Package (Independent Mode)

When `@diplodoc/infra` is used as a standalone npm package:

- Installed via `npm install --save-dev @diplodoc/infra`
- Has its own `node_modules` with all dependencies
- Can be cloned and developed independently

### Important Considerations

**Path Resolution**:

- In metapackage: Scripts resolve paths relative to metapackage structure
- Standalone: Scripts resolve paths relative to package root
- Proxy scripts (`bin/eslint`, etc.) use `require.resolve()` which works in both modes

**Package Lock Management**:

- When adding/updating dependencies, use `npm i --no-workspaces --package-lock-only` to regenerate `package-lock.json` for standalone mode
- This ensures `package-lock.json` is valid when package is used outside workspace
- Always regenerate after dependency changes to maintain standalone compatibility

## Project Structure

### Main Directories

- `bin/` — executable scripts
  - `lint.js` — linting CLI (check, fix, init, update)
  - `infra.js` — infrastructure CLI (init, update, sync, blacklist)
  - `eslint`, `prettier`, `stylelint`, `husky`, `lint-staged`, `svgo` — proxy scripts
- `src/` — source artifacts: `esbuild.mjs`, `esbuild.cjs`, `esbuild.d.ts` (re-export of `esbuild` for the `@diplodoc/infra/esbuild` subpath)
- `scaffolding/` — template files distributed to consumer packages
  - `.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`, `.lintstagedrc.js` — lint configs
  - `.husky/pre-commit`, `.husky/commit-msg` — Git hooks
  - `.editorconfig`, `.gitattributes` — editor settings
  - `sonar-project.properties` — SonarCloud config (`{{PACKAGE_NAME}}` substituted)
  - `.github/workflows/` — CI workflow templates (incl. `auto-approve.yml`, which lets `diplodoc-bot` approve dep-update / release PRs and dismisses stale bot approvals when new commits are pushed; see ADR-002)
  - `.github/CODEOWNERS`, `.github/dependabot.yml` — GitHub config
- `scripts/` — helper scripts used during init/update and distribution
  - `copy-scaffolding.js` — copies scaffolding files with blacklist support
  - `modify-package.js` — adds standard scripts to consumer's package.json
  - `modify-ignore.js` — updates .ignore files with standard patterns
  - `modify-release-please.js` — configures release-please in consumer packages
  - `sync-ci-gate.js` — derives each repo's CI checks from workflow YAML (jobs on `pull_request`) and updates the `master CI gate` ruleset; also **create-only** ensures the check-independent `master protection (auto-merge via app)` ruleset (Ruleset B) exists (ADR-002)
  - `check-pat-expiry.js` — evaluates `INFRA_APPROVER_PAT` expiry (ADR-002)
  - `match-auto-approve.js` — canonical (tested) matcher for auto-approvable bot PRs (ADR-002)
- `distribution.yml` — centralized config: target repos, blacklist, auto-merge settings, and the `ci_gate` block (ruleset name + `exclude_checks`)
- `test/` — package tests (unit + integration)

### Configuration Files (at package root)

- `eslint-common-config.js` — common ESLint configuration
- `eslint-client-config.js` — client-side ESLint configuration
- `eslint-node-config.js` — Node.js ESLint configuration
- `prettier-common-config.js` — Prettier configuration
- `stylelint-common-config.js` — Stylelint configuration

### GitHub Workflows (in this repo)

- `distribute-infra.yml` — distributes scaffolding to all target repos on release or manual trigger
- `sync-ci-gate.yml` — derives each repo's CI checks from workflow YAML and updates its `master CI gate` ruleset; runs weekly (`cron`) and on `workflow_dispatch` (ADR-002)
- `check-pat-expiry.yml` — two scheduled reminders (~2 weeks and ~3 days before the current `INFRA_APPROVER_PAT` expiry) + `workflow_dispatch`; opens/updates a `pat-rotation` issue assigned to `@diplodoc-platform/team` when rotation is due (ADR-002). Cron dates are expiry-relative and must be updated on rotation.
- `integration-test.yml` — pre-release smoke tests: applies scaffolding to 3 reference packages, runs their full CI
- `dependency-risk-assessment.yml` — emits both a human-readable comment and a machine-readable risk/profile decision for actual dependency changes
- `dependency-deep-verification.yml` — uses that dependency-diff decision to call testpack's exact-SHA reusable workflow for deep profiles in any distributed repository
- `tests.yml`, `release.yml`, `release-please.yml`, etc. — standard CI for this package itself

### GitHub Tokens

Two auth methods are used:

- **`YC_UI_BOT_GITHUB_TOKEN`** — common org-wide PAT used by most workflows. Has `repo` scope but **no `workflow` scope**.
- **GitHub App** (`INFRA_APP_ID` + `INFRA_APP_PRIVATE_KEY`) — used by `distribute-infra.yml` (push `.github/workflows/*.yml` to consumer repos), `sync-ci-gate.yml` (manage rulesets) and `check-pat-expiry.yml` (list org PATs). App must be installed on every target repo (or org-wide). Required permissions:
  - `Contents: Write`, `Workflows: Write`, `Pull requests: Write` (distribution);
  - `Administration: Write` (repository rulesets — needed by `sync-ci-gate.yml`; **must be added manually in the App settings and re-approved on targets**, there is no API for this; without it the Rulesets API returns `403`);
  - org `Personal access tokens: Read` (so `check-pat-expiry.yml` can list `GET /orgs/{org}/personal-access-tokens`);
  - org `Members: Read` (so `check-pat-expiry.yml` can resolve `@diplodoc-platform/team` members to auto-assign the rotation issue; best-effort, falls back to a team @mention).
- **`INFRA_APPROVER_PAT`** — fine-grained PAT of the machine user `diplodoc-bot` (member of `@diplodoc-platform/team`). Used to approve PRs in `distribute-infra.yml` and the distributed `auto-approve.yml`. Rotation is manual (GitHub has no PAT-creation API); `check-pat-expiry.yml` alerts before it lapses. See ADR-001 / ADR-002.

Why a GitHub App instead of extending PAT: GitHub blocks pushing `.github/workflows/*.yml` without `workflow` scope. Using a dedicated App scopes the privilege to the distribution use case and generates short-lived installation tokens per repo (instead of a long-lived PAT with broad permissions).

The workflow uses `actions/create-github-app-token@v3` to generate a fresh installation token for each target repo:

```yaml
- name: Generate App token for target repo
  id: app-token
  uses: actions/create-github-app-token@v3
  with:
    app-id: ${{ secrets.INFRA_APP_ID }}
    private-key: ${{ secrets.INFRA_APP_PRIVATE_KEY }}
    owner: diplodoc-platform
    repositories: ${{ matrix.repo }}
```

The token is then passed to subsequent steps via `${{ steps.app-token.outputs.token }}`.

## Environment Variables

The helper scripts in `scripts/` support two environment variables that enable the `infra sync` command to apply scaffolding to external directories with blacklist filtering:

### `INFRA_TARGET_DIR`

**Purpose**: Overrides the target directory for scaffolding operations.

**Default**: `process.cwd()` (when not set)

**Used by**: `copy-scaffolding.js`, `modify-ignore.js`, `modify-release-please.js`

**Why it exists**: When `infra sync` clones a target repo to a temporary directory (e.g., `.infra-sync-tmp/cli/`), it needs the scripts to write files there, not to the current working directory. The `infra sync` command sets this variable before calling the existing scripts.

**Example flow**:

```
infra sync --target ./target --repo cli
  └── sets INFRA_TARGET_DIR=./target
      ├── copy-scaffolding.js writes to ./target/ (not cwd)
      ├── modify-ignore.js updates ./target/.gitignore (not cwd/.gitignore)
      └── modify-release-please.js reads ./target/package.json
```

### `INFRA_BLACKLIST`

**Purpose**: JSON array of file paths/patterns to skip during scaffolding copy.

**Default**: `[]` (when not set — no files are blacklisted)

**Used by**: `copy-scaffolding.js` (both in `copyScaffoldingFiles()` and `copyWorkflows()`)

**Why it exists**: When `infra sync` processes a repository, it merges two blacklists:

1. Central exclusions from `distribution.yml` (e.g., `cli` has custom `tests.yml`)
2. Local exclusions from the target repo's `.infrarc.yml`

The merged list is passed as a JSON string to the existing `copy-scaffolding.js` script, which then skips those files during copy. This avoids duplicating the blacklist logic in the copy script.

**Example flow**:

```
infra sync --target ./target --repo cli
  └── reads distribution.yml → cli.exclude = [".github/workflows/tests.yml"]
  └── reads ./target/.infrarc.yml → exclude = [".editorconfig"]
  └── merges → [".github/workflows/tests.yml", ".editorconfig"]
  └── sets INFRA_BLACKLIST='[".github/workflows/tests.yml",".editorconfig"]'
      └── copy-scaffolding.js skips these files
```

**Supported patterns in the blacklist**:

- Exact paths: `.github/workflows/tests.yml`
- Glob patterns: `.github/workflows/*.yml`
- Directory prefixes: `.github/workflows/`

### Why Environment Variables (Not CLI Arguments)?

The helper scripts (`copy-scaffolding.js`, `modify-ignore.js`, `modify-release-please.js`) were originally designed as standalone scripts called via `execSync` from `bin/lint.js`. They use `process.cwd()` and have no argument parsing.

Rather than refactoring all scripts to accept CLI arguments (which would be a breaking change to the existing `lint update` flow), environment variables provide backward-compatible extension:

- When env vars are **not set**: scripts behave exactly as before (write to cwd, no blacklist)
- When env vars are **set**: scripts target the specified directory and respect the blacklist

This means `lint update` (local developer usage) and `infra sync` (automated distribution) share the same underlying scripts.

## distribution.yml

Centralized configuration file that lives in this repository. Defines:

- **Target repositories**: Which repos receive infrastructure updates
- **Blacklist**: Per-repo file exclusions
- **Auto-merge**: Whether PRs are auto-merged after CI passes

```yaml
defaults:
  auto_merge: true
  exclude: []

repos:
  cli:
    auto_merge: false # critical package — manual review
    exclude:
      - path: .github/workflows/tests.yml
        reason: 'Custom E2E steps'
        until: '2026-07-01' # auto-expires
  transform:
    auto_merge: false
    exclude: []
  cut-extension:
    exclude: []
```

**Synced automatically**: The metapackage's `sync-packages-list.yml` workflow adds new repos from `.gitmodules` to this file (preserving existing blacklist config).

## .infrarc.yml (in target repos)

Optional file in consumer repositories for local exclusions:

```yaml
exclude:
  - path: .github/workflows/tests.yml
    reason: 'Custom matrix build for multiple Node versions'
  - .editorconfig
```

These exclusions are merged (union) with the central `distribution.yml` exclusions.

## CLI Reference

### `lint` Binary

| Command       | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `lint`        | Run all linters (ESLint, Prettier, Stylelint) in check mode     |
| `lint fix`    | Run all linters in fix mode (auto-fix)                          |
| `lint init`   | Initialize infrastructure in current package (first-time setup) |
| `lint update` | Update scaffolding files in current package (manual)            |

### `infra` Binary

| Command                 | Description                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `infra init`            | Same as `lint init`                                                                                       |
| `infra update`          | Same as `lint update`                                                                                     |
| `infra sync`            | Distribute scaffolding to target repositories                                                             |
| `infra gate sync`       | Sync the `master CI gate` ruleset with each repo's checks (needs `GH_TOKEN` with `Administration: write`) |
| `infra blacklist show`  | Show blacklist for a repository                                                                           |
| `infra blacklist audit` | Check for expired exclusions                                                                              |
| `infra help`            | Show usage information                                                                                    |

### `infra sync` Options

| Flag              | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| `--target <path>` | Apply scaffolding to a local directory (instead of cloning) |
| `--repo <name>`   | Target a specific repository                                |
| `--all`           | Target all repositories from `distribution.yml`             |
| `--dry-run`       | Show diff without creating PRs                              |
| `--config <path>` | Path to `distribution.yml` (default: `./distribution.yml`)  |
| `--output <path>` | Write diff report to file (with `--dry-run`)                |
| `--version <tag>` | Version tag for branch/PR naming                            |

## Scaffolding Files Detail

Files in `scaffolding/` are copied to packages during `init`/`update`:

**`.eslintrc.js`**: Extends `@diplodoc/infra/eslint-config`, configures TypeScript parser with `project: true`, sets `root: true`.

**`.prettierrc.js`**: Exports `@diplodoc/infra/prettier-config` directly.

**`.stylelintrc.js`**: Extends `@diplodoc/infra/stylelint-config`.

**`.lintstagedrc.js`**: Configures lint-staged:

- JS/TS files: Prettier + ESLint (with auto-fix, excludes config files and scripts)
- CSS/SCSS files: Prettier + Stylelint (with auto-fix)
- JSON/YAML/MD files: Prettier
- SVG files: SVGO optimization
- Automatically runs `npm test` when test files (`.test.ts`, `.spec.ts`) or source files (`src/`) change

**`.editorconfig`**: UTF-8, LF line endings, 4-space indent default, 2-space for JS/TS/JSON/YAML.

**`.husky/pre-commit`**: Runs `npm run pre-commit`.

**`.husky/commit-msg`**: Validates Conventional Commits format, rejects Cyrillic, allows `fixup!`/`squash!` prefixes, supports `!` for breaking changes.

**`sonar-project.properties`**: SonarCloud config. `{{PACKAGE_NAME}}` placeholder is substituted from `package.json` name (without scope, e.g. `@diplodoc/foo` → `foo`). Substitution is done in `scripts/copy-scaffolding.js`.

**`.github/workflows/coverage.yml`**: Optional workflow — runs `test:coverage` when script exists, uploads coverage artifact, then runs SonarCloud scan via `SonarSource/sonarqube-scan-action`. Exits successfully when `test:coverage` is absent.

**SonarCloud setup for new repos**: After adding a repo in SonarCloud, disable **Automatic Analysis** (**Administration → Analysis Method**). Auto-imported projects enable it by default; CI-based analysis (our `coverage.yml`) fails with `You are running CI analysis while Automatic Analysis is enabled` until it is turned off. Requires project-level admin (not just org admin).

### Auto-Generated Configuration Files

These files are considered auto-generated and should NOT be edited manually in consumers:

- `.eslintrc.js`, `.prettierrc.js`, `.stylelintrc.js`, `.lintstagedrc.js`

Rules:

- Copied from `scaffolding/` during `infra init` / `infra update` / `distribute-infra.yml`
- Manual edits will be overwritten on next infrastructure update
- To customize behavior: update templates in `scaffolding/`, or use local `src/.eslintrc.js` overrides

### Ignore Files

Updated via `modify-ignore.js`. Adds standard patterns:

- System files: `.idea`, `.vscode`, `.history`, `.env`, `.DS_Store`
- Build artifacts: `/lib`, `/dist`, `/build`, `/cache`, `/coverage`, `/external`
- Dependencies: `node_modules`
- ESLint-specific: `esbuild/**/*.mjs`, config files (`.lintstagedrc.js`, `.eslintrc.js`, etc.)

**Important**: `test/` and `scripts/` are NOT added to `.eslintignore` — tests and scripts should be linted.

## Consumer Package Scripts

After `infra init`, consumer packages get these scripts:

```json
{
  "scripts": {
    "lint": "lint",
    "lint:fix": "lint fix",
    "pre-commit": "lint-staged",
    "prepare": "husky || true",
    "lock": "npm install --no-workspaces --package-lock-only --ignore-scripts"
  }
}
```

**Note**: Unlike the old `@diplodoc/lint`, there is no `lint update &&` prefix. Infrastructure updates are delivered via automated PRs, not on every lint run.

## Exports

- `@diplodoc/infra/eslint-config` — Common ESLint config
- `@diplodoc/infra/eslint-config/client` — Client-side ESLint config
- `@diplodoc/infra/eslint-config/node` — Node.js ESLint config
- `@diplodoc/infra/prettier-config` — Prettier config
- `@diplodoc/infra/stylelint-config` — Stylelint config
- `@diplodoc/infra/esbuild` — Re-export of the `esbuild` API (ESM and CJS); use instead of a direct `esbuild` dependency

## Testing

### Test Structure

- `test/unit/` — unit tests (modify-package, modify-ignore, esbuild export)
- `test/integration/` — integration tests (init, update, lint flows)
- `test/helpers/` — test utilities
- `test/fixtures/` — test data
- `test/runner.js` — custom test runner (Node.js `assert`, no framework)

### Running Tests

```bash
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests only
```

### Pre-Release Testing (CI)

`integration-test.yml` runs on every PR that touches scaffolding:

1. Clones 3 reference packages (cli, transform, cut-extension)
2. Applies scaffolding from the PR branch
3. Runs full CI (lint, typecheck, build, test) in each
4. Posts a diff report as a PR comment

This prevents merging changes that would break consumer packages.

## Common Tasks

### Adding a New Linting Rule

1. Update the appropriate config file (e.g., `eslint-common-config.js`)
2. Run `npm test` to verify
3. Integration test will verify rule doesn't break reference packages

### Modifying Scaffolding Files

1. Update files in `scaffolding/` directory
2. Run `npm test` to verify
3. The `integration-test.yml` workflow will test against real packages on PR

### Adding a Repo to Distribution

Repos are automatically synced from the metapackage's `.gitmodules` via `sync-packages-list.yml`. To add manually, edit `distribution.yml`.

### Excluding a File from Distribution

**Centrally** (in this repo): Add to `distribution.yml` under the repo's `exclude` list.

**Locally** (in target repo): Add to `.infrarc.yml` in the target repo root.

### Auditing Expired Exclusions

```bash
npx @diplodoc/infra blacklist audit
```

## Important Notes

1. **Push model**: Infrastructure updates are distributed via automated PRs, not on every `lint` run. The `lint update` prefix was removed from consumer scripts.

2. **Backward compatibility**: The `lint` binary still works for linting. The `infra` binary adds sync/blacklist capabilities.

3. **Blacklist merge**: Central (`distribution.yml`) and local (`.infrarc.yml`) exclusions are merged. Expired entries (past `until` date) are automatically ignored.

4. **Auto-merge**: Controlled per-repo in `distribution.yml`. Critical packages (cli, transform, components) default to `auto_merge: false`.

5. **Pre-release safety**: The `integration-test.yml` workflow blocks merging if scaffolding changes break any of the 3 reference packages.

6. **Migration from @diplodoc/lint**: Consumer packages need to update their `devDependencies` from `@diplodoc/lint` to `@diplodoc/infra`. The first `distribute-infra` run handles this automatically.

7. **Dual usage mode**: This package works both in metapackage (workspace) and standalone npm mode. All scripts must work correctly in both contexts. When making changes, test both modes.

8. **Package independence**: This package should not depend on other Diplodoc packages (except devops infra like `@diplodoc/tsconfig`).

9. **Used by all packages**: Critical infrastructure used by all Diplodoc packages. Changes should be carefully tested.

10. **Extensibility**: Packages can extend ESLint configs at the `src` level (e.g., `src/.eslintrc.js`), but should not override base configs.

11. **Replaces deprecated packages**: Replaces `@diplodoc/eslint-config`, `@diplodoc/prettier-config`, and `@diplodoc/lint`. Do not use those packages.
