/**
 * TermDetector: finds the hiring term ("Summer 2027") a recruiting email is
 * about, and decides whether it is eligible. Pure JavaScript.
 *
 * Rules:
 *  - A bare year ("2027") is never a term.
 *  - Seasons in graduation/enrollment context ("graduating Spring 2027",
 *    "Class of 2027") are ignored.
 *  - Month ranges map to a term only for unambiguous start months
 *    (Jan/Feb -> Spring, May/Jun -> Summer, Aug/Sep -> Fall).
 *  - A single term in the subject wins over extra mentions in the body.
 */
var TermDetector = (function () {
  var SEASON = '(spring|summer|fall|autumn|winter)';
  var EXCLUDE_CONTEXT = /(graduat|class of|degree|commencement|expected to complete|completion of your|enrolled|enrollment|returning to school|academic standing|gpa)/i;
  var MONTH_SEASON = { 0: 'Spring', 1: 'Spring', 4: 'Summer', 5: 'Summer', 7: 'Fall', 8: 'Fall' };

  function canonical(season, year) {
    var s = season.toLowerCase() === 'autumn' ? 'fall' : season.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1) + ' ' + year;
  }

  function inExcludedContext(text, idx) {
    var start = Math.max(0, idx - 60);
    var before = text.slice(start, idx);
    // Only look back within the same sentence.
    var cut = Math.max(before.lastIndexOf('.'), before.lastIndexOf('\n'));
    if (cut !== -1) before = before.slice(cut + 1);
    return EXCLUDE_CONTEXT.test(before);
  }

  function findTerms(text) {
    text = String(text || '');
    var found = [];
    var re, m;
    function add(term, idx) {
      if (!inExcludedContext(text, idx) && found.indexOf(term) === -1) found.push(term);
    }

    // "Summer 2027", "Summer of 2027", "Summer '27"
    re = new RegExp('\\b' + SEASON + "\\s*(?:of\\s+)?(['’])?(20\\d{2}|\\d{2})\\b", 'gi');
    while ((m = re.exec(text))) {
      if (m[3].length === 2 && !m[2]) continue; // "Summer 27" without apostrophe is too ambiguous
      add(canonical(m[1], m[3].length === 2 ? '20' + m[3] : m[3]), m.index);
    }
    // "2027 Summer"
    re = new RegExp('\\b(20\\d{2})\\s+' + SEASON + '\\b', 'gi');
    while ((m = re.exec(text))) add(canonical(m[2], m[1]), m.index);
    // "Summer Internship 2027", "Spring Co-op - 2027"
    re = new RegExp('\\b' + SEASON + '\\s+(?:internships?|interns?|co-?ops?|analyst|associate)(?:\\s+program)?\\s*[-–,(]?\\s*(20\\d{2})\\b', 'gi');
    while ((m = re.exec(text))) add(canonical(m[1], m[2]), m.index);
    // Month ranges: "January - April 2027", "May 2027 – August 2027"
    var month = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    re = new RegExp('\\b' + month + '\\.?\\s*(20\\d{2})?\\s*(?:-|–|—|to|through)\\s*' + month + '\\.?\\s*(20\\d{2})\\b', 'gi');
    while ((m = re.exec(text))) {
      var startMonth = Util.MONTHS[m[1].toLowerCase()];
      var season = MONTH_SEASON[startMonth];
      var year = m[2] || m[4];
      if (season && year) add(season + ' ' + year, m.index);
    }
    return found;
  }

  /**
   * @return {{term: string, terms: string[], status: string}}
   *   status is FOUND, NONE or CONFLICT.
   */
  function detect(subject, body) {
    var subjectTerms = findTerms(subject);
    var bodyTerms = findTerms(body);
    if (subjectTerms.length === 1) {
      return { term: subjectTerms[0], terms: union(subjectTerms, bodyTerms), status: 'FOUND' };
    }
    var all = union(subjectTerms, bodyTerms);
    if (all.length === 0) return { term: '', terms: [], status: 'NONE' };
    if (all.length === 1) return { term: all[0], terms: all, status: 'FOUND' };
    return { term: '', terms: all, status: 'CONFLICT' };
  }

  function union(a, b) {
    var out = a.slice();
    b.forEach(function (t) { if (out.indexOf(t) === -1) out.push(t); });
    return out;
  }

  /** ELIGIBLE, INELIGIBLE, UNKNOWN or CONFLICT. */
  function eligibility(termResult, eligibleTerms) {
    if (termResult.status === 'CONFLICT') return 'CONFLICT';
    if (!termResult.term) return 'UNKNOWN';
    var ok = eligibleTerms.some(function (t) { return Util.sameTerm(t, termResult.term); });
    return ok ? 'ELIGIBLE' : 'INELIGIBLE';
  }

  function isEligibleTerm(term, eligibleTerms) {
    return !!term && eligibleTerms.some(function (t) { return Util.sameTerm(t, term); });
  }

  return { findTerms: findTerms, detect: detect, eligibility: eligibility, isEligibleTerm: isEligibleTerm };
})();
