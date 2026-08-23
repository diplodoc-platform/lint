#!/usr/bin/env node

'use strict';

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function listJavaScriptFiles(root) {
    const files = [];
    if (!fs.existsSync(root)) return files;
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) files.push(...listJavaScriptFiles(target));
        if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
    return files;
}

const roots = ['bin', 'scripts', 'test/unit'];
const files = roots.flatMap((root) => listJavaScriptFiles(path.resolve(root)));
for (const file of files) execFileSync(process.execPath, ['--check', file], {stdio: 'inherit'});
console.log(`Syntax checked: ${files.length} JavaScript files`);
