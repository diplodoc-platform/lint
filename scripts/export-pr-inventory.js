#!/usr/bin/env node

/**
 * export-pr-inventory.js
 *
 * Exports all open Dependabot PRs across the Diplodoc platform repositories
 * into a structured inventory with: PR age, dependency name, version change,
 * check status, repository, and risk category.
 *
 * The inventory is sorted by priority: security PRs first, then by age
 * (oldest first). A per-repository breakdown is included in the markdown
 * output.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/export-pr-inventory.js [flags]
 *   - As a module: require('./export-pr-inventory') -> pure helpers for tests.
 *
 * Flags:
 *   --repo <name>        Single repository short name (or owner/name)
 *   --all                Export all repositories from distribution.yml (+ infra)
 *   --config <path>      Path to distribution.yml (default: bundled)
 *   --registry <path>    Path to dependency-policy.yml (default: bundled)
 *   --output <path>      Write JSON inventory to file (default: stdout)
 *   --markdown <path>    Write markdown report to file
 *   --owner <name>       GitHub org owner (default: diplodoc-platform)
 *   --dry-run            Skip network calls (only used with helpers in tests)
 *
 * Environment variables:
 *   GH_TOKEN             GitHub token with repo:read (required for network mode)
 *   GITHUB_TOKEN         Fallback for GH_TOKEN
 */

const {readFileSync, writeFileSync, existsSync, mkdirSync} = require('node:fs');
const {dirname, join, resolve} = require('node:path');
const yaml = require('js-yaml');

const {resolveRegistryPath, filterEntriesForRepo} = require('./generate-dependency-policy');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = 'diplodoc-platform';
const API_ROOT = 'https://api.github.com';
const INFRA_REPO = 'infra';

const RISK_ORDER = {low: 0, medium: 1, high: 2, critical: 3};

/**
 * Default risk derived from the Dependabot update type label.
 * Dependabot attaches `patch`, `minor`, `major` labels to its PRs.
 */
const DEFAULT_RISK_BY_LABEL = {
    patch: 'low',
    minor: 'medium',
    major: 'high',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no process state)
// ---------------------------------------------------------------------------

/**
 * Parse the distribution.yml config and return the full list of repository
 * names that should be audited. This is the 27 repos from `distribution.yml`
 * plus the `infra` source repo itself (28 total).
 *
 * @param {object} config Parsed distribution.yml.
 * @returns {string[]} Sorted unique repo names.
 */
function parseRepoList(config = {}) {
    const repos = new Set(Object.keys(config.repos || {}));
    repos.add(INFRA_REPO);
    return [...repos].sort((a, b) => a.localeCompare(b));
}

/**
 * Compute PR age in days from its created_at timestamp.
 *
 * @param {string} createdAt ISO 8601 date string.
 * @param {Date} [now] Reference date (default: new Date()).
 * @returns {number} Age in whole days (>= 0).
 */
function computeAgeDays(createdAt, now = new Date()) {
    if (!createdAt) return 0;
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) return 0;
    const diffMs = now.getTime() - created.getTime();
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Extract dependency name and version change from a Dependabot PR title.
 *
 * Dependabot titles follow patterns like:
 *   - "Bump foo from 1.2.3 to 1.2.4"
 *   - "Bump @scope/bar from 1.0.0 to 1.1.0"
 *   - "Bump foo in /subdir from 1.0.0 to 2.0.0"
 *   - "chore(deps): bump foo from 1.0.0 to 1.1.0"
 *   - "[Security] Bump foo from 1.0.0 to 1.2.0"
 *
 * @param {string} title PR title.
 * @returns {{dependency: string, from: string, to: string}|null}
 */
function extractDependencyFromTitle(title) {
    if (typeof title !== 'string' || title.length === 0) return null;

    // Match: optional prefix, "bump", package name, optional "in /path",
    // "from <version> to <version>"
    const re =
        /bump\s+(@?[A-Za-z0-9._][A-Za-z0-9._@/-]*)\s+(?:in\s+[^\s]+\s+)?from\s+([^\s]+)\s+to\s+([^\s]+)/i;
    const match = title.match(re);
    if (!match) return null;

    return {
        dependency: match[1].trim(),
        from: match[2].trim(),
        to: match[3].trim(),
    };
}

/**
 * Determine whether a PR is a security update based on its labels and title.
 *
 * @param {{labels?: Array<string|{name:string}>, title?: string}} pr
 * @returns {boolean}
 */
function isSecurityPr(pr) {
    const labels = normalizeLabels(pr.labels);
    if (labels.some((l) => l.toLowerCase() === 'security')) return true;
    if (typeof pr.title === 'string' && /\bsecurity\b/i.test(pr.title)) return true;
    return false;
}

/**
 * Normalize a PR labels array (GitHub API returns objects with a `name`
 * field; some endpoints return bare strings) into a list of lowercased
 * label names.
 *
 * @param {Array<string|{name:string}>|undefined} labels
 * @returns {string[]}
 */
function normalizeLabels(labels) {
    if (!Array.isArray(labels)) return [];
    return labels
        .map((label) => (typeof label === 'string' ? label : label && label.name) || '')
        .filter(Boolean)
        .map((l) => l.toLowerCase());
}

/**
 * Derive the update type (patch / minor / major) from Dependabot labels or
 * version comparison.
 *
 * @param {string[]} labels Normalized lowercased label names.
 * @param {string|null} from Source version.
 * @param {string|null} to Target version.
 * @returns {'patch'|'minor'|'major'|'unknown'}
 */
function deriveUpdateType(labels, from, to) {
    for (const type of ['patch', 'minor', 'major']) {
        if (labels.includes(type)) return type;
    }
    return compareSemver(from, to);
}

/**
 * Compare two semver strings and return the update type.
 *
 * @param {string|null} from
 * @param {string|null} to
 * @returns {'patch'|'minor'|'major'|'unknown'}
 */
function compareSemver(from, to) {
    const f = parseSemver(from);
    const t = parseSemver(to);
    if (!f || !t) return 'unknown';
    if (t.major !== f.major) return 'major';
    if (t.minor !== f.minor) return 'minor';
    return 'patch';
}

/**
 * Parse a version string into major/minor/patch components.
 * Strips leading range operators and pre-release suffixes.
 *
 * @param {string|null} version
 * @returns {{major:number,minor:number,patch:number}|null}
 */
function parseSemver(version) {
    if (typeof version !== 'string' || version.length === 0) return null;
    const cleaned = version
        .replace(/^[^0-9]*/, '')
        .split('-')[0]
        .split('+')[0];
    const parts = cleaned.split('.');
    const major = parseInt(parts[0], 10);
    const minor = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0;
    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
    return {major, minor, patch};
}

/**
 * Assess the risk category for a PR by consulting the registry entries.
 * If the changed dependency has a registry entry with a `risk` field, use it.
 * Otherwise fall back to the default risk for the update type.
 *
 * @param {string} dependency Dependency name.
 * @param {Array<object>} scopedEntries Registry entries scoped to the repo.
 * @param {string} updateType patch | minor | major | unknown.
 * @returns {string} Risk level (low | medium | high | critical).
 */
function assessRisk(dependency, scopedEntries, updateType) {
    const entry = scopedEntries.find((e) => e && e.dependency === dependency);
    if (entry && entry.risk && RISK_ORDER[entry.risk] !== undefined) {
        return entry.risk;
    }
    return DEFAULT_RISK_BY_LABEL[updateType] || 'medium';
}

/**
 * Build a single inventory entry from a raw GitHub PR object.
 *
 * @param {object} pr Raw PR object from GitHub API.
 * @param {string} repoName Repository short name.
 * @param {string} checkStatus Summary check status (passing | failing | pending | unknown).
 * @param {Array<object>} scopedEntries Registry entries scoped to the repo.
 * @param {Date} [now] Reference date for age calculation.
 * @returns {object} Inventory entry.
 */
function buildInventoryEntry(pr, repoName, checkStatus, scopedEntries, now = new Date()) {
    const labels = normalizeLabels(pr.labels);
    const security = isSecurityPr(pr);
    const dep = extractDependencyFromTitle(pr.title || '');
    const updateType = deriveUpdateType(labels, dep && dep.from, dep && dep.to);
    const risk = dep ? assessRisk(dep.dependency, scopedEntries, updateType) : 'unknown';

    return {
        repo: repoName,
        number: pr.number,
        title: pr.title || '',
        url: pr.html_url || '',
        headSha: (pr.head && pr.head.sha) || '',
        baseRef: (pr.base && pr.base.ref) || 'master',
        author: (pr.user && pr.user.login) || '',
        assignees: Array.isArray(pr.assignees)
            ? pr.assignees
                  .map((a) => (typeof a === 'string' ? a : (a && a.login) || ''))
                  .filter(Boolean)
            : [],
        createdAt: pr.created_at || '',
        ageDays: computeAgeDays(pr.created_at, now),
        security,
        dependency: dep ? dep.dependency : '',
        fromVersion: dep ? dep.from : '',
        toVersion: dep ? dep.to : '',
        updateType,
        risk,
        checkStatus,
        labels,
    };
}

/**
 * Sort the inventory by priority: security PRs first, then by age (oldest
 * first / highest age first). Within the same security/age bucket, sort by
 * repo name then PR number for deterministic ordering.
 *
 * @param {Array<object>} inventory
 * @returns {Array<object>} New sorted array.
 */
function sortInventory(inventory) {
    return [...inventory].sort((a, b) => {
        if (a.security !== b.security) return a.security ? -1 : 1;
        if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;
        if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
        return a.number - b.number;
    });
}

/**
 * Group the inventory by repository and return a per-repo breakdown with counts.
 *
 * @param {Array<object>} inventory
 * @returns {Array<{repo: string, total: number, security: number, failing: number, oldestAgeDays: number}>}
 */
function summarizeByRepo(inventory) {
    const map = new Map();
    for (const item of inventory) {
        if (!map.has(item.repo)) {
            map.set(item.repo, {
                repo: item.repo,
                total: 0,
                security: 0,
                failing: 0,
                oldestAgeDays: 0,
            });
        }
        const entry = map.get(item.repo);
        entry.total++;
        if (item.security) entry.security++;
        if (item.checkStatus === 'failing') entry.failing++;
        if (item.ageDays > entry.oldestAgeDays) entry.oldestAgeDays = item.ageDays;
    }
    return [...map.values()].sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return a.repo.localeCompare(b.repo);
    });
}

/**
 * Compute summary statistics for the entire inventory.
 *
 * @param {Array<object>} inventory
 * @returns {object}
 */
function summarizeInventory(inventory) {
    const byRepo = summarizeByRepo(inventory);
    let security = 0;
    let failing = 0;
    let older30 = 0;
    let older90 = 0;
    for (const item of inventory) {
        if (item.security) security++;
        if (item.checkStatus === 'failing') failing++;
        if (item.ageDays >= 30) older30++;
        if (item.ageDays >= 90) older90++;
    }
    return {
        totalPrs: inventory.length,
        securityPrs: security,
        failingPrs: failing,
        olderThan30Days: older30,
        olderThan90Days: older90,
        repoCount: byRepo.length,
        byRepo,
    };
}

/**
 * Render the inventory as a markdown report with a summary table, per-repo
 * breakdown, and the full sorted PR list.
 *
 * @param {Array<object>} inventory Sorted inventory.
 * @param {object} [summary] Pre-computed summary (computed if omitted).
 * @returns {string} Markdown document.
 */
function renderMarkdown(inventory, summary) {
    const s = summary || summarizeInventory(inventory);
    const lines = [];

    lines.push('# Dependabot PR Inventory');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total open PRs | ${s.totalPrs} |`);
    lines.push(`| Security PRs | ${s.securityPrs} |`);
    lines.push(`| Failing checks | ${s.failingPrs} |`);
    lines.push(`| Older than 30 days | ${s.olderThan30Days} |`);
    lines.push(`| Older than 90 days | ${s.olderThan90Days} |`);
    lines.push(`| Repositories | ${s.repoCount} |`);
    lines.push('');

    lines.push('## Per-Repository Breakdown');
    lines.push('');
    lines.push('| Repository | PRs | Security | Failing | Oldest (days) |');
    lines.push('|------------|-----|----------|---------|---------------|');
    for (const r of s.byRepo) {
        lines.push(
            `| ${r.repo} | ${r.total} | ${r.security} | ${r.failing} | ${r.oldestAgeDays} |`,
        );
    }
    lines.push('');

    lines.push('## All PRs (sorted: security first, then by age)');
    lines.push('');
    lines.push(
        '| # | Repo | Age (d) | Security | Dependency | From | To | Type | Risk | Checks | Title |',
    );
    lines.push(
        '|---|------|---------|----------|------------|------|-----|------|------|--------|-------|',
    );
    for (const item of inventory) {
        const sec = item.security ? 'yes' : '';
        const title = item.title.replace(/\|/g, '\\|');
        lines.push(
            `| ${item.number} | ${item.repo} | ${item.ageDays} | ${sec} | ${item.dependency || '—'} | ${item.fromVersion || '—'} | ${item.toVersion || '—'} | ${item.updateType} | ${item.risk} | ${item.checkStatus} | ${title} |`,
        );
    }
    lines.push('');

    lines.push('---');
    lines.push('_Generated by `@diplodoc/infra` PR Inventory Export._');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub API layer (thin wrapper around fetch)
// ---------------------------------------------------------------------------

async function ghRequest(token, path) {
    const res = await fetch(`${API_ROOT}${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'diplodoc-infra-pr-inventory',
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
 * List all open pull requests authored by Dependabot in a single repository.
 * Filters by the exact Dependabot author login. Labels and the generic Bot
 * account type are not an authority boundary and must never opt a PR into an
 * automated merge workflow.
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<object>>} Raw PR objects.
 */
async function listDependabotPrs(token, owner, repo) {
    const prs = [];
    let page = 1;
    for (;;) {
        const data = await ghRequest(
            token,
            `/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}&sort=created&direction=desc`,
        );
        if (!Array.isArray(data) || data.length === 0) break;
        for (const pr of data) {
            const isDependabot = pr.user && pr.user.login === 'dependabot[bot]';
            if (isDependabot) prs.push(pr);
        }
        if (data.length < 100) break;
        page++;
    }
    return prs;
}

/**
 * Determine the summary check status for a PR by inspecting the combined
 * status of its head SHA. Returns one of: passing, failing, pending, unknown.
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha PR head SHA.
 * @returns {Promise<string>}
 */
async function getPrCheckStatus(token, owner, repo, sha) {
    if (!sha) return 'unknown';
    try {
        const data = await ghRequest(
            token,
            `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/status`,
        );
        const state = data && data.state;
        if (state === 'success') return 'passing';
        if (state === 'failure' || state === 'error') return 'failing';
        if (state === 'pending') return 'pending';
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Export the full PR inventory for a set of repositories.
 *
 * @param {object} params
 * @param {string} params.token GitHub token.
 * @param {string} params.owner GitHub org owner.
 * @param {string[]} params.repos Repository short names.
 * @param {Array<object>} [params.registryEntries] Central registry entries for risk assessment.
 * @param {boolean} [params.skipChecks] Skip the per-PR check-status lookup (faster, less data).
 * @returns {Promise<object>} { inventory, summary, errors }
 */
async function exportInventory({token, owner, repos, registryEntries = [], skipChecks = false}) {
    const allEntries = Array.isArray(registryEntries) ? registryEntries : [];
    const inventory = [];
    const errors = [];

    for (const repo of repos) {
        let prs;
        try {
            prs = await listDependabotPrs(token, owner, repo);
        } catch (error) {
            errors.push({repo, phase: 'list-prs', message: error.message});
            continue;
        }

        const scopedEntries = filterEntriesForRepo(allEntries, repo);

        for (const pr of prs) {
            let checkStatus = 'unknown';
            if (!skipChecks) {
                const sha = pr.head && pr.head.sha;
                checkStatus = await getPrCheckStatus(token, owner, repo, sha);
            }

            const entry = buildInventoryEntry(pr, repo, checkStatus, scopedEntries);
            inventory.push(entry);
        }
    }

    const sorted = sortInventory(inventory);
    const summary = summarizeInventory(sorted);

    return {inventory: sorted, summary, errors};
}

// ---------------------------------------------------------------------------
// Config / registry loading
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
    if (!configPath || !existsSync(configPath)) return {};
    return yaml.load(readFileSync(configPath, 'utf8')) || {};
}

function loadRegistry(registryPath) {
    const path = resolveRegistryPath(registryPath);
    if (!existsSync(path)) return {};
    const reg = yaml.load(readFileSync(path, 'utf8')) || {};
    return Array.isArray(reg.entries) ? reg.entries : [];
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

    console.error(`[@diplodoc/infra] Exporting inventory for ${repos.length} repo(s)...`);

    let result;
    try {
        result = await exportInventory({
            token,
            owner,
            repos,
            registryEntries,
            skipChecks,
        });
    } catch (error) {
        console.error(`[@diplodoc/infra] Fatal: ${error.message}`);
        process.exit(1);
    }

    const json = JSON.stringify(result.inventory, null, 2);
    if (outputFile) {
        writeOutput(outputFile, json);
        console.error(`[@diplodoc/infra] Inventory JSON written to ${outputFile}`);
    } else {
        console.log(json);
    }

    if (markdownFile) {
        const md = renderMarkdown(result.inventory, result.summary);
        writeOutput(markdownFile, md);
        console.error(`[@diplodoc/infra] Markdown report written to ${markdownFile}`);
    }

    console.error(
        `[@diplodoc/infra] ${result.inventory.length} PRs across ${result.summary.repoCount} repos` +
            ` (${result.summary.securityPrs} security, ${result.summary.failingPrs} failing,` +
            ` ${result.summary.olderThan30Days} >30d, ${result.summary.olderThan90Days} >90d)`,
    );
    if (result.errors.length > 0) {
        console.error(`[@diplodoc/infra] ${result.errors.length} error(s):`);
        for (const e of result.errors) {
            console.error(`  ${e.repo}: ${e.phase} — ${e.message}`);
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[@diplodoc/infra] fatal: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    parseRepoList,
    computeAgeDays,
    extractDependencyFromTitle,
    isSecurityPr,
    normalizeLabels,
    deriveUpdateType,
    compareSemver,
    parseSemver,
    assessRisk,
    buildInventoryEntry,
    sortInventory,
    summarizeByRepo,
    summarizeInventory,
    renderMarkdown,
    exportInventory,
    loadConfig,
    loadRegistry,
};
