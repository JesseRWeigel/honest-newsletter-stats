import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { buildIssueReport, CAN_SEE, CANNOT_SEE } from '../src/report.js';
import { renderIndex, renderIssuePage } from '../src/dashboard.js';

function seeded(policy = { k: 5 }) {
  const store = new Store(':memory:', { policy });
  store.createIssue({ issueId: 'i1', title: 'Issue one', sentDay: '2026-07-01', recipientCount: 300 });
  store.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'Popular' });
  store.registerLink({ issueId: 'i1', linkId: 'b', targetUrl: 'https://example.org/b', label: 'Obscure' });
  for (let i = 0; i < 11; i += 1) store.recordClick('i1', 'a', '2026-07-01');
  store.recordClick('i1', 'b', '2026-07-01');
  return store;
}

test('the issue page states what the publisher cannot see, not only what it can', () => {
  const store = seeded();
  const html = renderIssuePage(store, buildIssueReport(store, 'i1'));
  assert.ok(html.includes('Not recorded, and not recoverable'), 'missing the inversion panel');
  for (const [question] of CANNOT_SEE) {
    assert.ok(html.includes(question.replace(/'/g, '&#39;')), `missing "${question}"`);
  }
  for (const [claim] of CAN_SEE) {
    assert.ok(html.includes(claim.replace(/'/g, '&#39;')), `missing "${claim}"`);
  }
  store.close();
});

test('the index renders the live schema so the no-identity claim is auditable', () => {
  const store = seeded();
  const html = renderIndex(store, [buildIssueReport(store, 'i1')]);
  assert.ok(html.includes('CREATE TABLE link_clicks'), 'schema not rendered');
  assert.ok(html.includes('day      TEXT NOT NULL'), 'schema body not rendered verbatim');
  assert.ok(html.includes('read live from the running database'));
  // The page must admit the residual leak rather than only advertising the good parts.
  assert.ok(/IP address and your user agent/.test(html), 'index does not disclose the IP leak');
  store.close();
});

test('a suppressed link renders as a threshold, never as zero', () => {
  const store = seeded();
  const html = renderIssuePage(store, buildIssueReport(store, 'i1'));
  assert.ok(html.includes('fewer than 5'), 'suppression not shown');
  assert.ok(html.includes('>11<'), 'published count missing');
  assert.ok(!/Obscure<\/td>[\s\S]{0,200}>0</.test(html), 'a suppressed link was rendered as zero');
  store.close();
});

test('the page tells the reader that clicks include machines', () => {
  const store = seeded();
  const html = renderIssuePage(store, buildIssueReport(store, 'i1'));
  assert.ok(html.includes('upper bound on people'), 'missing the bot inflation caveat');
  store.close();
});

test('hold mode and report mode describe their own storage honestly', () => {
  const reportStore = seeded();
  const reportHtml = renderIssuePage(reportStore, buildIssueReport(reportStore, 'i1'));
  assert.ok(reportHtml.includes('Anyone holding the database'),
    'report mode must admit that the database holds sub-threshold counts');
  reportStore.close();

  const holdStore = new Store(':memory:', { mode: 'hold', policy: { k: 5 } });
  holdStore.createIssue({ issueId: 'i1', title: 'x', sentDay: '2026-07-01', recipientCount: 10 });
  holdStore.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });
  holdStore.recordClick('i1', 'a', '2026-07-01');
  const holdHtml = renderIssuePage(holdStore, buildIssueReport(holdStore, 'i1'));
  assert.ok(holdHtml.includes('hold</strong> mode'), 'hold mode not disclosed on the page');
  holdStore.close();
});

test('rendered HTML escapes issue and link text', () => {
  const store = new Store(':memory:');
  store.createIssue({
    issueId: 'x1', title: '<script>alert(1)</script>', sentDay: '2026-07-01', recipientCount: 1,
  });
  store.registerLink({
    issueId: 'x1', linkId: 'a', targetUrl: 'https://example.org/a', label: '"><img src=x>',
  });
  const html = renderIssuePage(store, buildIssueReport(store, 'x1'));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'title was not escaped');
  assert.ok(!html.includes('<img src=x>'), 'label was not escaped');
  store.close();
});
