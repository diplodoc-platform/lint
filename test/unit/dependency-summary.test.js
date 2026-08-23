const assert = require('node:assert');

const {
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
} = require('../../scripts/dependency-summary');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- Constants --------------------------------------------------------------

test('DEFAULT_PR_LIMIT is 5 (matches scaffolding template 2+2+1)', () => {
    assert.strictEqual(DEFAULT_PR_LIMIT, 5);
});

test('NEW_PR_AGE_DAYS is 3', () => {
    assert.strictEqual(NEW_PR_AGE_DAYS, 3);
});

// --- parseDependabotLimit ---------------------------------------------------

test('parseDependabotLimit: sums open-pull-requests-limit across blocks', () => {
    const yaml = `
version: 2
updates:
  - package-ecosystem: 'npm'
    open-pull-requests-limit: 2
  - package-ecosystem: 'npm'
    open-pull-requests-limit: 2
  - package-ecosystem: 'npm'
    open-pull-requests-limit: 1
`;
    assert.strictEqual(parseDependabotLimit(yaml), 5);
});

test('parseDependabotLimit: returns default for empty content', () => {
    assert.strictEqual(parseDependabotLimit(''), DEFAULT_PR_LIMIT);
    assert.strictEqual(parseDependabotLimit(null), DEFAULT_PR_LIMIT);
});

test('parseDependabotLimit: returns default for invalid YAML', () => {
    assert.strictEqual(parseDependabotLimit('not: valid: yaml: ['), DEFAULT_PR_LIMIT);
});

test('parseDependabotLimit: handles no updates array', () => {
    const yaml = `version: 2\n`;
    assert.strictEqual(parseDependabotLimit(yaml), DEFAULT_PR_LIMIT);
});

test('parseDependabotLimit: handles blocks without limit (defaults to 0)', () => {
    const yaml = `
version: 2
updates:
  - package-ecosystem: 'npm'
    schedule:
      interval: 'weekly'
`;
    assert.strictEqual(parseDependabotLimit(yaml), DEFAULT_PR_LIMIT);
});

// --- prsWithoutOwner --------------------------------------------------------

function makePr(overrides = {}) {
    return {
        repo: 'cli',
        number: 1,
        title: 'Bump foo from 1.0.0 to 1.0.1',
        url: 'https://x',
        author: 'dependabot[bot]',
        assignees: [],
        createdAt: '2026-08-20T12:00:00Z',
        ageDays: 3,
        security: false,
        dependency: 'foo',
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        updateType: 'patch',
        risk: 'low',
        checkStatus: 'passing',
        labels: [],
        ...overrides,
    };
}

test('prsWithoutOwner: returns PRs with no assignees', () => {
    const inventory = [
        makePr({number: 1, assignees: [], ageDays: 1}),
        makePr({number: 2, assignees: ['someone'], ageDays: 2}),
        makePr({number: 3, assignees: [], ageDays: 2}),
    ];
    const result = prsWithoutOwner(inventory);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].number, 1);
    assert.strictEqual(result[1].number, 3);
});

test('prsWithoutOwner: only includes new PRs (age <= NEW_PR_AGE_DAYS)', () => {
    const inventory = [
        makePr({number: 1, assignees: [], ageDays: 1}),
        makePr({number: 2, assignees: [], ageDays: 10}),
    ];
    const result = prsWithoutOwner(inventory);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].number, 1);
});

test('prsWithoutOwner: Infinity includes all unowned PRs', () => {
    const inventory = [
        makePr({number: 1, assignees: [], ageDays: 1}),
        makePr({number: 2, assignees: [], ageDays: 100}),
    ];
    const result = prsWithoutOwner(inventory, Infinity);
    assert.strictEqual(result.length, 2);
});

test('prsWithoutOwner: handles empty/non-array input', () => {
    assert.deepStrictEqual(prsWithoutOwner([]), []);
    assert.deepStrictEqual(prsWithoutOwner(null), []);
    assert.deepStrictEqual(prsWithoutOwner(undefined), []);
});

test('prsWithoutOwner: handles missing assignees field', () => {
    const inventory = [{repo: 'cli', number: 1, ageDays: 1, title: 'test'}];
    const result = prsWithoutOwner(inventory);
    assert.strictEqual(result.length, 1);
});

// --- prsWithFailedChecks ----------------------------------------------------

test('prsWithFailedChecks: returns PRs with checkStatus failing', () => {
    const inventory = [
        makePr({number: 1, checkStatus: 'failing'}),
        makePr({number: 2, checkStatus: 'passing'}),
        makePr({number: 3, checkStatus: 'pending'}),
        makePr({number: 4, checkStatus: 'failing'}),
    ];
    const result = prsWithFailedChecks(inventory);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].number, 1);
    assert.strictEqual(result[1].number, 4);
});

test('prsWithFailedChecks: empty input returns empty', () => {
    assert.deepStrictEqual(prsWithFailedChecks([]), []);
});

// --- prsBreachingSla --------------------------------------------------------

test('prsBreachingSla: returns breaching PRs sorted by daysOverdue desc', () => {
    const prs = [
        {repo: 'cli', number: 1, breach: false, daysOverdue: 0},
        {repo: 'cli', number: 2, breach: true, daysOverdue: 5, slaLabel: 'Patch'},
        {repo: 'cli', number: 3, breach: true, daysOverdue: 10, slaLabel: 'Major'},
    ];
    const result = prsBreachingSla(prs);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].number, 3); // 10 days overdue
    assert.strictEqual(result[1].number, 2); // 5 days overdue
});

test('prsBreachingSla: empty input', () => {
    assert.deepStrictEqual(prsBreachingSla([]), []);
});

// --- expiringExceptions -----------------------------------------------------

test('expiringExceptions: returns overdue and expiring (<=14 days)', () => {
    const exceptions = [
        {id: 'DEP-0001', daysUntilReview: 30, overdue: false},
        {id: 'DEP-0002', daysUntilReview: 10, overdue: false},
        {id: 'DEP-0003', daysUntilReview: -5, overdue: true},
    ];
    const result = expiringExceptions(exceptions);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'DEP-0003'); // overdue first (sorted by daysUntilReview asc)
    assert.strictEqual(result[1].id, 'DEP-0002');
});

test('expiringExceptions: empty input', () => {
    assert.deepStrictEqual(expiringExceptions([]), []);
});

// --- unpinnedVersions -------------------------------------------------------

test('unpinnedVersions: finds exact pins without registry entry', () => {
    const packageJson = {
        dependencies: {svgo: '3.3.2', lodash: '^4.17.21'},
        devDependencies: {typescript: '5.0.0'},
    };
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    const violations = unpinnedVersions('cli', packageJson, registry);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].name, 'typescript');
    assert.strictEqual(violations[0].version, '5.0.0');
    assert.strictEqual(violations[0].section, 'devDependencies');
    assert.strictEqual(violations[0].repo, 'cli');
});

test('unpinnedVersions: no pins returns empty', () => {
    const packageJson = {dependencies: {lodash: '^4.17.21'}};
    const result = unpinnedVersions('cli', packageJson, []);
    assert.deepStrictEqual(result, []);
});

test('unpinnedVersions: null packageJson returns empty', () => {
    assert.deepStrictEqual(unpinnedVersions('cli', null, []), []);
});

test('unpinnedVersions: ranged deps are not pins', () => {
    const packageJson = {dependencies: {foo: '^1.0.0', bar: '~2.0.0', baz: '>=3.0.0'}};
    assert.deepStrictEqual(unpinnedVersions('cli', packageJson, []), []);
});

// --- stalePolicyEntries -----------------------------------------------------

test('stalePolicyEntries: flags dep no longer in package.json', () => {
    const packageJson = {dependencies: {lodash: '^4.17.21'}};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    const result = stalePolicyEntries('cli', packageJson, registry);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'DEP-0001');
    assert.strictEqual(result[0].dependency, 'svgo');
    assert.ok(result[0].reason.includes('no longer'));
});

test('stalePolicyEntries: flags version mismatch (pin changed)', () => {
    const packageJson = {dependencies: {svgo: '3.4.0'}};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    const result = stalePolicyEntries('cli', packageJson, registry);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].reason.includes('3.4.0'));
    assert.ok(result[0].reason.includes('3.3.2'));
});

test('stalePolicyEntries: no mismatch when allowed-version matches pin', () => {
    const packageJson = {dependencies: {svgo: '3.3.2'}};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    assert.deepStrictEqual(stalePolicyEntries('cli', packageJson, registry), []);
});

test('stalePolicyEntries: ranged version is not a mismatch', () => {
    const packageJson = {dependencies: {svgo: '^3.3.2'}};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    // ^3.3.2 is a range, not an exact pin — no mismatch to flag.
    assert.deepStrictEqual(stalePolicyEntries('cli', packageJson, registry), []);
});

test('stalePolicyEntries: no scoped entries returns empty', () => {
    const packageJson = {dependencies: {foo: '1.0.0'}};
    const registry = [
        {
            id: 'DEP-0001',
            dependency: 'foo',
            'allowed-version': '1.0.0',
            repositories: ['transform'],
        },
    ];
    // Entry scoped to 'transform', not 'cli'.
    assert.deepStrictEqual(stalePolicyEntries('cli', packageJson, registry), []);
});

test('stalePolicyEntries: null packageJson returns empty', () => {
    assert.deepStrictEqual(stalePolicyEntries('cli', null, []), []);
});

// --- reposAtPrLimit ---------------------------------------------------------

test('reposAtPrLimit: detects repos where PR count >= limit', () => {
    const inventory = [
        {repo: 'cli', number: 1},
        {repo: 'cli', number: 2},
        {repo: 'cli', number: 3},
        {repo: 'transform', number: 5},
    ];
    const prLimits = {cli: 3, transform: 5};
    const result = reposAtPrLimit(inventory, prLimits);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].repo, 'cli');
    assert.strictEqual(result[0].openPrs, 3);
    assert.strictEqual(result[0].limit, 3);
});

test('reposAtPrLimit: uses default when limit missing', () => {
    const inventory = [
        {repo: 'utils', number: 1},
        {repo: 'utils', number: 2},
        {repo: 'utils', number: 3},
        {repo: 'utils', number: 4},
        {repo: 'utils', number: 5},
    ];
    const result = reposAtPrLimit(inventory, {});
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].repo, 'utils');
    assert.strictEqual(result[0].limit, DEFAULT_PR_LIMIT);
});

test('reposAtPrLimit: sorts by openPrs descending', () => {
    const inventory = [
        {repo: 'a', number: 1},
        {repo: 'a', number: 2},
        {repo: 'b', number: 3},
        {repo: 'b', number: 4},
        {repo: 'b', number: 5},
    ];
    const prLimits = {a: 2, b: 3};
    const result = reposAtPrLimit(inventory, prLimits);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].repo, 'b');
    assert.strictEqual(result[1].repo, 'a');
});

test('reposAtPrLimit: empty input', () => {
    assert.deepStrictEqual(reposAtPrLimit([], {}), []);
    assert.deepStrictEqual(reposAtPrLimit(null, null), []);
});

// --- buildSummary -----------------------------------------------------------

test('buildSummary: empty inputs produce zero actionable items', () => {
    const summary = buildSummary({
        inventory: [],
        health: {prs: [], exceptions: [], summary: {}},
        manifests: {},
        registryEntries: [],
        prLimits: {},
        now: new Date('2026-08-23T12:00:00Z'),
    });
    assert.strictEqual(summary.totals.actionableItems, 0);
    assert.strictEqual(summary.totals.prsWithoutOwner, 0);
    assert.strictEqual(summary.totals.failedChecks, 0);
    assert.strictEqual(summary.totals.slaBreaches, 0);
    assert.strictEqual(summary.totals.expiringExceptions, 0);
    assert.strictEqual(summary.totals.unpinnedVersions, 0);
    assert.strictEqual(summary.totals.stalePolicyEntries, 0);
    assert.strictEqual(summary.totals.reposAtPrLimit, 0);
    assert.ok(summary.generatedAt);
});

test('buildSummary: computes all 7 categories', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const inventory = [
        makePr({repo: 'cli', number: 1, assignees: [], ageDays: 1, checkStatus: 'failing'}),
        makePr({repo: 'cli', number: 2, assignees: ['owner'], ageDays: 5, checkStatus: 'passing'}),
    ];
    const health = {
        prs: [
            {
                repo: 'cli',
                number: 1,
                breach: true,
                daysOverdue: 3,
                slaLabel: 'Patch',
                security: false,
                risk: 'low',
                dependency: 'foo',
                title: 't',
                ageDays: 10,
            },
            {
                repo: 'cli',
                number: 2,
                breach: false,
                daysOverdue: 0,
                slaLabel: 'Patch',
                security: false,
                risk: 'low',
                dependency: 'bar',
                title: 't',
                ageDays: 5,
            },
        ],
        exceptions: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                repositories: ['cli'],
                reviewAfter: '2026-09-01',
                daysUntilReview: 9,
                overdue: false,
            },
        ],
        summary: {},
    };
    const manifests = {
        cli: {dependencies: {svgo: '3.3.2', katex: '0.16.9'}},
    };
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    const prLimits = {cli: 2};

    const summary = buildSummary({
        inventory,
        health,
        manifests,
        registryEntries: registry,
        prLimits,
        now,
    });

    assert.strictEqual(summary.totals.prsWithoutOwner, 1); // PR #1
    assert.strictEqual(summary.totals.failedChecks, 1); // PR #1
    assert.strictEqual(summary.totals.slaBreaches, 1); // PR #1
    assert.strictEqual(summary.totals.expiringExceptions, 1); // DEP-0001 (9 days)
    assert.strictEqual(summary.totals.unpinnedVersions, 1); // katex 0.16.9
    assert.strictEqual(summary.totals.stalePolicyEntries, 0); // svgo 3.3.2 matches
    assert.strictEqual(summary.totals.reposAtPrLimit, 1); // cli has 2 PRs, limit 2
    assert.strictEqual(summary.totals.actionableItems, 6);
});

test('buildSummary: stalePolicyEntries detected via manifest mismatch', () => {
    const manifests = {
        cli: {dependencies: {svgo: '3.4.0'}}, // changed pin without updating registry
    };
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2', repositories: ['cli']},
    ];
    const summary = buildSummary({
        inventory: [],
        health: {prs: [], exceptions: [], summary: {}},
        manifests,
        registryEntries: registry,
        prLimits: {},
        now: new Date('2026-08-23T12:00:00Z'),
    });
    assert.strictEqual(summary.totals.stalePolicyEntries, 1);
});

// --- renderSummaryMarkdown --------------------------------------------------

test('renderSummaryMarkdown: includes title and summary table', () => {
    const summary = buildSummary({
        inventory: [],
        health: {prs: [], exceptions: [], summary: {}},
        manifests: {},
        registryEntries: [],
        prLimits: {},
        now: new Date('2026-08-23T12:00:00Z'),
    });
    const md = renderSummaryMarkdown(summary);
    assert.ok(md.includes('# Daily Dependency Health Summary'));
    assert.ok(md.includes('## Summary'));
    assert.ok(md.includes('Category'));
    assert.ok(md.includes('Count'));
    assert.ok(md.includes('All clear'));
});

test('renderSummaryMarkdown: renders category sections when items present', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const inventory = [
        makePr({
            repo: 'cli',
            number: 1,
            assignees: [],
            ageDays: 1,
            checkStatus: 'failing',
            title: 'Bump | pipe',
        }),
    ];
    const health = {
        prs: [
            {
                repo: 'cli',
                number: 1,
                breach: true,
                daysOverdue: 3,
                slaLabel: 'Patch',
                security: false,
                risk: 'low',
                dependency: 'foo',
                title: 'Bump | pipe',
                ageDays: 10,
            },
        ],
        exceptions: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                repositories: ['cli'],
                reviewAfter: '2026-09-01',
                daysUntilReview: 9,
                overdue: false,
            },
        ],
        summary: {},
    };
    const summary = buildSummary({
        inventory,
        health,
        manifests: {cli: {dependencies: {katex: '0.16.9'}}},
        registryEntries: [],
        prLimits: {cli: 1},
        now,
    });
    const md = renderSummaryMarkdown(summary);
    assert.ok(md.includes('## 1. New PRs Without Assigned Owner'));
    assert.ok(md.includes('## 2. PRs With Failing Checks'));
    assert.ok(md.includes('## 3. PRs Breaching SLA'));
    assert.ok(md.includes('## 4. Expiring / Overdue Exceptions'));
    assert.ok(md.includes('## 5. Pinned Versions Missing From Policy'));
    assert.ok(md.includes('## 7. Repositories at Dependabot PR Limit'));
    // Pipe in title is escaped
    assert.ok(md.includes('\\| pipe'));
});

test('renderSummaryMarkdown: does not render category sections when empty', () => {
    const summary = buildSummary({
        inventory: [],
        health: {prs: [], exceptions: [], summary: {}},
        manifests: {},
        registryEntries: [],
        prLimits: {},
        now: new Date('2026-08-23T12:00:00Z'),
    });
    const md = renderSummaryMarkdown(summary);
    assert.ok(!md.includes('## 1. New PRs'));
    assert.ok(!md.includes('## 2. PRs With Failing'));
});

test('renderSummaryMarkdown: total actionable items count shown', () => {
    const summary = buildSummary({
        inventory: [makePr({number: 1, assignees: [], ageDays: 1})],
        health: {prs: [], exceptions: [], summary: {}},
        manifests: {},
        registryEntries: [],
        prLimits: {},
        now: new Date('2026-08-23T12:00:00Z'),
    });
    const md = renderSummaryMarkdown(summary);
    assert.ok(md.includes('Total actionable items: 1'));
});

module.exports = {tests};
