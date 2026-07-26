# honest-newsletter-stats

Newsletter analytics with no tracking pixels, no per-subscriber link wrappers, aggregate
click counts behind a k-anonymity threshold, and a public dashboard that tells readers
what the publisher cannot see.

Catalog task: `MEDIA-015`. Part of [thousand](../../README.md).

**[Read this on the web](https://jesserweigel.github.io/honest-newsletter-stats/)**

**Read [THREAT_MODEL.md](THREAT_MODEL.md) first.** It is the primary deliverable. The code
implements the position taken there, and where the code falls short, that document says so
in detail. The short version of the honest part: the redirect endpoint still receives every
clicker's IP address and user agent in the HTTP request. This application never reads them
and never stores them, but they exist in flight, and a reverse proxy in front of this
server will log them by default. This system is unlinked at rest. It is not anonymous.

## What this is

Four pieces, about 900 lines of Node with zero runtime dependencies.

**No open tracking.** `src/email.js` renders the issue body with registered links rewritten
to shared redirect URLs and appends the opt-in feedback footer. It takes no recipient
argument, so the rendered bytes are identical for everyone on the list. `auditRenderedEmail`
rejects any `<img>`, remote CSS `url()`, remote `background` attribute, or active content
tag, so a template edit cannot quietly reintroduce a pixel.

**Aggregate-only click counting.** `src/store.js` defines a SQLite schema whose click table
is `(issue_id, link_id, day, count)`. There is no column that could hold a subscriber, an
IP, a user agent, or a clock time. `recordClick` takes three parameters and there is
nowhere for a fourth to go. Two storage modes:

- `report` (default) persists exact counts and applies the threshold when publishing.
- `hold` keeps sub-threshold per-link counts in process memory and writes only a
  link-agnostic per-day total, so a stolen database file cannot say which link the
  suppressed clicks were on. It costs durability and requires a single long-lived process.
  See the threat model before choosing it.

**A k-anonymity reporting policy.** `src/policy.js` is the only place a raw count becomes a
published number. Default k is 5. A cell below k serializes identically for every value
from 0 to k-1, so a suppressed cell says nothing about which small number it was. Optional
`quantize` rounds published counts down to a multiple of n, which blunts the attack where
someone polls the public dashboard and watches a counter tick once per click.

**A dashboard that inverts.** `src/dashboard.js` prints the numbers next to an explicit
list of the questions the system cannot answer and why each one is unanswerable. It renders
the `CREATE TABLE` statements live from the running database, so a reader can check the
no-identity claim against the process instead of against a promise in a README. It also
states the residual IP leak and the fact that click counts include mail scanners.

The feedback footer is a two-step action. A GET on a feedback link renders a confirmation
page and records nothing; only the confirming POST increments a counter. Corporate mail
scanners follow links, they do not submit forms, so feedback counts are much cleaner than
click counts.

## Running it

Needs Node 22.5 or newer for the built-in `node:sqlite`. No npm install, there are no
dependencies.

```bash
# see the rendered email, the pixel audit, and a published report
node src/cli.js demo

# serve the dashboard and redirect endpoint with seeded demo data
node src/cli.js serve --db /tmp/stats.db --port 8787 --seed 1
# then open http://localhost:8787/

# stronger at-rest mode, higher threshold
node src/cli.js serve --db /tmp/stats.db --mode hold --k 10
```

Endpoints: `GET /` index, `GET /i/:issue` issue dashboard, `GET /c/:issue/:link` redirect,
`GET|POST /f/:issue/:bucket` feedback, `GET /api/stats[/:issue]`, `GET /api/schema`.

Programmatic use:

```js
import { Store } from './src/store.js';
const store = new Store('stats.db', { mode: 'hold', policy: { k: 5, quantize: 10 } });
store.createIssue({ issueId: 'issue-12', title: 'Issue 12', recipientCount: 412 });
store.registerLink({ issueId: 'issue-12', linkId: 'a', targetUrl: 'https://example.org/a', label: 'A' });
```

## Verify

```bash
bash verify.sh
```

Three stages. Stage 1 runs 45 tests, including an end-to-end run of the real HTTP server
where twelve simulated subscribers each carry a canary in `User-Agent`, `Cookie`,
`X-Forwarded-For`, `X-Subscriber-Id`, `From`, and `Referer`, after which every byte the
process persisted and every byte it will serve is scanned for any canary. That suite
includes a negative control which deliberately plants a subscriber id in the database and
asserts the scanner catches it, so a pass means the scan can actually fail. Stage 2 repeats
the leak check from outside the test harness against a separately launched server, greping
the database file with `grep`. Stage 3 greps the shipped source for tracking primitives.

Assumptions recorded during the build, since the task description left them open:

- Counting is per link and per UTC day. Finer time buckets were rejected because they make
  timing correlation on a small list much easier.
- The threshold is applied to per-link cumulative totals and to a per-issue daily series,
  and a per-link-per-day table is never published, because subtracting consecutive
  cumulative totals would reveal daily increments that never passed the threshold.
- Free-text feedback is deliberately not implemented. A sentence cannot be k-anonymized.
- Bot filtering by user agent is deliberately not implemented, because it requires reading
  the user agent. Click counts are therefore an upper bound and the dashboard says so.

## Status

`bash verify.sh` exits 0. Pasted below, with 38 of the 45 individual test lines elided for
length and everything else verbatim. `tools/logrun.py` re-executed the same command from
outside this project and recorded the real exit code in `logs/runs.jsonl`.

```
== stage 1: test suite ==
✔ the issue page states what the publisher cannot see, not only what it can (2.169461ms)
✔ the index renders the live schema so the no-identity claim is auditable (0.618511ms)
✔ a suppressed link renders as a threshold, never as zero (0.50302ms)
✔ the page tells the reader that clicks include machines (0.434124ms)
✔ hold mode and report mode describe their own storage honestly (0.792561ms)
✔ rendered HTML escapes issue and link text (0.313398ms)
✔ the rendered email is byte-identical for every recipient (2.516259ms)
[38 test lines elided]
✔ hold mode released state survives reopening the same database file (53.042076ms)
✔ feedback buckets are a closed vocabulary (0.456005ms)
✔ utcDay keeps date granularity only (0.314008ms)
ℹ tests 45
ℹ suites 0
ℹ pass 45
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 210.348504

== stage 2: live server, external leak check ==
ok: no canary in stats.db
ok: no canary in stats.db-shm
ok: no canary in stats.db-wal
ok: no canary in the dashboard or the JSON API
ok: dashboard publishes what the publisher cannot see
ok: 7 clicks aggregated and published above k=5
ok: sub-threshold cells are suppressed in both the API and the page

== stage 3: structural grep for tracking primitives in shipped source ==
ok: no tracking primitive in src/

VERIFY PASSED
```

## Unfinished

- **No mail sending.** This produces the email HTML and counts the clicks. Handing the HTML
  to an ESP is out of scope, and the ESP will see far more than this system does.
- **No retention or deletion schedule.** Per-day rows accumulate forever. Collapsing old
  rows into per-issue totals after some weeks is listed in the threat model as an
  improvement and is not implemented.
- **No authentication on the dashboard.** It is public by design, which means the polling
  attack described in the threat model applies unless `quantize` is raised above 1.
- **Hold mode is single-process only.** On a scaled or serverless deployment the in-memory
  buffer is per-instance and the mode degrades. There is no distributed implementation.
- **The Oblivious HTTP relay is not built.** It is the change that would close the largest
  residual leak, and it needs a second party with a separate operator.
- **No load testing.** Every write is a synchronous SQLite statement on the request path.
  Fine for a newsletter, untested above a trickle.
