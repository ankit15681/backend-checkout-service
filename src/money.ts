// All money is integer minor units (cents). Floats never touch a stored amount.

export const CURRENCY = 'USD';

/** Upper bounds keep every intermediate product well inside Number.MAX_SAFE_INTEGER. */
export const MAX_UNIT_PRICE_CENTS = 100_000_000; // $1,000,000.00
export const MAX_LINE_QUANTITY = 1_000;

export function lineTotalCents(unitPriceCents: number, quantity: number): number {
  return assertSafeCents(unitPriceCents * quantity);
}

export function sumCents(values: number[]): number {
  return assertSafeCents(values.reduce((acc, v) => acc + v, 0));
}

/**
 * Percentage discount on an amount, rounded half-up to the nearest cent, computed
 * with BigInt so the multiplication can never lose precision. Clamped to the amount
 * so a total can never go negative, even if bps were misconfigured above 100%.
 */
export function discountCents(amountCents: number, bps: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error(`invalid amount ${amountCents}`);
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`invalid bps ${bps}`);
  const raw = (BigInt(amountCents) * BigInt(bps) + 5_000n) / 10_000n;
  return Math.min(Number(raw), amountCents);
}

function assertSafeCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`money overflow or negative amount: ${value}`);
  return value;
}
