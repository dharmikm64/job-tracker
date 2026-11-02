/**
 * ApplicationMatcher: decides which existing application (if any) an
 * extraction belongs to. Pure JavaScript.
 *
 * Order of evidence:
 *  1. Same company + same requisition ID.
 *  2. A thread already linked to an application, if details are consistent.
 *  3. Company + role (+ term, location to narrow) with exactly one candidate.
 *
 * Result: { type: 'MATCH'|'NONE'|'AMBIGUOUS'|'CONFLICT', appId, method, candidates, reason }
 */
var ApplicationMatcher = (function () {
  function result(type, extra) {
    var r = { type: type, appId: '', method: '', candidates: [], reason: '' };
    Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
    return r;
  }

  /** Lists fields where the extraction and the app disagree (both known). */
  function differences(app, ext) {
    var diffs = [];
    if (ext.company && app.company && Util.companyKey(ext.company) !== Util.companyKey(app.company)) diffs.push('company');
    if (ext.role && app.role && Util.roleKey(ext.role) !== Util.roleKey(app.role)) diffs.push('role');
    if (ext.term && app.term && !Util.sameTerm(ext.term, app.term)) diffs.push('term');
    if (ext.reqId && app.reqId && Util.reqKey(ext.reqId) !== Util.reqKey(app.reqId)) diffs.push('reqId');
    return diffs;
  }

  function ids(apps) { return apps.map(function (a) { return a.id; }); }

  function match(ext, apps, options) {
    options = options || {};
    var ck = Util.companyKey(ext.company);
    var rk = Util.roleKey(ext.role);

    // 1. Company + requisition ID.
    if (ck && ext.reqId) {
      var rq = Util.reqKey(ext.reqId);
      var reqHits = apps.filter(function (a) {
        return Util.companyKey(a.company) === ck && a.reqId && Util.reqKey(a.reqId) === rq;
      });
      if (reqHits.length === 1) {
        var d = differences(reqHits[0], ext);
        if (d.length) return result('CONFLICT', { appId: reqHits[0].id, candidates: ids(reqHits), reason: 'Same requisition ID but different ' + d.join(', ') });
        return result('MATCH', { appId: reqHits[0].id, method: 'company+reqId' });
      }
      if (reqHits.length > 1) return result('AMBIGUOUS', { candidates: ids(reqHits), reason: 'Several applications share this requisition ID' });
    }

    // 2. Previously linked thread.
    var threadHits = apps.filter(function (a) { return (a.threadIds || []).indexOf(ext.threadId) !== -1; });
    if (threadHits.length) {
      var consistent = threadHits.filter(function (a) { return differences(a, ext).length === 0; });
      if (consistent.length === 1) {
        if (threadHits.length === 1 || ext.role || ext.reqId) {
          return result('MATCH', { appId: consistent[0].id, method: 'thread' });
        }
      }
      if (consistent.length > 1 && !rk && !ext.reqId) {
        return result('AMBIGUOUS', { candidates: ids(consistent), reason: 'Thread is linked to several applications and the email names no role' });
      }
      if (consistent.length === 0) {
        // Only a *role* difference at the same company is evidence of a new,
        // separate application (Gmail can thread look-alike confirmations).
        var hard = threadHits.filter(function (a) {
          var d = differences(a, ext);
          return d.indexOf('company') !== -1 || d.indexOf('term') !== -1 || (d.indexOf('role') === -1 && d.length);
        });
        if (hard.length) {
          return result('CONFLICT', { appId: hard[0].id, candidates: ids(hard), reason: 'Linked thread disagrees on ' + differences(hard[0], ext).join(', ') });
        }
      }
    }

    // 3. Company + role/term/location.
    if (!ck) return result('NONE', { reason: 'Company not identified' });
    var pool = apps.filter(function (a) { return Util.companyKey(a.company) === ck; });
    if (ext.reqId) pool = pool.filter(function (a) { return !a.reqId; }); // different req IDs = different roles
    if (ext.term) pool = pool.filter(function (a) { return !a.term || Util.sameTerm(a.term, ext.term); });

    if (rk) {
      pool = pool.filter(function (a) { return Util.roleKey(a.role) === rk; });
    } else if (pool.length && !options.allowCompanyOnlyMatch) {
      return result('AMBIGUOUS', { candidates: ids(pool), reason: 'Email names the company but not the role' });
    } else if (pool.length > 1) {
      return result('AMBIGUOUS', { candidates: ids(pool), reason: 'Several applications at this company and no role in the email' });
    }

    if (pool.length > 1 && ext.location) {
      var byLoc = pool.filter(function (a) { return a.location && Util.collapse(a.location).toLowerCase() === Util.collapse(ext.location).toLowerCase(); });
      if (byLoc.length === 1) pool = byLoc;
    }
    if (pool.length === 1) return result('MATCH', { appId: pool[0].id, method: rk ? 'company+role' : 'company-only' });
    if (pool.length > 1) return result('AMBIGUOUS', { candidates: ids(pool), reason: 'Several applications match company and role' });
    return result('NONE', { reason: 'No existing application matches' });
  }

  return { match: match, differences: differences };
})();
