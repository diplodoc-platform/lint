const assert = require('node:assert');

const {
    SLA_RULES,
    DEFAULT_SLA_CATEGORY,
    isWeekend,
    addCalendarDays,
    addBusinessDays,
    slaDeadline,
    selectSlaCategory,
    assessSla,
    assessExceptionReview,
    computeHealth,
    summarizeHealth,
    renderHealthMarkdown,
} = require('../../scripts/dependency-health');

const tests = [];
function test(name, fn) {
    tests.push({name, fn});
}

// --- SLA_RULES -------------------------------------------------------------

test('SLA_RULES: contains all 7 categories', () => {
    const keys = Object.keys(SLA_RULES);
    for (const k of [
        'critical-security',
        'security',
        'patch',
        'minor',
        'major',
        'unknown',
        'exception',
    ]) {
        assert.ok(keys.includes(k), `missing ${k}`);
    }
    assert.strictEqual(keys.length, 7);
});

test('SLA_RULES: security uses business days, others calendar days', () => {
    assert.strictEqual(SLA_RULES['critical-security'].businessDays, true);
    assert.strictEqual(SLA_RULES['security'].businessDays, true);
    assert.strictEqual(SLA_RULES['patch'].businessDays, false);
    assert.strictEqual(SLA_RULES['minor'].businessDays, false);
    assert.strictEqual(SLA_RULES['major'].businessDays, false);
    assert.strictEqual(SLA_RULES['exception'].businessDays, false);
});

test('SLA_RULES: days match the platform SLA', () => {
    assert.strictEqual(SLA_RULES['critical-security'].days, 1);
    assert.strictEqual(SLA_RULES['security'].days, 3);
    assert.strictEqual(SLA_RULES['patch'].days, 7);
    assert.strictEqual(SLA_RULES['minor'].days, 14);
    assert.strictEqual(SLA_RULES['major'].days, 30);
    assert.strictEqual(SLA_RULES['exception'].days, 90);
});

// --- isWeekend -------------------------------------------------------------

test('isWeekend: Saturday and Sunday are weekends', () => {
    assert.strictEqual(isWeekend(new Date('2026-08-22T12:00:00Z')), true); // Sat
    assert.strictEqual(isWeekend(new Date('2026-08-23T12:00:00Z')), true); // Sun
});

test('isWeekend: weekdays are not weekends', () => {
    assert.strictEqual(isWeekend(new Date('2026-08-21T12:00:00Z')), false); // Fri
    assert.strictEqual(isWeekend(new Date('2026-08-24T12:00:00Z')), false); // Mon
});

// --- addCalendarDays -------------------------------------------------------

test('addCalendarDays: adds days including weekends', () => {
    const d = new Date('2026-08-21T12:00:00Z'); // Thu
    const result = addCalendarDays(d, 7);
    assert.strictEqual(result.toISOString(), '2026-08-28T12:00:00.000Z'); // Thu next week
});

test('addCalendarDays: does not mutate input', () => {
    const d = new Date('2026-08-21T12:00:00Z');
    const orig = d.getTime();
    addCalendarDays(d, 5);
    assert.strictEqual(d.getTime(), orig);
});

test('addCalendarDays: zero returns same date', () => {
    const d = new Date('2026-08-21T12:00:00Z');
    assert.strictEqual(addCalendarDays(d, 0).getTime(), d.getTime());
});

// --- addBusinessDays -------------------------------------------------------

test('addBusinessDays: skips weekends', () => {
    const fri = new Date('2026-08-21T12:00:00Z'); // Fri
    // +1 business day -> Mon
    assert.strictEqual(addBusinessDays(fri, 1).getUTCDay(), 1);
    // +3 business days -> Wed
    assert.strictEqual(addBusinessDays(fri, 3).getUTCDay(), 3);
});

test('addBusinessDays: Mon +5 business days = next Mon', () => {
    const mon = new Date('2026-08-24T12:00:00Z'); // Mon
    const result = addBusinessDays(mon, 5);
    assert.strictEqual(result.getUTCDay(), 1); // next Mon
});

test('addBusinessDays: zero returns same date', () => {
    const d = new Date('2026-08-24T12:00:00Z');
    assert.strictEqual(addBusinessDays(d, 0).getTime(), d.getTime());
});

test('addBusinessDays: does not mutate input', () => {
    const d = new Date('2026-08-21T12:00:00Z');
    const orig = d.getTime();
    addBusinessDays(d, 3);
    assert.strictEqual(d.getTime(), orig);
});

// --- slaDeadline -----------------------------------------------------------

test('slaDeadline: calendar days for patch', () => {
    const created = new Date('2026-08-20T12:00:00Z');
    const rule = SLA_RULES.patch;
    const deadline = slaDeadline(created, rule);
    assert.strictEqual(deadline.toISOString(), '2026-08-27T12:00:00.000Z');
});

test('slaDeadline: business days for critical security', () => {
    // Friday + 1 business day = Monday
    const fri = new Date('2026-08-21T12:00:00Z'); // Fri
    const rule = SLA_RULES['critical-security'];
    const deadline = slaDeadline(fri, rule);
    assert.strictEqual(deadline.getUTCDay(), 1); // Mon
});

test('slaDeadline: handles invalid date', () => {
    const rule = SLA_RULES.patch;
    const deadline = slaDeadline('not-a-date', rule);
    assert.ok(deadline instanceof Date);
});

// --- selectSlaCategory -----------------------------------------------------

test('selectSlaCategory: critical security PR -> critical-security', () => {
    assert.strictEqual(selectSlaCategory({security: true, risk: 'critical'}), 'critical-security');
});

test('selectSlaCategory: non-critical security PR -> security', () => {
    assert.strictEqual(selectSlaCategory({security: true, risk: 'high'}), 'security');
    assert.strictEqual(selectSlaCategory({security: true, risk: 'medium'}), 'security');
    assert.strictEqual(selectSlaCategory({security: true}), 'security');
});

test('selectSlaCategory: patch update -> patch', () => {
    assert.strictEqual(selectSlaCategory({security: false, updateType: 'patch'}), 'patch');
});

test('selectSlaCategory: minor update -> minor', () => {
    assert.strictEqual(selectSlaCategory({security: false, updateType: 'minor'}), 'minor');
});

test('selectSlaCategory: major update -> major', () => {
    assert.strictEqual(selectSlaCategory({security: false, updateType: 'major'}), 'major');
});

test('selectSlaCategory: unknown update type -> default', () => {
    assert.strictEqual(
        selectSlaCategory({security: false, updateType: 'unknown'}),
        DEFAULT_SLA_CATEGORY,
    );
    assert.strictEqual(selectSlaCategory({security: false}), DEFAULT_SLA_CATEGORY);
    assert.strictEqual(selectSlaCategory({}), DEFAULT_SLA_CATEGORY);
});

test('selectSlaCategory: null input -> default', () => {
    assert.strictEqual(selectSlaCategory(null), DEFAULT_SLA_CATEGORY);
});

// --- assessSla -------------------------------------------------------------

function makePr(overrides = {}) {
    return {
        repo: 'cli',
        number: 1,
        title: 'Bump foo from 1.0.0 to 1.0.1',
        url: 'https://x',
        dependency: 'foo',
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        security: false,
        risk: 'low',
        updateType: 'patch',
        checkStatus: 'passing',
        createdAt: '2026-08-20T12:00:00Z',
        ageDays: 3,
        ...overrides,
    };
}

test('assessSla: within SLA not breaching', () => {
    const now = new Date('2026-08-23T12:00:00Z'); // 3 days after creation
    const pr = makePr({createdAt: '2026-08-20T12:00:00Z', ageDays: 3, updateType: 'patch'});
    const assessed = assessSla(pr, now);
    assert.strictEqual(assessed.slaCategory, 'patch');
    assert.strictEqual(assessed.slaDays, 7);
    assert.strictEqual(assessed.breach, false);
    assert.strictEqual(assessed.daysOverdue, 0);
});

test('assessSla: patch past 7 days is breaching', () => {
    const now = new Date('2026-08-30T12:00:00Z'); // 10 days after creation
    const pr = makePr({createdAt: '2026-08-20T12:00:00Z', ageDays: 10, updateType: 'patch'});
    const assessed = assessSla(pr, now);
    assert.strictEqual(assessed.breach, true);
    assert.strictEqual(assessed.daysOverdue, 3);
});

test('assessSla: critical security uses business days', () => {
    // Created Friday, deadline is Monday (1 business day). On Tuesday it's breached.
    const pr = makePr({
        createdAt: '2026-08-21T12:00:00Z', // Fri
        security: true,
        risk: 'critical',
        updateType: 'patch',
    });
    const tue = new Date('2026-08-25T12:00:00Z'); // Tue
    const assessed = assessSla(pr, tue);
    assert.strictEqual(assessed.slaCategory, 'critical-security');
    assert.strictEqual(assessed.slaDays, 1);
    assert.strictEqual(assessed.breach, true);
});

test('assessSla: critical security on Monday not breached', () => {
    const pr = makePr({
        createdAt: '2026-08-21T12:00:00Z', // Fri
        security: true,
        risk: 'critical',
        updateType: 'patch',
    });
    const mon = new Date('2026-08-24T10:00:00Z'); // Mon, before deadline
    const assessed = assessSla(pr, mon);
    assert.strictEqual(assessed.breach, false);
});

test('assessSla: major uses 30 calendar days', () => {
    const pr = makePr({createdAt: '2026-08-01T12:00:00Z', ageDays: 31, updateType: 'major'});
    const now = new Date('2026-09-01T12:00:00Z'); // exactly 1 day past 30-day deadline
    const assessed = assessSla(pr, now);
    assert.strictEqual(assessed.slaCategory, 'major');
    assert.strictEqual(assessed.slaDays, 30);
    assert.strictEqual(assessed.breach, true);
    assert.strictEqual(assessed.daysOverdue, 1);
});

test('assessSla: preserves PR metadata', () => {
    const pr = makePr();
    const assessed = assessSla(pr, new Date('2026-08-23T12:00:00Z'));
    assert.strictEqual(assessed.repo, 'cli');
    assert.strictEqual(assessed.number, 1);
    assert.strictEqual(assessed.dependency, 'foo');
    assert.strictEqual(assessed.fromVersion, '1.0.0');
    assert.strictEqual(assessed.toVersion, '1.0.1');
    assert.strictEqual(assessed.security, false);
    assert.strictEqual(assessed.risk, 'low');
    assert.strictEqual(assessed.checkStatus, 'passing');
});

// --- assessExceptionReview -------------------------------------------------

test('assessExceptionReview: returns null for missing id', () => {
    assert.strictEqual(assessExceptionReview({}), null);
    assert.strictEqual(assessExceptionReview(null), null);
});

test('assessExceptionReview: returns null for missing review-after', () => {
    assert.strictEqual(assessExceptionReview({id: 'DEP-0001'}), null);
});

test('assessExceptionReview: returns null for invalid date', () => {
    assert.strictEqual(assessExceptionReview({id: 'DEP-0001', 'review-after': 'not-a-date'}), null);
});

test('assessExceptionReview: computes days until review', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const entry = {
        id: 'DEP-0001',
        dependency: 'svgo',
        'review-after': '2026-09-01',
        repositories: ['cli'],
    };
    const result = assessExceptionReview(entry, now);
    assert.strictEqual(result.id, 'DEP-0001');
    assert.strictEqual(result.dependency, 'svgo');
    assert.deepStrictEqual(result.repositories, ['cli']);
    assert.strictEqual(result.overdue, false);
    assert.strictEqual(result.reviewWindow, 90);
    assert.ok(result.daysUntilReview > 0);
});

test('assessExceptionReview: overdue when review-after in past', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const entry = {id: 'DEP-0002', 'review-after': '2026-08-01'};
    const result = assessExceptionReview(entry, now);
    assert.strictEqual(result.overdue, true);
    assert.ok(result.daysUntilReview < 0);
});

test('assessExceptionReview: handles Date object review-after', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const entry = {id: 'DEP-0003', 'review-after': new Date('2026-09-01T00:00:00Z')};
    const result = assessExceptionReview(entry, now);
    assert.strictEqual(result.overdue, false);
});

test('assessExceptionReview: handles camelCase reviewAfter', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const entry = {id: 'DEP-0004', reviewAfter: '2026-09-01'};
    const result = assessExceptionReview(entry, now);
    assert.strictEqual(result.id, 'DEP-0004');
    assert.strictEqual(result.overdue, false);
});

// --- computeHealth ---------------------------------------------------------

test('computeHealth: empty inventory and registry', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const health = computeHealth([], [], now);
    assert.deepStrictEqual(health.prs, []);
    assert.deepStrictEqual(health.exceptions, []);
    assert.strictEqual(health.summary.totalPrs, 0);
    assert.strictEqual(health.summary.breachingPrs, 0);
});

test('computeHealth: assesses each PR with SLA', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const inventory = [
        makePr({
            repo: 'cli',
            number: 1,
            createdAt: '2026-08-20T12:00:00Z',
            updateType: 'patch',
            ageDays: 3,
        }),
        makePr({
            repo: 'transform',
            number: 5,
            createdAt: '2026-08-01T12:00:00Z',
            updateType: 'major',
            ageDays: 22,
            risk: 'high',
        }),
    ];
    const health = computeHealth(inventory, [], now);
    assert.strictEqual(health.prs.length, 2);
    assert.strictEqual(health.prs[0].slaCategory, 'patch');
    assert.strictEqual(health.prs[1].slaCategory, 'major');
});

test('computeHealth: collects exceptions', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'review-after': '2026-09-01', repositories: ['cli']},
        {id: 'DEP-0002', dependency: 'other', 'review-after': '2026-07-01'},
    ];
    const health = computeHealth([], registry, now);
    assert.strictEqual(health.exceptions.length, 2);
    assert.strictEqual(health.exceptions[0].id, 'DEP-0001');
    assert.strictEqual(health.exceptions[1].overdue, true);
});

// --- summarizeHealth -------------------------------------------------------

test('summarizeHealth: counts breaches and categories', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    // patch SLA=7d (deadline 08-27 -> breach), minor SLA=14d (deadline 09-03 -> not breach),
    // critical-security SLA=1 business day (created Fri -> deadline Mon 08-24 -> breach)
    const inventory = [
        makePr({
            repo: 'cli',
            number: 1,
            createdAt: '2026-08-20T12:00:00Z',
            updateType: 'patch',
            ageDays: 10,
            risk: 'low',
            checkStatus: 'passing',
        }),
        makePr({
            repo: 'cli',
            number: 2,
            createdAt: '2026-08-20T12:00:00Z',
            updateType: 'minor',
            ageDays: 10,
            risk: 'medium',
            checkStatus: 'failing',
        }),
        makePr({
            repo: 'cli',
            number: 3,
            createdAt: '2026-08-21T12:00:00Z',
            security: true,
            risk: 'critical',
            updateType: 'patch',
            ageDays: 9,
            checkStatus: 'passing',
        }),
    ];
    const health = computeHealth(inventory, [], now);
    const s = health.summary;
    assert.strictEqual(s.totalPrs, 3);
    assert.strictEqual(s.breachingPrs, 2); // patch + critical-security breach; minor does not
    assert.strictEqual(s.securityPrs, 1);
    assert.strictEqual(s.securityBreaching, 1);
    assert.strictEqual(s.criticalPrs, 1);
    assert.strictEqual(s.criticalBreaching, 1);
    assert.strictEqual(s.failingPrs, 1);
    assert.ok(s.breachingByCategory.patch >= 1);
    assert.ok(s.breachingByCategory['critical-security'] >= 1);
});

test('summarizeHealth: exception counts', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const registry = [
        {id: 'DEP-0001', 'review-after': '2026-09-01'}, // 9 days left -> expiring (<=14)
        {id: 'DEP-0002', 'review-after': '2026-08-30'}, // 7 days left -> expiring
        {id: 'DEP-0003', 'review-after': '2026-07-01'}, // overdue
    ];
    const health = computeHealth([], registry, now);
    const s = health.summary;
    assert.strictEqual(s.totalExceptions, 3);
    assert.strictEqual(s.expiringExceptions, 2);
    assert.strictEqual(s.overdueExceptions, 1);
});

// --- renderHealthMarkdown ---------------------------------------------------

test('renderHealthMarkdown: includes SLA summary and rules', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const health = computeHealth([], [], now);
    const md = renderHealthMarkdown(health);
    assert.ok(md.includes('# Dependency Health Audit'));
    assert.ok(md.includes('## SLA Summary'));
    assert.ok(md.includes('## SLA Rules'));
    assert.ok(md.includes('Critical security'));
    assert.ok(md.includes('business days'));
});

test('renderHealthMarkdown: lists breaches when present', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    const inventory = [
        makePr({
            repo: 'cli',
            number: 42,
            title: 'Bump x | y',
            createdAt: '2026-08-20T12:00:00Z',
            updateType: 'patch',
            ageDays: 10,
        }),
    ];
    const health = computeHealth(inventory, [], now);
    const md = renderHealthMarkdown(health);
    assert.ok(md.includes('## SLA Breaches'));
    assert.ok(md.includes('cli'));
    assert.ok(md.includes('42'));
    assert.ok(md.includes('\\|'), 'pipe in title escaped');
});

test('renderHealthMarkdown: lists exceptions when present', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const registry = [
        {id: 'DEP-0001', dependency: 'svgo', 'review-after': '2026-09-01', repositories: ['cli']},
    ];
    const health = computeHealth([], registry, now);
    const md = renderHealthMarkdown(health);
    assert.ok(md.includes('## Exception Review Status'));
    assert.ok(md.includes('DEP-0001'));
    assert.ok(md.includes('svgo'));
});

test('renderHealthMarkdown: shows breaches by category table', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    const inventory = [
        makePr({
            repo: 'cli',
            number: 1,
            createdAt: '2026-08-20T12:00:00Z',
            updateType: 'patch',
            ageDays: 10,
        }),
    ];
    const health = computeHealth(inventory, [], now);
    const md = renderHealthMarkdown(health);
    assert.ok(md.includes('### Breaches by SLA category'));
});

module.exports = {tests};
