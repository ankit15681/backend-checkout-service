import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { type DB, inReadSnapshot, inTransaction, nowIso } from './db.ts';
import { errors } from './errors.ts';
import { many, one, run } from './sql.ts';

export interface CouponRow {
  code: string;
  milestone: number;
  order_threshold: number;
  discount_bps: number;
  created_at: string;
  redeemed_order_id: string | null;
  redeemed_at: string | null;
}

function couponView(c: CouponRow) {
  return {
    code: c.code,
    status: c.redeemed_order_id === null ? ('AVAILABLE' as const) : ('REDEEMED' as const),
    milestone: c.milestone,
    orderThreshold: c.order_threshold,
    percentBps: c.discount_bps,
    createdAt: c.created_at,
    redeemedOrderId: c.redeemed_order_id,
    redeemedAt: c.redeemed_at,
  };
}

/** Milestone k is reached once k * n orders have been placed. */
export function milestoneStatus(db: DB, config: Config) {
  const placedOrders = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM orders')!.n;
  const lastRewarded = one<{ m: number }>(db, 'SELECT COALESCE(MAX(milestone), 0) AS m FROM coupons')!.m;
  const reached = Math.floor(placedOrders / config.couponEveryNOrders);
  const next = lastRewarded + 1;
  return {
    everyNOrders: config.couponEveryNOrders,
    percentBps: config.couponDiscountBps,
    placedOrders,
    milestonesReached: reached,
    milestonesRewarded: lastRewarded,
    pendingGeneration: Math.max(0, reached - lastRewarded),
    nextMilestone: next,
    nextMilestoneOrderThreshold: next * config.couponEveryNOrders,
  };
}

/**
 * Generates exactly one coupon for the earliest reached-but-unrewarded milestone.
 * Runs under the write lock, and coupons.milestone is UNIQUE, so two concurrent
 * admin requests can never mint two coupons for the same milestone.
 */
export function generateCoupon(db: DB, config: Config) {
  return inTransaction(db, () => {
    const status = milestoneStatus(db, config);
    if (status.placedOrders < status.nextMilestoneOrderThreshold) throw errors.noEligibleMilestone(status);

    const code = newCouponCode();
    run(
      db,
      'INSERT INTO coupons (code, milestone, order_threshold, discount_bps, created_at) VALUES (?, ?, ?, ?, ?)',
      code, status.nextMilestone, status.nextMilestoneOrderThreshold, config.couponDiscountBps, nowIso(),
    );
    return couponView(one<CouponRow>(db, 'SELECT * FROM coupons WHERE code = ?', code)!);
  });
}

export function listCoupons(db: DB) {
  return inReadSnapshot(db, () => many<CouponRow>(db, 'SELECT * FROM coupons ORDER BY milestone').map(couponView));
}

// Crockford-style alphabet: no 0/O or 1/I/L confusion when a code is read aloud.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function newCouponCode(): string {
  const bytes = randomBytes(10);
  let suffix = '';
  for (const b of bytes) suffix += ALPHABET[b % ALPHABET.length];
  return `REWARD-${suffix}`;
}
