#!/usr/bin/env node

/**
 * generate-dependency-policy.js
 *
 * Generates a per-repository `.github/dependency-policy.yml` from the central
 * `dependency-policy.yml` registry shipped with @diplodoc/infra.
 *
 * The central registry is the single source of truth; this script projects it
 * down to only the entries that apply to a given repository (matched by the
 * `repositories` field on each entry). The resulting local file is what CI
 * checks and workflows read, while the central file remains authoritative.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/generate-dependency-policy.js [--repo <name>] [--registry <path>] [--target <dir>]
 *   - As a module: require('./generate-dependency-policy') -> exposes pure helpers for tests.
 *
 * Environment variables (used by `infra sync` / `infra init` / `infra update`):
 *   INFRA_REPO_NAME   Repository short name (e.g. "cli"). Falls back to deriving
 *                     from package.json name (stripping the @diplodoc scope).
 *   INFRA_TARGET_DIR  Output directory (default: process.cwd()).
 */

const {readFileSync, writeFileSync, existsSync, mkdirSync} = require('node:fs');
const {join, dirname} = require('node:path');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no process state)
// ---------------------------------------------------------------------------

/**
 * Resolve the central registry path, using the same fallback strategy as
 * copy-scaffolding.js: try the package root relative to this script, then
 * require.resolve('@diplodoc/infra/package.json'), then walk up.
 *
 * @param {string} [explicit] Explicit path override (CLI --registry).
 * @returns {string} Absolute path to dependency-policy.yml.
 */
function resolveRegistryPath(explicit) {
    if (explicit) {
        return explicit;
    }
    const candidate = join(__dirname, '..', 'dependency-policy.yml');
    if (existsSync(candidate)) {
        return candidate;
    }
    try {
        const packageJsonPath = require.resolve('@diplodoc/infra/package.json');
        return join(dirname(packageJsonPath), 'dependency-policy.yml');
    } catch {
        let currentDir = __dirname;
        for (let i = 0; i < 5; i++) {
            const test = join(currentDir, 'dependency-policy.yml');
            if (existsSync(test)) {
                return test;
            }
            const parent = dirname(currentDir);
            if (parent === currentDir) {
                break;
            }
            currentDir = parent;
        }
    }
    return candidate;
}

/**
 * Derive the repository short name from a package.json name by stripping the
 * `@diplodoc/` scope prefix. Returns the original name if no scope is present.
 *
 * @param {string} packageName e.g. "@diplodoc/cli" or "cli"
 * @returns {string} e.g. "cli"
 */
function repoNameFromPackage(packageName) {
    if (typeof packageName !== 'string' || packageName.length === 0) {
        return '';
    }
    return packageName.replace(/^@[^/]+\//, '');
}

/**
 * Filter registry entries to only those applicable to a given repository.
 * An entry applies when its `repositories` list is missing (applies to all)
 * or explicitly includes the repo name.
 *
 * @param {Array<object>} entries Registry entries.
 * @param {string} repoName Repository short name.
 * @returns {Array<object>} Filtered entries (new array, entries not cloned).
 */
function filterEntriesForRepo(entries, repoName) {
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries.filter((entry) => {
        const repos = entry.repositories;
        if (!Array.isArray(repos) || repos.length === 0) {
            return true;
        }
        return repos.includes(repoName);
    });
}

/**
 * Build the per-repo policy object from the central registry.
 * Preserves schema-version and registry-owner; projects entries.
 *
 * @param {object} registry Parsed central registry.
 * @param {string} repoName Repository short name.
 * @returns {object} Per-repo policy object.
 */
function buildRepoPolicy(registry, repoName) {
    const allEntries = registry.entries || [];
    const entries = filterEntriesForRepo(allEntries, repoName);
    return {
        'schema-version': registry['schema-version'] || '1.0',
        'registry-owner': registry['registry-owner'] || '',
        'generated-for': repoName,
        'generated-from': 'central dependency-policy.yml',
        entries,
    };
}

/**
 * Serialize the per-repo policy to YAML with a header comment.
 *
 * @param {object} policy Per-repo policy object.
 * @returns {string} YAML document with leading comment.
 */
function serializeRepoPolicy(policy) {
    const header =
        '# ============================================================================\n' +
        '# Per-repository dependency policy (AUTO-GENERATED — do not edit)\n' +
        '# Source of truth: @diplodoc/infra/dependency-policy.yml\n' +
        '# Regenerated on every infra init/update/sync. Manual edits will be lost.\n' +
        '# ============================================================================\n\n';
    const body = yaml.dump(policy, {sortKeys: false, lineWidth: 120});
    return header + body;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
        }
    }

    const targetDir = flags.target || process.env.INFRA_TARGET_DIR || process.cwd();
    let repoName = flags.repo || process.env.INFRA_REPO_NAME || '';

    if (!repoName) {
        const pkgPath = join(targetDir, 'package.json');
        if (existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
                repoName = repoNameFromPackage(pkg.name || '');
            } catch {
                // leave empty
            }
        }
    }

    if (!repoName) {
        console.error(
            '[@diplodoc/infra] Could not determine repository name. ' +
                'Use --repo <name>, set INFRA_REPO_NAME, or run in a directory with package.json.',
        );
        process.exit(1);
    }

    const registryPath = resolveRegistryPath(flags.registry);
    if (!existsSync(registryPath)) {
        console.error(`[@diplodoc/infra] Central registry not found at ${registryPath}`);
        process.exit(1);
    }

    const registry = yaml.load(readFileSync(registryPath, 'utf8')) || {};
    const policy = buildRepoPolicy(registry, repoName);
    const serialized = serializeRepoPolicy(policy);

    const outDir = join(targetDir, '.github');
    if (!existsSync(outDir)) {
        mkdirSync(outDir, {recursive: true});
    }
    const outPath = join(outDir, 'dependency-policy.yml');
    writeFileSync(outPath, serialized, 'utf8');

    const count = policy.entries.length;
    console.log(
        `[@diplodoc/infra] Generated .github/dependency-policy.yml for "${repoName}" (${count} entr${count === 1 ? 'y' : 'ies'}).`,
    );
}

module.exports = {
    resolveRegistryPath,
    repoNameFromPackage,
    filterEntriesForRepo,
    buildRepoPolicy,
    serializeRepoPolicy,
};
