export interface Config {
  port: number;
  dbPath: string;
  /** A coupon becomes available after every n-th successfully placed order. */
  couponEveryNOrders: number;
  /** Coupon discount in basis points (10% = 1000 bps) so fractional percents stay integral. */
  couponDiscountBps: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInteger(env.PORT ?? '3000', 'PORT', 0),
    dbPath: env.DB_PATH ?? 'data/checkout.db',
    couponEveryNOrders: parseInteger(env.COUPON_EVERY_N_ORDERS ?? '5', 'COUPON_EVERY_N_ORDERS', 1),
    couponDiscountBps: percentToBps(env.COUPON_DISCOUNT_PERCENT ?? '10', 'COUPON_DISCOUNT_PERCENT'),
  };
}

function parseInteger(raw: string, name: string, min: number): number {
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return Number(raw);
}

/** "10" -> 1000, "12.5" -> 1250. At most two decimal places, range (0, 100]. */
export function percentToBps(raw: string, name = 'percent'): number {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`${name} must be a percentage with at most 2 decimals, got "${raw}"`);
  }
  const [whole, frac = ''] = raw.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (bps <= 0 || bps > 10_000) {
    throw new Error(`${name} must be in (0, 100], got "${raw}"`);
  }
  return bps;
}
