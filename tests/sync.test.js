// End-to-end sync tests using fake Gmail / Sheets / Properties services.
const test = require('node:test');
const assert = require('node:assert');
require('./helpers/load').loadApp();
const { installFakes, makeGmail } = require('./helpers/fakes');
const { E } = require('./fixtures/emails');

const ALL = Object.values(E);
const PROPS = { INITIAL_IMPORT_START: '2026-06-01', PAGE_SIZE: '25' };

function setupWorld(emails = ALL, props = PROPS) {
  const w = installFakes({ emails, props });
  setup(); // Main.js entry point: creates tabs and default settings
  return w;
}
const sheet = (w, name) => w.spreadsheet.getSheetByName(name);
const apps = (w) => sheet(w, 'Applications').rows();
const events = (w) => sheet(w, 'Events').rows();
const reviews = (w) => sheet(w, 'Review Queue').rows();

test('full sync builds the expected applications and review items', () => {
  const w = setupWorld();
  syncNow();
  const a = apps(w);
  const byKey = Object.fromEntries(a.map((x) => [x['Company'] + ' / ' + x['Role'], x]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), [
    'Acme Robotics / Software Engineer Intern',
    'Contoso / Product Manager Intern',
    'Contoso / Software Engineer Intern',
    'Evil Corp / =HYPERLINK("http://evil.example","Intern")',
    'Hooli / Software Engineering Intern',
    'Northwind Systems / Embedded Software Co-op'
  ]);
  assert.strictEqual(byKey['Acme Robotics / Software Engineer Intern']['Current Status'], 'Rejected');
  assert.strictEqual(byKey['Contoso / Product Manager Intern']['Current Status'], 'Interview');
  assert.strictEqual(byKey['Hooli / Software Engineering Intern']['Current Status'], 'Interview');
  assert.strictEqual(byKey['Northwind Systems / Embedded Software Co-op']['Hiring Term'], 'Spring 2027');
  // No Globex (Summer 2026), no Initech (no term), no newsletter.
  assert.ok(!a.some((x) => /Globex|Initech|Handshake/.test(x['Company'])));

  const reasons = reviews(w).map((r) => r['Message ID'] + ': ' + r['Review Reason']);
  assert.ok(reasons.some((r) => r.startsWith('m-initech-1')), reasons.join('\n'));
  assert.ok(reasons.some((r) => r.startsWith('m-contoso-4')), reasons.join('\n'));
  assert.ok(events(w).every((e) => e['Processing State'] !== 'PENDING'));
  const log = sheet(w, 'Sync Log').rows();
  assert.strictEqual(log.length, 1);
  assert.ok(log[0]['End Time']);
  assert.strictEqual(log[0]['Errors'], '');
});

test('email-derived strings are never written as formulas', () => {
  const w = setupWorld();
  syncNow();
  for (const s of Object.values(w.spreadsheet.sheets)) assert.deepStrictEqual(s.formulaWrites, [], s.name);
});

test('re-running sync (and resetting the checkpoint) creates no duplicates', () => {
  const w = setupWorld();
  syncNow();
  const snapshot = JSON.stringify([apps(w), events(w).length, reviews(w).length]);
  syncNow();
  resetSyncCheckpoint();
  syncNow();
  assert.strictEqual(JSON.stringify([apps(w), events(w).length, reviews(w).length]), snapshot);
});

test('interrupted run: crash after saving applications, before marking events complete', () => {
  const w = setupWorld();
  const realUpdate = SheetRepository.updateEvents;
  let crashed = false;
  SheetRepository.updateEvents = function (updates) {
    if (!crashed && updates.some((u) => u.fields.state === 'COMPLETED')) {
      crashed = true;
      throw new Error('Simulated timeout');
    }
    return realUpdate(updates);
  };
  assert.throws(() => syncNow(), /Simulated timeout/);
  SheetRepository.updateEvents = realUpdate;

  // State after the crash: some apps written, their events still PENDING,
  // checkpoint not advanced, lock released, Sync Log shows the error.
  const pending = events(w).filter((e) => e['Processing State'] === 'PENDING');
  assert.ok(pending.length > 0);
  // Earlier windows may have finished and saved their checkpoint, but the
  // checkpoint must never pass a message whose event is still PENDING.
  const saved = JSON.parse(w.props.getProperty('SYNC_STATE') || '{"lastCompletedEnd":0}').lastCompletedEnd;
  const msgDate = (e) => ALL.find((m) => m.id === e['Gmail Message ID']).date.getTime();
  assert.ok(pending.every((e) => saved <= msgDate(e)), 'checkpoint skipped past unfinished work');
  assert.strictEqual(w.lockState.held, false);
  assert.match(sheet(w, 'Sync Log').rows()[0]['Errors'], /Simulated timeout/);

  syncNow(); // retry
  assert.ok(events(w).every((e) => e['Processing State'] !== 'PENDING'));

  // Same final result as a clean run.
  const clean = setupWorld();
  syncNow();
  const strip = (rows) => rows.map((r) => [r['Application ID'], r['Company'], r['Role'], r['Current Status']].join('|')).sort();
  assert.deepStrictEqual(strip(apps(w)), strip(apps(clean)));
  assert.strictEqual(events(w).length, events(clean).length);
});

test('interrupted run: crash while writing events leaves the checkpoint alone', () => {
  const w = setupWorld();
  const realAppend = SheetRepository.appendEvents;
  let calls = 0;
  SheetRepository.appendEvents = function (evts) {
    if (++calls === 3) throw new Error('Simulated crash');
    return realAppend(evts);
  };
  assert.throws(() => syncNow(), /Simulated crash/);
  SheetRepository.appendEvents = realAppend;
  const checkpoint = JSON.parse(w.props.getProperty('SYNC_STATE') || '{"lastCompletedEnd":null}').lastCompletedEnd;
  syncNow();
  const after = JSON.parse(w.props.getProperty('SYNC_STATE')).lastCompletedEnd;
  assert.ok(checkpoint === null || checkpoint < after);
  const ids = events(w).map((e) => e['Gmail Message ID']);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate events');
});

test('dry run changes no applications, events or checkpoint', () => {
  const w = setupWorld();
  dryRun();
  assert.strictEqual(apps(w).length, 0);
  assert.strictEqual(events(w).length, 0);
  assert.strictEqual(reviews(w).length, 0);
  assert.strictEqual(w.props.getProperty('SYNC_STATE'), null);
  const preview = sheet(w, 'Dry Run Preview').rows();
  assert.ok(preview.some((r) => r['Action'] === 'CREATE' && r['Company'] === 'Acme Robotics'));
  assert.ok(preview.some((r) => r['Action'] === 'IGNORE' && r['Company'] === 'Globex'));
});

test('overlapping run is skipped while the lock is held', () => {
  const w = setupWorld();
  w.lockState.held = true;
  const s = SyncService.run({});
  assert.strictEqual(s.skipped, true);
  assert.strictEqual(apps(w).length, 0);
});

test('large windows are split instead of paged by offset', () => {
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push({ ...E.contosoSwe, id: 'm-bulk-' + i, threadId: 't-bulk-' + i,
      date: new Date(2026, 8, 1, i), subject: 'Thank you for applying to Contoso',
      body: `Thanks for applying to Contoso! We received your application for the Robotics Engineer Intern ${i} (Summer 2027) role.` });
  }
  const w = setupWorld(many, { ...PROPS, PAGE_SIZE: '10' });
  syncNow();
  assert.strictEqual(apps(w).length, 30);
  // The window was halved at least once because a page came back full.
  assert.ok(w.gmail.calls.search.length > 1);
});

test('manual edits (Notes, Status Lock, corrected Company) survive later syncs', () => {
  const w = setupWorld([E.acmeConfirm]);
  syncNow();
  const sh = sheet(w, 'Applications');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = (h) => head.indexOf(h) + 1;
  sh.getRange(2, col('Notes'), 1, 1).setValues([['Referred by Sam']]);
  sh.getRange(2, col('Manual Status Lock'), 1, 1).setValues([[true]]);
  sh.getRange(2, col('Company'), 1, 1).setValues([['Acme Robotics (Boston)']]);

  // A rejection arrives later (same thread, so it still matches).
  global.GmailApp = makeGmail([E.acmeConfirm, E.acmeThreadReject]);
  syncNow();
  const row = apps(w)[0];
  assert.strictEqual(row['Notes'], 'Referred by Sam');
  assert.strictEqual(row['Manual Status Lock'], true);
  assert.strictEqual(row['Company'], 'Acme Robotics (Boston)');
  assert.strictEqual(row['Current Status'], 'Applied'); // locked
});

test('review workflow: Link, Correct (create), Ignore — and processing twice changes nothing', () => {
  const w = setupWorld();
  syncNow();
  const sh = sheet(w, 'Review Queue');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = (h) => head.indexOf(h) + 1;
  const rowOf = (msgId) => reviews(w).findIndex((r) => r['Message ID'] === msgId) + 2;
  const pmId = apps(w).find((a) => a['Role'] === 'Product Manager Intern')['Application ID'];

  // Ambiguous Contoso rejection -> link to the PM application.
  sh.getRange(rowOf('m-contoso-4'), col('Decision'), 1, 2).setValues([['Link', 'app=' + pmId]]);
  // Initech (no term) -> correct and create.
  sh.getRange(rowOf('m-initech-1'), col('Decision'), 1, 2).setValues([['Correct', 'term=Summer 2027']]);

  processReviewDecisions();
  const after1 = JSON.stringify(apps(w));
  assert.strictEqual(apps(w).find((a) => a['Application ID'] === pmId)['Current Status'], 'Rejected');
  const initech = apps(w).find((a) => a['Company'] === 'Initech');
  assert.strictEqual(initech['Hiring Term'], 'Summer 2027');
  assert.strictEqual(initech['Current Status'], 'Applied');
  assert.ok(reviews(w).find((r) => r['Message ID'] === 'm-contoso-4')['Resolution'].startsWith('Applied to'));

  // Same decisions again: nothing changes.
  processReviewDecisions();
  const resolutionsBefore = reviews(w).map((r) => r['Resolution']);
  sh.getRange(rowOf('m-contoso-4'), col('Resolution'), 1, 1).setValues([['']]); // even if Resolution is cleared
  processReviewDecisions();
  assert.strictEqual(JSON.stringify(apps(w)), after1);
  assert.strictEqual(reviews(w).find((r) => r['Message ID'] === 'm-contoso-4')['Resolution'], 'Already completed');
  assert.strictEqual(resolutionsBefore.length, reviews(w).length);

  // Ignore keeps the email out for good.
  const others = reviews(w).filter((r) => !r['Resolution']);
  if (others.length) {
    sh.getRange(rowOf(others[0]['Message ID']), col('Decision'), 1, 1).setValues([['Ignore']]);
    processReviewDecisions();
    const evt = events(w).find((e) => e['Gmail Message ID'] === others[0]['Message ID']);
    assert.strictEqual(evt['Processing State'], 'IGNORED');
  }
});

test('review errors are reported in the row, not applied', () => {
  const w = setupWorld();
  syncNow();
  const sh = sheet(w, 'Review Queue');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const r = reviews(w).findIndex((x) => x['Message ID'] === 'm-contoso-4') + 2;
  sh.getRange(r, head.indexOf('Decision') + 1, 1, 2).setValues([['Correct', 'colour=blue']]);
  processReviewDecisions();
  const row = reviews(w).find((x) => x['Message ID'] === 'm-contoso-4');
  assert.match(row['Review Reason'], /^ERROR: Unknown key/);
  assert.strictEqual(row['Resolution'], '');
});

test('installing the trigger twice leaves exactly one schedule; remove disables it', () => {
  const w = setupWorld([]);
  installTrigger();
  installTrigger();
  assert.strictEqual(w.triggers.length, 1);
  assert.strictEqual(w.triggers[0].spec.hours, 2);
  removeTriggers();
  assert.strictEqual(w.triggers.length, 0);
});

test('Gmail query covers phrases, senders and the include label, with epoch bounds', () => {
  const q = GmailReader.buildQuery(Config.build({}), Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 15));
  assert.match(q, /"thank you for applying"/);
  assert.match(q, /from:greenhouse\.io/);
  assert.match(q, /label:job-tracker-include/);
  assert.match(q, /after:1767225600 before:1768435200$/);
  assert.doesNotMatch(q, /is:unread|in:inbox/);
});
