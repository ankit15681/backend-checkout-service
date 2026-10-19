import { type DB, inTransaction, nowIso } from './db.ts';
import { AppError, errors } from './errors.ts';
import { CURRENCY } from './money.ts';
import { many, one, run } from './sql.ts';

export interface ProductRow {
  id: string;
  name: string;
  price_cents: number;
  inventory: number;
  updated_at: string;
}

export function productView(p: ProductRow) {
  return {
    id: p.id,
    name: p.name,
    unitPriceCents: p.price_cents,
    currency: CURRENCY,
    availableInventory: p.inventory,
    updatedAt: p.updated_at,
  };
}

export function listProducts(db: DB) {
  return many<ProductRow>(db, 'SELECT * FROM products ORDER BY id').map(productView);
}

export function getProduct(db: DB, productId: string) {
  const row = one<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', productId);
  if (!row) throw errors.productNotFound(productId);
  return productView(row);
}

/**
 * Admin change of price and/or stock. Stock changes are deltas, not absolute values:
 * "set inventory to 10" computed from a stale read would silently undo sales that
 * committed in between, whereas "add 7" composes correctly with concurrent checkouts.
 */
export function updateProduct(db: DB, productId: string, patch: { priceCents?: number; inventoryDelta?: number }) {
  return inTransaction(db, () => {
    const now = nowIso();
    if (!one(db, 'SELECT 1 FROM products WHERE id = ?', productId)) throw errors.productNotFound(productId);
    if (patch.priceCents !== undefined) {
      run(db, 'UPDATE products SET price_cents = ?, updated_at = ? WHERE id = ?', patch.priceCents, now, productId);
    }
    if (patch.inventoryDelta !== undefined) {
      const changed = run(
        db,
        'UPDATE products SET inventory = inventory + ?, updated_at = ? WHERE id = ? AND inventory + ? >= 0',
        patch.inventoryDelta, now, productId, patch.inventoryDelta,
      );
      if (changed !== 1) {
        throw new AppError(409, 'INVENTORY_WOULD_GO_NEGATIVE', 'Adjustment would make inventory negative', {
          productId,
          inventoryDelta: patch.inventoryDelta,
        });
      }
    }
    return getProduct(db, productId);
  });
}
