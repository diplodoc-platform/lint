const {join} = require('node:path');
const {readFileSync, writeFileSync} = require('node:fs');

const filename = join(process.cwd(), 'package.json');

let pkg;
try {
    pkg = JSON.parse(readFileSync(filename));
} catch {
    throw 'Unable to modify ' + filename;
}

function configure(command, impl, strict = true) {
    if (pkg.scripts[command]) {
        if (pkg.scripts[command] !== impl && strict) {
            throw `Lint command '${command}' already configured with different program`;
        }
    } else {
        pkg.scripts[command] = impl;
        console.log('[@diplodoc/lint]', '=> Add', command, 'script');
    }
}

configure('lint', 'lint init && lint');
configure('lint:fix', 'lint init && lint fix');
configure('pre-commit', 'lint init && lint-staged');
configure('prepare', 'husky install || true', false);

writeFileSync(filename, JSON.stringify(pkg, null, 2), 'utf8');