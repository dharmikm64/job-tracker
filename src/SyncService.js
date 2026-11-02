/**
 * SyncService: runs one sync (or dry run) end to end.
 *
 * Per search window:
 *   1. Read matching Gmail messages (read-only).
 *   2. SyncPlanner decides CREATE / UPDATE / REVIEW / IGNORE / SKIP.
 *   3. Persist events (PENDING / REVIEW / IGNORED) and review rows.
 *   4. applyPending(): apply PENDING events to Applications, then mark them
 *      COMPLETED.
 *   5. Only then advance the Gmail checkpoint.
 * If a run stops anywhere, the next run first re-applies PENDING events
 * (idempotent) and re-reads the unfinished window (deduplicated by message ID).
 */
var SyncService = (function () {
  function makeRunId(now) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'RUN-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
      pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '-' +
      Math.floor(Math.random() * 1e4);
  }

  /**
   * Apply all PENDING events, and make sure every REVIEW event has a review
   * row. Safe to call repeatedly; this is also the crash-recovery step.
   */
  function applyPending(now, runId) {
    var repo = SheetRepository;
    var events = repo.readEvents();
    var pending = events.filter(function (e) { return e.state === 'PENDING'; });

    // Recovery: a REVIEW event whose review row was never written.
    var reviewIds = {};
    repo.readReviews().forEach(function (r) { reviewIds[r.reviewId] = true; });
    var missingReviews = events.filter(function (e) {
      return e.state === 'REVIEW' && !reviewIds[SyncPlanner.reviewIdFor(e.messageId)];
    }).map(function (e) { return reviewFromEvent(e, (e.details && e.details.reason) || 'Needs review'); });
    repo.appendReviews(missingReviews);

    if (!pending.length) return { completed: [], created: 0, updated: 0, reviews: missingReviews.length };

    var res = SyncPlanner.applyEvents(pending, repo.readApplications(), now);
    repo.saveApplications(res.apps);
    // Applications are saved; now mark their events complete.
    repo.updateEvents(res.completed.map(function (id) {
      return { key: id, fields: { state: 'COMPLETED', updatedAt: now } };
    }));
    repo.updateEvents(res.toReview.map(function (t) {
      return { key: t.event.eventId, fields: { state: 'REVIEW', updatedAt: now } };
    }));
    repo.appendReviews(res.toReview.map(function (t) { return reviewFromEvent(t.event, t.reason); }));
    return {
      completed: res.completed, created: res.stats.created, updated: res.stats.updated,
      reviews: res.toReview.length + missingReviews.length
    };
  }

  function reviewFromEvent(e, reason) {
    var d = e.details || {};
    return SyncPlanner.reviewFromExt({
      messageId: e.messageId, company: d.company, role: d.role, term: d.term, termsFound: d.termsFound,
      eventType: d.eventType || e.eventType, link: d.link
    }, reason, (d.candidates || []).length === 1 ? d.candidates[0] : (e.appId || ''));
  }

  function myAddress() {
    try { return String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
  }

  function ensureSheets() {
    try { SheetRepository.readApplications(); SheetRepository.readEvents(); SheetRepository.readReviews(); }
    catch (e) { SheetRepository.ensureSchema(); }
  }

  /** Fetch every thread in a window, halving it while results fill a page. */
  function fetchWindow(window, config) {
    var w = window;
    var threads = GmailReader.searchThreads(GmailReader.buildQuery(config, w.start, w.end), 0, config.pageSize);
    while (threads.length >= config.pageSize) {
      var smaller = SyncState.shrink(w);
      if (!smaller) break;
      w = smaller;
      threads = GmailReader.searchThreads(GmailReader.buildQuery(config, w.start, w.end), 0, config.pageSize);
    }
    // Minimum-size window still full: read all pages now, within this run.
    var offset = threads.length;
    var page = threads;
    while (page.length >= config.pageSize && offset < 500) {
      page = GmailReader.searchThreads(GmailReader.buildQuery(config, w.start, w.end), offset, config.pageSize);
      threads = threads.concat(page);
      offset += page.length;
    }
    return { window: w, threads: threads };
  }

  /**
   * Run a sync.
   * @param options { dryRun: boolean }
   * @return summary object
   */
  function run(options) {
    options = options || {};
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
      Logger.log('Another sync is running; skipping this one.');
      return { skipped: true };
    }
    var started = new Date();
    var runId = makeRunId(started);
    var summary = { runId: runId, scanned: 0, created: 0, updated: 0, reviews: 0, errors: '', windows: 0 };
    var preview = [];
    var repo = SheetRepository;
    var config, state;
    try {
      config = Config.load();
      ensureSheets();
      repo.appendLog({ runId: runId, start: started, mode: options.dryRun ? 'DRY_RUN' : 'SYNC' });

      if (!options.dryRun) {
        var rec = applyPending(started, runId);
        summary.updated += rec.updated; summary.created += rec.created; summary.reviews += rec.reviews;
      }

      state = SyncState.load(config);
      var known = repo.knownMessageIds();
      var apps = repo.readApplications();
      var me = myAddress();
      var deadline = started.getTime() + config.maxRuntimeMs - 60 * 1000;

      while (Date.now() < deadline && summary.scanned < config.maxMessagesPerRun) {
        var window = SyncState.nextWindow(state, Date.now(), config);
        if (!window) break;
        var fetched = fetchWindow(window, config);
        var emails = GmailReader.toEmails(fetched.threads, state.importStart, config, me);
        var now = new Date();
        var plan = SyncPlanner.plan(emails, apps, known, config, { runId: runId, now: now });
        summary.scanned += plan.decisions.length;
        summary.windows++;

        if (options.dryRun) {
          plan.decisions.forEach(function (x) { preview.push(previewRow(x)); });
          summary.reviews += plan.reviews.length;
          summary.created += plan.decisions.filter(function (x) { return x.decision.action === 'CREATE'; }).length;
          summary.updated += plan.decisions.filter(function (x) { return x.decision.action === 'UPDATE'; }).length;
          apps = plan.workingApps;
        } else {
          repo.appendEvents(plan.events);   // PENDING / REVIEW / IGNORED
          repo.appendReviews(plan.reviews);
          var applied = applyPending(now, runId);
          summary.created += applied.created; summary.updated += applied.updated;
          summary.reviews += plan.reviews.length + applied.reviews;
          apps = repo.readApplications();
        }
        emails.forEach(function (e) { known[e.id] = true; });
        state = SyncState.complete(state, fetched.window);
        if (!options.dryRun) SyncState.save(state); // only after the window is fully applied
      }
      if (options.dryRun) repo.writeDryRun(preview);
    } catch (err) {
      summary.errors = String(err && err.stack || err);
      throw err;
    } finally {
      try {
        repo.updateLog(runId, {
          end: new Date(), scanned: summary.scanned, created: summary.created, updated: summary.updated,
          reviews: summary.reviews, errors: summary.errors.slice(0, 2000),
          checkpoint: state && state.lastCompletedEnd ? new Date(state.lastCompletedEnd).toISOString() +
            (options.dryRun ? ' (not saved: dry run)' : '') : ''
        });
      } catch (e) { Logger.log('Could not update Sync Log: ' + e); }
      lock.releaseLock();
    }
    Logger.log(JSON.stringify(summary));
    return summary;
  }

  function previewRow(x) {
    var d = x.decision, ext = x.ext;
    var change = '';
    if (d.action === 'CREATE') change = '(new) → ' + (StatusEngine.STATUS_FOR_EVENT[ext.eventType] || '');
    if (d.action === 'UPDATE' && d.result) change = d.result.note;
    return {
      messageId: ext.messageId, date: ext.emailDate, subject: ext.subject, action: d.action,
      appId: d.appId || (d.candidates || []).join(', '), company: ext.company, role: ext.role,
      term: ext.term || (ext.termsFound || []).join(' / '), eventType: ext.eventType,
      statusChange: change, reason: d.reason, link: ext.link
    };
  }

  return { run: run, applyPending: applyPending, previewRow: previewRow };
})();
