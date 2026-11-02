/**
 * Main: the functions you run. Each top-level function below appears in the
 * Apps Script editor's "Run" dropdown, and most are in the spreadsheet's
 * "Job Tracker" menu.
 */

var TRIGGER_HANDLER = 'scheduledSync';
var ALLOWED_HOURS = [1, 2, 4, 6, 8, 12];

/** Simple trigger: adds the "Job Tracker" menu when the spreadsheet opens. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Job Tracker')
    .addItem('Sync now', 'syncNow')
    .addItem('Dry run (preview only)', 'dryRun')
    .addItem('Process review decisions', 'processReviewDecisions')
    .addSeparator()
    .addItem('Install / update automatic sync', 'installTrigger')
    .addItem('Disable automatic sync', 'removeTriggers')
    .addItem('Show sync status', 'showSyncStatus')
    .addSeparator()
    .addItem('Set up sheets & default settings', 'setup')
    .addToUi();
}

/** Run this first. Creates tabs and default Script Properties; triggers authorization. */
function setup() {
  var added = Config.writeMissingDefaults();
  SheetRepository.ensureSchema();
  notify_('Setup complete. ' + (added.length ? 'Added settings: ' + added.join(', ') : 'Settings already present.'));
}

/** Manual sync. */
function syncNow() {
  var s = SyncService.run({ dryRun: false });
  notify_(s.skipped ? 'A sync is already running.' : summaryText_('Sync', s));
}

/** Preview what a sync would do, written to the "Dry Run Preview" tab. */
function dryRun() {
  var s = SyncService.run({ dryRun: true });
  notify_(s.skipped ? 'A sync is already running.' : summaryText_('Dry run', s) + ' See "Dry Run Preview".');
}

/** Time-driven trigger handler. */
function scheduledSync() {
  SyncService.run({ dryRun: false });
}

/** Apply decisions entered in the Review Queue tab. */
function processReviewDecisions() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { notify_('A sync is running; try again in a minute.'); return; }
  try {
    var s = ReviewService.processDecisions(new Date());
    notify_('Reviews: ' + s.applied + ' applied, ' + s.ignored + ' ignored, ' + s.noop +
      ' already done, ' + s.errors + ' errors (see Review Reason).');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Install the automatic sync. Removes existing sync triggers first, so
 * running this repeatedly never creates duplicate schedules.
 */
function installTrigger() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var hours = Config.load().syncIntervalHours;
    if (ALLOWED_HOURS.indexOf(hours) === -1) {
      throw new Error('SYNC_INTERVAL_HOURS must be one of ' + ALLOWED_HOURS.join(', ') + ' (got ' + hours + ')');
    }
    var removed = deleteSyncTriggers_();
    ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyHours(hours).create();
    notify_('Automatic sync every ' + hours + 'h installed' + (removed ? ' (replaced ' + removed + ' old trigger(s))' : '') + '.');
  } finally {
    lock.releaseLock();
  }
}

/** Disable automation: removes every trigger that calls scheduledSync. */
function removeTriggers() {
  var removed = deleteSyncTriggers_();
  notify_('Removed ' + removed + ' automatic sync trigger(s).');
}

function showSyncStatus() {
  var config = Config.load();
  var state = SyncState.load(config);
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === TRIGGER_HANDLER; });
  var msg = 'Import start: ' + new Date(state.importStart).toDateString() +
    '\nProcessed through: ' + (state.lastCompletedEnd ? new Date(state.lastCompletedEnd).toString() : '(nothing yet)') +
    '\nInitial import done: ' + SyncState.isInitialImportDone(state, Date.now(), config) +
    '\nAutomatic sync triggers: ' + triggers.length;
  notify_(msg, true);
}

/** Start the Gmail import over from INITIAL_IMPORT_START. Existing rows are kept; dedup prevents duplicates. */
function resetSyncCheckpoint() {
  SyncState.reset();
  notify_('Checkpoint reset. The next sync re-reads Gmail from INITIAL_IMPORT_START (no duplicates are created).');
}

function deleteSyncTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_HANDLER) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function summaryText_(label, s) {
  return label + ': scanned ' + s.scanned + ' message(s), created ' + s.created + ', updated ' + s.updated +
    ', review items ' + s.reviews + '.';
}

/** Show a message in the spreadsheet if possible; always log it. */
function notify_(msg, asAlert) {
  Logger.log(msg);
  try {
    if (asAlert) SpreadsheetApp.getUi().alert(msg);
    else SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Job Tracker', 10);
  } catch (e) {
    // Running from the editor or a trigger: no UI available, the log is enough.
  }
}
