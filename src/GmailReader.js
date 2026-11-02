/**
 * GmailReader: read-only Gmail access through GmailApp.
 *
 * It never modifies, labels, archives, deletes, sends or marks messages read.
 * Gmail search (without "in:") covers all mail except Spam and Trash, so
 * archived messages are included and unread status doesn't matter.
 */
var GmailReader = (function () {
  /** Build the search query for [startMs, endMs). Pure. */
  function buildQuery(config, startMs, endMs) {
    var parts = config.searchPhrases.map(function (p) { return '"' + p.replace(/"/g, '') + '"'; });
    config.recruitingSenders.forEach(function (s) { parts.push('from:' + s); });
    if (config.includeLabel) parts.push('label:' + config.includeLabel.replace(/[\s/]+/g, '-'));
    return '(' + parts.join(' OR ') + ')' +
      ' after:' + Math.floor(startMs / 1000) + ' before:' + Math.floor(endMs / 1000);
  }

  function messageLink(messageId, config) {
    return 'https://mail.google.com/mail/u/' + config.gmailAccountIndex + '/#all/' + messageId;
  }

  /** Search threads. Returns GmailThread[] (max `max`). */
  function searchThreads(query, start, max) {
    return GmailApp.search(query, start, max);
  }

  /**
   * Convert threads to plain email objects. Includes every message in each
   * matched thread at or after `floorMs` (deduplication happens later).
   */
  function toEmails(threads, floorMs, config, myAddress) {
    if (!threads.length) return [];
    var perThread = GmailApp.getMessagesForThreads(threads);
    var out = [];
    threads.forEach(function (thread, i) {
      var labels = thread.getLabels().map(function (l) { return l.getName(); });
      perThread[i].forEach(function (msg) {
        if (msg.isInTrash() || msg.isDraft()) return;
        var date = msg.getDate();
        if (date.getTime() < floorMs) return;
        var from = msg.getFrom();
        var body = msg.getPlainBody();
        if (!body || !body.trim()) body = Util.htmlToText(msg.getBody());
        out.push({
          id: msg.getId(),
          threadId: thread.getId(),
          date: date,
          from: from,
          subject: msg.getSubject(),
          body: body.length > 20000 ? body.slice(0, 20000) : body,
          labels: labels,
          link: messageLink(msg.getId(), config),
          isFromMe: !!myAddress && Util.emailAddress(from) === myAddress
        });
      });
    });
    return out;
  }

  return { buildQuery: buildQuery, searchThreads: searchThreads, toEmails: toEmails, messageLink: messageLink };
})();
