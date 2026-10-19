import type { Config } from './config.ts';
import { milestoneStatus } from './coupons.ts';
import { type DB, inReadSnapshot } from './db.ts';
import { CURRENCY } from './money.ts';
import { many, one } from './sql.ts';

/**
 * Admin summary. Pure reads inside one snapshot, so the numbers are mutually
 * consistent even while checkouts commit concurrently, and asking twice changes nothing.
 * Revenue figures are aggregated from the order snapshots, never from current prices.
 */
export function getReport(db: DB, config: Config) {
  return inReadSnapshot(db, () => {
    const totals = one<{ orders: number; gross: number; discounts: number; net: number }>(
      db,
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(subtotal_cents), 0) AS gross,
              COALESCE(SUM(discount_cents), 0) AS discounts,
              COALESCE(SUM(total_cents), 0) AS net
         FROM orders`,
    )!;
    const products = many<{ id: string; name: string; quantity: number; gross: number }>(
      db,
      `SELECT p.id, p.name,
              COALESCE(SUM(oi.quantity), 0) AS quantity,
              COALESCE(SUM(oi.line_total_cents), 0) AS gross
         FROM products p LEFT JOIN order_items oi ON oi.product_id = p.id
        GROUP BY p.id, p.name
        ORDER BY p.id`,
    );
    const coupons = one<{ generated: number; redeemed: number }>(
      db,
      'SELECT COUNT(*) AS generated, COUNT(redeemed_order_id) AS redeemed FROM coupons',
    )!;

    return {
      generatedAt: new Date().toISOString(),
      currency: CURRENCY,
      placedOrders: totals.orders,
      productsPurchased: products.map((p) => ({
        productId: p.id,
        name: p.name,
        quantity: p.quantity,
        grossRevenueCents: p.gross,
      })),
      revenue: {
        grossCents: totals.gross,
        discountsCents: totals.discounts,
        netCents: totals.net,
      },
      coupons: {
        generated: coupons.generated,
        available: coupons.generated - coupons.redeemed,
        redeemed: coupons.redeemed,
      },
      milestones: milestoneStatus(db, config),
    };
  });
}
