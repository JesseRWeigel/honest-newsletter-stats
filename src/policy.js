// Reporting policy: k-anonymity threshold and count quantization.
//
// This module decides what a stored count is allowed to become when it is shown to
// anyone, including the publisher's own dashboard. It is the only place a raw count
// turns into a published number, so the rules are auditable in one screen.
//
// Read THREAT_MODEL.md section "What k buys and what it does not" before changing
// any default here. The short version: k protects against inference from a small
// published aggregate. It does nothing against whoever holds the database, unless
// the store is running in hold mode.

export const DEFAULT_POLICY = Object.freeze({
  // Minimum number of recorded events before a count is published at all.
  k: 5,
  // Published counts are rounded down to a multiple of this. 1 means exact.
  // Values above 1 blunt the "poll the dashboard and watch the number tick"
  // attack described in the threat model, at the cost of precision.
  quantize: 1,
});

export function validatePolicy(policy = {}) {
  const merged = { ...DEFAULT_POLICY, ...policy };
  for (const field of ['k', 'quantize']) {
    const value = merged[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`policy.${field} must be an integer >= 1, got ${JSON.stringify(value)}`);
    }
  }
  return Object.freeze(merged);
}

/**
 * Turn one raw count into a publishable cell.
 *
 * Returns { suppressed, value, threshold, exact }. When suppressed is true, value is
 * null and callers must render the threshold, never a zero, because rendering zero
 * would falsely claim nobody clicked.
 */
export function publishCount(count, policy = DEFAULT_POLICY) {
  const p = validatePolicy(policy);
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`count must be a non-negative integer, got ${JSON.stringify(count)}`);
  }
  if (count < p.k) {
    return { suppressed: true, value: null, threshold: p.k, exact: false };
  }
  const value = Math.floor(count / p.quantize) * p.quantize;
  return { suppressed: false, value, threshold: p.k, exact: p.quantize === 1 };
}

/** Apply publishCount across a list of rows, replacing row.count with row.published. */
export function publishRows(rows, policy = DEFAULT_POLICY, countKey = 'count') {
  return rows.map((row) => {
    const { [countKey]: count, ...rest } = row;
    return { ...rest, published: publishCount(count, policy) };
  });
}

/** Human sentence for a suppressed cell, used by both the HTML and the JSON API. */
export function describeCell(cell) {
  return cell.suppressed
    ? `fewer than ${cell.threshold}`
    : cell.exact
      ? String(cell.value)
      : `${cell.value} or more`;
}
