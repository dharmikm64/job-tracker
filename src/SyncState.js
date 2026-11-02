/**
 * SyncState: the Gmail checkpoint, stored in Script Properties.
 *
 * The checkpoint is one timestamp, `lastCompletedEnd`: every message before
 * it has been fully processed. Each search window is
 *   [lastCompletedEnd - overlap, min(lastCompletedEnd + windowDays, now))
 * and the checkpoint moves to the window's end only after the whole window has
 * been processed and its events marked complete. If a window holds too many
 * threads for one page, it is split in half rather than paged by offset, so
 * new mail reordering Gmail results can't make us skip a thread.
 *
 * The window math is pure; load/save use PropertiesService.
 */
var SyncState = (function () {
  var KEY = 'SYNC_STATE';
  var HOUR = 3600 * 1000;
  var DAY = 24 * HOUR;
  var MIN_WINDOW = HOUR;

  function initial(config) {
    return { importStart: config.initialImportStart.getTime(), lastCompletedEnd: null, version: 1 };
  }

  /** Reset if missing or if INITIAL_IMPORT_START was moved earlier. */
  function normalize(state, config) {
    var start = config.initialImportStart.getTime();
    if (!state || typeof state.importStart !== 'number') return initial(config);
    if (start < state.importStart) return initial(config);
    return state;
  }

  function nextWindow(state, nowMs, config) {
    var floor = state.importStart;
    var done = state.lastCompletedEnd;
    var start = done === null ? floor : Math.max(floor, done - config.overlapHours * HOUR);
    var from = done === null ? floor : done;
    var end = Math.min(from + config.windowDays * DAY, nowMs);
    if (end <= from) return null; // caught up
    return { start: start, end: end, minEnd: Math.min(from + MIN_WINDOW, end) };
  }

  /** Halve a window that returned a full page. Returns null at minimum size. */
  function shrink(window) {
    if (window.end <= window.minEnd) return null;
    var mid = Math.floor((window.start + window.end) / 2);
    return { start: window.start, end: Math.max(mid, window.minEnd), minEnd: window.minEnd };
  }

  function complete(state, window) {
    return {
      importStart: state.importStart,
      lastCompletedEnd: Math.max(state.lastCompletedEnd || 0, window.end),
      version: 1
    };
  }

  function isInitialImportDone(state, nowMs, config) {
    return state.lastCompletedEnd !== null && nowMs - state.lastCompletedEnd < config.windowDays * DAY;
  }

  function load(config) {
    var raw = PropertiesService.getScriptProperties().getProperty(KEY);
    var parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    return normalize(parsed, config);
  }

  function save(state) {
    PropertiesService.getScriptProperties().setProperty(KEY, JSON.stringify(state));
  }

  function reset() {
    PropertiesService.getScriptProperties().deleteProperty(KEY);
  }

  return {
    KEY: KEY, initial: initial, normalize: normalize, nextWindow: nextWindow, shrink: shrink,
    complete: complete, isInitialImportDone: isInitialImportDone, load: load, save: save, reset: reset
  };
})();
