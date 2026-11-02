/**
 * EmailParser: turns one email into a structured "extraction" using rules
 * and regular expressions. Pure JavaScript (no Gmail calls).
 *
 * Input email shape (built by GmailReader or by test fixtures):
 *   { id, threadId, date: Date, from, subject, body, labels: [], link }
 *
 * Unknown fields are left as '' / null. Nothing is guessed from the sender
 * domain, because recruiting platforms send for many employers.
 *
 * Extension point: EmailParser.registerExtractor(fn) adds a second-stage
 * extractor (e.g. an LLM call later). It receives (email, extraction) and
 * returns a partial object; only fields that are still blank are filled.
 */
var EmailParser = (function () {
  var extraExtractors = [];

  // Each rule: event type + phrases. Order matters: first match wins.
  var EVENT_RULES = [
    { type: 'WITHDRAWN', patterns: [
      /\byour application has been withdrawn\b/i, /\byou(?:'ve| have) withdrawn\b/i,
      /\brequest to withdraw\b/i, /\bwithdrawal of your application\b/i,
      /\bapplication (?:was|is) withdrawn\b/i] },
    { type: 'REJECTED', patterns: [
      /\b(?:decided|chosen|elected) not to (?:move|proceed|advance)\b/i,
      /\bwill not be (?:moving|proceeding) forward\b/i, /\bnot (?:be )?moving forward with your\b/i,
      /\b(?:move|moving) forward with other candidates\b/i, /\bpursue other candidates\b/i,
      /\bregret to inform\b/i, /\bnot (?:been )?selected\b/i, /\bposition has been filled\b/i,
      /\bunable to offer you\b/i, /\bwe will not be offering\b/i, /\bnot a match at this time\b/i] },
    { type: 'OFFER', patterns: [
      /\bpleased to (?:extend an |offer you\b)/i, /\bexcited to (?:extend an |offer you\b)/i,
      /\boffer of employment\b/i, /\byour offer letter\b/i, /\bextend(?:ing)? (?:you )?an offer\b/i,
      /\bcongratulations[^.]{0,80}\boffer\b/i] },
    { type: 'REMINDER', patterns: [
      /^\s*(?:friendly\s+)?reminder\b/i, /\bfriendly reminder\b/i, /\bthis is a reminder\b/i,
      /\bjust a reminder\b/i, /\bhave not (?:yet )?completed\b/i, /\bhasn't been completed\b/i,
      /\bexpires? (?:soon|in \d+)\b/i] },
    { type: 'ASSESSMENT', patterns: [
      /\bonline assessment\b/i, /\bcoding (?:challenge|assessment|test)\b/i,
      /\btechnical assessment\b/i, /\bcomplete (?:the|this|our|an?) (?:\w+ )?assessment\b/i,
      /\bhackerrank\b/i, /\bcodesignal\b/i, /\bcodility\b/i, /\btake-home\b/i,
      /\bassessment invitation\b/i, /\binvited to (?:complete|take) (?:a|an|the)\b/i] },
    { type: 'INTERVIEW', patterns: [
      /\binvite you to (?:an? )?(?:\w+ )?interview\b/i, /\binterview invitation\b/i,
      /\bschedule (?:an?|your) (?:\w+ )?interview\b/i, /\b(?:like|love) to (?:schedule|set up|invite you)\b/i,
      /\bnext round\b/i, /\bphone screen\b/i, /\bsuperday\b/i, /\bavailability for (?:an? )?(?:\w+ )?interview\b/i,
      /\byour interview (?:is|has been) (?:scheduled|confirmed)\b/i, /\binterview confirmation\b/i,
      /\bmove (?:you )?forward to (?:the )?(?:next|interview)\b/i] },
    { type: 'APPLIED', patterns: [
      /\bthank(?:s| you) for (?:applying|submitting your application)\b/i,
      /\b(?:we(?:'ve| have)? )?received your application\b/i,
      /\byour application (?:has been|was) (?:received|submitted|sent)\b/i,
      /\bapplication (?:received|confirmation|submitted)\b/i,
      /\byour application was sent to\b/i, /\bsuccessfully (?:applied|submitted)\b/i,
      /\bthank(?:s| you) for your application\b/i] }
  ];

  // Second-person phrases that show the email is about *your* application.
  var PERSONAL = [
    /\byour application\b/i, /\byou(?:'ve| have)? applied\b/i, /\bthank(?:s| you) for applying\b/i,
    /\byour candidacy\b/i, /\binvite you\b/i, /\boffer you\b/i,
    /\bregret to inform you\b/i, /\byour (?:online |technical )?assessment\b/i,
    /\byour (?:recent )?(?:interest|submission)\b/i, /\bwith your application\b/i
  ];

  // Signals of job ads, alerts and newsletters.
  var AD_SIGNALS = [
    /\bjob alert\b/i, /\bjobs? (?:you may|you might|we think you)\b/i, /\brecommended (?:jobs|for you|roles)\b/i,
    /\bnew jobs? (?:for you|matching|posted)\b/i, /\bnewsletter\b/i, /\bwebinar\b/i, /\bdigest\b/i,
    /\btips (?:for|to)\b/i, /\bcareer (?:fair|advice|tips)\b/i, /\bwe(?:'re| are) hiring\b/i,
    /\bopen (?:roles|positions)\b/i, /\bsimilar jobs\b/i, /\bhow to (?:ace|prepare|nail)\b/i,
    /\bview (?:all )?jobs\b/i, /\bapply now\b/i, /\bupcoming events?\b/i
  ];

  var UPDATE_PHRASES = [/\byour application\b/i, /\bapplication status\b/i, /\byour candidacy\b/i];

  var FOOTER_MARKERS = /(unsubscribe|privacy policy|©|\(c\) \d{4}|copyright|this (?:e-?mail|message) was sent|you are receiving this|do not reply to this|manage (?:your )?(?:email )?preferences|equal (?:employment )?opportunity employer)/i;

  var ROLE_WORDS = /\b(intern|internship|co-?op|engineer|engineering|developer|analyst|scientist|designer|researcher|associate|manager|specialist|consultant|technician|programmer|architect|fellow|trainee|apprentice|administrator)\b/i;

  var COMPANY_STOPWORDS = /^(?:our|we|us|you|your|the team|team|greenhouse|lever|workday|linkedin|handshake|icims|ashby|jobvite|hackerrank|codesignal|no-?reply|notifications?|recruiting|careers|hr|talent|unfortunately|thank you|congratulations|hi|hello|dear)$/i;

  var NAME_SUFFIX = /\s*(?:\(?via [^)]*\)?|university recruiting|campus recruiting|early careers?|talent acquisition|recruiting team|recruitment|recruiting|hiring team|careers?|jobs|talent|hr team|people team)\s*$/i;

  /** Remove quoted replies and the footer, keep the main message. */
  function mainText(body) {
    var lines = String(body || '').replace(/\r/g, '').split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*>/.test(line)) continue;
      if (/^\s*On .{5,120} wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line)) break;
      if (i >= 3 && FOOTER_MARKERS.test(line)) break;
      out.push(line);
    }
    return out.join('\n');
  }

  function countMatches(list, text) {
    return list.filter(function (re) { return re.test(text); }).length;
  }

  function classify(subject, text) {
    var both = subject + '\n' + text;
    for (var i = 0; i < EVENT_RULES.length; i++) {
      var rule = EVENT_RULES[i];
      for (var j = 0; j < rule.patterns.length; j++) {
        var re = rule.patterns[j];
        // Reminder phrases at line start only make sense against the subject.
        var target = rule.type === 'REMINDER' && re.source.charAt(0) === '^' ? subject : both;
        var m = re.exec(target);
        if (m) return { type: rule.type, index: target === subject ? -1 : m.index - subject.length - 1, match: m[0] };
      }
    }
    for (var k = 0; k < UPDATE_PHRASES.length; k++) {
      var u = UPDATE_PHRASES[k].exec(text);
      if (u) return { type: 'UPDATE', index: u.index, match: u[0] };
    }
    return null;
  }

  // Capitalized phrase of 1-5 words, allowing "&", "." and "-" inside names.
  var CAP = "([A-Z0-9][A-Za-z0-9&.'’\\-]*(?:\\s+(?:&\\s+)?[A-Z0-9][A-Za-z0-9&.'’\\-]*){0,4})";

  var COMPANY_PATTERNS = [
    new RegExp('\\b(?:applying|applied|application)\\s+(?:to|at|with)\\s+' + CAP),
    new RegExp('\\bapplication was sent to\\s+' + CAP),
    new RegExp('\\b(?:position|role|opportunity|internship|co-op|job|program|opening)\\b(?:\\s*\\([^)]*\\))?\\s+(?:at|with)\\s+' + CAP),
    new RegExp('\\binterest in (?:joining |working (?:at|with|for) )?' + CAP),
    new RegExp('\\bfrom\\s+' + CAP + '\\s*$'),
    new RegExp('^(?:the\\s+)?' + CAP + '\\s+(?:university |campus |early careers? )?(?:recruiting|talent acquisition|recruitment|hiring|careers|people)(?:\\s+team)?\\s*$', 'm'),
    new RegExp('^' + CAP + '\\s*[-–|:]\\s*(?:application|interview|assessment|offer|your|thank)', 'i')
  ];

  function cleanCompany(raw) {
    // Stop at a sentence boundary: "Hooli. We would..." -> "Hooli".
    var s = Util.collapse(raw).split(/[.!?;]\s/)[0].replace(/[.,;:!'’\-]+$/, '').replace(/^the\s+/i, '');
    // Drop trailing generic words that the capitalized-phrase regex swallows.
    s = s.replace(/\s+(?:Team|Recruiting|Careers|Hiring|Talent|For|And|Is|We|Our)$/i, '');
    if (!s || s.length < 2 || COMPANY_STOPWORDS.test(s)) return '';
    if (ROLE_WORDS.test(s)) return ''; // looks like a role title, not an employer
    if (/^(?:spring|summer|fall|winter)\b/i.test(s) || /^\d+$/.test(s)) return '';
    return s;
  }

  function extractCompany(email, subject, text) {
    var sources = [subject, text];
    for (var i = 0; i < COMPANY_PATTERNS.length; i++) {
      for (var j = 0; j < sources.length; j++) {
        var m = COMPANY_PATTERNS[i].exec(sources[j]);
        if (m) {
          var c = cleanCompany(m[1]);
          if (c) return { value: c, source: j === 0 ? 'subject' : 'body' };
        }
      }
    }
    // Sender display name, but only when it carries a recruiting suffix
    // ("Acme Careers", "Acme via Greenhouse"), so a recruiter's personal name
    // is never mistaken for the company.
    var name = Util.displayName(email.from);
    if (name && NAME_SUFFIX.test(name)) {
      var stripped = cleanCompany(name.replace(NAME_SUFFIX, ''));
      if (stripped) return { value: stripped, source: 'sender-name' };
    }
    return { value: '', source: '' };
  }

  function cleanRole(raw) {
    var s = Util.collapse(raw)
      .replace(/\([^)]*\b20\d{2}\b[^)]*\)/g, '')
      .replace(/\(\s*(?:req(?:uisition)?|job)?\s*(?:id|#)?\s*:?\s*[A-Z]{0,4}-?\d{3,}[A-Z0-9-]*\s*\)/gi, '')
      .replace(/\b(?:req(?:uisition)?|job)\s*(?:id|#|number|no\.?)\s*:?\s*[A-Z]{0,4}-?\d{3,}[A-Z0-9-]*/gi, '')
      .replace(/[-–,|(]\s*(?:spring|summer|fall|autumn|winter)\s*(?:of\s+)?'?(?:20)?\d{2}\s*\)?/gi, '')
      .replace(/\b(?:spring|summer|fall|autumn|winter)\s*(?:of\s+)?'?20\d{2}\b/gi, '')
      .replace(/^(?:the|our|a|an)\s+/i, '')
      .replace(/\s+(?:position|role|opening|opportunity|job)$/i, '')
      .replace(/[\s,.;:\-–|(]+$/, '');
    return Util.collapse(s);
  }

  var ROLE_PATTERNS = [
    { re: /^\s*(?:position|role|job title|job|title|requisition title)\s*:\s*(.+)$/im, needsRoleWord: false },
    { re: /\b(?:for|to) (?:the|our) (?:position of |role of )?(.{3,90}?)\s+(?:position|role|opening|opportunity|job)\b/i, needsRoleWord: true },
    { re: /\b(?:applying|applied|application|interest|candidacy) (?:to|for|in) (?:the |our )?(.{3,90}?)(?:\s+(?:position|role))?(?:\s*\([^)]*\))?\s+(?:at|with)\s+[A-Z]/, needsRoleWord: true },
    { re: /(?:application (?:received|submitted|confirmation)|thank you for applying|interview invitation|assessment invitation)\s*[-:–|]\s*(.+)$/i, needsRoleWord: true, subjectOnly: true },
    { re: /^(.{3,90}?)\s*[-–|:]\s*(?:application|interview|assessment)/i, needsRoleWord: true, subjectOnly: true }
  ];

  function extractRole(subject, text) {
    for (var i = 0; i < ROLE_PATTERNS.length; i++) {
      var p = ROLE_PATTERNS[i];
      var sources = p.subjectOnly ? [subject] : [subject, text];
      for (var j = 0; j < sources.length; j++) {
        var m = p.re.exec(sources[j]);
        if (!m) continue;
        var role = cleanRole(m[1]);
        if (role.length < 3 || role.length > 90) continue;
        if (p.needsRoleWord && !ROLE_WORDS.test(role)) continue;
        return role;
      }
    }
    return '';
  }

  function extractReqId(subject, text) {
    var both = subject + '\n' + text;
    var m = /\b(?:req(?:uisition)?|job)\s*(?:id|#|number|no\.?)?\s*[:#]?\s*([A-Z]{0,4}-?\d{3,}[A-Z0-9-]*)\b/i.exec(both);
    if (m) return m[1].toUpperCase();
    m = /\b((?:JR|REQ|R)-?\d{4,})\b/.exec(both);
    return m ? m[1].toUpperCase() : '';
  }

  function extractLocation(text) {
    var m = /^\s*(?:location|office|work location)s?\s*:\s*(.{2,60})$/im.exec(text);
    if (m) return Util.collapse(m[1]).replace(/[.;]+$/, '');
    m = /\b(?:based in|located in|in our)\s+([A-Z][A-Za-z.\-]+(?:\s[A-Z][A-Za-z.\-]+)*(?:,\s*[A-Z]{2})?)(?:\s+office)?\b/.exec(text);
    return m ? Util.collapse(m[1]) : '';
  }

  function extractAppliedDate(text, emailDate) {
    var re = new RegExp('\\b(?:applied|submitted|received)(?: your application)?(?: on| at)?\\s+(' + Util.dateRegex().source + ')', 'i');
    var m = re.exec(text);
    if (!m) return null;
    var d = Util.parseDate(m[1], emailDate);
    return d && d.getTime() <= emailDate.getTime() ? d : null;
  }

  function extractDeadline(text, emailDate) {
    var re = new RegExp('\\b(?:deadline(?: is)?|due(?: date)?(?: is)?|(?:complete|submit|respond|reply|finish|share|send|provide)[\\w ]{0,30}? by|no later than|expires?(?: on)?|before)\\s*:?\\s*(?:on\\s+)?(' + Util.dateRegex().source + ')', 'i');
    var m = re.exec(text);
    if (m) {
      var d = Util.parseDate(m[1], emailDate);
      if (d && d.getTime() >= Util.startOfDay(emailDate).getTime()) return d;
    }
    m = /\bwithin (\d{1,2}) (business |calendar )?days\b/i.exec(text);
    if (m) {
      var n = Number(m[1]);
      return m[2] && /business/i.test(m[2]) ? Util.addBusinessDays(emailDate, n) : Util.addDays(Util.startOfDay(emailDate), n);
    }
    return null;
  }

  /**
   * Parse one email.
   * @return extraction object (see README "Data model").
   */
  function parse(email) {
    var subject = Util.collapse(email.subject);
    var fullBody = String(email.body || '');
    var text = mainText(fullBody);
    var emailDate = Util.toDate(email.date);

    var personal = countMatches(PERSONAL, subject + '\n' + text);
    var adSignals = countMatches(AD_SIGNALS, subject + '\n' + fullBody);
    var event = classify(subject, text);

    var relevance, relevanceReason;
    // Ads/newsletters: ad signals and nothing personal, or several ad signals
    // with no concrete event (only a vague "your application" mention).
    var vague = !event || event.type === 'UPDATE';
    if (adSignals > 0 && (personal === 0 || (adSignals >= 2 && vague))) {
      relevance = 'AD'; relevanceReason = 'Looks like a job ad, alert or newsletter';
    } else if (event) {
      relevance = 'APPLICATION'; relevanceReason = 'Matched "' + event.match + '"';
    } else {
      relevance = 'NOT_RECRUITING'; relevanceReason = 'No application-specific phrases';
    }

    var term = TermDetector.detect(subject, text);
    var company = extractCompany(email, subject, text);
    var appliedDate = event && event.type === 'APPLIED' ? extractAppliedDate(text, emailDate) : null;

    var evidence = '';
    if (event) {
      evidence = event.index < 0 ? 'Subject: ' + subject : Util.snippetAround(text, Math.max(0, event.index));
    }

    var extraction = {
      messageId: email.id,
      threadId: email.threadId,
      emailDate: emailDate,
      subject: subject,
      link: email.link || '',
      labels: email.labels || [],
      relevance: relevance,
      relevanceReason: relevanceReason,
      eventType: relevance === 'APPLICATION' ? event.type : '',
      company: company.value,
      companySource: company.source,
      role: extractRole(subject, text),
      reqId: extractReqId(subject, text),
      location: extractLocation(text),
      term: term.term,
      termStatus: term.status,
      termsFound: term.terms,
      eventDate: appliedDate || emailDate,
      appliedDate: appliedDate,
      deadline: extractDeadline(text, emailDate),
      evidence: evidence
    };

    extraExtractors.forEach(function (fn) {
      var extra = fn(email, extraction) || {};
      Object.keys(extra).forEach(function (k) {
        if (extraction[k] === '' || extraction[k] === null || extraction[k] === undefined) extraction[k] = extra[k];
      });
    });
    return extraction;
  }

  function registerExtractor(fn) { extraExtractors.push(fn); }
  function clearExtractors() { extraExtractors = []; }

  return { parse: parse, mainText: mainText, registerExtractor: registerExtractor, clearExtractors: clearExtractors };
})();
