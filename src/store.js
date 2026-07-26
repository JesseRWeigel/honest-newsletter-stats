// Durable state for honest-newsletter-stats.
//
// The central design claim of this project is structural, not procedural: there is no
// column anywhere in this schema that can hold a subscriber identifier, an IP address,
// a user agent, or a timestamp finer than one UTC day. Nothing has to remember to strip
// identity, because no write path ever accepts it. recordClick takes an issue id, a link
// id, and a day. That is the whole signature.
//
// SCHEMA_COLUMNS below is asserted against the live database by test/no-identity.test.js.
// Adding a column to any table fails that test until the allowlist is updated, which is
// the point: widening what this system stores should require an explicit, reviewable edit.

import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_POLICY, validatePolicy } from './policy.js';

export const FEEDBACK_BUCKETS = Object.freeze([
  'useful',
  'not-useful',
  'too-long',
  'more-like-this',
]);

export const SCHEMA_COLUMNS = Object.freeze({
  issues: ['issue_id', 'title', 'sent_day', 'recipient_count'],
  links: ['issue_id', 'link_id', 'target_url', 'label'],
  link_clicks: ['issue_id', 'link_id', 'day', 'count'],
  held_totals: ['issue_id', 'day', 'count'],
  feedback: ['issue_id', 'bucket', 'day', 'count'],
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS issues (
  issue_id        TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  sent_day        TEXT NOT NULL,
  recipient_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  issue_id   TEXT NOT NULL,
  link_id    TEXT NOT NULL,
  target_url TEXT NOT NULL,
  label      TEXT NOT NULL,
  PRIMARY KEY (issue_id, link_id)
);

-- Aggregate click counters. One row per issue, link, and UTC day. There is deliberately
-- no subscriber column, no ip column, no user_agent column, and no clock time.
CREATE TABLE IF NOT EXISTS link_clicks (
  issue_id TEXT NOT NULL,
  link_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (issue_id, link_id, day)
);

-- Hold mode only. Clicks on links that have not yet reached k are counted here, per
-- issue and day, with the link identity discarded. See docs in this file.
CREATE TABLE IF NOT EXISTS held_totals (
  issue_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (issue_id, day)
);

CREATE TABLE IF NOT EXISTS feedback (
  issue_id TEXT NOT NULL,
  bucket   TEXT NOT NULL,
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (issue_id, bucket, day)
);
`;

/** UTC day string for a Date or epoch ms. Day granularity is the finest time we keep. */
export function utcDay(when = Date.now()) {
  return new Date(when).toISOString().slice(0, 10);
}

function assertPlainId(value, what) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new TypeError(`${what} must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, got ${JSON.stringify(value)}`);
  }
}

function assertDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`day must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
}

export class Store {
  /**
   * @param {string} path        file path, or ':memory:'
   * @param {object} options
   * @param {'report'|'hold'} options.mode
   *   'report' persists every click immediately and applies k only when publishing.
   *   'hold'   keeps sub-k per-link counts in process memory and writes only a
   *            link-agnostic per-day total, so a stolen database file reveals nothing
   *            about which links had fewer than k clicks. The cost is real: a process
   *            restart loses the held per-link breakdown permanently.
   * @param {object} options.policy  see policy.js
   */
  constructor(path = ':memory:', { mode = 'report', policy = DEFAULT_POLICY } = {}) {
    if (mode !== 'report' && mode !== 'hold') {
      throw new TypeError(`mode must be 'report' or 'hold', got ${JSON.stringify(mode)}`);
    }
    this.mode = mode;
    this.policy = validatePolicy(policy);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA_SQL);
    // (issue|link) -> Map<day, count> for links still below k in hold mode. Populated below
    // from whatever is already on disk, so reopening a database cannot lose the accounting.
    // (issue|link) pairs that already crossed k and are being written through.
    //
    // This used to be seeded from every link with ANY historical click row, without comparing
    // to the k in force now. So a database written in report mode, or under a smaller k, came
    // back with every link marked released, and hold mode wrote each new sub-threshold click
    // straight through. Recording one click, reopening with {mode:'hold', k:10}, and clicking
    // again produced a stored count of 2 against a threshold of 10.
    //
    // A link is released only if what is already stored meets the ACTIVE threshold. Anything
    // below it goes back into `held`, seeded with the counts already on disk so the
    // accounting stays correct and no further writes accumulate below k.
    this.released = new Set();
    this.held = new Map();
    const existing = this.db.prepare(
      'SELECT issue_id, link_id, day, count FROM link_clicks',
    ).all();
    const totals = new Map();
    for (const row of existing) {
      const key = `${row.issue_id}|${row.link_id}`;
      totals.set(key, (totals.get(key) ?? 0) + row.count);
    }
    for (const [key, total] of totals) {
      if (total >= this.policy.k) {
        this.released.add(key);
      }
    }
    if (this.mode === 'hold') {
      for (const row of existing) {
        const key = `${row.issue_id}|${row.link_id}`;
        if (this.released.has(key)) continue;
        const days = this.held.get(key) ?? new Map();
        days.set(row.day, (days.get(row.day) ?? 0) + row.count);
        this.held.set(key, days);
      }
    }
  }

  close() {
    this.db.close();
  }

  // ---- writes -------------------------------------------------------------

  createIssue({ issueId, title, sentDay = utcDay(), recipientCount }) {
    assertPlainId(issueId, 'issueId');
    assertDay(sentDay);
    if (!Number.isInteger(recipientCount) || recipientCount < 0) {
      throw new TypeError('recipientCount must be a non-negative integer');
    }
    this.db.prepare(
      'INSERT OR REPLACE INTO issues (issue_id, title, sent_day, recipient_count) VALUES (?, ?, ?, ?)',
    ).run(issueId, String(title), sentDay, recipientCount);
  }

  registerLink({ issueId, linkId, targetUrl, label }) {
    assertPlainId(issueId, 'issueId');
    assertPlainId(linkId, 'linkId');
    const url = new URL(targetUrl); // throws on garbage, and pins the redirect allowlist
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(`targetUrl must be http or https, got ${url.protocol}`);
    }
    this.db.prepare(
      'INSERT OR REPLACE INTO links (issue_id, link_id, target_url, label) VALUES (?, ?, ?, ?)',
    ).run(issueId, linkId, url.toString(), String(label ?? linkId));
  }

  /**
   * Record one click. Note the signature: there is no fourth parameter, and there is
   * nowhere for one to go. Returns 'counted', 'held', or 'released' so the server can
   * report behavior in tests without exposing anything per-subscriber.
   */
  recordClick(issueId, linkId, day = utcDay()) {
    assertPlainId(issueId, 'issueId');
    assertPlainId(linkId, 'linkId');
    assertDay(day);
    const link = this.db.prepare(
      'SELECT 1 FROM links WHERE issue_id = ? AND link_id = ?',
    ).get(issueId, linkId);
    if (!link) throw new RangeError(`unregistered link ${issueId}/${linkId}`);

    const key = `${issueId}|${linkId}`;
    if (this.mode === 'report' || this.released.has(key)) {
      this.#bumpClicks(issueId, linkId, day, 1);
      return this.mode === 'report' ? 'counted' : 'released';
    }

    const days = this.held.get(key) ?? new Map();
    days.set(day, (days.get(day) ?? 0) + 1);
    this.held.set(key, days);
    this.#bumpHeld(issueId, day, 1);

    let total = 0;
    for (const c of days.values()) total += c;
    if (total >= this.policy.k) {
      for (const [d, c] of days) {
        this.#bumpClicks(issueId, linkId, d, c);
        this.#bumpHeld(issueId, d, -c);
      }
      this.held.delete(key);
      this.released.add(key);
      return 'released';
    }
    return 'held';
  }

  recordFeedback(issueId, bucket, day = utcDay()) {
    assertPlainId(issueId, 'issueId');
    assertDay(day);
    if (!FEEDBACK_BUCKETS.includes(bucket)) {
      throw new RangeError(`unknown feedback bucket ${JSON.stringify(bucket)}`);
    }
    this.db.prepare(`
      INSERT INTO feedback (issue_id, bucket, day, count) VALUES (?, ?, ?, 1)
      ON CONFLICT (issue_id, bucket, day) DO UPDATE SET count = count + 1
    `).run(issueId, bucket, day);
  }

  #bumpClicks(issueId, linkId, day, delta) {
    this.db.prepare(`
      INSERT INTO link_clicks (issue_id, link_id, day, count) VALUES (?, ?, ?, ?)
      ON CONFLICT (issue_id, link_id, day) DO UPDATE SET count = count + excluded.count
    `).run(issueId, linkId, day, delta);
  }

  #bumpHeld(issueId, day, delta) {
    this.db.prepare(`
      INSERT INTO held_totals (issue_id, day, count) VALUES (?, ?, ?)
      ON CONFLICT (issue_id, day) DO UPDATE SET count = count + excluded.count
    `).run(issueId, day, delta);
    this.db.prepare('DELETE FROM held_totals WHERE issue_id = ? AND count <= 0').run(issueId);
  }

  // ---- reads --------------------------------------------------------------

  getIssue(issueId) {
    return this.db.prepare('SELECT * FROM issues WHERE issue_id = ?').get(issueId) ?? null;
  }

  listIssues() {
    return this.db.prepare('SELECT * FROM issues ORDER BY sent_day DESC, issue_id').all();
  }

  listLinks(issueId) {
    return this.db.prepare(
      'SELECT link_id, target_url, label FROM links WHERE issue_id = ? ORDER BY link_id',
    ).all(issueId);
  }

  getLinkTarget(issueId, linkId) {
    const row = this.db.prepare(
      'SELECT target_url FROM links WHERE issue_id = ? AND link_id = ?',
    ).get(issueId, linkId);
    return row ? row.target_url : null;
  }

  /** Raw cumulative click count per link. Unpublished; callers must apply the policy. */
  linkTotals(issueId) {
    const counts = new Map(
      this.db.prepare(
        'SELECT link_id, SUM(count) AS n FROM link_clicks WHERE issue_id = ? GROUP BY link_id',
      ).all(issueId).map((r) => [r.link_id, Number(r.n)]),
    );
    return this.listLinks(issueId).map((l) => ({ ...l, count: counts.get(l.link_id) ?? 0 }));
  }

  /**
   * Clicks per day across all links in an issue, including hold-mode clicks whose link
   * identity was discarded. Aggregating across links is what makes this series safe to
   * show at day granularity: it is the sum over the whole issue, not one link.
   */
  dailyTotals(issueId) {
    return this.db.prepare(`
      SELECT day, SUM(n) AS n FROM (
        SELECT day, count AS n FROM link_clicks WHERE issue_id = ?
        UNION ALL
        SELECT day, count AS n FROM held_totals WHERE issue_id = ?
      ) GROUP BY day ORDER BY day
    `).all(issueId, issueId).map((r) => ({ day: r.day, count: Number(r.n) }));
  }

  feedbackTotals(issueId) {
    const counts = new Map(
      this.db.prepare(
        'SELECT bucket, SUM(count) AS n FROM feedback WHERE issue_id = ? GROUP BY bucket',
      ).all(issueId).map((r) => [r.bucket, Number(r.n)]),
    );
    return FEEDBACK_BUCKETS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
  }

  /** Total clicks currently held below k, across all links in the issue. */
  heldTotal(issueId) {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(count), 0) AS n FROM held_totals WHERE issue_id = ?',
    ).get(issueId);
    return Number(row.n);
  }

  /** The live CREATE TABLE text, rendered on the public dashboard so readers can audit it. */
  schemaText() {
    return this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((r) => `${r.sql};`).join('\n\n');
  }

  /** Column names per table, as SQLite reports them. Used by the schema guard test. */
  liveColumns() {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((r) => r.name);
    const out = {};
    for (const t of tables) {
      out[t] = this.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    }
    return out;
  }
}
