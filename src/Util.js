/**
 * Util: small pure helpers shared by the parser, matcher and repository.
 * No Apps Script services are used here.
 */
var Util = (function () {
  var MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
    september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };
  var MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  // Matches "November 10, 2026", "Nov. 10", "10 November 2026", "11/10/2026", "2026-11-10".
  var DATE_RE_SOURCE =
    '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\\s+)?' +
    '(?:' + MONTH_RE + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?' +
    '|\\d{1,2}(?:st|nd|rd|th)?\\s+' + MONTH_RE + '\\.?(?:,?\\s+\\d{4})?' +
    '|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}' +
    '|\\d{4}-\\d{2}-\\d{2})';

  function isDate(x) {
    return Object.prototype.toString.call(x) === '[object Date]' && !isNaN(x.getTime());
  }

  function toDate(x) {
    if (isDate(x)) return x;
    if (x === '' || x === null || x === undefined) return null;
    var d = new Date(x);
    return isNaN(d.getTime()) ? null : d;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    var r = new Date(d.getTime());
    r.setDate(r.getDate() + n);
    return r;
  }

  function addBusinessDays(d, n) {
    var r = startOfDay(d);
    while (n > 0) {
      r = addDays(r, 1);
      var day = r.getDay();
      if (day !== 0 && day !== 6) n--;
    }
    return r;
  }

  /**
   * Parse a date string found in an email. When the year is missing, use the
   * first occurrence on or after (refDate - 7 days). Returns null if unsure.
   */
  function parseDate(str, refDate) {
    if (!str) return null;
    var s = String(str).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1')
      .replace(/^(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\s+/, '').trim();
    var m, y, mo, d;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
      y = +m[1]; mo = +m[2] - 1; d = +m[3];
    } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) {
      mo = +m[1] - 1; d = +m[2]; y = +m[3]; if (y < 100) y += 2000;
    } else if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s)) && MONTHS[m[1]] !== undefined) {
      mo = MONTHS[m[1]]; d = +m[2]; y = m[3] ? +m[3] : null;
    } else if ((m = /^(\d{1,2})\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/.exec(s)) && MONTHS[m[2]] !== undefined) {
      mo = MONTHS[m[2]]; d = +m[1]; y = m[3] ? +m[3] : null;
    } else {
      return null;
    }
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    if (y === null) {
      if (!refDate) return null;
      y = refDate.getFullYear();
      var guess = new Date(y, mo, d);
      if (guess < addDays(startOfDay(refDate), -7)) y += 1;
    }
    var out = new Date(y, mo, d);
    return out.getMonth() === mo ? out : null; // rejects Feb 31 etc.
  }

  function dateRegex(flags) {
    return new RegExp(DATE_RE_SOURCE, flags || 'i');
  }

  function maxDate(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a.getTime() >= b.getTime() ? a : b;
  }

  function sameInstant(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.getTime() === b.getTime();
  }

  function collapse(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** Lowercase, drop legal suffixes and punctuation: "Acme, Inc." -> "acme". */
  function companyKey(name) {
    var s = collapse(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ');
    s = collapse(s).replace(/^the /, '');
    var suffix = /\s(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|lp|llp|group|holdings)$/;
    while (suffix.test(s)) s = s.replace(suffix, '');
    return s.trim();
  }

  /**
   * Normalize a role title for comparison. Strips hiring terms, years, req IDs
   * and punctuation, and unifies a few synonyms. Different specialisations stay
   * different: "SWE Intern" != "SWE Intern, Machine Learning".
   */
  function roleKey(role) {
    var s = collapse(role).toLowerCase();
    s = s.replace(/\b(?:spring|summer|fall|autumn|winter)\s*(?:of\s+)?'?(?:20)?\d{2}\b/g, ' ')
      .replace(/\b20\d{2}\b/g, ' ')
      .replace(/\b(?:req(?:uisition)?|job)\s*(?:id|#|no\.?)?\s*:?\s*[a-z]{0,4}-?\d{3,}\b/g, ' ')
      .replace(/\b(?:jr|r|req)-?\d{4,}\b/g, ' ')
      .replace(/\bco-?op\b/g, 'coop')
      .replace(/\binternship\b/g, 'intern')
      .replace(/\bswe\b/g, 'software engineer')
      .replace(/\bsde\b/g, 'software development engineer')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(?:the|a|an|position|role|program)\b/g, ' ');
    return collapse(s);
  }

  function reqKey(req) {
    return collapse(req).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function sameTerm(a, b) {
    return collapse(a).toLowerCase() === collapse(b).toLowerCase();
  }

  /** Return the sentence around index `idx` (max `maxLen` chars). */
  function snippetAround(text, idx, maxLen) {
    maxLen = maxLen || 220;
    var start = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('\n', idx), text.lastIndexOf('!', idx)) + 1;
    var endCandidates = ['.', '\n', '!', '?'].map(function (c) {
      var i = text.indexOf(c, idx);
      return i === -1 ? text.length : i + 1;
    });
    var end = Math.min.apply(null, endCandidates);
    var out = collapse(text.slice(start, end));
    if (out.length > maxLen) out = out.slice(0, maxLen - 1) + '…';
    return out;
  }

  /** Strip HTML to text (used when an email has no plain-text part). */
  function htmlToText(html) {
    return String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ');
  }

  /** Extract the bare address from "Name <addr@x.com>". */
  function emailAddress(from) {
    var m = /<([^>]+)>/.exec(from || '');
    return collapse(m ? m[1] : from).toLowerCase();
  }

  function displayName(from) {
    var m = /^\s*"?([^"<]*?)"?\s*</.exec(from || '');
    return m ? collapse(m[1]) : '';
  }

  /** Prefix strings that Sheets would treat as formulas with an apostrophe. */
  function sheetSafe(value) {
    if (typeof value !== 'string') return value;
    return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  }

  return {
    MONTHS: MONTHS, isDate: isDate, toDate: toDate, startOfDay: startOfDay, addDays: addDays,
    addBusinessDays: addBusinessDays, parseDate: parseDate, dateRegex: dateRegex,
    maxDate: maxDate, sameInstant: sameInstant, collapse: collapse, companyKey: companyKey,
    roleKey: roleKey, reqKey: reqKey, sameTerm: sameTerm, snippetAround: snippetAround,
    htmlToText: htmlToText, emailAddress: emailAddress, displayName: displayName,
    sheetSafe: sheetSafe
  };
})();
