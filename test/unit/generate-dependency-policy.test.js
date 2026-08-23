const assert = require('node:assert');
const {join} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, fileExists, writeJson} = require('../helpers/file-utils');
const {mkdirSync} = require('node:fs');
const yaml = require('js-yaml');

const {
    repoNameFromPackage,
    filterEntriesForRepo,
    buildRepoPolicy,
    serializeRepoPolicy,
    resolveRegistryPath,
} = require('../../scripts/generate-dependency-policy');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- repoNameFromPackage -------------------------------------------------

test('repoNameFromPackage: strips @diplodoc scope', () => {
    assert.strictEqual(repoNameFromPackage('@diplodoc/cli'), 'cli');
    assert.strictEqual(repoNameFromPackage('@diplodoc/cut-extension'), 'cut-extension');
});

test('repoNameFromPackage: keeps unscoped names', () => {
    assert.strictEqual(repoNameFromPackage('infra'), 'infra');
});

test('repoNameFromPackage: handles empty / invalid', () => {
    assert.strictEqual(repoNameFromPackage(''), '');
    assert.strictEqual(repoNameFromPackage(null), '');
    assert.strictEqual(repoNameFromPackage(undefined), '');
});

// --- filterEntriesForRepo ------------------------------------------------

test('filterEntriesForRepo: includes entries that list the repo', () => {
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', repositories: ['cli', 'transform']},
        {id: 'DEP-0002', dependency: 'ajv', repositories: ['transform']},
    ];
    const result = filterEntriesForRepo(entries, 'cli');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'DEP-0001');
});

test('filterEntriesForRepo: entries without repositories apply to all repos', () => {
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', repositories: ['cli']},
        {id: 'DEP-0002', dependency: 'glob'},
    ];
    const result = filterEntriesForRepo(entries, 'transform');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'DEP-0002');
});

test('filterEntriesForRepo: empty repositories array means all repos', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', repositories: []}];
    const result = filterEntriesForRepo(entries, 'anything');
    assert.strictEqual(result.length, 1);
});

test('filterEntriesForRepo: returns empty array for no matches', () => {
    const entries = [{id: 'DEP-0001', dependency: 'svgo', repositories: ['cli', 'transform']}];
    const result = filterEntriesForRepo(entries, 'utils');
    assert.strictEqual(result.length, 0);
});

test('filterEntriesForRepo: handles non-array entries input', () => {
    assert.deepStrictEqual(filterEntriesForRepo(null, 'cli'), []);
    assert.deepStrictEqual(filterEntriesForRepo(undefined, 'cli'), []);
});

// --- buildRepoPolicy -----------------------------------------------------

test('buildRepoPolicy: projects entries and preserves metadata', () => {
    const registry = {
        'schema-version': '1.0',
        'registry-owner': 'diplodoc-platform/infra',
        entries: [
            {id: 'DEP-0001', dependency: 'svgo', repositories: ['cli', 'transform']},
            {id: 'DEP-0002', dependency: 'ajv', repositories: ['utils']},
        ],
    };
    const policy = buildRepoPolicy(registry, 'cli');
    assert.strictEqual(policy['schema-version'], '1.0');
    assert.strictEqual(policy['registry-owner'], 'diplodoc-platform/infra');
    assert.strictEqual(policy['generated-for'], 'cli');
    assert.strictEqual(policy.entries.length, 1);
    assert.strictEqual(policy.entries[0].id, 'DEP-0001');
});

test('buildRepoPolicy: handles missing entries key', () => {
    const registry = {'schema-version': '1.0', 'registry-owner': 'x'};
    const policy = buildRepoPolicy(registry, 'cli');
    assert.deepStrictEqual(policy.entries, []);
});

test('buildRepoPolicy: defaults schema-version when missing', () => {
    const policy = buildRepoPolicy({}, 'cli');
    assert.strictEqual(policy['schema-version'], '1.0');
});

// --- serializeRepoPolicy -------------------------------------------------

test('serializeRepoPolicy: produces valid parseable YAML with header comment', () => {
    const policy = {
        'schema-version': '1.0',
        'registry-owner': 'diplodoc-platform/infra',
        'generated-for': 'cli',
        'generated-from': 'central dependency-policy.yml',
        entries: [{id: 'DEP-0001', dependency: 'svgo', repositories: ['cli', 'transform']}],
    };
    const serialized = serializeRepoPolicy(policy);
    assert.ok(serialized.startsWith('#'), 'YAML should start with header comment');
    assert.ok(serialized.includes('AUTO-GENERATED'));
    const reparsed = yaml.load(serialized);
    assert.strictEqual(reparsed['generated-for'], 'cli');
    assert.strictEqual(reparsed.entries.length, 1);
    assert.strictEqual(reparsed.entries[0].id, 'DEP-0001');
});

test('serializeRepoPolicy: empty entries produces valid YAML', () => {
    const policy = {
        'schema-version': '1.0',
        'registry-owner': 'x',
        'generated-for': 'utils',
        'generated-from': 'central dependency-policy.yml',
        entries: [],
    };
    const serialized = serializeRepoPolicy(policy);
    const reparsed = yaml.load(serialized);
    assert.deepStrictEqual(reparsed.entries, []);
});

// --- resolveRegistryPath -------------------------------------------------

test('resolveRegistryPath: resolves the local registry relative to script', () => {
    const path = resolveRegistryPath();
    assert.ok(path.endsWith('dependency-policy.yml'));
});

test('resolveRegistryPath: returns explicit override verbatim', () => {
    assert.strictEqual(resolveRegistryPath('/tmp/custom.yml'), '/tmp/custom.yml');
});

// --- CLI integration -----------------------------------------------------

const SCRIPT = join(__dirname, '../../scripts/generate-dependency-policy.js');
const REAL_REGISTRY = join(__dirname, '../../dependency-policy.yml');

test('CLI: generates .github/dependency-policy.yml for cli with DEP-0001', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {name: '@diplodoc/cli', version: '1.0.0'});
        execSync(`node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}"`, {
            stdio: 'pipe',
            env: {...process.env},
        });
        assert.ok(fileExists(tempDir, '.github/dependency-policy.yml'));
        const content = readFile(tempDir, '.github/dependency-policy.yml');
        const parsed = yaml.load(content);
        assert.strictEqual(parsed['generated-for'], 'cli');
        assert.strictEqual(parsed.entries.length, 1);
        assert.strictEqual(parsed.entries[0].id, 'DEP-0001');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: repo with no matching entries gets empty entries list', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {name: '@diplodoc/utils', version: '1.0.0'});
        execSync(`node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}"`, {
            stdio: 'pipe',
            env: {...process.env},
        });
        const content = readFile(tempDir, '.github/dependency-policy.yml');
        const parsed = yaml.load(content);
        assert.strictEqual(parsed['generated-for'], 'utils');
        assert.deepStrictEqual(parsed.entries, []);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: INFRA_REPO_NAME env var overrides package.json derivation', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {name: '@diplodoc/whatever', version: '1.0.0'});
        execSync(`node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}"`, {
            stdio: 'pipe',
            env: {...process.env, INFRA_REPO_NAME: 'transform'},
        });
        const content = readFile(tempDir, '.github/dependency-policy.yml');
        const parsed = yaml.load(content);
        assert.strictEqual(parsed['generated-for'], 'transform');
        assert.strictEqual(parsed.entries.length, 1);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: --repo flag overrides package.json derivation', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {name: '@diplodoc/whatever', version: '1.0.0'});
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}" --repo cli`,
            {stdio: 'pipe', env: {...process.env}},
        );
        const content = readFile(tempDir, '.github/dependency-policy.yml');
        const parsed = yaml.load(content);
        assert.strictEqual(parsed['generated-for'], 'cli');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: creates .github directory if missing', async () => {
    const tempDir = await createTempDir();
    try {
        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}" --repo cli`,
            {stdio: 'pipe', env: {...process.env}},
        );
        assert.ok(fileExists(tempDir, '.github/dependency-policy.yml'));
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when repo name cannot be determined', async () => {
    const tempDir = await createTempDir();
    try {
        let failed = false;
        try {
            execSync(`node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}"`, {
                stdio: 'pipe',
                env: {...process.env},
            });
        } catch {
            failed = true;
        }
        assert.ok(failed, 'Should exit non-zero');
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
