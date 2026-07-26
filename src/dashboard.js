// The public dashboard. Two panels: the numbers, and the questions the numbers cannot
// answer. The schema is rendered live from the database so a reader can check the claim
// "there is no subscriber column" against the running system rather than against a
// promise in a README.

import { describeCell } from './policy.js';
import { escapeHtml } from './email.js';
import { CAN_SEE, CANNOT_SEE } from './report.js';

const CSS = `
:root { color-scheme: light dark; --fg:#111; --muted:#555; --line:#d8d8d8; --bg:#fff; --accent:#0b5; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --muted:#a0a0a0; --line:#333; --bg:#111; --accent:#3d9; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1rem 4rem; background:var(--bg); color:var(--fg);
  font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; }
p.lede { color: var(--muted); margin-top:0; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight:600; }
td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.suppressed { color: var(--muted); font-style: italic; }
.panels { display: grid; gap: 1.5rem; grid-template-columns: 1fr; }
@media (min-width: 56rem) { .panels { grid-template-columns: 1fr 1fr; } }
.panel { border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; }
.panel h3 { margin: 0 0 .5rem; font-size: 1rem; }
.panel dt { font-weight: 600; margin-top: .8rem; }
.panel dd { margin: .15rem 0 0; color: var(--muted); font-size: .92rem; }
.panel.can { border-left: 4px solid var(--accent); }
.panel.cannot { border-left: 4px solid #c33; }
pre { overflow-x: auto; background: rgba(127,127,127,.12); padding: .9rem; border-radius: 6px;
  font-size: .82rem; line-height: 1.45; }
.note { border-left: 4px solid #c93; padding: .6rem .9rem; background: rgba(200,150,50,.10);
  border-radius: 0 6px 6px 0; margin: 1rem 0; font-size: .93rem; }
a { color: inherit; }
footer { margin-top: 3rem; color: var(--muted); font-size: .88rem; }
`;

function cell(published) {
  const text = escapeHtml(describeCell(published));
  return published.suppressed
    ? `<td class="n suppressed">${text}</td>`
    : `<td class="n">${text}</td>`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body><main>
${body}
<footer>
  <p>Served by <a href="https://github.com/JesseRWeigel/honest-newsletter-stats">honest-newsletter-stats</a>.
  The threat model, including the leaks this design does <em>not</em> close, is published with the code.</p>
</footer>
</main></body></html>`;
}

export function renderIndex(store, reports) {
  const rows = reports.map((r) => `
    <tr>
      <td><a href="/i/${escapeHtml(r.issue.issueId)}">${escapeHtml(r.issue.title)}</a></td>
      <td>${escapeHtml(r.issue.sentDay)}</td>
      <td class="n">${r.issue.recipientCount}</td>
      ${cell(r.totalClicks)}
    </tr>`).join('');

  return page('Newsletter stats, honestly', `
<h1>Newsletter stats, honestly</h1>
<p class="lede">No tracking pixels. No per-subscriber link wrappers. Counts only, published
with a threshold, and this page says out loud what the publisher cannot see.</p>

<table>
  <thead><tr><th>Issue</th><th>Sent</th><th class="n">Recipients</th><th class="n">Clicks</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">No issues yet.</td></tr>'}</tbody>
</table>

${panels()}

<h2>The schema, read live from the running database</h2>
<p class="lede">Not a copy in the documentation. This is what the process is writing to
right now. Check it for a column that could hold a subscriber, an IP address, or a clock
time finer than one day.</p>
<pre>${escapeHtml(store.schemaText())}</pre>

<div class="note"><strong>What this design still leaks.</strong> The redirect endpoint
receives your IP address and your user agent in the HTTP request itself, the same way any
web server does. This code never reads them into a variable and never writes them down,
but they exist in transit, and whoever runs the server could change that. Read the threat
model before trusting this page.</div>
`);
}

function panels(canSee, cannotSee) {
  const can = (canSee ?? CAN_SEE).map(([q, why]) =>
    `<dt>${escapeHtml(q)}</dt><dd>${escapeHtml(why)}</dd>`).join('\n');
  const cannot = (cannotSee ?? CANNOT_SEE).map(([q, why]) =>
    `<dt>${escapeHtml(q)}</dt><dd>${escapeHtml(why)}</dd>`).join('\n');
  return `
<h2>What the publisher can and cannot see</h2>
<div class="panels">
  <div class="panel can"><h3>Recorded</h3><dl>${can}</dl></div>
  <div class="panel cannot"><h3>Not recorded, and not recoverable</h3><dl>${cannot}</dl></div>
</div>`;
}

export function renderIssuePage(store, report) {
  const { issue, policy } = report;

  const linkRows = report.links.map((l) => `
    <tr>
      <td>${escapeHtml(l.label)}</td>
      <td><a href="${escapeHtml(l.target_url)}" rel="noreferrer">${escapeHtml(l.target_url)}</a></td>
      ${cell(l.published)}
    </tr>`).join('');

  const dayRows = report.daily.map((d) => `
    <tr><td>${escapeHtml(d.day)}</td>${cell(d.published)}</tr>`).join('');

  const fbRows = report.feedback.map((f) => `
    <tr><td>${escapeHtml(f.bucket)}</td>${cell(f.published)}</tr>`).join('');

  const heldNote = report.heldBelowThreshold
    ? `<p class="lede">Running in <strong>hold</strong> mode. Clicks on links that have not
       reached the threshold are stored only as a per-day total with the link identity
       discarded, so the database file itself does not record which link they were on.
       Currently held: ${escapeHtml(describeCell(report.heldBelowThreshold))}.</p>`
    : `<p class="lede">Running in <strong>report</strong> mode. Exact per-link counts are
       stored and the threshold is applied when publishing. Anyone holding the database
       file sees the counts below the threshold; see the threat model.</p>`;

  return page(`${issue.title} stats`, `
<h1>${escapeHtml(issue.title)}</h1>
<p class="lede">Sent ${escapeHtml(issue.sentDay)} to ${issue.recipientCount} recipients.
Threshold k = ${policy.k}${policy.quantize > 1 ? `, counts rounded down to a multiple of ${policy.quantize}` : ''}.
${report.suppressedLinkCount} link${report.suppressedLinkCount === 1 ? '' : 's'} withheld for being under the threshold.</p>
${heldNote}

<h2>Links</h2>
<table>
  <thead><tr><th>Label</th><th>Destination</th><th class="n">Clicks</th></tr></thead>
  <tbody>${linkRows || '<tr><td colspan="3">No links registered.</td></tr>'}</tbody>
</table>

<h2>Clicks per day, all links combined</h2>
<table>
  <thead><tr><th>Day (UTC)</th><th class="n">Clicks</th></tr></thead>
  <tbody>${dayRows || '<tr><td colspan="2">Nothing recorded yet.</td></tr>'}</tbody>
</table>

<h2>Opt-in feedback footer</h2>
<table>
  <thead><tr><th>Response</th><th class="n">Count</th></tr></thead>
  <tbody>${fbRows}</tbody>
</table>

${panels(report.canSee, report.cannotSee)}

<div class="note"><strong>Clicks are an upper bound on people.</strong> Corporate mail
scanners and link previewers fetch URLs without a human involved. Filtering them out would
mean inspecting the user agent, which this system refuses to do, so the counts above
include machines. A count of 40 does not mean 40 readers.</div>

<p><a href="/">All issues</a> &middot; <a href="/api/stats/${escapeHtml(issue.issueId)}">JSON</a>
&middot; <a href="/api/schema">Schema</a></p>
`);
}

export function renderFeedbackConfirm(issueId, bucket) {
  return page('Confirm feedback', `
<h1>Send this feedback?</h1>
<p class="lede">One more press. This second step exists so that mail scanners and link
previewers, which follow every link in an email automatically, cannot vote on your behalf.</p>
<form method="POST" action="/f/${escapeHtml(issueId)}/${escapeHtml(bucket)}">
  <p>You are about to record: <strong>${escapeHtml(bucket)}</strong> on issue
  <strong>${escapeHtml(issueId)}</strong>.</p>
  <p>What gets stored is one increment to a counter. No identifier of you is created,
  transmitted, or saved.</p>
  <p><button type="submit">Send it</button></p>
</form>
<p><a href="/i/${escapeHtml(issueId)}">See the published counts instead</a></p>
`);
}

export function renderThanks(issueId) {
  return page('Recorded', `
<h1>Recorded</h1>
<p class="lede">A counter went up by one. That is the entire record of this action.</p>
<p><a href="/i/${escapeHtml(issueId)}">See the published counts</a></p>
`);
}

export function renderError(status, message) {
  return page(`${status}`, `<h1>${status}</h1><p class="lede">${escapeHtml(message)}</p>
<p><a href="/">All issues</a></p>`);
}
