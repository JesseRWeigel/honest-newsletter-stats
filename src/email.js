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
  const add = (m) => { if (!problems.includes(m)) problems.push(m); };

  // Anything that causes the mail client to fetch a remote resource when the message is
  // opened IS open tracking, whatever tag it hides behind. An independent review found four
  // vectors this audit passed as clean: a remote stylesheet, a CSS @import, an SVG <image>,
  // and a protocol-relative url(). Each one is a working open pixel.
  if (/<img\b/i.test(html)) {
    add('contains an <img> tag; remote images are open tracking by another name');
  }
  if (/<(script|iframe|object|embed|frame|applet)\b/i.test(html)) {
    add('contains an active content tag');
  }
  // A remote stylesheet fetches on open just as reliably as an image.
  if (/<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i.test(html)) {
    add('contains a <link> to a remote stylesheet, which fetches on open exactly like a pixel');
  }
  if (/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i.test(html)) {
    add('contains a CSS @import of a remote sheet, which fetches on open');
  }
  // Protocol-relative and quoted-or-not url(). The original pattern required an explicit
  // http scheme, so //tracker.example/x.png sailed through.
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
    add('contains a CSS remote url(), which fetches on open exactly like a pixel');
  }
  // Named individually rather than merged into one message: knowing WHICH vector fired is
  // what tells an author where to look in their template.
  if (/\bbackground\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
    add('contains a remote background attribute, which fetches on open');
  }
  if (/<(?:body|table|td|tr)\b[^>]*\b(?:src|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
    add('contains a remote resource attribute on a layout element, which fetches on open');
  }
  // SVG carries its own image and use elements, which reference remote hrefs.
  if (/<svg\b/i.test(html) && /<(?:image|use)\b[^>]*\b(?:xlink:)?href/i.test(html)) {
    add('contains an SVG <image> or <use> with an href, which fetches on open');
  }
  if (/<(?:video|audio|source)\b/i.test(html)) {
    add('contains a media element, which can fetch or preload on open');
  }
  return problems;
}

/**
 * Render and audit in one call, refusing to emit HTML that would track opens.
 *
 * renderIssue alone did not audit anything, and the `render` CLI path did not call the audit
 * either, so a body containing a tracking pixel rendered fine and exited 0. A guarantee that
 * depends on the caller remembering to check is not a guarantee.
 */
export function renderIssueAudited(options) {
  const html = renderIssue(options);
  const problems = auditRenderedEmail(html);
  if (problems.length && !options.allowTracking) {
    const err = new Error(
      'refusing to render: this body would track opens.\n  ' + problems.join('\n  ') +
      '\nRemove the remote resources, or pass allowTracking to render it anyway and lose ' +
      'the guarantee this project exists to make.');
    err.problems = problems;
    throw err;
  }
  return { html, problems };
}
