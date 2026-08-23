const assert = require('node:assert');
const yaml = require('js-yaml');

const {
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
} = require('../../scripts/export-pr-inventory');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- parseRepoList --------------------------------------------------------

test('parseRepoList: returns 28 repos (27 from config + infra)', () => {
    const config = {
        repos: {
            cli: {},
            transform: {},
            components: {},
            utils: {},
            'cut-extension': {},
            'package-template': {},
            testpack: {},
        },
    };
    const repos = parseRepoList(config);
    assert.ok(repos.includes('infra'), 'infra should be included');
    assert.ok(repos.includes('cli'));
    assert.strictEqual(repos.length, 8);
    assert.deepStrictEqual(repos, [...repos].sort(), 'should be sorted');
});

test('parseRepoList: handles empty config', () => {
    const repos = parseRepoList({});
    assert.deepStrictEqual(repos, ['infra']);
});

test('parseRepoList: deduplicates infra if already in config', () => {
    const config = {repos: {infra: {}, cli: {}}};
    const repos = parseRepoList(config);
    const infraCount = repos.filter((r) => r === 'infra').length;
    assert.strictEqual(infraCount, 1);
});

// --- computeAgeDays -------------------------------------------------------

test('computeAgeDays: computes correct age in days', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const created = '2026-08-20T12:00:00Z';
    assert.strictEqual(computeAgeDays(created, now), 3);
});

test('computeAgeDays: returns 0 for future date', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const created = '2026-08-25T12:00:00Z';
    assert.strictEqual(computeAgeDays(created, now), 0);
});

test('computeAgeDays: returns 0 for empty/invalid', () => {
    assert.strictEqual(computeAgeDays(''), 0);
    assert.strictEqual(computeAgeDays(null), 0);
    assert.strictEqual(computeAgeDays('not-a-date'), 0);
});

test('computeAgeDays: handles partial days (floors)', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const created = '2026-08-22T18:00:00Z';
    assert.strictEqual(computeAgeDays(created, now), 0);
    const created2 = '2026-08-21T10:00:00Z';
    assert.strictEqual(computeAgeDays(created2, now), 2);
});

// --- extractDependencyFromTitle -------------------------------------------

test('extractDependencyFromTitle: basic bump', () => {
    const result = extractDependencyFromTitle('Bump foo from 1.2.3 to 1.2.4');
    assert.deepStrictEqual(result, {dependency: 'foo', from: '1.2.3', to: '1.2.4'});
});

test('extractDependencyFromTitle: scoped package', () => {
    const result = extractDependencyFromTitle('Bump @scope/bar from 1.0.0 to 1.1.0');
    assert.deepStrictEqual(result, {
        dependency: '@scope/bar',
        from: '1.0.0',
        to: '1.1.0',
    });
});

test('extractDependencyFromTitle: with subdir', () => {
    const result = extractDependencyFromTitle('Bump foo in /packages/cli from 1.0.0 to 2.0.0');
    assert.deepStrictEqual(result, {dependency: 'foo', from: '1.0.0', to: '2.0.0'});
});

test('extractDependencyFromTitle: with chore prefix', () => {
    const result = extractDependencyFromTitle('chore(deps): bump foo from 1.0.0 to 1.1.0');
    assert.deepStrictEqual(result, {dependency: 'foo', from: '1.0.0', to: '1.1.0'});
});

test('extractDependencyFromTitle: security prefix', () => {
    const result = extractDependencyFromTitle('[Security] Bump lodash from 4.17.20 to 4.17.21');
    assert.deepStrictEqual(result, {
        dependency: 'lodash',
        from: '4.17.20',
        to: '4.17.21',
    });
});

test('extractDependencyFromTitle: case insensitive', () => {
    const result = extractDependencyFromTitle('bump FOO from 1.0.0 to 2.0.0');
    assert.ok(result);
    assert.strictEqual(result.dependency, 'FOO');
});

test('extractDependencyFromTitle: returns null for non-dependabot title', () => {
    assert.strictEqual(extractDependencyFromTitle('Fix bug in parser'), null);
    assert.strictEqual(extractDependencyFromTitle(''), null);
    assert.strictEqual(extractDependencyFromTitle(null), null);
});

// --- isSecurityPr / normalizeLabels ---------------------------------------

test('isSecurityPr: detects security label', () => {
    assert.ok(isSecurityPr({labels: [{name: 'security'}]}));
    assert.ok(isSecurityPr({labels: [{name: 'Security'}]}));
    assert.ok(isSecurityPr({labels: ['security']}));
});

test('isSecurityPr: detects security in title', () => {
    assert.ok(isSecurityPr({title: '[Security] Bump foo from 1 to 2', labels: []}));
});

test('isSecurityPr: returns false for non-security', () => {
    assert.strictEqual(isSecurityPr({labels: [{name: 'dependencies'}], title: 'Bump foo'}), false);
    assert.strictEqual(isSecurityPr({labels: [], title: 'Bump bar'}), false);
});

test('normalizeLabels: handles objects, strings, and mixed', () => {
    assert.deepStrictEqual(normalizeLabels([{name: 'foo'}, {name: 'Bar'}, 'baz']), [
        'foo',
        'bar',
        'baz',
    ]);
    assert.deepStrictEqual(normalizeLabels(null), []);
    assert.deepStrictEqual(normalizeLabels(undefined), []);
});

// --- deriveUpdateType / compareSemver / parseSemver -----------------------

test('deriveUpdateType: uses labels when present', () => {
    assert.strictEqual(deriveUpdateType(['patch'], '1.0.0', '1.0.1'), 'patch');
    assert.strictEqual(deriveUpdateType(['minor'], '1.0.0', '1.1.0'), 'minor');
    assert.strictEqual(deriveUpdateType(['major'], '1.0.0', '2.0.0'), 'major');
});

test('deriveUpdateType: falls back to semver comparison', () => {
    assert.strictEqual(deriveUpdateType([], '1.0.0', '1.0.1'), 'patch');
    assert.strictEqual(deriveUpdateType([], '1.0.0', '1.1.0'), 'minor');
    assert.strictEqual(deriveUpdateType([], '1.0.0', '2.0.0'), 'major');
});

test('deriveUpdateType: returns unknown for missing versions', () => {
    assert.strictEqual(deriveUpdateType([], null, null), 'unknown');
});

test('compareSemver: handles range operators in from', () => {
    assert.strictEqual(compareSemver('^1.0.0', '2.0.0'), 'major');
    assert.strictEqual(compareSemver('~1.2.0', '1.2.1'), 'patch');
});

test('parseSemver: strips pre-release suffixes', () => {
    const v = parseSemver('1.2.3-beta.1');
    assert.deepStrictEqual(v, {major: 1, minor: 2, patch: 3});
});

test('parseSemver: returns null for invalid', () => {
    assert.strictEqual(parseSemver(''), null);
    assert.strictEqual(parseSemver(null), null);
    assert.strictEqual(parseSemver('abc'), null);
});

// --- assessRisk ------------------------------------------------------------

test('assessRisk: uses registry entry risk when present', () => {
    const entries = [
        {dependency: 'svgo', risk: 'high'},
        {dependency: 'lodash', risk: 'critical'},
    ];
    assert.strictEqual(assessRisk('svgo', entries, 'major'), 'high');
    assert.strictEqual(assessRisk('lodash', entries, 'patch'), 'critical');
});

test('assessRisk: falls back to update-type default', () => {
    assert.strictEqual(assessRisk('unknown-dep', [], 'patch'), 'low');
    assert.strictEqual(assessRisk('unknown-dep', [], 'minor'), 'medium');
    assert.strictEqual(assessRisk('unknown-dep', [], 'major'), 'high');
    assert.strictEqual(assessRisk('unknown-dep', [], 'unknown'), 'medium');
});

// --- buildInventoryEntry ---------------------------------------------------

test('buildInventoryEntry: builds complete entry from raw PR', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const pr = {
        number: 42,
        title: 'Bump foo from 1.0.0 to 2.0.0',
        html_url: 'https://github.com/diplodoc-platform/cli/pull/42',
        user: {login: 'dependabot[bot]', type: 'Bot'},
        created_at: '2026-07-23T12:00:00Z',
        labels: [{name: 'dependencies'}, {name: 'major'}],
        head: {sha: 'abc123'},
    };
    const entry = buildInventoryEntry(pr, 'cli', 'failing', [], now);
    assert.strictEqual(entry.repo, 'cli');
    assert.strictEqual(entry.number, 42);
    assert.strictEqual(entry.dependency, 'foo');
    assert.strictEqual(entry.fromVersion, '1.0.0');
    assert.strictEqual(entry.toVersion, '2.0.0');
    assert.strictEqual(entry.updateType, 'major');
    assert.strictEqual(entry.risk, 'high');
    assert.strictEqual(entry.security, false);
    assert.strictEqual(entry.checkStatus, 'failing');
    assert.strictEqual(entry.headSha, 'abc123');
    assert.strictEqual(entry.baseRef, 'master');
    assert.strictEqual(entry.ageDays, 31);
    assert.ok(entry.labels.includes('dependencies'));
});

test('buildInventoryEntry: security PR detected', () => {
    const pr = {
        number: 1,
        title: '[Security] Bump lodash from 4.17.20 to 4.17.21',
        html_url: 'url',
        user: {login: 'dependabot[bot]'},
        created_at: '2026-08-23T00:00:00Z',
        labels: [{name: 'security'}, {name: 'dependencies'}],
    };
    const entry = buildInventoryEntry(pr, 'utils', 'passing', []);
    assert.strictEqual(entry.security, true);
    assert.strictEqual(entry.updateType, 'patch');
});

test('buildInventoryEntry: handles missing dependency in title', () => {
    const pr = {
        number: 99,
        title: 'Update dependencies',
        html_url: 'url',
        user: {login: 'dependabot[bot]'},
        created_at: '2026-08-20T00:00:00Z',
        labels: [{name: 'dependencies'}],
    };
    const entry = buildInventoryEntry(pr, 'cli', 'unknown', []);
    assert.strictEqual(entry.dependency, '');
    assert.strictEqual(entry.fromVersion, '');
    assert.strictEqual(entry.toVersion, '');
    assert.strictEqual(entry.updateType, 'unknown');
    assert.strictEqual(entry.risk, 'unknown');
});

// --- sortInventory --------------------------------------------------------

test('sortInventory: security PRs first', () => {
    const inventory = [
        {repo: 'cli', number: 1, security: false, ageDays: 5},
        {repo: 'cli', number: 2, security: true, ageDays: 1},
    ];
    const sorted = sortInventory(inventory);
    assert.strictEqual(sorted[0].number, 2);
    assert.strictEqual(sorted[1].number, 1);
});

test('sortInventory: non-security sorted by age (oldest first)', () => {
    const inventory = [
        {repo: 'cli', number: 1, security: false, ageDays: 5},
        {repo: 'cli', number: 2, security: false, ageDays: 30},
        {repo: 'cli', number: 3, security: false, ageDays: 10},
    ];
    const sorted = sortInventory(inventory);
    assert.strictEqual(sorted[0].ageDays, 30);
    assert.strictEqual(sorted[1].ageDays, 10);
    assert.strictEqual(sorted[2].ageDays, 5);
});

test('sortInventory: security PRs also sorted by age within group', () => {
    const inventory = [
        {repo: 'cli', number: 1, security: true, ageDays: 2},
        {repo: 'cli', number: 2, security: true, ageDays: 10},
    ];
    const sorted = sortInventory(inventory);
    assert.strictEqual(sorted[0].ageDays, 10);
    assert.strictEqual(sorted[1].ageDays, 2);
});

test('sortInventory: does not mutate original array', () => {
    const inventory = [
        {repo: 'cli', number: 1, security: false, ageDays: 5},
        {repo: 'cli', number: 2, security: false, ageDays: 30},
    ];
    const sorted = sortInventory(inventory);
    assert.strictEqual(inventory[0].ageDays, 5);
    assert.strictEqual(sorted[0].ageDays, 30);
});

// --- summarizeByRepo -------------------------------------------------------

test('summarizeByRepo: groups by repo with counts', () => {
    const inventory = [
        {repo: 'cli', security: true, checkStatus: 'failing', ageDays: 30},
        {repo: 'cli', security: false, checkStatus: 'passing', ageDays: 5},
        {repo: 'transform', security: false, checkStatus: 'failing', ageDays: 90},
    ];
    const summary = summarizeByRepo(inventory);
    assert.strictEqual(summary.length, 2);
    assert.strictEqual(summary[0].repo, 'cli');
    assert.strictEqual(summary[0].total, 2);
    assert.strictEqual(summary[0].security, 1);
    assert.strictEqual(summary[0].failing, 1);
    assert.strictEqual(summary[0].oldestAgeDays, 30);
    const transformSummary = summary.find((s) => s.repo === 'transform');
    assert.strictEqual(transformSummary.total, 1);
    assert.strictEqual(transformSummary.oldestAgeDays, 90);
});

test('summarizeByRepo: empty inventory returns empty array', () => {
    assert.deepStrictEqual(summarizeByRepo([]), []);
});

// --- summarizeInventory ---------------------------------------------------

test('summarizeInventory: computes all statistics', () => {
    const inventory = [
        {repo: 'cli', security: true, checkStatus: 'failing', ageDays: 95},
        {repo: 'cli', security: false, checkStatus: 'passing', ageDays: 40},
        {repo: 'transform', security: false, checkStatus: 'failing', ageDays: 10},
    ];
    const summary = summarizeInventory(inventory);
    assert.strictEqual(summary.totalPrs, 3);
    assert.strictEqual(summary.securityPrs, 1);
    assert.strictEqual(summary.failingPrs, 2);
    assert.strictEqual(summary.olderThan30Days, 2);
    assert.strictEqual(summary.olderThan90Days, 1);
    assert.strictEqual(summary.repoCount, 2);
});

// --- renderMarkdown --------------------------------------------------------

test('renderMarkdown: produces valid markdown with expected sections', () => {
    const inventory = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump foo from 1.0.0 to 2.0.0',
            url: 'url',
            security: false,
            ageDays: 30,
            dependency: 'foo',
            fromVersion: '1.0.0',
            toVersion: '2.0.0',
            updateType: 'major',
            risk: 'high',
            checkStatus: 'failing',
            labels: [],
        },
    ];
    const md = renderMarkdown(inventory);
    assert.ok(md.includes('# Dependabot PR Inventory'), 'has title');
    assert.ok(md.includes('## Summary'), 'has summary section');
    assert.ok(md.includes('## Per-Repository Breakdown'), 'has repo breakdown');
    assert.ok(md.includes('## All PRs'), 'has PR table');
    assert.ok(md.includes('cli'), 'includes repo name');
    assert.ok(md.includes('Bump foo'), 'includes PR title');
    assert.ok(md.includes('| 42 |'), 'includes PR number');
});

test('renderMarkdown: handles empty inventory', () => {
    const md = renderMarkdown([]);
    assert.ok(md.includes('# Dependabot PR Inventory'));
    assert.ok(md.includes('Total open PRs | 0'));
});

test('renderMarkdown: escapes pipe in titles', () => {
    const inventory = [
        {
            repo: 'cli',
            number: 1,
            title: 'Bump foo | bar from 1 to 2',
            url: 'url',
            security: false,
            ageDays: 1,
            dependency: 'foo',
            fromVersion: '1',
            toVersion: '2',
            updateType: 'major',
            risk: 'high',
            checkStatus: 'passing',
            labels: [],
        },
    ];
    const md = renderMarkdown(inventory);
    assert.ok(md.includes('\\|'), 'pipe is escaped');
});

module.exports = {tests};
