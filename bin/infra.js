#!/usr/bin/env node

const {execSync, execFileSync} = require('node:child_process');
const {realpathSync, readFileSync, existsSync, writeFileSync, mkdirSync} = require('node:fs');
const {dirname, join, resolve} = require('node:path');
const yaml = require('js-yaml');

const scriptPath = realpathSync(__filename);
const srcDir = dirname(dirname(scriptPath));
const binDir = join(srcDir, 'bin');

const args = process.argv.slice(2);
const command = args[0];

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'sh' : 'bash';

const flags = {};
for (let i = 1; i < args.length; i++) {
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

function execCommand(cmd, options = {}) {
    try {
        return execSync(cmd, {
            stdio: 'inherit',
            shell,
            cwd: process.cwd(),
            ...options,
        });
    } catch (error) {
        process.exit(error.status || 1);
    }
}

function loadYaml(filePath) {
    const content = readFileSync(filePath, 'utf8');
    return yaml.load(content) || {};
}

function loadInfrarc(targetDir) {
    const infrarcPath = join(targetDir, '.infrarc.yml');
    if (!existsSync(infrarcPath)) return [];

    const config = loadYaml(infrarcPath);
    return config.exclude || [];
}

function loadBlacklist(repoName, targetDir, configPath) {
    let centralExcludes = [];

    if (configPath && existsSync(configPath)) {
        const config = loadYaml(configPath);
        const repoConfig = config.repos?.[repoName];
        centralExcludes = repoConfig?.exclude || [];
    }

    const localExcludes = loadInfrarc(targetDir);

    const now = new Date();
    return [...centralExcludes, ...localExcludes]
        .map((entry) => (typeof entry === 'string' ? {path: entry} : entry))
        .filter((entry) => !entry.until || new Date(entry.until) > now);
}

function getRepoConfig(repoName, configPath) {
    if (!configPath || !existsSync(configPath)) return {};
    const config = loadYaml(configPath);
    const defaults = config.defaults || {};
    const repoConfig = config.repos?.[repoName] || {};
    return {...defaults, ...repoConfig};
}

function getAllRepos(configPath) {
    if (!configPath || !existsSync(configPath)) return [];
    const config = loadYaml(configPath);
    return Object.keys(config.repos || {});
}

function showHelp() {
    console.log(`
@diplodoc/infra — Infrastructure management CLI

Usage:
  infra init                Initialize infrastructure in current package
  infra update              Update scaffolding in current package
  infra sync                Distribute infrastructure to target repositories
  infra gate sync           Sync the "master CI gate" ruleset with each repo's checks
  infra policy check        Enforce exact-pin registry against package.json
  infra policy review       Risk-assess dependency changes between two package.json/lockfile snapshots
  infra dependabot ignores   Auto-generate dependabot.yml ignore entries from registry
  infra inventory export    Export all open Dependabot PRs to an inventory
  infra health audit        Audit dependency health (SLA) across all repositories
  infra health summary      Generate daily dependency health summary (7 categories)
  infra health assign      Auto-assign owners to SLA-breaching PRs and update tracking issue
  infra automerge rules     Print the 9 auto-merge conditions + exclusion list
  infra automerge evaluate  Evaluate a JSON file against the auto-merge rules
  infra automerge run       Run the auto-merge workflow (evaluate + merge qualifying PRs)
  infra blacklist show      Show blacklist for a repository
  infra blacklist audit     Check for expired exclusions

Sync options:
  --target <path>           Apply scaffolding to a local directory
  --repo <name>             Target a specific repository
  --all                     Target all repositories from distribution.yml
  --dry-run                 Show diff without creating PRs
  --config <path>           Path to distribution.yml (default: ./distribution.yml)
  --output <path>           Output diff report to file (with --dry-run)

Gate options (requires GH_TOKEN with Administration: write):
  --repo <name>             Target a specific repository (name or owner/name)
  --all                     Target all repositories from distribution.yml
  --dry-run                 Compute and print contexts without writing the ruleset
  --config <path>           Path to distribution.yml (default: ./distribution.yml)
  --output <path>           Write the JSON result to a file

Policy options:
  --package <path>          Path to package.json (default: ./package.json)
  --registry <path>         Path to dependency-policy.yml (default: bundled)
  --repo <name>             Repository short name for registry scoping

  Review options:
  --before-pkg <path>       Base (target branch) package.json
  --after-pkg <path>        Head (PR branch) package.json
  --before-lock <path>      Base package-lock.json (optional)
  --after-lock <path>       Head package-lock.json (optional)
  --pr <number>             Pull request number (for posting comment)
  --comment <path>          Write markdown comment to file
  --post                    Post comment via gh pr comment

Dependabot options:
  --registry <path>         Path to dependency-policy.yml (default: bundled)
  --target <dir>            Target directory containing .github/dependabot.yml
  --repo <name>             Repository short name for registry scoping

Inventory options (requires GH_TOKEN):
  --repo <name>             Export a single repository
  --all                     Export all repositories from distribution.yml (+ infra)
  --config <path>           Path to distribution.yml (default: bundled)
  --registry <path>         Path to dependency-policy.yml (default: bundled)
  --output <path>           Write JSON inventory to file (default: stdout)
  --markdown <path>         Write markdown report to file
  --skip-checks             Skip per-PR check-status lookup (faster)

Health options (requires GH_TOKEN):
  --repo <name>             Audit or summarize a single repository
  --all                     Audit or summarize all repositories from distribution.yml (+ infra)
  --config <path>           Path to distribution.yml (default: bundled)
  --registry <path>         Path to dependency-policy.yml (default: bundled)
  --output <path>           Write JSON report to file (default: stdout)
  --markdown <path>         Write markdown report to file
  --skip-checks             Skip per-PR check-status lookup (faster)
  --owner <name>            GitHub org owner (default: diplodoc-platform)

Blacklist options:
  --repo <name>             Repository to inspect
  --config <path>           Path to distribution.yml

Auto-merge options:
  --input <path>            Evaluate a JSON file against the auto-merge rules
  --json                    Emit JSON result (default for evaluate)
  --quiet                   Suppress informational stderr
  --all                     Evaluate all repositories from distribution.yml (+ infra)
  --repo <name>             Evaluate a single repository
  --config <path>           Path to distribution.yml (default: bundled)
  --registry <path>         Path to dependency-policy.yml (default: bundled)
  --output <path>           Write JSON audit log to file (default: stdout)
  --markdown <path>         Write markdown audit report to file
  --owner <name>            GitHub org owner (default: diplodoc-platform)
  --dry-run                 Audit-only: evaluate but do not merge (default)
  --enabled                 Enable live auto-merge (phase 2)
  --skip-checks             Skip per-PR check-status lookup (faster)
  --tracking-repo <name>    Repo for audit tracking issue (default: infra)
`);
}

function runInit() {
    console.log('[@diplodoc/infra] Extend package.json configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-package.js')}"`);
    execCommand(`"${join(binDir, 'husky')}" init`);

    console.log('[@diplodoc/infra] Copy scaffolding files');
    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`);

    console.log('[@diplodoc/infra] Extend .ignore configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`);

    console.log('[@diplodoc/infra] Setup release-please configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`);

    console.log('[@diplodoc/infra] Generate per-repo dependency policy');
    execCommand(`node "${join(srcDir, 'scripts/generate-dependency-policy.js')}"`);

    console.log('[@diplodoc/infra] Generate dependabot ignore entries from registry');
    execCommand(`node "${join(srcDir, 'scripts/generate-dependabot-ignores.js')}"`);

    console.log(
        '[@diplodoc/infra] Audit exact-pin registry (legacy pins are warning-only during rollout)',
    );
    execCommand(`node "${join(srcDir, 'scripts/enforce-exact-pin.js')}" --warn-only`);
}

function runUpdate() {
    console.log('[@diplodoc/infra] Update package.json scripts');
    execCommand(`node "${join(srcDir, 'scripts/modify-package.js')}"`);

    console.log('[@diplodoc/infra] Copy scaffolding files');
    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`);

    console.log('[@diplodoc/infra] Extend .ignore configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`);

    console.log('[@diplodoc/infra] Setup release-please configuration');
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`);

    console.log('[@diplodoc/infra] Generate per-repo dependency policy');
    execCommand(`node "${join(srcDir, 'scripts/generate-dependency-policy.js')}"`);

    console.log('[@diplodoc/infra] Generate dependabot ignore entries from registry');
    execCommand(`node "${join(srcDir, 'scripts/generate-dependabot-ignores.js')}"`);

    console.log(
        '[@diplodoc/infra] Audit exact-pin registry (legacy pins are warning-only during rollout)',
    );
    execCommand(`node "${join(srcDir, 'scripts/enforce-exact-pin.js')}" --warn-only`);
}

function runSync() {
    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    const dryRun = !!flags['dry-run'];
    const outputFile = flags.output;
    const targetPath = flags.target;
    const repoFilter = flags.repo;
    const all = !!flags.all;

    if (targetPath) {
        const absTarget = resolve(targetPath);
        const repoName = repoFilter || 'unknown';
        const blacklist = loadBlacklist(repoName, absTarget, configPath);
        if (dryRun) {
            applySyncToTarget(absTarget, repoName, blacklist, false);
            const report = generateDiffReport(absTarget, repoName, blacklist);
            const formatted = formatDiffReports([report]);
            console.log(formatted);
            if (outputFile) {
                writeFileSync(outputFile, formatted, 'utf8');
            }
            // Revert changes in target directory
            try {
                execSync('git checkout -- . && git clean -fd', {
                    cwd: absTarget,
                    stdio: 'pipe',
                    shell,
                });
            } catch {
                // Not a git repo or no changes to revert
            }
        } else {
            applySyncToTarget(absTarget, repoName, blacklist, false);
        }
        return;
    }

    if (!repoFilter && !all) {
        console.error('Error: specify --repo <name>, --all, or --target <path>');
        process.exit(1);
    }

    const repos = repoFilter ? [repoFilter] : getAllRepos(configPath);
    if (repos.length === 0) {
        console.error('Error: no repositories found in distribution config');
        process.exit(1);
    }

    const reports = [];

    for (const repo of repos) {
        console.log(`\n--- Processing ${repo} ---`);
        const repoConfig = getRepoConfig(repo, configPath);
        const ghRepo = repoConfig.github || `diplodoc-platform/${repo}`;

        const tmpDir = join(process.cwd(), '.infra-sync-tmp', repo);
        if (!existsSync(tmpDir)) {
            mkdirSync(tmpDir, {recursive: true});
        }

        try {
            execSync(`gh repo clone ${ghRepo} "${tmpDir}" -- --depth 1`, {
                stdio: 'pipe',
                shell,
            });
        } catch (error) {
            console.error(`Failed to clone ${ghRepo}: ${error.message}`);
            continue;
        }

        const blacklist = loadBlacklist(repo, tmpDir, configPath);

        if (dryRun) {
            applySyncToTarget(tmpDir, repo, blacklist, false);
            const report = generateDiffReport(tmpDir, repo, blacklist);
            reports.push(report);
            if (report.hasChanges) {
                console.log(`  ${repo}: changes detected`);
            } else {
                console.log(`  ${repo}: no changes`);
            }
        } else {
            applySyncToTarget(tmpDir, repo, blacklist, false);

            const version = flags.version || 'latest';
            const branchName = `infra/update-v${version}`;

            try {
                execSync(
                    [
                        `cd "${tmpDir}"`,
                        `git checkout -b ${branchName}`,
                        'git add -A',
                        `git diff --cached --quiet || git commit -m "chore: update infrastructure to v${version}"`,
                        `git push origin ${branchName}`,
                        `gh pr create --title "chore: update infrastructure to v${version}" --body "Automated infrastructure update from @diplodoc/infra v${version}"`,
                    ].join(' && '),
                    {stdio: 'inherit', shell},
                );

                if (repoConfig.auto_merge !== false) {
                    try {
                        execSync(`cd "${tmpDir}" && gh pr merge --auto --squash`, {
                            stdio: 'pipe',
                            shell,
                        });
                    } catch {
                        console.log(`Note: auto-merge not available for ${repo}`);
                    }
                }
            } catch (error) {
                console.error(`Failed to create PR for ${repo}: ${error.message}`);
            }
        }
    }

    if (dryRun && outputFile) {
        writeFileSync(outputFile, formatDiffReports(reports), 'utf8');
        console.log(`\nDiff report written to ${outputFile}`);
    }

    // Cleanup
    const tmpBase = join(process.cwd(), '.infra-sync-tmp');
    if (existsSync(tmpBase)) {
        try {
            execSync(`rm -rf "${tmpBase}"`, {shell, stdio: 'pipe'});
        } catch {
            // ignore cleanup errors
        }
    }
}

function runGate() {
    const sub = args[1];
    if (sub !== 'sync') {
        console.error('Unknown gate command. Use: sync');
        process.exit(1);
    }

    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    const dryRun = !!flags['dry-run'];
    const repoFilter = flags.repo;
    const all = !!flags.all;
    const output = flags.output;

    if (!repoFilter && !all) {
        console.error('Error: specify --repo <name> or --all');
        process.exit(1);
    }

    const repos = repoFilter ? [repoFilter] : getAllRepos(configPath);
    if (repos.length === 0) {
        console.error('Error: no repositories found in distribution config');
        process.exit(1);
    }

    const gateScript = join(srcDir, 'scripts/sync-ci-gate.js');
    let failed = 0;

    for (const repo of repos) {
        // Use execFileSync with an argv array (NO shell) so repo / config /
        // output values are passed verbatim to node and can never be parsed as
        // shell syntax — quotes, $(...), ;-chains in a repo name are inert.
        const gateArgs = [gateScript, '--repo', repo, '--config', configPath];
        if (dryRun) gateArgs.push('--dry-run');
        // With --all we never collide on a single --output file; only honor it
        // for a single-repo invocation.
        if (output && repoFilter) gateArgs.push('--output', output);

        try {
            execFileSync(process.execPath, gateArgs, {stdio: 'inherit', cwd: process.cwd()});
        } catch {
            failed++;
        }
    }

    if (failed > 0) {
        console.error(`[@diplodoc/infra] gate sync: ${failed} repository(ies) failed`);
        process.exit(1);
    }
}

function applySyncToTarget(targetDir, repoName, blacklist, dryRun) {
    if (dryRun) return;

    const blacklistPaths = blacklist.map((e) => e.path);

    const env = {
        ...process.env,
        INFRA_TARGET_DIR: targetDir,
        INFRA_BLACKLIST: JSON.stringify(blacklistPaths),
        INFRA_REPO_NAME: repoName,
    };

    // Order matters: modify package.json first so subsequent steps see the
    // up-to-date dependency list and scripts, then copy scaffolding (which may
    // depend on canonical script names), then modify ignore/release-please.
    execCommand(`node "${join(srcDir, 'scripts/modify-package.js')}"`, {cwd: targetDir, env});
    execCommand(`node "${join(srcDir, 'scripts/copy-scaffolding.js')}"`, {cwd: targetDir, env});
    execCommand(`node "${join(srcDir, 'scripts/modify-ignore.js')}"`, {cwd: targetDir, env});
    execCommand(`node "${join(srcDir, 'scripts/modify-release-please.js')}"`, {
        cwd: targetDir,
        env,
    });
    execCommand(`node "${join(srcDir, 'scripts/generate-dependency-policy.js')}"`, {
        cwd: targetDir,
        env,
    });
    execCommand(`node "${join(srcDir, 'scripts/generate-dependabot-ignores.js')}"`, {
        cwd: targetDir,
        env,
    });
    execCommand(`node "${join(srcDir, 'scripts/enforce-exact-pin.js')}" --warn-only`, {
        cwd: targetDir,
        env,
    });
}

function generateDiffReport(targetDir, repoName, blacklist) {
    const lines = [];
    let hasChanges = false;

    if (blacklist.length > 0) {
        lines.push('**Excluded files (blacklist):**');
        for (const entry of blacklist) {
            const reason = entry.reason ? ` — ${entry.reason}` : '';
            const until = entry.until ? ` (until ${entry.until})` : '';
            lines.push(`- \`${entry.path}\`${reason}${until}`);
        }
        lines.push('');
    }

    try {
        const diff = execSync('git diff --stat', {
            cwd: targetDir,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        if (diff.trim()) {
            hasChanges = true;
            lines.push('**Changes:**');
            lines.push('```');
            lines.push(diff.trim());
            lines.push('```');
        }
    } catch {
        lines.push('Unable to generate diff.');
    }

    return {repoName, hasChanges, body: lines.join('\n')};
}

function formatDiffReports(reports) {
    const noChanges = reports.filter((r) => !r.hasChanges && !r.body.includes('blacklist'));
    const withChanges = reports.filter((r) => r.hasChanges || r.body.includes('blacklist'));

    // Group repos with identical diffs
    const groups = new Map();
    for (const report of withChanges) {
        const key = report.body;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(report.repoName);
    }

    const lines = [];

    for (const [body, repos] of groups) {
        if (repos.length === 1) {
            lines.push(`## ${repos[0]}\n`);
            lines.push(body);
        } else {
            lines.push(`## ${repos.join(', ')} (${repos.length} repos)\n`);
            lines.push(body);
        }
        lines.push('\n---\n');
    }

    if (noChanges.length > 0) {
        lines.push('<details>');
        lines.push(`<summary>No changes (${noChanges.length} repos)</summary>\n`);
        lines.push(noChanges.map((r) => `- ${r.repoName}`).join('\n'));
        lines.push('\n</details>');
    }

    return lines.join('\n');
}

function runPolicy() {
    const sub = args[1];
    if (sub === 'check') {
        const enforceScript = join(srcDir, 'scripts/enforce-exact-pin.js');
        const enforceArgs = [enforceScript];
        if (flags.package) enforceArgs.push('--package', flags.package);
        if (flags.registry) enforceArgs.push('--registry', flags.registry);
        if (flags.repo) enforceArgs.push('--repo', flags.repo);

        try {
            execFileSync(process.execPath, enforceArgs, {stdio: 'inherit', cwd: process.cwd()});
        } catch {
            process.exit(1);
        }
        return;
    }

    if (sub === 'review') {
        const reviewScript = join(srcDir, 'scripts/dependency-policy-review.js');
        const reviewArgs = [reviewScript];
        if (flags['before-pkg']) reviewArgs.push('--before-pkg', flags['before-pkg']);
        if (flags['after-pkg']) reviewArgs.push('--after-pkg', flags['after-pkg']);
        if (flags['before-lock']) reviewArgs.push('--before-lock', flags['before-lock']);
        if (flags['after-lock']) reviewArgs.push('--after-lock', flags['after-lock']);
        if (flags.registry) reviewArgs.push('--registry', flags.registry);
        if (flags.repo) reviewArgs.push('--repo', flags.repo);
        if (flags.pr) reviewArgs.push('--pr', flags.pr);
        if (flags['head-sha']) reviewArgs.push('--head-sha', flags['head-sha']);
        if (flags['compatibility-score'])
            reviewArgs.push('--compatibility-score', flags['compatibility-score']);
        if (flags.comment) reviewArgs.push('--comment', flags.comment);
        if (flags.post) reviewArgs.push('--post');
        if (flags.quiet) reviewArgs.push('--quiet');

        try {
            execFileSync(process.execPath, reviewArgs, {stdio: 'inherit', cwd: process.cwd()});
        } catch {
            process.exit(1);
        }
        return;
    }

    console.error('Unknown policy command. Use: check, review');
    process.exit(1);
}

function runDependabot() {
    const sub = args[1];
    if (sub !== 'ignores') {
        console.error('Unknown dependabot command. Use: ignores');
        process.exit(1);
    }

    const ignoresScript = join(srcDir, 'scripts/generate-dependabot-ignores.js');
    const ignoresArgs = [ignoresScript];

    if (flags.registry) ignoresArgs.push('--registry', flags.registry);
    if (flags.target) ignoresArgs.push('--target', flags.target);
    if (flags.repo) ignoresArgs.push('--repo', flags.repo);

    try {
        execFileSync(process.execPath, ignoresArgs, {
            stdio: 'inherit',
            cwd: process.cwd(),
        });
    } catch {
        process.exit(1);
    }
}

function runInventory() {
    const sub = args[1];
    if (sub !== 'export') {
        console.error('Unknown inventory command. Use: export');
        process.exit(1);
    }

    const inventoryScript = join(srcDir, 'scripts/export-pr-inventory.js');
    const inventoryArgs = [inventoryScript];

    if (flags.all) inventoryArgs.push('--all');
    else if (flags.repo) inventoryArgs.push('--repo', flags.repo);

    if (flags.config) inventoryArgs.push('--config', resolve(flags.config));
    if (flags.registry) inventoryArgs.push('--registry', flags.registry);
    if (flags.output) inventoryArgs.push('--output', flags.output);
    if (flags.markdown) inventoryArgs.push('--markdown', flags.markdown);
    if (flags['skip-checks']) inventoryArgs.push('--skip-checks');
    if (flags.owner) inventoryArgs.push('--owner', flags.owner);

    try {
        execFileSync(process.execPath, inventoryArgs, {
            stdio: 'inherit',
            cwd: process.cwd(),
        });
    } catch {
        process.exit(1);
    }
}

function runHealth() {
    const sub = args[1];
    if (sub !== 'audit' && sub !== 'summary' && sub !== 'assign') {
        console.error('Unknown health command. Use: audit, summary, assign');
        process.exit(1);
    }

    const scriptName =
        sub === 'summary'
            ? 'scripts/dependency-summary.js'
            : sub === 'assign'
              ? 'scripts/dependency-assign.js'
              : 'scripts/dependency-health.js';
    const healthScript = join(srcDir, scriptName);
    const healthArgs = [healthScript];

    if (flags.all) healthArgs.push('--all');
    else if (flags.repo) healthArgs.push('--repo', flags.repo);
    else {
        console.error('Error: specify --repo <name> or --all');
        process.exit(1);
    }

    if (flags.config) healthArgs.push('--config', resolve(flags.config));
    if (flags.registry) healthArgs.push('--registry', flags.registry);
    if (flags.output) healthArgs.push('--output', flags.output);
    if (flags.markdown) healthArgs.push('--markdown', flags.markdown);
    if (flags['skip-checks']) healthArgs.push('--skip-checks');
    if (flags.owner) healthArgs.push('--owner', flags.owner);
    if (sub === 'assign') {
        if (flags['tracking-repo']) healthArgs.push('--tracking-repo', flags['tracking-repo']);
        if (flags['default-owner']) healthArgs.push('--default-owner', flags['default-owner']);
        if (flags['dry-run']) healthArgs.push('--dry-run');
    }

    try {
        execFileSync(process.execPath, healthArgs, {
            stdio: 'inherit',
            cwd: process.cwd(),
        });
    } catch {
        process.exit(1);
    }
}

function runAutoMerge() {
    const sub = args[1];
    if (sub !== 'rules' && sub !== 'evaluate' && sub !== 'run') {
        console.error('Unknown automerge command. Use: rules, evaluate, run');
        process.exit(1);
    }

    const rulesScript = join(srcDir, 'scripts/auto-merge-rules.js');

    if (sub === 'rules') {
        try {
            execFileSync(process.execPath, [rulesScript, '--list'], {
                stdio: 'inherit',
                cwd: process.cwd(),
            });
        } catch {
            process.exit(1);
        }
        return;
    }

    // sub === 'evaluate'
    if (sub === 'evaluate') {
        if (!flags.input) {
            console.error('Error: --input <path> is required for automerge evaluate');
            process.exit(1);
        }
        const evalArgs = [rulesScript, '--input', flags.input];
        if (flags.json) evalArgs.push('--json');
        if (flags.quiet) evalArgs.push('--quiet');

        try {
            execFileSync(process.execPath, evalArgs, {
                stdio: 'inherit',
                cwd: process.cwd(),
            });
        } catch {
            process.exit(1);
        }
        return;
    }

    // sub === 'run' — the auto-merge workflow (T10.2)
    const automergeScript = join(srcDir, 'scripts/auto-merge.js');
    const automergeArgs = [automergeScript];

    if (flags.all) automergeArgs.push('--all');
    else if (flags.repo) automergeArgs.push('--repo', flags.repo);
    else {
        console.error('Error: specify --repo <name> or --all');
        process.exit(1);
    }

    if (flags.config) automergeArgs.push('--config', resolve(flags.config));
    if (flags.registry) automergeArgs.push('--registry', flags.registry);
    if (flags.output) automergeArgs.push('--output', flags.output);
    if (flags.markdown) automergeArgs.push('--markdown', flags.markdown);
    if (flags.owner) automergeArgs.push('--owner', flags.owner);
    if (flags['skip-checks']) automergeArgs.push('--skip-checks');
    if (flags.enabled) automergeArgs.push('--enabled');
    if (flags['dry-run']) automergeArgs.push('--dry-run');
    if (flags['tracking-repo']) automergeArgs.push('--tracking-repo', flags['tracking-repo']);

    try {
        execFileSync(process.execPath, automergeArgs, {
            stdio: 'inherit',
            cwd: process.cwd(),
        });
    } catch {
        process.exit(1);
    }
}

function runBlacklistShow() {
    const repoName = flags.repo;
    if (!repoName) {
        console.error('Error: --repo is required');
        process.exit(1);
    }

    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    const blacklist = loadBlacklist(repoName, process.cwd(), configPath);

    if (blacklist.length === 0) {
        console.log(`No exclusions for ${repoName}`);
        return;
    }

    console.log(`Exclusions for ${repoName}:\n`);
    for (const entry of blacklist) {
        const reason = entry.reason ? `\n    Reason: ${entry.reason}` : '';
        const until = entry.until ? `\n    Until: ${entry.until}` : '';
        console.log(`  - ${entry.path}${reason}${until}`);
    }
}

function runBlacklistAudit() {
    const configPath = resolve(flags.config || join(srcDir, 'distribution.yml'));
    if (!existsSync(configPath)) {
        console.log('No distribution.yml found');
        return;
    }

    const config = loadYaml(configPath);
    const now = new Date();
    let hasExpired = false;

    for (const [repoName, repoConfig] of Object.entries(config.repos || {})) {
        const excludes = repoConfig.exclude || [];
        for (const entry of excludes) {
            if (typeof entry === 'object' && entry.until) {
                const expiry = new Date(entry.until);
                if (expiry <= now) {
                    hasExpired = true;
                    console.log(
                        `EXPIRED: ${repoName} — ${entry.path} (expired ${entry.until})${entry.reason ? ` — ${entry.reason}` : ''}`,
                    );
                }
            }
        }
    }

    if (!hasExpired) {
        console.log('No expired exclusions found.');
    }
}

switch (command) {
    case 'init':
        runInit();
        break;
    case 'update':
        runUpdate();
        break;
    case 'sync':
        runSync();
        break;
    case 'gate':
        runGate();
        break;
    case 'policy':
        runPolicy();
        break;
    case 'dependabot':
        runDependabot();
        break;
    case 'inventory':
        runInventory();
        break;
    case 'health':
        runHealth();
        break;
    case 'automerge':
        runAutoMerge();
        break;
    case 'blacklist':
        if (args[1] === 'show') {
            runBlacklistShow();
        } else if (args[1] === 'audit') {
            runBlacklistAudit();
        } else {
            console.error('Unknown blacklist command. Use: show, audit');
            process.exit(1);
        }
        break;
    case 'help':
    case '--help':
    case '-h':
        showHelp();
        break;
    default:
        showHelp();
        process.exit(command ? 1 : 0);
}
