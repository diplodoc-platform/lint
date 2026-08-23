#!/usr/bin/env node

/**
 * enforce-exact-pin.js
 *
 * CI check that enforces the dependency policy registry: for every exact pin
 * in package.json (a version with no range operator such as `^`, `~`, `>`,
 * `<`, `*`, `x`, `latest`, `workspace:`, `file:`, `link:`, `git+`), there
 * MUST be a corresponding entry in the central `dependency-policy.yml`
 * registry that carries a `reason` and an `owner`.
 *
 * Any exact pin without a matching registry entry fails the check with a
 * clear error message referencing the missing entry.
 *
 * Runnable two ways:
 *   - As a CLI:   node scripts/enforce-exact-pin.js [--package <path>] [--base-package <path>]
 *                 [--registry <path>] [--repo <name>] [--warn-only] [--quiet]
 *   - As a module: require('./enforce-exact-pin') -> exposes pure helpers for tests.
 *
 * Environment variables (used by `infra sync` / `infra init` / `infra update`):
 *   INFRA_REPO_NAME   Repository short name (e.g. "cli"). Used to scope which
 *                     registry entries apply to this repo when filtering.
 */

const {readFileSync, existsSync} = require('node:fs');
const {join, dirname} = require('node:path');
const yaml = require('js-yaml');

const {
    resolveRegistryPath,
    repoNameFromPackage,
    filterEntriesForRepo,
} = require('./generate-dependency-policy');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * package.json sections that may contain dependencies and therefore exact pins.
 */
const DEPENDENCY_SECTIONS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
];

/**
 * Version specifiers that are NOT exact pins (range/alias operators).
 * An exact pin is a bare numeric version like "3.3.2" or "1.2.3-beta.1".
 */
const NON_PIN_PREFIXES = [
    '^',
    '~',
    '>',
    '<',
    '=',
    '*',
    'x',
    'X',
    'workspace:',
    'file:',
    'link:',
    'git+',
    'github:',
    'http:',
    'https:',
    'npm:',
];

/**
 * Bare version tag keywords that are not exact pins either.
 */
const NON_PIN_KEYWORDS = ['latest'];

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no process state)
// ---------------------------------------------------------------------------

/**
 * Determine whether a version specifier is an exact pin.
 *
 * An exact pin is a version string that starts with a digit and contains no
 * range operator (`^`, `~`, `>`, `<`, `*`, `x`, `=`, `||`). Aliases
 * (`workspace:`, `file:`, `link:`, `git+`, `github:`, `http(s):`, `npm:`)
 * and the `latest` tag are not exact pins.
 *
 * @param {string} version npm version specifier.
 * @returns {boolean} True when `version` is an exact pin.
 */
function isExactPin(version) {
    if (typeof version !== 'string' || version.length === 0) {
        return false;
    }
    const trimmed = version.trim();
    if (trimmed.length === 0) {
        return false;
    }
    for (const prefix of NON_PIN_PREFIXES) {
        if (trimmed.startsWith(prefix)) {
            return false;
        }
    }
    if (NON_PIN_KEYWORDS.includes(trimmed)) {
        return false;
    }
    // A range with `||` (e.g. "1.2.3 || 1.3.0") is not a single exact pin.
    if (trimmed.includes('||')) {
        return false;
    }
    // Wildcard components (e.g. "3.x", "1.2.X") are not exact pins.
    if (/\d[.-]x/i.test(trimmed)) {
        return false;
    }
    // An exact pin must begin with a digit.
    return /^\d/.test(trimmed);
}

/**
 * Extract every exact pin from a parsed package.json object.
 *
 * Returns an array of descriptors `{ name, version, section }` for each
 * exact-pinned dependency across all dependency sections.
 *
 * @param {object} packageJson Parsed package.json.
 * @returns {Array<{name: string, version: string, section: string}>}
 */
function extractExactPins(packageJson) {
    const pins = [];
    if (!packageJson || typeof packageJson !== 'object') {
        return pins;
    }
    for (const section of DEPENDENCY_SECTIONS) {
        const deps = packageJson[section];
        if (!deps || typeof deps !== 'object') {
            continue;
        }
        for (const [name, version] of Object.entries(deps)) {
            if (isExactPin(version)) {
                pins.push({name, version: version.trim(), section});
            }
        }
    }
    return pins;
}

/**
 * Find the registry entry that applies to a given exact pin.
 *
 * An entry matches when its `dependency` equals the pin name and either:
 *   - it has no `allowed-version` (covers any pinned version of the dep), or
 *   - its `allowed-version` (stringified) equals the pinned version.
 * When `repoName` is provided, the candidate set is first scoped to entries
 * applicable to that repository (entries with a `repositories` list that
 * includes the repo, or entries with no `repositories` list at all).
 *
 * @param {Array<object>} entries Registry entries (already scoped to the repo
 *     when `repoName` is given — pass the full list to use global matching).
 * @param {string} depName Pinned dependency name.
 * @param {string} version Pinned version (exact, trimmed).
 * @returns {object|undefined} Matching entry or undefined.
 */
function findRegistryEntry(entries, depName, version) {
    if (!Array.isArray(entries)) {
        return undefined;
    }
    return entries.find((entry) => {
        if (!entry || entry.dependency !== depName) {
            return false;
        }
        const allowed = entry['allowed-version'];
        if (allowed === undefined || allowed === null || allowed === '') {
            return true;
        }
        return String(allowed).trim() === String(version).trim();
    });
}

/**
 * Validate that a registry entry has the mandatory `reason` and `owner`
 * fields required for an exact-pin exception.
 *
 * @param {object} entry Registry entry.
 * @returns {Array<string>} List of missing mandatory fields (empty when valid).
 */
function missingMandatoryFields(entry) {
    const missing = [];
    if (!entry || typeof entry !== 'object') {
        return ['reason', 'owner'];
    }
    if (!entry.reason || String(entry.reason).trim() === '') {
        missing.push('reason');
    }
    if (!entry.owner || String(entry.owner).trim() === '') {
        missing.push('owner');
    }
    return missing;
}

/**
 * Run the enforcement: compare every exact pin in a package.json against the
 * scoped registry entries and return a result object describing violations.
 *
 * @param {object} packageJson Parsed package.json.
 * @param {object} registry Parsed central registry (`{entries: [...]}`).
 * @param {string} [repoName] Repository short name (scopes entries).
 * @returns {{violations: Array<object>, checked: number, ok: boolean}}
 */
function enforce(packageJson, registry, repoName) {
    const pins = extractExactPins(packageJson);
    const allEntries = registry && Array.isArray(registry.entries) ? registry.entries : [];
    const scopedEntries = repoName ? filterEntriesForRepo(allEntries, repoName) : allEntries;

    const violations = [];
    for (const pin of pins) {
        const entry = findRegistryEntry(scopedEntries, pin.name, pin.version);
        if (!entry) {
            violations.push({
                name: pin.name,
                version: pin.version,
                section: pin.section,
                reason: 'no matching registry entry',
            });
            continue;
        }
        const missing = missingMandatoryFields(entry);
        if (missing.length > 0) {
            violations.push({
                name: pin.name,
                version: pin.version,
                section: pin.section,
                reason: `registry entry ${entry.id || '(no id)'} missing mandatory fields: ${missing.join(', ')}`,
            });
        }
    }

    return {
        checked: pins.length,
        violations,
        ok: violations.length === 0,
    };
}

/**
 * Enforce the registry only for exact pins introduced or changed by a patch.
 * Existing exact pins are rollout baseline, not newly-created exceptions. This
 * keeps the first infrastructure rollout from failing every repository while
 * still preventing new undocumented pins.
 *
 * @param {object} beforePackageJson package.json from the target branch.
 * @param {object} afterPackageJson package.json from the proposed revision.
 * @param {object} registry Parsed central registry.
 * @param {string} [repoName] Repository short name.
 * @returns {{violations: Array<object>, checked: number, existing: number, ok: boolean}}
 */
function enforceChanges(beforePackageJson, afterPackageJson, registry, repoName) {
    const beforePins = new Map(
        extractExactPins(beforePackageJson).map((pin) => [
            `${pin.section}\0${pin.name}`,
            pin.version,
        ]),
    );
    const introducedPins = extractExactPins(afterPackageJson).filter((pin) => {
        return beforePins.get(`${pin.section}\0${pin.name}`) !== pin.version;
    });
    const packageWithIntroducedPins = {};
    for (const pin of introducedPins) {
        packageWithIntroducedPins[pin.section] ||= {};
        packageWithIntroducedPins[pin.section][pin.name] = pin.version;
    }
    const result = enforce(packageWithIntroducedPins, registry, repoName);
    return {
        ...result,
        existing: extractExactPins(afterPackageJson).length - introducedPins.length,
    };
}

/**
 * Render violations as human-readable error lines.
 *
 * @param {Array<object>} violations Violations from `enforce`.
 * @returns {string} Multi-line error message.
 */
function formatViolations(violations) {
    if (!Array.isArray(violations) || violations.length === 0) {
        return '';
    }
    const lines = [];
    for (const v of violations) {
        lines.push(
            `  - "${v.name}" pinned to "${v.version}" in ${v.section}: ${v.reason}. ` +
                `Add an entry to devops/infra/dependency-policy.yml (id DEP-NNNN) with reason, owner, ` +
                `allowed-version: ${v.version}, and the repositories list including this repo.`,
        );
    }
    return lines.join('\n');
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

    const packagePath = flags.package || join(process.cwd(), 'package.json');
    const basePackagePath =
        typeof flags['base-package'] === 'string' ? flags['base-package'] : null;
    const registryPath = resolveRegistryPath(flags.registry);
    let repoName = flags.repo || process.env.INFRA_REPO_NAME || '';

    if (!existsSync(packagePath)) {
        console.error(`[@diplodoc/infra] package.json not found at ${packagePath}`);
        process.exit(1);
    }
    if (!existsSync(registryPath)) {
        console.error(`[@diplodoc/infra] Central registry not found at ${registryPath}`);
        process.exit(1);
    }

    let packageJson;
    try {
        packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    } catch (error) {
        console.error(`[@diplodoc/infra] Failed to parse package.json: ${error.message}`);
        process.exit(1);
    }

    const registry = yaml.load(readFileSync(registryPath, 'utf8')) || {};

    if (!repoName) {
        repoName = repoNameFromPackage(packageJson.name || '');
    }

    let result;
    if (basePackagePath) {
        if (!existsSync(basePackagePath)) {
            console.error(`[@diplodoc/infra] Base package.json not found at ${basePackagePath}`);
            process.exit(1);
        }
        let basePackageJson;
        try {
            basePackageJson = JSON.parse(readFileSync(basePackagePath, 'utf8'));
        } catch (error) {
            console.error(`[@diplodoc/infra] Failed to parse base package.json: ${error.message}`);
            process.exit(1);
        }
        result = enforceChanges(basePackageJson, packageJson, registry, repoName);
    } else {
        result = enforce(packageJson, registry, repoName);
    }

    if (result.ok) {
        console.log(
            `[@diplodoc/infra] Dependency policy check passed: ${result.checked} exact pin${result.checked === 1 ? '' : 's'} verified${repoName ? ` for "${repoName}"` : ''}.`,
        );
        process.exit(0);
    }

    console.error(
        `[@diplodoc/infra] Dependency policy check FAILED: ${result.violations.length} unregistered exact pin${result.violations.length === 1 ? '' : 's'}:\n` +
            formatViolations(result.violations),
    );
    if (flags['warn-only'] === true) {
        console.error(
            '[@diplodoc/infra] Warning-only mode: continuing rollout despite legacy pins.',
        );
        process.exit(0);
    }
    process.exit(1);
}

module.exports = {
    isExactPin,
    extractExactPins,
    findRegistryEntry,
    missingMandatoryFields,
    enforce,
    enforceChanges,
    formatViolations,
    DEPENDENCY_SECTIONS,
};
