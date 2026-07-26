# Threat model

This document is the point of the project. The code is an implementation of the position
taken here, and where the code falls short of the position, this document says so.

Read the [Residual leaks](#residual-leaks-the-part-most-write-ups-omit) section before you
decide whether to trust the system. It is placed in the middle rather than at the end
because it is the part that determines whether any of the rest matters.

## What the system is

A newsletter analytics stack with three pieces:

1. **No open tracking at all.** No pixel, no remote image, no remote CSS, no web font, no
   background attribute. Opening the email sends nothing to anyone except the mail
   provider, which was going to see it anyway.
2. **Click counting through a shared redirect.** Every recipient of an issue receives the
   identical URL for a given link, `https://links.example/c/<issue>/<link>`. The stored
   result is one row of `(issue_id, link_id, day, count)`. There is no column for a
   person, and there is no per-recipient token in the URL to put in one.
3. **An opt-in feedback footer.** Four buttons. Pressing one requires a confirming second
   press, so automated link scanners cannot vote. The result is one increment to a
   counter.

Published numbers pass a k-anonymity threshold, default k = 5. A count below k is shown as
"fewer than 5", never as a zero and never as an exact figure.

## Actors

| Actor | Capability assumed |
|---|---|
| **Subscriber** | Receives the email, may click, may press feedback, may read the dashboard. |
| **Publisher** | Runs the newsletter, holds the sending list in a mail provider, reads the dashboard. |
| **Operator** | Runs the redirect server process and the machine under it. Often the same person as the publisher, and the distinction matters enormously. |
| **Database thief** | Has a copy of the SQLite file, from a backup, a stolen laptop, or a compromised host. |
| **Live host attacker** | Has code execution or traffic visibility on the running server. |
| **Network observer** | Sees TLS metadata: that this subscriber's IP contacted the redirect host, when, and how much data moved. |
| **Mail provider** | Gmail, Fastmail, a corporate Exchange, and the publisher's ESP. Sees the message and, for webmail, sees the click. |

## What the publisher can learn

Precisely this, and nothing adjacent to it:

- How many clicks each link in an issue received in total, once that total reaches k.
- How many clicks the issue received in total on each UTC day, summed across all links.
- How many times each of the four feedback buttons was confirmed, once that count reaches k.
- How many recipients the issue was sent to. The mail provider already told them this.

Derived quantities the publisher can compute from the above, and should be expected to:
a click rate per issue, a crude ranking of links within an issue, and a trend across
issues. Those are the legitimate uses this system is built to serve.

## What the publisher cannot learn

Each of these is unanswerable because the underlying fact was never recorded, not because
a query is withheld:

- Whether any particular subscriber opened the issue. Nothing is fetched on open.
- Whether any particular subscriber clicked any particular link.
- Which links a single subscriber clicked, as a set. Two clicks by the same person are
  indistinguishable from clicks by two people. No cookie, no session, no token, no
  IP-derived key ties them together.
- The time of day of a click. The finest timestamp written anywhere is a UTC date.
- The distinction between 40 clicks by 40 people and 40 clicks by 4 people who clicked
  ten times each. Counts are clicks and are an upper bound on humans.
- Anything about subscribers who never clicked. They are, correctly, invisible.
- Reader geography, mail client, browser, or device.

The dashboard prints this list next to the numbers. A subscriber should not have to read
source code to find out what is being collected.

## What an attacker with the database can learn

Assume the SQLite file is fully compromised. Its contents are:

- The issues table: issue ids, titles, send dates, recipient headcounts.
- The links table: the destination URL of every link the publisher registered.
- The click table: `(issue, link, day, count)` rows.
- The feedback table: `(issue, bucket, day, count)` rows.

So a database thief learns the publisher's editorial history and the shape of reader
interest, at day resolution. That is a real loss for the publisher. Subscriber privacy
survives it, because there is no subscriber in the file. There is no list of readers here
to steal; the sending list lives in the mail provider.

**In the default `report` mode, the thief also sees counts below k.** The threshold is
applied when publishing, not when writing. If exactly one person clicked an unusual link
and the publisher happens to know only one subscriber cares about that topic, the file
says "1" and the inference is available to whoever holds the file.

**In `hold` mode, it does not.** Clicks on a link that has not yet reached k are held in
process memory and written to disk only as a per-day total for the whole issue, with the
link identity discarded. A stolen file then cannot say which link the sub-threshold clicks
were on. The test suite proves this by scanning the raw bytes of the database and checking
that a clicked-but-suppressed link is byte-for-byte as represented on disk as a link
nobody touched.

Hold mode costs something real, and the cost is not hypothetical:

- A process restart permanently loses the per-link attribution of held clicks. The issue's
  total survives in `held_totals`; which link they were on does not.
- It requires a single long-lived process. On a serverless platform where each request may
  hit a fresh instance, the in-memory buffer is per-instance and the mode degrades to
  something close to report mode with extra data loss. Do not deploy hold mode on Lambda,
  Vercel Functions, or Cloud Run with instance scaling and expect it to work.
- On an issue with only one or two registered links, the per-day held total is close to a
  per-link count, so the protection is weak. It is strongest on issues with many links.

## Residual leaks, the part most write-ups omit

### The redirect endpoint receives your IP address and user agent

This is the big one, and no amount of schema design removes it. When a subscriber clicks,
their browser or mail client makes an HTTP request to the redirect host. That request
carries a source IP address, a user agent string, `Accept-Language`, and a TLS
fingerprint. The operator's kernel sees the IP before any application code runs.

What this code does about it: `src/server.js` never reads `req.socket.remoteAddress`,
never reads `req.headers`, and writes no access log. The values pass through process
memory and are discarded. The test suite sends deliberately distinctive headers through
the real server and then scans every byte the process persisted, plus every byte it will
serve over HTTP, to prove none of it was kept.

What this code cannot do about it:

- **A reverse proxy in front of it logs by default.** nginx, Caddy, Cloudflare, and every
  PaaS edge keep request logs with IPs. If you deploy this behind any of them without
  turning access logging off, the system as a whole records exactly what this application
  refuses to record, and the privacy claim is void. This is the most likely way a real
  deployment breaks the promise.
- **The operator can change the code.** Nothing here is verifiable by a subscriber from
  the outside. A subscriber who trusts this system is trusting the operator to run this
  code, unmodified, with logging off. Publishing the code raises the cost of quietly
  defecting; it does not make defection detectable.
- **The hosting provider sees the traffic regardless.** Its flow logs, its load balancer,
  and its billing telemetry are outside this program's control.

Do not describe a deployment of this as anonymous. It is unlinked at rest, by an operator
who can see the requests in flight.

### Timing correlation on a small list

Day-granularity storage destroys click timing in the database. It does not destroy it in
the moment. An operator watching the server, or a network observer watching the subscriber,
sees the click as it happens. On a list of 30 people where the operator knows who is
awake at 3am, a single click is not anonymous no matter what the schema looks like.

k-anonymity does nothing here. k is a property of the published aggregate, not of the
request stream.

### Polling the dashboard recovers timing

With `quantize: 1`, the default, a published count is exact once it crosses k. An observer
who refreshes the public dashboard every ten seconds watches the number increase by one
shortly after each click, which reconstructs click times to the polling interval. That
defeats the purpose of storing only a date.

The mitigation is in the code and off by default: set `quantize` to 10 and published
counts round down to a multiple of ten, so a poller sees a state change roughly once per
ten clicks rather than once per click. The test
`a lone dashboard poller cannot watch a counter tick when quantization is on` demonstrates
the difference. Turn it on if your dashboard is genuinely public and your list is small.
It is off by default because rounded counts confuse publishers who have not read this
document, which is an honest reason and also an uncomfortable one.

### Counts include machines

Corporate mail gateways, security scanners, and link previewers fetch URLs with no human
involved. They inflate click counts, sometimes by a lot, and they inflate the counts of
links that appear early in an email most of all.

The usual fix is to filter them by user agent. This system refuses to read the user agent,
so it cannot filter them. That is a deliberate trade: the counts are noisier and the
requests are not profiled. The dashboard states this on every issue page. Treat every
click number here as an upper bound.

The feedback footer is protected differently. A GET on a feedback link renders a
confirmation page and records nothing; only the confirming POST increments a counter.
Scanners follow links, they do not submit forms, so feedback counts are much cleaner than
click counts. The cost is that a real subscriber has to press twice, which suppresses
response rate.

### The k threshold does not compose across queries

k protects a single published cell. It does not protect a set of cells that overlap.
Specific failure modes worth knowing:

- **Differencing across time.** This implementation publishes per-link totals that are
  cumulative and monotone, and a daily series that is summed over all links in the issue.
  It deliberately does not publish a per-link, per-day table, because subtracting
  yesterday's per-link total from today's would reveal per-day increments that were never
  above k on their own.
- **Differencing across issues.** If the same link appears in two issues and the publisher
  compares, small differences can fall below k even though both endpoints are above it.
  This system does not do cross-issue joins, but a publisher with the dashboard open in
  two tabs can do the arithmetic.
- **Side knowledge.** k = 5 means at least five clicks, not at least five people, and
  certainly not five people the observer cannot guess. On a list of eight, "5 or more"
  is close to naming everyone.

k buys one thing honestly: it prevents the published dashboard from asserting the
existence of a very small group of readers who did an unusual thing. That is worth having.
It is not anonymity, and this system does not implement differential privacy. Adding
calibrated noise was considered and rejected, because a counter that is queried repeatedly
over a newsletter's life needs a privacy budget tracked across all those queries, and an
unbudgeted noise layer would look more rigorous than it is.

### Free-text feedback is not supported, on purpose

An open comment box is the largest identity leak available in a system like this. People
sign their notes, mention their employer, or describe their situation in a way only they
could. There is no way to k-anonymize a sentence. The footer therefore offers four fixed
buckets and no text field. If you add one, this threat model no longer describes your
system.

### Link registration must not be per-recipient

The entire design rests on every recipient receiving identical bytes. A publisher who
registers one link per recipient, or who personalizes a URL in any way, reintroduces
per-subscriber tracking through the front door while keeping the privacy-looking schema.
`renderIssue` takes no recipient argument for this reason, and a test asserts that repeated
renders are byte-identical. That test is a guard against the maintainer, not against an
outside attacker.

## What a subscriber is trusting

Stated plainly, because a privacy claim that hides its trust assumptions is marketing:

1. That the operator is running this code, unmodified.
2. That no reverse proxy, CDN, or platform edge in front of it keeps access logs.
3. That the operator does not read live request traffic, which they are technically able to
   do at any moment without leaving a trace in the database.
4. That the mail provider on both ends is a separate problem the subscriber has already
   accepted.
5. That the publisher does not correlate dashboard numbers with side knowledge about a
   small list.

Items 1 through 3 are unverifiable from outside. A subscriber's real protection is that
the system stores nothing worth stealing later, so a breach, a subpoena, an acquisition,
or a change of heart six months from now finds counters instead of a behavioral profile.
That is a smaller claim than "private", and it is the claim this project actually supports.

## What would make this stronger

Honest list of things not built here:

- **Oblivious HTTP or a relay in front of the redirect**, so the operator sees a relay's
  IP instead of the subscriber's. This closes the largest residual leak and needs a second
  party with a genuinely separate operator, which a solo newsletter usually does not have.
- **Reproducible deployment with an attestation**, so a subscriber could check that the
  running binary matches the published source.
- **A published retention and deletion schedule**, with old per-day rows collapsed into
  per-issue totals after some weeks. Straightforward to add, not implemented.
- **A formal privacy budget** if noise is ever introduced.

## Summary table

| Question | Answer |
|---|---|
| Can the publisher tell who opened an issue? | No. Nothing is fetched on open. |
| Can the publisher tell who clicked a link? | No. |
| Can the publisher tell how many clicks a link got? | Yes, once it reaches k. |
| Can the publisher tell what time a click happened? | Not from stored data. Yes, if watching the live server. |
| Does the redirect server see IP addresses? | Yes, in flight. It never stores them. A proxy in front of it might. |
| Does a database thief learn anything about a subscriber? | No. There is no subscriber in the database. |
| Does a database thief learn sub-threshold counts? | Yes in `report` mode. No in `hold` mode. |
| Are the click counts accurate? | No. They include mail scanners and are an upper bound. |
| Is this anonymous? | No. It is unlinked at rest, with an operator who can see requests in flight. |
