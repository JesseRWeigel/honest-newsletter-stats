import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { renderIssue, auditRenderedEmail, clickUrl } from '../src/email.js';

const BODY = `<p>Read the <a href="https://example.org/a">first thing</a> and the
<a href='https://example.org/b'>second thing</a>.</p>`;

function seeded() {
  const store = new Store(':memory:');
  store.createIssue({ issueId: 'i1', title: 'Issue one', sentDay: '2026-07-01', recipientCount: 300 });
  store.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });
  store.registerLink({ issueId: 'i1', linkId: 'b', targetUrl: 'https://example.org/b', label: 'B' });
  return store;
}

test('the rendered email is byte-identical for every recipient', () => {
  const store = seeded();
  const links = store.listLinks('i1');
  // renderIssue has no recipient parameter, so the only way to produce a per-recipient
  // difference would be to add one. Render repeatedly and compare bytes.
  const renders = Array.from({ length: 5 }, () => renderIssue({
    bodyHtml: BODY, issueId: 'i1', links, baseUrl: 'https://links.example.org',
  }));
  const first = Buffer.from(renders[0], 'utf8');
  for (const r of renders) {
    assert.ok(Buffer.from(r, 'utf8').equals(first), 'renders differ between recipients');
  }
  store.close();
});

test('links are rewritten to a shared redirect URL carrying no token', () => {
  const store = seeded();
  const html = renderIssue({
    bodyHtml: BODY, issueId: 'i1', links: store.listLinks('i1'), baseUrl: 'https://links.example.org',
  });
  assert.ok(html.includes('href="https://links.example.org/c/i1/a"'), html);
  assert.ok(html.includes('href="https://links.example.org/c/i1/b"'), html);
  assert.ok(!html.includes('href="https://example.org/a"'), 'original target left unrewritten');

  // Every href in the rendered mail must be a bare path with no query string and no
  // opaque path segment that could encode a recipient.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    const url = new URL(href);
    assert.equal(url.search, '', `href carries a query string: ${href}`);
    for (const segment of url.pathname.split('/').filter(Boolean)) {
      assert.ok(segment.length <= 32, `path segment looks like an opaque token: ${href}`);
      assert.ok(!/^[0-9a-f]{16,}$/i.test(segment), `path segment looks like a hash: ${href}`);
    }
  }
  store.close();
});

test('the audit rejects a tracking pixel and other on-open fetches', () => {
  assert.deepEqual(auditRenderedEmail('<p>hello</p>'), []);
  assert.match(auditRenderedEmail('<img src="https://t.example/p.gif?u=99">')[0], /img/);
  assert.match(auditRenderedEmail('<div style="background:url(https://t.example/p.png)"></div>')[0], /url\(\)/);
  assert.match(auditRenderedEmail('<td background="https://t.example/p.png"></td>')[0], /background/);
  assert.match(auditRenderedEmail('<script src="x"></script>')[0], /active content/);
});

test('the rendered email contains no image tag and no remote fetch of any kind', () => {
  const store = seeded();
  const html = renderIssue({
    bodyHtml: BODY, issueId: 'i1', links: store.listLinks('i1'), baseUrl: 'https://links.example.org',
  });
  assert.deepEqual(auditRenderedEmail(html), []);
  store.close();
});

test('an unregistered link is left alone rather than given an invented identifier', () => {
  const store = seeded();
  const body = `${BODY}<a href="https://elsewhere.example/z">untracked</a>`;
  const html = renderIssue({
    bodyHtml: body, issueId: 'i1', links: store.listLinks('i1'), baseUrl: 'https://links.example.org',
  });
  assert.ok(html.includes('href="https://elsewhere.example/z"'), 'unregistered link should be untouched');
  store.close();
});

test('clickUrl is a pure function of issue and link', () => {
  assert.equal(clickUrl('https://l.example', 'i1', 'a'), 'https://l.example/c/i1/a');
  assert.equal(clickUrl('https://l.example', 'i1', 'a'), clickUrl('https://l.example', 'i1', 'a'));
});
