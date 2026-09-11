const assert = require('node:assert');
const {
    RISK_LEVELS,
    RISK_WEIGHT,
    RISK_DESCRIPTIONS,
    CLASSIFICATION_RULES,
    globToRegExp,
    matchDependency,
    classifyDependency,
    elevateRisk,
} = require('../../scripts/risk-classification');

const {
    riskForChange,
    buildAssessment,
    renderComment,
} = require('../../scripts/dependency-policy-review');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- RISK_LEVELS -----------------------------------------------------------

test('RISK_LEVELS: defines exactly four ordered levels', () => {
    assert.deepStrictEqual(RISK_LEVELS, ['low', 'medium', 'high', 'critical']);
});

test('RISK_WEIGHT: orders low < medium < high < critical', () => {
    assert.ok(RISK_WEIGHT.low < RISK_WEIGHT.medium);
    assert.ok(RISK_WEIGHT.medium < RISK_WEIGHT.high);
    assert.ok(RISK_WEIGHT.high < RISK_WEIGHT.critical);
});

test('RISK_DESCRIPTIONS: every level has examples/checks/merge', () => {
    for (const level of RISK_LEVELS) {
        const desc = RISK_DESCRIPTIONS[level];
        assert.ok(desc, `missing description for ${level}`);
        assert.ok(typeof desc.examples === 'string');
        assert.ok(typeof desc.checks === 'string');
        assert.ok(typeof desc.merge === 'string');
    }
});

test('CLASSIFICATION_RULES: covers all four risk levels', () => {
    const risks = new Set(CLASSIFICATION_RULES.map((g) => g.risk));
    for (const level of RISK_LEVELS) {
        assert.ok(risks.has(level), `no rule group for ${level}`);
    }
});

// --- globToRegExp / matchDependency -----------------------------------------

test('globToRegExp: matches literal name', () => {
    const re = globToRegExp('svgo');
    assert.ok(re.test('svgo'));
    assert.ok(!re.test('svgo2'));
});

test('globToRegExp: wildcard matches any chars including slash', () => {
    const re = globToRegExp('@types/*');
    assert.ok(re.test('@types/node'));
    assert.ok(re.test('@types/webpack/types'));
    assert.ok(!re.test('@types'));
});

test('matchDependency: literal case-insensitive', () => {
    assert.strictEqual(matchDependency('Vitest', 'vitest'), true);
    assert.strictEqual(matchDependency('vitest', 'vitest'), true);
    assert.strictEqual(matchDependency('vitest', 'jest'), false);
});

test('matchDependency: wildcard case-insensitive', () => {
    assert.strictEqual(matchDependency('@TYPES/node', '@types/*'), true);
    assert.strictEqual(matchDependency('ESLint-Plugin-Foo', 'eslint-*'), true);
    assert.strictEqual(matchDependency('eslint', 'eslint-*'), false);
});

test('matchDependency: invalid inputs return false', () => {
    assert.strictEqual(matchDependency(null, 'svgo'), false);
    assert.strictEqual(matchDependency('svgo', null), false);
    assert.strictEqual(matchDependency(undefined, '*'), false);
});

// --- classifyDependency ----------------------------------------------------

test('classifyDependency: @types/* is low', () => {
    assert.strictEqual(classifyDependency('@types/node'), 'low');
    assert.strictEqual(classifyDependency('@types/react'), 'low');
});

test('classifyDependency: eslint/prettier/stylelint tools are low', () => {
    assert.strictEqual(classifyDependency('eslint'), 'low');
    assert.strictEqual(classifyDependency('eslint-config-foo'), 'low');
    assert.strictEqual(classifyDependency('@typescript-eslint/parser'), 'low');
    assert.strictEqual(classifyDependency('prettier'), 'low');
    assert.strictEqual(classifyDependency('stylelint'), 'low');
    assert.strictEqual(classifyDependency('husky'), 'low');
    assert.strictEqual(classifyDependency('lint-staged'), 'low');
});

test('classifyDependency: test runners and bundlers are medium', () => {
    assert.strictEqual(classifyDependency('vitest'), 'medium');
    assert.strictEqual(classifyDependency('@vitest/ui'), 'medium');
    assert.strictEqual(classifyDependency('jest'), 'medium');
    assert.strictEqual(classifyDependency('@playwright/test'), 'medium');
    assert.strictEqual(classifyDependency('esbuild'), 'medium');
    assert.strictEqual(classifyDependency('webpack'), 'medium');
    assert.strictEqual(classifyDependency('vite'), 'medium');
    assert.strictEqual(classifyDependency('@swc/core'), 'medium');
});

test('classifyDependency: parsers/sanitizers/renderers/Markdown/YAML are high', () => {
    assert.strictEqual(classifyDependency('svgo'), 'high');
    assert.strictEqual(classifyDependency('ajv'), 'high');
    assert.strictEqual(classifyDependency('css-tree'), 'high');
    assert.strictEqual(classifyDependency('postcss'), 'high');
    assert.strictEqual(classifyDependency('dompurify'), 'high');
    assert.strictEqual(classifyDependency('marked'), 'high');
    assert.strictEqual(classifyDependency('markdown-it'), 'high');
    assert.strictEqual(classifyDependency('remark'), 'high');
    assert.strictEqual(classifyDependency('js-yaml'), 'high');
    assert.strictEqual(classifyDependency('cheerio'), 'high');
    assert.strictEqual(classifyDependency('@diplodoc/transform'), 'high');
});

test('classifyDependency: security-sensitive runtime is critical', () => {
    assert.strictEqual(classifyDependency('jsonwebtoken'), 'critical');
    assert.strictEqual(classifyDependency('jose'), 'critical');
    assert.strictEqual(classifyDependency('bcrypt'), 'critical');
    assert.strictEqual(classifyDependency('passport'), 'critical');
});

test('classifyDependency: unknown dependency returns null', () => {
    assert.strictEqual(classifyDependency('lodash'), null);
    assert.strictEqual(classifyDependency('axios'), null);
    assert.strictEqual(classifyDependency('some-random-pkg'), null);
});

test('classifyDependency: empty/invalid name returns null', () => {
    assert.strictEqual(classifyDependency(''), null);
    assert.strictEqual(classifyDependency(null), null);
    assert.strictEqual(classifyDependency(undefined), null);
});

// --- elevateRisk -----------------------------------------------------------

test('elevateRisk: low -> medium -> high -> critical', () => {
    assert.strictEqual(elevateRisk('low'), 'medium');
    assert.strictEqual(elevateRisk('medium'), 'high');
    assert.strictEqual(elevateRisk('high'), 'critical');
});

test('elevateRisk: critical caps at critical', () => {
    assert.strictEqual(elevateRisk('critical'), 'critical');
});

test('elevateRisk: unknown risk returned unchanged', () => {
    assert.strictEqual(elevateRisk('bogus'), 'bogus');
});

// --- riskForChange with classification -------------------------------------

test('riskForChange: classified low dep stays low on major bump', () => {
    const change = {
        name: '@types/node',
        section: 'devDependencies',
        changeType: 'changed',
        from: '^1.0.0',
        to: '^2.0.0',
    };
    assert.strictEqual(riskForChange(undefined, change), 'low');
});

test('riskForChange: classified low dep stays low on patch', () => {
    const change = {
        name: 'eslint',
        section: 'devDependencies',
        changeType: 'changed',
        from: '^8.0.0',
        to: '^8.1.0',
    };
    assert.strictEqual(riskForChange(undefined, change), 'low');
});

test('riskForChange: classified medium dep patch stays medium', () => {
    const change = {
        name: 'vitest',
        section: 'devDependencies',
        changeType: 'changed',
        from: '^1.0.0',
        to: '^1.0.1',
    };
    assert.strictEqual(riskForChange(undefined, change), 'medium');
});

test('riskForChange: classified medium dep major elevates to high', () => {
    const change = {
        name: 'vitest',
        section: 'devDependencies',
        changeType: 'changed',
        from: '^1.0.0',
        to: '^2.0.0',
    };
    assert.strictEqual(riskForChange(undefined, change), 'high');
});

test('riskForChange: classified high dep patch stays high', () => {
    const change = {
        name: 'marked',
        section: 'dependencies',
        changeType: 'changed',
        from: '^9.0.0',
        to: '^9.0.1',
    };
    assert.strictEqual(riskForChange(undefined, change), 'high');
});

test('riskForChange: classified high dep major elevates to critical', () => {
    const change = {
        name: 'marked',
        section: 'dependencies',
        changeType: 'changed',
        from: '^9.0.0',
        to: '^10.0.0',
    };
    assert.strictEqual(riskForChange(undefined, change), 'critical');
});

test('riskForChange: classified critical dep stays critical', () => {
    const change = {
        name: 'jsonwebtoken',
        section: 'dependencies',
        changeType: 'changed',
        from: '^8.0.0',
        to: '^9.0.0',
    };
    assert.strictEqual(riskForChange(undefined, change), 'critical');
});

test('riskForChange: classified dep added uses classification risk', () => {
    const added = {name: 'vitest', section: 'devDependencies', changeType: 'added'};
    assert.strictEqual(riskForChange(undefined, added), 'medium');
    const addedHigh = {name: 'svgo', section: 'dependencies', changeType: 'added'};
    assert.strictEqual(riskForChange(undefined, addedHigh), 'high');
});

test('riskForChange: classified dep removed is low', () => {
    const removed = {name: 'vitest', section: 'devDependencies', changeType: 'removed'};
    assert.strictEqual(riskForChange(undefined, removed), 'low');
});

test('riskForChange: registry risk overrides classification', () => {
    const entry = {risk: 'critical'};
    const change = {
        name: '@types/node',
        section: 'devDependencies',
        changeType: 'changed',
        from: '^1.0.0',
        to: '^1.0.1',
    };
    assert.strictEqual(riskForChange(entry, change), 'critical');
});

test('riskForChange: unclassified dep falls back to change-type default', () => {
    const change = {
        name: 'lodash',
        section: 'dependencies',
        changeType: 'changed',
        from: '^4.17.0',
        to: '^4.17.21',
    };
    assert.strictEqual(riskForChange(undefined, change), 'low');
});

test('riskForChange: no name falls back to change-type default', () => {
    assert.strictEqual(
        riskForChange(undefined, {changeType: 'changed', from: '^1.0.0', to: '^2.0.0'}),
        'high',
    );
    assert.strictEqual(riskForChange(undefined, {changeType: 'added'}), 'medium');
    assert.strictEqual(riskForChange(undefined, {changeType: 'removed'}), 'low');
});

// --- buildAssessment with classification -----------------------------------

test('buildAssessment: records classification on assessed items', () => {
    const direct = [
        {
            name: 'vitest',
            section: 'devDependencies',
            from: '^1.0.0',
            to: '^2.0.0',
            changeType: 'changed',
        },
        {
            name: '@types/node',
            section: 'devDependencies',
            from: '^1.0.0',
            to: '^2.0.0',
            changeType: 'changed',
        },
    ];
    const assessment = buildAssessment(direct, [], []);
    assert.strictEqual(assessment.direct[0].classification, 'medium');
    assert.strictEqual(assessment.direct[0].risk, 'high'); // elevated major
    assert.strictEqual(assessment.direct[1].classification, 'low');
    assert.strictEqual(assessment.direct[1].risk, 'low'); // types never elevate
    assert.strictEqual(assessment.maxRisk, 'high');
});

test('buildAssessment: unclassified dep has null classification', () => {
    const direct = [
        {
            name: 'lodash',
            section: 'dependencies',
            from: '^4.17.0',
            to: '^4.17.21',
            changeType: 'changed',
        },
    ];
    const assessment = buildAssessment(direct, [], []);
    assert.strictEqual(assessment.direct[0].classification, null);
    assert.strictEqual(assessment.direct[0].risk, 'low');
});

test('buildAssessment: high classified major bump yields critical maxRisk', () => {
    const direct = [
        {
            name: 'marked',
            section: 'dependencies',
            from: '^9.0.0',
            to: '^10.0.0',
            changeType: 'changed',
        },
    ];
    const assessment = buildAssessment(direct, [], []);
    assert.strictEqual(assessment.maxRisk, 'critical');
    assert.strictEqual(assessment.verificationProfile, 'ecosystem');
});

// --- renderComment with classification -------------------------------------

test('renderComment: includes risk levels legend', () => {
    const assessment = buildAssessment([], [], []);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('### Risk Levels'));
    assert.ok(comment.includes('types, lint-only dev tools'));
    assert.ok(comment.includes('security-sensitive runtime'));
});

test('renderComment: includes Class column for direct changes', () => {
    const direct = [
        {
            name: 'vitest',
            section: 'devDependencies',
            from: '^1.0.0',
            to: '^1.0.1',
            changeType: 'changed',
        },
    ];
    const assessment = buildAssessment(direct, [], []);
    const comment = renderComment(assessment);
    assert.ok(comment.includes('| Class |'));
    assert.ok(comment.includes('medium'));
});

test('renderComment: bolds the max risk level in the legend', () => {
    const direct = [
        {
            name: 'marked',
            section: 'dependencies',
            from: '^9.0.0',
            to: '^10.0.0',
            changeType: 'changed',
        },
    ];
    const assessment = buildAssessment(direct, [], []);
    const comment = renderComment(assessment);
    assert.ok(/\*\*critical\*\*/.test(comment));
});

module.exports = {tests};
