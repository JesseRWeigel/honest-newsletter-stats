import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store, SCHEMA_COLUMNS, utcDay } from '../src/store.js';
import { buildIssueReport } from '../src/report.js';

function seeded(options = {}) {
  const store = new Store(':memory:', options);
  store.createIssue({ issueId: 'i1', title: 'Issue one', sentDay: '2026-07-01', recipientCount: 300 });
  store.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });
  store.registerLink({ issueId: 'i1', linkId: 'b', targetUrl: 'https://example.org/b', label: 'B' });
  return store;
}

test('the live schema matches the declared column allowlist exactly', () => {
  // This is the guard that fails the moment anyone adds a subscriber_id, ip, session, or
  // clock-time column to any table.
  const store = new Store(':memory:');
  assert.deepEqual(store.liveColumns(), { ...SCHEMA_COLUMNS });
  store.close();
});

test('no table has a column whose name suggests per-person identity or clock time', () => {
  const store = new Store(':memory:');
  const banned = new Set([
    // 'recipient' is absent on purpose: issues.recipient_count is a headcount the
    // publisher already has from the mail provider, and it names no one.
    'subscriber', 'subscribers', 'user', 'person', 'email', 'ip', 'addr',
    'address', 'agent', 'ua', 'cookie', 'session', 'token', 'fingerprint', 'device',
    'time', 'timestamp', 'ts', 'hour', 'minute', 'second', 'hash', 'uuid', 'referer',
  ]);
  for (const [table, cols] of Object.entries(store.liveColumns())) {
    for (const col of cols) {
      for (const word of col.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
        assert.ok(!banned.has(word), `${table}.${col} looks like identity or clock time`);
      }
    }
  }
  store.close();
});

test('recordClick takes exactly three parameters and cannot be handed an identity', () => {
  const store = seeded();
  const signature = store.recordClick.toString().match(/^\s*recordClick\s*\(([^)]*)\)/)[1];
  assert.equal(signature.split(',').length, 3, `recordClick signature changed: (${signature})`);
  assert.ok(!/subscriber|recipient|ip|agent|token/i.test(signature), `suspicious parameter in (${signature})`);
  // Passing a fourth argument is silently ignored by JavaScript, which is the point:
  // there is no parameter for it to land in and no column for it to reach.
  store.recordClick('i1', 'a', '2026-07-01', 'subscriber-9f2a');
  const rows = store.db.prepare('SELECT * FROM link_clicks').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ issue_id: 'i1', link_id: 'a', day: '2026-07-01', count: 1 }]);
  store.close();
});

test('clicks aggregate per link and per day', () => {
  const store = seeded();
  for (let i = 0; i < 7; i += 1) store.recordClick('i1', 'a', '2026-07-01');
  for (let i = 0; i < 3; i += 1) store.recordClick('i1', 'a', '2026-07-02');
  store.recordClick('i1', 'b', '2026-07-02');
  assert.deepEqual(store.linkTotals('i1').map((r) => [r.link_id, r.count]), [['a', 10], ['b', 1]]);
  assert.deepEqual(store.dailyTotals('i1'), [
    { day: '2026-07-01', count: 7 }, { day: '2026-07-02', count: 4 },
  ]);
  store.close();
});

test('an unregistered link is refused, so the redirect cannot be used as an open redirect', () => {
  const store = seeded();
  assert.throws(() => store.recordClick('i1', 'nope', '2026-07-01'), RangeError);
  assert.equal(store.getLinkTarget('i1', 'nope'), null);
  assert.throws(() => store.registerLink({
    issueId: 'i1', linkId: 'js', targetUrl: 'javascript:alert(1)', label: 'x',
  }), TypeError);
  store.close();
});

test('malformed ids and days are rejected rather than written', () => {
  const store = seeded();
  assert.throws(() => store.recordClick('i1', 'a', '2026-7-1'), TypeError);
  assert.throws(() => store.recordClick('i1', 'a', '2026-07-01T12:34:56Z'), TypeError);
  assert.throws(() => store.recordClick("i1'; DROP TABLE link_clicks; --", 'a', '2026-07-01'), TypeError);
  store.close();
});

test('the report suppresses a link under the threshold and publishes one over it', () => {
  const store = seeded({ policy: { k: 5 } });
  for (let i = 0; i < 6; i += 1) store.recordClick('i1', 'a', '2026-07-01');
  for (let i = 0; i < 4; i += 1) store.recordClick('i1', 'b', '2026-07-01');
  const report = buildIssueReport(store, 'i1');
  const byId = Object.fromEntries(report.links.map((l) => [l.link_id, l.published]));
  assert.equal(byId.a.value, 6);
  assert.equal(byId.b.suppressed, true);
  assert.equal(byId.b.value, null);
  assert.equal(report.suppressedLinkCount, 1);
  // The raw sub-threshold count must not appear anywhere in the serialized report.
  assert.ok(!JSON.stringify(report).includes('"count":4'), 'raw sub-threshold count leaked into the report');
  store.close();
});

test('hold mode keeps sub-threshold clicks out of the database entirely', () => {
  const store = seeded({ mode: 'hold', policy: { k: 5 } });
  for (let i = 0; i < 4; i += 1) store.recordClick('i1', 'a', '2026-07-01');

  const clickRows = store.db.prepare('SELECT * FROM link_clicks').all().map((r) => ({ ...r }));
  assert.deepEqual(clickRows, [], 'a link under k must have no row at all in link_clicks');
  assert.equal(store.heldTotal('i1'), 4, 'held clicks are counted without their link identity');
  const held = store.db.prepare('SELECT * FROM held_totals').all().map((r) => ({ ...r }));
  assert.deepEqual(held, [{ issue_id: 'i1', day: '2026-07-01', count: 4 }]);
  assert.ok(!JSON.stringify(held).includes('"a"'), 'held rows must not name the link');
  store.close();
});

test('hold mode releases the full history once the link crosses k, without double counting', () => {
  const store = seeded({ mode: 'hold', policy: { k: 5 } });
  for (let i = 0; i < 3; i += 1) assert.equal(store.recordClick('i1', 'a', '2026-07-01'), 'held');
  assert.equal(store.recordClick('i1', 'a', '2026-07-02'), 'held');
  assert.equal(store.recordClick('i1', 'a', '2026-07-02'), 'released');

  assert.deepEqual(store.linkTotals('i1').map((r) => [r.link_id, r.count]), [['a', 5], ['b', 0]]);
  assert.deepEqual(store.dailyTotals('i1'), [
    { day: '2026-07-01', count: 3 }, { day: '2026-07-02', count: 2 },
  ]);
  assert.equal(store.heldTotal('i1'), 0, 'released clicks must be removed from the held total');

  // Subsequent clicks write through directly.
  assert.equal(store.recordClick('i1', 'a', '2026-07-02'), 'released');
  assert.equal(store.dailyTotals('i1').reduce((a, r) => a + r.count, 0), 6);
  store.close();
});

test('hold mode released state survives reopening the same database file', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hns-'));
  const file = path.join(dir, 'stats.db');
  try {
    const a = new Store(file, { mode: 'hold', policy: { k: 3 } });
    a.createIssue({ issueId: 'i1', title: 'x', sentDay: '2026-07-01', recipientCount: 10 });
    a.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });
    for (let i = 0; i < 3; i += 1) a.recordClick('i1', 'a', '2026-07-01');
    a.close();

    const b = new Store(file, { mode: 'hold', policy: { k: 3 } });
    assert.equal(b.recordClick('i1', 'a', '2026-07-01'), 'released',
      'a link already over k must keep writing through after a restart');
    assert.equal(b.linkTotals('i1')[0].count, 4);
    b.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('feedback buckets are a closed vocabulary', () => {
  const store = seeded();
  store.recordFeedback('i1', 'useful', '2026-07-01');
  assert.throws(() => store.recordFeedback('i1', 'clicked-from-gmail', '2026-07-01'), RangeError);
  assert.equal(store.feedbackTotals('i1').find((f) => f.bucket === 'useful').count, 1);
  store.close();
});

test('utcDay keeps date granularity only', () => {
  assert.equal(utcDay(Date.UTC(2026, 6, 1, 23, 59, 59)), '2026-07-01');
  assert.equal(utcDay(Date.UTC(2026, 6, 2, 0, 0, 1)), '2026-07-02');
  assert.match(utcDay(), /^\d{4}-\d{2}-\d{2}$/);
});

test('reopening under a higher k holds instead of releasing', async () => {
  // The leak: `released` was seeded from every link with any historical click row, without
  // comparing to the k in force now. A database written in report mode came back with every
  // link released, so hold mode wrote each new sub-threshold click straight through.
  const dir = mkdtempSync(join(tmpdir(), 'hns-k-'));
  const dbPath = join(dir, 'stats.db');

  let s = new Store(dbPath, { mode: 'report', k: 5 });
  s.createIssue({ issueId: 'i1', title: 't', sentDay: '2026-07-26', recipientCount: 100 });
  s.registerLink({ issueId: 'i1', linkId: 'l1', targetUrl: 'https://e.com', label: 'x' });
  assert.equal(s.recordClick('i1', 'l1', '2026-07-26'), 'counted');
  s.close();

  s = new Store(dbPath, { mode: 'hold', k: 10 });
  assert.equal(s.recordClick('i1', 'l1', '2026-07-26'), 'held',
    'a link below the ACTIVE k must be held, whatever mode wrote the earlier rows');
  assert.equal(s.heldTotal('i1'), 1, 'the pre-existing count must be carried into held');
  s.close();
});

test('a link already above the active k stays released', async () => {
  // The fix must not break the normal path: real crossings still write through.
  const dir = mkdtempSync(join(tmpdir(), 'hns-k2-'));
  const dbPath = join(dir, 'stats.db');
  let s = new Store(dbPath, { mode: 'report', k: 2 });
  s.createIssue({ issueId: 'i1', title: 't', sentDay: '2026-07-26', recipientCount: 100 });
  s.registerLink({ issueId: 'i1', linkId: 'l1', targetUrl: 'https://e.com', label: 'x' });
  for (let i = 0; i < 4; i += 1) s.recordClick('i1', 'l1', '2026-07-26');
  s.close();

  s = new Store(dbPath, { mode: 'hold', k: 3 });
  assert.equal(s.recordClick('i1', 'l1', '2026-07-26'), 'released',
    'four stored clicks is above k=3, so this link is genuinely released');
  s.close();
});
