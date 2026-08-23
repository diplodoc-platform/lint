#!/usr/bin/env node

/**
 * dependency-health.js
 *
 * Central Dependency Health audit for the Diplodoc platform.
 *
 * Audits all 28 repositories (27 from distribution.yml + the infra source
 * repo) for open Dependabot PRs and evaluates each against the platform SLA:
 *
 *   - Critical security  — 1 business day
 *   - Other security     — 3 business days
 *   - Patch              — 7 calendar days
 *   - Minor              — 14 calendar days
 *   - Major              — 30 calendar days
 *   - Exception review   — at least every 90 days (registry review-after)
 *
 * The audit is the foundation of the `Dependency Health` workflow (T8.1) and
 * is consumed by the Daily Summary (T8.2). The PR inventory is obtained by
 * reusing `export-pr-inventory.js` (same GitHub App token), then SLA status
 * is computed by pure helpers exported here for unit tests.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/dependency-health.js [flags]
 *   - As a module: require('./dependency-health') -> pure helpers for tests.
 *
 * Flags:
 *   --all                 Audit all repositories from distribution.yml (+ infra)
 *   --repo <name>         Audit a single repository short name
 *   --config <path>       Path to distribution.yml (default: bundled)
 *   --registry <path>     Path to dependency-policy.yml (default: bundled)
 *   --output <path>       Write JSON health report to file (default: stdout)
 *   --markdown <path>     Write markdown report to file
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

const {resolveRegistryPath, filterEntriesForRepo} = require('./generate-dependency-policy');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = 'diplodoc-platform';
const INFRA_REPO = 'infra';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * SLA rules per category.
 *
 * `businessDays: true`  → deadline counts working days (Mon–Fri), skipping
 *                        weekends. Used for security PRs.
 * `businessDays: false` → deadline counts calendar days. Used for routine
 *                        version bumps and exception reviews.
 *
 * @typedef {{days: number, businessDays: boolean, label: string}} SlaRule
 */
const SLA_RULES = {
    'critical-security': {days: 1, businessDays: true, label: 'Critical security'},
    security: {days: 3, businessDays: true, label: 'Other security'},
    patch: {days: 7, businessDays: false, label: 'Patch'},
    minor: {days: 14, businessDays: false, label: 'Minor'},
    major: {days: 30, businessDays: false, label: 'Major'},
    unknown: {days: 14, businessDays: false, label: 'Unknown (treated as minor)'},
    exception: {days: 90, businessDays: false, label: 'Exception review'},
};

/**
 * Default SLA category used when a PR's update type cannot be determined.
 * Conservative: treated as a minor bump (14 calendar days) so an unclassifiable
 * PR is not silently given a generous major window.
 */
const DEFAULT_SLA_CATEGORY = 'unknown';

// ---------------------------------------------------------------------------
// Pure date helpers (no network, no process state)
// ---------------------------------------------------------------------------

/**
 * Whether a date falls on a Saturday or Sunday.
 *
 * @param {Date} date
 * @returns {boolean}
 */
function isWeekend(date) {
    const day = date.getUTCDay(); // 0=Sun .. 6=Sat
    return day === 0 || day === 6;
}

/**
 * Add `n` calendar days to a date, returning a new Date.
 *
 * @param {Date} date
 * @param {number} n
 * @returns {Date}
 */
function addCalendarDays(date, n) {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + n);
    return result;
}

/**
 * Add `n` business days (Mon–Fri) to a date, skipping weekends.
 * A negative `n` subtracts business days. The starting day itself is NOT
 * counted (i.e. addBusinessDays(Mon, 1) === Tue).
 *
 * @param {Date} date Start date (UTC).
 * @param {number} n Number of business days to add (>= 0 expected).
 * @returns {Date}
 */
function addBusinessDays(date, n) {
    const result = new Date(date.getTime());
    const step = n >= 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
        result.setUTCDate(result.getUTCDate() + step);
        if (!isWeekend(result)) {
            remaining -= 1;
        }
    }
    return result;
}

/**
 * Compute the SLA deadline for a PR given its creation time and SLA rule.
 *
 * @param {string|Date} createdAt ISO timestamp or Date of PR creation.
 * @param {SlaRule} rule
 * @returns {Date} Deadline date (UTC).
 */
function slaDeadline(createdAt, rule) {
    const start = createdAt instanceof Date ? createdAt : new Date(createdAt);
    const base = Number.isNaN(start.getTime()) ? new Date(0) : start;
    return rule.businessDays ? addBusinessDays(base, rule.days) : addCalendarDays(base, rule.days);
}

// ---------------------------------------------------------------------------
// SLA selection + assessment (pure)
// ---------------------------------------------------------------------------

/**
 * Select the SLA category for a PR inventory entry.
 *
 * Security PRs are split into critical-security (risk === 'critical') and
 * other security. Non-security PRs are classified by their update type
 * (patch / minor / major); unknown update types fall back to the conservative
 * default category.
 *
 * @param {{security?: boolean, risk?: string, updateType?: string}} pr
 * @returns {string} SLA category key (see SLA_RULES).
 */
function selectSlaCategory(pr) {
    if (pr && pr.security) {
        return pr.risk === 'critical' ? 'critical-security' : 'security';
    }
    const type = pr && pr.updateType;
    if (type && SLA_RULES[type] && type !== 'exception') {
        return type;
    }
    return DEFAULT_SLA_CATEGORY;
}

/**
 * Assess a single PR against its SLA.
 *
 * @param {object} pr Inventory entry from export-pr-inventory (must contain
 *                    createdAt, security, risk, updateType).
 * @param {Date} [now] Reference time (default: new Date()).
 * @returns {{repo: string, number: number, title: string, url: string,
 *            dependency: string, fromVersion: string, toVersion: string,
 *            security: boolean, risk: string, updateType: string,
 *            checkStatus: string, ageDays: number, slaCategory: string,
 *            slaLabel: string, slaDays: number, deadline: string,
 *            breach: boolean, daysOverdue: number}}
 */
function assessSla(pr, now = new Date()) {
    const category = selectSlaCategory(pr);
    const rule = SLA_RULES[category] || SLA_RULES[DEFAULT_SLA_CATEGORY];
    const created = new Date(pr.createdAt || now.toISOString());
    const deadline = slaDeadline(created, rule);
    const deadlineMs = deadline.getTime();
    const nowMs = now.getTime();
    const ageDays =
        pr.ageDays != null
            ? pr.ageDays
            : Math.max(0, Math.floor((nowMs - created.getTime()) / MS_PER_DAY));
    const daysOverdue = Math.max(0, Math.floor((nowMs - deadlineMs) / MS_PER_DAY));
    return {
        repo: pr.repo,
        number: pr.number,
        title: pr.title || '',
        url: pr.url || '',
        dependency: pr.dependency || '',
        fromVersion: pr.fromVersion || '',
        toVersion: pr.toVersion || '',
        security: !!pr.security,
        risk: pr.risk || 'unknown',
        updateType: pr.updateType || 'unknown',
        checkStatus: pr.checkStatus || 'unknown',
        ageDays,
        slaCategory: category,
        slaLabel: rule.label,
        slaDays: rule.days,
        deadline: deadline.toISOString(),
        breach: nowMs > deadlineMs,
        daysOverdue,
    };
}

/**
 * Assess a registry exception entry against the 90-day review cadence.
 *
 * @param {object} entry Registry entry (must contain id, review-after).
 * @param {Date} [now]
 * @returns {{id: string, dependency: string, repositories: Array,
 *            reviewAfter: string, daysUntilReview: number, overdue: boolean,
 *            reviewWindow: number}|null}
 */
function assessExceptionReview(entry, now = new Date()) {
    if (!entry || !entry.id) return null;
    const reviewAfter = entry['review-after'] || entry.reviewAfter;
    if (!reviewAfter) return null;
    const reviewDate = reviewAfter instanceof Date ? reviewAfter : new Date(reviewAfter);
    if (Number.isNaN(reviewDate.getTime())) return null;
    const daysUntilReview = Math.floor((reviewDate.getTime() - now.getTime()) / MS_PER_DAY);
    return {
        id: entry.id,
        dependency: entry.dependency || '',
        repositories: Array.isArray(entry.repositories) ? entry.repositories : [],
        reviewAfter: reviewDate instanceof Date ? reviewDate.toISOString() : String(reviewAfter),
        daysUntilReview,
        overdue: daysUntilReview < 0,
        reviewWindow: SLA_RULES.exception.days,
    };
}

/**
 * Compute the full health audit from an inventory + registry.
 *
 * @param {Array<object>} inventory Sorted PR inventory (from export-pr-inventory).
 * @param {Array<object>} registryEntries Central registry entries.
 * @param {Date} [now]
 * @returns {{prs: Array, exceptions: Array, summary: object}}
 */
function computeHealth(inventory, registryEntries, now = new Date()) {
    const prs = (Array.isArray(inventory) ? inventory : []).map((pr) => assessSla(pr, now));

    const entries = Array.isArray(registryEntries) ? registryEntries : [];
    const exceptions = entries.map((e) => assessExceptionReview(e, now)).filter(Boolean);

    const summary = summarizeHealth({prs, exceptions});
    return {prs, exceptions, summary};
}

/**
 * Summarize a computed health audit.
 *
 * @param {{prs: Array, exceptions: Array}} health
 * @returns {object}
 */
function summarizeHealth({prs, exceptions}) {
    let breaching = 0;
    let securityBreaching = 0;
    let criticalBreaching = 0;
    let failing = 0;
    let securityTotal = 0;
    let criticalTotal = 0;
    const breachingByCategory = {};
    for (const pr of prs) {
        if (pr.security) securityTotal++;
        if (pr.risk === 'critical') criticalTotal++;
        if (pr.checkStatus === 'failing') failing++;
        if (pr.breach) {
            breaching++;
            if (pr.security) securityBreaching++;
            if (pr.risk === 'critical') criticalBreaching++;
            breachingByCategory[pr.slaCategory] = (breachingByCategory[pr.slaCategory] || 0) + 1;
        }
    }
    let expiringExceptions = 0;
    let overdueExceptions = 0;
    for (const ex of exceptions) {
        if (ex.overdue) overdueExceptions++;
        else if (ex.daysUntilReview <= 14) expiringExceptions++;
    }
    return {
        totalPrs: prs.length,
        breachingPrs: breaching,
        securityPrs: securityTotal,
        securityBreaching,
        criticalPrs: criticalTotal,
        criticalBreaching,
        failingPrs: failing,
        breachingByCategory,
        totalExceptions: exceptions.length,
        expiringExceptions,
        overdueExceptions,
    };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render the health audit as a markdown report.
 *
 * @param {{prs: Array, exceptions: Array, summary: object}} health
 * @returns {string}
 */
function renderHealthMarkdown(health) {
    const s = health.summary || summarizeHealth(health);
    const lines = [];

    lines.push('# Dependency Health Audit');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## SLA Summary');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total open Dependabot PRs | ${s.totalPrs} |`);
    lines.push(`| PRs breaching SLA | ${s.breachingPrs} |`);
    lines.push(`| Security PRs (total) | ${s.securityPrs} |`);
    lines.push(`| Security PRs breaching SLA | ${s.securityBreaching} |`);
    lines.push(`| Critical-risk PRs (total) | ${s.criticalPrs} |`);
    lines.push(`| Critical-risk PRs breaching SLA | ${s.criticalBreaching} |`);
    lines.push(`| PRs with failing checks | ${s.failingPrs} |`);
    lines.push(`| Registry exceptions (total) | ${s.totalExceptions} |`);
    lines.push(`| Expiring exceptions (<=14d) | ${s.expiringExceptions} |`);
    lines.push(`| Overdue exceptions | ${s.overdueExceptions} |`);
    lines.push('');

    if (Object.keys(s.breachingByCategory).length > 0) {
        lines.push('### Breaches by SLA category');
        lines.push('');
        lines.push('| SLA category | Breaching |');
        lines.push('|--------------|-----------|');
        for (const [cat, count] of Object.entries(s.breachingByCategory).sort(
            (a, b) => b[1] - a[1],
        )) {
            const label = (SLA_RULES[cat] && SLA_RULES[cat].label) || cat;
            lines.push(`| ${label} | ${count} |`);
        }
        lines.push('');
    }

    lines.push('## SLA Rules');
    lines.push('');
    lines.push('| Category | Deadline | Counting |');
    lines.push('|----------|----------|----------|');
    for (const [key, rule] of Object.entries(SLA_RULES)) {
        const counting = rule.businessDays ? 'business days' : 'calendar days';
        lines.push(`| ${rule.label} | ${rule.days} ${counting} | ${counting} |`);
    }
    lines.push('');

    const breaching = health.prs.filter((p) => p.breach);
    if (breaching.length > 0) {
        lines.push('## SLA Breaches (PRs past their deadline)');
        lines.push('');
        lines.push(
            '| Repo | # | Age (d) | SLA | Overdue (d) | Security | Risk | Dependency | From | To | Checks | Title |',
        );
        lines.push(
            '|------|---|---------|-----|------------|----------|------|------------|------|-----|--------|-------|',
        );
        for (const pr of breaching.sort((a, b) => b.daysOverdue - a.daysOverdue)) {
            const sec = pr.security ? 'yes' : '';
            const title = pr.title.replace(/\|/g, '\\|');
            lines.push(
                `| ${pr.repo} | ${pr.number} | ${pr.ageDays} | ${pr.slaLabel} | ${pr.daysOverdue} | ${sec} | ${pr.risk} | ${pr.dependency || '—'} | ${pr.fromVersion || '—'} | ${pr.toVersion || '—'} | ${pr.checkStatus} | ${title} |`,
            );
        }
        lines.push('');
    }

    if (health.exceptions.length > 0) {
        lines.push('## Exception Review Status');
        lines.push('');
        lines.push('| ID | Dependency | Repos | Review after | Days left | Status |');
        lines.push('|----|------------|-------|--------------|-----------|--------|');
        for (const ex of health.exceptions.sort((a, b) => a.daysUntilReview - b.daysUntilReview)) {
            const status = ex.overdue ? 'OVERDUE' : ex.daysUntilReview <= 14 ? 'expiring' : 'ok';
            const repos = (ex.repositories || []).join(', ') || 'all';
            lines.push(
                `| ${ex.id} | ${ex.dependency} | ${repos} | ${ex.reviewAfter} | ${ex.daysUntilReview} | ${status} |`,
            );
        }
        lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by `@diplodoc/infra` Dependency Health audit._');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration (reuses export-pr-inventory network layer)
// ---------------------------------------------------------------------------

/**
 * Run the full dependency health audit across a set of repositories.
 *
 * @param {object} params
 * @param {string} params.token GitHub App installation token (or PAT).
 * @param {string} params.owner GitHub org owner.
 * @param {string[]} params.repos Repository short names (28 for full audit).
 * @param {Array<object>} [params.registryEntries] Central registry entries.
 * @param {boolean} [params.skipChecks] Skip per-PR check-status lookup.
 * @param {Date} [params.now] Reference time (default: now).
 * @returns {Promise<{health: object, errors: Array}>}
 */
async function runHealthAudit({
    token,
    owner,
    repos,
    registryEntries = [],
    skipChecks = false,
    now,
}) {
    const referenceTime = now || new Date();
    const result = await exportInventory({token, owner, repos, registryEntries, skipChecks});
    const health = computeHealth(result.inventory, registryEntries, referenceTime);
    return {health, errors: result.errors || []};
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

    console.error(`[@diplodoc/infra] Auditing dependency health for ${repos.length} repo(s)...`);

    let result;
    try {
        result = await runHealthAudit({token, owner, repos, registryEntries, skipChecks});
    } catch (error) {
        console.error(`[@diplodoc/infra] Fatal: ${error.message}`);
        process.exit(1);
    }

    const {health, errors} = result;
    const json = JSON.stringify(health, null, 2);
    if (outputFile) {
        writeOutput(outputFile, json);
        console.error(`[@diplodoc/infra] Health report written to ${outputFile}`);
    } else {
        console.log(json);
    }

    if (markdownFile) {
        const md = renderHealthMarkdown(health);
        writeOutput(markdownFile, md);
        console.error(`[@diplodoc/infra] Markdown report written to ${markdownFile}`);
    }

    const s = health.summary;
    console.error(
        `[@diplodoc/infra] ${s.totalPrs} PRs across ${repos.length} repos` +
            ` (${s.securityPrs} security, ${s.breachingPrs} breaching SLA,` +
            ` ${s.failingPrs} failing checks, ${s.overdueExceptions} overdue exceptions)`,
    );
    if (errors.length > 0) {
        console.error(`[@diplodoc/infra] ${errors.length} error(s):`);
        for (const e of errors) {
            console.error(`  ${e.repo}: ${e.phase} — ${e.message}`);
        }
    }

    if (s.breachingPrs > 0 || s.overdueExceptions > 0) {
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
    SLA_RULES,
    DEFAULT_SLA_CATEGORY,
    isWeekend,
    addCalendarDays,
    addBusinessDays,
    slaDeadline,
    selectSlaCategory,
    assessSla,
    assessExceptionReview,
    computeHealth,
    summarizeHealth,
    renderHealthMarkdown,
    runHealthAudit,
};
