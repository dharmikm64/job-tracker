const test = require('node:test');
const assert = require('node:assert');
require('./helpers/load').loadApp();
const { E } = require('./fixtures/emails');

const config = Config.build({ INITIAL_IMPORT_START: '2026-06-01' });
const ctx = { runId: 'RUN-test', now: new Date('2026-11-01T00:00:00') };

function planAll(emails, apps = []) {
  return SyncPlanner.plan(emails, apps, {}, config, ctx);
}
const actions = (p) => Object.fromEntries(p.decisions.map((x) => [x.email.id, x.decision.action]));
const appBy = (p, pred) => p.workingApps.filter(pred);

test('Summer 2027 confirmation creates an Applied record; Summer 2026 is ignored', () => {
  const p = planAll([E.acmeConfirm, E.globex2026, E.northwindCoop]);
  const a = actions(p);
  assert.strictEqual(a['m-acme-1'], 'CREATE');
  assert.strictEqual(a['m-nw-1'], 'CREATE');
  assert.strictEqual(a['m-globex-1'], 'IGNORE');
  const acme = appBy(p, (x) => x.company === 'Acme Robotics')[0];
  assert.strictEqual(acme.status, 'Applied');
  assert.strictEqual(acme.term, 'Summer 2027');
  assert.strictEqual(acme.appliedDate.getTime(), E.acmeConfirm.date.getTime());
  assert.strictEqual(appBy(p, (x) => x.company === 'Globex').length, 0);
});

test('graduation-2027 email with no term goes to review, not to Applications', () => {
  const p = planAll([E.initechGrad]);
  assert.strictEqual(actions(p)['m-initech-1'], 'REVIEW');
  assert.match(p.reviews[0].reason, /No hiring term/);
  assert.strictEqual(p.workingApps.length, 0);
});

test('rejection with no term updates the matching Summer 2027 application', () => {
  const p = planAll([E.acmeConfirm, E.acmeReject]);
  assert.strictEqual(actions(p)['m-acme-2'], 'UPDATE');
  const acme = p.workingApps[0];
  assert.strictEqual(acme.status, 'Rejected');
  assert.strictEqual(p.workingApps.length, 1);
});

test('rejection reply in a linked thread matches even without role or term', () => {
  const p = planAll([E.acmeConfirm, E.acmeThreadReject]);
  const d = p.decisions.find((x) => x.email.id === 'm-acme-3').decision;
  assert.strictEqual(d.action, 'UPDATE');
  assert.match(d.reason, /thread/);
});

test('two roles at the same company stay separate (even in one Gmail thread)', () => {
  const p = planAll([E.contosoSwe, E.contosoPm, E.contosoPmInterview]);
  const contoso = appBy(p, (x) => x.company === 'Contoso');
  assert.strictEqual(contoso.length, 2);
  const pm = contoso.find((x) => x.role === 'Product Manager Intern');
  const swe = contoso.find((x) => x.role === 'Software Engineer Intern');
  assert.strictEqual(pm.status, 'Interview');
  assert.strictEqual(swe.status, 'Applied');
});

test('ambiguous email (company with two roles, no role named) goes to review with both candidates', () => {
  const p = planAll([E.contosoSwe, E.contosoPm, E.contosoVague]);
  assert.strictEqual(actions(p)['m-contoso-4'], 'REVIEW');
  const r = p.reviews.find((x) => x.messageId === 'm-contoso-4');
  assert.strictEqual(r.candidateAppId.split(', ').length, 2);
  assert.ok(appBy(p, (x) => x.status === 'Rejected').length === 0);
});

test('first-seen interview creates the app without an Applied Date; delayed confirmation does not regress status', () => {
  const p = planAll([E.hooliInterview, E.hooliLateConfirm]);
  assert.strictEqual(p.workingApps.length, 1);
  const hooli = p.workingApps[0];
  assert.strictEqual(hooli.status, 'Interview');
  assert.strictEqual(hooli.appliedDate.toDateString(), new Date(2026, 8, 20).toDateString());

  const onlyInterview = planAll([E.hooliInterview]).workingApps[0];
  assert.strictEqual(onlyInterview.appliedDate, null);
});

test('newsletter mentioning interviews creates nothing', () => {
  const p = planAll([E.newsletter]);
  assert.strictEqual(actions(p)['m-news-1'], 'SKIP');
  assert.strictEqual(p.events.length, 0);
});

test('duplicate message IDs are skipped (already known or repeated in batch)', () => {
  const p = SyncPlanner.plan([E.acmeConfirm, E.acmeConfirm], [], { 'm-x': true }, config, ctx);
  assert.strictEqual(p.events.length, 1);
  const again = SyncPlanner.plan([E.acmeConfirm], p.workingApps, { 'm-acme-1': true }, config, ctx);
  assert.strictEqual(again.events.length, 0);
});

test('labeled thread that is not recognized goes to review instead of being skipped', () => {
  const email = { id: 'm-lab', threadId: 't-lab', date: new Date('2026-09-01'), from: 'x <x@y.z>',
    subject: 'Coffee chat', body: 'Nice talking today!', labels: ['job-tracker-include'] };
  assert.strictEqual(actions(planAll([email]))['m-lab'], 'REVIEW');
});

// ---- StatusEngine ---------------------------------------------------------

const base = () => StatusEngine.newApplication('APP-1', { company: 'Acme', role: 'SWE Intern', term: 'Summer 2027' }, new Date());
const ev = (type, date, extra = {}) => ({ type, eventDate: new Date(date), ...extra });

test('status: old confirmation never overwrites a newer interview', () => {
  let a = StatusEngine.apply(base(), ev('INTERVIEW', '2026-10-01')).app;
  a = StatusEngine.apply(a, ev('APPLIED', '2026-09-01')).app;
  assert.strictEqual(a.status, 'Interview');
  assert.strictEqual(a.appliedDate.toISOString(), new Date('2026-09-01').toISOString());
});

test('status: reminder does not change status but can set a deadline', () => {
  let a = StatusEngine.apply(base(), ev('ASSESSMENT', '2026-10-01')).app;
  const r = StatusEngine.apply(a, ev('REMINDER', '2026-10-03', { deadline: new Date('2026-10-08') }));
  assert.strictEqual(r.app.status, 'Assessment');
  assert.strictEqual(r.statusChanged, false);
  assert.strictEqual(r.app.nextDeadline.toISOString(), new Date('2026-10-08').toISOString());
});

test('status: newer interview after rejection goes to review; older one is ignored quietly', () => {
  const rejected = StatusEngine.apply(base(), ev('REJECTED', '2026-10-10')).app;
  assert.match(StatusEngine.apply(rejected, ev('INTERVIEW', '2026-10-15')).review, /after Rejected/);
  const older = StatusEngine.apply(rejected, ev('INTERVIEW', '2026-10-01'));
  assert.strictEqual(older.review, null);
  assert.strictEqual(older.app.status, 'Rejected');
});

test('status: stages are not forced into one order (assessment after interview is allowed)', () => {
  let a = StatusEngine.apply(base(), ev('INTERVIEW', '2026-10-01')).app;
  a = StatusEngine.apply(a, ev('ASSESSMENT', '2026-10-05')).app;
  assert.strictEqual(a.status, 'Assessment');
});

test('status: manual lock keeps status but other fields still update', () => {
  const a = { ...StatusEngine.apply(base(), ev('APPLIED', '2026-09-01')).app, locked: true };
  const r = StatusEngine.apply(a, ev('REJECTED', '2026-10-01'));
  assert.strictEqual(r.app.status, 'Applied');
  assert.strictEqual(r.app.lastEventDate.toISOString(), new Date('2026-10-01').toISOString());
});

test('status: applying the same event twice is a no-op the second time', () => {
  const e = ev('INTERVIEW', '2026-10-01', { threadId: 't1', link: 'L' });
  const once = StatusEngine.apply(base(), e).app;
  const twice = StatusEngine.apply(once, e);
  assert.strictEqual(twice.changed, false);
  assert.ok(StatusEngine.equalApps(once, twice.app));
});

test('matcher: same req ID with a different term is a conflict', () => {
  const app = { ...base(), company: 'Acme Robotics', reqId: 'R-10452', term: 'Summer 2027' };
  const m = ApplicationMatcher.match({ company: 'Acme Robotics', reqId: 'R-10452', term: 'Summer 2026', threadId: 'z' }, [app]);
  assert.strictEqual(m.type, 'CONFLICT');
});

test('matcher: company-only match is opt-in', () => {
  const app = { ...base(), company: 'Acme' };
  const ext = { company: 'Acme', threadId: 'z' };
  assert.strictEqual(ApplicationMatcher.match(ext, [app]).type, 'AMBIGUOUS');
  assert.strictEqual(ApplicationMatcher.match(ext, [app], { allowCompanyOnlyMatch: true }).type, 'MATCH');
});
