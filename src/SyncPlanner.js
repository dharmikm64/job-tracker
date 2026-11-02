/**
 * SyncPlanner: the pure "brain" of a sync. Given emails and the current
 * applications, it decides per message whether to CREATE, UPDATE, REVIEW,
 * IGNORE or SKIP, and produces the event and review records to persist.
 * Nothing here touches Gmail or Sheets, so it is fully testable in Node.
 */
var SyncPlanner = (function () {
  var PROPOSED_STATUS = {
    APPLIED: 'Applied', ASSESSMENT: 'Assessment', INTERVIEW: 'Interview', OFFER: 'Offer',
    REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', REMINDER: '(reminder)', UPDATE: '(update)'
  };

  function appIdFor(messageId) { return 'APP-' + messageId; }
  function eventIdFor(messageId) { return 'EVT-' + messageId; }
  function reviewIdFor(messageId) { return 'REV-' + messageId; }

  /** What gets stored in the Events "Details" column so an event can be re-applied later. */
  function detailsFrom(ext, extra) {
    var d = {
      subject: ext.subject, company: ext.company, role: ext.role, reqId: ext.reqId,
      location: ext.location, term: ext.term, termsFound: ext.termsFound, eventType: ext.eventType,
      eventDate: ext.eventDate, appliedDate: ext.appliedDate, deadline: ext.deadline,
      link: ext.link, threadId: ext.threadId, labels: ext.labels
    };
    Object.keys(extra || {}).forEach(function (k) { d[k] = extra[k]; });
    return d;
  }

  function eventFromExt(ext) {
    return {
      type: ext.eventType, eventDate: ext.eventDate, appliedDate: ext.appliedDate,
      deadline: ext.deadline, threadId: ext.threadId, link: ext.link
    };
  }

  /**
   * Decide what to do with one extraction.
   * @return { action, appId, reason, candidates, termEligibility }
   */
  function decide(ext, apps, config, isLabeled) {
    if (ext.relevance !== 'APPLICATION') {
      if (isLabeled && ext.relevance === 'NOT_RECRUITING') {
        return { action: 'REVIEW', reason: 'Labeled for inclusion but no application event recognized', candidates: [] };
      }
      return { action: 'SKIP', reason: ext.relevanceReason, candidates: [] };
    }

    var elig = TermDetector.eligibility({ term: ext.term, status: ext.termStatus }, config.eligibleTerms);
    var m = ApplicationMatcher.match(ext, apps, { allowCompanyOnlyMatch: config.allowCompanyOnlyMatch });
    var base = { termEligibility: elig, candidates: m.candidates || [] };

    function out(action, extra) {
      var r = { action: action, appId: '', reason: '' };
      Object.keys(base).forEach(function (k) { r[k] = base[k]; });
      Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }

    if (m.type === 'CONFLICT') return out('REVIEW', { reason: m.reason, candidates: [m.appId] });
    if (m.type === 'AMBIGUOUS') return out('REVIEW', { reason: m.reason });

    if (m.type === 'MATCH') {
      var app = apps.filter(function (a) { return a.id === m.appId; })[0];
      if (elig === 'CONFLICT') return out('REVIEW', { reason: 'Email mentions several hiring terms: ' + ext.termsFound.join(', '), candidates: [m.appId] });
      if (elig === 'INELIGIBLE') return out('REVIEW', { reason: 'Matched application but email says ' + ext.term, candidates: [m.appId] });
      var res = StatusEngine.apply(StatusEngine.fillBlanks(app, ext), eventFromExt(ext));
      if (res.review) return out('REVIEW', { reason: res.review, candidates: [m.appId] });
      return out('UPDATE', { appId: m.appId, reason: 'Matched by ' + m.method + '. ' + res.note, result: res });
    }

    // No existing application.
    if (elig === 'INELIGIBLE') return out('IGNORE', { reason: 'Out of scope: ' + ext.term });
    if (elig === 'CONFLICT') return out('REVIEW', { reason: 'Email mentions several hiring terms: ' + ext.termsFound.join(', ') });
    if (elig === 'UNKNOWN') return out('REVIEW', { reason: 'No hiring term and no matching application' });
    if (!ext.company) return out('REVIEW', { reason: 'Company not identified' });
    if (!ext.role && !ext.reqId) return out('REVIEW', { reason: 'Role not identified' });
    if (!StatusEngine.STATUS_FOR_EVENT[ext.eventType]) return out('REVIEW', { reason: 'New application but the email has no clear status (' + ext.eventType + ')' });
    return out('CREATE', { appId: appIdFor(ext.messageId), reason: 'New ' + ext.term + ' application' });
  }

  function isFromMe(email, config) {
    var addr = Util.emailAddress(email.from);
    return email.isFromMe === true || config.myEmails.indexOf(addr) !== -1;
  }

  /**
   * Plan a batch.
   * @param emails     email objects (any order)
   * @param apps       current applications
   * @param knownIds   object/Set-like: knownIds[messageId] === true if already recorded
   * @param config     Config.build() result
   * @param ctx        { runId, now }
   * @return { decisions, events, reviews, workingApps }
   */
  function plan(emails, apps, knownIds, config, ctx) {
    var working = apps.map(function (a) { return a; });
    var byId = {};
    working.forEach(function (a) { byId[a.id] = a; });
    var sorted = emails.slice().sort(function (a, b) { return Util.toDate(a.date) - Util.toDate(b.date); });
    var decisions = [], events = [], reviews = [];
    var seen = {};

    sorted.forEach(function (email) {
      if (knownIds[email.id] || seen[email.id]) return;
      seen[email.id] = true;
      if (isFromMe(email, config)) return;

      var labeled = !!config.includeLabel && (email.labels || []).indexOf(config.includeLabel) !== -1;
      var ext, d;
      try {
        ext = EmailParser.parse(email);
        d = decide(ext, working, config, labeled);
      } catch (err) {
        // One bad email must not block the whole window: send it to review.
        ext = { messageId: email.id, threadId: email.threadId, emailDate: Util.toDate(email.date),
          eventDate: Util.toDate(email.date), subject: email.subject || '', link: email.link || '',
          labels: email.labels || [], eventType: '', evidence: '', termsFound: [] };
        d = { action: 'REVIEW', appId: '', reason: 'Parser error: ' + err.message, candidates: [] };
      }
      decisions.push({ email: email, ext: ext, decision: d });
      if (d.action === 'SKIP') return;

      var state = { CREATE: 'PENDING', UPDATE: 'PENDING', REVIEW: 'REVIEW', IGNORE: 'IGNORED' }[d.action];
      events.push({
        eventId: eventIdFor(ext.messageId), appId: d.appId || '', messageId: ext.messageId,
        threadId: ext.threadId, eventDate: ext.eventDate, eventType: ext.eventType || '',
        evidence: ext.evidence, state: state, runId: ctx.runId, decision: d.action,
        details: detailsFrom(ext, { reason: d.reason, candidates: d.candidates }), updatedAt: ctx.now
      });

      if (d.action === 'REVIEW') {
        reviews.push(reviewFromExt(ext, d.reason, d.candidates.length === 1 ? d.candidates[0] : (d.candidates || []).join(', ')));
      } else if (d.action === 'CREATE') {
        var created = StatusEngine.newApplication(d.appId, ext, ctx.now);
        var res = StatusEngine.apply(created, eventFromExt(ext));
        working.push(res.app);
        byId[res.app.id] = res.app;
      } else if (d.action === 'UPDATE') {
        var idx = working.indexOf(byId[d.appId]);
        working[idx] = d.result.app;
        byId[d.appId] = d.result.app;
      }
    });
    return { decisions: decisions, events: events, reviews: reviews, workingApps: working };
  }

  function reviewFromExt(ext, reason, candidate) {
    return {
      reviewId: reviewIdFor(ext.messageId), messageId: ext.messageId, company: ext.company || '',
      role: ext.role || '', term: ext.term || (ext.termsFound || []).join(' / '),
      proposedStatus: PROPOSED_STATUS[ext.eventType] || '', candidateAppId: candidate || '',
      reason: reason, decision: '', corrected: '', link: ext.link || '',
      eventId: eventIdFor(ext.messageId), resolution: '', resolvedAt: null
    };
  }

  /**
   * Apply persisted PENDING events to applications. Used for the normal path
   * and for recovery after an interrupted run; safe to repeat.
   * @return { apps (changed or created), completed: [eventId], toReview: [{event, reason}], stats }
   */
  function applyEvents(pendingEvents, apps, now) {
    var byId = {};
    apps.forEach(function (a) { byId[a.id] = a; });
    var original = {};
    var touched = {};
    var completed = [], toReview = [], created = 0, updated = 0;

    pendingEvents.slice().sort(function (a, b) { return Util.toDate(a.eventDate) - Util.toDate(b.eventDate); })
      .forEach(function (e) {
        var d = e.details || {};
        var ext = {
          company: d.company, role: d.role, reqId: d.reqId, location: d.location, term: d.term
        };
        var app = byId[e.appId];
        var isNew = false;
        if (!app) {
          if (e.decision !== 'CREATE' && !d.createIfMissing) {
            toReview.push({ event: e, reason: 'Linked application ' + e.appId + ' no longer exists' });
            return;
          }
          app = StatusEngine.newApplication(e.appId, ext, now);
          isNew = true;
        } else if (!original[app.id]) {
          original[app.id] = app;
        }
        var res = StatusEngine.apply(StatusEngine.fillBlanks(app, ext), {
          type: d.eventType || e.eventType, eventDate: Util.toDate(d.eventDate) || Util.toDate(e.eventDate),
          appliedDate: Util.toDate(d.appliedDate), deadline: Util.toDate(d.deadline),
          threadId: e.threadId, link: d.link
        }, { force: !!d.force });
        if (res.review) {
          toReview.push({ event: e, reason: res.review });
          return;
        }
        var nextApp = res.app;
        if (isNew) { nextApp.isNew = true; created++; }
        else if (res.changed || !StatusEngine.equalApps(app, nextApp)) { updated++; }
        nextApp.updatedAt = now;
        byId[nextApp.id] = nextApp;
        touched[nextApp.id] = true;
        completed.push(e.eventId);
      });

    var changedApps = Object.keys(touched).map(function (id) { return byId[id]; }).filter(function (a) {
      return a.isNew || !original[a.id] || !StatusEngine.equalApps(original[a.id], a);
    });
    return { apps: changedApps, completed: completed, toReview: toReview, stats: { created: created, updated: updated } };
  }

  return {
    plan: plan, decide: decide, applyEvents: applyEvents, reviewFromExt: reviewFromExt,
    appIdFor: appIdFor, eventIdFor: eventIdFor, reviewIdFor: reviewIdFor, PROPOSED_STATUS: PROPOSED_STATUS
  };
})();
