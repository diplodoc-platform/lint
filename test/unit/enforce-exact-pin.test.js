const assert = require('node:assert');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, writeJson} = require('../helpers/file-utils');
const yaml = require('js-yaml');

const {
    isExactPin,
    extractExactPins,
    findRegistryEntry,
    missingMandatoryFields,
    enforce,
    enforceChanges,
    formatViolations,
} = require('../../scripts/enforce-exact-pin');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- isExactPin ----------------------------------------------------------

test('isExactPin: bare numeric versions are exact pins', () => {
    assert.strictEqual(isExactPin('3.3.2'), true);
    assert.strictEqual(isExactPin('1.0.0'), true);
    assert.strictEqual(isExactPin('1.2.3-beta.1'), true);
    assert.strictEqual(isExactPin('0.0.0'), true);
});

test('isExactPin: caret and tilde ranges are not exact pins', () => {
    assert.strictEqual(isExactPin('^3.3.2'), false);
    assert.strictEqual(isExactPin('~3.3.2'), false);
    assert.strictEqual(isExactPin('^1.0.0'), false);
});

test('isExactPin: comparators are not exact pins', () => {
    assert.strictEqual(isExactPin('>3.3.2'), false);
    assert.strictEqual(isExactPin('<3.3.2'), false);
    assert.strictEqual(isExactPin('>=3.3.2'), false);
    assert.strictEqual(isExactPin('<=3.3.2'), false);
    assert.strictEqual(isExactPin('=3.3.2'), false);
});

test('isExactPin: wildcards are not exact pins', () => {
    assert.strictEqual(isExactPin('*'), false);
    assert.strictEqual(isExactPin('x'), false);
    assert.strictEqual(isExactPin('X'), false);
    assert.strictEqual(isExactPin('3.x'), false);
});

test('isExactPin: aliases and protocols are not exact pins', () => {
    assert.strictEqual(isExactPin('workspace:*'), false);
    assert.strictEqual(isExactPin('workspace:^'), false);
    assert.strictEqual(isExactPin('file:../foo'), false);
    assert.strictEqual(isExactPin('link:../foo'), false);
    assert.strictEqual(isExactPin('git+https://github.com/foo/bar.git'), false);
    assert.strictEqual(isExactPin('github:foo/bar'), false);
    assert.strictEqual(isExactPin('npm:foo@1.2.3'), false);
    assert.strictEqual(isExactPin('http://example.com/foo.tgz'), false);
});

test('isExactPin: latest tag is not an exact pin', () => {
    assert.strictEqual(isExactPin('latest'), false);
});

test('isExactPin: ranges with || are not exact pins', () => {
    assert.strictEqual(isExactPin('1.2.3 || 1.3.0'), false);
});

test('isExactPin: handles invalid input', () => {
    assert.strictEqual(isExactPin(''), false);
    assert.strictEqual(isExactPin(null), false);
    assert.strictEqual(isExactPin(undefined), false);
    assert.strictEqual(isExactPin(123), false);
});

test('isExactPin: trims whitespace before checking', () => {
    assert.strictEqual(isExactPin('  3.3.2  '), true);
    assert.strictEqual(isExactPin('  ^3.3.2  '), false);
});

// --- extractExactPins ----------------------------------------------------

test('extractExactPins: collects exact pins from all dependency sections', () => {
    const pkg = {
        dependencies: {svgo: '3.3.2', lodash: '^4.17.0'},
        devDependencies: {eslint: '8.57.0', prettier: '^3.3.3'},
        peerDependencies: {typescript: '5.4.0'},
        optionalDependencies: {fsevents: '^2.3.0'},
    };
    const pins = extractExactPins(pkg);
    const names = pins.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['eslint', 'svgo', 'typescript']);
});

test('extractExactPins: records section and version', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const pins = extractExactPins(pkg);
    assert.strictEqual(pins.length, 1);
    assert.strictEqual(pins[0].name, 'svgo');
    assert.strictEqual(pins[0].version, '3.3.2');
    assert.strictEqual(pins[0].section, 'dependencies');
});

test('extractExactPins: returns empty array for object without deps', () => {
    assert.deepStrictEqual(extractExactPins({name: 'foo'}), []);
});

test('extractExactPins: handles null/undefined input', () => {
    assert.deepStrictEqual(extractExactPins(null), []);
    assert.deepStrictEqual(extractExactPins(undefined), []);
});

test('extractExactPins: ignores missing/empty sections', () => {
    const pkg = {dependencies: {}, devDependencies: null, peerDependencies: undefined};
    assert.deepStrictEqual(extractExactPins(pkg), []);
});

// --- findRegistryEntry ---------------------------------------------------

test('findRegistryEntry: matches by dependency name and allowed-version', () => {
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2'},
        {id: 'DEP-0002', dependency: 'ajv', 'allowed-version': '8.17.1'},
    ];
    const entry = findRegistryEntry(entries, 'svgo', '3.3.2');
    assert.ok(entry);
    assert.strictEqual(entry.id, 'DEP-0001');
});

test('findRegistryEntry: matches when allowed-version is missing (covers any pin)', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo'}];
    const entry = findRegistryEntry(entries, 'svgo', '3.3.2');
    assert.ok(entry);
});

test('findRegistryEntry: returns undefined when version does not match', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2'}];
    assert.strictEqual(findRegistryEntry(entries, 'svgo', '3.3.3'), undefined);
});

test('findRegistryEntry: returns undefined when dependency name not in registry', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2'}];
    assert.strictEqual(findRegistryEntry(entries, 'lodash', '4.17.0'), undefined);
});

test('findRegistryEntry: coerces numeric allowed-version to string', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', 'allowed-version': 3.3}];
    const entry = findRegistryEntry(entries, 'svgo', '3.3');
    assert.ok(entry);
});

test('findRegistryEntry: handles non-array entries', () => {
    assert.strictEqual(findRegistryEntry(null, 'svgo', '3.3.2'), undefined);
    assert.strictEqual(findRegistryEntry(undefined, 'svgo', '3.3.2'), undefined);
});

// --- missingMandatoryFields ----------------------------------------------

test('missingMandatoryFields: returns empty array when reason and owner present', () => {
    assert.deepStrictEqual(missingMandatoryFields({reason: 'x', owner: 'y'}), []);
});

test('missingMandatoryFields: reports missing reason', () => {
    assert.deepStrictEqual(missingMandatoryFields({owner: 'y'}), ['reason']);
});

test('missingMandatoryFields: reports missing owner', () => {
    assert.deepStrictEqual(missingMandatoryFields({reason: 'x'}), ['owner']);
});

test('missingMandatoryFields: reports both when empty strings', () => {
    assert.deepStrictEqual(missingMandatoryFields({reason: '  ', owner: ''}), ['reason', 'owner']);
});

test('missingMandatoryFields: handles non-object entry', () => {
    assert.deepStrictEqual(missingMandatoryFields(null), ['reason', 'owner']);
});

// --- enforce -------------------------------------------------------------

test('enforce: passes when every exact pin has a registry entry', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}, devDependencies: {lodash: '^4.17.0'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'broken',
                owner: 'team',
                repositories: ['cli', 'transform'],
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 1);
    assert.deepStrictEqual(result.violations, []);
});

test('enforce: flags pin with no matching registry entry', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {entries: []};
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].name, 'svgo');
    assert.ok(result.violations[0].reason.includes('no matching registry entry'));
});

test('enforceChanges: permits unchanged legacy exact pins', () => {
    const before = {devDependencies: {typescript: '6.0.3'}};
    const after = {devDependencies: {typescript: '6.0.3'}};
    const result = enforceChanges(before, after, {entries: []}, 'testpack');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(result.existing, 1);
});

test('enforceChanges: rejects a newly introduced unregistered pin', () => {
    const before = {devDependencies: {typescript: '^6.0.0'}};
    const after = {devDependencies: {typescript: '6.0.3'}};
    const result = enforceChanges(before, after, {entries: []}, 'testpack');

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.existing, 0);
    assert.strictEqual(result.violations[0].name, 'typescript');
});

test('enforceChanges: validates a changed exact version against the registry', () => {
    const before = {dependencies: {svgo: '3.3.1'}};
    const after = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'Known rendering regression in newer versions',
                owner: 'team',
                repositories: ['cli'],
            },
        ],
    };
    const result = enforceChanges(before, after, registry, 'cli');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.checked, 1);
});

test('enforce: flags entry missing mandatory reason/owner', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [{id: 'DEP-0001', dependency: 'svgo', 'allowed-version': '3.3.2'}],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.ok(result.violations[0].reason.includes('mandatory fields'));
});

test('enforce: scopes entries by repo when repoName given', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'x',
                owner: 'y',
                repositories: ['transform'],
            },
        ],
    };
    // cli is not in the repositories list -> entry does not apply -> violation
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
});

test('enforce: global entries (no repositories) apply to all repos', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'x',
                owner: 'y',
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.ok, true);
});

test('enforce: counts only exact pins, ignores ranges', () => {
    const pkg = {
        dependencies: {svgo: '3.3.2', lodash: '^4.17.0', ajv: '~8.17.1'},
    };
    const registry = {
        entries: [
            {
                id: 'DEP-0001',
                dependency: 'svgo',
                'allowed-version': '3.3.2',
                reason: 'x',
                owner: 'y',
            },
        ],
    };
    const result = enforce(pkg, registry, 'cli');
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.ok, true);
});

test('enforce: handles missing registry entries key', () => {
    const pkg = {dependencies: {svgo: '3.3.2'}};
    const result = enforce(pkg, {}, 'cli');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
});

test('enforce: no exact pins -> ok with zero checked', () => {
    const pkg = {dependencies: {lodash: '^4.17.0'}};
    const result = enforce(pkg, {entries: []}, 'cli');
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(result.ok, true);
});

// --- formatViolations ----------------------------------------------------

test('formatViolations: produces readable multi-line message', () => {
    const violations = [
        {
            name: 'svgo',
            version: '3.3.2',
            section: 'dependencies',
            reason: 'no matching registry entry',
        },
    ];
    const msg = formatViolations(violations);
    assert.ok(msg.includes('svgo'));
    assert.ok(msg.includes('3.3.2'));
    assert.ok(msg.includes('dependencies'));
    assert.ok(msg.includes('dependency-policy.yml'));
});

test('formatViolations: returns empty string for no violations', () => {
    assert.strictEqual(formatViolations([]), '');
    assert.strictEqual(formatViolations(null), '');
});

// --- CLI integration -----------------------------------------------------

const SCRIPT = join(__dirname, '../../scripts/enforce-exact-pin.js');
const REAL_REGISTRY = join(__dirname, '../../dependency-policy.yml');

test('CLI: passes for cli package.json against real registry', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            devDependencies: {svgo: '3.3.2'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}" --repo cli`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: fails for unregistered exact pin', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            dependencies: {'some-unknown-dep': '1.2.3'},
        });
        let failed = false;
        let stderr = '';
        try {
            execSync(
                `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}" --repo cli`,
                {stdio: 'pipe', env: {...process.env}},
            );
        } catch (error) {
            failed = true;
            stderr = error.stderr ? error.stderr.toString() : '';
        }
        assert.ok(failed, 'Should exit non-zero');
        assert.ok(stderr.includes('some-unknown-dep'), 'Error should reference the missing dep');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits 0 when there are no exact pins', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/utils',
            version: '1.0.0',
            dependencies: {lodash: '^4.17.0'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}" --repo utils`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: derives repo name from package.json when --repo omitted', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {
            name: '@diplodoc/cli',
            version: '1.0.0',
            devDependencies: {svgo: '3.3.2'},
        });
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'package.json')}"`,
            {stdio: 'pipe', env: {...process.env}},
        );
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when package.json is missing', async () => {
    const tempDir = await createTempDir();
    try {
        let failed = false;
        try {
            execSync(
                `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --package "${join(tempDir, 'nope.json')}"`,
                {stdio: 'pipe', env: {...process.env}},
            );
        } catch {
            failed = true;
        }
        assert.ok(failed);
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
