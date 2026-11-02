const test = require('node:test');
const assert = require('node:assert');
require('./helpers/load').loadApp();

const config = Config.build({ INITIAL_IMPORT_START: '2026-01-01', WINDOW_DAYS: '14', OVERLAP_HOURS: '48' });
const DAY = 86400000;

test('initial import starts at INITIAL_IMPORT_START, not a fixed 90-day limit', () => {
  const s = SyncState.initial(config);
  const w = SyncState.nextWindow(s, new Date('2026-11-01').getTime(), config);
  assert.strictEqual(w.start, new Date(2026, 0, 1).getTime());
  assert.strictEqual(w.end - w.start, 14 * DAY);
});

test('later windows overlap the previous one and always make progress', () => {
  let s = SyncState.initial(config);
  const now = new Date('2026-03-01').getTime();
  const w1 = SyncState.nextWindow(s, now, config);
  s = SyncState.complete(s, w1);
  const w2 = SyncState.nextWindow(s, now, config);
  assert.strictEqual(w2.start, w1.end - 48 * 3600000);
  assert.ok(w2.end > w1.end);
});

test('caught up: no window until time passes; the window then ends at now', () => {
  const now = new Date('2026-11-01T12:00:00').getTime();
  let s = { importStart: config.initialImportStart.getTime(), lastCompletedEnd: now, version: 1 };
  assert.strictEqual(SyncState.nextWindow(s, now, config), null);
  const later = now + 2 * 3600000;
  assert.strictEqual(SyncState.nextWindow(s, later, config).end, later);
});

test('shrinking halves the window down to a minimum, never moving the start', () => {
  const w = { start: 0, end: 16 * 3600000, minEnd: 3600000 };
  let x = w, steps = 0;
  while ((x = SyncState.shrink(x))) { assert.strictEqual(x.start, 0); steps++; if (steps > 10) break; }
  assert.ok(steps >= 4 && steps <= 6);
});

test('moving INITIAL_IMPORT_START earlier resets the checkpoint', () => {
  const s = { importStart: new Date(2026, 5, 1).getTime(), lastCompletedEnd: new Date(2026, 9, 1).getTime(), version: 1 };
  assert.strictEqual(SyncState.normalize(s, config).lastCompletedEnd, null);
});

test('review corrections parser', () => {
  const c = ReviewService.parseCorrections('company=Acme; role=SWE Intern; status=interview; date=2026-10-01; app=APP-1');
  assert.strictEqual(c.company, 'Acme');
  assert.strictEqual(c.eventType, 'INTERVIEW');
  assert.strictEqual(c.app, 'APP-1');
  assert.strictEqual(c.eventDate.getDate(), 1);
  assert.throws(() => ReviewService.parseCorrections('status=Ghosted'), /Unknown status/);
});
