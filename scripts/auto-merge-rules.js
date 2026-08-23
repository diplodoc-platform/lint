#!/usr/bin/env node

/**
 * auto-merge-rules.js
 *
 * Strict auto-merge rule engine for Diplodoc Dependabot PRs (T10.1).
 *
 * Auto-merge is only enabled when ALL of the following 9 conditions
 * are met (see PLAN.md section 7 / E10):
 *
 *   1. Patch update          — only `patch` semver bumps qualify.
 *   2. Risk: low              — the dependency's risk level must be `low`.
 *   3. devDependency          — the change lives in `devDependencies`.
 *   4. No exception           — no policy-registry entry covers the dep.
 *   5. No new transitive deps — no new runtime/transitive deps added.
 *   6. All checks green       — every required CI check is passing.
 *   7. No snapshot changes    — the PR does not modify test snapshots.
 *   8. Manifest + lockfile only — the PR touches only package.json /
 *                                 package-lock.json (no source/docs/config).
 *   9. 24h since green CI     — at least 24 hours elapsed since CI turned
 *                                 green, as a soak-time safety gate.
 *
 * Hard exclusions (always require a human, short-circuit before the 9
 * conditions are even evaluated):
 *
 *   - Production dependencies  (section !== 'devDependencies')
 *   - Minor / major updates    (updateType !== 'patch')
 *   - Grouped PRs               (Dependabot `groups` — multiple deps)
 *   - Security-sensitive PRs   (vulnerability / `security` label)
 *   - High-risk dependencies    (risk !== 'low')
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/auto-merge-rules.js [--list] [--input <path>] [--json]
 *   - As a module: require('./auto-merge-rules') -> pure helpers for tests.
 *
 * Flags:
 *   --list           Print the 9 conditions + exclusion list and exit.
 *   --input <path>   Evaluate a JSON file describing the PR.
 *   --json           Emit the evaluation result as JSON (default for --input).
 *   --quiet          Suppress informational stderr.
 */

// ---------------------------------------------------------------------------
// Constants — the 9 auto-merge conditions (documented + machine-checked)
// ---------------------------------------------------------------------------

/**
 * The 9 mandatory auto-merge conditions.  Each entry has a stable `id`
 * (used by tests and downstream tooling), a human-readable `name`, and
 * a `description` explaining what the condition checks and why.
 *
 * The order matches the task note / epic ordering.
 */
const AUTO_MERGE_CONDITIONS = [
    {
        id: 'patch-update',
        name: 'Patch update',
        description:
            'Only patch semver bumps qualify for auto-merge. Minor and major ' +
            'updates are hard exclusions (see EXCLUSION_LIST).',
    },
    {
        id: 'risk-low',
        name: 'Dependency has risk: low',
        description:
            'The dependency risk level (from the policy registry or the ' +
            'risk-classification layer) must be `low`. Medium / high / critical ' +
            'are hard exclusions.',
    },
    {
        id: 'dev-dependency',
        name: 'It is a devDependency',
        description:
            'The change must live in the `devDependencies` section of ' +
            'package.json. Production dependencies are a hard exclusion.',
    },
    {
        id: 'no-exception',
        name: 'No exception exists',
        description:
            'No policy-registry entry (DEP-NNNN) covers the changed dependency. ' +
            'A pinned/exceptioned dependency is excluded from auto-merge so the ' +
            'documented reason and verification profile are honored.',
    },
    {
        id: 'no-new-transitive',
        name: 'No new runtime/transitive dependencies',
        description:
            'The PR must not introduce new transitive dependencies. A new ' +
            'transitive dep means an unreviewed runtime surface area and is ' +
            'excluded from auto-merge.',
    },
    {
        id: 'checks-green',
        name: 'All required checks green',
        description:
            'Every required CI check (the `master CI gate` ruleset) must be ' +
            'passing. A pending, failing, or missing check blocks auto-merge.',
    },
    {
        id: 'no-snapshots',
        name: "PR doesn't change snapshots",
        description:
            'The PR must not modify test snapshot files (e.g. `*.snap`, ' +
            '`__snapshots__/`). Snapshot changes imply behavioural output drift ' +
            'that warrants a human review.',
    },
    {
        id: 'manifest-lockfile-only',
        name: 'PR contains only manifest and lockfile',
        description:
            'The PR may touch only dependency manifests: package.json and the ' +
            'lockfile (package-lock.json / npm-shrinkwrap.json). Source, docs, ' +
            'config, or workflow changes block auto-merge.',
    },
    {
        id: 'ci-24h-soak',
        name: '24 hours passed since successful CI',
        description:
            'At least 24 hours must have elapsed since CI last turned green. ' +
            'This soak-time gate gives downstream consumers and manual reviewers ' +
            'a window to object before an automated merge lands.',
    },
];

/**
 * Hard exclusions — categories of Dependabot PR that ALWAYS require a
 * human, regardless of the 9 conditions.  Evaluated before the conditions
 * so the evaluation result can surface the blocking category directly.
 *
 * Each entry has an `id`, `name`, `description`, and a `matches(input)`
 * predicate.  The predicate receives the same evaluation input as
 * `evaluateAutoMerge`.
 */
const EXCLUSION_LIST = [
    {
        id: 'production-dep',
        name: 'Production dependency',
        description:
            'Production dependencies (anything outside `devDependencies`) ' +
            'require a human review.',
        matches: (input) => isProductionSection(input.section),
    },
    {
        id: 'minor-update',
        name: 'Minor update',
        description: 'Minor semver bumps can add new API surface and require a human.',
        matches: (input) => input.updateType === 'minor',
    },
    {
        id: 'major-update',
        name: 'Major update',
        description: 'Major semver bumps can have breaking changes and require a human.',
        matches: (input) => input.updateType === 'major',
    },
    {
        id: 'grouped-pr',
        name: 'Grouped PR',
        description:
            'Dependabot grouped PRs bundle multiple dependencies and require a ' +
            'human review because the blast radius is wider.',
        matches: (input) => input.isGrouped === true,
    },
    {
        id: 'security-sensitive',
        name: 'Security-sensitive update',
        description:
            'Security / vulnerability Dependabot PRs require a human + security ' +
            'review and are never auto-merged.',
        matches: (input) => input.isSecurity === true,
    },
    {
        id: 'high-risk',
        name: 'High-risk dependency',
        description:
            'Dependencies whose risk level is not `low` (medium / high / ' +
            'critical) require a human review.',
        matches: (input) => typeof input.risk === 'string' && input.risk !== 'low',
    },
];

/**
 * Files that a qualifying PR is allowed to touch.  Anything outside this
 * set blocks the `manifest-lockfile-only` condition.
 */
const ALLOWED_MANIFEST_FILES = new Set([
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
]);

/**
 * Glob patterns for test snapshot files.  A PR that changes any path
 * matching these patterns fails the `no-snapshots` condition.
 *
 * Patterns are matched with `*` running across path separators (the same
 * convention as `risk-classification.js` glob matchers).
 */
const SNAPSHOT_PATTERNS = [
    '**/__snapshots__/**',
    '**/*.snap',
    '**/*.snap.cjs',
    '**/*.snap.js',
    '**/*.snap.mjs',
    '**/*.snap.ts',
];

/**
 * Soak-time window: minimum number of milliseconds that must elapse
 * between CI turning green and an auto-merge being permitted.
 */
const SOAK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Pure helpers (no process state)
// ---------------------------------------------------------------------------

/**
 * Whether a package.json section is a "production" section (i.e. NOT a
 * dev-only section).  `devDependencies` is the only dev-only section; all
 * others (dependencies, peerDependencies, optionalDependencies) are
 * considered production-relevant.
 *
 * @param {string|undefined} section
 * @returns {boolean}
 */
function isProductionSection(section) {
    return section !== 'devDependencies';
}

/**
 * Compile a glob pattern (with `**` and `*` segments) into a RegExp.
 * `**` matches any run of characters including `/`; a single `*` matches
 * any run of characters except `/`.  Other characters are escaped.
 *
 * Mirrors the glob semantics used in `risk-classification.js` but adds
 * support for `**` path-spanning segments.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function snapshotGlobToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withGlobstar = escaped.replace(/\*\*/g, '\u0000'); // placeholder
    const withStar = withGlobstar.replace(/\*/g, '[^/]*');
    const restored = withStar.replace(/\u0000/g, '.*');
    return new RegExp('^' + restored + '$');
}

/**
 * Test whether a changed file path matches any snapshot glob pattern.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isSnapshotFile(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return false;
    }
    for (const pattern of SNAPSHOT_PATTERNS) {
        if (snapshotGlobToRegExp(pattern).test(filePath)) {
            return true;
        }
    }
    return false;
}

/**
 * Check the `manifest-lockfile-only` condition: every changed file must
 * be one of the allowed manifest/lockfile paths.
 *
 * @param {Array<string>} changedFiles
 * @returns {boolean}
 */
function isManifestLockfileOnly(changedFiles) {
    if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
        return false;
    }
    return changedFiles.every((file) => ALLOWED_MANIFEST_FILES.has(file));
}

/**
 * Check whether any of the changed files is a snapshot file.
 *
 * @param {Array<string>} changedFiles
 * @returns {boolean}
 */
function changesSnapshots(changedFiles) {
    if (!Array.isArray(changedFiles)) {
        return false;
    }
    return changedFiles.some(isSnapshotFile);
}

/**
 * Compute the elapsed milliseconds between CI turning green and `now`.
 * Returns `null` when either timestamp is missing or invalid.
 *
 * Accepts `Date` instances, millisecond numbers, or ISO strings.
 *
 * @param {Date|number|string} ciCompletedAt
 * @param {Date|number|string} now
 * @returns {number|null}
 */
function elapsedMs(ciCompletedAt, now) {
    const ci = toMillis(ciCompletedAt);
    const cur = toMillis(now);
    if (ci === null || cur === null) {
        return null;
    }
    return cur - ci;
}

function toMillis(value) {
    if (value instanceof Date) {
        const n = value.getTime();
        return Number.isNaN(n) ? null : n;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.length > 0) {
        const n = Date.parse(value);
        return Number.isNaN(n) ? null : n;
    }
    return null;
}

/**
 * Evaluate the 24h soak condition.
 *
 * @param {{ciCompletedAt?: *, now?: *, changesSnapshots?: *, changedFiles?: *}} input
 * @returns {boolean}
 */
function meetsSoakWindow(input) {
    const ci = toMillis(input.ciCompletedAt);
    if (ci === null) {
        return false;
    }
    const cur = input.now !== undefined ? toMillis(input.now) : Date.now();
    if (cur === null) {
        return false;
    }
    return cur - ci >= SOAK_WINDOW_MS;
}

/**
 * Normalise the "new transitive dependencies" input into a count.
 * Accepts an array (length), a number, or a boolean.
 *
 * @param {*} value
 * @returns {number}
 */
function newTransitiveCount(value) {
    if (Array.isArray(value)) {
        return value.length;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    return 0;
}

/**
 * Evaluate a single auto-merge condition against the input.
 *
 * @param {string} id        Condition id (one of AUTO_MERGE_CONDITIONS).
 * @param {object} input     Evaluation input (see `evaluateAutoMerge`).
 * @returns {boolean}
 */
function checkCondition(id, input) {
    switch (id) {
        case 'patch-update':
            return input.updateType === 'patch';
        case 'risk-low':
            return input.risk === 'low';
        case 'dev-dependency':
            return input.section === 'devDependencies';
        case 'no-exception':
            return input.hasException !== true;
        case 'no-new-transitive':
            return newTransitiveCount(input.newTransitiveDependencies) === 0;
        case 'checks-green':
            return input.checksGreen === true;
        case 'no-snapshots':
            return !changesSnapshots(input.changedFiles) && input.changesSnapshots !== true;
        case 'manifest-lockfile-only':
            return isManifestLockfileOnly(input.changedFiles);
        case 'ci-24h-soak':
            return meetsSoakWindow(input);
        default:
            return false;
    }
}

/**
 * Evaluate the full auto-merge policy against a PR description.
 *
 * Input fields (all optional unless noted):
 *
 *   - `updateType`             'patch' | 'minor' | 'major' | 'unknown'
 *   - `risk`                   'low' | 'medium' | 'high' | 'critical'
 *   - `section`                package.json section
 *   - `hasException`           boolean — registry entry covers the dep
 *   - `newTransitiveDependencies` array | number | boolean
 *   - `checksGreen`            boolean — all required checks passing
 *   - `changesSnapshots`       boolean (explicit override; changedFiles is
 *                              otherwise scanned via SNAPSHOT_PATTERNS)
 *   - `changedFiles`           array of file paths changed by the PR
 *   - `ciCompletedAt`          Date | number(ms) | ISO string
 *   - `now`                    Date | number(ms) | ISO string (default: now)
 *   - `isGrouped`              boolean — Dependabot grouped PR
 *   - `isSecurity`             boolean — security/vulnerability PR
 *
 * @param {object} input PR description.
 * @returns {{allowed: boolean, excluded: boolean, exclusions: Array<object>, conditions: Array<object>, blockingReasons: Array<string>}}
 */
function evaluateAutoMerge(input) {
    const data = input || {};
    const now = data.now !== undefined ? data.now : Date.now();

    // 1. Hard exclusions (short-circuit).  Each matched exclusion is
    //    recorded; the first one is surfaced as the primary reason.
    const matchedExclusions = [];
    for (const ex of EXCLUSION_LIST) {
        try {
            if (ex.matches(data)) {
                matchedExclusions.push({
                    id: ex.id,
                    name: ex.name,
                    description: ex.description,
                });
            }
        } catch {
            // A predicate that throws on missing input is treated as not
            // matching — the per-condition checks below will report the
            // real failure.
        }
    }
    const excluded = matchedExclusions.length > 0;

    // 2. Evaluate all 9 conditions (even when excluded, so the report is
    //    complete).  Normalise `now` into the input for the soak check.
    const evalInput = {...data, now};
    const conditions = AUTO_MERGE_CONDITIONS.map((cond) => {
        const passed = checkCondition(cond.id, evalInput);
        return {
            id: cond.id,
            name: cond.name,
            description: cond.description,
            passed,
        };
    });

    const failedConditions = conditions.filter((c) => !c.passed);
    const allConditionsPassed = failedConditions.length === 0;
    const allowed = !excluded && allConditionsPassed;

    const blockingReasons = [];
    for (const ex of matchedExclusions) {
        blockingReasons.push(`Exclusion: ${ex.name}`);
    }
    for (const cond of failedConditions) {
        blockingReasons.push(`Condition failed: ${cond.name}`);
    }

    return {
        allowed,
        excluded,
        exclusions: matchedExclusions,
        conditions,
        blockingReasons,
    };
}

/**
 * Render the rules (9 conditions + exclusions) as a markdown document.
 * Used by the `--list` CLI flag and by downstream docs generators.
 *
 * @returns {string}
 */
function renderRulesMarkdown() {
    const lines = [];
    lines.push('# Auto-merge Rules');
    lines.push('');
    lines.push(
        'Auto-merge is **only** enabled when all 9 conditions below are met ' +
            'AND no hard exclusion applies.',
    );
    lines.push('');
    lines.push('## Conditions (all must pass)');
    lines.push('');
    lines.push('| # | Id | Name | Description |');
    lines.push('|---|----|------|-------------|');
    AUTO_MERGE_CONDITIONS.forEach((cond, idx) => {
        lines.push(`| ${idx + 1} | \`${cond.id}\` | ${cond.name} | ${cond.description} |`);
    });
    lines.push('');
    lines.push('## Hard exclusions (always require a human)');
    lines.push('');
    lines.push('| Id | Name | Description |');
    lines.push('|----|------|-------------|');
    for (const ex of EXCLUSION_LIST) {
        lines.push(`| \`${ex.id}\` | ${ex.name} | ${ex.description} |`);
    }
    lines.push('');
    lines.push('## Allowed manifest files');
    lines.push('');
    lines.push('A qualifying PR may touch only:');
    lines.push('');
    for (const file of ALLOWED_MANIFEST_FILES) {
        lines.push(`- \`${file}\``);
    }
    lines.push('');
    lines.push('## Snapshot file patterns');
    lines.push('');
    lines.push(
        'A PR changing any path matching these patterns fails the `no-snapshots` condition:',
    );
    lines.push('');
    for (const pat of SNAPSHOT_PATTERNS) {
        lines.push(`- \`${pat}\``);
    }
    lines.push('');
    lines.push(`## Soak window`);
    lines.push('');
    lines.push(
        `Minimum elapsed time between green CI and auto-merge: **${SOAK_WINDOW_MS / (60 * 60 * 1000)} hours**.`,
    );
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
    const {readFileSync} = require('node:fs');
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

    const quiet = flags.quiet === true;

    if (flags.list === true) {
        console.log(renderRulesMarkdown());
        process.exit(0);
    }

    if (flags.input) {
        let raw;
        try {
            raw = readFileSync(flags.input, 'utf8');
        } catch (error) {
            console.error(`[@diplodoc/infra] Cannot read --input ${flags.input}: ${error.message}`);
            process.exit(1);
        }
        let input;
        try {
            input = JSON.parse(raw);
        } catch (error) {
            console.error(`[@diplodoc/infra] --input is not valid JSON: ${error.message}`);
            process.exit(1);
        }
        const result = evaluateAutoMerge(input);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.allowed ? 0 : 1);
    }

    if (!quiet) {
        console.error('Usage: auto-merge-rules.js [--list] [--input <path>] [--json] [--quiet]');
        console.error('  --list   Print the 9 conditions + exclusion list as markdown.');
        console.error(
            '  --input  Evaluate a JSON file describing the PR (exits non-zero when not allowed).',
        );
    }
    process.exit(0);
}

module.exports = {
    AUTO_MERGE_CONDITIONS,
    EXCLUSION_LIST,
    ALLOWED_MANIFEST_FILES,
    SNAPSHOT_PATTERNS,
    SOAK_WINDOW_MS,
    isProductionSection,
    snapshotGlobToRegExp,
    isSnapshotFile,
    isManifestLockfileOnly,
    changesSnapshots,
    elapsedMs,
    meetsSoakWindow,
    newTransitiveCount,
    checkCondition,
    evaluateAutoMerge,
    renderRulesMarkdown,
};
