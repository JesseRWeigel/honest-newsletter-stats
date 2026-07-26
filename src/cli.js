#!/usr/bin/env node
// Command line entry point.
//
//   node src/cli.js demo [--db path] [--mode report|hold] [--k 5]
//       Builds a small demo database, renders the email for it, prints the audit result.
//   node src/cli.js serve [--db path] [--port 8787] [--mode report|hold] [--k 5]
//   node src/cli.js render --db path --issue ID --base URL
//       Prints the email HTML that would be sent, identical for every recipient.
//   node src/cli.js stats --db path --issue ID
//       Prints the published report as JSON, threshold already applied.

import { Store, utcDay } from './store.js';
import { renderIssue, auditRenderedEmail } from './email.js';
import { buildIssueReport } from './report.js';
import { startServer } from './server.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const DEMO_BODY = `<h1>Issue 12: what we shipped</h1>
<p>The redirect layer is live. Read the
<a href="https://example.org/threat-model">threat model</a> first, then the
<a href="https://example.org/changelog">changelog</a>.</p>
<p>One of these is deliberately obscure so you can watch the threshold suppress it:
<a href="https://example.org/deep-cut">the deep cut</a>.</p>`;

const DEMO_LINKS = [
  { linkId: 'threat-model', targetUrl: 'https://example.org/threat-model', label: 'Threat model' },
  { linkId: 'changelog', targetUrl: 'https://example.org/changelog', label: 'Changelog' },
  { linkId: 'deep-cut', targetUrl: 'https://example.org/deep-cut', label: 'The deep cut' },
];

export function seedDemo(store, { issueId = 'issue-12' } = {}) {
  store.createIssue({
    issueId,
    title: 'Issue 12: what we shipped',
    sentDay: utcDay(),
    recipientCount: 412,
  });
  for (const l of DEMO_LINKS) store.registerLink({ issueId, ...l });

  const today = utcDay();
  const yesterday = utcDay(Date.now() - 86_400_000);
  for (let i = 0; i < 9; i += 1) store.recordClick(issueId, 'threat-model', i < 5 ? yesterday : today);
  for (let i = 0; i < 6; i += 1) store.recordClick(issueId, 'changelog', today);
  // Left under the default threshold on purpose, so the dashboard shows suppression.
  for (let i = 0; i < 2; i += 1) store.recordClick(issueId, 'deep-cut', today);
  for (let i = 0; i < 7; i += 1) store.recordFeedback(issueId, 'useful', today);
  for (let i = 0; i < 5; i += 1) store.recordFeedback(issueId, 'more-like-this', today);
  store.recordFeedback(issueId, 'too-long', today);
  return issueId;
}

function openStore(args) {
  const policy = args.k ? { k: Number(args.k) } : undefined;
  return new Store(args.db ?? 'stats.db', {
    mode: args.mode ?? 'report',
    ...(policy ? { policy } : {}),
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'demo';

  if (cmd === 'demo') {
    const store = openStore({ ...args, db: args.db ?? ':memory:' });
    const issueId = seedDemo(store);
    const base = args.base ?? 'https://links.example.org';
    const html = renderIssue({
      bodyHtml: DEMO_BODY,
      issueId,
      links: store.listLinks(issueId),
      baseUrl: base,
    });
    const problems = auditRenderedEmail(html);
    process.stdout.write(`${html}\n`);
    process.stdout.write(`\n--- email audit: ${problems.length ? problems.join('; ') : 'clean, no pixel, no remote fetch, no per-recipient token'}\n`);
    process.stdout.write(`--- published report (k=${store.policy.k}, mode=${store.mode}):\n`);
    process.stdout.write(`${JSON.stringify(buildIssueReport(store, issueId), null, 2)}\n`);
    store.close();
    return;
  }

  if (cmd === 'serve') {
    const { store } = startServer({
      db: args.db ?? 'stats.db',
      port: Number(args.port ?? 8787),
      mode: args.mode ?? 'report',
      ...(args.k ? { policy: { k: Number(args.k) } } : {}),
    });
    if (args.seed) seedDemo(store);
    process.stdout.write(`listening on http://localhost:${args.port ?? 8787} (mode=${store.mode}, k=${store.policy.k})\n`);
    return;
  }

  if (cmd === 'render') {
    const store = openStore(args);
    const issueId = args.issue;
    const html = renderIssue({
      bodyHtml: args.body ?? DEMO_BODY,
      issueId,
      links: store.listLinks(issueId),
      baseUrl: args.base ?? 'https://links.example.org',
    });
    process.stdout.write(`${html}\n`);
    store.close();
    return;
  }

  if (cmd === 'stats') {
    const store = openStore(args);
    const report = buildIssueReport(store, args.issue);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    store.close();
    return;
  }

  process.stderr.write('usage: cli.js <demo|serve|render|stats> [--db path] [--issue id] [--mode report|hold] [--k n] [--port n]\n');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
