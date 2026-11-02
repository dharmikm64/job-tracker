/**
 * SheetRepository: all SpreadsheetApp access.
 *
 * - Columns are found by header name, so you can reorder columns or add your
 *   own; rows are found by stable IDs, never by remembered row numbers.
 * - Email-derived strings are written into plain-text ("@") columns and any
 *   value starting with = + - @ gets a leading apostrophe, so it can't run
 *   as a formula.
 * - Updates write only the fields that changed, so Notes, Manual Status Lock
 *   and other manual edits are left alone.
 * - Separate writes are NOT atomic. Reliability comes from the event states
 *   (PENDING -> COMPLETED) and idempotent re-application, not transactions.
 */
var SheetRepository = (function () {
  var T = 'text', D = 'date', B = 'bool', J = 'json', L = 'list', N = 'number';

  var SCHEMAS = {
    applications: { name: 'Applications', key: 'id', columns: [
      ['id', 'Application ID', T], ['company', 'Company', T], ['role', 'Role', T],
      ['reqId', 'Requisition ID', T], ['location', 'Location', T], ['term', 'Hiring Term', T],
      ['appliedDate', 'Applied Date', D], ['status', 'Current Status', T], ['lastEventDate', 'Last Event Date', D],
      ['nextDeadline', 'Next Deadline', D], ['sourceLink', 'Source Email Link', T],
      ['locked', 'Manual Status Lock', B], ['notes', 'Notes', T],
      ['statusDate', 'Status Date', D], ['threadIds', 'Thread IDs', L],
      ['createdAt', 'Created At', D], ['updatedAt', 'Updated At', D]] },
    events: { name: 'Events', key: 'eventId', columns: [
      ['eventId', 'Event ID', T], ['appId', 'Application ID', T], ['messageId', 'Gmail Message ID', T],
      ['threadId', 'Thread ID', T], ['eventDate', 'Event Date', D], ['eventType', 'Detected Event', T],
      ['evidence', 'Evidence Snippet', T], ['state', 'Processing State', T], ['decision', 'Decision', T],
      ['runId', 'Run ID', T], ['details', 'Details (JSON)', J], ['updatedAt', 'Updated At', D]] },
    reviews: { name: 'Review Queue', key: 'reviewId', columns: [
      ['messageId', 'Message ID', T], ['company', 'Extracted Company', T], ['role', 'Role', T],
      ['term', 'Hiring Term', T], ['proposedStatus', 'Proposed Status', T],
      ['candidateAppId', 'Candidate Application ID', T], ['reason', 'Review Reason', T],
      ['decision', 'Decision', T], ['corrected', 'Corrected Values', T], ['link', 'Source Email Link', T],
      ['reviewId', 'Review ID', T], ['eventId', 'Event ID', T], ['resolution', 'Resolution', T],
      ['resolvedAt', 'Resolved At', D]] },
    log: { name: 'Sync Log', key: 'runId', columns: [
      ['runId', 'Run ID', T], ['start', 'Start Time', D], ['end', 'End Time', D],
      ['scanned', 'Messages Scanned', N], ['created', 'Applications Created', N],
      ['updated', 'Updates Applied', N], ['reviews', 'Review Items', N], ['errors', 'Errors', T],
      ['mode', 'Mode', T], ['checkpoint', 'Checkpoint', T]] },
    dryRun: { name: 'Dry Run Preview', key: 'messageId', columns: [
      ['messageId', 'Message ID', T], ['date', 'Message Date', D], ['subject', 'Subject', T],
      ['action', 'Action', T], ['appId', 'Application ID', T], ['company', 'Company', T],
      ['role', 'Role', T], ['term', 'Hiring Term', T], ['eventType', 'Detected Event', T],
      ['statusChange', 'Status Change', T], ['reason', 'Reason', T], ['link', 'Source Email Link', T]] }
  };

  var USER_FIELDS = { locked: true, notes: true };
  var DECISIONS = ['Approve', 'Correct', 'Link', 'Ignore'];
  var DATE_FORMAT = 'yyyy-mm-dd hh:mm';

  function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

  function sheetFor(schema) {
    var sh = ss().getSheetByName(schema.name);
    if (!sh) throw new Error('Missing sheet "' + schema.name + '". Run setup() first.');
    return sh;
  }

  /** Header name -> 1-based column index. */
  function headerMap(sh) {
    var lastCol = sh.getLastColumn();
    var map = {};
    if (lastCol === 0) return map;
    sh.getRange(1, 1, 1, lastCol).getValues()[0].forEach(function (h, i) {
      if (h !== '') map[String(h).trim()] = i + 1;
    });
    return map;
  }

  function colIndex(schema, map) {
    var idx = {};
    schema.columns.forEach(function (c) {
      if (!map[c[1]]) throw new Error('Sheet "' + schema.name + '" is missing column "' + c[1] + '". Run setup().');
      idx[c[0]] = map[c[1]];
    });
    return idx;
  }

  function formatFor(type) {
    return type === T || type === J || type === L ? '@' : type === D ? DATE_FORMAT : '0';
  }

  /** Create missing sheets/columns and set formats. Safe to run repeatedly. */
  function ensureSchema() {
    Object.keys(SCHEMAS).forEach(function (k) {
      var schema = SCHEMAS[k];
      var sh = ss().getSheetByName(schema.name) || ss().insertSheet(schema.name);
      var map = headerMap(sh);
      var next = sh.getLastColumn() + 1;
      schema.columns.forEach(function (c) {
        if (!map[c[1]]) {
          if (next > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), next - sh.getMaxColumns());
          sh.getRange(1, next, 1, 1).setValues([[c[1]]]);
          map[c[1]] = next++;
        }
      });
      sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
      sh.setFrozenRows(1);
      var rows = sh.getMaxRows() - 1;
      if (rows > 0) {
        schema.columns.forEach(function (c) {
          if (c[2] !== B) sh.getRange(2, map[c[1]], rows, 1).setNumberFormat(formatFor(c[2]));
        });
      }
    });
    // Only existing data rows: checkboxes store FALSE, which would make
    // getLastRow() count empty rows. New rows get validation on append.
    [SCHEMAS.applications, SCHEMAS.reviews].forEach(function (schema) {
      var last = sheetFor(schema).getLastRow();
      if (last >= 2) applyValidation(schema, 2, last - 1);
    });
  }

  function applyValidation(schema, startRow, numRows) {
    var sh = sheetFor(schema);
    var idx = colIndex(schema, headerMap(sh));
    if (schema === SCHEMAS.applications) {
      sh.getRange(startRow, idx.locked, numRows, 1).insertCheckboxes();
      var statusRule = SpreadsheetApp.newDataValidation()
        .requireValueInList(StatusEngine.STATUSES, true).setAllowInvalid(false).build();
      sh.getRange(startRow, idx.status, numRows, 1).setDataValidation(statusRule);
    } else if (schema === SCHEMAS.reviews) {
      var decisionRule = SpreadsheetApp.newDataValidation()
        .requireValueInList(DECISIONS, true).setAllowInvalid(false).build();
      sh.getRange(startRow, idx.decision, numRows, 1).setDataValidation(decisionRule);
    }
  }

  function toCell(type, v) {
    if (v === null || v === undefined) return type === B ? false : '';
    if (type === D) return Util.toDate(v) || '';
    if (type === B) return v === true;
    if (type === N) return Number(v) || 0;
    if (type === J) return Util.sheetSafe(JSON.stringify(v));
    if (type === L) return Util.sheetSafe((v || []).join(', '));
    return Util.sheetSafe(String(v));
  }

  function fromCell(type, v) {
    if (type === D) return Util.toDate(v);
    if (type === B) return v === true || String(v).toUpperCase() === 'TRUE';
    if (type === N) return Number(v) || 0;
    if (type === J) { try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; } }
    if (type === L) return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return v === null || v === undefined ? '' : String(v);
  }

  /** Read all rows of a schema as objects (each with a hidden `_row`). */
  function readAll(schema) {
    var sh = sheetFor(schema);
    var idx = colIndex(schema, headerMap(sh));
    var last = sh.getLastRow();
    if (last < 2) return [];
    var width = sh.getLastColumn();
    var values = sh.getRange(2, 1, last - 1, width).getValues();
    var out = [];
    values.forEach(function (row, i) {
      var keyVal = row[idx[schema.key] - 1];
      if (keyVal === '' || keyVal === null) return;
      var obj = { _row: i + 2 };
      schema.columns.forEach(function (c) { obj[c[0]] = fromCell(c[2], row[idx[c[0]] - 1]); });
      out.push(obj);
    });
    return out;
  }

  /** Append objects as new rows in one write. */
  function appendRows(schema, objects) {
    if (!objects.length) return;
    var sh = sheetFor(schema);
    var idx = colIndex(schema, headerMap(sh));
    var width = sh.getLastColumn();
    var start = sh.getLastRow() + 1;
    var needed = start + objects.length - 1 - sh.getMaxRows();
    if (needed > 0) sh.insertRowsAfter(sh.getMaxRows(), needed);
    var formats = [], values = [];
    objects.forEach(function (o) {
      var row = new Array(width).fill(''), fmt = new Array(width).fill('General');
      schema.columns.forEach(function (c) {
        row[idx[c[0]] - 1] = toCell(c[2], o[c[0]]);
        if (c[2] !== B) fmt[idx[c[0]] - 1] = formatFor(c[2]);
      });
      values.push(row); formats.push(fmt);
    });
    var range = sh.getRange(start, 1, objects.length, width);
    range.setNumberFormats(formats);
    range.setValues(values);
    applyValidation(schema, start, objects.length);
  }

  /**
   * Update specific fields of rows identified by key. Re-reads the key column
   * first, so rows moved by sorting are still found. Writes contiguous runs.
   * @param updates [{ key, fields: {field: value} }]
   * @return number of rows updated
   */
  function updateFields(schema, updates) {
    if (!updates.length) return 0;
    var sh = sheetFor(schema);
    var idx = colIndex(schema, headerMap(sh));
    var types = {};
    schema.columns.forEach(function (c) { types[c[0]] = c[2]; });
    var last = sh.getLastRow();
    if (last < 2) return 0;
    var keys = sh.getRange(2, idx[schema.key], last - 1, 1).getValues();
    var rowOf = {};
    keys.forEach(function (r, i) { if (r[0] !== '') rowOf[String(r[0])] = i + 2; });
    var count = 0;
    updates.forEach(function (u) {
      var row = rowOf[u.key];
      if (!row) return;
      var cols = Object.keys(u.fields).map(function (f) { return { col: idx[f], f: f }; })
        .sort(function (a, b) { return a.col - b.col; });
      var i = 0;
      while (i < cols.length) {
        var j = i;
        while (j + 1 < cols.length && cols[j + 1].col === cols[j].col + 1) j++;
        var run = cols.slice(i, j + 1);
        sh.getRange(row, run[0].col, 1, run.length).setValues([run.map(function (c) {
          return toCell(types[c.f], u.fields[c.f]);
        })]);
        i = j + 1;
      }
      count++;
    });
    return count;
  }

  // ---- Applications ----------------------------------------------------

  function readApplications() { return readAll(SCHEMAS.applications); }

  var APP_ENGINE_FIELDS = ['company', 'role', 'reqId', 'location', 'term', 'appliedDate', 'status',
    'lastEventDate', 'nextDeadline', 'sourceLink', 'statusDate', 'threadIds', 'updatedAt'];

  function changedFields(before, after) {
    var fields = {};
    APP_ENGINE_FIELDS.forEach(function (f) {
      var a = before ? before[f] : undefined, b = after[f];
      var same;
      if (f === 'threadIds') same = (a || []).join(',') === (b || []).join(',');
      else if (Util.isDate(a) || Util.isDate(b)) same = Util.sameInstant(Util.toDate(a), Util.toDate(b));
      else same = (a || '') === (b || '');
      if (!same && !USER_FIELDS[f]) fields[f] = b;
    });
    return fields;
  }

  /**
   * Save applications produced by SyncPlanner.applyEvents. New apps are
   * appended unless a row with that ID already exists (recovery case).
   */
  function saveApplications(apps) {
    if (!apps.length) return;
    var current = {};
    readApplications().forEach(function (a) { current[a.id] = a; });
    var toAppend = [], updates = [];
    apps.forEach(function (a) {
      if (current[a.id]) {
        var fields = changedFields(current[a.id], a);
        if (Object.keys(fields).length) updates.push({ key: a.id, fields: fields });
      } else {
        toAppend.push(a);
      }
    });
    appendRows(SCHEMAS.applications, toAppend);
    updateFields(SCHEMAS.applications, updates);
  }

  // ---- Events ------------------------------------------------------------

  function readEvents() { return readAll(SCHEMAS.events); }

  function knownMessageIds() {
    var known = {};
    readEvents().forEach(function (e) { known[e.messageId] = true; });
    return known;
  }

  /** Append events whose Event ID is not already present. */
  function appendEvents(events) {
    var existing = {};
    readEvents().forEach(function (e) { existing[e.eventId] = true; });
    appendRows(SCHEMAS.events, events.filter(function (e) { return !existing[e.eventId]; }));
  }

  function updateEvents(updates) { return updateFields(SCHEMAS.events, updates); }

  // ---- Review queue ------------------------------------------------------

  function readReviews() { return readAll(SCHEMAS.reviews); }

  function appendReviews(reviews) {
    var existing = {};
    readReviews().forEach(function (r) { existing[r.reviewId] = true; });
    appendRows(SCHEMAS.reviews, reviews.filter(function (r) { return !existing[r.reviewId]; }));
  }

  function updateReviews(updates) { return updateFields(SCHEMAS.reviews, updates); }

  // ---- Sync log and dry run ------------------------------------------------

  function appendLog(entry) { appendRows(SCHEMAS.log, [entry]); }

  function updateLog(runId, fields) { updateFields(SCHEMAS.log, [{ key: runId, fields: fields }]); }

  function writeDryRun(rows) {
    var sh = sheetFor(SCHEMAS.dryRun);
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
    appendRowsFrom(sh, rows);
  }

  function appendRowsFrom(sh, rows) {
    // Dry-run rows always start right after the header.
    if (!rows.length) return;
    var schema = SCHEMAS.dryRun;
    var idx = colIndex(schema, headerMap(sh));
    var width = sh.getLastColumn();
    var needed = rows.length + 1 - sh.getMaxRows();
    if (needed > 0) sh.insertRowsAfter(sh.getMaxRows(), needed);
    var values = rows.map(function (o) {
      var row = new Array(width).fill('');
      schema.columns.forEach(function (c) { row[idx[c[0]] - 1] = toCell(c[2], o[c[0]]); });
      return row;
    });
    var formats = rows.map(function () {
      var fmt = new Array(width).fill('General');
      schema.columns.forEach(function (c) { fmt[idx[c[0]] - 1] = formatFor(c[2]); });
      return fmt;
    });
    var range = sh.getRange(2, 1, rows.length, width);
    range.setNumberFormats(formats);
    range.setValues(values);
  }

  return {
    SCHEMAS: SCHEMAS, DECISIONS: DECISIONS, ensureSchema: ensureSchema, readAll: readAll,
    readApplications: readApplications, saveApplications: saveApplications,
    readEvents: readEvents, knownMessageIds: knownMessageIds, appendEvents: appendEvents,
    updateEvents: updateEvents, readReviews: readReviews, appendReviews: appendReviews,
    updateReviews: updateReviews, appendLog: appendLog, updateLog: updateLog, writeDryRun: writeDryRun,
    changedFields: changedFields
  };
})();
