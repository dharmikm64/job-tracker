// In-memory stand-ins for the Apps Script services the project uses.
// They implement only the methods our code calls. The fake Gmail objects have
// no write methods at all, so any attempt to modify mail would throw.

class FakeRange {
  constructor(sheet, row, col, nr, nc) {
    if (row < 1 || col < 1 || row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) {
      throw new Error(`Range out of bounds on ${sheet.name}: r${row} c${col} ${nr}x${nc} (max ${sheet.maxRows}x${sheet.maxCols})`);
    }
    Object.assign(this, { sheet, row, col, nr, nc });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = (this.sheet.cells[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some((l) => l.length !== this.nc)) throw new Error('setValues size mismatch');
    values.forEach((line, r) => line.forEach((v, c) => {
      const rr = this.row - 1 + r, cc = this.col - 1 + c;
      if (typeof v === 'string' && v.startsWith('=')) this.sheet.formulaWrites.push(v);
      // Like Sheets: a leading apostrophe forces text and is not stored.
      if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1);
      (this.sheet.cells[rr] = this.sheet.cells[rr] || [])[cc] = v;
    }));
    this.sheet.writeCalls++;
    if (this.sheet.onWrite) this.sheet.onWrite(this);
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat() { return this; }
  setNumberFormats() { return this; }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
  insertCheckboxes() { return this; }
  clearContent() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) {
      const row = this.sheet.cells[this.row - 1 + r];
      if (row) row[this.col - 1 + c] = '';
    }
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    Object.assign(this, { name, cells: [], maxRows: 1000, maxCols: 26, formulaWrites: [], writeCalls: 0 });
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if ((this.cells[r] || []).some((v) => v !== '' && v !== undefined)) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.cells.forEach((row) => (row || []).forEach((v, i) => { if (v !== '' && v !== undefined) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  insertColumnsAfter(_after, n) { this.maxCols += n; }
  getRange(row, col, nr = 1, nc = 1) { return new FakeRange(this, row, col, nr, nc); }
  setFrozenRows() {}
  /** Test helper: rows as objects keyed by header. */
  rows() {
    const width = this.getLastColumn();
    const head = this.getRange(1, 1, 1, width).getValues()[0];
    const last = this.getLastRow();
    if (last < 2) return [];
    return this.getRange(2, 1, last - 1, width).getValues().map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
  toast() {}
}

function validationBuilder() {
  const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) };
  return b;
}

function makeProperties(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); },
    getProperties: () => ({ ...store }),
    setProperties: (obj) => { Object.assign(store, obj); },
    deleteProperty: (k) => { delete store[k]; }
  };
}

// ---- Gmail -------------------------------------------------------------

function fakeMessage(e) {
  return {
    getId: () => e.id, getDate: () => e.date, getFrom: () => e.from, getSubject: () => e.subject,
    getPlainBody: () => e.body, getBody: () => e.body, isInTrash: () => false, isDraft: () => false
  };
}

function makeGmail(emails) {
  const threads = {};
  emails.forEach((e) => { (threads[e.threadId] = threads[e.threadId] || []).push(e); });
  const calls = { search: [] };
  function thread(id) {
    return { getId: () => id, getLabels: () => (threads[id][0].labels || []).map((n) => ({ getName: () => n })), _id: id };
  }
  return {
    calls,
    search(query, start, max) {
      calls.search.push(query);
      const after = Number(/after:(\d+)/.exec(query)[1]) * 1000;
      const before = Number(/before:(\d+)/.exec(query)[1]) * 1000;
      const hits = Object.keys(threads)
        .filter((id) => threads[id].some((m) => m.date.getTime() >= after && m.date.getTime() < before))
        .sort((a, b) => Math.max(...threads[b].map((m) => m.date)) - Math.max(...threads[a].map((m) => m.date)));
      return hits.slice(start, start + max).map(thread);
    },
    getMessagesForThreads(ts) {
      return ts.map((t) => threads[t._id].slice().sort((a, b) => a.date - b.date).map(fakeMessage));
    }
  };
}

/**
 * Install fake globals. Returns handles for assertions.
 * @param opts { emails, props, now }
 */
function installFakes(opts = {}) {
  const spreadsheet = new FakeSpreadsheet();
  const props = makeProperties(opts.props || {});
  const triggers = [];
  const lockState = { held: false, available: true };
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    newDataValidation: validationBuilder,
    getUi: () => { throw new Error('No UI in tests'); },
    flush: () => {}
  };
  global.PropertiesService = { getScriptProperties: () => props };
  global.LockService = {
    getScriptLock: () => ({
      tryLock: () => { if (!lockState.available || lockState.held) return false; lockState.held = true; return true; },
      waitLock: () => { lockState.held = true; },
      releaseLock: () => { lockState.held = false; }
    })
  };
  global.Logger = { log: () => {} };
  global.Session = { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) };
  global.GmailApp = makeGmail(opts.emails || []);
  global.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
    newTrigger: (handler) => {
      const spec = { handler };
      const chain = {
        timeBased: () => chain, everyHours: (h) => { spec.hours = h; return chain; },
        create: () => { const t = { getHandlerFunction: () => handler, spec }; triggers.push(t); return t; }
      };
      return chain;
    }
  };
  return { spreadsheet, props, triggers, lockState, gmail: global.GmailApp };
}

module.exports = { installFakes, FakeSheet, makeGmail };
