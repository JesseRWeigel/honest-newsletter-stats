// The redirect and dashboard server.
//
// Rules this file holds to, and which test/no-identity.test.js checks by sending
// deliberately distinctive headers and then scanning every byte the process wrote:
//
//   1. req.socket.remoteAddress is never read.
//   2. req.headers is never read at all. No user agent, no cookie, no forwarded-for,
//      no accept-language, no referer.
//   3. Nothing is written to stdout per request. There is no access log, because an
//      access log is a per-subscriber identity store with a different name.
//   4. Redirect targets come from the links table, never from the query string, so this
//      cannot be used as an open redirect.
//
// If you deploy this behind nginx, Cloudflare, or a platform edge, those layers keep
// their own request logs and rules 1 to 3 stop being true for the system as a whole.
// That is the single most important operational caveat in the threat model.

import http from 'node:http';
import { Store, FEEDBACK_BUCKETS, utcDay } from './store.js';
import { buildIssueReport } from './report.js';
import {
  renderIndex, renderIssuePage, renderFeedbackConfirm, renderThanks, renderError,
} from './dashboard.js';

const HTML = { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' };
const JSON_H = { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' };
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'referrer-policy': 'no-referrer' };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * @param {Store} store
 * @param {object} options
 * @param {() => string} options.today  injectable UTC day source, for tests
 */
export function createServer(store, { today = () => utcDay() } = {}) {
  return http.createServer((req, res) => {
    // Only the path is parsed. The Host header is used to build a syntactically valid
    // URL and is then discarded; nothing downstream reads it.
    let path;
    try {
      path = decodeURI(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, TEXT, 'bad request');
    }
    const parts = path.split('/').filter(Boolean);

    try {
      if (req.method === 'GET' && parts.length === 0) {
        const reports = store.listIssues()
          .map((i) => buildIssueReport(store, i.issue_id))
          .filter(Boolean);
        return send(res, 200, HTML, renderIndex(store, reports));
      }

      if (req.method === 'GET' && parts[0] === 'i' && parts.length === 2) {
        const report = buildIssueReport(store, parts[1]);
        if (!report) return send(res, 404, HTML, renderError(404, 'No such issue.'));
        return send(res, 200, HTML, renderIssuePage(store, report));
      }

      // The click redirect. Identical URL for every recipient of the issue.
      if (req.method === 'GET' && parts[0] === 'c' && parts.length === 3) {
        const [, issueId, linkId] = parts;
        if (!ID.test(issueId) || !ID.test(linkId)) {
          return send(res, 404, HTML, renderError(404, 'No such link.'));
        }
        const target = store.getLinkTarget(issueId, linkId);
        if (!target) return send(res, 404, HTML, renderError(404, 'No such link.'));
        store.recordClick(issueId, linkId, today());
        return send(res, 302, {
          location: target,
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
          ...TEXT,
        }, `Redirecting to ${target}`);
      }

      // Feedback is two steps on purpose. A GET only renders a confirmation page, so a
      // mail scanner that follows every link in the email records nothing.
      if (parts[0] === 'f' && parts.length === 3) {
        const [, issueId, bucket] = parts;
        if (!ID.test(issueId) || !FEEDBACK_BUCKETS.includes(bucket) || !store.getIssue(issueId)) {
          return send(res, 404, HTML, renderError(404, 'No such feedback link.'));
        }
        if (req.method === 'GET') {
          return send(res, 200, HTML, renderFeedbackConfirm(issueId, bucket));
        }
        if (req.method === 'POST') {
          req.resume(); // drain without reading; the body is not needed and not stored
          req.on('end', () => {
            store.recordFeedback(issueId, bucket, today());
            send(res, 200, HTML, renderThanks(issueId));
          });
          return undefined;
        }
        return send(res, 405, TEXT, 'method not allowed');
      }

      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'schema') {
        return send(res, 200, JSON_H, JSON.stringify({
          schemaSql: store.schemaText(),
          columns: store.liveColumns(),
        }, null, 2));
      }

      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'stats') {
        if (parts.length === 2) {
          return send(res, 200, JSON_H, JSON.stringify(
            store.listIssues().map((i) => buildIssueReport(store, i.issue_id)), null, 2));
        }
        const report = buildIssueReport(store, parts[2]);
        if (!report) return send(res, 404, JSON_H, JSON.stringify({ error: 'no such issue' }));
        return send(res, 200, JSON_H, JSON.stringify(report, null, 2));
      }

      return send(res, 404, HTML, renderError(404, 'Nothing here.'));
    } catch {
      // The message is deliberately generic. An error string built from request input is
      // a way for request content to end up in a log file.
      return send(res, 500, HTML, renderError(500, 'Something went wrong handling that request.'));
    }
  });
}

export function startServer({ db = 'stats.db', port = 8787, mode = 'report', policy } = {}) {
  const store = new Store(db, { mode, ...(policy ? { policy } : {}) });
  const server = createServer(store);
  server.listen(port);
  return { server, store };
}
