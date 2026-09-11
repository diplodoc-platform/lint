#!/usr/bin/env node

/**
 * auto-merge.js
 *
 * Auto-merge workflow for Dependabot PRs (T10.2).
 *
 * Evaluates every open Dependabot PR across the Diplodoc platform against
 * the 9 strict auto-merge conditions defined in T10.1 (`auto-merge-rules.js`).
 * PRs that pass ALL conditions (and are not hard-excluded) are auto-merged
 * via the GitHub REST API after the 24-hour soak window.
 *
 * The workflow is **phase-gated**: it runs in `dry-run` mode by default
 * (surfaces qualifying PRs in the audit log without merging).  Enabling
 * live merges requires setting `AUTOMERGE_ENABLED=true` — this is the
 * "4–6 weeks of stable operation" gate described in the epic (E10).
 *
 * Audit log: every evaluated PR is recorded in a structured JSON audit
 * entry with the decision, reasons, and merge outcome.  The audit log is
 * uploaded as a workflow artifact and appended to a tracking issue for
 * human review and rollback traceability.
 *
 * Setting `AUTOMERGE_ENABLED=false` immediately stops future auto-merges.
 * Rollback is intentionally manual (`git revert` + reviewed PR); GitHub does
 * not expose the previously assumed REST revert endpoint.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/auto-merge.js [flags]
 *   - As a module: require('./auto-merge') -> pure helpers for tests.
 *
 * Flags:
 *   --all                 Evaluate all repositories from distribution.yml (+ infra)
 *   --repo <name>         Evaluate a single repository short name
 *   --config <path>       Path to distribution.yml (default: bundled)
 *   --registry <path>     Path to dependency-policy.yml (default: bundled)
 *   --output <path>       Write JSON audit log to file (default: stdout)
 *   --markdown <path>     Write markdown audit report to file
 *   --owner <name>        GitHub org owner (default: diplodoc-platform)
 *   --dry-run             Audit-only: evaluate but do not merge (default)
 *   --enabled             Enable live auto-merge (phase 2)
 *   --skip-checks         Skip per-PR check-status lookup (faster, less data)
 *   --tracking-repo <name> Repo for audit tracking issue (default: infra)
 *
 * Environment variables:
 *   GH_TOKEN              GitHub token (App installation token)
 *   GITHUB_TOKEN          Fallback for GH_TOKEN
 *   AUTOMERGE_ENABLED     'true' enables live merges (equivalent to --enabled)
 */

const {readFileSync, writeFileSync, mkdirSync, existsSync} = require('node:fs');
const {dirname, join, resolve} = require('node:path');

const {parseRepoList, exportInventory, loadConfig, loadRegistry} = require('./export-pr-inventory');

const {evaluateAutoMerge, AUTO_MERGE_CONDITIONS, SOAK_WINDOW_MS} = require('./auto-merge-rules');

const {filterEntriesForRepo} = require('./generate-dependency-policy');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = 'diplodoc-platform';
const INFRA_REPO = 'infra';
const API_ROOT = 'https://api.github.com';

/**
 * Audit tracking issue title (stable, date-free for update-in-place).
 */
const AUDIT_ISSUE_TITLE = 'Auto-merge Audit Log';
const AUDIT_ISSUE_LABELS = ['dependency-health', 'auto-merge'];

/**
 * Maximum number of files to fetch per PR (GitHub API paginates at 100).
 * A qualifying PR touches only package.json + lockfile (2 files), so 100
 * is more than enough to detect grouped PRs and snapshot changes.
 */
const MAX_PR_FILES = 100;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no process state)
// ---------------------------------------------------------------------------

/**
 * Determine the package.json section that changed from a unified diff patch.
 *
 * The patch text from the GitHub API contains lines like:
 *   `+"devDependencies": {`
 *   `+    "eslint": "8.0.0",`
 *   `-    "eslint": "7.0.0",`
 *
 * We look for added (`+`) lines containing a section name key to determine
 * which section the dependency change lives in.  If multiple sections
 * changed, we return the first production-relevant one (conservative —
 * production deps block auto-merge, so the caller sees the exclusion).
 *
 * @param {string} patch Unified diff patch text for package.json.
 * @returns {string|null} Section name or null if not determinable.
 */
function deriveSection(patch) {
    if (typeof patch !== 'string' || patch.length === 0) return null;
    const sections = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
    ];
    for (const section of sections) {
        const pattern = new RegExp(`^\\+\\s*["']${section}["']\\s*:`, 'm');
        if (pattern.test(patch)) {
            return section;
        }
    }
    return null;
}

/**
 * Determine whether a PR is a grouped Dependabot PR.
 *
 * A grouped PR bundles multiple dependency updates.  We detect this by:
 *   1. The `grouped` label (Dependabot attaches this for grouped updates).
 *   2. Multiple distinct dependency names in the title (e.g. "Bump eslint
 *      and prettier").
 *   3. Multiple package.json sections changed (uncommon for a single dep).
 *
 * @param {{labels?: string[], title?: string, dependency?: string}} entry Inventory entry.
 * @param {Array<object>} [prFiles] PR files (optional, for multi-file check).
 * @returns {boolean}
 */
function deriveIsGrouped(entry, prFiles) {
    if (!entry) return false;
    const labels = Array.isArray(entry.labels) ? entry.labels : [];
    if (labels.includes('grouped')) return true;
    if (labels.includes('dependencies') && typeof entry.title === 'string') {
        const titleLower = entry.title.toLowerCase();
        if (titleLower.includes(' and ') || titleLower.includes('grouped')) return true;
    }
    if (Array.isArray(prFiles)) {
        const pkgJsonFiles = prFiles.filter(
            (f) => f && (f.filename === 'package.json' || f.filename.endsWith('/package.json')),
        );
        if (pkgJsonFiles.length > 1) return true;
    }
    return false;
}

/**
 * Derive the CI completion timestamp from a check-runs API response.
 *
 * Finds the latest `completed_at` timestamp across all check runs.  This
 * represents when CI last finished (green or red).  The `ci-24h-soak`
 * condition uses this to enforce the 24-hour soak window.
 *
 * @param {object} checkRunsResponse GitHub check-runs API response.
 * @returns {string|null} ISO timestamp or null if no completed checks.
 */
function deriveCiCompletedAt(checkRunsResponse) {
    if (!checkRunsResponse || !Array.isArray(checkRunsResponse.check_runs)) {
        return null;
    }
    let latest = null;
    for (const run of checkRunsResponse.check_runs) {
        if (run && run.completed_at) {
            if (latest === null || run.completed_at > latest) {
                latest = run.completed_at;
            }
        }
    }
    return latest;
}

/**
 * Check if every required branch-protection context is green.
 *
 * @param {object} checkRunsResponse GitHub check-runs API response.
 * @param {string[]} requiredChecks Required check context names.
 * @returns {boolean}
 */
function deriveChecksGreen(checkRunsResponse, requiredChecks = []) {
    if (!checkRunsResponse || !Array.isArray(checkRunsResponse.check_runs)) {
        return false;
    }
    if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) return false;
    const latestByName = new Map();
    for (const run of checkRunsResponse.check_runs) {
        if (!run || !run.name) continue;
        const previous = latestByName.get(run.name);
        if (!previous || Number(run.id || 0) >= Number(previous.id || 0)) {
            latestByName.set(run.name, run);
        }
    }
    const successfulConclusions = new Set(['success', 'neutral', 'skipped']);
    return requiredChecks.every((name) => {
        const run = latestByName.get(name);
        return run && run.status === 'completed' && successfulConclusions.has(run.conclusion);
    });
}

/**
 * Determine whether a registry entry covers the changed dependency.
 *
 * @param {string} dependency Dependency name.
 * @param {Array<object>} scopedEntries Registry entries scoped to the repo.
 * @returns {boolean}
 */
function deriveHasException(dependency, scopedEntries) {
    if (!dependency || !Array.isArray(scopedEntries)) return false;
    return scopedEntries.some((e) => e && e.dependency === dependency);
}

/**
 * Count new transitive dependencies from a lockfile diff patch.
 *
 * A "new transitive" is a package that appears in the `packages` or
 * `dependencies` section of package-lock.json with an added (`+`) line
 * and is NOT a direct dependency (i.e. it's nested under `node_modules/`
 * with a path prefix, indicating it's transitive).
 *
 * To distinguish NEW entries from UPDATED entries (version bump of an
 * existing package), we check that the added `node_modules/<name>` key
 * does NOT have a corresponding removed (`-`) line with the same key.
 * A version update produces both a `-` and `+` line for the same key.
 *
 * @param {string} lockPatch Unified diff patch for package-lock.json.
 * @returns {number}
 */
function deriveNewTransitiveCount(lockPatch) {
    if (typeof lockPatch !== 'string' || lockPatch.length === 0) return 0;
    const lines = lockPatch.split('\n');
    const added = new Set();
    const removed = new Set();
    for (const line of lines) {
        const addMatch = line.match(/^\+\s*["'](node_modules\/[^"']+)["']\s*:/);
        if (addMatch) added.add(addMatch[1]);
        const removeMatch = line.match(/^-\s*["'](node_modules\/[^"']+)["']\s*:/);
        if (removeMatch) removed.add(removeMatch[1]);
    }
    // New transitive = added entries that were NOT previously present (no removal).
    let count = 0;
    for (const name of added) {
        if (!removed.has(name)) count++;
    }
    return count;
}

/**
 * Build the evaluation input object for `evaluateAutoMerge` from an
 * inventory entry and supplementary GitHub API data.
 *
 * @param {object} entry Inventory entry (from export-pr-inventory).
 * @param {Array<object>} prFiles PR files (from GET /pulls/{n}/files).
 * @param {object} [extra] Supplementary data:
 *   - `packageJsonPatch` — patch text for package.json
 *   - `lockPatch` — patch text for package-lock.json
 *   - `checkRuns` — check-runs API response for head SHA
 *   - `scopedEntries` — registry entries scoped to the repo
 *   - `now` — reference time (for soak window)
 * @returns {object} Input for evaluateAutoMerge.
 */
function buildEvaluationInput(entry, prFiles, extra = {}) {
    const files = Array.isArray(prFiles) ? prFiles : [];
    const changedFiles = files.map((f) => (f && f.filename) || '').filter(Boolean);

    // Derive patches from PR files when not explicitly provided in extra.
    const packageJsonFile = files.find((f) => f && f.filename === 'package.json');
    const lockFile = files.find(
        (f) => f && (f.filename === 'package-lock.json' || f.filename === 'npm-shrinkwrap.json'),
    );
    const packageJsonPatch =
        extra.packageJsonPatch !== undefined
            ? extra.packageJsonPatch
            : packageJsonFile
              ? packageJsonFile.patch || ''
              : '';
    const lockPatch =
        extra.lockPatch !== undefined ? extra.lockPatch : lockFile ? lockFile.patch || '' : '';

    const section = packageJsonPatch ? deriveSection(packageJsonPatch) : entry.section || null;

    const isGrouped = deriveIsGrouped(entry, files);

    const checkRuns = extra.checkRuns || null;
    const requiredChecks = Array.isArray(extra.requiredChecks) ? extra.requiredChecks : [];
    const ciCompletedAt =
        extra.ciCompletedAt ||
        deriveCiCompletedAt({
            check_runs: ((checkRuns && checkRuns.check_runs) || []).filter((run) =>
                requiredChecks.includes(run.name),
            ),
        });
    const checksGreen =
        extra.checksGreen !== undefined
            ? extra.checksGreen
            : deriveChecksGreen(checkRuns, requiredChecks);

    const scopedEntries = extra.scopedEntries || [];
    const hasException = deriveHasException(entry.dependency, scopedEntries);

    const newTransitiveDependencies =
        typeof extra.newTransitiveCount === 'number'
            ? extra.newTransitiveCount
            : lockPatch
              ? deriveNewTransitiveCount(lockPatch)
              : 0;

    return {
        updateType: entry.updateType || 'unknown',
        risk: entry.risk || 'unknown',
        section,
        hasException,
        newTransitiveDependencies,
        checksGreen,
        changedFiles,
        ciCompletedAt,
        now: extra.now,
        isGrouped,
        isSecurity: entry.security || false,
    };
}

/**
 * Evaluate a single PR for auto-merge eligibility.
 *
 * Wraps `evaluateAutoMerge` with the PR context to produce a structured
 * decision object suitable for the audit log.
 *
 * @param {object} entry Inventory entry.
 * @param {Array<object>} prFiles PR files.
 * @param {object} extra Supplementary data (see buildEvaluationInput).
 * @returns {{entry: object, evaluation: object, input: object}}
 */
function classifyPrForAutoMerge(entry, prFiles, extra = {}) {
    const input = buildEvaluationInput(entry, prFiles, extra);
    const evaluation = evaluateAutoMerge(input);
    return {entry, evaluation, input};
}

/**
 * Format a single audit log entry from a classification result.
 *
 * @param {{entry: object, evaluation: object}} classification
 * @param {{merged?: boolean, mergeError?: string, skipped?: string}} [outcome]
 * @param {string} [timestamp] ISO timestamp (default: now).
 * @returns {object} Audit entry.
 */
function formatAuditEntry(classification, outcome = {}, timestamp) {
    const {entry, evaluation} = classification;
    return {
        timestamp: timestamp || new Date().toISOString(),
        repo: entry.repo,
        number: entry.number,
        title: entry.title,
        url: entry.url,
        dependency: entry.dependency || '',
        fromVersion: entry.fromVersion || '',
        toVersion: entry.toVersion || '',
        updateType: entry.updateType,
        risk: entry.risk,
        security: entry.security || false,
        allowed: evaluation.allowed,
        excluded: evaluation.excluded,
        exclusions: evaluation.exclusions.map((e) => e.id),
        failedConditions: evaluation.conditions.filter((c) => !c.passed).map((c) => c.id),
        blockingReasons: evaluation.blockingReasons,
        merged: outcome.merged || false,
        mergeError: outcome.mergeError || null,
        skipped: outcome.skipped || null,
    };
}

/**
 * Render the audit log as a markdown report.
 *
 * @param {Array<object>} auditEntries Audit entries.
 * @param {object} [summary] Pre-computed summary.
 * @returns {string} Markdown document.
 */
function renderAuditLog(auditEntries, summary) {
    const entries = Array.isArray(auditEntries) ? auditEntries : [];
    const s = summary || summarizeAudit(entries);
    const lines = [];

    lines.push('# Auto-merge Audit Log');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total evaluated | ${s.totalEvaluated} |`);
    lines.push(`| Allowed (passed all conditions) | ${s.allowed} |`);
    lines.push(`| Excluded (hard exclusion) | ${s.excluded} |`);
    lines.push(`| Merged | ${s.merged} |`);
    lines.push(`| Merge errors | ${s.mergeErrors} |`);
    lines.push(`| Skipped (dry-run) | ${s.skipped} |`);
    lines.push('');

    if (entries.length === 0) {
        lines.push('_No Dependabot PRs found to evaluate._');
        lines.push('');
        return lines.join('\n');
    }

    lines.push('## Evaluated PRs');
    lines.push('');
    lines.push(
        '| Repo | # | Dependency | From | To | Type | Risk | Allowed | Excluded | Merged | Reason |',
    );
    lines.push(
        '|------|---|------------|------|-----|------|------|---------|----------|--------|--------|',
    );
    for (const e of entries) {
        const allowed = e.allowed ? 'yes' : '';
        const excluded = e.excluded ? 'yes' : '';
        const merged = e.merged ? 'yes' : e.skipped ? 'skip' : '';
        const reason = e.blockingReasons.length > 0 ? e.blockingReasons.join('; ') : '—';
        const esc = (v) => String(v || '').replace(/\|/g, '\\|');
        lines.push(
            `| ${esc(e.repo)} | ${e.number} | ${esc(e.dependency) || '—'} | ${esc(e.fromVersion) || '—'} | ${esc(e.toVersion) || '—'} | ${e.updateType} | ${e.risk} | ${allowed} | ${excluded} | ${merged} | ${esc(reason)} |`,
        );
    }
    lines.push('');

    if (s.merged > 0) {
        lines.push('## Auto-merged PRs');
        lines.push('');
        for (const e of entries) {
            if (!e.merged) continue;
            lines.push(
                `- [${e.repo}#${e.number}](${e.url}) — ${e.dependency} ${e.fromVersion} → ${e.toVersion}`,
            );
        }
        lines.push('');
        lines.push(
            '> **Rollback**: disable `AUTOMERGE_ENABLED`, run `git revert` for the merge commit, and open a reviewed PR.',
        );
        lines.push('> Setting `AUTOMERGE_ENABLED=false` immediately stops all future auto-merges.');
        lines.push('');
    }

    lines.push('---');
    lines.push('_Auto-generated by `@diplodoc/infra` Auto-merge Workflow (T10.2)._');

    return lines.join('\n');
}

/**
 * Summarize the audit log entries.
 *
 * @param {Array<object>} auditEntries
 * @returns {object}
 */
function summarizeAudit(auditEntries) {
    const entries = Array.isArray(auditEntries) ? auditEntries : [];
    let allowed = 0;
    let excluded = 0;
    let merged = 0;
    let mergeErrors = 0;
    let skipped = 0;
    for (const e of entries) {
        if (e.allowed) allowed++;
        if (e.excluded) excluded++;
        if (e.merged) merged++;
        if (e.mergeError) mergeErrors++;
        if (e.skipped) skipped++;
    }
    return {
        totalEvaluated: entries.length,
        allowed,
        excluded,
        merged,
        mergeErrors,
        skipped,
    };
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
            'User-Agent': 'diplodoc-infra-auto-merge',
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
 * Fetch the list of files changed by a PR.
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} number PR number.
 * @returns {Promise<Array<object>>} PR file objects (with filename, patch).
 */
async function fetchPrFiles(token, owner, repo, number) {
    const {ok, json} = await ghRequest(
        token,
        'GET',
        `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${MAX_PR_FILES}`,
    );
    if (!ok || !Array.isArray(json)) return [];
    return json;
}

/**
 * Fetch the check-runs for a commit SHA.
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha Head SHA.
 * @returns {Promise<object>} Check-runs API response.
 */
async function fetchCheckRuns(token, owner, repo, sha) {
    if (!sha) return {check_runs: []};
    try {
        const {ok, json} = await ghRequest(
            token,
            'GET',
            `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
        );
        if (!ok || !json) return {check_runs: []};
        return json;
    } catch {
        return {check_runs: []};
    }
}

/**
 * Extract required status-check contexts from both legacy branch protection
 * and the effective rules that GitHub reports for a branch.
 *
 * @param {object|null} protection Legacy required-status-check response.
 * @param {Array<object>|null} rules Effective branch rules response.
 * @returns {string[]}
 */
function extractRequiredCheckContexts(protection, rules) {
    const contexts = new Set();

    for (const context of Array.isArray(protection && protection.contexts)
        ? protection.contexts
        : []) {
        if (typeof context === 'string' && context) contexts.add(context);
    }
    for (const check of Array.isArray(protection && protection.checks) ? protection.checks : []) {
        if (check && typeof check.context === 'string' && check.context) {
            contexts.add(check.context);
        }
    }

    for (const rule of Array.isArray(rules) ? rules : []) {
        if (!rule || rule.type !== 'required_status_checks') continue;
        const required = rule.parameters && rule.parameters.required_status_checks;
        for (const check of Array.isArray(required) ? required : []) {
            if (check && typeof check.context === 'string' && check.context) {
                contexts.add(check.context);
            }
        }
    }

    return [...contexts];
}

/**
 * Fetch required status-check contexts from legacy branch protection and
 * active repository or organization rulesets. Inaccessible endpoints are
 * treated as empty; if neither source yields contexts, auto-merge fails closed.
 */
async function fetchRequiredChecks(token, owner, repo, branch) {
    if (!branch) return [];
    let protection = null;
    let rules = null;

    try {
        const response = await ghRequest(
            token,
            'GET',
            `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
        );
        if (response.ok) protection = response.json;
    } catch {}

    try {
        const response = await ghRequest(
            token,
            'GET',
            `/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
        );
        if (response.ok) rules = response.json;
    } catch {}

    return extractRequiredCheckContexts(protection, rules);
}

/**
 * Merge a pull request via the GitHub REST API.
 *
 * Uses the squash merge method (clean history, single commit per PR).
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} number PR number.
 * @param {string} sha Expected head SHA (safety: only merge if SHA matches).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function mergePullRequest(token, owner, repo, number, sha) {
    if (!sha) {
        return {ok: false, error: 'Missing expected PR head SHA; refusing to merge'};
    }
    const {ok, status, json} = await ghRequest(
        token,
        'PUT',
        `/repos/${owner}/${repo}/pulls/${number}/merge`,
        {
            merge_method: 'squash',
            sha,
        },
    );
    if (!ok) {
        const detail = json && json.message ? json.message : `HTTP ${status}`;
        return {ok: false, error: detail};
    }
    return {ok: true};
}

/**
 * Parse a GitHub PR URL into {owner, repo, number}.
 *
 * @param {string} url PR URL (e.g. https://github.com/diplodoc-platform/cli/pull/123)
 * @returns {{owner: string, repo: string, number: number}|null}
 */
function parsePrUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return {owner: match[1], repo: match[2], number: parseInt(match[3], 10)};
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the auto-merge evaluation and (optionally) merge qualifying PRs.
 *
 * @param {object} params
 * @param {string} params.token GitHub token.
 * @param {string} params.owner GitHub org owner.
 * @param {string[]} params.repos Repository short names.
 * @param {Array<object>} [params.registryEntries] Central registry entries.
 * @param {boolean} [params.skipChecks] Skip per-PR check-status lookup.
 * @param {boolean} [params.enabled] Enable live merges (default: false = dry-run).
 * @param {Date} [params.now] Reference time for soak window.
 * @returns {Promise<{audit: Array, summary: object, errors: Array}>}
 */
async function runAutoMerge({
    token,
    owner,
    repos,
    registryEntries = [],
    skipChecks = false,
    enabled = false,
    now,
}) {
    const referenceTime = now || new Date();
    const errors = [];

    // 1. Export the PR inventory (reuses export-pr-inventory)
    const invResult = await exportInventory({token, owner, repos, registryEntries, skipChecks});
    for (const e of invResult.errors || []) {
        errors.push(e);
    }
    const inventory = invResult.inventory || [];

    const audit = [];

    // 2. Evaluate each PR
    for (const entry of inventory) {
        let prFiles = [];
        let checkRuns = null;

        try {
            prFiles = await fetchPrFiles(token, owner, entry.repo, entry.number);
        } catch (error) {
            errors.push({repo: entry.repo, phase: 'fetch-files', message: error.message});
        }

        let requiredChecks = [];
        try {
            requiredChecks = await fetchRequiredChecks(token, owner, entry.repo, entry.baseRef);
            checkRuns = await fetchCheckRuns(token, owner, entry.repo, getHeadSha(entry));
            if (requiredChecks.length === 0) {
                errors.push({
                    repo: entry.repo,
                    phase: 'required-checks',
                    message: 'No required checks could be resolved',
                });
            }
        } catch (error) {
            errors.push({repo: entry.repo, phase: 'fetch-checks', message: error.message});
            checkRuns = {check_runs: []};
        }

        const scopedEntries = filterEntriesForRepo(registryEntries, entry.repo);
        const packageJsonFile = prFiles.find((f) => f && f.filename === 'package.json');
        const lockFile = prFiles.find(
            (f) =>
                f && (f.filename === 'package-lock.json' || f.filename === 'npm-shrinkwrap.json'),
        );

        const extra = {
            packageJsonPatch: packageJsonFile ? packageJsonFile.patch || '' : '',
            lockPatch: lockFile ? lockFile.patch || '' : '',
            checkRuns,
            requiredChecks,
            scopedEntries,
            now: referenceTime,
        };

        const classification = classifyPrForAutoMerge(entry, prFiles, extra);
        const evalResult = classification.evaluation;

        let outcome = {};

        if (evalResult.allowed && enabled) {
            const headSha = getHeadSha(entry);
            try {
                const mergeResult = await mergePullRequest(
                    token,
                    owner,
                    entry.repo,
                    entry.number,
                    headSha,
                );
                if (mergeResult.ok) {
                    outcome = {merged: true};
                } else {
                    outcome = {merged: false, mergeError: mergeResult.error};
                    errors.push({
                        repo: entry.repo,
                        phase: 'merge',
                        message: mergeResult.error || 'unknown',
                    });
                }
            } catch (error) {
                outcome = {merged: false, mergeError: error.message};
                errors.push({repo: entry.repo, phase: 'merge', message: error.message});
            }
        } else if (evalResult.allowed && !enabled) {
            outcome = {skipped: 'dry-run (AUTOMERGE_ENABLED not set)'};
        }

        audit.push(formatAuditEntry(classification, outcome, referenceTime.toISOString()));
    }

    const summary = summarizeAudit(audit);
    return {audit, summary, errors};
}

/**
 * Extract the immutable head SHA carried by the inventory entry.
 *
 * @param {object} entry Inventory entry.
 * @returns {string|undefined}
 */
function getHeadSha(entry) {
    return entry && entry.headSha ? entry.headSha : undefined;
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

    const enableRequested = flags.enabled === true || process.env.AUTOMERGE_ENABLED === 'true';
    const observationComplete = process.env.AUTOMERGE_OBSERVATION_COMPLETE === 'true';
    const enabled = enableRequested && observationComplete;

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
    if (enableRequested && !observationComplete) {
        console.error(
            'Error: live auto-merge requires AUTOMERGE_OBSERVATION_COMPLETE=true after the documented observation period',
        );
        process.exit(1);
    }
    if (enabled && skipChecks) {
        console.error(
            'Error: --skip-checks is audit-only and cannot be combined with live auto-merge',
        );
        process.exit(1);
    }

    const mode = enabled ? 'ENABLED (live merges)' : 'DRY-RUN (audit only)';
    console.error(`[@diplodoc/infra] Auto-merge evaluation — ${mode} — ${repos.length} repo(s)...`);

    let result;
    try {
        result = await runAutoMerge({
            token,
            owner,
            repos,
            registryEntries,
            skipChecks,
            enabled,
        });
    } catch (error) {
        console.error(`[@diplodoc/infra] Fatal: ${error.message}`);
        process.exit(1);
    }

    const json = JSON.stringify(result.audit, null, 2);
    if (outputFile) {
        writeOutput(outputFile, json);
        console.error(`[@diplodoc/infra] Audit log written to ${outputFile}`);
    } else {
        console.log(json);
    }

    if (markdownFile) {
        const md = renderAuditLog(result.audit, result.summary);
        writeOutput(markdownFile, md);
        console.error(`[@diplodoc/infra] Audit markdown written to ${markdownFile}`);
    }

    const s = result.summary;
    console.error(
        `[@diplodoc/infra] ${s.totalEvaluated} PR(s) evaluated: ${s.allowed} allowed, ${s.excluded} excluded, ${s.merged} merged, ${s.mergeErrors} errors, ${s.skipped} skipped (dry-run)`,
    );
    if (result.errors.length > 0) {
        console.error(`[@diplodoc/infra] ${result.errors.length} error(s):`);
        for (const e of result.errors) {
            console.error(`  ${e.repo}: ${e.phase} — ${e.message}`);
        }
    }

    if (s.mergeErrors > 0) {
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
    INFRA_REPO,
    AUDIT_ISSUE_TITLE,
    AUDIT_ISSUE_LABELS,
    SOAK_WINDOW_MS,
    AUTO_MERGE_CONDITIONS,
    deriveSection,
    deriveIsGrouped,
    deriveCiCompletedAt,
    deriveChecksGreen,
    deriveHasException,
    deriveNewTransitiveCount,
    buildEvaluationInput,
    classifyPrForAutoMerge,
    formatAuditEntry,
    renderAuditLog,
    summarizeAudit,
    parsePrUrl,
    fetchPrFiles,
    fetchCheckRuns,
    extractRequiredCheckContexts,
    fetchRequiredChecks,
    mergePullRequest,
    runAutoMerge,
};
