#!/usr/bin/env node

/**
 * dependency-policy-review.js
 *
 * Mandatory Dependency Policy check for any changes to package.json or
 * lockfile.  The check:
 *   1. Gets the list of direct (package.json) and transitive (lockfile)
 *      dependency changes.
 *   2. Finds each changed dependency in the central policy registry.
 *   3. Calculates the maximum PR risk.
 *   4. Selects a verification profile.
 *   5. Renders a structured risk-assessment comment and (when running in
 *      CI with GH_TOKEN available) posts it on the PR.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/dependency-policy-review.js [flags]
 *   - As a module: require('./dependency-policy-review') -> pure helpers for tests.
 *
 * Flags:
 *   --before-pkg <path>   Path to the base (target branch) package.json
 *   --after-pkg  <path>   Path to the head (PR branch) package.json
 *   --before-lock <path>  Path to the base package-lock.json (optional)
 *   --after-lock  <path>  Path to the head package-lock.json (optional)
 *   --registry <path>     Path to central dependency-policy.yml
 *   --repo <name>         Repository short name (scopes registry entries)
 *   --pr <number>          Pull request number (for posting comment)
 *   --comment <path>       Write the markdown comment to a file instead of stdout
 *   --post                 Post the comment via `gh pr comment`
 *   --quiet                Suppress informational stdout
 *
 * Environment variables:
 *   GH_TOKEN              GitHub token for `gh pr comment`
 *   GITHUB_REPOSITORY     owner/repo (for gh CLI)
 *   INFRA_REPO_NAME       Repository short name (fallback for --repo)
 */

const {readFileSync, writeFileSync, existsSync} = require('node:fs');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const yaml = require('js-yaml');

const {
    resolveRegistryPath,
    repoNameFromPackage,
    filterEntriesForRepo,
} = require('./generate-dependency-policy');

const {classifyDependency, elevateRisk, RISK_DESCRIPTIONS} = require('./risk-classification');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPENDENCY_SECTIONS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
];

/**
 * Risk levels ordered from lowest to highest.  Used by `calculateMaxRisk`.
 */
const RISK_ORDER = {low: 0, medium: 1, high: 2, critical: 3};

/**
 * Default verification profile per risk level.  Registry entries can
 * override this; entries without a profile fall back to this mapping.
 */
const DEFAULT_PROFILE_BY_RISK = {
    low: 'standard',
    medium: 'toolchain',
    high: 'document-transform',
    critical: 'ecosystem',
};

/**
 * Default risk for a dependency change that has no registry entry.
 * Determined by the type of version change.
 */
const DEFAULT_RISK_BY_CHANGE = {
    added: 'medium',
    removed: 'low',
    patch: 'low',
    minor: 'medium',
    major: 'high',
    unknown: 'medium',
};

/**
 * Auto-merge permission per risk level, derived from the PLAN.md / E6
 * risk-classification table.  Surfaced in the structured PR comment.
 */
const AUTO_MERGE_PERMISSION = {
    low: 'permitted',
    medium: 'conditional — human review or delayed auto-merge',
    high: 'prohibited — human review required',
    critical: 'prohibited — assigned owner security review required',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no process state)
// ---------------------------------------------------------------------------

/**
 * Compare two parsed package.json objects and return the list of direct
 * dependency changes across all dependency sections.
 *
 * Each change is `{ name, section, from, to, changeType }` where
 * `changeType` is `added`, `removed`, or `changed`.
 *
 * @param {object} before Parsed base package.json.
 * @param {object} after  Parsed head package.json.
 * @returns {Array<{name:string,section:string,from:string|null,to:string|null,changeType:string}>}
 */
function diffDirectDependencies(before, after) {
    const changes = [];
    const beforePkg = before || {};
    const afterPkg = after || {};

    for (const section of DEPENDENCY_SECTIONS) {
        const beforeDeps = beforePkg[section] || {};
        const afterDeps = afterPkg[section] || {};
        const allNames = new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)]);

        for (const name of allNames) {
            const from = beforeDeps[name] || null;
            const to = afterDeps[name] || null;

            if (from === null && to !== null) {
                changes.push({name, section, from: null, to, changeType: 'added'});
            } else if (from !== null && to === null) {
                changes.push({name, section, from, to: null, changeType: 'removed'});
            } else if (from !== to) {
                changes.push({name, section, from, to, changeType: 'changed'});
            }
        }
    }

    return changes;
}

/**
 * Determine the semantic update type (patch / minor / major) from a
 * version change.  Returns `unknown` when versions cannot be compared.
 *
 * @param {string|null} from Old version specifier.
 * @param {string|null} to  New version specifier.
 * @returns {'patch'|'minor'|'major'|'unknown'}
 */
function classifyVersionChange(from, to) {
    const fromVer = extractSemver(from);
    const toVer = extractSemver(to);
    if (!fromVer || !toVer) {
        return 'unknown';
    }
    if (toVer.major !== fromVer.major) {
        return 'major';
    }
    if (toVer.minor !== fromVer.minor) {
        return 'minor';
    }
    return 'patch';
}

/**
 * Extract major/minor/patch numbers from a version specifier string.
 * Strips leading range operators (`^`, `~`, `>=`, etc.) and pre-release
 * suffixes.
 *
 * @param {string|null} version
 * @returns {{major:number,minor:number,patch:number}|null}
 */
function extractSemver(version) {
    if (typeof version !== 'string' || version.length === 0) {
        return null;
    }
    const cleaned = version
        .replace(/^[^0-9]*/, '')
        .split('-')[0]
        .split('+')[0];
    const parts = cleaned.split('.');
    const major = parseInt(parts[0], 10);
    const minor = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0;
    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
        return null;
    }
    return {major, minor, patch};
}

/**
 * Compare two parsed package-lock.json objects and return the list of
 * transitive dependency changes (i.e. packages that changed but are not
 * direct dependencies listed in package.json).
 *
 * Uses the `packages` field (npm 7+ lockfile v3).  Falls back to the
 * legacy `dependencies` field for older lockfiles.
 *
 * @param {object} beforeLock Parsed base lockfile.
 * @param {object} afterLock  Parsed head lockfile.
 * @param {Array<string>} directNames Set of direct dependency names (to exclude).
 * @returns {Array<{name:string,from:string|null,to:string|null,changeType:string}>}
 */
function diffTransitiveDependencies(beforeLock, afterLock, directNames) {
    const beforePackages = extractLockPackages(beforeLock);
    const afterPackages = extractLockPackages(afterLock);
    const exclude = new Set(directNames);
    exclude.add(''); // root package

    const changes = [];
    const allKeys = new Set([...Object.keys(beforePackages), ...Object.keys(afterPackages)]);

    for (const key of allKeys) {
        if (exclude.has(key)) {
            continue;
        }
        const name = lockKeyToName(key);
        if (exclude.has(name)) {
            continue;
        }
        const from = beforePackages[key] || null;
        const to = afterPackages[key] || null;

        if (from === null && to !== null) {
            changes.push({name, from: null, to, changeType: 'added'});
        } else if (from !== null && to === null) {
            changes.push({name, from, to: null, changeType: 'removed'});
        } else if (from !== to) {
            changes.push({name, from, to, changeType: 'changed'});
        }
    }

    return changes;
}

/**
 * Extract the package map from a parsed lockfile.
 * Returns `{ [packageName]: version }` from either `packages` (v3) or
 * `dependencies` (v1/v2) sections.
 *
 * @param {object} lock Parsed lockfile.
 * @returns {object} Map of package key -> version string.
 */
function extractLockPackages(lock) {
    const result = {};
    if (!lock || typeof lock !== 'object') {
        return result;
    }

    if (lock.packages && typeof lock.packages === 'object') {
        for (const [key, meta] of Object.entries(lock.packages)) {
            if (key === '' || key === 'node_modules') {
                continue;
            }
            const version = (meta && meta.version) || '';
            result[key] = version;
        }
        return result;
    }

    if (lock.dependencies && typeof lock.dependencies === 'object') {
        for (const [name, meta] of Object.entries(lock.dependencies)) {
            const version = (meta && meta.version) || '';
            result[name] = version;
        }
    }

    return result;
}

/**
 * Convert a lockfile package key (e.g. `node_modules/foo` or
 * `node_modules/@scope/bar`) to the bare package name.
 *
 * @param {string} key Lockfile package key.
 * @returns {string} Package name.
 */
function lockKeyToName(key) {
    return key.replace(/^.*node_modules\//, '');
}

/**
 * Look up a dependency change in the scoped registry entries and return
 * the matching entry (or `undefined`).
 *
 * Matches by dependency name.  When the registry entry has an
 * `ignored-versions` list, a change *to* one of those versions is
 * flagged as `ignored`.
 *
 * @param {Array<object>} entries Scoped registry entries.
 * @param {{name:string,to:string|null}} change Dependency change.
 * @returns {object|undefined}
 */
function lookupInRegistry(entries, change) {
    if (!Array.isArray(entries)) {
        return undefined;
    }
    return entries.find((entry) => entry && entry.dependency === change.name);
}

/**
 * Determine the risk level for a single dependency change.
 *
 * Priority (highest wins):
 *   1. Registry entry with an explicit `risk` field.
 *   2. Dependency-name classification (see `risk-classification.js`).
 *      For `changed` deps a major bump elevates the classified risk by
 *      one level (medium→high, high→critical).  Low-risk categories
 *      (types/lint) are never elevated — a major bump of `@types/*` is
 *      still low.
 *   3. Change-type default (`DEFAULT_RISK_BY_CHANGE`).
 *
 * @param {object|undefined} entry Registry entry (or undefined).
 * @param {{changeType:string,from:string|null,to:string|null,name?:string,section?:string}} change
 * @returns {string} Risk level (low | medium | high | critical).
 */
function riskForChange(entry, change) {
    if (entry && entry.risk && RISK_ORDER[entry.risk] !== undefined) {
        return entry.risk;
    }

    const classified = classifyDependency(change.name, change.section);
    if (classified !== null) {
        if (change.changeType === 'changed' && classified !== 'low') {
            const updateType = classifyVersionChange(change.from, change.to);
            if (updateType === 'major') {
                return elevateRisk(classified);
            }
        }
        if (change.changeType === 'removed') {
            return DEFAULT_RISK_BY_CHANGE.removed;
        }
        return classified;
    }

    if (change.changeType === 'changed') {
        const updateType = classifyVersionChange(change.from, change.to);
        return DEFAULT_RISK_BY_CHANGE[updateType] || 'medium';
    }
    return DEFAULT_RISK_BY_CHANGE[change.changeType] || 'medium';
}

/**
 * Calculate the maximum risk across all assessed dependency changes.
 *
 * @param {Array<{risk:string}>} assessed List of assessed changes with `risk`.
 * @returns {string} Maximum risk level, or `low` when empty.
 */
function calculateMaxRisk(assessed) {
    if (!Array.isArray(assessed) || assessed.length === 0) {
        return 'low';
    }
    let max = 0;
    let maxRisk = 'low';
    for (const item of assessed) {
        const level = RISK_ORDER[item.risk];
        if (level !== undefined && level > max) {
            max = level;
            maxRisk = item.risk;
        }
    }
    return maxRisk;
}

/**
 * Select the verification profile for the assessment.
 *
 * Uses the verification-profile from the highest-risk registry entry
 * that has one.  Falls back to the default profile for the calculated
 * max risk.
 *
 * @param {Array<{entry:object|undefined,risk:string}>} assessed
 * @param {string} maxRisk
 * @returns {string} Verification profile name.
 */
function selectVerificationProfile(assessed, maxRisk) {
    const maxLevel = RISK_ORDER[maxRisk] || 0;
    for (const item of assessed) {
        const itemLevel = RISK_ORDER[item.risk] || 0;
        if (itemLevel === maxLevel && item.entry && item.entry['verification-profile']) {
            return item.entry['verification-profile'];
        }
    }
    return DEFAULT_PROFILE_BY_RISK[maxRisk] || 'standard';
}

/**
 * Build the full assessment object from direct + transitive changes and
 * the scoped registry.
 *
 * @param {Array<object>} directChanges  Direct dependency changes.
 * @param {Array<object>} transitiveChanges Transitive dependency changes.
 * @param {Array<object>} scopedEntries  Registry entries scoped to the repo.
 * @returns {object} Assessment object.
 */
function buildAssessment(directChanges, transitiveChanges, scopedEntries) {
    const assessedDirect = directChanges.map((change) => {
        const entry = lookupInRegistry(scopedEntries, change);
        const risk = riskForChange(entry, change);
        const inRegistry = Boolean(entry);
        const ignored = isIgnoredVersion(entry, change.to);
        const classification = classifyDependency(change.name, change.section);
        return {change, entry, risk, inRegistry, ignored, classification, type: 'direct'};
    });

    const assessedTransitive = transitiveChanges.map((change) => {
        const entry = lookupInRegistry(scopedEntries, change);
        const risk = riskForChange(entry, change);
        const inRegistry = Boolean(entry);
        const ignored = isIgnoredVersion(entry, change.to);
        const classification = classifyDependency(change.name, change.section);
        return {change, entry, risk, inRegistry, ignored, classification, type: 'transitive'};
    });

    const allAssessed = [...assessedDirect, ...assessedTransitive];
    const maxRisk = calculateMaxRisk(allAssessed);
    const profile = selectVerificationProfile(allAssessed, maxRisk);

    const exceptions = collectExceptions(allAssessed);
    const autoMergePermission = AUTO_MERGE_PERMISSION[maxRisk] || AUTO_MERGE_PERMISSION.medium;

    return {
        maxRisk,
        verificationProfile: profile,
        autoMergePermission,
        direct: assessedDirect,
        transitive: assessedTransitive,
        exceptions,
        summary: {
            total: allAssessed.length,
            direct: assessedDirect.length,
            transitive: assessedTransitive.length,
            inRegistry: allAssessed.filter((a) => a.inRegistry).length,
            ignored: allAssessed.filter((a) => a.ignored).length,
            exceptions: exceptions.length,
        },
    };
}

/**
 * Collect known policy exceptions from the assessed changes.  An
 * exception is a registry entry with an `id` (DEP-NNNN) that matches a
 * changed dependency.  Each exception includes the policy id,
 * dependency name, reason, category, affected output (derived from
 * `category` or `reason`), verification profile, owner, and evidence.
 *
 * @param {Array<object>} allAssessed Assessed direct + transitive changes.
 * @returns {Array<object>} Exceptions list.
 */
function collectExceptions(allAssessed) {
    if (!Array.isArray(allAssessed)) {
        return [];
    }
    const seen = new Set();
    const exceptions = [];
    for (const item of allAssessed) {
        if (!item.inRegistry || !item.entry || !item.entry.id) {
            continue;
        }
        if (seen.has(item.entry.id)) {
            continue;
        }
        seen.add(item.entry.id);
        const entry = item.entry;
        exceptions.push({
            id: entry.id,
            dependency: entry.dependency || item.change.name,
            reason: entry.reason || '—',
            category: entry.category || '—',
            affectedOutput: deriveAffectedOutput(entry),
            verificationProfile: entry['verification-profile'] || '—',
            owner: entry.owner || '—',
            evidence: entry.evidence || {},
            ignored: item.ignored,
        });
    }
    return exceptions;
}

/**
 * Derive a human-readable description of what output is affected by a
 * policy entry.  Uses the `category` field if available, otherwise
 * falls back to the `reason`.
 *
 * @param {object} entry Registry entry.
 * @returns {string} Affected output description.
 */
function deriveAffectedOutput(entry) {
    if (!entry) {
        return '—';
    }
    const category = entry.category;
    if (category && category !== '—') {
        const categoryMap = {
            'output-regression': 'rendered output (visual / structural regression)',
            security: 'security-sensitive runtime behavior',
            build: 'build pipeline / bundle output',
            test: 'test execution / coverage',
        };
        if (categoryMap[category]) {
            return categoryMap[category];
        }
        return category;
    }
    if (entry.reason && entry.reason !== '—') {
        return entry.reason;
    }
    return '—';
}

/**
 * Check whether the `to` version of a change is in the entry's
 * `ignored-versions` list.
 *
 * @param {object|undefined} entry Registry entry.
 * @param {string|null} version Target version.
 * @returns {boolean}
 */
function isIgnoredVersion(entry, version) {
    if (!entry || !Array.isArray(entry['ignored-versions']) || !version) {
        return false;
    }
    return entry['ignored-versions'].some((v) => String(v).trim() === String(version).trim());
}

// ---------------------------------------------------------------------------
// Compatibility score (Dependabot signal)
// ---------------------------------------------------------------------------

const GITHUB_API_ROOT = 'https://api.github.com';

/**
 * Extract the Dependabot compatibility score (0-100) from a GitHub
 * check-runs API response.  Dependabot posts a check run whose name
 * contains "Dependabot"; the score percentage appears in the check
 * run's output title or summary.
 *
 * @param {object|undefined} checkRunsResponse Parsed `GET /commits/{sha}/check-runs` response.
 * @returns {number|null} Compatibility score (0-100) or null when not found.
 */
function extractCompatibilityScore(checkRunsResponse) {
    if (!checkRunsResponse || !Array.isArray(checkRunsResponse.check_runs)) {
        return null;
    }
    for (const run of checkRunsResponse.check_runs) {
        if (!run || !run.name || !/dependabot/i.test(run.name)) {
            continue;
        }
        const output = run.output || {};
        const text = `${output.title || ''} ${output.summary || ''}`;
        const match = text.match(/(\d+)\s*%/);
        if (match) {
            return parseInt(match[1], 10);
        }
    }
    return null;
}

/**
 * Fetch the Dependabot compatibility score from the GitHub REST API.
 * Returns `null` when the API call fails or no Dependabot check run is
 * found.  Requires `GITHUB_REPOSITORY` (owner/repo) and a token in the
 * environment.
 *
 * @param {string} headSha PR head commit SHA.
 * @param {object} env Environment (defaults to `process.env`).
 * @returns {Promise<number|null>}
 */
async function fetchCompatibilityScore(headSha, env) {
    const e = env || process.env;
    const repo = e.GITHUB_REPOSITORY;
    const token = e.GH_TOKEN || e.GITHUB_TOKEN;
    if (!repo || !token || !headSha) {
        return null;
    }
    try {
        const res = await fetch(
            `${GITHUB_API_ROOT}/repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'diplodoc-infra-policy-review',
                },
            },
        );
        if (!res.ok) {
            return null;
        }
        const data = await res.json();
        return extractCompatibilityScore(data);
    } catch {
        return null;
    }
}

/**
 * Render the assessment as a markdown comment.
 *
 * @param {object} assessment Assessment from `buildAssessment`.
 * @param {object} [options] Optional rendering options.
 * @param {number|null} [options.compatibilityScore] Dependabot compatibility score (0-100).
 * @returns {string} Markdown comment body.
 */
function renderComment(assessment, options) {
    const opts = options || {};
    const compatibilityScore = opts.compatibilityScore;
    const lines = [];
    const riskEmoji = {low: '🟢', medium: '🟡', high: '🟠', critical: '🔴'};
    const emoji = riskEmoji[assessment.maxRisk] || '⚪';

    lines.push('## Dependency Policy Risk Assessment');
    lines.push('');
    lines.push(`**Max Risk:** ${emoji} ${assessment.maxRisk}`);
    lines.push(`**Verification Profile:** \`${assessment.verificationProfile}\``);

    const autoMerge =
        assessment.autoMergePermission || AUTO_MERGE_PERMISSION[assessment.maxRisk] || '—';
    lines.push(`**Auto-merge:** ${autoMerge}`);

    if (compatibilityScore !== undefined && compatibilityScore !== null) {
        const scoreEmoji = compatibilityScore >= 90 ? '🟢' : compatibilityScore >= 50 ? '🟡' : '🔴';
        lines.push(
            `**Compatibility Score:** ${scoreEmoji} ${compatibilityScore}% _(signal only — not a merge basis)_`,
        );
    }
    lines.push('');

    lines.push('### Risk Levels');
    lines.push('');
    lines.push('| Risk | Examples | Checks | Merge |');
    lines.push('|------|----------|--------|-------|');
    for (const level of ['low', 'medium', 'high', 'critical']) {
        const desc = RISK_DESCRIPTIONS[level];
        const marker = level === assessment.maxRisk ? '**' : '';
        lines.push(
            `| ${marker}${level}${marker} | ${desc.examples} | ${desc.checks} | ${desc.merge} |`,
        );
    }
    lines.push('');
    lines.push('### Summary');
    lines.push('');
    lines.push(`| Metric | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Direct changes | ${assessment.summary.direct} |`);
    lines.push(`| Transitive changes | ${assessment.summary.transitive} |`);
    lines.push(`| In registry | ${assessment.summary.inRegistry} |`);
    lines.push(`| Ignored versions | ${assessment.summary.ignored} |`);
    if (assessment.summary.exceptions !== undefined) {
        lines.push(`| Known exceptions | ${assessment.summary.exceptions} |`);
    }
    lines.push('');

    if (assessment.direct.length > 0) {
        lines.push('### Direct Changes');
        lines.push('');
        lines.push('| Dependency | Section | From | To | Risk | Class | Registry |');
        lines.push('|------------|---------|------|-----|------|-------|----------|');
        for (const item of assessment.direct) {
            const c = item.change;
            const reg = item.inRegistry ? item.entry.id || 'yes' : '—';
            const ignoredTag = item.ignored ? ' (ignored)' : '';
            const cls = item.classification || '—';
            lines.push(
                `| ${c.name} | ${c.section} | ${c.from || '—'} | ${c.to || '—'} | ${item.risk}${ignoredTag} | ${cls} | ${reg} |`,
            );
        }
        lines.push('');
    }

    if (assessment.transitive.length > 0) {
        lines.push('### Transitive Changes');
        lines.push('');
        lines.push('| Dependency | From | To | Risk | Class | Registry |');
        lines.push('|------------|------|-----|------|-------|----------|');
        for (const item of assessment.transitive) {
            const c = item.change;
            const reg = item.inRegistry ? item.entry.id || 'yes' : '—';
            const ignoredTag = item.ignored ? ' (ignored)' : '';
            const cls = item.classification || '—';
            lines.push(
                `| ${c.name} | ${c.from || '—'} | ${c.to || '—'} | ${item.risk}${ignoredTag} | ${cls} | ${reg} |`,
            );
        }
        lines.push('');
    }

    const exceptions = assessment.exceptions || [];
    if (exceptions.length > 0) {
        lines.push('### Known Exceptions');
        lines.push('');
        for (const ex of exceptions) {
            lines.push(`#### ${ex.id} — \`${ex.dependency}\``);
            lines.push('');
            lines.push(`- **Reason:** ${ex.reason}`);
            lines.push(`- **Affected output:** ${ex.affectedOutput}`);
            lines.push(`- **Required verification:** \`${ex.verificationProfile}\``);
            lines.push(`- **Owner:** ${ex.owner}`);
            if (ex.evidence && typeof ex.evidence === 'object') {
                const evidenceLinks = Object.entries(ex.evidence)
                    .map(([key, value]) => `[${key}](${value})`)
                    .join(', ');
                if (evidenceLinks) {
                    lines.push(`- **Evidence:** ${evidenceLinks}`);
                }
            }
            if (ex.ignored) {
                lines.push(`- **Note:** PR targets an ignored version`);
            }
            lines.push('');
        }
    }

    if (assessment.summary.total === 0) {
        lines.push('No dependency changes detected.');
        lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by `@diplodoc/infra` Dependency Policy Review._');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
        }
    }

    const beforePkgPath = flags['before-pkg'];
    const afterPkgPath = flags['after-pkg'];
    const beforeLockPath = flags['before-lock'];
    const afterLockPath = flags['after-lock'];
    const registryPath = resolveRegistryPath(flags.registry);
    let repoName = flags.repo || process.env.INFRA_REPO_NAME || '';
    const quiet = flags.quiet === true;
    const doPost = flags.post === true;
    const commentFile = flags.comment;
    const prNumber = flags.pr;
    const headSha = flags['head-sha'];
    let compatibilityScore =
        flags['compatibility-score'] !== undefined && flags['compatibility-score'] !== true
            ? parseInt(flags['compatibility-score'], 10)
            : undefined;

    if (!beforePkgPath || !afterPkgPath) {
        console.error(
            'Usage: dependency-policy-review.js --before-pkg <path> --after-pkg <path> ' +
                '[--before-lock <path>] [--after-lock <path>] [--registry <path>] [--repo <name>] ' +
                '[--pr <number>] [--head-sha <sha>] [--compatibility-score <0-100>] ' +
                '[--comment <path>] [--post]',
        );
        process.exit(1);
    }

    if (!existsSync(beforePkgPath) || !existsSync(afterPkgPath)) {
        console.error('[@diplodoc/infra] package.json files not found');
        process.exit(1);
    }

    async function main() {
        const beforePkg = JSON.parse(readFileSync(beforePkgPath, 'utf8'));
        const afterPkg = JSON.parse(readFileSync(afterPkgPath, 'utf8'));

        let beforeLock = null;
        let afterLock = null;
        if (beforeLockPath && existsSync(beforeLockPath)) {
            beforeLock = JSON.parse(readFileSync(beforeLockPath, 'utf8'));
        }
        if (afterLockPath && existsSync(afterLockPath)) {
            afterLock = JSON.parse(readFileSync(afterLockPath, 'utf8'));
        }

        const registry = yaml.load(readFileSync(registryPath, 'utf8')) || {};

        if (!repoName) {
            repoName = repoNameFromPackage(afterPkg.name || '');
        }

        const allEntries = registry && Array.isArray(registry.entries) ? registry.entries : [];
        const scopedEntries = repoName ? filterEntriesForRepo(allEntries, repoName) : allEntries;

        const directChanges = diffDirectDependencies(beforePkg, afterPkg);
        const directNames = new Set(directChanges.map((c) => c.name));
        const transitiveChanges =
            beforeLock && afterLock
                ? diffTransitiveDependencies(beforeLock, afterLock, [...directNames])
                : [];

        const assessment = buildAssessment(directChanges, transitiveChanges, scopedEntries);

        if (compatibilityScore === undefined && headSha) {
            compatibilityScore = await fetchCompatibilityScore(headSha, process.env);
            if (compatibilityScore !== null && !quiet) {
                console.error(
                    `[@diplodoc/infra] Fetched compatibility score: ${compatibilityScore}%`,
                );
            }
        }

        const commentOpts = {};
        if (
            compatibilityScore !== undefined &&
            compatibilityScore !== null &&
            !Number.isNaN(compatibilityScore)
        ) {
            commentOpts.compatibilityScore = compatibilityScore;
        }

        const comment = renderComment(assessment, commentOpts);

        if (commentFile) {
            writeFileSync(commentFile, comment, 'utf8');
            if (!quiet) {
                console.log(`[@diplodoc/infra] Comment written to ${commentFile}`);
            }
        } else {
            console.log(comment);
        }

        if (!quiet) {
            console.error(
                `[@diplodoc/infra] Risk assessment: ${assessment.maxRisk}, ` +
                    `profile=${assessment.verificationProfile}, ` +
                    `${assessment.summary.direct} direct, ${assessment.summary.transitive} transitive.`,
            );
        }

        if (doPost && prNumber) {
            try {
                execSync(`gh pr comment ${prNumber} --body-file -`, {
                    input: comment,
                    stdio: ['pipe', 'inherit', 'inherit'],
                    env: process.env,
                });
                if (!quiet) {
                    console.log(`[@diplodoc/infra] Comment posted on PR #${prNumber}`);
                }
            } catch (error) {
                console.error(`[@diplodoc/infra] Failed to post comment: ${error.message}`);
                process.exit(1);
            }
        }
    }

    main().catch((error) => {
        console.error(`[@diplodoc/infra] Error: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    DEPENDENCY_SECTIONS,
    RISK_ORDER,
    DEFAULT_PROFILE_BY_RISK,
    DEFAULT_RISK_BY_CHANGE,
    AUTO_MERGE_PERMISSION,
    GITHUB_API_ROOT,
    diffDirectDependencies,
    classifyVersionChange,
    extractSemver,
    diffTransitiveDependencies,
    extractLockPackages,
    lockKeyToName,
    lookupInRegistry,
    riskForChange,
    calculateMaxRisk,
    selectVerificationProfile,
    isIgnoredVersion,
    buildAssessment,
    collectExceptions,
    deriveAffectedOutput,
    renderComment,
    extractCompatibilityScore,
    fetchCompatibilityScore,
    classifyDependency,
    elevateRisk,
    RISK_DESCRIPTIONS,
};
