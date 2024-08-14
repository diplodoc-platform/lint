const {join} = require('node:path');
const {readFileSync, writeFileSync} = require('node:fs');

const filename = join(process.cwd(), 'package.json');

let pkg;
try {
    pkg = JSON.parse(readFileSync(filename));
} catch {
    throw 'Unable to modify ' + filename;
}

function configure(command, impl, force = false) {
    if (pkg.scripts[command] && !force) {
        if (pkg.scripts[command] !== impl) {
            throw `Lint command '${command}' already configured with different program`;
        }
    } else {
        pkg.scripts[command] = impl;
        console.log('[@diplodoc/lint]', '=> Add', command, 'script');
    }
}

configure('lint', 'lint update && lint');
configure('lint:fix', 'lint update && lint fix');
configure('pre-commit', 'lint update && lint-staged');
configure('prepare', 'husky || true', true);

writeFileSync(filename, JSON.stringify(pkg, null, 2), 'utf8');