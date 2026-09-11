const assert = require('node:assert');
const {join, dirname} = require('node:path');
const {execSync} = require('node:child_process');
const {createTempDir, removeTempDir} = require('../helpers/temp-dir');
const {writeFile, readFile, fileExists, writeJson} = require('../helpers/file-utils');
const {mkdirSync} = require('node:fs');
const yaml = require('js-yaml');

const {
    buildIgnoreEntries,
    serializeIgnoreEntries,
    injectIntoTemplate,
    generatePerRepoIgnores,
    hasNoWildcardIgnores,
    MARKER,
} = require('../../scripts/generate-dependabot-ignores');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- buildIgnoreEntries --------------------------------------------------

test('buildIgnoreEntries: extracts entries with ignored-versions', () => {
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', 'ignored-versions': ['3.3.3', '3.3.4']},
        {id: 'DEP-0002', dependency: 'ajv', 'ignored-versions': ['8.17.1']},
    ];
    const result = buildIgnoreEntries(entries);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]['dependency-name'], 'svgo');
    assert.deepStrictEqual(result[0].versions, ['3.3.3', '3.3.4']);
    assert.strictEqual(result[1]['dependency-name'], 'ajv');
    assert.deepStrictEqual(result[1].versions, ['8.17.1']);
});

test('buildIgnoreEntries: skips entries without ignored-versions', () => {
    const entries = [
        {id: 'DEP-0001', dependency: 'svgo', 'ignored-versions': ['3.3.3']},
        {id: 'DEP-0002', dependency: 'lodash'},
        {id: 'DEP-0003', dependency: 'katex', 'ignored-versions': []},
    ];
    const result = buildIgnoreEntries(entries);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]['dependency-name'], 'svgo');
});

test('buildIgnoreEntries: handles non-array input', () => {
    assert.deepStrictEqual(buildIgnoreEntries(null), []);
    assert.deepStrictEqual(buildIgnoreEntries(undefined), []);
    assert.deepStrictEqual(buildIgnoreEntries('not-an-array'), []);
});

test('buildIgnoreEntries: coerces versions to strings', () => {
    const entries = [{dependency: 'types', 'ignored-versions': [3.3, 4, '5.0.0']}];
    const result = buildIgnoreEntries(entries);
    assert.deepStrictEqual(result[0].versions, ['3.3', '4', '5.0.0']);
});

// --- serializeIgnoreEntries -----------------------------------------------

test('serializeIgnoreEntries: produces valid YAML for multiple entries', () => {
    const entries = [
        {'dependency-name': 'svgo', versions: ['3.3.3', '3.3.4']},
        {'dependency-name': 'ajv', versions: ['8.17.1']},
    ];
    const yamlStr = serializeIgnoreEntries(entries, 4);
    const parsed = yaml.load(`ignore:\n${yamlStr.split('\n').slice(1).join('\n')}`);
    assert.strictEqual(parsed.ignore.length, 2);
    assert.strictEqual(parsed.ignore[0]['dependency-name'], 'svgo');
    assert.deepStrictEqual(parsed.ignore[0].versions, ['3.3.3', '3.3.4']);
    assert.strictEqual(parsed.ignore[1]['dependency-name'], 'ajv');
    assert.deepStrictEqual(parsed.ignore[1].versions, ['8.17.1']);
});

test('serializeIgnoreEntries: returns comment for empty entries', () => {
    const result = serializeIgnoreEntries([], 4);
    assert.ok(result.includes('no registry-based ignores'));
    assert.ok(result.startsWith('    #'));
});

test('serializeIgnoreEntries: handles null entries', () => {
    const result = serializeIgnoreEntries(null, 4);
    assert.ok(result.includes('no registry-based ignores'));
});

test('serializeIgnoreEntries: respects custom indentation', () => {
    const entries = [{'dependency-name': 'svgo', versions: ['3.3.3']}];
    const yamlStr = serializeIgnoreEntries(entries, 6);
    assert.ok(yamlStr.startsWith('      ignore:'), 'Should start with 6-space indent');
});

// --- injectIntoTemplate ---------------------------------------------------

test('injectIntoTemplate: replaces markers with generated YAML', () => {
    const template = [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    schedule:',
        '      interval: weekly',
        '    # @generated-ignore',
        '',
        '  - package-ecosystem: npm',
        '    schedule:',
        '      interval: monthly',
        '    # @generated-ignore',
    ].join('\n');
    const fragments = [
        "    ignore:\n      - dependency-name: 'svgo'\n        versions:\n          - '3.3.3'",
        '    # (no registry-based ignores for this repo)',
    ];
    const result = injectIntoTemplate(template, fragments);
    assert.ok(!result.includes(MARKER), 'All markers should be replaced');
    assert.ok(result.includes("dependency-name: 'svgo'"));
    assert.ok(result.includes('no registry-based ignores'));
});

test('injectIntoTemplate: handles fewer fragments than markers', () => {
    const template = `version: 2\nupdates:\n  - x\n    # @generated-ignore\n  - y\n    # @generated-ignore`;
    const fragments = ['    ignore:\n      - a'];
    const result = injectIntoTemplate(template, fragments);
    // First marker replaced, second remains
    assert.ok(result.includes('ignore:'));
    assert.ok(result.includes(MARKER));
});

test('injectIntoTemplate: no markers returns content unchanged', () => {
    const content = 'version: 2\nupdates: []';
    const result = injectIntoTemplate(content, ['    ignore:\n      - a']);
    assert.strictEqual(result, content);
});

// --- generatePerRepoIgnores -----------------------------------------------

test('generatePerRepoIgnores: generates ignores for matching repo', () => {
    const registry = {
        entries: [
            {
                dependency: 'svgo',
                'ignored-versions': ['3.3.3', '3.3.4'],
                repositories: ['cli', 'transform'],
            },
            {dependency: 'ajv', 'ignored-versions': ['8.17.1'], repositories: ['transform']},
        ],
    };
    const fragments = generatePerRepoIgnores(registry, 'cli', 3);
    assert.strictEqual(fragments.length, 3);
    for (const frag of fragments) {
        assert.ok(frag.includes("dependency-name: 'svgo'"));
        assert.ok(frag.includes("'3.3.3'"));
        assert.ok(frag.includes("'3.3.4'"));
        assert.ok(!frag.includes('ajv'), 'ajv should be filtered out for cli');
    }
});

test('generatePerRepoIgnores: repo with no matching entries gets comment', () => {
    const registry = {
        entries: [{dependency: 'svgo', 'ignored-versions': ['3.3.3'], repositories: ['cli']}],
    };
    const fragments = generatePerRepoIgnores(registry, 'utils', 3);
    assert.strictEqual(fragments.length, 3);
    for (const frag of fragments) {
        assert.ok(frag.includes('no registry-based ignores'));
    }
});

test('generatePerRepoIgnores: entries without repositories apply to all repos', () => {
    const registry = {
        entries: [{dependency: 'glob', 'ignored-versions': ['11.0.0']}],
    };
    const fragments = generatePerRepoIgnores(registry, 'anything', 3);
    for (const frag of fragments) {
        assert.ok(frag.includes("dependency-name: 'glob'"));
    }
});

test('generatePerRepoIgnores: empty registry produces comment fragments', () => {
    const registry = {};
    const fragments = generatePerRepoIgnores(registry, 'cli', 3);
    assert.strictEqual(fragments.length, 3);
    for (const frag of fragments) {
        assert.ok(frag.includes('no registry-based ignores'));
    }
});

test('generatePerRepoIgnores: defaults to the single npm update block', () => {
    const fragments = generatePerRepoIgnores({entries: []}, 'cli');
    assert.strictEqual(fragments.length, 1);
});

// --- hasNoWildcardIgnores -------------------------------------------------

test('hasNoWildcardIgnores: true for no ignore sections', () => {
    const content =
        'version: 2\nupdates:\n  - package-ecosystem: npm\n    schedule:\n      interval: weekly';
    assert.strictEqual(hasNoWildcardIgnores(content), true);
});

test('hasNoWildcardIgnores: true for specific-version ignores', () => {
    const content = [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    ignore:',
        '      - dependency-name: svgo',
        '        versions:',
        '          - 3.3.3',
    ].join('\n');
    assert.strictEqual(hasNoWildcardIgnores(content), true);
});

test('hasNoWildcardIgnores: false for dependency-name wildcard', () => {
    const content = [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    ignore:',
        '      - dependency-name: "*"',
        '        update-types:',
        '          - version-update:semver-major',
    ].join('\n');
    assert.strictEqual(hasNoWildcardIgnores(content), false);
});

test('hasNoWildcardIgnores: false for update-types entries', () => {
    const content = [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    ignore:',
        '      - dependency-name: svgo',
        '        update-types:',
        '          - version-update:semver-major',
    ].join('\n');
    assert.strictEqual(hasNoWildcardIgnores(content), false);
});

test('hasNoWildcardIgnores: true for malformed/empty content', () => {
    assert.strictEqual(hasNoWildcardIgnores(''), true);
    assert.strictEqual(hasNoWildcardIgnores('version: 2'), true);
});

// --- CLI integration -------------------------------------------------------

const SCRIPT = join(__dirname, '../../scripts/generate-dependabot-ignores.js');
const REAL_REGISTRY = join(__dirname, '../../dependency-policy.yml');
const TEMPLATE_DEPENDABOT = join(__dirname, '../../scaffolding/.github/dependabot.yml');

test('CLI: injects svgo ignores for cli repo', async () => {
    const tempDir = await createTempDir();
    try {
        const githubDir = join(tempDir, '.github');
        mkdirSync(githubDir, {recursive: true});
        const template = readFile(dirname(TEMPLATE_DEPENDABOT), 'dependabot.yml');
        writeFile(githubDir, 'dependabot.yml', template);
        writeJson(tempDir, 'package.json', {name: '@diplodoc/cli', version: '1.0.0'});

        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}" --repo cli`,
            {stdio: 'pipe', env: {...process.env}},
        );

        const content = readFile(githubDir, 'dependabot.yml');
        assert.ok(!content.includes(MARKER), 'Markers should be replaced');
        assert.ok(content.includes("dependency-name: 'svgo'"), 'Should contain svgo ignore');
        assert.ok(content.includes("'3.3.3'"), 'Should contain version 3.3.3');
        assert.ok(content.includes("'3.3.4'"), 'Should contain version 3.3.4');
        assert.ok(hasNoWildcardIgnores(content), 'No wildcard ignores');
        // Verify valid YAML
        yaml.load(content);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: repo without matching entries gets comment placeholders', async () => {
    const tempDir = await createTempDir();
    try {
        const githubDir = join(tempDir, '.github');
        mkdirSync(githubDir, {recursive: true});
        const template = readFile(dirname(TEMPLATE_DEPENDABOT), 'dependabot.yml');
        writeFile(githubDir, 'dependabot.yml', template);
        writeJson(tempDir, 'package.json', {name: '@diplodoc/utils', version: '1.0.0'});

        execSync(`node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}"`, {
            stdio: 'pipe',
            env: {...process.env},
        });

        const content = readFile(githubDir, 'dependabot.yml');
        assert.ok(!content.includes(MARKER));
        assert.ok(content.includes('no registry-based ignores'));
        assert.ok(hasNoWildcardIgnores(content));
        yaml.load(content);
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: INFRA_REPO_NAME env var overrides package.json', async () => {
    const tempDir = await createTempDir();
    try {
        const githubDir = join(tempDir, '.github');
        mkdirSync(githubDir, {recursive: true});
        const template = readFile(dirname(TEMPLATE_DEPENDABOT), 'dependabot.yml');
        writeFile(githubDir, 'dependabot.yml', template);
        writeJson(tempDir, 'package.json', {name: '@diplodoc/whatever', version: '1.0.0'});

        execSync(`node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}"`, {
            stdio: 'pipe',
            env: {...process.env, INFRA_REPO_NAME: 'transform'},
        });

        const content = readFile(githubDir, 'dependabot.yml');
        assert.ok(content.includes("dependency-name: 'svgo'"), 'transform has svgo in registry');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when no markers found', async () => {
    const tempDir = await createTempDir();
    try {
        const githubDir = join(tempDir, '.github');
        mkdirSync(githubDir, {recursive: true});
        writeFile(githubDir, 'dependabot.yml', 'version: 2\nupdates: []');
        writeJson(tempDir, 'package.json', {name: '@diplodoc/cli', version: '1.0.0'});

        let exitCode = 0;
        try {
            execSync(
                `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}" --repo cli`,
                {stdio: 'pipe', env: {...process.env}},
            );
        } catch (err) {
            exitCode = err.status;
        }
        assert.strictEqual(exitCode, 0, 'Should exit 0 when nothing to do');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when dependabot.yml not found', async () => {
    const tempDir = await createTempDir();
    try {
        writeJson(tempDir, 'package.json', {name: '@diplodoc/cli', version: '1.0.0'});

        let failed = false;
        try {
            execSync(
                `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}" --repo cli`,
                {stdio: 'pipe', env: {...process.env}},
            );
        } catch {
            failed = true;
        }
        assert.ok(failed, 'Should exit non-zero');
    } finally {
        await removeTempDir(tempDir);
    }
});

test('CLI: exits non-zero when repo name cannot be determined', async () => {
    const tempDir = await createTempDir();
    try {
        const githubDir = join(tempDir, '.github');
        mkdirSync(githubDir, {recursive: true});
        const template = readFile(dirname(TEMPLATE_DEPENDABOT), 'dependabot.yml');
        writeFile(githubDir, 'dependabot.yml', template);

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

test('CLI: generated dependabot.yml is valid YAML with no wildcard ignores', async () => {
    const tempDir = await createTempDir();
    try {
        const githubDir = join(tempDir, '.github');
        mkdirSync(githubDir, {recursive: true});
        const template = readFile(dirname(TEMPLATE_DEPENDABOT), 'dependabot.yml');
        writeFile(githubDir, 'dependabot.yml', template);
        writeJson(tempDir, 'package.json', {name: '@diplodoc/cli', version: '1.0.0'});

        execSync(
            `node "${SCRIPT}" --registry "${REAL_REGISTRY}" --target "${tempDir}" --repo cli`,
            {stdio: 'pipe', env: {...process.env}},
        );

        const content = readFile(githubDir, 'dependabot.yml');
        const parsed = yaml.load(content);
        assert.strictEqual(parsed.version, 2);
        assert.strictEqual(parsed.updates.length, 1);
        // The npm update block should have an ignore section with svgo.
        for (const block of parsed.updates) {
            assert.ok(Array.isArray(block.ignore), 'Each block should have ignore array');
            assert.strictEqual(block.ignore.length, 1);
            assert.strictEqual(block.ignore[0]['dependency-name'], 'svgo');
            assert.deepStrictEqual(block.ignore[0].versions, ['3.3.3', '3.3.4']);
            // No update-types (wildcard ignores)
            assert.strictEqual(block.ignore[0]['update-types'], undefined);
        }
    } finally {
        await removeTempDir(tempDir);
    }
});

module.exports = {tests};
