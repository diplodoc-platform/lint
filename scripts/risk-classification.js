#!/usr/bin/env node

/**
 * risk-classification.js
 *
 * Dependency risk classification for Diplodoc Dependabot PRs.
 *
 * Maps a dependency (by name + package.json section) to one of four risk
 * levels, independently of the bump size.  The classification is a
 * middle layer between the explicit policy registry (`risk` field on a
 * registry entry) and the change-type fallback (patch/minor/major).
 *
 * Risk levels (from PLAN.md / T6.2):
 *
 *   | Risk     | Examples                              | Checks                    | Merge                  |
 *   |----------|---------------------------------------|---------------------------|------------------------|
 *   | low      | types, lint-only dev tools            | standard CI               | auto-merge possible    |
 *   | medium   | test runners, bundlers, SDK patch      | standard + integration    | human or delayed auto  |
 *   | high     | parsers, sanitizers, renderers, CLI,   | document-transform        | human only             |
 *   |          | svgo, Markdown/YAML                   |                           |                        |
 *   | critical | security-sensitive runtime,           | all checks + security     | assigned owner         |
 *   |          | major core                            | review                    |                        |
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/risk-classification.js --name <pkg> [--section <s>]
 *   - As a module: require('./risk-classification') -> pure helpers for tests.
 *
 * Flags:
 *   --name <package>    Dependency package name (required)
 *   --section <section> package.json section (dependencies | devDependencies | ...)
 *   --json              Emit JSON result
 */

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

/**
 * Ordered risk weights (low < medium < high < critical).
 */
const RISK_WEIGHT = {low: 0, medium: 1, high: 2, critical: 3};

/**
 * Human-readable description of each risk level, used by the review
 * comment and any tooling that surfaces the classification.
 */
const RISK_DESCRIPTIONS = {
    low: {
        examples: 'types, lint-only dev tools',
        checks: 'standard CI',
        merge: 'auto-merge possible',
    },
    medium: {
        examples: 'test runners, bundlers, SDK patch',
        checks: 'standard + integration',
        merge: 'human or delayed auto',
    },
    high: {
        examples: 'parsers, sanitizers, renderers, CLI, svgo, Markdown/YAML',
        checks: 'document-transform profile',
        merge: 'human only',
    },
    critical: {
        examples: 'security-sensitive runtime, major core',
        checks: 'all checks + security review',
        merge: 'assigned owner',
    },
};

/**
 * Pattern groups mapping a dependency category to its base risk.
 * Patterns are matched against the bare dependency name (with scope).
 *
 * Matching is case-insensitive.  Each group is an array of matchers;
 * a matcher is either a glob (with `*` matching any run of characters
 * including `/`) or a literal package name.
 */
const CLASSIFICATION_RULES = [
    {
        risk: 'low',
        matchers: [
            '@types/*',
            '@typescript-eslint/*',
            'eslint',
            'eslint-*',
            '@eslint/*',
            'prettier',
            'prettier-*',
            '@prettier/*',
            'stylelint',
            'stylelint-*',
            '@stylelint/*',
            'husky',
            'lint-staged',
            '@diplodoc/tsconfig',
            'editorconfig',
            '@commitlint/*',
            'commitlint',
            'conventional-changelog-*',
            '@conventional-changelog/*',
        ],
    },
    {
        risk: 'medium',
        matchers: [
            'vitest',
            '@vitest/*',
            'jest',
            '@jest/*',
            'mocha',
            'chai',
            'sinon',
            'playwright',
            '@playwright/*',
            'esbuild',
            'webpack',
            'rollup',
            '@rollup/*',
            'vite',
            'vite-*',
            '@vitejs/*',
            'swc',
            '@swc/*',
            '@babel/*',
            'babel',
            'c8',
            'nyc',
            'istanbul',
            'istanbul-*',
            '@istanbuljs/*',
            'tsup',
            'turbo',
            '@turbo/*',
            'nx',
            '@nx/*',
        ],
    },
    {
        risk: 'high',
        matchers: [
            'svgo',
            'ajv',
            '@ajv/*',
            'css-tree',
            '@css-tree/*',
            'postcss',
            'autoprefixer',
            'dompurify',
            'sanitize-*',
            'xss',
            'marked',
            'markdown-it',
            'markdown-it-*',
            'remark',
            'remark-*',
            'rehype',
            'rehype-*',
            'unified',
            'micromark',
            '@micromark/*',
            'mdast-*',
            'hast-*',
            'js-yaml',
            'yaml',
            'cheerio',
            'acorn',
            'esprima',
            '@diplodoc/cli',
            '@diplodoc/transform',
            '@diplodoc/components',
        ],
    },
    {
        risk: 'critical',
        matchers: [
            'jsonwebtoken',
            'jose',
            'bcrypt',
            'bcryptjs',
            'passport',
            'passport-*',
            'oauth*',
            '@octokit/auth-*',
            'argon2',
        ],
    },
];

/**
 * Compile a glob matcher into a RegExp.  `*` matches any run of
 * characters (including `/`); all other characters are escaped.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withWild = escaped.replace(/\*/g, '.*');
    return new RegExp('^' + withWild + '$', 'i');
}

/**
 * Test whether a dependency name matches a glob pattern
 * (case-insensitive, `*` matches any characters including `/`).
 *
 * @param {string} name    Dependency name.
 * @param {string} pattern  Glob pattern or literal name.
 * @returns {boolean}
 */
function matchDependency(name, pattern) {
    if (typeof name !== 'string' || typeof pattern !== 'string') {
        return false;
    }
    if (!pattern.includes('*')) {
        return name.toLowerCase() === pattern.toLowerCase();
    }
    return globToRegExp(pattern).test(name);
}

/**
 * Classify a dependency by name (and optionally the package.json section
 * it lives in) into one of the four risk levels.
 *
 * Returns `null` when no classification rule matches, signalling the
 * caller to fall back to change-type based defaults.
 *
 * @param {string} name        Dependency package name.
 * @param {string} [section]   package.json section (dependencies, devDependencies, ...).
 * @returns {string|null} Risk level (low | medium | high | critical) or null.
 */
function classifyDependency(name, section) {
    if (typeof name !== 'string' || name.length === 0) {
        return null;
    }

    for (const group of CLASSIFICATION_RULES) {
        for (const matcher of group.matchers) {
            if (matchDependency(name, matcher)) {
                return group.risk;
            }
        }
    }

    return null;
}

/**
 * Elevate a risk level by one step (capped at critical).
 *
 * @param {string} risk
 * @returns {string}
 */
function elevateRisk(risk) {
    const order = ['low', 'medium', 'high', 'critical'];
    const idx = order.indexOf(risk);
    if (idx === -1) {
        return risk;
    }
    return order[Math.min(idx + 1, order.length - 1)];
}

module.exports = {
    RISK_LEVELS,
    RISK_WEIGHT,
    RISK_DESCRIPTIONS,
    CLASSIFICATION_RULES,
    globToRegExp,
    matchDependency,
    classifyDependency,
    elevateRisk,
};
