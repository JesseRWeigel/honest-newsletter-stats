// Renders the email body: registered links rewritten to shared redirect URLs, plus the
// opt-in feedback footer.
//
// The load-bearing property here is that renderIssue takes no recipient argument. The
// rendered bytes are identical for every subscriber on the list, which is the structural
// reason no per-subscriber identity can be recovered from a click. test/email.test.js
// asserts byte equality across renders and asserts that no <img> tag is ever emitted.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** The shared, recipient-independent redirect URL for one link in one issue. */
export function clickUrl(baseUrl, issueId, linkId) {
  return new URL(`/c/${encodeURIComponent(issueId)}/${encodeURIComponent(linkId)}`, baseUrl).toString();
}

export function feedbackUrl(baseUrl, issueId, bucket) {
  return new URL(`/f/${encodeURIComponent(issueId)}/${encodeURIComponent(bucket)}`, baseUrl).toString();
}

const FEEDBACK_LABELS = {
  useful: 'This was useful',
  'not-useful': 'This was not useful',
  'too-long': 'Too long',
  'more-like-this': 'More like this',
};

export function renderFooter(baseUrl, issueId, buckets = Object.keys(FEEDBACK_LABELS)) {
  const items = buckets.map((b) => {
    const label = FEEDBACK_LABELS[b] ?? b;
    return `      <li><a href="${escapeHtml(feedbackUrl(baseUrl, issueId, b))}">${escapeHtml(label)}</a></li>`;
  }).join('\n');
  return [
    '  <hr>',
    '  <div class="feedback-footer">',
    '    <p>Optional feedback. Pressing one of these tells us only that <em>somebody</em>',
    '    pressed it, and the count is published on the public dashboard alongside this',
    '    issue. Nothing here identifies you. Ignoring it is the default and costs nothing.</p>',
    '    <ul>',
    items,
    '    </ul>',
    `    <p><a href="${escapeHtml(new URL('/', baseUrl).toString())}">See exactly what we can and cannot measure</a></p>`,
    '  </div>',
  ].join('\n');
}

/**
 * Rewrite every registered link in an HTML body to its shared redirect URL and append
 * the feedback footer.
 *
 * Links are matched by their target URL, so the body is authored with real destination
 * URLs and never with tracking tokens. An unregistered link is left exactly as authored,
 * which means it is not counted at all. That is the intended failure mode: an uncounted
 * link is better than an invented identifier.
 */
export function renderIssue({ bodyHtml, issueId, links, baseUrl, footer = true }) {
  let out = bodyHtml;
  for (const link of links) {
    const target = link.target_url ?? link.targetUrl;
    const id = link.link_id ?? link.linkId;
    const replacement = clickUrl(baseUrl, issueId, id);
    out = out.split(`href="${target}"`).join(`href="${replacement}"`);
    out = out.split(`href='${target}'`).join(`href="${replacement}"`);
  }
  if (footer) out = `${out}\n${renderFooter(baseUrl, issueId)}\n`;
  return out;
}

/**
 * Structural audit of a rendered email. Returns a list of problems, empty when clean.
 * Run this in the send pipeline, not only in tests, so a regression in a template cannot
 * quietly reintroduce a pixel.
 */
export function auditRenderedEmail(html) {
  const problems = [];
  if (/<img\b/i.test(html)) {
    problems.push('contains an <img> tag; remote images are open tracking by another name');
  }
  if (/<(script|iframe|object|embed)\b/i.test(html)) {
    problems.push('contains an active content tag');
  }
  if (/url\(\s*['"]?https?:/i.test(html)) {
    problems.push('contains a CSS remote url(), which fetches on open exactly like a pixel');
  }
  if (/background\s*=\s*["']https?:/i.test(html)) {
    problems.push('contains a remote background attribute, which fetches on open');
  }
  return problems;
}
