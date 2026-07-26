// Builds the published view of an issue: what the publisher can see, plus the explicit
// list of what nobody can see because it was never recorded.
//
// The second list is the interesting half. A normal analytics dashboard is a list of
// things the publisher knows about you. This one prints, next to those numbers, the
// questions the system cannot answer no matter who asks it.

import { publishRows, publishCount, validatePolicy } from './policy.js';
import { SCHEMA_COLUMNS } from './store.js';

/** Questions this system cannot answer, with the reason each one is unanswerable. */
export const CANNOT_SEE = Object.freeze([
  ['Did a specific subscriber open this issue?',
   'There is no open tracking. No pixel, no remote image, no beacon of any kind is embedded in the email, so opening it sends nothing anywhere.'],
  ['Did a specific subscriber click this link?',
   'Click URLs are identical for every recipient. The stored row is (issue, link, day, count) and has no column that could hold a recipient.'],
  ['Which links did one subscriber click, as a set?',
   'Nothing correlates two clicks to the same person. Per-link counters are incremented independently with no session, cookie, or token.'],
  ['What time of day did clicks happen?',
   'The finest timestamp stored anywhere is a UTC date. Clock time is dropped before the write.'],
  ['Which subscribers are the most engaged?',
   'No per-subscriber state exists to rank. The database has no subscriber table at all; the sending list lives in the mail provider, not here.'],
  ['How many unique people clicked, as opposed to how many clicks?',
   'Distinguishing a repeat clicker from a new one requires identifying the clicker. Counts are clicks, and clicks are an upper bound on people.'],
  ['Where in the world are the readers?',
   'No IP address is read into a variable, logged, or stored, so no geolocation is possible after the fact.'],
  ['What email client or browser do readers use?',
   'The user agent header is never read by the redirect handler and never written anywhere.'],
]);

/** Questions this system can answer, stated as plainly as the ones above. */
export const CAN_SEE = Object.freeze([
  ['How many clicks each link received in total, once it passes the threshold.',
   'Sub-threshold links are shown as "fewer than k", never as zero.'],
  ['How many clicks the whole issue received on each UTC day.',
   'Summed across every link, which is why day granularity is acceptable here.'],
  ['How many readers pressed each button in the opt-in feedback footer.',
   'Feedback is a deliberate two-step action, so it is not triggered by mail scanners.'],
  ['How many recipients the issue was sent to.',
   'The publisher already knows this from the mail provider; it is here as a denominator.'],
]);

export function buildIssueReport(store, issueId) {
  const issue = store.getIssue(issueId);
  if (!issue) return null;
  const policy = validatePolicy(store.policy);

  const links = publishRows(store.linkTotals(issueId), policy);
  const daily = publishRows(store.dailyTotals(issueId), policy);
  const feedback = publishRows(store.feedbackTotals(issueId), policy);

  const rawTotal = store.linkTotals(issueId).reduce((a, r) => a + r.count, 0)
    + store.heldTotal(issueId);

  return {
    issue: {
      issueId: issue.issue_id,
      title: issue.title,
      sentDay: issue.sent_day,
      recipientCount: issue.recipient_count,
    },
    policy: { k: policy.k, quantize: policy.quantize, mode: store.mode },
    links,
    daily,
    feedback,
    totalClicks: publishCount(rawTotal, policy),
    suppressedLinkCount: links.filter((l) => l.published.suppressed).length,
    // Hold mode writes a link-agnostic per-day total for sub-threshold clicks. It is
    // published through the same threshold, because on an issue with only one or two
    // links this number is close to a per-link count.
    heldBelowThreshold: store.mode === 'hold'
      ? publishCount(store.heldTotal(issueId), policy)
      : null,
    canSee: CAN_SEE,
    cannotSee: CANNOT_SEE,
    schemaColumns: SCHEMA_COLUMNS,
  };
}
