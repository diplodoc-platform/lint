#!/usr/bin/env node

const {execFileSync} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');

const cacheDir = mkdtempSync(join(tmpdir(), 'diplodoc-infra-npm-cache-'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
    execFileSync(npmCommand, ['pack', '--dry-run', '--ignore-scripts'], {
        cwd: join(__dirname, '..'),
        env: {...process.env, npm_config_cache: cacheDir},
        stdio: 'inherit',
    });
} finally {
    rmSync(cacheDir, {recursive: true, force: true});
}
