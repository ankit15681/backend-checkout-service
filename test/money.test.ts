import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentToBps } from '../src/config.ts';
import { discountCents, lineTotalCents } from '../src/money.ts';

describe('money', () => {
  it('rounds percentage discounts half-up to the cent', () => {
    assert.equal(discountCents(999, 1000), 100); // 99.9  -> 100
    assert.equal(discountCents(994, 1000), 99); //  99.4  -> 99
    assert.equal(discountCents(995, 1000), 100); // 99.5  -> 100 (half-up)
    assert.equal(discountCents(1, 1250), 0); //     0.125 -> 0
    assert.equal(discountCents(4, 1250), 1); //     0.5   -> 1
  });

  it('never discounts more than the amount, so totals cannot go negative', () => {
    assert.equal(discountCents(12_345, 10_000), 12_345);
    assert.equal(discountCents(12_345, 25_000), 12_345); // misconfigured >100% is clamped
    assert.equal(discountCents(0, 1000), 0);
  });

  it('stays exact up to the largest supported amount and refuses beyond it', () => {
    // No 0.1 + 0.2 style errors: amounts are integer cents and bps are integers.
    assert.equal(lineTotalCents(1_999, 3), 5_997);
    // $9 billion at 100%: amount × bps is still a safe integer, so the result is exact.
    assert.equal(discountCents(90_000_000_000, 10_000), 90_000_000_000);
    // 90_071_992_547 × 0.3333 = 30_020_995_115.9151 -> 30_020_995_116 (cross-checked with BigInt).
    assert.equal(discountCents(90_071_992_547, 3_333), 30_020_995_116);
    // Past the safe range we fail loudly instead of returning an imprecise discount.
    assert.throws(() => discountCents(9_007_199_254_740_991, 3_333), /overflow/);
  });

  it('parses configured percentages into basis points without floats', () => {
    assert.equal(percentToBps('10'), 1000);
    assert.equal(percentToBps('12.5'), 1250);
    assert.equal(percentToBps('0.01'), 1);
    assert.equal(percentToBps('100'), 10_000);
    for (const bad of ['0', '100.01', '-5', 'abc', '1.234', '']) {
      assert.throws(() => percentToBps(bad), `expected "${bad}" to be rejected`);
    }
  });
});
