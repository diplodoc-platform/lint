const assert = require('node:assert');

const {
    DEFAULT_OWNER_TEAM,
    DEFAULT_ASSIGNEE_LOGIN,
    TRACKING_ISSUE_TITLE,
    TRACKING_ISSUE_LABELS,
    resolveOwner,
    resolveAssigneeLogin,
    groupBreachesByOwner,
    buildAssignActions,
    renderTrackingIssue,
} = require('../../scripts/dependency-assign');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- Constants --------------------------------------------------------------

test('DEFAULT_OWNER_TEAM is the platform team mention', () => {
    assert.strictEqual(DEFAULT_OWNER_TEAM, '@diplodoc-platform/team');
});

test('DEFAULT_ASSIGNEE_LOGIN is the machine user login', () => {
    assert.strictEqual(DEFAULT_ASSIGNEE_LOGIN, 'diplodoc-bot');
});

test('TRACKING_ISSUE_TITLE is stable and date-free', () => {
    assert.strictEqual(TRACKING_ISSUE_TITLE, 'SLA Breach Tracking');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(TRACKING_ISSUE_TITLE), 'title must not contain a date');
});

test('TRACKING_ISSUE_LABELS includes dependency-health and sla-breach', () => {
    assert.ok(TRACKING_ISSUE_LABELS.includes('dependency-health'));
    assert.ok(TRACKING_ISSUE_LABELS.includes('sla-breach'));
});

// --- resolveOwner -----------------------------------------------------------

test('resolveOwner: returns registry owner when dependency matches', () => {
    const pr = {repo: 'cli', dependency: 'svgo'};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli', 'transform']},
    ];
    assert.strictEqual(resolveOwner(pr, registry), '@alice');
});

test('resolveOwner: returns registry owner for repo-scoped entry', () => {
    const pr = {repo: 'transform', dependency: 'svgo'};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', owner: '@bob', repositories: ['transform']},
    ];
    assert.strictEqual(resolveOwner(pr, registry), '@bob');
});

test('resolveOwner: falls back to default when dependency not in registry', () => {
    const pr = {repo: 'cli', dependency: 'lodash'};
    const registry = [{id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli']}];
    assert.strictEqual(resolveOwner(pr, registry), DEFAULT_OWNER_TEAM);
});

test('resolveOwner: falls back to default when registry entry has no owner', () => {
    const pr = {repo: 'cli', dependency: 'svgo'};
    const registry = [{id: 'DEP-0001', dependency: 'svgo', repositories: ['cli']}];
    assert.strictEqual(resolveOwner(pr, registry), DEFAULT_OWNER_TEAM);
});

test('resolveOwner: entry scoped to a different repo does not match', () => {
    const pr = {repo: 'utils', dependency: 'svgo'};
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli', 'transform']},
    ];
    assert.strictEqual(resolveOwner(pr, registry), DEFAULT_OWNER_TEAM);
});

test('resolveOwner: global entry (no repositories) applies to all repos', () => {
    const pr = {repo: 'utils', dependency: 'svgo'};
    const registry = [{id: 'DEP-0002', dependency: 'svgo', owner: '@carol'}];
    assert.strictEqual(resolveOwner(pr, registry), '@carol');
});

test('resolveOwner: null pr returns default', () => {
    assert.strictEqual(resolveOwner(null, []), DEFAULT_OWNER_TEAM);
});

test('resolveOwner: empty dependency still matches a global entry with empty dependency', () => {
    const pr = {repo: 'cli', dependency: ''};
    const registry = [{id: 'DEP-0001', dependency: '', owner: '@dave'}];
    assert.strictEqual(resolveOwner(pr, registry), '@dave');
});

test('resolveOwner: custom defaultOwner is used as fallback', () => {
    const pr = {repo: 'cli', dependency: 'lodash'};
    assert.strictEqual(resolveOwner(pr, [], '@custom-team'), '@custom-team');
});

// --- resolveAssigneeLogin ---------------------------------------------------

test('resolveAssigneeLogin: strips leading @ from user login', () => {
    assert.strictEqual(resolveAssigneeLogin('@alice'), 'alice');
});

test('resolveAssigneeLogin: bare login passes through', () => {
    assert.strictEqual(resolveAssigneeLogin('alice'), 'alice');
});

test('resolveAssigneeLogin: team mention falls back to default', () => {
    assert.strictEqual(resolveAssigneeLogin('@diplodoc-platform/team'), DEFAULT_ASSIGNEE_LOGIN);
    assert.strictEqual(resolveAssigneeLogin('org/team'), DEFAULT_ASSIGNEE_LOGIN);
});

test('resolveAssigneeLogin: empty string falls back to default', () => {
    assert.strictEqual(resolveAssigneeLogin(''), DEFAULT_ASSIGNEE_LOGIN);
    assert.strictEqual(resolveAssigneeLogin(null), DEFAULT_ASSIGNEE_LOGIN);
});

test('resolveAssigneeLogin: invalid characters fall back to default', () => {
    assert.strictEqual(resolveAssigneeLogin('@bad/name'), DEFAULT_ASSIGNEE_LOGIN);
    assert.strictEqual(resolveAssigneeLogin('has space'), DEFAULT_ASSIGNEE_LOGIN);
});

test('resolveAssigneeLogin: custom defaultLogin is used for team fallback', () => {
    assert.strictEqual(resolveAssigneeLogin('@org/team', 'fallback-bot'), 'fallback-bot');
});

test('resolveAssigneeLogin: a valid user owner with @ resolves to the bare login', () => {
    assert.strictEqual(resolveAssigneeLogin('@alice'), 'alice');
});

// --- groupBreachesByOwner ---------------------------------------------------

test('groupBreachesByOwner: groups PRs by resolved owner', () => {
    const prs = [
        {repo: 'cli', number: 1, dependency: 'svgo', breach: true},
        {repo: 'transform', number: 2, dependency: 'svgo', breach: true},
        {repo: 'utils', number: 3, dependency: 'lodash', breach: true},
    ];
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli', 'transform']},
    ];
    const groups = groupBreachesByOwner(prs, registry);
    assert.deepStrictEqual(Object.keys(groups).sort(), ['@alice', DEFAULT_OWNER_TEAM].sort());
    assert.strictEqual(groups['@alice'].length, 2);
    assert.strictEqual(groups[DEFAULT_OWNER_TEAM].length, 1);
});

test('groupBreachesByOwner: empty input returns empty object', () => {
    assert.deepStrictEqual(groupBreachesByOwner([], []), {});
    assert.deepStrictEqual(groupBreachesByOwner(null, []), {});
});

test('groupBreachesByOwner: all PRs share the default owner when no registry entries', () => {
    const prs = [
        {repo: 'cli', number: 1, dependency: 'lodash', breach: true},
        {repo: 'utils', number: 2, dependency: 'axios', breach: true},
    ];
    const groups = groupBreachesByOwner(prs, []);
    assert.deepStrictEqual(Object.keys(groups), [DEFAULT_OWNER_TEAM]);
    assert.strictEqual(groups[DEFAULT_OWNER_TEAM].length, 2);
});

// --- buildAssignActions -----------------------------------------------------

function makeHealth(prs) {
    return {prs, exceptions: [], summary: {}};
}

test('buildAssignActions: returns one action per breaching PR', () => {
    const prs = [
        {repo: 'cli', number: 10, dependency: 'svgo', breach: true},
        {repo: 'utils', number: 5, dependency: 'lodash', breach: true},
        {repo: 'cli', number: 11, dependency: 'axios', breach: false},
    ];
    const registry = [{id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli']}];
    const actions = buildAssignActions(makeHealth(prs), registry);
    assert.strictEqual(actions.length, 2);
    assert.strictEqual(actions[0].repo, 'cli');
    assert.strictEqual(actions[0].number, 10);
    assert.strictEqual(actions[0].owner, '@alice');
    assert.strictEqual(actions[0].login, 'alice');
    assert.strictEqual(actions[1].repo, 'utils');
    assert.strictEqual(actions[1].number, 5);
    assert.strictEqual(actions[1].owner, DEFAULT_OWNER_TEAM);
    assert.strictEqual(actions[1].login, DEFAULT_ASSIGNEE_LOGIN);
});

test('buildAssignActions: empty when no breaches', () => {
    const prs = [{repo: 'cli', number: 10, dependency: 'svgo', breach: false}];
    const actions = buildAssignActions(makeHealth(prs), []);
    assert.strictEqual(actions.length, 0);
});

test('buildAssignActions: deduplicates by repo#number', () => {
    const prs = [
        {repo: 'cli', number: 10, dependency: 'svgo', breach: true},
        {repo: 'cli', number: 10, dependency: 'svgo', breach: true},
    ];
    const actions = buildAssignActions(makeHealth(prs), []);
    assert.strictEqual(actions.length, 1);
});

test('buildAssignActions: handles missing health object', () => {
    const actions = buildAssignActions(null, []);
    assert.strictEqual(actions.length, 0);
});

test('buildAssignActions: handles empty prs array', () => {
    const actions = buildAssignActions({prs: []}, []);
    assert.strictEqual(actions.length, 0);
});

test('buildAssignActions: team owner resolves to fallback login', () => {
    const prs = [{repo: 'cli', number: 1, dependency: 'svgo', breach: true}];
    const registry = [
        {
            id: 'DEP-0001',
            dependency: 'svgo',
            owner: '@diplodoc-platform/svg-team',
            repositories: ['cli'],
        },
    ];
    const actions = buildAssignActions(makeHealth(prs), registry);
    assert.strictEqual(actions[0].owner, '@diplodoc-platform/svg-team');
    assert.strictEqual(actions[0].login, DEFAULT_ASSIGNEE_LOGIN);
});

// --- renderTrackingIssue ----------------------------------------------------

test('renderTrackingIssue: includes title and summary table', () => {
    const health = makeHealth([]);
    const md = renderTrackingIssue(health, [], undefined, '2026-08-23T07:00:00.000Z');
    assert.ok(md.includes('## SLA Breach Tracking'));
    assert.ok(md.includes('Last updated: 2026-08-23T07:00:00.000Z'));
    assert.ok(md.includes('Total breaching PRs'));
});

test('renderTrackingIssue: shows "No SLA breaches" when no breaches', () => {
    const health = makeHealth([]);
    const md = renderTrackingIssue(health, []);
    assert.ok(md.includes('No SLA breaches detected'));
});

test('renderTrackingIssue: lists breaching PRs grouped by owner', () => {
    const prs = [
        {
            repo: 'cli',
            number: 10,
            dependency: 'svgo',
            breach: true,
            daysOverdue: 5,
            ageDays: 12,
            slaLabel: 'Patch',
            security: false,
            risk: 'high',
            fromVersion: '3.3.2',
            toVersion: '3.3.3',
            title: 'Bump svgo',
        },
        {
            repo: 'utils',
            number: 5,
            dependency: 'lodash',
            breach: true,
            daysOverdue: 2,
            ageDays: 16,
            slaLabel: 'Minor',
            security: false,
            risk: 'medium',
            fromVersion: '4.17.20',
            toVersion: '4.17.21',
            title: 'Bump lodash',
        },
    ];
    const registry = [{id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli']}];
    const md = renderTrackingIssue(makeHealth(prs), registry);
    assert.ok(md.includes('Owner: @alice'));
    assert.ok(md.includes('Bump svgo'));
    assert.ok(md.includes('Owner: ' + DEFAULT_OWNER_TEAM));
    assert.ok(md.includes('Bump lodash'));
});

test('renderTrackingIssue: includes fix-or-file-exception reminder', () => {
    const prs = [
        {
            repo: 'cli',
            number: 10,
            dependency: 'svgo',
            breach: true,
            daysOverdue: 5,
            ageDays: 12,
            slaLabel: 'Patch',
            security: false,
            risk: 'high',
            fromVersion: '3.3.2',
            toVersion: '3.3.3',
            title: 'Bump svgo',
        },
    ];
    const md = renderTrackingIssue(makeHealth(prs), []);
    assert.ok(md.includes('fix or file an exception'));
    assert.ok(md.includes('policy exception'));
    assert.ok(md.includes('dependency-policy.yml'));
});

test('renderTrackingIssue: escapes pipe characters in titles', () => {
    const prs = [
        {
            repo: 'cli',
            number: 10,
            dependency: 'svgo',
            breach: true,
            daysOverdue: 5,
            ageDays: 12,
            slaLabel: 'Patch',
            security: false,
            risk: 'high',
            fromVersion: '3.3.2',
            toVersion: '3.3.3',
            title: 'Bump a|b from 1 to 2',
        },
    ];
    const md = renderTrackingIssue(makeHealth(prs), []);
    assert.ok(md.includes('Bump a\\|b from 1 to 2'));
    assert.ok(!md.includes('Bump a|b from 1 to 2\n|'));
});

test('renderTrackingIssue: sorts breaches by daysOverdue descending within the table', () => {
    const prs = [
        {
            repo: 'a',
            number: 1,
            dependency: 'x',
            breach: true,
            daysOverdue: 1,
            ageDays: 8,
            slaLabel: 'Patch',
            security: false,
            risk: 'low',
            fromVersion: '1',
            toVersion: '2',
            title: 'low overdue',
        },
        {
            repo: 'b',
            number: 2,
            dependency: 'y',
            breach: true,
            daysOverdue: 10,
            ageDays: 20,
            slaLabel: 'Minor',
            security: false,
            risk: 'medium',
            fromVersion: '1',
            toVersion: '2',
            title: 'high overdue',
        },
    ];
    const md = renderTrackingIssue(makeHealth(prs), []);
    const lowIdx = md.indexOf('low overdue');
    const highIdx = md.indexOf('high overdue');
    assert.ok(highIdx < lowIdx, 'higher-overdue PR should appear first');
});

test('renderTrackingIssue: security column shows yes for security PRs', () => {
    const prs = [
        {
            repo: 'cli',
            number: 1,
            dependency: 'svgo',
            breach: true,
            daysOverdue: 2,
            ageDays: 5,
            slaLabel: 'Critical security',
            security: true,
            risk: 'critical',
            fromVersion: '3.3.2',
            toVersion: '3.3.3',
            title: '[Security] Bump svgo',
        },
    ];
    const md = renderTrackingIssue(makeHealth(prs), []);
    assert.ok(md.includes('yes'));
    assert.ok(md.includes('[Security] Bump svgo'));
});

test('renderTrackingIssue: handles null health', () => {
    const md = renderTrackingIssue(null, []);
    assert.ok(md.includes('No SLA breaches detected'));
});

test('renderTrackingIssue: summary counts reflect health summary', () => {
    const health = {
        prs: [
            {
                repo: 'cli',
                number: 1,
                dependency: 'svgo',
                breach: true,
                daysOverdue: 3,
                ageDays: 10,
                slaLabel: 'Patch',
                security: false,
                risk: 'high',
                fromVersion: '3.3.2',
                toVersion: '3.3.3',
                title: 'Bump svgo',
            },
        ],
        exceptions: [],
        summary: {securityBreaching: 1, criticalBreaching: 0},
    };
    const md = renderTrackingIssue(health, []);
    assert.ok(md.includes('Security PRs breaching | 1'));
    assert.ok(md.includes('Critical-risk PRs breaching | 0'));
});

test('renderTrackingIssue: distinct owners count in summary', () => {
    const prs = [
        {
            repo: 'cli',
            number: 1,
            dependency: 'svgo',
            breach: true,
            daysOverdue: 3,
            ageDays: 10,
            slaLabel: 'Patch',
            security: false,
            risk: 'high',
            fromVersion: '3.3.2',
            toVersion: '3.3.3',
            title: 'Bump svgo',
        },
        {
            repo: 'utils',
            number: 2,
            dependency: 'lodash',
            breach: true,
            daysOverdue: 1,
            ageDays: 8,
            slaLabel: 'Patch',
            security: false,
            risk: 'low',
            fromVersion: '4.17.20',
            toVersion: '4.17.21',
            title: 'Bump lodash',
        },
    ];
    const registry = [{id: 'DEP-0001', dependency: 'svgo', owner: '@alice', repositories: ['cli']}];
    const md = renderTrackingIssue(makeHealth(prs), registry);
    assert.ok(md.includes('Distinct owners | 2'));
});

test('renderTrackingIssue: custom defaultOwner is used', () => {
    const prs = [
        {
            repo: 'utils',
            number: 1,
            dependency: 'lodash',
            breach: true,
            daysOverdue: 1,
            ageDays: 8,
            slaLabel: 'Patch',
            security: false,
            risk: 'low',
            fromVersion: '4.17.20',
            toVersion: '4.17.21',
            title: 'Bump lodash',
        },
    ];
    const md = renderTrackingIssue(makeHealth(prs), [], '@custom-team');
    assert.ok(md.includes('Owner: @custom-team'));
});

test('renderTrackingIssue: includes reference to svgo-exception-tagging doc', () => {
    const prs = [
        {
            repo: 'cli',
            number: 1,
            dependency: 'svgo',
            breach: true,
            daysOverdue: 3,
            ageDays: 10,
            slaLabel: 'Patch',
            security: false,
            risk: 'high',
            fromVersion: '3.3.2',
            toVersion: '3.3.3',
            title: 'Bump svgo',
        },
    ];
    const md = renderTrackingIssue(makeHealth(prs), []);
    assert.ok(md.includes('svgo-exception-tagging.md'));
});

test('renderTrackingIssue: generated-by footer present', () => {
    const md = renderTrackingIssue(makeHealth([]), []);
    assert.ok(md.includes('@diplodoc/infra'));
    assert.ok(md.includes('T8.3'));
});

module.exports = {tests};
