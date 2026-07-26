// The test that this whole project exists to pass.
//
// It runs a realistic send-and-click flow through the real HTTP server, where every
// simulated subscriber carries a canary: a distinctive id in headers a normal analytics
// stack would happily record, a unique source port, a unique cookie, a unique user agent.
// Afterwards it scans every byte the process persisted, plus every byte the process was
// willing to hand back over HTTP, for any canary.
//
// If a subscriber identifier ever reaches the click table, or the WAL, or a log file, or
// the JSON API, this test fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, SCHEMA_COLUMNS } from '../src/store.js';
import { createServer } from '../src/server.js';
import { buildIssueReport } from '../src/report.js';

const SUBSCRIBERS = Array.from({ length: 12 }, (_, i) => ({
  id: `SUBSCRIBER-CANARY-${String(i).padStart(4, '0')}`,
  email: `canary${i}@example.invalid`,
  ua: `Mozilla/5.0 (CanaryClient/${i}.0)`,
  ip: `203.0.113.${i + 10}`,
  cookie: `sid=CANARY-SESSION-${i}`,
}));

function canaryStrings() {
  return SUBSCRIBERS.flatMap((s) => [s.id, s.email, s.ua, s.ip, s.cookie, `CanaryClient/${s.id}`])
    .concat(['CANARY-SESSION', 'canary', 'CanaryClient', '203.0.113.']);
}

function request(port, method, urlPath, subscriber, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        // Everything a conventional analytics pipeline would grab.
        'user-agent': subscriber.ua,
        cookie: subscriber.cookie,
        'x-forwarded-for': subscriber.ip,
        'x-subscriber-id': subscriber.id,
        'x-real-ip': subscriber.ip,
        from: subscriber.email,
        referer: `https://mail.example.invalid/read/${subscriber.id}`,
        'accept-language': 'en-CA,fr-CA;q=0.7',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function readAllBytes(dir) {
  const names = await readdir(dir);
  const parts = [];
  for (const name of names) {
    parts.push(Buffer.from(`\n=== ${name} ===\n`, 'utf8'));
    parts.push(await readFile(path.join(dir, name)));
  }
  return { names, bytes: Buffer.concat(parts) };
}

test('no subscriber identifier survives an end-to-end send, click, and feedback flow', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hns-leak-'));
  const dbPath = path.join(dir, 'stats.db');
  const store = new Store(dbPath, { policy: { k: 5 } });
  const server = createServer(store, { today: () => '2026-07-20' });
  const port = await listen(server);

  t.after(async () => {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  store.createIssue({ issueId: 'i1', title: 'Issue one', sentDay: '2026-07-20', recipientCount: 412 });
  for (const linkId of ['a', 'b', 'c']) {
    store.registerLink({ issueId: 'i1', linkId, targetUrl: `https://example.org/${linkId}`, label: linkId });
  }

  // Every subscriber clicks link a. Six click b. One clicks c, the classic deanonymizing
  // case: an audience of one on an obscure link.
  const responses = [];
  for (const s of SUBSCRIBERS) responses.push(await request(port, 'GET', '/c/i1/a', s));
  for (const s of SUBSCRIBERS.slice(0, 6)) responses.push(await request(port, 'GET', '/c/i1/b', s));
  responses.push(await request(port, 'GET', '/c/i1/c', SUBSCRIBERS[3]));

  // Feedback: the GET must not count, only the confirming POST.
  for (const s of SUBSCRIBERS) responses.push(await request(port, 'GET', '/f/i1/useful', s));
  for (const s of SUBSCRIBERS.slice(0, 7)) {
    responses.push(await request(port, 'POST', '/f/i1/useful', s, 'confirm=1'));
  }

  // And a dashboard read, plus both API surfaces.
  responses.push(await request(port, 'GET', '/', SUBSCRIBERS[0]));
  responses.push(await request(port, 'GET', '/i/i1', SUBSCRIBERS[0]));
  responses.push(await request(port, 'GET', '/api/stats/i1', SUBSCRIBERS[0]));
  responses.push(await request(port, 'GET', '/api/schema', SUBSCRIBERS[0]));

  await t.test('the flow actually happened', () => {
    assert.equal(responses[0].status, 302, 'click should redirect');
    assert.equal(responses[0].headers.location, 'https://example.org/a');
    assert.equal(store.linkTotals('i1').find((l) => l.link_id === 'a').count, 12);
    assert.equal(store.feedbackTotals('i1').find((f) => f.bucket === 'useful').count, 7,
      'only the confirming POSTs should count, not the 12 GETs');
  });

  await t.test('the database file contains no canary of any kind', async () => {
    // Force a checkpoint so WAL contents are folded in, then read every file the store
    // created: the database, the WAL, and the shared-memory index.
    store.db.exec('PRAGMA wal_checkpoint(FULL);');
    const { names, bytes } = await readAllBytes(dir);
    assert.ok(names.some((n) => n.startsWith('stats.db')), `expected a database file, saw ${names}`);
    const haystack = bytes.toString('latin1');
    for (const canary of canaryStrings()) {
      assert.ok(!haystack.includes(canary),
        `canary ${JSON.stringify(canary)} was persisted in one of ${names.join(', ')}`);
    }
  });

  await t.test('no HTTP response echoes a canary back', () => {
    for (const r of responses) {
      for (const canary of canaryStrings()) {
        assert.ok(!r.body.includes(canary), `response body echoed ${canary}`);
        assert.ok(!JSON.stringify(r.headers).includes(canary), `response header echoed ${canary}`);
      }
    }
  });

  await t.test('the click table holds only the four allowed columns', () => {
    assert.deepEqual(store.liveColumns().link_clicks, SCHEMA_COLUMNS.link_clicks);
    const rows = store.db.prepare('SELECT * FROM link_clicks').all().map((r) => ({ ...r }));
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['count', 'day', 'issue_id', 'link_id']);
      assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/, 'day must not carry clock time');
    }
  });

  await t.test('the audience of one is suppressed in every published surface', () => {
    const report = buildIssueReport(store, 'i1');
    const c = report.links.find((l) => l.link_id === 'c');
    assert.equal(c.published.suppressed, true, 'a link clicked once must never be published');
    assert.equal(c.published.value, null);

    const issuePage = responses.at(-3).body;
    const apiJson = responses.at(-2).body;
    assert.ok(issuePage.includes('fewer than 5'), 'dashboard must show the suppression');
    assert.ok(!/"count"\s*:\s*1\b/.test(apiJson), `raw count of 1 in API output: ${apiJson.slice(0, 400)}`);
  });

  await t.test('the redirect sets no cookie and no referrer', () => {
    const redirect = responses[0];
    assert.equal(redirect.headers['set-cookie'], undefined, 'redirect must not set a cookie');
    assert.equal(redirect.headers['referrer-policy'], 'no-referrer');
  });

  await t.test('the redirect cannot be pointed at an arbitrary destination', async () => {
    const open = await request(port, 'GET', '/c/i1/a?to=https://evil.example', SUBSCRIBERS[0]);
    assert.equal(open.headers.location, 'https://example.org/a', 'query string must not steer the redirect');
    const missing = await request(port, 'GET', '/c/i1/does-not-exist', SUBSCRIBERS[0]);
    assert.equal(missing.status, 404);
  });

  await t.test('the process wrote no log file next to the database', async () => {
    const names = await readdir(dir);
    const logs = names.filter((n) => /\.(log|jsonl|ndjson|csv)$/.test(n));
    assert.deepEqual(logs, [], `unexpected log files: ${logs.join(', ')}`);
  });
});

test('the server source never reads an identifying request property', async () => {
  // A grep-level guard. It is coarse, and it is here because the runtime test above can
  // only prove that today's code paths did not leak, while this proves the code does not
  // even reach for the values.
  const src = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const code = src.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const forbidden of [
    'remoteAddress', 'remoteFamily', 'user-agent', 'userAgent', 'x-forwarded-for',
    'x-real-ip', 'headers.cookie', 'setHeader(\'set-cookie', 'console.log', 'process.stdout',
  ]) {
    assert.ok(!code.includes(forbidden), `src/server.js reaches for ${forbidden}`);
  }
});

test('hold mode leaves nothing about a sub-threshold link on disk', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hns-hold-'));
  const dbPath = path.join(dir, 'stats.db');
  const store = new Store(dbPath, { mode: 'hold', policy: { k: 5 } });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  store.createIssue({ issueId: 'i1', title: 'Issue one', sentDay: '2026-07-20', recipientCount: 412 });
  store.registerLink({
    issueId: 'i1', linkId: 'embarrassing-link', targetUrl: 'https://example.org/x', label: 'x',
  });
  store.registerLink({
    issueId: 'i1', linkId: 'innocuous-link', targetUrl: 'https://example.org/y', label: 'y',
  });
  // Only the first link is clicked, four times, one short of k.
  for (let i = 0; i < 4; i += 1) store.recordClick('i1', 'embarrassing-link', '2026-07-20');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

  const { bytes } = await readAllBytes(dir);
  const haystack = bytes.toString('latin1');
  // Both link ids are in the database because the publisher registered them. The claim
  // hold mode makes is that the file does not say which one was clicked, so the two ids
  // must be equally represented on disk.
  const clicked = haystack.split('embarrassing-link').length - 1;
  const notClicked = haystack.split('innocuous-link').length - 1;
  assert.ok(clicked > 0, 'the registered link should be in the links table');
  assert.equal(clicked, notClicked,
    `clicked link appears ${clicked} times on disk, unclicked link ${notClicked}: the file distinguishes them`);
  assert.deepEqual(store.db.prepare('SELECT * FROM link_clicks').all().map((r) => ({ ...r })), []);
  assert.equal(store.heldTotal('i1'), 4);
});

test('a stray write of an identifier into the database is caught by the scanner', async (t) => {
  // Negative control. The leak scan above is only meaningful if it can fail, so here a
  // canary is deliberately written into the database and the same scan must catch it.
  const dir = await mkdtemp(path.join(tmpdir(), 'hns-control-'));
  const dbPath = path.join(dir, 'stats.db');
  const store = new Store(dbPath);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  store.createIssue({ issueId: 'i1', title: 'Issue one', sentDay: '2026-07-20', recipientCount: 1 });
  store.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });
  // Simulate the bug this project is designed to make impossible: someone adds a column
  // and starts recording who clicked.
  store.db.exec('ALTER TABLE link_clicks ADD COLUMN subscriber_id TEXT');
  store.db.prepare(
    'INSERT INTO link_clicks (issue_id, link_id, day, count, subscriber_id) VALUES (?, ?, ?, ?, ?)',
  ).run('i1', 'a', '2026-07-20', 1, SUBSCRIBERS[0].id);
  store.db.exec('PRAGMA wal_checkpoint(FULL);');

  const { bytes } = await readAllBytes(dir);
  assert.ok(bytes.toString('latin1').includes(SUBSCRIBERS[0].id),
    'the negative control failed to plant a canary, so the scan proves nothing');
  assert.notDeepEqual(store.liveColumns().link_clicks, SCHEMA_COLUMNS.link_clicks,
    'the schema guard failed to notice an added column');
});

test('a lone dashboard poller cannot watch a counter tick when quantization is on', () => {
  // Without quantization, an observer refreshing the dashboard sees the published number
  // go up by one shortly after each click, which recovers click timing that the day-level
  // storage was supposed to destroy. This documents both the leak and the mitigation.
  const store = new Store(':memory:', { policy: { k: 5, quantize: 10 } });
  store.createIssue({ issueId: 'i1', title: 'x', sentDay: '2026-07-20', recipientCount: 100 });
  store.registerLink({ issueId: 'i1', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });

  const observed = [];
  for (let i = 0; i < 24; i += 1) {
    store.recordClick('i1', 'a', '2026-07-20');
    observed.push(JSON.stringify(buildIssueReport(store, 'i1').links.find((l) => l.link_id === 'a').published));
  }
  const distinct = new Set(observed);
  assert.ok(distinct.size <= 4, `poller saw ${distinct.size} distinct states across 24 clicks`);
  store.close();
});
