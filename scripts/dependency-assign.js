#!/usr/bin/env node

/**
 * dependency-assign.js
 *
 * Auto-assign an owner to Dependabot PRs that breach their SLA and maintain
 * a single tracking issue in the `infra` repository.
 *
 * Builds on the T8.1 health audit (SLA breach detection) and the T9.1 PR
 * inventory. For every PR past its SLA deadline the script:
 *
 *   1. Resolves an owner — the registry entry's `owner` field when the
 *      changed dependency is covered by a policy exception, otherwise the
 *      default platform team (`@diplodoc-platform/team`).
 *   2. Auto-assigns that owner to the PR via the GitHub REST API
 *      (`POST /repos/{owner}/{repo}/issues/{number}/assignees`).
 *   3. Creates or updates a single tracking issue in the `infra` repo titled
 *      `SLA Breach Tracking` whose body lists every breaching PR grouped by
 *      owner and carries the "fix or file exception" reminder.
 *
 * The workflow step is idempotent: re-runs update the same tracking issue
 * (matched by title) rather than creating duplicates, and re-assigning an
 * already-assigned PR is a no-op on the GitHub side.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/dependency-assign.js [flags]
 *   - As a module: require('./dependency-assign') -> pure helpers for tests.
 *
 * Flags:
 *   --all                 Audit all repositories from distribution.yml (+ infra)
 *   --repo <name>         Audit a single repository short name
 *   --config <path>       Path to distribution.yml (default: bundled)
 *   --registry <path>     Path to dependency-policy.yml (default: bundled)
 *   --output <path>       Write JSON assign report to file (default: stdout)
 *   --markdown <path>     Write tracking-issue markdown to file
 *   --owner <name>        GitHub org owner (default: diplodoc-platform)
 *   --tracking-repo <name> Repo where the tracking issue is posted (default: infra)
 *   --default-owner <login> Fallback assignee when no registry owner (default: diplodoc-platform/team)
 *   --dry-run             Do not assign or post — only print what would happen
 *   --skip-checks         Skip per-PR check-status lookup (faster)
 *
 * Environment variables:
 *   GH_TOKEN              GitHub token (App installation token) with repo:read + issues:write
 *   GITHUB_TOKEN          Fallback for GH_TOKEN
 */

const {readFileSync, writeFileSync, mkdirSync} = require('node:fs');
const {dirname, join, resolve} = require('node:path');

const {parseRepoList, exportInventory, loadConfig, loadRegistry} = require('./export-pr-inventory');

const {computeHealth} = require('./dependency-health');

const {filterEntriesForRepo} = require('./generate-dependency-policy');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = 'diplodoc-platform';
const INFRA_REPO = 'infra';
const API_ROOT = 'https://api.github.com';

/**
 * Stable title for the single SLA-breach tracking issue in the infra repo.
 * Kept date-free so the same issue is updated across daily runs rather than
 * a new issue being created every day.
 */
const TRACKING_ISSUE_TITLE = 'SLA Breach Tracking';

/**
 * Default assignee when no registry `owner` field matches the breaching PR.
 * The literal `@diplodoc-platform/team` is a team mention used in the
 * tracking-issue body; for the assignees API we strip the leading `@` and
 * the `/team` suffix is NOT a valid login, so the API call uses the
 * `DEFAULT_ASSIGNEE_LOGIN` constant instead.
 */
const DEFAULT_OWNER_TEAM = '@diplodoc-platform/team';

/**
 * Fallback login used for the assignees API when no registry owner resolves.
 * GitHub's assignees API accepts user logins (not team slugs), so we fall
 * back to the org-wide machine user. This is a best-effort signal — the
 * tracking issue still @-mentions the team for human triage.
 */
const DEFAULT_ASSIGNEE_LOGIN = 'diplodoc-bot';

/**
 * Labels applied to the tracking issue.
 */
const TRACKING_ISSUE_LABELS = ['dependency-health', 'sla-breach'];

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no process state)
// ---------------------------------------------------------------------------

/**
 * Resolve the owner for a breaching PR.
 *
 * Resolution order:
 *   1. Registry entry `owner` field (when the changed dependency matches a
 *      policy exception scoped to the PR's repository).
 *   2. `defaultOwner` argument (defaults to the platform team mention).
 *
 * The returned value is a human-readable owner string suitable for the
 * tracking-issue body (may be a `@team` mention). Use `resolveAssigneeLogin`
 * to derive a valid GitHub login for the assignees API.
 *
 * @param {object} pr Assessed PR (must contain `repo`, `dependency`).
 * @param {Array<object>} registryEntries Full central registry entries.
 * @param {string} [defaultOwner] Fallback owner string.
 * @returns {string} Owner string (may be `@team`, `@user`, or a name).
 */
function resolveOwner(pr, registryEntries, defaultOwner = DEFAULT_OWNER_TEAM) {
    if (!pr || !Array.isArray(registryEntries)) return defaultOwner;
    const scoped = filterEntriesForRepo(registryEntries, pr.repo);
    const depName = pr.dependency || '';
    for (const entry of scoped) {
        if (entry && entry.dependency === depName && entry.owner) {
            return entry.owner;
        }
    }
    return defaultOwner;
}

/**
 * Derive a valid GitHub login for the assignees API from an owner string.
 *
 * Registry `owner` values may be `@user`, `@team`, or a bare name. The
 * assignees API accepts only user logins (no team slugs, no leading `@`).
 * Team mentions (`@org/team`) are not assignable, so they fall back to
 * `defaultLogin`.
 *
 * @param {string} owner Owner string (e.g. `@diplodoc-platform/team`, `@alice`).
 * @param {string} [defaultLogin] Fallback login.
 * @returns {string} A bare GitHub login (no leading `@`).
 */
function resolveAssigneeLogin(owner, defaultLogin = DEFAULT_ASSIGNEE_LOGIN) {
    if (!owner || typeof owner !== 'string') return defaultLogin;
    const trimmed = owner.trim();
    if (!trimmed) return defaultLogin;
    const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    if (stripped.includes('/')) return defaultLogin;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(stripped)) return defaultLogin;
    return stripped;
}

/**
 * Group breaching PRs by their resolved owner.
 *
 * @param {Array<object>} breachingPrs Assessed PRs with `breach: true`.
 * @param {Array<object>} registryEntries Central registry entries.
 * @param {string} [defaultOwner] Fallback owner string.
 * @returns {object} Map of owner string -> array of PRs.
 */
function groupBreachesByOwner(breachingPrs, registryEntries, defaultOwner) {
    const groups = {};
    if (!Array.isArray(breachingPrs)) return groups;
    for (const pr of breachingPrs) {
        const owner = resolveOwner(pr, registryEntries, defaultOwner);
        if (!groups[owner]) groups[owner] = [];
        groups[owner].push(pr);
    }
    return groups;
}

/**
 * Build the list of assignment actions from the health audit.
 *
 * Each action describes a PR that should have an assignee added. Actions are
 * deduplicated by `${repo}#${number}` so a PR breaching multiple rules is
 * only assigned once.
 *
 * @param {object} health Health audit result ({prs, exceptions, summary}).
 * @param {Array<object>} registryEntries Central registry entries.
 * @param {string} [defaultOwner] Fallback owner string.
 * @returns {Array<{repo: string, number: number, owner: string, login: string}>}
 */
function buildAssignActions(health, registryEntries, defaultOwner) {
    const prs = health && Array.isArray(health.prs) ? health.prs : [];
    const breaching = prs.filter((p) => p.breach);
    const seen = new Set();
    const actions = [];
    for (const pr of breaching) {
        const key = `${pr.repo}#${pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const owner = resolveOwner(pr, registryEntries, defaultOwner);
        const login = resolveAssigneeLogin(owner);
        actions.push({repo: pr.repo, number: pr.number, owner, login});
    }
    return actions;
}

function escapePipe(str) {
    return String(str || '').replace(/\|/g, '\\|');
}

/**
 * Render the tracking-issue body markdown.
 *
 * The body lists every breaching PR grouped by owner, followed by the
 * "fix or file exception" reminder.
 *
 * @param {object} health Health audit result ({prs, exceptions, summary}).
 * @param {Array<object>} registryEntries Central registry entries.
 * @param {string} [defaultOwner] Fallback owner string.
 * @param {string} [generatedAt] ISO timestamp (default: now).
 * @returns {string} Markdown body.
 */
function renderTrackingIssue(health, registryEntries, defaultOwner, generatedAt) {
    const prs = health && Array.isArray(health.prs) ? health.prs : [];
    const breaching = prs
        .filter((p) => p.breach)
        .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
    const summary = (health && health.summary) || {};
    const groups = groupBreachesByOwner(breaching, registryEntries, defaultOwner);
    const stamp = generatedAt || new Date().toISOString();

    const lines = [];
    lines.push('## SLA Breach Tracking');
    lines.push('');
    lines.push(`_Last updated: ${stamp}_`);
    lines.push('');
    lines.push('This issue is auto-maintained by the `Dependency Health Audit` workflow (T8.3).');
    lines.push('It tracks Dependabot PRs that have exceeded their SLA deadline. Each PR must');
    lines.push('either be **fixed** (merged, closed, or rebased) or have a **policy exception**');
    lines.push('filed in `dependency-policy.yml` (see DEP-NNNN entries).');
    lines.push('');

    lines.push('### Summary');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total breaching PRs | ${breaching.length} |`);
    lines.push(`| Security PRs breaching | ${summary.securityBreaching || 0} |`);
    lines.push(`| Critical-risk PRs breaching | ${summary.criticalBreaching || 0} |`);
    lines.push(`| Distinct owners | ${Object.keys(groups).length} |`);
    lines.push('');

    if (breaching.length === 0) {
        lines.push('**No SLA breaches detected.** This issue will remain open as a placeholder');
        lines.push('and will be updated on the next audit run if breaches appear.');
        lines.push('');
    } else {
        const ownerNames = Object.keys(groups).sort();
        for (const owner of ownerNames) {
            const ownerPrs = groups[owner];
            lines.push(`### Owner: ${owner}`);
            lines.push('');
            lines.push(
                '| Repo | # | Age (d) | SLA | Overdue (d) | Security | Risk | Dependency | From | To | Title |',
            );
            lines.push(
                '|------|---|---------|-----|------------|----------|------|------------|------|-----|-------|',
            );
            for (const pr of ownerPrs) {
                const sec = pr.security ? 'yes' : '';
                lines.push(
                    `| ${pr.repo} | ${pr.number} | ${pr.ageDays} | ${pr.slaLabel} | ${pr.daysOverdue} | ${sec} | ${pr.risk} | ${pr.dependency || '—'} | ${pr.fromVersion || '—'} | ${pr.toVersion || '—'} | ${escapePipe(pr.title)} |`,
                );
            }
            lines.push('');
        }

        lines.push('### Reminder — fix or file an exception');
        lines.push('');
        lines.push('For each breaching PR above:');
        lines.push('');
        lines.push('1. **Fix the PR** — merge it, close it, or rebase it onto the target branch.');
        lines.push('2. **File a policy exception** — if the PR is blocked for a known reason');
        lines.push('   (e.g. `svgo` output regression), add or update a `DEP-NNNN` entry in');
        lines.push('   `devops/infra/dependency-policy.yml` with `reason`, `owner`, `evidence`,');
        lines.push('   `verification-profile`, `review-after`, and `exit-criteria`. See');
        lines.push('   `docs/svgo-exception-tagging.md` for the established procedure.');
        lines.push('');
        lines.push('A known breakage must not remain just a red PR. Either it gets fixed, or a');
        lines.push('policy exception is filed.');
        lines.push('');
    }

    lines.push('---');
    lines.push('_Auto-generated by `@diplodoc/infra` Dependency Health Audit (T8.3)._');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub API layer (thin wrapper around fetch)
// ---------------------------------------------------------------------------

async function ghRequest(token, method, path, body) {
    const opts = {
        method: method || 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'diplodoc-infra-assign',
        },
    };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_ROOT}${path}`, opts);
    const text = await res.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    return {ok: res.ok, status: res.status, json};
}

/**
 * Add assignees to a PR (issues API — PRs are issues in GitHub's API).
 *
 * @param {string} token
 * @param {string} owner Org owner.
 * @param {string} repo Repo short name.
 * @param {number} number PR number.
 * @param {string[]} logins Assignee logins (no leading @).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function addAssignees(token, owner, repo, number, logins) {
    const {ok, status, json} = await ghRequest(
        token,
        'POST',
        `/repos/${owner}/${repo}/issues/${number}/assignees`,
        {assignees: logins},
    );
    if (!ok) {
        const detail = json && json.message ? json.message : `HTTP ${status}`;
        return {ok: false, error: detail};
    }
    return {ok: true};
}

/**
 * Find an open issue by title in the tracking repo.
 *
 * @param {string} token
 * @param {string} owner Org owner.
 * @param {string} repo Tracking repo (default: infra).
 * @param {string} title Issue title to search for.
 * @returns {Promise<number|null>} Issue number or null if not found.
 */
async function findTrackingIssue(token, owner, repo, title) {
    const {ok, json} = await ghRequest(
        token,
        'GET',
        `/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:issue is:open in:title "${title}"`)}`,
    );
    if (!ok || !json || !Array.isArray(json.items) || json.items.length === 0) {
        return null;
    }
    return json.items[0].number;
}

/**
 * Create a new tracking issue.
 *
 * @param {string} token
 * @param {string} owner Org owner.
 * @param {string} repo Tracking repo.
 * @param {string} title Issue title.
 * @param {string} body Issue body markdown.
 * @param {string[]} [labels] Issue labels.
 * @returns {Promise<{number: number, created: true}>}
 */
async function createTrackingIssue(token, owner, repo, title, body, labels) {
    const {ok, status, json} = await ghRequest(token, 'POST', `/repos/${owner}/${repo}/issues`, {
        title,
        body,
        labels: labels || TRACKING_ISSUE_LABELS,
    });
    if (!ok || !json || !json.number) {
        const detail = json && json.message ? json.message : `HTTP ${status}`;
        throw new Error(`Failed to create tracking issue: ${detail}`);
    }
    return {number: json.number, created: true};
}

/**
 * Update an existing tracking issue's body.
 *
 * @param {string} token
 * @param {string} owner Org owner.
 * @param {string} repo Tracking repo.
 * @param {number} number Issue number.
 * @param {string} body Issue body markdown.
 * @returns {Promise<{number: number, created: false}>}
 */
async function updateTrackingIssue(token, owner, repo, number, body) {
    const {ok, status, json} = await ghRequest(
        token,
        'PATCH',
        `/repos/${owner}/${repo}/issues/${number}`,
        {body},
    );
    if (!ok) {
        const detail = json && json.message ? json.message : `HTTP ${status}`;
        throw new Error(`Failed to update tracking issue #${number}: ${detail}`);
    }
    return {number, created: false};
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full auto-assign + tracking-issue flow.
 *
 * @param {object} params
 * @param {string} params.token GitHub token (App installation token).
 * @param {string} params.owner GitHub org owner.
 * @param {string[]} params.repos Repository short names.
 * @param {Array<object>} [params.registryEntries] Central registry entries.
 * @param {boolean} [params.skipChecks] Skip per-PR check-status lookup.
 * @param {string} [params.trackingRepo] Repo for the tracking issue (default: infra).
 * @param {string} [params.defaultOwner] Fallback owner string.
 * @param {boolean} [params.dryRun] Skip network mutations (assign + issue).
 * @param {Date} [params.now] Reference time.
 * @returns {Promise<{actions: Array, issue: object|null, summary: object, errors: Array}>}
 */
async function runAssign({
    token,
    owner,
    repos,
    registryEntries = [],
    skipChecks = false,
    trackingRepo,
    defaultOwner,
    dryRun = false,
    now,
}) {
    const referenceTime = now || new Date();
    const errors = [];

    // 1. Health audit (reuses export-pr-inventory + dependency-health)
    const invResult = await exportInventory({token, owner, repos, registryEntries, skipChecks});
    for (const e of invResult.errors || []) {
        errors.push(e);
    }
    const health = computeHealth(invResult.inventory, registryEntries, referenceTime);

    // 2. Build assignment actions
    const actions = buildAssignActions(health, registryEntries, defaultOwner);

    // 3. Render tracking-issue body
    const body = renderTrackingIssue(
        health,
        registryEntries,
        defaultOwner,
        referenceTime.toISOString(),
    );

    let issue = null;

    if (dryRun) {
        return {actions, issue: null, health, summary: health.summary, errors};
    }

    // 4. Apply assignments
    const assignmentResults = [];
    for (const action of actions) {
        try {
            const res = await addAssignees(token, owner, action.repo, action.number, [
                action.login,
            ]);
            assignmentResults.push({...action, ...res});
            if (!res.ok) {
                errors.push({repo: action.repo, phase: 'assign', message: res.error || 'unknown'});
            }
        } catch (error) {
            assignmentResults.push({...action, ok: false, error: error.message});
            errors.push({repo: action.repo, phase: 'assign', message: error.message});
        }
    }

    // 5. Create or update the tracking issue
    const trackingRepoName = trackingRepo || INFRA_REPO;
    try {
        const existing = await findTrackingIssue(
            token,
            owner,
            trackingRepoName,
            TRACKING_ISSUE_TITLE,
        );
        if (existing) {
            issue = await updateTrackingIssue(token, owner, trackingRepoName, existing, body);
        } else {
            issue = await createTrackingIssue(
                token,
                owner,
                trackingRepoName,
                TRACKING_ISSUE_TITLE,
                body,
                TRACKING_ISSUE_LABELS,
            );
        }
    } catch (error) {
        errors.push({repo: trackingRepoName, phase: 'tracking-issue', message: error.message});
    }

    return {
        actions: assignmentResults,
        issue,
        health,
        summary: health.summary,
        errors,
    };
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
    const trackingRepo = flags['tracking-repo'] || INFRA_REPO;
    const defaultOwner = flags['default-owner'] || DEFAULT_OWNER_TEAM;
    const dryRun = flags['dry-run'] === true;

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
    if (!token && !dryRun) {
        console.error('Error: GH_TOKEN env var is required (or use --dry-run)');
        process.exit(1);
    }

    const registryEntries = loadRegistry(flags.registry);
    const skipChecks = flags['skip-checks'] === true;

    console.error(
        `[@diplodoc/infra] Auto-assigning owners for SLA-breaching PRs across ${repos.length} repo(s)...`,
    );

    let result;
    try {
        result = await runAssign({
            token: token || '',
            owner,
            repos,
            registryEntries,
            skipChecks,
            trackingRepo,
            defaultOwner,
            dryRun,
        });
    } catch (error) {
        console.error(`[@diplodoc/infra] Fatal: ${error.message}`);
        process.exit(1);
    }

    const report = {
        actions: result.actions,
        issue: result.issue,
        summary: result.summary,
        errors: result.errors,
    };
    const json = JSON.stringify(report, null, 2);
    if (outputFile) {
        writeOutput(outputFile, json);
        console.error(`[@diplodoc/infra] Assign report written to ${outputFile}`);
    } else {
        console.log(json);
    }

    if (markdownFile) {
        const md = renderTrackingIssue(
            result.health || {prs: [], summary: result.summary},
            registryEntries,
            defaultOwner,
        );
        writeOutput(markdownFile, md);
        console.error(`[@diplodoc/infra] Tracking-issue markdown written to ${markdownFile}`);
    }

    const s = result.summary || {};
    const breaches = (result.actions || []).length;
    console.error(
        `[@diplodoc/infra] ${breaches} SLA-breaching PR(s) assigned` +
            ` (${s.securityBreaching || 0} security, ${s.criticalBreaching || 0} critical)` +
            (result.issue
                ? `, tracking issue #${result.issue.number} (${result.issue.created ? 'created' : 'updated'})`
                : ', no tracking issue'),
    );
    if (result.errors.length > 0) {
        console.error(`[@diplodoc/infra] ${result.errors.length} error(s):`);
        for (const e of result.errors) {
            console.error(`  ${e.repo}: ${e.phase} — ${e.message}`);
        }
    }

    if (breaches > 0) {
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
    DEFAULT_OWNER,
    DEFAULT_OWNER_TEAM,
    DEFAULT_ASSIGNEE_LOGIN,
    INFRA_REPO,
    TRACKING_ISSUE_TITLE,
    TRACKING_ISSUE_LABELS,
    resolveOwner,
    resolveAssigneeLogin,
    groupBreachesByOwner,
    buildAssignActions,
    renderTrackingIssue,
    addAssignees,
    findTrackingIssue,
    createTrackingIssue,
    updateTrackingIssue,
    runAssign,
};
