/**
 * ReviewService: applies decisions from the Review Queue tab.
 *
 * In the sheet, pick a Decision for a row, optionally fill Corrected Values,
 * then run "Process review decisions":
 *   Approve  - accept the extraction. Updates the Candidate Application ID if
 *              there is exactly one; otherwise creates a new application.
 *   Correct  - like Approve, after applying Corrected Values.
 *   Link     - attach to an existing application (Candidate Application ID,
 *              or app=APP-... in Corrected Values).
 *   Ignore   - drop the email; it will never be processed again.
 *
 * Corrected Values format (any subset, separated by ";"):
 *   company=Acme; role=Software Engineer Intern; term=Summer 2027;
 *   status=Interview; reqId=R123; location=New York, NY; date=2026-10-01;
 *   app=APP-abc123
 *
 * Every resolved row gets a Resolution, and its event moves out of REVIEW, so
 * processing the same decision twice changes nothing.
 */
var ReviewService = (function () {
  var EVENT_FOR_STATUS = {
    applied: 'APPLIED', assessment: 'ASSESSMENT', interview: 'INTERVIEW', offer: 'OFFER',
    rejected: 'REJECTED', withdrawn: 'WITHDRAWN'
  };
  var KEYS = {
    company: 'company', role: 'role', term: 'term', status: 'status', reqid: 'reqId',
    req: 'reqId', location: 'location', date: 'date', app: 'app', application: 'app'
  };

  /** Parse "key=value; key=value". Pure. Throws on unknown keys or statuses. */
  function parseCorrections(text) {
    var out = {};
    String(text || '').split(/[;\n]/).forEach(function (part) {
      if (!part.trim()) return;
      var eq = part.indexOf('=');
      if (eq === -1) throw new Error('Expected key=value in "' + part.trim() + '"');
      var key = KEYS[part.slice(0, eq).trim().toLowerCase().replace(/[\s_]/g, '')];
      var value = part.slice(eq + 1).trim();
      if (!key) throw new Error('Unknown key in "' + part.trim() + '"');
      if (key === 'status') {
        if (!EVENT_FOR_STATUS[value.toLowerCase()]) throw new Error('Unknown status "' + value + '"');
        out.eventType = EVENT_FOR_STATUS[value.toLowerCase()];
      } else if (key === 'date') {
        var d = Util.parseDate(value, null);
        if (!d) throw new Error('Could not read date "' + value + '" (use YYYY-MM-DD)');
        out.eventDate = d;
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  /**
   * Work out what one review decision means. Pure.
   * @return { kind: 'IGNORE'|'APPLY'|'NOOP'|'ERROR', message, eventUpdate }
   */
  function resolve(review, event, appIds) {
    var decision = String(review.decision || '').trim();
    if (!decision) return { kind: 'SKIP' };
    if (review.resolution) return { kind: 'SKIP' };
    if (!event) return { kind: 'ERROR', message: 'Event ' + review.eventId + ' not found' };
    if (event.state === 'COMPLETED' || event.state === 'IGNORED') {
      return { kind: 'NOOP', message: 'Already ' + event.state.toLowerCase() };
    }
    if (decision === 'Ignore') return { kind: 'IGNORE', message: 'Ignored' };

    var corr;
    try { corr = decision === 'Correct' || review.corrected ? parseCorrections(review.corrected) : {}; }
    catch (e) { return { kind: 'ERROR', message: e.message }; }

    var details = {};
    Object.keys(event.details || {}).forEach(function (k) { details[k] = event.details[k]; });
    ['company', 'role', 'term', 'reqId', 'location', 'eventType', 'eventDate'].forEach(function (k) {
      if (corr[k] !== undefined) details[k] = corr[k];
    });
    if (corr.eventDate) details.appliedDate = details.eventType === 'APPLIED' ? corr.eventDate : details.appliedDate;
    details.force = true;
    details.reviewedDecision = decision;

    var candidate = String(review.candidateAppId || '').trim();
    var singleCandidate = /^APP-[^,\s]+$/.test(candidate) ? candidate : '';
    var target = corr.app || ((decision === 'Link' || decision === 'Approve' || decision === 'Correct') ? singleCandidate : '');
    if (decision === 'Link' && !target) {
      return { kind: 'ERROR', message: 'Link needs one Candidate Application ID or app=APP-... in Corrected Values' };
    }
    if (target && !appIds[target]) return { kind: 'ERROR', message: 'Application ' + target + ' not found' };

    if (target) {
      return { kind: 'APPLY', message: 'Applied to ' + target,
        eventUpdate: { appId: target, decision: 'UPDATE', state: 'PENDING', details: details, eventType: details.eventType || '' } };
    }
    if (!details.company) return { kind: 'ERROR', message: 'Cannot create an application without company= (use Correct)' };
    if (!StatusEngine.STATUS_FOR_EVENT[details.eventType]) {
      return { kind: 'ERROR', message: 'Cannot create an application without status= (use Correct)' };
    }
    var newId = SyncPlanner.appIdFor(event.messageId);
    details.createIfMissing = true;
    return { kind: 'APPLY', message: 'Created ' + newId,
      eventUpdate: { appId: newId, decision: 'CREATE', state: 'PENDING', details: details, eventType: details.eventType } };
  }

  /** Apps Script: process every decided-but-unresolved review row. */
  function processDecisions(now) {
    now = now || new Date();
    var repo = SheetRepository;
    var events = {};
    repo.readEvents().forEach(function (e) { events[e.eventId] = e; });
    var appIds = {};
    repo.readApplications().forEach(function (a) { appIds[a.id] = true; });

    var eventUpdates = [], reviewUpdates = [], summary = { applied: 0, ignored: 0, errors: 0, noop: 0 };
    var pendingReviewIds = [];
    repo.readReviews().forEach(function (r) {
      var res = resolve(r, events[r.eventId], appIds);
      if (res.kind === 'SKIP') return;
      if (res.kind === 'ERROR') {
        summary.errors++;
        reviewUpdates.push({ key: r.reviewId, fields: { reason: 'ERROR: ' + res.message + ' | ' + r.reason.replace(/^ERROR: .*? \| /, '') } });
        return;
      }
      if (res.kind === 'NOOP') {
        summary.noop++;
        reviewUpdates.push({ key: r.reviewId, fields: { resolution: res.message, resolvedAt: now } });
        return;
      }
      if (res.kind === 'IGNORE') {
        summary.ignored++;
        eventUpdates.push({ key: r.eventId, fields: { state: 'IGNORED', decision: 'IGNORE', updatedAt: now } });
        reviewUpdates.push({ key: r.reviewId, fields: { resolution: 'Ignored', resolvedAt: now } });
        return;
      }
      summary.applied++;
      var u = res.eventUpdate;
      eventUpdates.push({ key: r.eventId, fields: {
        appId: u.appId, decision: u.decision, state: 'PENDING', details: u.details,
        eventType: u.eventType, updatedAt: now } });
      pendingReviewIds.push({ reviewId: r.reviewId, eventId: r.eventId, message: res.message });
    });

    // 1) Persist PENDING events, 2) apply them, 3) record resolutions.
    repo.updateEvents(eventUpdates);
    var applied = SyncService.applyPending(now, 'review');
    pendingReviewIds.forEach(function (p) {
      var ok = applied.completed.indexOf(p.eventId) !== -1;
      reviewUpdates.push({ key: p.reviewId, fields: ok
        ? { resolution: p.message, resolvedAt: now }
        : { reason: 'ERROR: could not apply (see Events tab)' } });
    });
    repo.updateReviews(reviewUpdates);
    return summary;
  }

  return { parseCorrections: parseCorrections, resolve: resolve, processDecisions: processDecisions };
})();
