import { randomUUID } from 'node:crypto';
import { cartLines, findCart } from './carts.ts';
import type { CouponRow } from './coupons.ts';
import { type DB, inReadSnapshot, inTransaction, nowIso } from './db.ts';
import { errors, type PriceChange, type StockShortfall } from './errors.ts';
import { CURRENCY, discountCents, lineTotalCents, sumCents } from './money.ts';
import { many, one, run } from './sql.ts';

interface OrderRow {
  id: string;
  cart_id: string;
  subtotal_cents: number;
  coupon_code: string | null;
  discount_bps: number | null;
  discount_cents: number;
  total_cents: number;
  created_at: string;
}

interface OrderItemRow {
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
}

export type OrderView = ReturnType<typeof orderView>;

function orderView(o: OrderRow, items: OrderItemRow[]) {
  return {
    id: o.id,
    cartId: o.cart_id,
    status: 'PLACED' as const,
    currency: CURRENCY,
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.product_name,
      unitPriceCents: i.unit_price_cents,
      quantity: i.quantity,
      lineTotalCents: i.line_total_cents,
    })),
    subtotalCents: o.subtotal_cents,
    discount:
      o.coupon_code === null
        ? null
        : { couponCode: o.coupon_code, percentBps: o.discount_bps, amountCents: o.discount_cents },
    discountCents: o.discount_cents,
    totalCents: o.total_cents,
    createdAt: o.created_at,
  };
}

function loadOrder(db: DB, orderId: string): OrderView {
  const order = one<OrderRow>(db, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw errors.orderNotFound(orderId);
  const items = many<OrderItemRow>(db, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id', orderId);
  return orderView(order, items);
}

export function getOrder(db: DB, orderId: string): OrderView {
  return inReadSnapshot(db, () => loadOrder(db, orderId));
}

export function listOrders(db: DB): OrderView[] {
  return inReadSnapshot(db, () => {
    const items = many<OrderItemRow>(db, 'SELECT * FROM order_items ORDER BY order_id, product_id');
    return many<OrderRow>(db, 'SELECT * FROM orders ORDER BY created_at, id').map((o) =>
      orderView(o, items.filter((i) => i.order_id === o.id)),
    );
  });
}

export function normalizeCouponCode(code: string | null | undefined): string | null {
  const trimmed = code?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export interface CheckoutResult {
  order: OrderView;
  /** True when this call returned an order created by an earlier identical request. */
  replayed: boolean;
}

/**
 * Turns an OPEN cart into an order, atomically.
 *
 * Everything — validation, inventory decrement, coupon redemption, order snapshot and
 * the cart's OPEN -> CHECKED_OUT transition — happens inside one write transaction.
 * Either all of it commits or none of it does, so a failed checkout cannot consume
 * stock or a coupon.
 *
 * Idempotency: the cart is the idempotency key. A cart yields at most one order
 * (orders.cart_id is UNIQUE), and repeating the same checkout request for an
 * already-checked-out cart returns the original order instead of creating another.
 */
export function checkout(db: DB, cartId: string, rawCouponCode: string | null): CheckoutResult {
  const couponCode = normalizeCouponCode(rawCouponCode);

  return inTransaction(db, () => {
    const cart = findCart(db, cartId);

    if (cart.status === 'CHECKED_OUT') {
      const existing = one<OrderRow>(db, 'SELECT * FROM orders WHERE cart_id = ?', cartId);
      if (!existing) throw new Error(`cart ${cartId} is CHECKED_OUT without an order`);
      // Same request again (e.g. client timed out and retried): replay the result.
      if (existing.coupon_code === couponCode) return { order: loadOrder(db, existing.id), replayed: true };
      // Different parameters: this is not a retry, refuse rather than guess.
      throw errors.cartAlreadyCheckedOut(cartId, existing.id);
    }

    const lines = cartLines(db, cartId);
    if (lines.length === 0) throw errors.cartEmpty(cartId);

    let coupon: CouponRow | undefined;
    if (couponCode !== null) {
      coupon = one<CouponRow>(db, 'SELECT * FROM coupons WHERE code = ?', couponCode);
      if (!coupon) throw errors.couponNotFound(couponCode);
      if (coupon.redeemed_order_id !== null) throw errors.couponAlreadyRedeemed(couponCode);
    }

    const priceChanges: PriceChange[] = lines
      .filter((l) => l.quoted_unit_price_cents !== l.price_cents)
      .map((l) => ({
        productId: l.product_id,
        quotedUnitPriceCents: l.quoted_unit_price_cents,
        currentUnitPriceCents: l.price_cents,
      }));
    if (priceChanges.length > 0) throw errors.priceChanged(priceChanges);

    const shortfalls: StockShortfall[] = lines
      .filter((l) => l.inventory < l.quantity)
      .map((l) => ({ productId: l.product_id, requested: l.quantity, available: l.inventory }));
    if (shortfalls.length > 0) throw errors.insufficientStock(shortfalls);

    const subtotal = sumCents(lines.map((l) => lineTotalCents(l.price_cents, l.quantity)));
    const discount = coupon ? discountCents(subtotal, coupon.discount_bps) : 0;
    const total = subtotal - discount;

    const orderId = randomUUID();
    const now = nowIso();
    run(
      db,
      `INSERT INTO orders (id, cart_id, subtotal_cents, coupon_code, discount_bps, discount_cents, total_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId, cartId, subtotal, couponCode, coupon?.discount_bps ?? null, discount, total, now,
    );

    for (const l of lines) {
      run(
        db,
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
         VALUES (?, ?, ?, ?, ?, ?)`,
        orderId, l.product_id, l.name, l.price_cents, l.quantity, lineTotalCents(l.price_cents, l.quantity),
      );
      // Guarded decrement: correct even if a future change moved the check above out
      // of this transaction. The CHECK (inventory >= 0) constraint backs it up again.
      const decremented = run(
        db,
        'UPDATE products SET inventory = inventory - ?, updated_at = ? WHERE id = ? AND inventory >= ?',
        l.quantity, now, l.product_id, l.quantity,
      );
      if (decremented !== 1) {
        throw errors.insufficientStock([{ productId: l.product_id, requested: l.quantity, available: l.inventory }]);
      }
    }

    if (coupon) {
      const redeemed = run(
        db,
        'UPDATE coupons SET redeemed_order_id = ?, redeemed_at = ? WHERE code = ? AND redeemed_order_id IS NULL',
        orderId, now, coupon.code,
      );
      if (redeemed !== 1) throw errors.couponAlreadyRedeemed(coupon.code);
    }

    const closed = run(db, "UPDATE carts SET status = 'CHECKED_OUT', updated_at = ? WHERE id = ? AND status = 'OPEN'", now, cartId);
    if (closed !== 1) throw new Error(`cart ${cartId} changed state during checkout`);

    return { order: loadOrder(db, orderId), replayed: false };
  });
}
