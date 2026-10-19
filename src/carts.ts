import { randomUUID } from 'node:crypto';
import { type DB, inReadSnapshot, inTransaction, nowIso } from './db.ts';
import { errors } from './errors.ts';
import { CURRENCY, lineTotalCents, sumCents } from './money.ts';
import type { ProductRow } from './products.ts';
import { many, one, run } from './sql.ts';

export interface CartRow {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  created_at: string;
  updated_at: string;
}

/** A cart line joined with the product's *current* state. */
export interface CartLineRow {
  product_id: string;
  quantity: number;
  quoted_unit_price_cents: number;
  name: string;
  price_cents: number;
  inventory: number;
}

export function cartLines(db: DB, cartId: string): CartLineRow[] {
  return many<CartLineRow>(
    db,
    `SELECT ci.product_id, ci.quantity, ci.quoted_unit_price_cents, p.name, p.price_cents, p.inventory
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = ?
      ORDER BY ci.product_id`,
    cartId,
  );
}

export function findCart(db: DB, cartId: string): CartRow {
  const cart = one<CartRow>(db, 'SELECT * FROM carts WHERE id = ?', cartId);
  if (!cart) throw errors.cartNotFound(cartId);
  return cart;
}

function orderIdForCart(db: DB, cartId: string): string | null {
  return one<{ id: string }>(db, 'SELECT id FROM orders WHERE cart_id = ?', cartId)?.id ?? null;
}

function requireOpenCart(db: DB, cartId: string): CartRow {
  const cart = findCart(db, cartId);
  if (cart.status !== 'OPEN') throw errors.cartNotOpen(cartId, orderIdForCart(db, cartId));
  return cart;
}

function requireProduct(db: DB, productId: string): ProductRow {
  const product = one<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', productId);
  if (!product) throw errors.productNotFound(productId);
  return product;
}

/**
 * Early stock check for fast feedback. It is advisory only: carts do not reserve stock,
 * so checkout re-validates under the write lock.
 */
function requireStock(product: ProductRow, quantity: number): void {
  if (product.inventory < quantity) {
    throw errors.insufficientStock([{ productId: product.id, requested: quantity, available: product.inventory }]);
  }
}

function touch(db: DB, cartId: string): void {
  run(db, 'UPDATE carts SET updated_at = ? WHERE id = ?', nowIso(), cartId);
}

export function cartView(db: DB, cart: CartRow) {
  const lines = cartLines(db, cart.id);
  const open = cart.status === 'OPEN';
  const issues: { productId: string; code: 'PRICE_CHANGED' | 'INSUFFICIENT_STOCK' }[] = [];
  const items = lines.map((l) => {
    const priceChanged = l.quoted_unit_price_cents !== l.price_cents;
    // Only an increase blocks checkout; a drop is passed on to the customer.
    if (open && l.price_cents > l.quoted_unit_price_cents) issues.push({ productId: l.product_id, code: 'PRICE_CHANGED' });
    if (open && l.inventory < l.quantity) issues.push({ productId: l.product_id, code: 'INSUFFICIENT_STOCK' });
    // What checkout charges: the quoted price, or the current one if it has dropped.
    // A checked-out cart's lines were frozen at the charged price.
    const unitPriceCents = open ? Math.min(l.quoted_unit_price_cents, l.price_cents) : l.quoted_unit_price_cents;
    return {
      productId: l.product_id,
      name: l.name,
      quantity: l.quantity,
      unitPriceCents,
      quotedUnitPriceCents: l.quoted_unit_price_cents,
      currentUnitPriceCents: l.price_cents,
      priceChanged,
      availableInventory: l.inventory,
      lineTotalCents: lineTotalCents(unitPriceCents, l.quantity),
    };
  });
  return {
    id: cart.id,
    status: cart.status,
    orderId: open ? null : orderIdForCart(db, cart.id),
    currency: CURRENCY,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    subtotalCents: sumCents(items.map((i) => i.lineTotalCents)),
    checkoutReady: open && items.length > 0 && issues.length === 0,
    issues,
    createdAt: cart.created_at,
    updatedAt: cart.updated_at,
  };
}

export function createCart(db: DB) {
  return inTransaction(db, () => {
    const id = randomUUID();
    const now = nowIso();
    run(db, "INSERT INTO carts (id, status, created_at, updated_at) VALUES (?, 'OPEN', ?, ?)", id, now, now);
    return cartView(db, findCart(db, id));
  });
}

export function getCart(db: DB, cartId: string) {
  return inReadSnapshot(db, () => cartView(db, findCart(db, cartId)));
}

/** Adds a new line. Not an upsert: a retried "add 1" must not silently become 2. */
export function addItem(db: DB, cartId: string, productId: string, quantity: number) {
  return inTransaction(db, () => {
    const cart = requireOpenCart(db, cartId);
    const product = requireProduct(db, productId);
    if (one(db, 'SELECT 1 FROM cart_items WHERE cart_id = ? AND product_id = ?', cartId, productId)) {
      throw errors.itemAlreadyInCart(productId);
    }
    requireStock(product, quantity);
    run(
      db,
      'INSERT INTO cart_items (cart_id, product_id, quantity, quoted_unit_price_cents) VALUES (?, ?, ?, ?)',
      cartId, productId, quantity, product.price_cents,
    );
    touch(db, cartId);
    return cartView(db, findCart(db, cart.id));
  });
}

/**
 * Sets an absolute quantity (idempotent). Also re-quotes the line at the current
 * price, which is how a client acknowledges a PRICE_CHANGED error.
 */
export function setItemQuantity(db: DB, cartId: string, productId: string, quantity: number) {
  return inTransaction(db, () => {
    requireOpenCart(db, cartId);
    if (!one(db, 'SELECT 1 FROM cart_items WHERE cart_id = ? AND product_id = ?', cartId, productId)) {
      throw errors.itemNotInCart(productId);
    }
    const product = requireProduct(db, productId);
    requireStock(product, quantity);
    run(
      db,
      'UPDATE cart_items SET quantity = ?, quoted_unit_price_cents = ? WHERE cart_id = ? AND product_id = ?',
      quantity, product.price_cents, cartId, productId,
    );
    touch(db, cartId);
    return cartView(db, findCart(db, cartId));
  });
}

/** Idempotent: removing a line that is not there is a no-op, so retries are safe. */
export function removeItem(db: DB, cartId: string, productId: string) {
  return inTransaction(db, () => {
    requireOpenCart(db, cartId);
    if (run(db, 'DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', cartId, productId) > 0) {
      touch(db, cartId);
    }
    return cartView(db, findCart(db, cartId));
  });
}
