import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, validatePolicy, publishCount, publishRows, describeCell } from '../src/policy.js';

test('the default threshold is at least 5', () => {
  // A k of 1 or 2 is decoration. If someone lowers this default, the change should be
  // deliberate enough to break a test.
  assert.ok(DEFAULT_POLICY.k >= 5, `default k is ${DEFAULT_POLICY.k}`);
});

test('counts below k are suppressed and never rendered as zero', () => {
  for (let n = 0; n < 5; n += 1) {
    const cell = publishCount(n, { k: 5 });
    assert.equal(cell.suppressed, true, `count ${n} should be suppressed`);
    assert.equal(cell.value, null);
    assert.equal(describeCell(cell), 'fewer than 5');
    assert.ok(!describeCell(cell).includes('0'), 'a suppressed cell must not read as zero');
  }
});

test('counts at or above k are published', () => {
  assert.deepEqual(publishCount(5, { k: 5 }), { suppressed: false, value: 5, threshold: 5, exact: true });
  assert.equal(publishCount(41, { k: 5 }).value, 41);
});

test('a suppressed cell leaks no information about which of 0..k-1 it was', () => {
  const cells = [0, 1, 2, 3, 4].map((n) => JSON.stringify(publishCount(n, { k: 5 })));
  assert.equal(new Set(cells).size, 1, 'all sub-threshold cells must serialize identically');
});

test('quantization rounds down, so a published count is a lower bound', () => {
  assert.equal(publishCount(37, { k: 5, quantize: 10 }).value, 30);
  assert.equal(publishCount(40, { k: 5, quantize: 10 }).value, 40);
  assert.equal(publishCount(49, { k: 5, quantize: 10 }).exact, false);
  assert.equal(describeCell(publishCount(49, { k: 5, quantize: 10 })), '40 or more');
});

test('quantization is monotone, so a published count never goes down as clicks go up', () => {
  let previous = -1;
  for (let n = 5; n < 200; n += 1) {
    const cell = publishCount(n, { k: 5, quantize: 7 });
    assert.ok(cell.value >= previous, `published value dropped at n=${n}`);
    previous = cell.value;
  }
});

test('invalid policies are rejected rather than silently coerced', () => {
  for (const bad of [{ k: 0 }, { k: -1 }, { k: 1.5 }, { k: '5' }, { quantize: 0 }, { quantize: null }]) {
    assert.throws(() => validatePolicy(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => publishCount(-1, DEFAULT_POLICY), TypeError);
  assert.throws(() => publishCount(1.5, DEFAULT_POLICY), TypeError);
});

test('publishRows replaces the raw count so it cannot be serialized by accident', () => {
  const rows = publishRows([{ link_id: 'a', count: 2 }, { link_id: 'b', count: 9 }], { k: 5 });
  assert.equal(rows[0].count, undefined, 'raw count must not survive into a published row');
  assert.equal(rows[0].published.suppressed, true);
  assert.equal(rows[1].published.value, 9);
  assert.ok(!JSON.stringify(rows).includes('"count"'), JSON.stringify(rows));
});
