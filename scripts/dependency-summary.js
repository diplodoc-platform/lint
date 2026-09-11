#!/usr/bin/env node

/**
 * dependency-summary.js
 *
 * Daily Dependency Health Summary for the Diplodoc platform.
 *
 * Builds on the T8.1 health audit and the T9.1 PR inventory to produce a
 * structured summary covering all 7 categories required by the PLAN.md §5
 * daily summary:
 *
 *   1. New PRs without assigned owner
 *   2. Failed checks
 *   3. PRs older than SLA
 *   4. Exceptions with expiring `review-after`
 *   5. Versions pinned in `package.json` but missing from policy
 *   6. Policy entries not matching real manifest/lockfile
 *   7. Repositories where Dependabot stopped due to open-PR limit
 *
 * The summary is posted daily as a GitHub issue (or job summary) by the
 * `Dependency Health Audit` workflow (T8.1/T8.2).
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/dependency-summary.js [flags]
 *   - As a module: require('./dependency-summary') -> pure helpers for tests.
 *
 * Flags:
 *   --all                 Summarize all repositories from distribution.yml (+ infra)
 *   --repo <name>         Summarize a single repository short name
 *   --config <path>       Path to distribution.yml (default: bundled)
 *   --registry <path>     Path to dependency-policy.yml (default: bundled)
 *   --output <path>       Write JSON summary to file (default: stdout)
 *   --markdown <path>     Write markdown summary to file
 *   --owner <name>        GitHub org owner (default: diplodoc-platform)
 *   --skip-checks         Skip per-PR check-status lookup (faster)
 *
 * Environment variables:
 *   GH_TOKEN              GitHub token (App installation token) with repo:read
 *   GITHUB_TOKEN          Fallback for GH_TOKEN
 */

const {readFileSync, writeFileSync, existsSync, mkdirSync} = require('node:fs');
const {dirname, join, resolve} = require('node:path');
const yaml = require('js-yaml');

const {parseRepoList, exportInventory, loadConfig, loadRegistry} = require('./export-pr-inventory');

const {computeHealth, SLA_RULES} = require('./dependency-health');

const {resolveRegistryPath, filterEntriesForRepo} = require('./generate-dependency-policy');

const {extractExactPins, findRegistryEntry} = require('./enforce-exact-pin');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = 'diplodoc-platform';
const API_ROOT = 'https://api.github.com';

/**
 * Default per-repo WIP limit when dependabot.yml is not available.
 * Matches the scaffolding template total (2 + 2 + 1 = 5).
 */
const DEFAULT_PR_LIMIT = 5;

/**
 * Number of days within which a PR is considered "new" for the
 * "new PRs without owner" category.
 */
const NEW_PR_AGE_DAYS = 3;

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function ghRequest(token, path) {
    const res = await fetch(`${API_ROOT}${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'diplodoc-infra-summary',
        },
    });
    const text = await res.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    if (!res.ok) {
        const detail = json && json.message ? json.message : text || res.statusText;
        throw new Error(`GitHub API GET ${path} -> ${res.status}: ${detail}`);
    }
    return json;
}

/**
 * Fetch a file from a repository via the GitHub Contents API.
 * Returns the decoded text content, or null if the file does not exist.
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} path File path within the repo.
 * @returns {Promise<string|null>}
 */
async function fetchFileContent(token, owner, repo, path) {
    try {
        const data = await ghRequest(
            token,
            `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
        );
        if (data && data.content && data.encoding === 'base64') {
            return Buffer.from(data.content, 'base64').toString('utf8');
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parse a dependabot.yml config and compute the total open-pull-requests-limit
 * across all update blocks.
 *
 * @param {string} content Raw dependabot.yml content.
 * @returns {number} Total WIP limit (sum of all blocks).
 */
function parseDependabotLimit(content) {
    if (!content) return DEFAULT_PR_LIMIT;
    let config;
    try {
        config = yaml.load(content);
    } catch {
        return DEFAULT_PR_LIMIT;
    }
    const updates = config && Array.isArray(config.updates) ? config.updates : [];
    if (updates.length === 0) return DEFAULT_PR_LIMIT;
    let total = 0;
    for (const block of updates) {
        const limit =
            block && typeof block['open-pull-requests-limit'] === 'number'
                ? block['open-pull-requests-limit']
                : 0;
        total += limit;
    }
    return total > 0 ? total : DEFAULT_PR_LIMIT;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Category 1: PRs without an assigned owner.
 *
 * Returns PRs that have no assignees. When `maxAgeDays` is provided, only
 * PRs created within the last `maxAgeDays` days are included (the "new" PRs
 * subset). Pass `Infinity` to include all unowned PRs.
 *
 * @param {Array<object>} inventory PR inventory entries (must have `assignees` and `ageDays`).
 * @param {number} [maxAgeDays] Only include PRs younger than this (default: NEW_PR_AGE_DAYS).
 * @returns {Array<object>} Unowned PR entries.
 */
function prsWithoutOwner(inventory, maxAgeDays = NEW_PR_AGE_DAYS) {
    if (!Array.isArray(inventory)) return [];
    return inventory.filter((pr) => {
        const assignees = Array.isArray(pr.assignees) ? pr.assignees : [];
        if (assignees.length > 0) return false;
        if (maxAgeDays === Infinity) return true;
        const age = typeof pr.ageDays === 'number' ? pr.ageDays : 0;
        return age <= maxAgeDays;
    });
}

/**
 * Category 2: PRs with failing checks.
 *
 * @param {Array<object>} inventory PR inventory entries.
 * @returns {Array<object>} PRs whose checkStatus is 'failing'.
 */
function prsWithFailedChecks(inventory) {
    if (!Array.isArray(inventory)) return [];
    return inventory.filter((pr) => pr.checkStatus === 'failing');
}

/**
 * Category 3: PRs breaching SLA.
 *
 * Delegates to the health audit's breach flag.
 *
 * @param {Array<object>} assessedPrs Assessed PRs from computeHealth (with `breach` field).
 * @returns {Array<object>} Breaching PRs sorted by daysOverdue (descending).
 */
function prsBreachingSla(assessedPrs) {
    if (!Array.isArray(assessedPrs)) return [];
    return assessedPrs
        .filter((pr) => pr.breach)
        .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
}

/**
 * Category 4: Exceptions with expiring or overdue review-after.
 *
 * @param {Array<object>} exceptions Exception assessments from computeHealth.
 * @returns {Array<object>} Exceptions that are overdue or expiring (<=14 days).
 */
function expiringExceptions(exceptions) {
    if (!Array.isArray(exceptions)) return [];
    return exceptions
        .filter((ex) => ex.overdue || ex.daysUntilReview <= 14)
        .sort((a, b) => a.daysUntilReview - b.daysUntilReview);
}

/**
 * Category 5: Versions pinned in a package.json but missing from the policy
 * registry.
 *
 * Reuses `extractExactPins` and `findRegistryEntry` from enforce-exact-pin.
 * Returns an array of violation descriptors per repo.
 *
 * @param {string} repoName Repository short name.
 * @param {object} packageJson Parsed package.json.
 * @param {Array<object>} registryEntries Central registry entries (full list).
 * @returns {Array<{repo: string, name: string, version: string, section: string}>}
 */
function unpinnedVersions(repoName, packageJson, registryEntries) {
    if (!packageJson || typeof packageJson !== 'object') return [];
    const scoped = filterEntriesForRepo(registryEntries || [], repoName);
    const pins = extractExactPins(packageJson);
    const violations = [];
    for (const pin of pins) {
        const entry = findRegistryEntry(scoped, pin.name, pin.version);
        if (!entry) {
            violations.push({
                repo: repoName,
                name: pin.name,
                version: pin.version,
                section: pin.section,
            });
        }
    }
    return violations;
}

/**
 * Category 6: Policy entries that do not match the real manifest.
 *
 * A registry entry is "stale" when:
 *   - The `dependency` is no longer present in the repo's package.json
 *     (neither as an exact pin nor as a ranged dependency), OR
 *   - The entry has an `allowed-version` that no longer matches the pinned
 *     version in package.json (the pin was changed without updating the
 *     registry).
 *
 * @param {string} repoName Repository short name.
 * @param {object} packageJson Parsed package.json.
 * @param {Array<object>} registryEntries Central registry entries (full list).
 * @returns {Array<{repo: string, id: string, dependency: string, reason: string}>}
 */
function stalePolicyEntries(repoName, packageJson, registryEntries) {
    if (!packageJson || typeof packageJson !== 'object') return [];
    const scoped = filterEntriesForRepo(registryEntries || [], repoName);
    if (scoped.length === 0) return [];

    // Collect all dependency names and versions across sections.
    const allDeps = {};
    const sections = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
    ];
    for (const section of sections) {
        const deps = packageJson[section];
        if (deps && typeof deps === 'object') {
            for (const [name, version] of Object.entries(deps)) {
                allDeps[name] = typeof version === 'string' ? version.trim() : '';
            }
        }
    }

    const stale = [];
    for (const entry of scoped) {
        if (!entry || !entry.dependency) continue;
        const depName = entry.dependency;
        const actualVersion = allDeps[depName];
        if (actualVersion === undefined) {
            stale.push({
                repo: repoName,
                id: entry.id || '(no id)',
                dependency: depName,
                reason: 'dependency no longer in package.json',
            });
            continue;
        }
        // If the entry has an allowed-version, check that it matches the pin.
        const allowed = entry['allowed-version'];
        if (allowed !== undefined && allowed !== null && allowed !== '') {
            const allowedStr = String(allowed).trim();
            // The actual version in package.json may be a range (^1.2.3).
            // Only flag a mismatch if the actual is an exact pin AND it
            // doesn't match the allowed-version.
            if (/^\d/.test(actualVersion) && actualVersion !== allowedStr) {
                stale.push({
                    repo: repoName,
                    id: entry.id || '(no id)',
                    dependency: depName,
                    reason: `pinned version ${actualVersion} != allowed-version ${allowedStr}`,
                });
            }
        }
    }
    return stale;
}

/**
 * Category 7: Repositories where Dependabot stopped creating PRs because
 * the open-PR limit was reached.
 *
 * A repo is "at limit" when the number of open Dependabot PRs is >= the
 * total `open-pull-requests-limit` from its dependabot.yml.
 *
 * @param {Array<object>} inventory PR inventory entries.
 * @param {object} prLimits Map of repoName -> total open-pull-requests-limit.
 * @returns {Array<{repo: string, openPrs: number, limit: number}>}
 */
function reposAtPrLimit(inventory, prLimits) {
    if (!Array.isArray(inventory) || !prLimits || typeof prLimits !== 'object') return [];
    const counts = {};
    for (const pr of inventory) {
        counts[pr.repo] = (counts[pr.repo] || 0) + 1;
    }
    const result = [];
    for (const repo of Object.keys(counts)) {
        const limit = prLimits[repo] || DEFAULT_PR_LIMIT;
        if (counts[repo] >= limit) {
            result.push({repo, openPrs: counts[repo], limit});
        }
    }
    return result.sort((a, b) => b.openPrs - a.openPrs);
}

/**
 * Build the full daily summary from its components.
 *
 * All arguments are pre-fetched by the orchestrator (runSummary) so this
 * function is pure and testable.
 *
 * @param {object} params
 * @param {Array<object>} params.inventory PR inventory (sorted).
 * @param {object} params.health Health audit result ({prs, exceptions, summary}).
 * @param {object} params.manifests Map of repoName -> parsed package.json (or null).
 * @param {Array<object>} params.registryEntries Central registry entries (full list).
 * @param {object} params.prLimits Map of repoName -> total open-pull-requests-limit.
 * @param {Date} [params.now]
 * @returns {object} Daily summary with 7 categories.
 */
function buildSummary({inventory, health, manifests, registryEntries, prLimits, now}) {
    const referenceTime = now || new Date();
    const inv = Array.isArray(inventory) ? inventory : [];
    const h = health || {prs: [], exceptions: [], summary: {}};

    const cats = {
        prsWithoutOwner: prsWithoutOwner(inv),
        failedChecks: prsWithFailedChecks(inv),
        slaBreaches: prsBreachingSla(h.prs || []),
        expiringExceptions: expiringExceptions(h.exceptions || []),
        unpinnedVersions: [],
        stalePolicyEntries: [],
        reposAtPrLimit: reposAtPrLimit(inv, prLimits || {}),
    };

    const repos = new Set(inv.map((p) => p.repo));
    for (const [repoName, packageJson] of Object.entries(manifests || {})) {
        if (packageJson) {
            cats.unpinnedVersions.push(...unpinnedVersions(repoName, packageJson, registryEntries));
            cats.stalePolicyEntries.push(
                ...stalePolicyEntries(repoName, packageJson, registryEntries),
            );
            repos.add(repoName);
        }
    }

    const actionableCount =
        cats.prsWithoutOwner.length +
        cats.failedChecks.length +
        cats.slaBreaches.length +
        cats.expiringExceptions.length +
        cats.unpinnedVersions.length +
        cats.stalePolicyEntries.length +
        cats.reposAtPrLimit.length;

    return {
        generatedAt: referenceTime.toISOString(),
        categories: cats,
        totals: {
            prsWithoutOwner: cats.prsWithoutOwner.length,
            failedChecks: cats.failedChecks.length,
            slaBreaches: cats.slaBreaches.length,
            expiringExceptions: cats.expiringExceptions.length,
            unpinnedVersions: cats.unpinnedVersions.length,
            stalePolicyEntries: cats.stalePolicyEntries.length,
            reposAtPrLimit: cats.reposAtPrLimit.length,
            actionableItems: actionableCount,
        },
        healthSummary: h.summary || {},
        repoCount: repos.size,
    };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function escapePipe(str) {
    return String(str || '').replace(/\|/g, '\\|');
}

/**
 * Render the daily summary as a markdown document.
 *
 * Actionable items are highlighted with emoji indicators: each non-empty
 * category is prefixed with a status icon so reviewers can scan quickly.
 *
 * @param {object} summary The summary object from buildSummary.
 * @returns {string}
 */
function renderSummaryMarkdown(summary) {
    const cats = summary.categories || {};
    const totals = summary.totals || {};
    const lines = [];

    lines.push('# Daily Dependency Health Summary');
    lines.push('');
    lines.push(`Generated: ${summary.generatedAt || new Date().toISOString()}`);
    lines.push('');

    // Summary table
    lines.push('## Summary');
    lines.push('');
    lines.push('| Category | Count | Status |');
    lines.push('|----------|-------|--------|');
    const rows = [
        [
            'PRs without owner (new)',
            totals.prsWithoutOwner,
            totals.prsWithoutOwner > 0 ? 'action' : 'ok',
        ],
        ['PRs with failing checks', totals.failedChecks, totals.failedChecks > 0 ? 'action' : 'ok'],
        ['PRs breaching SLA', totals.slaBreaches, totals.slaBreaches > 0 ? 'critical' : 'ok'],
        [
            'Expiring/overdue exceptions',
            totals.expiringExceptions,
            totals.expiringExceptions > 0 ? 'action' : 'ok',
        ],
        [
            'Unpinned exact versions',
            totals.unpinnedVersions,
            totals.unpinnedVersions > 0 ? 'action' : 'ok',
        ],
        [
            'Stale policy entries',
            totals.stalePolicyEntries,
            totals.stalePolicyEntries > 0 ? 'action' : 'ok',
        ],
        ['Repos at PR limit', totals.reposAtPrLimit, totals.reposAtPrLimit > 0 ? 'action' : 'ok'],
    ];
    for (const [label, count, status] of rows) {
        const icon = status === 'critical' ? 'red' : status === 'action' ? 'orange' : 'green';
        lines.push(`| ${label} | ${count} | ${icon} |`);
    }
    lines.push('');
    lines.push(`**Total actionable items: ${totals.actionableItems || 0}**`);
    lines.push('');

    // Category 1: PRs without owner
    if (cats.prsWithoutOwner && cats.prsWithoutOwner.length > 0) {
        lines.push('## 1. New PRs Without Assigned Owner');
        lines.push('');
        lines.push(
            'These Dependabot PRs (created within the last ' +
                NEW_PR_AGE_DAYS +
                ' days) have no assignee.',
        );
        lines.push('');
        lines.push('| Repo | # | Age (d) | Dependency | From | To | Title |');
        lines.push('|------|---|---------|------------|------|-----|-------|');
        for (const pr of cats.prsWithoutOwner) {
            lines.push(
                `| ${pr.repo} | ${pr.number} | ${pr.ageDays} | ${pr.dependency || '—'} | ${pr.fromVersion || '—'} | ${pr.toVersion || '—'} | ${escapePipe(pr.title)} |`,
            );
        }
        lines.push('');
    }

    // Category 2: Failed checks
    if (cats.failedChecks && cats.failedChecks.length > 0) {
        lines.push('## 2. PRs With Failing Checks');
        lines.push('');
        lines.push('These Dependabot PRs have failing CI checks and need attention.');
        lines.push('');
        lines.push('| Repo | # | Age (d) | Dependency | From | To | Title |');
        lines.push('|------|---|---------|------------|------|-----|-------|');
        for (const pr of cats.failedChecks) {
            lines.push(
                `| ${pr.repo} | ${pr.number} | ${pr.ageDays} | ${pr.dependency || '—'} | ${pr.fromVersion || '—'} | ${pr.toVersion || '—'} | ${escapePipe(pr.title)} |`,
            );
        }
        lines.push('');
    }

    // Category 3: SLA breaches
    if (cats.slaBreaches && cats.slaBreaches.length > 0) {
        lines.push('## 3. PRs Breaching SLA');
        lines.push('');
        lines.push('These PRs have exceeded their SLA deadline.');
        lines.push('');
        lines.push(
            '| Repo | # | Age (d) | SLA | Overdue (d) | Security | Risk | Dependency | Title |',
        );
        lines.push(
            '|------|---|---------|-----|------------|----------|------|------------|-------|',
        );
        for (const pr of cats.slaBreaches) {
            const sec = pr.security ? 'yes' : '';
            lines.push(
                `| ${pr.repo} | ${pr.number} | ${pr.ageDays} | ${pr.slaLabel} | ${pr.daysOverdue} | ${sec} | ${pr.risk} | ${pr.dependency || '—'} | ${escapePipe(pr.title)} |`,
            );
        }
        lines.push('');
    }

    // Category 4: Expiring exceptions
    if (cats.expiringExceptions && cats.expiringExceptions.length > 0) {
        lines.push('## 4. Expiring / Overdue Exceptions');
        lines.push('');
        lines.push('Registry entries whose `review-after` date is past or within 14 days.');
        lines.push('');
        lines.push('| ID | Dependency | Repos | Review after | Days left | Status |');
        lines.push('|----|------------|-------|--------------|-----------|--------|');
        for (const ex of cats.expiringExceptions) {
            const status = ex.overdue ? 'OVERDUE' : 'expiring';
            const repos = (ex.repositories || []).join(', ') || 'all';
            lines.push(
                `| ${ex.id} | ${ex.dependency} | ${repos} | ${ex.reviewAfter} | ${ex.daysUntilReview} | ${status} |`,
            );
        }
        lines.push('');
    }

    // Category 5: Unpinned versions
    if (cats.unpinnedVersions && cats.unpinnedVersions.length > 0) {
        lines.push('## 5. Pinned Versions Missing From Policy');
        lines.push('');
        lines.push('Exact pins in `package.json` without a matching registry entry.');
        lines.push('');
        lines.push('| Repo | Dependency | Version | Section |');
        lines.push('|------|------------|---------|---------|');
        for (const v of cats.unpinnedVersions) {
            lines.push(`| ${v.repo} | ${v.name} | ${v.version} | ${v.section} |`);
        }
        lines.push('');
    }

    // Category 6: Stale policy entries
    if (cats.stalePolicyEntries && cats.stalePolicyEntries.length > 0) {
        lines.push('## 6. Policy Entries Not Matching Manifest');
        lines.push('');
        lines.push(
            'Registry entries that reference dependencies no longer present or with mismatched versions.',
        );
        lines.push('');
        lines.push('| Repo | ID | Dependency | Reason |');
        lines.push('|------|----|------------|--------|');
        for (const e of cats.stalePolicyEntries) {
            lines.push(`| ${e.repo} | ${e.id} | ${e.dependency} | ${escapePipe(e.reason)} |`);
        }
        lines.push('');
    }

    // Category 7: Repos at PR limit
    if (cats.reposAtPrLimit && cats.reposAtPrLimit.length > 0) {
        lines.push('## 7. Repositories at Dependabot PR Limit');
        lines.push('');
        lines.push(
            'These repos have reached their `open-pull-requests-limit`, so Dependabot cannot open new PRs until existing ones are merged/closed.',
        );
        lines.push('');
        lines.push('| Repo | Open PRs | Limit |');
        lines.push('|------|----------|-------|');
        for (const r of cats.reposAtPrLimit) {
            lines.push(`| ${r.repo} | ${r.openPrs} | ${r.limit} |`);
        }
        lines.push('');
    }

    if (totals.actionableItems === 0) {
        lines.push('---');
        lines.push('All clear. No actionable items found.');
        lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by `@diplodoc/infra` Daily Dependency Health Summary._');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full daily summary across a set of repositories.
 *
 * Fetches the PR inventory, computes the health audit, fetches per-repo
 * package.json and dependabot.yml, then builds the 7-category summary.
 *
 * @param {object} params
 * @param {string} params.token GitHub token.
 * @param {string} params.owner GitHub org owner.
 * @param {string[]} params.repos Repository short names.
 * @param {Array<object>} [params.registryEntries] Central registry entries.
 * @param {boolean} [params.skipChecks] Skip per-PR check-status lookup.
 * @param {Date} [params.now] Reference time.
 * @returns {Promise<{summary: object, errors: Array}>}
 */
async function runSummary({token, owner, repos, registryEntries = [], skipChecks = false, now}) {
    const referenceTime = now || new Date();
    const errors = [];

    // 1. PR inventory + health audit
    const invResult = await exportInventory({token, owner, repos, registryEntries, skipChecks});
    for (const e of invResult.errors || []) {
        errors.push(e);
    }
    const health = computeHealth(invResult.inventory, registryEntries, referenceTime);

    // 2. Fetch per-repo manifests + dependabot limits
    const manifests = {};
    const prLimits = {};
    for (const repo of repos) {
        // package.json
        try {
            const content = await fetchFileContent(token, owner, repo, 'package.json');
            if (content) {
                try {
                    manifests[repo] = JSON.parse(content);
                } catch {
                    manifests[repo] = null;
                    errors.push({repo, phase: 'parse-manifest', message: 'invalid package.json'});
                }
            } else {
                manifests[repo] = null;
            }
        } catch (error) {
            manifests[repo] = null;
            errors.push({repo, phase: 'fetch-manifest', message: error.message});
        }

        // dependabot.yml
        try {
            const depContent = await fetchFileContent(token, owner, repo, '.github/dependabot.yml');
            prLimits[repo] = parseDependabotLimit(depContent);
        } catch {
            prLimits[repo] = DEFAULT_PR_LIMIT;
        }
    }

    // 3. Build summary
    const summary = buildSummary({
        inventory: invResult.inventory,
        health,
        manifests,
        registryEntries,
        prLimits,
        now: referenceTime,
    });

    return {summary, errors};
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

function writeOutput(filePath, content) {
    if (!filePath) return;
    const abs = resolve(filePath);
    mkdirSync(dirname(abs), {recursive: true});
    writeFileSync(abs, content, 'utf8');
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const owner = flags.owner || process.env.REPO_OWNER || DEFAULT_OWNER;
    const outputFile = typeof flags.output === 'string' ? flags.output : null;
    const markdownFile = typeof flags.markdown === 'string' ? flags.markdown : null;

    const configPath = resolve(flags.config || join(__dirname, '..', 'distribution.yml'));
    const config = loadConfig(configPath);

    let repos;
    if (flags.all) {
        repos = parseRepoList(config);
    } else if (flags.repo) {
        const name = flags.repo.includes('/') ? flags.repo.split('/')[1] : flags.repo;
        repos = [name];
    } else {
        console.error('Error: specify --repo <name> or --all');
        process.exit(1);
    }

    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
        console.error('Error: GH_TOKEN env var is required');
        process.exit(1);
    }

    const registryEntries = loadRegistry(flags.registry);
    const skipChecks = flags['skip-checks'] === true;

    console.error(`[@diplodoc/infra] Generating daily summary for ${repos.length} repo(s)...`);

    let result;
    try {
        result = await runSummary({token, owner, repos, registryEntries, skipChecks});
    } catch (error) {
        console.error(`[@diplodoc/infra] Fatal: ${error.message}`);
        process.exit(1);
    }

    const {summary, errors} = result;
    const json = JSON.stringify(summary, null, 2);
    if (outputFile) {
        writeOutput(outputFile, json);
        console.error(`[@diplodoc/infra] Summary written to ${outputFile}`);
    } else {
        console.log(json);
    }

    if (markdownFile) {
        const md = renderSummaryMarkdown(summary);
        writeOutput(markdownFile, md);
        console.error(`[@diplodoc/infra] Markdown summary written to ${markdownFile}`);
    }

    const t = summary.totals;
    console.error(
        `[@diplodoc/infra] ${t.actionableItems} actionable item(s):` +
            ` ${t.prsWithoutOwner} unowned, ${t.failedChecks} failing, ${t.slaBreaches} SLA breaches,` +
            ` ${t.expiringExceptions} expiring exceptions, ${t.unpinnedVersions} unpinned,` +
            ` ${t.stalePolicyEntries} stale entries, ${t.reposAtPrLimit} at PR limit`,
    );
    if (errors.length > 0) {
        console.error(`[@diplodoc/infra] ${errors.length} error(s):`);
        for (const e of errors) {
            console.error(`  ${e.repo}: ${e.phase} — ${e.message}`);
        }
    }

    if (t.actionableItems > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[@diplodoc/infra] fatal: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_PR_LIMIT,
    NEW_PR_AGE_DAYS,
    parseDependabotLimit,
    prsWithoutOwner,
    prsWithFailedChecks,
    prsBreachingSla,
    expiringExceptions,
    unpinnedVersions,
    stalePolicyEntries,
    reposAtPrLimit,
    buildSummary,
    renderSummaryMarkdown,
    runSummary,
};
