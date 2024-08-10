const {join} = require('node:path');
const {readFileSync, writeFileSync} = require('node:fs');

const SYSTEM = [
    '.idea',
    '.vscode',
    '.history',
    '.env',
    '.DS_Store',
];
const ARTIFACTS = [
    '/lib',
    '/dist',
    '/build',
    '/cache',
    '/coverage',
];
const INSTALL = [
    'node_modules',
];

const ignores = {
    '.gitignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
        '/.eslintrc.js',
        '/.prettierrc.js',
        '/.stylelintrc.js',
        '/.lintstagedrc.js',
        // '/.eslinignore',
        // '/.prettierignore',
        // '/.stylelintignore',
    ],
    '.eslintignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
    ],
    '.prettierignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
    ],
    '.stylelintignore': [
        ...SYSTEM,
        ...INSTALL,
        ...ARTIFACTS,
    ]
};

for (const [file, list] of Object.entries(ignores)) {
    const filename = join(process.cwd(), file);

    let source;
    try {
        source = readFileSync(filename, 'utf8').split('\n');
    } catch {
        source = [];
    }

    console.log('[@diplodoc/lint]', 'Update', file);

    for (const rule of list) {
        add(source, rule);
    }

    writeFileSync(filename, source.join('\n'), 'utf8');
}

function add(source, ignore) {
    if (!source.includes(ignore)) {
        source.push(ignore);
        console.log('[@diplodoc/lint]', '=> Add', ignore);
    }
}