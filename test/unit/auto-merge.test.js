const assert = require('node:assert');
const {
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
    extractRequiredCheckContexts,
} = require('../../scripts/auto-merge');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- deriveSection ---------------------------------------------------------

test('deriveSection: detects devDependencies from patch', () => {
    const patch = [
        '@@ -1,5 +1,5 @@',
        ' {',
        '   "name": "test",',
        '+  "devDependencies": {',
        '+    "eslint": "8.0.0",',
        '-    "eslint": "7.0.0"',
        '   }',
        '}',
    ].join('\n');
    assert.strictEqual(deriveSection(patch), 'devDependencies');
});

test('deriveSection: detects dependencies (production)', () => {
    const patch = [
        '@@ -1,3 +1,3 @@',
        ' {',
        '+  "dependencies": {',
        '+    "lodash": "4.17.21"',
        ' }',
    ].join('\n');
    assert.strictEqual(deriveSection(patch), 'dependencies');
});

test('deriveSection: detects peerDependencies', () => {
    const patch = '+  "peerDependencies": {';
    assert.strictEqual(deriveSection(patch), 'peerDependencies');
});

test('deriveSection: detects optionalDependencies', () => {
    const patch = '+    "optionalDependencies": {';
    assert.strictEqual(deriveSection(patch), 'optionalDependencies');
});

test('deriveSection: returns null for empty patch', () => {
    assert.strictEqual(deriveSection(''), null);
    assert.strictEqual(deriveSection(null), null);
    assert.strictEqual(deriveSection(undefined), null);
});

test('deriveSection: returns null when no section in patch', () => {
    const patch = '+  "version": "1.0.0"';
    assert.strictEqual(deriveSection(patch), null);
});

test('deriveSection: uses single quotes for section key', () => {
    const patch = "+  'devDependencies': {";
    assert.strictEqual(deriveSection(patch), 'devDependencies');
});

test('deriveSection: does not match removed lines (only added)', () => {
    const patch = '-  "devDependencies": {';
    assert.strictEqual(deriveSection(patch), null);
});

// --- deriveIsGrouped -------------------------------------------------------

test('deriveIsGrouped: true for grouped label', () => {
    assert.ok(deriveIsGrouped({labels: ['grouped'], title: 'Bump eslint from 7 to 8'}));
});

test('deriveIsGrouped: true for title with " and "', () => {
    assert.ok(deriveIsGrouped({labels: ['dependencies'], title: 'Bump eslint and prettier'}));
});

test('deriveIsGrouped: true for title with "grouped"', () => {
    assert.ok(deriveIsGrouped({labels: ['dependencies'], title: 'Grouped dependency updates'}));
});

test('deriveIsGrouped: true for multiple package.json files', () => {
    const files = [{filename: 'package.json'}, {filename: 'packages/sub/package.json'}];
    assert.ok(
        deriveIsGrouped({labels: [], title: 'Bump foo from 1 to 2', dependency: 'foo'}, files),
    );
});

test('deriveIsGrouped: false for single dep', () => {
    assert.ok(!deriveIsGrouped({labels: [], title: 'Bump eslint from 7 to 8'}));
});

test('deriveIsGrouped: false for null entry', () => {
    assert.ok(!deriveIsGrouped(null));
});

test('deriveIsGrouped: false for empty entry', () => {
    assert.ok(!deriveIsGrouped({}));
});

// --- deriveCiCompletedAt ---------------------------------------------------

test('deriveCiCompletedAt: returns latest completed_at', () => {
    const response = {
        check_runs: [
            {completed_at: '2026-08-23T10:00:00Z'},
            {completed_at: '2026-08-23T11:00:00Z'},
            {completed_at: '2026-08-23T09:00:00Z'},
        ],
    };
    assert.strictEqual(deriveCiCompletedAt(response), '2026-08-23T11:00:00Z');
});

test('deriveCiCompletedAt: returns null when no completed_at', () => {
    const response = {
        check_runs: [{completed_at: null}, {status: 'in_progress'}],
    };
    assert.strictEqual(deriveCiCompletedAt(response), null);
});

test('deriveCiCompletedAt: returns null for empty check_runs', () => {
    assert.strictEqual(deriveCiCompletedAt({check_runs: []}), null);
});

test('deriveCiCompletedAt: returns null for null input', () => {
    assert.strictEqual(deriveCiCompletedAt(null), null);
    assert.strictEqual(deriveCiCompletedAt(undefined), null);
});

test('deriveCiCompletedAt: handles single completed run', () => {
    const response = {check_runs: [{completed_at: '2026-08-23T10:00:00Z'}]};
    assert.strictEqual(deriveCiCompletedAt(response), '2026-08-23T10:00:00Z');
});

// --- deriveChecksGreen -----------------------------------------------------

test('deriveChecksGreen: true when all runs completed + success', () => {
    const response = {
        check_runs: [
            {id: 1, name: 'lint', status: 'completed', conclusion: 'success'},
            {id: 2, name: 'test', status: 'completed', conclusion: 'success'},
        ],
    };
    assert.ok(deriveChecksGreen(response, ['lint', 'test']));
});

test('deriveChecksGreen: false when one run failed', () => {
    const response = {
        check_runs: [
            {id: 1, name: 'lint', status: 'completed', conclusion: 'success'},
            {id: 2, name: 'test', status: 'completed', conclusion: 'failure'},
        ],
    };
    assert.ok(!deriveChecksGreen(response, ['lint', 'test']));
});

test('deriveChecksGreen: false when one run is pending', () => {
    const response = {
        check_runs: [
            {id: 1, name: 'lint', status: 'completed', conclusion: 'success'},
            {id: 2, name: 'test', status: 'in_progress', conclusion: null},
        ],
    };
    assert.ok(!deriveChecksGreen(response, ['lint', 'test']));
});

test('deriveChecksGreen: ignores non-required failures and accepts neutral required checks', () => {
    const response = {
        check_runs: [
            {id: 1, name: 'lint', status: 'completed', conclusion: 'neutral'},
            {id: 2, name: 'optional', status: 'completed', conclusion: 'failure'},
        ],
    };
    assert.ok(deriveChecksGreen(response, ['lint']));
});

test('deriveChecksGreen: fails closed when required contexts are unknown', () => {
    const response = {
        check_runs: [{id: 1, name: 'lint', status: 'completed', conclusion: 'success'}],
    };
    assert.ok(!deriveChecksGreen(response));
});

test('deriveChecksGreen: false for empty check_runs', () => {
    assert.ok(!deriveChecksGreen({check_runs: []}));
});

test('deriveChecksGreen: false for null input', () => {
    assert.ok(!deriveChecksGreen(null));
});

// --- deriveHasException ----------------------------------------------------

test('deriveHasException: true when entry matches dependency', () => {
    const entries = [{dependency: 'svgo', owner: '@team'}];
    assert.ok(deriveHasException('svgo', entries));
});

test('deriveHasException: false when no entry matches', () => {
    const entries = [{dependency: 'svgo', owner: '@team'}];
    assert.ok(!deriveHasException('lodash', entries));
});

test('deriveHasException: false for empty dependency', () => {
    assert.ok(!deriveHasException('', [{dependency: 'svgo'}]));
});

test('deriveHasException: false for empty entries', () => {
    assert.ok(!deriveHasException('svgo', []));
    assert.ok(!deriveHasException('svgo', null));
    assert.ok(!deriveHasException('svgo', undefined));
});

// --- deriveNewTransitiveCount ---------------------------------------------

test('deriveNewTransitiveCount: counts added node_modules entries', () => {
    const patch = [
        '@@ -1,10 +1,12 @@',
        '   "packages": {',
        '+    "node_modules/@babel/core": {',
        '+      "version": "7.0.0"',
        '+    },',
        '+    "node_modules/@babel/parser": {',
        '+      "version": "7.0.0"',
        '+    },',
        '     "node_modules/eslint": {',
        '',
    ].join('\n');
    assert.strictEqual(deriveNewTransitiveCount(patch), 2);
});

test('deriveNewTransitiveCount: excludes updated entries (has both + and -)', () => {
    const patch = [
        '-    "node_modules/eslint": {',
        '-      "version": "8.0.0"',
        '-    },',
        '+    "node_modules/eslint": {',
        '+      "version": "8.0.1"',
        '+    },',
        '+    "node_modules/new-dep": {',
        '+      "version": "1.0.0"',
        '+    },',
    ].join('\n');
    assert.strictEqual(deriveNewTransitiveCount(patch), 1);
});

test('deriveNewTransitiveCount: 0 for empty patch', () => {
    assert.strictEqual(deriveNewTransitiveCount(''), 0);
    assert.strictEqual(deriveNewTransitiveCount(null), 0);
});

test('deriveNewTransitiveCount: 0 when no new entries', () => {
    const patch = '-    "node_modules/old-dep": {';
    assert.strictEqual(deriveNewTransitiveCount(patch), 0);
});

test('deriveNewTransitiveCount: ignores +++ header line', () => {
    const patch = '+++ b/package-lock.json\n+    "node_modules/foo": {';
    assert.strictEqual(deriveNewTransitiveCount(patch), 1);
});

// --- buildEvaluationInput --------------------------------------------------

const SAMPLE_ENTRY = {
    repo: 'cli',
    number: 42,
    title: 'Bump eslint from 8.0.0 to 8.0.1',
    url: 'https://github.com/diplodoc-platform/cli/pull/42',
    dependency: 'eslint',
    fromVersion: '8.0.0',
    toVersion: '8.0.1',
    updateType: 'patch',
    risk: 'low',
    security: false,
    labels: ['dependencies', 'patch'],
};

const SAMPLE_PR_FILES = [
    {
        filename: 'package.json',
        patch: '+  "devDependencies": {\n+    "eslint": "8.0.1"\n-    "eslint": "8.0.0"',
    },
    {
        filename: 'package-lock.json',
        patch: '-    "node_modules/eslint": {\n-      "version": "8.0.0"\n+    "node_modules/eslint": {\n+      "version": "8.0.1"',
    },
];

test('buildEvaluationInput: builds correct input from entry + files', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    id: 1,
                    name: 'test',
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        requiredChecks: ['test'],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    assert.strictEqual(input.updateType, 'patch');
    assert.strictEqual(input.risk, 'low');
    assert.strictEqual(input.section, 'devDependencies');
    assert.strictEqual(input.hasException, false);
    assert.strictEqual(input.isGrouped, false);
    assert.strictEqual(input.isSecurity, false);
    assert.deepStrictEqual(input.changedFiles, ['package.json', 'package-lock.json']);
    assert.ok(input.checksGreen);
    assert.strictEqual(input.ciCompletedAt, '2026-08-22T10:00:00Z');
});

test('buildEvaluationInput: section from entry when no patch', () => {
    const input = buildEvaluationInput(
        {...SAMPLE_ENTRY, section: 'devDependencies'},
        SAMPLE_PR_FILES,
        {},
    );
    assert.strictEqual(input.section, 'devDependencies');
});

test('buildEvaluationInput: section null when no patch in files', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, [{filename: 'README.md'}], {});
    assert.strictEqual(input.section, null);
});

test('buildEvaluationInput: hasException true with matching registry entry', () => {
    const input = buildEvaluationInput(
        {...SAMPLE_ENTRY, dependency: 'svgo'},
        [{filename: 'package.json', patch: '+  "devDependencies": {'}],
        {scopedEntries: [{dependency: 'svgo', owner: '@team'}]},
    );
    assert.strictEqual(input.hasException, true);
});

test('buildEvaluationInput: newTransitiveDependencies from lock patch', () => {
    const lockPatch =
        '+    "node_modules/new-transitive-1": {\n+    "node_modules/new-transitive-2": {';
    const input = buildEvaluationInput(
        SAMPLE_ENTRY,
        [{filename: 'package-lock.json', patch: lockPatch}],
        {},
    );
    assert.strictEqual(input.newTransitiveDependencies, 2);
});

test('buildEvaluationInput: newTransitiveDependencies from explicit count', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, [{filename: 'package.json'}], {
        newTransitiveCount: 3,
    });
    assert.strictEqual(input.newTransitiveDependencies, 3);
});

test('buildEvaluationInput: newTransitiveDependencies 0 when no lock patch', () => {
    const input = buildEvaluationInput(SAMPLE_ENTRY, [{filename: 'package.json'}], {});
    assert.strictEqual(input.newTransitiveDependencies, 0);
});

// --- classifyPrForAutoMerge -----------------------------------------------

test('classifyPrForAutoMerge: returns entry + evaluation + input', () => {
    const result = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    id: 1,
                    name: 'test',
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        requiredChecks: ['test'],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    assert.ok(result.entry);
    assert.ok(result.evaluation);
    assert.ok(result.input);
    assert.strictEqual(result.evaluation.allowed, true);
    assert.strictEqual(result.evaluation.conditions.length, 9);
});

test('classifyPrForAutoMerge: excluded PR is not allowed', () => {
    const entry = {...SAMPLE_ENTRY, updateType: 'major', risk: 'high'};
    const result = classifyPrForAutoMerge(entry, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    name: 'test',
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        requiredChecks: ['test'],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    assert.strictEqual(result.evaluation.allowed, false);
    assert.strictEqual(result.evaluation.excluded, true);
});

// --- formatAuditEntry ------------------------------------------------------

test('formatAuditEntry: produces structured audit entry', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {
                    name: 'test',
                    status: 'completed',
                    conclusion: 'success',
                    completed_at: '2026-08-22T10:00:00Z',
                },
            ],
        },
        requiredChecks: ['test'],
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {merged: true}, '2026-08-24T10:00:00Z');
    assert.strictEqual(audit.repo, 'cli');
    assert.strictEqual(audit.number, 42);
    assert.strictEqual(audit.dependency, 'eslint');
    assert.strictEqual(audit.fromVersion, '8.0.0');
    assert.strictEqual(audit.toVersion, '8.0.1');
    assert.strictEqual(audit.allowed, true);
    assert.strictEqual(audit.merged, true);
    assert.strictEqual(audit.mergeError, null);
    assert.strictEqual(audit.timestamp, '2026-08-24T10:00:00Z');
    assert.deepStrictEqual(audit.exclusions, []);
});

test('formatAuditEntry: records blocked conditions', () => {
    const classification = classifyPrForAutoMerge(
        {...SAMPLE_ENTRY, updateType: 'minor'},
        SAMPLE_PR_FILES,
        {checkRuns: {check_runs: []}, scopedEntries: [], now: new Date('2026-08-24T10:00:00Z')},
    );
    const audit = formatAuditEntry(classification, {});
    assert.strictEqual(audit.allowed, false);
    assert.ok(audit.exclusions.includes('minor-update'));
    assert.ok(audit.blockingReasons.length > 0);
    assert.strictEqual(audit.merged, false);
});

test('formatAuditEntry: records merge error', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {status: 'completed', conclusion: 'success', completed_at: '2026-08-22T10:00:00Z'},
            ],
        },
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {merged: false, mergeError: 'Merge conflict'});
    assert.strictEqual(audit.merged, false);
    assert.strictEqual(audit.mergeError, 'Merge conflict');
});

test('formatAuditEntry: records skipped (dry-run)', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {status: 'completed', conclusion: 'success', completed_at: '2026-08-22T10:00:00Z'},
            ],
        },
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {skipped: 'dry-run'});
    assert.strictEqual(audit.merged, false);
    assert.strictEqual(audit.skipped, 'dry-run');
});

test('formatAuditEntry: default timestamp when omitted', () => {
    const classification = classifyPrForAutoMerge(SAMPLE_ENTRY, SAMPLE_PR_FILES, {
        checkRuns: {
            check_runs: [
                {status: 'completed', conclusion: 'success', completed_at: '2026-08-22T10:00:00Z'},
            ],
        },
        scopedEntries: [],
        now: new Date('2026-08-24T10:00:00Z'),
    });
    const audit = formatAuditEntry(classification, {});
    assert.ok(typeof audit.timestamp === 'string');
    assert.ok(audit.timestamp.length > 0);
});

// --- summarizeAudit --------------------------------------------------------

test('summarizeAudit: empty array', () => {
    const s = summarizeAudit([]);
    assert.strictEqual(s.totalEvaluated, 0);
    assert.strictEqual(s.allowed, 0);
    assert.strictEqual(s.merged, 0);
});

test('summarizeAudit: counts correctly', () => {
    const entries = [
        {allowed: true, excluded: false, merged: true, mergeError: null, skipped: null},
        {allowed: false, excluded: true, merged: false, mergeError: null, skipped: null},
        {allowed: true, excluded: false, merged: false, mergeError: null, skipped: 'dry-run'},
        {allowed: false, excluded: false, merged: false, mergeError: 'conflict', skipped: null},
    ];
    const s = summarizeAudit(entries);
    assert.strictEqual(s.totalEvaluated, 4);
    assert.strictEqual(s.allowed, 2);
    assert.strictEqual(s.excluded, 1);
    assert.strictEqual(s.merged, 1);
    assert.strictEqual(s.mergeErrors, 1);
    assert.strictEqual(s.skipped, 1);
});

test('summarizeAudit: non-array input', () => {
    const s = summarizeAudit(null);
    assert.strictEqual(s.totalEvaluated, 0);
});

// --- renderAuditLog --------------------------------------------------------

test('renderAuditLog: empty audit produces header', () => {
    const md = renderAuditLog([]);
    assert.ok(md.includes('# Auto-merge Audit Log'));
    assert.ok(md.includes('No Dependabot PRs found'));
});

test('renderAuditLog: includes summary table', () => {
    const entries = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump eslint',
            url: 'https://github.com/diplodoc-platform/cli/pull/42',
            dependency: 'eslint',
            fromVersion: '8.0.0',
            toVersion: '8.0.1',
            updateType: 'patch',
            risk: 'low',
            security: false,
            allowed: true,
            excluded: false,
            exclusions: [],
            failedConditions: [],
            blockingReasons: [],
            merged: true,
            mergeError: null,
            skipped: null,
            timestamp: '2026-08-24T10:00:00Z',
        },
    ];
    const md = renderAuditLog(entries);
    assert.ok(md.includes('Total evaluated'));
    assert.ok(md.includes('1'));
    assert.ok(md.includes('cli'));
    assert.ok(md.includes('eslint'));
    assert.ok(md.includes('Auto-merged PRs'));
    assert.ok(md.includes('Rollback'));
});

test('renderAuditLog: no merged section when zero merged', () => {
    const entries = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump eslint',
            url: '',
            dependency: 'eslint',
            fromVersion: '8.0.0',
            toVersion: '8.0.1',
            updateType: 'minor',
            risk: 'medium',
            security: false,
            allowed: false,
            excluded: true,
            exclusions: ['minor-update'],
            failedConditions: [],
            blockingReasons: ['Exclusion: Minor update'],
            merged: false,
            mergeError: null,
            skipped: null,
            timestamp: '2026-08-24T10:00:00Z',
        },
    ];
    const md = renderAuditLog(entries);
    assert.ok(!md.includes('## Auto-merged PRs'));
    assert.ok(md.includes('Exclusion: Minor update'));
});

test('renderAuditLog: escapes pipe characters in title', () => {
    const entries = [
        {
            repo: 'cli',
            number: 42,
            title: 'Bump foo|bar from 1 to 2',
            url: '',
            dependency: 'foo|bar',
            fromVersion: '1',
            toVersion: '2',
            updateType: 'patch',
            risk: 'low',
            security: false,
            allowed: true,
            excluded: false,
            exclusions: [],
            failedConditions: [],
            blockingReasons: [],
            merged: true,
            mergeError: null,
            skipped: null,
            timestamp: '2026-08-24T10:00:00Z',
        },
    ];
    const md = renderAuditLog(entries);
    assert.ok(md.includes('foo\\|bar'));
});

test('renderAuditLog: valid markdown starting with #', () => {
    const md = renderAuditLog([]);
    assert.ok(md.startsWith('# Auto-merge Audit Log'));
});

// --- parsePrUrl ------------------------------------------------------------

test('parsePrUrl: parses valid PR URL', () => {
    const result = parsePrUrl('https://github.com/diplodoc-platform/cli/pull/123');
    assert.deepStrictEqual(result, {owner: 'diplodoc-platform', repo: 'cli', number: 123});
});

test('parsePrUrl: returns null for invalid URL', () => {
    assert.strictEqual(parsePrUrl('https://example.com/foo'), null);
    assert.strictEqual(parsePrUrl('not a url'), null);
});

test('parsePrUrl: returns null for non-string', () => {
    assert.strictEqual(parsePrUrl(null), null);
    assert.strictEqual(parsePrUrl(undefined), null);
    assert.strictEqual(parsePrUrl(123), null);
});

test('parsePrUrl: handles issue URL (not pull)', () => {
    assert.strictEqual(parsePrUrl('https://github.com/diplodoc-platform/cli/issues/123'), null);
});

// --- extractRequiredCheckContexts -----------------------------------------

test('extractRequiredCheckContexts: combines legacy protection and active rulesets', () => {
    const protection = {
        contexts: ['lint'],
        checks: [{context: 'test'}, {context: 'lint'}],
    };
    const rules = [
        {
            type: 'required_status_checks',
            parameters: {
                required_status_checks: [{context: 'build'}, {context: 'test'}],
            },
        },
        {type: 'pull_request', parameters: {}},
    ];

    assert.deepStrictEqual(extractRequiredCheckContexts(protection, rules), [
        'lint',
        'test',
        'build',
    ]);
});

test('extractRequiredCheckContexts: reads organization rules without legacy protection', () => {
    const rules = [
        {
            type: 'required_status_checks',
            ruleset_source_type: 'Organization',
            parameters: {required_status_checks: [{context: 'ci / required'}]},
        },
    ];

    assert.deepStrictEqual(extractRequiredCheckContexts(null, rules), ['ci / required']);
});

test('extractRequiredCheckContexts: fails closed with malformed or absent responses', () => {
    assert.deepStrictEqual(extractRequiredCheckContexts(null, null), []);
    assert.deepStrictEqual(
        extractRequiredCheckContexts({contexts: [null, '']}, [{type: 'required_status_checks'}]),
        [],
    );
});

// --- Constants -------------------------------------------------------------

test('SOAK_WINDOW_MS: equals 24 hours', () => {
    assert.strictEqual(SOAK_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test('AUTO_MERGE_CONDITIONS: re-exported from auto-merge-rules', () => {
    assert.strictEqual(AUTO_MERGE_CONDITIONS.length, 9);
});

module.exports = {tests};
