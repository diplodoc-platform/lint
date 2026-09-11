const assert = require('node:assert');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, writeJson} = require('../helpers/file-utils');

const {
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
    AUTO_MERGE_PERMISSION,
} = require('../../scripts/dependency-policy-review');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- diffDirectDependencies ------------------------------------------------

test('diffDirectDependencies: detects added dependency', () => {
    const before = {dependencies: {lodash: '^4.17.0'}};
    const after = {dependencies: {lodash: '^4.17.0', svgo: '3.3.2'}};
    const changes = diffDirectDependencies(before, after);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].name, 'svgo');
    assert.strictEqual(changes[0].changeType, 'added');
    assert.strictEqual(changes[0].to, '3.3.2');
    assert.strictEqual(changes[0].from, null);
});

test('diffDirectDependencies: detects removed dependency', () => {
    const before = {dependencies: {lodash: '^4.17.0', svgo: '3.3.2'}};
    const after = {dependencies: {lodash: '^4.17.0'}};
    const changes = diffDirectDependencies(before, after);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].name, 'svgo');
    assert.strictEqual(changes[0].changeType, 'removed');
});

test('diffDirectDependencies: detects changed version', () => {
    const before = {dependencies: {lodash: '^4.17.0'}};
    const after = {dependencies: {lodash: '^4.17.21'}};
    const changes = diffDirectDependencies(before, after);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].name, 'lodash');
    assert.strictEqual(changes[0].changeType, 'changed');
    assert.strictEqual(changes[0].from, '^4.17.0');
    assert.strictEqual(changes[0].to, '^4.17.21');
});

test('diffDirectDependencies: detects changes across multiple sections', () => {
    const before = {
        dependencies: {svgo: '3.3.2'},
        devDependencies: {eslint: '8.57.0'},
    };
    const after = {
        dependencies: {svgo: '3.3.2', ajv: '^8.17.1'},
        devDependencies: {eslint: '^9.0.0'},
    };
    const changes = diffDirectDependencies(before, after);
    assert.strictEqual(changes.length, 2);
    const names = changes.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['ajv', 'eslint']);
});

test('diffDirectDependencies: no changes returns empty array', () => {
    const pkg = {dependencies: {lodash: '^4.17.0'}};
    assert.deepStrictEqual(diffDirectDependencies(pkg, pkg), []);
});

test('diffDirectDependencies: handles null/undefined input', () => {
    assert.deepStrictEqual(diffDirectDependencies(null, null), []);
    assert.deepStrictEqual(diffDirectDependencies(undefined, undefined), []);
});

// --- extractSemver ---------------------------------------------------------

test('extractSemver: parses bare version', () => {
    const v = extractSemver('3.3.2');
    assert.deepStrictEqual(v, {major: 3, minor: 3, patch: 2});
});

test('extractSemver: strips range operators', () => {
    assert.deepStrictEqual(extractSemver('^3.3.2'), {major: 3, minor: 3, patch: 2});
    assert.deepStrictEqual(extractSemver('~1.2.3'), {major: 1, minor: 2, patch: 3});
    assert.deepStrictEqual(extractSemver('>=2.0.0'), {major: 2, minor: 0, patch: 0});
});

test('extractSemver: strips pre-release suffix', () => {
    assert.deepStrictEqual(extractSemver('1.2.3-beta.1'), {major: 1, minor: 2, patch: 3});
});

test('extractSemver: handles two-part version', () => {
    assert.deepStrictEqual(extractSemver('8.17'), {major: 8, minor: 17, patch: 0});
});

test('extractSemver: returns null for invalid input', () => {
    assert.strictEqual(extractSemver(null), null);
    assert.strictEqual(extractSemver(''), null);
    assert.strictEqual(extractSemver('latest'), null);
});

// --- classifyVersionChange -------------------------------------------------

test('classifyVersionChange: major bump', () => {
    assert.strictEqual(classifyVersionChange('^1.0.0', '^2.0.0'), 'major');
});

test('classifyVersionChange: minor bump', () => {
    assert.strictEqual(classifyVersionChange('^1.0.0', '^1.1.0'), 'minor');
});

test('classifyVersionChange: patch bump', () => {
    assert.strictEqual(classifyVersionChange('^1.0.0', '^1.0.1'), 'patch');
});

test('classifyVersionChange: unknown for null versions', () => {
    assert.strictEqual(classifyVersionChange(null, '^1.0.0'), 'unknown');
    assert.strictEqual(classifyVersionChange('^1.0.0', null), 'unknown');
});

// --- extractLockPackages / lockKeyToName -----------------------------------

test('extractLockPackages: reads from packages (v3) format', () => {
    const lock = {
        packages: {
            '': {name: 'foo', version: '1.0.0'},
            'node_modules/lodash': {version: '4.17.21'},
            'node_modules/@scope/bar': {version: '1.0.0'},
        },
    };
    const result = extractLockPackages(lock);
    assert.strictEqual(result['node_modules/lodash'], '4.17.21');
    assert.strictEqual(result['node_modules/@scope/bar'], '1.0.0');
    assert.strictEqual(result[''], undefined);
});

test('extractLockPackages: falls back to dependencies (v1/v2) format', () => {
    const lock = {
        dependencies: {
            lodash: {version: '4.17.21'},
            ajv: {version: '8.17.1'},
        },
    };
    const result = extractLockPackages(lock);
    assert.strictEqual(result['lodash'], '4.17.21');
    assert.strictEqual(result['ajv'], '8.17.1');
});

test('extractLockPackages: returns empty for null/undefined', () => {
    assert.deepStrictEqual(extractLockPackages(null), {});
    assert.deepStrictEqual(extractLockPackages(undefined), {});
});

test('lockKeyToName: strips node_modules/ prefix', () => {
    assert.strictEqual(lockKeyToName('node_modules/lodash'), 'lodash');
    assert.strictEqual(lockKeyToName('node_modules/@scope/bar'), '@scope/bar');
    assert.strictEqual(lockKeyToName('lodash'), 'lodash');
});

// --- diffTransitiveDependencies --------------------------------------------

test('diffTransitiveDependencies: detects added transitive', () => {
    const beforeLock = {
        packages: {'': {version: '1.0.0'}, 'node_modules/lodash': {version: '4.17.21'}},
    };
    const afterLock = {
        packages: {
            '': {version: '1.0.0'},
            'node_modules/lodash': {version: '4.17.21'},
            'node_modules/new-dep': {version: '1.0.0'},
        },
    };
    const changes = diffTransitiveDependencies(beforeLock, afterLock, []);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].name, 'new-dep');
    assert.strictEqual(changes[0].changeType, 'added');
});

test('diffTransitiveDependencies: detects changed version', () => {
    const beforeLock = {packages: {'node_modules/lodash': {version: '4.17.0'}}};
    const afterLock = {packages: {'node_modules/lodash': {version: '4.17.21'}}};
    const changes = diffTransitiveDependencies(beforeLock, afterLock, []);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].changeType, 'changed');
    assert.strictEqual(changes[0].from, '4.17.0');
    assert.strictEqual(changes[0].to, '4.17.21');
});

test('diffTransitiveDependencies: excludes direct dependencies', () => {
    const beforeLock = {packages: {'node_modules/lodash': {version: '4.17.0'}}};
    const afterLock = {packages: {'node_modules/lodash': {version: '4.17.21'}}};
    const changes = diffTransitiveDependencies(beforeLock, afterLock, ['lodash']);
    assert.strictEqual(changes.length, 0);
});

test('diffTransitiveDependencies: excludes by package name (scoped)', () => {
    const beforeLock = {packages: {'node_modules/@scope/bar': {version: '1.0.0'}}};
    const afterLock = {packages: {'node_modules/@scope/bar': {version: '2.0.0'}}};
    const changes = diffTransitiveDependencies(beforeLock, afterLock, ['@scope/bar']);
    assert.strictEqual(changes.length, 0);
});

// --- lookupInRegistry ------------------------------------------------------

test('lookupInRegistry: finds entry by dependency name', () => {
    const entries = [
        {dependency: 'svgo', id: 'DEP-0001'},
        {dependency: 'ajv', id: 'DEP-0002'},
    ];
    const entry = lookupInRegistry(entries, {name: 'svgo', to: '3.3.2'});
    assert.ok(entry);
    assert.strictEqual(entry.id, 'DEP-0001');
});

test('lookupInRegistry: returns undefined for no match', () => {
    const entries = [{dependency: 'svgo', id: 'DEP-0001'}];
    assert.strictEqual(lookupInRegistry(entries, {name: 'lodash', to: '4.17.21'}), undefined);
});

test('lookupInRegistry: handles non-array entries', () => {
    assert.strictEqual(lookupInRegistry(null, {name: 'svgo', to: '3.3.2'}), undefined);
});

// --- riskForChange ---------------------------------------------------------

test('riskForChange: uses registry risk when available', () => {
    const entry = {risk: 'high'};
    assert.strictEqual(
        riskForChange(entry, {changeType: 'changed', from: '^3.3.2', to: '^3.3.3'}),
        'high',
    );
});

test('riskForChange: defaults based on update type for changed deps', () => {
    assert.strictEqual(
        riskForChange(undefined, {changeType: 'changed', from: '^1.0.0', to: '^1.0.1'}),
        'low',
    );
    assert.strictEqual(
        riskForChange(undefined, {changeType: 'changed', from: '^1.0.0', to: '^1.1.0'}),
        'medium',
    );
    assert.strictEqual(
        riskForChange(undefined, {changeType: 'changed', from: '^1.0.0', to: '^2.0.0'}),
        'high',
    );
});

test('riskForChange: defaults for added/removed', () => {
    assert.strictEqual(riskForChange(undefined, {changeType: 'added'}), 'medium');
    assert.strictEqual(riskForChange(undefined, {changeType: 'removed'}), 'low');
});

test('riskForChange: unknown change type defaults to medium', () => {
    assert.strictEqual(riskForChange(undefined, {changeType: 'unknown'}), 'medium');
});

// --- calculateMaxRisk ------------------------------------------------------

test('calculateMaxRisk: returns highest risk', () => {
    const assessed = [{risk: 'low'}, {risk: 'high'}, {risk: 'medium'}];
    assert.strictEqual(calculateMaxRisk(assessed), 'high');
});

test('calculateMaxRisk: critical is highest', () => {
    const assessed = [{risk: 'low'}, {risk: 'critical'}, {risk: 'high'}];
    assert.strictEqual(calculateMaxRisk(assessed), 'critical');
});

test('calculateMaxRisk: empty array returns low', () => {
    assert.strictEqual(calculateMaxRisk([]), 'low');
    assert.strictEqual(calculateMaxRisk(null), 'low');
});

// --- selectVerificationProfile --------------------------------------------

test('selectVerificationProfile: uses profile from highest-risk entry', () => {
    const assessed = [
        {risk: 'low', entry: {'verification-profile': 'standard'}},
        {risk: 'high', entry: {'verification-profile': 'deep'}},
    ];
    assert.strictEqual(selectVerificationProfile(assessed, 'high'), 'deep');
});

test('selectVerificationProfile: falls back to default by risk', () => {
    const assessed = [{risk: 'medium', entry: undefined}];
    assert.strictEqual(selectVerificationProfile(assessed, 'medium'), 'toolchain');
});

test('selectVerificationProfile: low risk default', () => {
    assert.strictEqual(selectVerificationProfile([], 'low'), 'standard');
});

test('selectVerificationProfile: critical risk default', () => {
    assert.strictEqual(selectVerificationProfile([], 'critical'), 'ecosystem');
});

// --- isIgnoredVersion ------------------------------------------------------

test('isIgnoredVersion: true when version in ignored-versions', () => {
    const entry = {'ignored-versions': ['3.3.3', '3.3.4']};
    assert.strictEqual(isIgnoredVersion(entry, '3.3.3'), true);
    assert.strictEqual(isIgnoredVersion(entry, '3.3.4'), true);
});

test('isIgnoredVersion: false when version not in list', () => {
    const entry = {'ignored-versions': ['3.3.3']};
    assert.strictEqual(isIgnoredVersion(entry, '3.3.2'), false);
});

test('isIgnoredVersion: false for no entry or no list', () => {
    assert.strictEqual(isIgnoredVersion(undefined, '3.3.3'), false);
    assert.strictEqual(isIgnoredVersion({}, '3.3.3'), false);
});

// --- buildAssessment -------------------------------------------------------

test('buildAssessment: assesses direct and transitive changes', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const transitive = [{name: 'css-tree', from: '2.3.0', to: '2.3.1', changeType: 'changed'}];
    const entries = [
        {
            id: 'DEP-0001',
            dependency: 'svgo',
            risk: 'high',
            'verification-profile': 'document-rendering',
            repositories: ['cli'],
        },
    ];
    const assessment = buildAssessment(direct, transitive, entries);
    assert.strictEqual(assessment.maxRisk, 'high');
    assert.strictEqual(assessment.verificationProfile, 'document-rendering');
    assert.strictEqual(assessment.summary.direct, 1);
    assert.strictEqual(assessment.summary.transitive, 1);
    assert.strictEqual(assessment.summary.inRegistry, 1);
});

test('buildAssessment: transitive not in registry uses default risk', () => {
    const direct = [];
    const transitive = [{name: 'lodash', from: '4.17.0', to: '4.17.21', changeType: 'changed'}];
    const assessment = buildAssessment(direct, transitive, []);
    assert.strictEqual(assessment.maxRisk, 'low');
    assert.strictEqual(assessment.summary.inRegistry, 0);
});

test('buildAssessment: empty changes returns low risk', () => {
    const assessment = buildAssessment([], [], []);
    assert.strictEqual(assessment.maxRisk, 'low');
    assert.strictEqual(assessment.summary.total, 0);
});

test('buildAssessment: marks ignored versions', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', risk: 'high', 'ignored-versions': ['3.3.3']},
    ];
    const assessment = buildAssessment(direct, [], entries);
    assert.strictEqual(assessment.summary.ignored, 1);
    assert.strictEqual(assessment.direct[0].ignored, true);
});

// --- collectExceptions -----------------------------------------------------

test('collectExceptions: collects unique registry entries with ids', () => {
    const assessed = [
        {
            inRegistry: true,
            entry: {
                id: 'DEP-0001',
                dependency: 'svgo',
                reason: 'breaks svg',
                category: 'output-regression',
                'verification-profile': 'document-rendering',
                owner: 'team',
                evidence: {'upstream-issue': 'https://example.com'},
            },
            change: {name: 'svgo'},
            ignored: false,
        },
        {inRegistry: false, entry: undefined, change: {name: 'lodash'}, ignored: false},
        {
            inRegistry: true,
            entry: {id: 'DEP-0001', dependency: 'svgo'},
            change: {name: 'svgo'},
            ignored: false,
        },
    ];
    const exceptions = collectExceptions(assessed);
    assert.strictEqual(exceptions.length, 1);
    assert.strictEqual(exceptions[0].id, 'DEP-0001');
    assert.strictEqual(exceptions[0].dependency, 'svgo');
    assert.strictEqual(exceptions[0].reason, 'breaks svg');
    assert.strictEqual(
        exceptions[0].affectedOutput,
        'rendered output (visual / structural regression)',
    );
    assert.strictEqual(exceptions[0].verificationProfile, 'document-rendering');
    assert.strictEqual(exceptions[0].owner, 'team');
});

test('collectExceptions: empty array when no registry entries', () => {
    const assessed = [
        {inRegistry: false, entry: undefined, change: {name: 'lodash'}, ignored: false},
    ];
    assert.deepStrictEqual(collectExceptions(assessed), []);
});

test('collectExceptions: handles empty input', () => {
    assert.deepStrictEqual(collectExceptions([]), []);
    assert.deepStrictEqual(collectExceptions(null), []);
});

// --- deriveAffectedOutput --------------------------------------------------

test('deriveAffectedOutput: maps known categories', () => {
    assert.strictEqual(
        deriveAffectedOutput({category: 'output-regression'}),
        'rendered output (visual / structural regression)',
    );
    assert.strictEqual(
        deriveAffectedOutput({category: 'security'}),
        'security-sensitive runtime behavior',
    );
});

test('deriveAffectedOutput: falls back to raw category for unknown', () => {
    assert.strictEqual(deriveAffectedOutput({category: 'custom-thing'}), 'custom-thing');
});

test('deriveAffectedOutput: falls back to reason when no category', () => {
    assert.strictEqual(deriveAffectedOutput({reason: 'some reason'}), 'some reason');
});

test('deriveAffectedOutput: returns dash for empty entry', () => {
    assert.strictEqual(deriveAffectedOutput(null), '—');
    assert.strictEqual(deriveAffectedOutput({}), '—');
});

// --- buildAssessment with exceptions & auto-merge --------------------------

test('buildAssessment: includes exceptions and auto-merge permission', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {
            id: 'DEP-0001',
            dependency: 'svgo',
            risk: 'high',
            reason: 'Newer versions break SVG',
            category: 'output-regression',
            'verification-profile': 'document-rendering',
            owner: 'diplodoc-platform/team',
            evidence: {'upstream-issue': 'https://github.com/svg/svgo/issues/2218'},
            repositories: ['cli'],
        },
    ];
    const assessment = buildAssessment(direct, [], entries);
    assert.strictEqual(assessment.maxRisk, 'high');
    assert.ok(assessment.autoMergePermission);
    assert.strictEqual(assessment.autoMergePermission, AUTO_MERGE_PERMISSION.high);
    assert.ok(assessment.exceptions);
    assert.strictEqual(assessment.exceptions.length, 1);
    assert.strictEqual(assessment.exceptions[0].id, 'DEP-0001');
    assert.strictEqual(assessment.exceptions[0].dependency, 'svgo');
    assert.strictEqual(assessment.exceptions[0].reason, 'Newer versions break SVG');
    assert.strictEqual(assessment.exceptions[0].verificationProfile, 'document-rendering');
    assert.strictEqual(assessment.summary.exceptions, 1);
});

test('buildAssessment: auto-merge permission varies by risk', () => {
    const lowAssessment = buildAssessment([], [], []);
    assert.strictEqual(lowAssessment.autoMergePermission, AUTO_MERGE_PERMISSION.low);

    const mediumDirect = [
        {
            name: 'vitest',
            section: 'devDependencies',
            from: '^1.0.0',
            to: '^1.1.0',
            changeType: 'changed',
        },
    ];
    const mediumAssessment = buildAssessment(mediumDirect, [], []);
    assert.strictEqual(mediumAssessment.autoMergePermission, AUTO_MERGE_PERMISSION.medium);
});

// --- extractCompatibilityScore ---------------------------------------------

test('extractCompatibilityScore: finds score in Dependabot check title', () => {
    const response = {
        check_runs: [{name: 'Dependabot', output: {title: '90% compatible', summary: ''}}],
    };
    assert.strictEqual(extractCompatibilityScore(response), 90);
});

test('extractCompatibilityScore: finds score in summary', () => {
    const response = {
        check_runs: [
            {name: 'Dependabot Compatibility Score', output: {title: '', summary: 'Score: 75%'}},
        ],
    };
    assert.strictEqual(extractCompatibilityScore(response), 75);
});

test('extractCompatibilityScore: returns null for no Dependabot check', () => {
    const response = {
        check_runs: [
            {name: 'CI', output: {title: 'passed', summary: ''}},
            {name: 'test', output: {title: '100%', summary: ''}},
        ],
    };
    assert.strictEqual(extractCompatibilityScore(response), null);
});

test('extractCompatibilityScore: returns null for empty/invalid response', () => {
    assert.strictEqual(extractCompatibilityScore(null), null);
    assert.strictEqual(extractCompatibilityScore({}), null);
    assert.strictEqual(extractCompatibilityScore({check_runs: []}), null);
});

test('extractCompatibilityScore: returns null when no percentage in text', () => {
    const response = {
        check_runs: [{name: 'Dependabot', output: {title: 'Checking...', summary: 'No score yet'}}],
    };
    assert.strictEqual(extractCompatibilityScore(response), null);
});

// --- renderComment with new sections ---------------------------------------

test('renderComment: includes auto-merge permission', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Auto-merge'));
    assert.ok(comment.includes(AUTO_MERGE_PERMISSION.low));
});

test('renderComment: includes auto-merge permission for high risk', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', risk: 'high', 'verification-profile': 'deep'},
    ];
    const assessment = buildAssessment(direct, [], entries);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Auto-merge'));
    assert.ok(comment.includes(AUTO_MERGE_PERMISSION.high));
});

test('renderComment: includes known exceptions section', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {
            id: 'DEP-0001',
            dependency: 'svgo',
            risk: 'high',
            reason: 'Newer versions break large SVG diagrams',
            category: 'output-regression',
            'verification-profile': 'document-rendering',
            owner: 'diplodoc-platform/team',
            evidence: {'upstream-issue': 'https://github.com/svg/svgo/issues/2218'},
        },
    ];
    const assessment = buildAssessment(direct, [], entries);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Known Exceptions'));
    assert.ok(comment.includes('DEP-0001'));
    assert.ok(comment.includes('svgo'));
    assert.ok(comment.includes('Newer versions break large SVG diagrams'));
    assert.ok(comment.includes('rendered output (visual / structural regression)'));
    assert.ok(comment.includes('document-rendering'));
    assert.ok(comment.includes('diplodoc-platform/team'));
    assert.ok(comment.includes('upstream-issue'));
});

test('renderComment: no exceptions section when no registry entries', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment);
    assert.ok(!comment.includes('Known Exceptions'));
});

test('renderComment: includes compatibility score when provided', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment, {compatibilityScore: 95});
    assert.ok(comment.includes('Compatibility Score'));
    assert.ok(comment.includes('95%'));
    assert.ok(comment.includes('signal only'));
});

test('renderComment: omits compatibility score when not provided', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment);
    assert.ok(!comment.includes('Compatibility Score'));
});

test('renderComment: compatibility score with null is omitted', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment, {compatibilityScore: null});
    assert.ok(!comment.includes('Compatibility Score'));
});

test('renderComment: compatibility score emoji varies by score', () => {
    const assessment = buildAssessment([], [], []);
    const high = renderComment(assessment, {compatibilityScore: 95});
    assert.ok(high.includes('🟢'));

    const med = renderComment(assessment, {compatibilityScore: 60});
    assert.ok(med.includes('🟡'));

    const low = renderComment(assessment, {compatibilityScore: 20});
    assert.ok(low.includes('🔴'));
});

test('renderComment: includes Known exceptions count in summary', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [{id: 'DEP-0001', dependency: 'svgo', risk: 'high'}];
    const assessment = buildAssessment(direct, [], entries);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Known exceptions'));
    assert.ok(comment.includes('1'));
});

test('renderComment: evidence links rendered as markdown', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {
            id: 'DEP-0001',
            dependency: 'svgo',
            risk: 'high',
            evidence: {
                'upstream-issue': 'https://github.com/svg/svgo/issues/2218',
                'upstream-pr': 'https://github.com/svg/svgo/pull/2220',
            },
        },
    ];
    const assessment = buildAssessment(direct, [], entries);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('[upstream-issue](https://github.com/svg/svgo/issues/2218)'));
    assert.ok(comment.includes('[upstream-pr](https://github.com/svg/svgo/pull/2220)'));
});

test('renderComment: ignored exception noted', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', risk: 'high', 'ignored-versions': ['3.3.3']},
    ];
    const assessment = buildAssessment(direct, [], entries);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('ignored version'));
});

// --- renderComment ---------------------------------------------------------

test('renderComment: includes max risk and profile', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Dependency Policy Risk Assessment'));
    assert.ok(comment.includes('Max Risk'));
    assert.ok(comment.includes('Verification Profile'));
});

test('renderComment: includes direct changes table', () => {
    const direct = [
        {name: 'svgo', section: 'dependencies', from: '3.3.2', to: '3.3.3', changeType: 'changed'},
    ];
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', risk: 'high', 'verification-profile': 'deep'},
    ];
    const assessment = buildAssessment(direct, [], entries);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Direct Changes'));
    assert.ok(comment.includes('svgo'));
    assert.ok(comment.includes('DEP-0001'));
});

test('renderComment: includes transitive changes table', () => {
    const transitive = [{name: 'lodash', from: '4.17.0', to: '4.17.21', changeType: 'changed'}];
    const assessment = buildAssessment([], transitive, []);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('Transitive Changes'));
    assert.ok(comment.includes('lodash'));
});

test('renderComment: shows no changes message when empty', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('No dependency changes detected'));
});

// --- CLI integration -------------------------------------------------------

const SCRIPT = join(__dirname, '../../scripts/dependency-policy-review.js');
const REAL_REGISTRY = join(__dirname, '../../dependency-policy.yml');

test('CLI: produces assessment for changed package.json', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.2'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.3'},
        });
        const output = execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" --repo cli`,
            {encoding: 'utf8', stdio: 'pipe', env: {...process.env}},
        );
        assert.ok(output.includes('Dependency Policy Risk Assessment'));
        assert.ok(output.includes('svgo'));
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: writes comment to file with --comment flag', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {ajv: '^8.17.1'},
        });
        const commentPath = join(tempDir, 'comment.md');
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" ` +
                `--comment "${commentPath}" --quiet --repo cli`,
            {stdio: 'pipe', env: {...process.env}},
        );
        const content = readFile(tempDir, 'comment.md');
        assert.ok(content.includes('Dependency Policy Risk Assessment'));
        assert.ok(content.includes('ajv'));
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: writes machine-readable dependency decision with --json flag', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/tabs-extension',
            version: '1.0.0',
            dependencies: {svgo: '3.3.2'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/tabs-extension',
            version: '1.0.0',
            dependencies: {svgo: '3.3.3'},
        });
        const jsonPath = join(tempDir, 'assessment.json');
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" ` +
                `--json "${jsonPath}" --quiet --repo tabs-extension ` +
                `--head-sha 0123456789012345678901234567890123456789`,
            {stdio: 'pipe', env: {...process.env}},
        );
        const assessment = JSON.parse(readFile(tempDir, 'assessment.json'));
        assert.strictEqual(assessment.repository, 'tabs-extension');
        assert.strictEqual(assessment.headSha, '0123456789012345678901234567890123456789');
        assert.strictEqual(assessment.hasDependencyChanges, true);
        assert.strictEqual(assessment.maxRisk, 'high');
        assert.strictEqual(assessment.verificationProfile, 'document-transform');
        assert.strictEqual(assessment.summary.total, 1);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: machine-readable decision distinguishes manifest edits from dependency changes', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/tabs-extension',
            version: '1.0.0',
            scripts: {test: 'node test.js'},
            dependencies: {lodash: '^4.17.21'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/tabs-extension',
            version: '1.0.0',
            scripts: {test: 'node test.mjs'},
            dependencies: {lodash: '^4.17.21'},
        });
        const jsonPath = join(tempDir, 'assessment.json');
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" ` +
                `--json "${jsonPath}" --quiet --repo tabs-extension`,
            {stdio: 'pipe', env: {...process.env}},
        );
        const assessment = JSON.parse(readFile(tempDir, 'assessment.json'));
        assert.strictEqual(assessment.hasDependencyChanges, false);
        assert.strictEqual(assessment.verificationProfile, 'standard');
        assert.strictEqual(assessment.summary.total, 0);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: detects transitive changes from lockfile', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {lodash: '^4.17.0'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {lodash: '^4.17.0'},
        });
        writeJson(tempDir, 'before-lock.json', {
            name: 'cli',
            lockfileVersion: 3,
            packages: {
                '': {name: 'cli', version: '1.0.0'},
                'node_modules/lodash': {version: '4.17.0'},
                'node_modules/css-tree': {version: '2.3.0'},
            },
        });
        writeJson(tempDir, 'after-lock.json', {
            name: 'cli',
            lockfileVersion: 3,
            packages: {
                '': {name: 'cli', version: '1.0.0'},
                'node_modules/lodash': {version: '4.17.0'},
                'node_modules/css-tree': {version: '2.3.1'},
            },
        });
        const output = execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" ` +
                `--before-lock "${join(tempDir, 'before-lock.json')}" ` +
                `--after-lock "${join(tempDir, 'after-lock.json')}" --repo cli`,
            {encoding: 'utf8', stdio: 'pipe', env: {...process.env}},
        );
        assert.ok(output.includes('Transitive Changes'));
        assert.ok(output.includes('css-tree'));
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when missing required flags', async () => {
    let failed = false;
    try {
        execSync(`node "${SCRIPT}"`, {stdio: 'pipe', env: {...process.env}});
    } catch {
        failed = true;
    }
    assert.ok(failed);
});

test('CLI: derives repo name from after package.json', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.2'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.2'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" --quiet`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: includes compatibility score with --compatibility-score flag', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.2'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.3'},
        });
        const output = execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" ` +
                `--compatibility-score 85 --repo cli`,
            {encoding: 'utf8', stdio: 'pipe', env: {...process.env}},
        );
        assert.ok(output.includes('Compatibility Score'));
        assert.ok(output.includes('85%'));
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: includes auto-merge and exceptions in output', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'before.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.2'},
        });
        writeJson(tempDir, 'after.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {svgo: '3.3.3'},
        });
        const output = execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" ` +
                `--before-pkg "${join(tempDir, 'before.json')}" ` +
                `--after-pkg "${join(tempDir, 'after.json')}" --repo cli`,
            {encoding: 'utf8', stdio: 'pipe', env: {...process.env}},
        );
        assert.ok(output.includes('Auto-merge'));
        assert.ok(output.includes('Known Exceptions'));
        assert.ok(output.includes('DEP-0001'));
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
