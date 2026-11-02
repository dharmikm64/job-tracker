/**
 * Config: defaults plus overrides from Script Properties.
 *
 * Edit values in the Apps Script editor: Project Settings > Script Properties.
 * List values are separated by "|" (pipe), e.g. "Spring 2027|Summer 2027".
 * Config.build() is pure so it can be tested in Node; Config.load() reads
 * PropertiesService and only works inside Apps Script.
 */
var Config = (function () {
  var DEFAULTS = {
    ELIGIBLE_TERMS: 'Spring 2027|Summer 2027',
    // First day the initial import searches from (YYYY-MM-DD). Set this early
    // enough to catch old confirmations for Spring/Summer 2027 roles.
    INITIAL_IMPORT_START: '2026-01-01',
    SEARCH_PHRASES: [
      'thank you for applying', 'thanks for applying', 'your application',
      'application received', 'application was sent', 'received your application',
      'interview', 'online assessment', 'coding challenge', 'assessment invitation',
      'offer letter', 'not to move forward', 'not moving forward', 'other candidates',
      'withdrawn', 'next steps', 'internship', 'co-op'
    ].join('|'),
    RECRUITING_SENDERS: [
      'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'myworkday.com', 'workday.com',
      'icims.com', 'smartrecruiters.com', 'ashbyhq.com', 'jobvite.com', 'taleo.net',
      'successfactors.com', 'eightfold.ai', 'hackerrankforwork.com', 'hackerrank.com',
      'codesignal.com', 'codility.com', 'joinhandshake.com', 'linkedin.com'
    ].join('|'),
    // Apply this Gmail label to any thread the keyword search misses.
    INCLUDE_LABEL: 'job-tracker-include',
    OVERLAP_HOURS: '48',
    WINDOW_DAYS: '14',
    PAGE_SIZE: '25',
    MAX_RUNTIME_SECONDS: '270',
    MAX_MESSAGES_PER_RUN: '300',
    SYNC_INTERVAL_HOURS: '2',
    // When true, an email with a company but no role/req ID/thread link may
    // update the company's only application. Off by default (goes to review).
    ALLOW_COMPANY_ONLY_MATCH: 'false',
    // Extra addresses of yours, so your own replies are not parsed as events.
    MY_EMAILS: '',
    GMAIL_ACCOUNT_INDEX: '0'
  };

  function splitList(value) {
    return String(value || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function parseYmd(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!m) throw new Error('INITIAL_IMPORT_START must be YYYY-MM-DD, got "' + value + '"');
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : Number(fallback);
  }

  /** Build a typed config object from a plain {KEY: string} map. */
  function build(props) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      p[k] = props && props[k] !== undefined && props[k] !== '' ? props[k] : DEFAULTS[k];
    });
    return {
      eligibleTerms: splitList(p.ELIGIBLE_TERMS),
      initialImportStart: parseYmd(p.INITIAL_IMPORT_START),
      searchPhrases: splitList(p.SEARCH_PHRASES),
      recruitingSenders: splitList(p.RECRUITING_SENDERS),
      includeLabel: String(p.INCLUDE_LABEL).trim(),
      overlapHours: num(p.OVERLAP_HOURS, DEFAULTS.OVERLAP_HOURS),
      windowDays: num(p.WINDOW_DAYS, DEFAULTS.WINDOW_DAYS),
      pageSize: Math.min(100, num(p.PAGE_SIZE, DEFAULTS.PAGE_SIZE)),
      maxRuntimeMs: num(p.MAX_RUNTIME_SECONDS, DEFAULTS.MAX_RUNTIME_SECONDS) * 1000,
      maxMessagesPerRun: num(p.MAX_MESSAGES_PER_RUN, DEFAULTS.MAX_MESSAGES_PER_RUN),
      syncIntervalHours: num(p.SYNC_INTERVAL_HOURS, DEFAULTS.SYNC_INTERVAL_HOURS),
      allowCompanyOnlyMatch: String(p.ALLOW_COMPANY_ONLY_MATCH).toLowerCase() === 'true',
      myEmails: splitList(p.MY_EMAILS).map(function (s) { return s.toLowerCase(); }),
      gmailAccountIndex: String(p.GMAIL_ACCOUNT_INDEX).trim() || '0'
    };
  }

  /** Apps Script only: read Script Properties and build the config. */
  function load() {
    return build(PropertiesService.getScriptProperties().getProperties());
  }

  /** Apps Script only: write defaults for keys that are not set yet. */
  function writeMissingDefaults() {
    var store = PropertiesService.getScriptProperties();
    var current = store.getProperties();
    var missing = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      if (current[k] === undefined) missing[k] = DEFAULTS[k];
    });
    if (Object.keys(missing).length) store.setProperties(missing, false);
    return Object.keys(missing);
  }

  return { DEFAULTS: DEFAULTS, build: build, load: load, writeMissingDefaults: writeMissingDefaults };
})();
