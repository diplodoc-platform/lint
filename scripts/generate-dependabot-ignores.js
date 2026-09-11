#!/usr/bin/env node

/**
 * generate-dependabot-ignores.js
 *
 * Auto-generates `ignore` entries in dependabot.yml from the central
 * dependency-policy.yml registry. Manual and wildcard ignores are
 * prohibited — only specific proven problematic versions from the
 * registry's `ignored-versions` field are emitted, ensuring Dependabot
 * raises a new PR when a subsequent version is released.
 *
 * The dependabot.yml template contains marker comments (`# @generated-ignore`)
 * in the npm update block. This script replaces that marker with a YAML
 * `ignore:` sections containing only `dependency-name` + `versions` entries
 * sourced from the registry (filtered by the target repository).
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/generate-dependabot-ignores.js [--repo <name>] [--registry <path>] [--target <dir>]
 *   - As a module: require('./generate-dependabot-ignores') -> exposes pure helpers for tests.
 *
 * Environment variables (used by `infra sync` / `infra init` / `infra update`):
 *   INFRA_REPO_NAME   Repository short name (e.g. "cli"). Falls back to deriving
 *                     from package.json name (stripping the @diplodoc scope).
 *   INFRA_TARGET_DIR  Target directory containing .github/dependabot.yml (default: process.cwd()).
 */

const {readFileSync, writeFileSync, existsSync} = require('node:fs');
const {join, dirname} = require('node:path');
const yaml = require('js-yaml');

const {
    resolveRegistryPath,
    filterEntriesForRepo,
    repoNameFromPackage,
} = require('./generate-dependency-policy');

const MARKER = '# @generated-ignore';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no process state)
// ---------------------------------------------------------------------------

/**
 * Build ignore entries from registry entries that have a non-empty
 * `ignored-versions` array. Each entry produces a `{dependency-name, versions}`
 * pair — no wildcards, no `update-types`.
 *
 * @param {Array<object>} entries Registry entries (already filtered for repo).
 * @returns {Array<object>} Ignore entries with `dependency-name` and `versions`.
 */
function buildIgnoreEntries(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries
        .filter((e) => Array.isArray(e['ignored-versions']) && e['ignored-versions'].length > 0)
        .map((e) => ({
            'dependency-name': e.dependency,
            versions: e['ignored-versions'].map((v) => String(v).trim()),
        }));
}

/**
 * Serialize ignore entries to YAML text with the given base indentation.
 * Produces a complete `ignore:` block. Returns an empty string when there
 * are no entries (the marker is then replaced with a harmless comment).
 *
 * @param {Array<object>} entries Ignore entries from `buildIgnoreEntries`.
 * @param {number} [indent=4] Base indentation in spaces.
 * @returns {string} YAML text for the `ignore:` block (no trailing newline).
 */
function serializeIgnoreEntries(entries, indent) {
    const baseIndent = ' '.repeat(indent || 4);
    if (!entries || entries.length === 0) {
        return `${baseIndent}# (no registry-based ignores for this repo)`;
    }
    const lines = [`${baseIndent}ignore:`];
    for (const entry of entries) {
        lines.push(`${baseIndent}  - dependency-name: '${entry['dependency-name']}'`);
        lines.push(`${baseIndent}    versions:`);
        for (const v of entry.versions) {
            lines.push(`${baseIndent}      - '${v}'`);
        }
    }
    return lines.join('\n');
}

/**
 * Replace every `# @generated-ignore` marker line in the dependabot.yml
 * content with the corresponding YAML block from `perBlockYaml`. The entire
 * marker line (including leading whitespace) is replaced, so the fragment
 * must include its own base indentation. Markers are replaced in order.
 *
 * @param {string} content The dependabot.yml file content.
 * @param {Array<string>} perBlockYaml One YAML fragment per update block.
 * @returns {string} Updated content with markers replaced.
 */
function injectIntoTemplate(content, perBlockYaml) {
    let result = content;
    for (const fragment of perBlockYaml) {
        result = result.replace(/^[ \t]*# @generated-ignore$/m, fragment || '');
    }
    return result;
}

/**
 * Generate per-block ignore YAML fragments from the central registry for a
 * given repository. The same ignore entries apply to all update blocks
 * (patch/minor/major) because `ignored-versions` are version-specific,
 * not update-type-specific.
 *
 * @param {object} registry Parsed central registry.
 * @param {string} repoName Repository short name.
 * @param {number} [numBlocks=1] Number of update blocks in dependabot.yml.
 * @returns {Array<string>} Array of YAML fragments (one per block).
 */
function generatePerRepoIgnores(registry, repoName, numBlocks) {
    const count = numBlocks || 1;
    const allEntries = registry.entries || [];
    const repoEntries = filterEntriesForRepo(allEntries, repoName);
    const ignoreEntries = buildIgnoreEntries(repoEntries);
    const fragment = serializeIgnoreEntries(ignoreEntries);
    return Array.from({length: count}, () => fragment);
}

/**
 * Validate that a dependabot.yml content contains no manual or wildcard
 * `ignore` entries (i.e. no `dependency-name: '*'` and no `update-types`
 * inside `ignore`). This is a sanity check after generation.
 *
 * @param {string} content The dependabot.yml file content.
 * @returns {boolean} True if no wildcard/manual ignores are found.
 */
function hasNoWildcardIgnores(content) {
    const parsed = yaml.load(content);
    if (!parsed || !Array.isArray(parsed.updates)) {
        return true;
    }
    for (const block of parsed.updates) {
        if (!Array.isArray(block.ignore)) {
            continue;
        }
        for (const entry of block.ignore) {
            if (entry['dependency-name'] === '*' || entry['dependency-name'] === "'*'") {
                return false;
            }
            if (Array.isArray(entry['update-types']) && entry['update-types'].length > 0) {
                return false;
            }
        }
    }
    return true;
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

    const dependabotPath = join(targetDir, '.github', 'dependabot.yml');
    if (!existsSync(dependabotPath)) {
        console.error(`[@diplodoc/infra] dependabot.yml not found at ${dependabotPath}`);
        process.exit(1);
    }

    const registry = yaml.load(readFileSync(registryPath, 'utf8')) || {};
    const dependabotContent = readFileSync(dependabotPath, 'utf8');

    const markerCount = (dependabotContent.match(/^[ \t]*# @generated-ignore$/gm) || []).length;
    if (markerCount === 0) {
        console.log(
            `[@diplodoc/infra] No @generated-ignore markers found in dependabot.yml — nothing to do.`,
        );
        process.exit(0);
    }

    const perBlockYaml = generatePerRepoIgnores(registry, repoName, markerCount);
    const updated = injectIntoTemplate(dependabotContent, perBlockYaml);

    writeFileSync(dependabotPath, updated, 'utf8');

    const allEntries = registry.entries || [];
    const repoEntries = filterEntriesForRepo(allEntries, repoName);
    const ignoreEntries = buildIgnoreEntries(repoEntries);
    const count = ignoreEntries.length;

    console.log(
        `[@diplodoc/infra] Generated dependabot.yml ignores for "${repoName}" ` +
            `(${count} dependenc${count === 1 ? 'y' : 'ies'} with ignored-versions, ` +
            `${markerCount} block${markerCount === 1 ? '' : 's'} updated).`,
    );
}

module.exports = {
    buildIgnoreEntries,
    serializeIgnoreEntries,
    injectIntoTemplate,
    generatePerRepoIgnores,
    hasNoWildcardIgnores,
    MARKER,
};
