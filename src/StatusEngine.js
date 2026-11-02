/**
 * StatusEngine: applies one event to one application and returns the new
 * application state. Pure and idempotent: applying the same event twice
 * gives the same result as applying it once.
 *
 * Rules:
 *  - A confirmation ("Applied") never moves a later status backwards; it only
 *    fills in Applied Date. So a delayed confirmation can't undo an interview.
 *  - Reminders and generic updates never change status.
 *  - Only APPLIED events set Applied Date (an interview email does not).
 *  - Events older than the current status don't change it.
 *  - After Rejected/Withdrawn, a newer non-matching event goes to review.
 *  - After Offer, anything except Withdrawn goes to review.
 *  - Stages are NOT assumed to be ordered: a newer Assessment can follow an
 *    Interview.
 *  - Manual Status Lock: status is never changed, other fields still update.
 *  - opts.force (from an approved review) skips the contradiction checks,
 *    but still respects the lock.
 */
var StatusEngine = (function () {
  var STATUS_FOR_EVENT = {
    APPLIED: 'Applied', ASSESSMENT: 'Assessment', INTERVIEW: 'Interview',
    OFFER: 'Offer', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn'
  };
  var STATUSES = ['Applied', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
  var TERMINAL = { Rejected: true, Withdrawn: true };

  function clone(app) {
    var c = {};
    Object.keys(app).forEach(function (k) { c[k] = app[k]; });
    c.threadIds = (app.threadIds || []).slice();
    return c;
  }

  function time(d) { return d ? d.getTime() : null; }

  /**
   * @param app   application object
   * @param ev    { type, eventDate, appliedDate, deadline, threadId, link }
   * @param opts  { force }
   * @return { app, changed, statusChanged, review: string|null, note: string }
   */
  function apply(app, ev, opts) {
    opts = opts || {};
    var next = clone(app);
    var newStatus = STATUS_FOR_EVENT[ev.type] || '';
    var cur = app.status || '';
    var evTime = time(ev.eventDate);
    var isStale = !!(app.statusDate && evTime !== null && evTime < time(app.statusDate));
    var note = '';
    var setStatus = false;

    if (newStatus) {
      if (app.locked) {
        note = 'Status locked; kept ' + (cur || '(blank)');
      } else if (!cur) {
        setStatus = true;
      } else if (cur === newStatus) {
        note = 'Status unchanged';
      } else if (ev.type === 'APPLIED') {
        note = 'Confirmation does not override ' + cur;
      } else if (opts.force) {
        setStatus = true;
      } else if (TERMINAL[cur]) {
        if (isStale && !TERMINAL[newStatus]) {
          note = 'Older ' + newStatus + ' event; already ' + cur;
        } else {
          return reviewResult(app, newStatus + ' event after ' + cur);
        }
      } else if (cur === 'Offer' && newStatus !== 'Withdrawn') {
        if (isStale && !TERMINAL[newStatus]) note = 'Older ' + newStatus + ' event; already Offer';
        else return reviewResult(app, newStatus + ' event after Offer');
      } else if (isStale) {
        if (TERMINAL[newStatus]) return reviewResult(app, 'Older ' + newStatus + ' than current ' + cur + ' status');
        note = 'Older ' + newStatus + ' event; kept ' + cur;
      } else {
        setStatus = true;
      }
    } else {
      note = ev.type === 'REMINDER' ? 'Reminder (no status change)' : 'Update (no status change)';
    }

    if (ev.type === 'APPLIED') {
      var applied = ev.appliedDate || ev.eventDate;
      if (applied && (!next.appliedDate || time(applied) < time(next.appliedDate))) next.appliedDate = applied;
    }

    var prevLast = app.lastEventDate;
    if (ev.deadline && (!next.nextDeadline || !prevLast || evTime >= time(prevLast))) next.nextDeadline = ev.deadline;
    next.lastEventDate = Util.maxDate(app.lastEventDate, ev.eventDate);

    if (setStatus) {
      next.status = newStatus;
      next.statusDate = ev.eventDate;
      if (ev.link) next.sourceLink = ev.link;
      if (TERMINAL[newStatus]) next.nextDeadline = null;
      note = (cur || '(new)') + ' → ' + newStatus;
    }
    if (!next.sourceLink && ev.link) next.sourceLink = ev.link;
    if (ev.threadId && next.threadIds.indexOf(ev.threadId) === -1) next.threadIds.push(ev.threadId);

    return {
      app: next,
      changed: !equalApps(app, next),
      statusChanged: next.status !== app.status,
      review: null,
      note: note
    };
  }

  function reviewResult(app, reason) {
    return { app: app, changed: false, statusChanged: false, review: reason, note: '' };
  }

  var FIELDS = ['company', 'role', 'reqId', 'location', 'term', 'appliedDate', 'status', 'lastEventDate',
    'nextDeadline', 'sourceLink', 'statusDate'];

  function equalApps(a, b) {
    for (var i = 0; i < FIELDS.length; i++) {
      var x = a[FIELDS[i]], y = b[FIELDS[i]];
      if (Util.isDate(x) || Util.isDate(y)) {
        if (!Util.sameInstant(Util.toDate(x), Util.toDate(y))) return false;
      } else if ((x || '') !== (y || '')) {
        return false;
      }
    }
    return (a.threadIds || []).join(',') === (b.threadIds || []).join(',');
  }

  /** Build a brand-new application from an extraction (blank fields stay blank). */
  function newApplication(id, ext, now) {
    return {
      id: id, company: ext.company || '', role: ext.role || '', reqId: ext.reqId || '',
      location: ext.location || '', term: ext.term || '', appliedDate: null, status: '',
      lastEventDate: null, nextDeadline: null, sourceLink: '', locked: false, notes: '',
      statusDate: null, threadIds: [], createdAt: now, updatedAt: now
    };
  }

  /** Fill blank descriptive fields only, so manual corrections are preserved. */
  function fillBlanks(app, ext) {
    var next = clone(app);
    ['company', 'role', 'reqId', 'location', 'term'].forEach(function (f) {
      if (!next[f] && ext[f]) next[f] = ext[f];
    });
    return next;
  }

  return {
    STATUSES: STATUSES, STATUS_FOR_EVENT: STATUS_FOR_EVENT, apply: apply,
    newApplication: newApplication, fillBlanks: fillBlanks, equalApps: equalApps
  };
})();
