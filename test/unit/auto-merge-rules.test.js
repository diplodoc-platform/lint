const assert = require('node:assert');
const {
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
} = require('../../scripts/auto-merge-rules');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- AUTO_MERGE_CONDITIONS --------------------------------------------------

test('AUTO_MERGE_CONDITIONS: defines exactly 9 conditions', () => {
    assert.strictEqual(AUTO_MERGE_CONDITIONS.length, 9);
});

test('AUTO_MERGE_CONDITIONS: each condition has id/name/description', () => {
    for (const cond of AUTO_MERGE_CONDITIONS) {
        assert.ok(typeof cond.id === 'string' && cond.id.length > 0);
        assert.ok(typeof cond.name === 'string' && cond.name.length > 0);
        assert.ok(typeof cond.description === 'string' && cond.description.length > 0);
    }
});

test('AUTO_MERGE_CONDITIONS: ids are unique', () => {
    const ids = AUTO_MERGE_CONDITIONS.map((c) => c.id);
    assert.strictEqual(ids.length, new Set(ids).size);
});

test('AUTO_MERGE_CONDITIONS: ids match the documented 9 conditions', () => {
    const expected = [
        'patch-update',
        'risk-low',
        'dev-dependency',
        'no-exception',
        'no-new-transitive',
        'checks-green',
        'no-snapshots',
        'manifest-lockfile-only',
        'ci-24h-soak',
    ];
    assert.deepStrictEqual(
        AUTO_MERGE_CONDITIONS.map((c) => c.id),
        expected,
    );
});

// --- EXCLUSION_LIST --------------------------------------------------------

test('EXCLUSION_LIST: covers the documented exclusion categories', () => {
    const ids = EXCLUSION_LIST.map((e) => e.id);
    assert.ok(ids.includes('production-dep'));
    assert.ok(ids.includes('minor-update'));
    assert.ok(ids.includes('major-update'));
    assert.ok(ids.includes('grouped-pr'));
    assert.ok(ids.includes('security-sensitive'));
    assert.ok(ids.includes('high-risk'));
});

test('EXCLUSION_LIST: each entry has id/name/description/matches', () => {
    for (const ex of EXCLUSION_LIST) {
        assert.ok(typeof ex.id === 'string');
        assert.ok(typeof ex.name === 'string');
        assert.ok(typeof ex.description === 'string');
        assert.strictEqual(typeof ex.matches, 'function');
    }
});

test('EXCLUSION_LIST: ids are unique', () => {
    const ids = EXCLUSION_LIST.map((e) => e.id);
    assert.strictEqual(ids.length, new Set(ids).size);
});

// --- isProductionSection ---------------------------------------------------

test('isProductionSection: devDependencies is NOT production', () => {
    assert.strictEqual(isProductionSection('devDependencies'), false);
});

test('isProductionSection: dependencies is production', () => {
    assert.strictEqual(isProductionSection('dependencies'), true);
});

test('isProductionSection: peerDependencies is production', () => {
    assert.strictEqual(isProductionSection('peerDependencies'), true);
});

test('isProductionSection: optionalDependencies is production', () => {
    assert.strictEqual(isProductionSection('optionalDependencies'), true);
});

test('isProductionSection: undefined is production (conservative)', () => {
    assert.strictEqual(isProductionSection(undefined), true);
});

// --- snapshotGlobToRegExp / isSnapshotFile ---------------------------------

test('snapshotGlobToRegExp: ** spans path separators', () => {
    const re = snapshotGlobToRegExp('**/__snapshots__/**');
    assert.ok(re.test('src/__snapshots__/foo.test.ts.snap'));
    assert.ok(re.test('packages/cli/__snapshots__/bar.snap'));
    assert.ok(!re.test('src/foo.ts'));
});

test('snapshotGlobToRegExp: single * does not span separator', () => {
    const re = snapshotGlobToRegExp('**/*.snap');
    assert.ok(re.test('tests/foo.snap'));
    assert.ok(re.test('a/b/c/foo.snap'));
    assert.ok(!re.test('tests/foo.txt'));
});

test('isSnapshotFile: detects __snapshots__ path', () => {
    assert.ok(isSnapshotFile('src/__snapshots__/foo.test.ts.snap'));
});

test('isSnapshotFile: detects *.snap extension', () => {
    assert.ok(isSnapshotFile('tests/foo.snap'));
    assert.ok(isSnapshotFile('tests/foo.snap.cjs'));
});

test('isSnapshotFile: ignores non-snapshot files', () => {
    assert.ok(!isSnapshotFile('package.json'));
    assert.ok(!isSnapshotFile('src/foo.ts'));
    assert.ok(!isSnapshotFile('tests/foo.test.ts'));
});

test('isSnapshotFile: empty/invalid input returns false', () => {
    assert.ok(!isSnapshotFile(''));
    assert.ok(!isSnapshotFile(null));
    assert.ok(!isSnapshotFile(undefined));
});

// --- isManifestLockfileOnly ------------------------------------------------

test('isManifestLockfileOnly: package.json alone is allowed', () => {
    assert.ok(isManifestLockfileOnly(['package.json']));
});

test('isManifestLockfileOnly: package.json + package-lock.json is allowed', () => {
    assert.ok(isManifestLockfileOnly(['package.json', 'package-lock.json']));
});

test('isManifestLockfileOnly: npm-shrinkwrap.json is allowed', () => {
    assert.ok(isManifestLockfileOnly(['package.json', 'npm-shrinkwrap.json']));
});

test('isManifestLockfileOnly: source file blocks the condition', () => {
    assert.ok(!isManifestLockfileOnly(['package.json', 'src/foo.ts']));
});

test('isManifestLockfileOnly: workflow file blocks the condition', () => {
    assert.ok(!isManifestLockfileOnly(['package.json', '.github/workflows/ci.yml']));
});

test('isManifestLockfileOnly: empty array fails (no manifest touched)', () => {
    assert.ok(!isManifestLockfileOnly([]));
});

test('isManifestLockfileOnly: non-array fails', () => {
    assert.ok(!isManifestLockfileOnly(null));
    assert.ok(!isManifestLockfileOnly(undefined));
});

// --- changesSnapshots ------------------------------------------------------

test('changesSnapshots: returns true when any file is a snapshot', () => {
    assert.ok(changesSnapshots(['package.json', 'tests/foo.snap']));
});

test('changesSnapshots: returns false for manifest-only', () => {
    assert.ok(!changesSnapshots(['package.json', 'package-lock.json']));
});

test('changesSnapshots: handles non-array', () => {
    assert.ok(!changesSnapshots(null));
    assert.ok(!changesSnapshots(undefined));
});

// --- elapsedMs / meetsSoakWindow ------------------------------------------

test('elapsedMs: Date instances', () => {
    const ci = new Date('2026-08-23T10:00:00Z');
    const now = new Date('2026-08-24T10:00:00Z');
    assert.strictEqual(elapsedMs(ci, now), 24 * 60 * 60 * 1000);
});

test('elapsedMs: ISO strings', () => {
    const elapsed = elapsedMs('2026-08-23T10:00:00Z', '2026-08-23T11:00:00Z');
    assert.strictEqual(elapsed, 60 * 60 * 1000);
});

test('elapsedMs: millisecond numbers', () => {
    assert.strictEqual(elapsedMs(1000, 2000), 1000);
});

test('elapsedMs: null when inputs invalid', () => {
    assert.strictEqual(elapsedMs('not-a-date', '2026-08-23T10:00:00Z'), null);
    assert.strictEqual(elapsedMs(undefined, undefined), null);
    assert.strictEqual(elapsedMs(NaN, 1000), null);
});

test('meetsSoakWindow: true after 24h', () => {
    const ci = new Date('2026-08-23T10:00:00Z');
    const now = new Date('2026-08-24T10:00:00Z');
    assert.ok(meetsSoakWindow({ciCompletedAt: ci, now}));
});

test('meetsSoakWindow: false before 24h', () => {
    const ci = new Date('2026-08-23T10:00:00Z');
    const now = new Date('2026-08-24T09:59:59Z');
    assert.ok(!meetsSoakWindow({ciCompletedAt: ci, now}));
});

test('meetsSoakWindow: false when ciCompletedAt missing', () => {
    assert.ok(!meetsSoakWindow({now: Date.now()}));
});

test('meetsSoakWindow: uses Date.now() when now is omitted', () => {
    // CI completed 25h ago relative to now → meets
    const ci = new Date(Date.now() - 25 * 60 * 60 * 1000);
    assert.ok(meetsSoakWindow({ciCompletedAt: ci}));
    // CI completed 1h ago → does not meet
    const ci2 = new Date(Date.now() - 60 * 60 * 1000);
    assert.ok(!meetsSoakWindow({ciCompletedAt: ci2}));
});

// --- newTransitiveCount ---------------------------------------------------

test('newTransitiveCount: array length', () => {
    assert.strictEqual(newTransitiveCount(['a', 'b']), 2);
    assert.strictEqual(newTransitiveCount([]), 0);
});

test('newTransitiveCount: number', () => {
    assert.strictEqual(newTransitiveCount(3), 3);
    assert.strictEqual(newTransitiveCount(0), 0);
});

test('newTransitiveCount: boolean', () => {
    assert.strictEqual(newTransitiveCount(true), 1);
    assert.strictEqual(newTransitiveCount(false), 0);
});

test('newTransitiveCount: other types resolve to 0', () => {
    assert.strictEqual(newTransitiveCount(null), 0);
    assert.strictEqual(newTransitiveCount(undefined), 0);
    assert.strictEqual(newTransitiveCount('foo'), 0);
});

// --- checkCondition --------------------------------------------------------

test('checkCondition: patch-update passes only for patch', () => {
    assert.ok(checkCondition('patch-update', {updateType: 'patch'}));
    assert.ok(!checkCondition('patch-update', {updateType: 'minor'}));
    assert.ok(!checkCondition('patch-update', {updateType: 'major'}));
});

test('checkCondition: risk-low passes only for low', () => {
    assert.ok(checkCondition('risk-low', {risk: 'low'}));
    assert.ok(!checkCondition('risk-low', {risk: 'medium'}));
    assert.ok(!checkCondition('risk-low', {risk: 'high'}));
});

test('checkCondition: dev-dependency passes only for devDependencies', () => {
    assert.ok(checkCondition('dev-dependency', {section: 'devDependencies'}));
    assert.ok(!checkCondition('dev-dependency', {section: 'dependencies'}));
    assert.ok(!checkCondition('dev-dependency', {section: 'peerDependencies'}));
});

test('checkCondition: no-exception passes when hasException is falsy', () => {
    assert.ok(checkCondition('no-exception', {}));
    assert.ok(checkCondition('no-exception', {hasException: false}));
    assert.ok(!checkCondition('no-exception', {hasException: true}));
});

test('checkCondition: no-new-transitive via array/number/boolean', () => {
    assert.ok(checkCondition('no-new-transitive', {newTransitiveDependencies: []}));
    assert.ok(checkCondition('no-new-transitive', {newTransitiveDependencies: 0}));
    assert.ok(checkCondition('no-new-transitive', {newTransitiveDependencies: false}));
    assert.ok(!checkCondition('no-new-transitive', {newTransitiveDependencies: ['x']}));
    assert.ok(!checkCondition('no-new-transitive', {newTransitiveDependencies: 1}));
    assert.ok(!checkCondition('no-new-transitive', {newTransitiveDependencies: true}));
});

test('checkCondition: checks-green requires true', () => {
    assert.ok(checkCondition('checks-green', {checksGreen: true}));
    assert.ok(!checkCondition('checks-green', {checksGreen: false}));
    assert.ok(!checkCondition('checks-green', {}));
});

test('checkCondition: no-snapshots via changedFiles', () => {
    assert.ok(checkCondition('no-snapshots', {changedFiles: ['package.json']}));
    assert.ok(!checkCondition('no-snapshots', {changedFiles: ['package.json', 'tests/foo.snap']}));
});

test('checkCondition: no-snapshots via explicit changesSnapshots=true override', () => {
    assert.ok(
        !checkCondition('no-snapshots', {changedFiles: ['package.json'], changesSnapshots: true}),
    );
    assert.ok(
        checkCondition('no-snapshots', {changedFiles: ['package.json'], changesSnapshots: false}),
    );
});

test('checkCondition: manifest-lockfile-only via changedFiles', () => {
    assert.ok(
        checkCondition('manifest-lockfile-only', {
            changedFiles: ['package.json', 'package-lock.json'],
        }),
    );
    assert.ok(
        !checkCondition('manifest-lockfile-only', {changedFiles: ['package.json', 'src/foo.ts']}),
    );
    assert.ok(!checkCondition('manifest-lockfile-only', {changedFiles: []}));
});

test('checkCondition: ci-24h-soak passes after 24h', () => {
    const ci = new Date('2026-08-23T10:00:00Z');
    const now = new Date('2026-08-24T10:00:00Z');
    assert.ok(checkCondition('ci-24h-soak', {ciCompletedAt: ci, now}));
});

test('checkCondition: ci-24h-soak fails before 24h', () => {
    const ci = new Date('2026-08-23T10:00:00Z');
    const now = new Date('2026-08-23T11:00:00Z');
    assert.ok(!checkCondition('ci-24h-soak', {ciCompletedAt: ci, now}));
});

test('checkCondition: unknown id returns false', () => {
    assert.ok(!checkCondition('does-not-exist', {}));
});

// --- evaluateAutoMerge — positive case -----------------------------------

const PASSING_INPUT = {
    updateType: 'patch',
    risk: 'low',
    section: 'devDependencies',
    hasException: false,
    newTransitiveDependencies: [],
    checksGreen: true,
    changedFiles: ['package.json', 'package-lock.json'],
    ciCompletedAt: new Date('2026-08-22T10:00:00Z'),
    now: new Date('2026-08-24T10:00:00Z'), // 48h later
    isGrouped: false,
    isSecurity: false,
};

test('evaluateAutoMerge: all conditions pass + no exclusion → allowed', () => {
    const result = evaluateAutoMerge(PASSING_INPUT);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.excluded, false);
    assert.strictEqual(result.exclusions.length, 0);
    assert.strictEqual(result.conditions.length, 9);
    assert.strictEqual(
        result.conditions.every((c) => c.passed),
        true,
    );
    assert.strictEqual(result.blockingReasons.length, 0);
});

// --- evaluateAutoMerge — exclusion cases ----------------------------------

test('evaluateAutoMerge: production dependency excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, section: 'dependencies'});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.excluded, true);
    assert.ok(result.exclusions.some((e) => e.id === 'production-dep'));
});

test('evaluateAutoMerge: minor update excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, updateType: 'minor'});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.excluded, true);
    assert.ok(result.exclusions.some((e) => e.id === 'minor-update'));
});

test('evaluateAutoMerge: major update excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, updateType: 'major'});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.exclusions.some((e) => e.id === 'major-update'));
});

test('evaluateAutoMerge: grouped PR excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, isGrouped: true});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.exclusions.some((e) => e.id === 'grouped-pr'));
});

test('evaluateAutoMerge: security PR excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, isSecurity: true});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.exclusions.some((e) => e.id === 'security-sensitive'));
});

test('evaluateAutoMerge: high-risk dep excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, risk: 'high'});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.exclusions.some((e) => e.id === 'high-risk'));
});

test('evaluateAutoMerge: medium-risk dep excluded', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, risk: 'medium'});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.exclusions.some((e) => e.id === 'high-risk'));
});

test('evaluateAutoMerge: multiple exclusions recorded', () => {
    const result = evaluateAutoMerge({
        ...PASSING_INPUT,
        section: 'dependencies',
        updateType: 'major',
        isSecurity: true,
    });
    assert.strictEqual(result.allowed, false);
    const ids = result.exclusions.map((e) => e.id);
    assert.ok(ids.includes('production-dep'));
    assert.ok(ids.includes('major-update'));
    assert.ok(ids.includes('security-sensitive'));
});

// --- evaluateAutoMerge — condition failure cases (no exclusion) ----------

test('evaluateAutoMerge: exception present fails no-exception condition', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, hasException: true});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.excluded, false);
    assert.ok(result.blockingReasons.some((r) => r.includes('No exception exists')));
});

test('evaluateAutoMerge: new transitive dep fails no-new-transitive', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, newTransitiveDependencies: ['some-pkg']});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.blockingReasons.some((r) => r.includes('No new runtime/transitive')));
});

test('evaluateAutoMerge: red checks fail checks-green', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, checksGreen: false});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.blockingReasons.some((r) => r.includes('All required checks green')));
});

test('evaluateAutoMerge: snapshot change fails no-snapshots', () => {
    const result = evaluateAutoMerge({
        ...PASSING_INPUT,
        changedFiles: ['package.json', 'package-lock.json', 'tests/foo.test.ts.snap'],
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.blockingReasons.some((r) => r.includes("doesn't change snapshots")));
});

test('evaluateAutoMerge: extra source file fails manifest-lockfile-only', () => {
    const result = evaluateAutoMerge({
        ...PASSING_INPUT,
        changedFiles: ['package.json', 'package-lock.json', 'src/foo.ts'],
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.blockingReasons.some((r) => r.includes('only manifest and lockfile')));
});

test('evaluateAutoMerge: CI <24h ago fails ci-24h-soak', () => {
    const result = evaluateAutoMerge({
        ...PASSING_INPUT,
        ciCompletedAt: new Date('2026-08-24T09:00:00Z'),
        now: new Date('2026-08-24T10:00:00Z'), // 1h later
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.blockingReasons.some((r) => r.includes('24 hours')));
});

test('evaluateAutoMerge: missing ciCompletedAt fails ci-24h-soak', () => {
    const result = evaluateAutoMerge({...PASSING_INPUT, ciCompletedAt: undefined});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.blockingReasons.some((r) => r.includes('24 hours')));
});

// --- evaluateAutoMerge — edge cases ---------------------------------------

test('evaluateAutoMerge: empty input is not allowed (no conditions pass)', () => {
    const result = evaluateAutoMerge({});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.excluded, true); // undefined section → production
    assert.strictEqual(result.conditions.length, 9);
});

test('evaluateAutoMerge: returns conditions array with id/name/description', () => {
    const result = evaluateAutoMerge(PASSING_INPUT);
    for (const cond of result.conditions) {
        assert.ok(typeof cond.id === 'string');
        assert.ok(typeof cond.name === 'string');
        assert.ok(typeof cond.description === 'string');
        assert.strictEqual(typeof cond.passed, 'boolean');
    }
});

test('evaluateAutoMerge: now defaults to Date.now() when omitted', () => {
    const ci = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const result = evaluateAutoMerge({...PASSING_INPUT, ciCompletedAt: ci, now: undefined});
    // 25h > 24h → soak condition passes
    const soak = result.conditions.find((c) => c.id === 'ci-24h-soak');
    assert.strictEqual(soak.passed, true);
});

test('evaluateAutoMerge: handles null input gracefully', () => {
    const result = evaluateAutoMerge(null);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.conditions.length, 9);
});

// --- renderRulesMarkdown ---------------------------------------------------

test('renderRulesMarkdown: contains all 9 condition ids', () => {
    const md = renderRulesMarkdown();
    for (const cond of AUTO_MERGE_CONDITIONS) {
        assert.ok(md.includes(cond.id), `missing condition id ${cond.id}`);
        assert.ok(md.includes(cond.name), `missing condition name ${cond.name}`);
    }
});

test('renderRulesMarkdown: contains all exclusion ids', () => {
    const md = renderRulesMarkdown();
    for (const ex of EXCLUSION_LIST) {
        assert.ok(md.includes(ex.id), `missing exclusion id ${ex.id}`);
        assert.ok(md.includes(ex.name), `missing exclusion name ${ex.name}`);
    }
});

test('renderRulesMarkdown: contains allowed manifest files', () => {
    const md = renderRulesMarkdown();
    for (const file of ALLOWED_MANIFEST_FILES) {
        assert.ok(md.includes(file), `missing allowed file ${file}`);
    }
});

test('renderRulesMarkdown: contains snapshot patterns', () => {
    const md = renderRulesMarkdown();
    for (const pat of SNAPSHOT_PATTERNS) {
        assert.ok(md.includes(pat), `missing snapshot pattern ${pat}`);
    }
});

test('renderRulesMarkdown: contains soak window hours', () => {
    const md = renderRulesMarkdown();
    const hours = SOAK_WINDOW_MS / (60 * 60 * 1000);
    assert.ok(md.includes(`${hours} hours`));
});

test('renderRulesMarkdown: is valid markdown (starts with #)', () => {
    const md = renderRulesMarkdown();
    assert.ok(md.startsWith('# Auto-merge Rules'));
    assert.ok(md.includes('| # |'));
});

// --- SOAK_WINDOW_MS sanity -------------------------------------------------

test('SOAK_WINDOW_MS: equals 24 hours', () => {
    assert.strictEqual(SOAK_WINDOW_MS, 24 * 60 * 60 * 1000);
});

module.exports = {tests};
