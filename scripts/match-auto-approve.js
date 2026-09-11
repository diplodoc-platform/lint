/**
 * match-auto-approve.js
 *
 * Canonical, unit-tested rules for which bot-authored PRs the machine user
 * (`diplodoc-bot`) should auto-approve. Two kinds of automated PRs qualify:
 *
 *   1. Dependency updates from scaffolding `update-deps.yml`
 *      (author yc-ui-bot, branch `ci/update-deps/*`, title `fix(deps): Update ...`).
 *   2. Release PRs from scaffolding `release-please.yml`
 *      (author yc-ui-bot, branch `release-please--*`, title `chore(...): release ...`).
 *
 * NOTE: The distributed `scaffolding/.github/workflows/auto-approve.yml` mirrors
 * these rules with declarative `if:` expressions so consumer repos need no extra
 * dependency at runtime. Keep the two in sync — this module is the source of
 * truth and the one covered by tests.
 */

// PR author(s) whose automated PRs are eligible for auto-approval. This is the
// account that opens dep/release PRs (yc-ui-bot), NOT the approver (diplodoc-bot).
const BOT_AUTHORS = ['yc-ui-bot'];

const UPDATE_DEPS_BRANCH_PREFIX = 'ci/update-deps/';
const RELEASE_PLEASE_BRANCH_PREFIX = 'release-please--';

const UPDATE_DEPS_TITLE = /^fix\(deps\): update/i;
const RELEASE_PLEASE_TITLE = /^chore(\(.+\))?: release/i;

/**
 * Classify a PR into the kind of automated PR it is, or null if it is not one
 * of the auto-approvable kinds.
 *
 * @param {{author?: string, branch?: string, title?: string}} pr
 * @returns {('update-deps'|'release-please'|null)}
 */
function classifyPr({author = '', branch = '', title = ''} = {}) {
    if (!BOT_AUTHORS.includes(author)) return null;

    const isUpdateDeps =
        branch.startsWith(UPDATE_DEPS_BRANCH_PREFIX) || UPDATE_DEPS_TITLE.test(title);
    if (isUpdateDeps) return 'update-deps';

    const isReleasePlease =
        branch.startsWith(RELEASE_PLEASE_BRANCH_PREFIX) || RELEASE_PLEASE_TITLE.test(title);
    if (isReleasePlease) return 'release-please';

    return null;
}

/**
 * Whether the machine user should auto-approve this PR.
 *
 * @param {{author?: string, branch?: string, title?: string}} pr
 * @returns {boolean}
 */
function shouldAutoApprove(pr) {
    return classifyPr(pr) !== null;
}

/**
 * Defense-in-depth: tie approval to CONTENT, not just the branch name. Every
 * commit on the PR must be both authored and committed by the trusted bot, so a
 * push by anyone else to a `ci/update-deps/*` / `release-please--*` branch does
 * not get a free code-owner approval. The distributed auto-approve.yml mirrors
 * this with a `gh api .../commits` check — keep the two in sync.
 *
 * @param {Array<{author?: {login?: string}, committer?: {login?: string}}>} commits
 *        GitHub PR commit objects (login is the GitHub-resolved identity).
 * @param {string} login trusted bot login (e.g. yc-ui-bot)
 * @returns {boolean}
 */
function commitsAllAuthoredBy(commits, login) {
    if (!Array.isArray(commits) || commits.length === 0) return false;
    return commits.every(
        (c) =>
            c && c.author && c.committer && c.author.login === login && c.committer.login === login,
    );
}

module.exports = {
    BOT_AUTHORS,
    UPDATE_DEPS_BRANCH_PREFIX,
    RELEASE_PLEASE_BRANCH_PREFIX,
    classifyPr,
    shouldAutoApprove,
    commitsAllAuthoredBy,
};
