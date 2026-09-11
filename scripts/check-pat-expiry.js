#!/usr/bin/env node

/**
 * check-pat-expiry.js
 *
 * Monitors the expiry of the machine user's fine-grained PAT (`INFRA_APPROVER_PAT`,
 * owned by `diplodoc-bot`) which the distribution / auto-approve flows rely on.
 *
 * GitHub provides NO API to create or regenerate a fine-grained PAT, so this
 * cannot auto-rotate. (Switching to a GitHub App token is not an option either:
 * Apps cannot be code owners and cannot approve PRs — the very reason the PAT
 * exists.) Instead this implements the remaining ADR-001 "Future work" item:
 * an automated, ahead-of-time expiry check that alerts so a human can rotate it
 * before it lapses.
 *
 * Discovery: `GET /orgs/{org}/personal-access-tokens` (requires the caller to
 * have the org "Personal access tokens: read" permission).
 *
 * Runnable as a CLI or required as a module (pure helpers are exported for tests).
 */

const {writeFileSync, mkdirSync} = require('node:fs');
const {dirname, resolve} = require('node:path');

const DEFAULT_ORG = 'diplodoc-platform';
const DEFAULT_BOT_LOGIN = 'diplodoc-bot';
const DEFAULT_THRESHOLD_DAYS = 14;
const API_ROOT = 'https://api.github.com';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no process state)
// ---------------------------------------------------------------------------

/**
 * Whole days from `now` until `expiresAt` (negative if already past).
 * Returns Infinity when there is no expiry date.
 *
 * @param {string|null|undefined} expiresAt ISO timestamp
 * @param {Date} [now]
 * @returns {number}
 */
function daysUntil(expiresAt, now = new Date()) {
    if (!expiresAt) return Infinity;
    const ts = new Date(expiresAt).getTime();
    if (Number.isNaN(ts)) return Infinity;
    return Math.floor((ts - now.getTime()) / MS_PER_DAY);
}

/**
 * Normalize an org PAT-grant item to {expiresAt, expired}.
 *
 * @param {object} item
 * @returns {{expiresAt: (string|null), expired: boolean}}
 */
function normalizeToken(item = {}) {
    const expiresAt = item.token_expires_at || item.expires_at || null;
    const expired = item.token_expired === true;
    return {expiresAt, expired};
}

/**
 * Among all PAT grants owned by `login`, pick the one that expires soonest
 * (the most pressing to rotate).
 *
 * @param {Array<object>} tokens
 * @param {string} login
 * @returns {object|null}
 */
function findBotToken(tokens = [], login) {
    const owned = tokens.filter((t) => t && t.owner && t.owner.login === login);
    if (owned.length === 0) return null;

    return owned.reduce((soonest, current) => {
        const a = daysUntil(normalizeToken(soonest).expiresAt);
        const b = daysUntil(normalizeToken(current).expiresAt);
        return b < a ? current : soonest;
    });
}

/**
 * Evaluate the expiry state of the bot's PAT.
 *
 * @param {{tokens: Array<object>, login: string, thresholdDays?: number, now?: Date}} params
 * @returns {{status: ('ok'|'warn'|'expired'|'missing'), login: string, daysLeft: (number|null), expiresAt: (string|null), tokenId: (number|null), thresholdDays: number}}
 */
function evaluateExpiry({tokens, login, thresholdDays = DEFAULT_THRESHOLD_DAYS, now = new Date()}) {
    const token = findBotToken(tokens, login);
    if (!token) {
        return {
            status: 'missing',
            login,
            daysLeft: null,
            expiresAt: null,
            tokenId: null,
            thresholdDays,
        };
    }

    const {expiresAt, expired} = normalizeToken(token);
    const daysLeft = daysUntil(expiresAt, now);

    let status;
    if (expired || daysLeft < 0) {
        status = 'expired';
    } else if (daysLeft <= thresholdDays) {
        status = 'warn';
    } else {
        status = 'ok';
    }

    return {
        status,
        login,
        daysLeft: Number.isFinite(daysLeft) ? daysLeft : null,
        expiresAt,
        tokenId: token.id != null ? token.id : null,
        thresholdDays,
    };
}

// ---------------------------------------------------------------------------
// GitHub API + CLI
// ---------------------------------------------------------------------------

async function listOrgPats(token, org) {
    const out = [];
    let page = 1;
    for (;;) {
        const res = await fetch(
            `${API_ROOT}/orgs/${org}/personal-access-tokens?per_page=100&page=${page}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'diplodoc-infra-check-pat-expiry',
                },
            },
        );
        const text = await res.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = null;
            }
        }
        if (!res.ok) {
            const detail = json && json.message ? json.message : text || res.statusText;
            throw new Error(`GitHub API GET org PATs -> ${res.status}: ${detail}`);
        }
        const items = Array.isArray(json) ? json : [];
        out.push(...items);
        if (items.length < 100) break;
        page++;
    }
    return out;
}

function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const org = flags.org || process.env.PAT_ORG || DEFAULT_ORG;
    const login = flags.login || process.env.PAT_BOT_LOGIN || DEFAULT_BOT_LOGIN;
    const thresholdDays =
        Number(flags.threshold || process.env.PAT_THRESHOLD_DAYS) || DEFAULT_THRESHOLD_DAYS;
    const outputFile = typeof flags.output === 'string' ? flags.output : null;

    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GH_TOKEN env var is required (org "Personal access tokens: read")');
    }

    let result;
    try {
        const tokens = await listOrgPats(token, org);
        result = evaluateExpiry({tokens, login, thresholdDays});
    } catch (error) {
        result = {
            status: 'error',
            login,
            daysLeft: null,
            expiresAt: null,
            tokenId: null,
            thresholdDays,
            reason: error.message,
        };
    }

    console.error(
        `[pat-expiry] ${login}: ${result.status}` +
            (result.daysLeft != null ? ` — ${result.daysLeft} day(s) left` : '') +
            (result.expiresAt ? ` (expires ${result.expiresAt})` : '') +
            (result.reason ? ` — ${result.reason}` : ''),
    );
    console.log(JSON.stringify(result));

    if (outputFile) {
        const abs = resolve(outputFile);
        mkdirSync(dirname(abs), {recursive: true});
        writeFileSync(abs, JSON.stringify(result, null, 2), 'utf8');
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[pat-expiry] fatal: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    daysUntil,
    normalizeToken,
    findBotToken,
    evaluateExpiry,
};
