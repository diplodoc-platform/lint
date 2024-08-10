const filename = process.cwd() + '/package.json';
const {readFileSync, writeFileSync} = require('fs');

let pkg;
try {
    pkg = JSON.parse(readFileSync(filename));
} catch {
    throw 'Unable to modify ' + filename;
}

function configure(command, impl) {
    if (pkg.scripts[command]) {
        if (pkg.scripts[command] !== impl) {
            throw `Lint command '${command}' already configured with different program`;
        }
    } else {
        pkg.scripts[command] = impl;
        console.log('=> Add', command, 'script');
    }
}

configure('lint', 'lint init && lint');
configure('lint:fix', 'lint init && lint fix');
configure('pre-commit', 'lint init && lint-staged');
configure('prepare', 'husky install || true');

writeFileSync(filename, JSON.stringify(pkg, null, 2), 'utf8');