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
 * Percentage discount on an amount, rounded half-up to the nearest cent. Plain integer
 * arithmetic is exact while `amount × bps` stays a safe integer, which the bounds above
 * guarantee for any realistic order (up to ~$9 billion at 100%); beyond that we throw
 * rather than silently lose precision. Subtracting the remainder first makes the
 * division exact. Clamped to the amount so a total can never go negative, even if bps
 * were misconfigured above 100%.
 */
export function discountCents(amountCents: number, bps: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error(`invalid amount ${amountCents}`);
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`invalid bps ${bps}`);
  const scaled = assertSafeCents(amountCents * bps + 5_000); // + half of 10_000 = round half-up
  return Math.min((scaled - (scaled % 10_000)) / 10_000, amountCents);
}

function assertSafeCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`money overflow or negative amount: ${value}`);
  return value;
}
