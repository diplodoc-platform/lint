const {join} = require('node:path');
const {readFileSync, writeFileSync} = require('node:fs');

const filename = join(process.cwd(), 'package.json');

let pkg;
try {
    pkg = JSON.parse(readFileSync(filename));
} catch {
    throw 'Unable to modify ' + filename;
}

// Patterns of legacy script values that should be automatically upgraded to the
// current standard. These come from the pull-distribution era (`lint update && ...`)
// and from the renamed package (`@diplodoc/lint`).
// Each entry: regex that matches a known legacy form. If the current value matches,
// it's safe to overwrite without warning.
const LEGACY_PATTERNS = {
    lint: [/^lint update && lint$/, /^@diplodoc\/(lint|infra) update && lint$/],
    'lint:fix': [
        /^lint update && lint fix$/,
        /^lint update && lint:fix$/,
        /^@diplodoc\/(lint|infra) update && lint fix$/,
    ],
    'pre-commit': [
        /^lint update && lint-staged$/,
        /^@diplodoc\/(lint|infra) update && lint-staged$/,
    ],
};

function configure(command, impl, {force = false} = {}) {
    if (!pkg.scripts) {
        pkg.scripts = {};
    }

    const current = pkg.scripts[command];

    if (!current) {
        pkg.scripts[command] = impl;
        console.log('[@diplodoc/infra]', '=> Add', command, 'script');
        return;
    }

    if (current === impl) {
        return;
    }

    if (force) {
        pkg.scripts[command] = impl;
        console.log('[@diplodoc/infra]', '=> Update', command, 'script (forced)');
        return;
    }

    // Migrate known legacy values to the standard one.
    const knownLegacy = (LEGACY_PATTERNS[command] || []).some((re) => re.test(current));
    if (knownLegacy) {
        pkg.scripts[command] = impl;
        console.log(
            '[@diplodoc/infra]',
            '=> Migrate',
            command,
            `script: "${current}" -> "${impl}"`,
        );
        return;
    }

    // Unknown customization — keep it, but warn so the maintainer notices.
    console.warn(
        `[@diplodoc/infra] WARNING: script "${command}" is customized ("${current}"), ` +
            `expected "${impl}". Leaving as-is. ` +
            `If this is intentional, ignore this message. Otherwise, set it to the standard value manually.`,
    );
}

configure('lint', 'lint');
configure('lint:fix', 'lint fix');
configure('pre-commit', 'lint-staged');
configure('prepare', 'husky || true', {force: true});
configure('lock', 'npm install --no-workspaces --package-lock-only --ignore-scripts');

writeFileSync(filename, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
