import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer } from './helpers.ts';

interface Order {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  items: { productId: string; quantity: number }[];
}

describe('admin report', () => {
  let api: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    api = await startServer({ everyNOrders: 2, discountPercent: '12.5' });
    // Mixed workload: plain orders, discounted orders, failed checkouts, a retry,
    // an unredeemed coupon and a price change between orders.
    await api.placeOrders(2);
    const c1 = await api.generateCoupon();
    const soldOutLater = await api.createCart([['limited-sneakers', 1]]);
    await api.checkout(await api.createCart([['keyboard', 1], ['mouse', 3]]), c1);
    await api.call('PATCH', '/admin/products/mouse', { priceCents: 1_999 });
    const retried = await api.createCart([['mouse', 2], ['limited-sneakers', 2]]);
    await api.checkout(retried);
    await api.checkout(retried);
    await api.checkout(await api.createCart([['limited-sneakers', 1]]), c1); // fails: coupon used
    await api.checkout(await api.createCart([['limited-sneakers', 1]]));
    await api.checkout(soldOutLater); // fails: sold out since it was added
    await api.generateCoupon(); // milestone 2 (4 orders), left unredeemed
  });
  after(() => api.close());

  it('reconciles with the orders and coupons the API returns', async () => {
    const report = await api.report();
    const orders: Order[] = (await api.call('GET', '/admin/orders')).body.orders;
    const coupons: { status: string }[] = (await api.call('GET', '/admin/coupons')).body.coupons;
    const sum = (f: (o: Order) => number) => orders.reduce((acc, o) => acc + f(o), 0);

    assert.equal(report.placedOrders, 5);
    assert.equal(report.placedOrders, orders.length);
    assert.equal(report.revenue.grossCents, sum((o) => o.subtotalCents));
    assert.equal(report.revenue.discountsCents, sum((o) => o.discountCents));
    assert.equal(report.revenue.netCents, sum((o) => o.totalCents));
    assert.equal(report.revenue.netCents, report.revenue.grossCents - report.revenue.discountsCents);
    assert.ok(report.revenue.discountsCents > 0);

    for (const p of report.productsPurchased) {
      const fromOrders = sum((o) => o.items.filter((i) => i.productId === p.productId).reduce((a, i) => a + i.quantity, 0));
      assert.equal(p.quantity, fromOrders, p.productId);
    }
    assert.equal(
      report.productsPurchased.reduce((a: number, p: { grossRevenueCents: number }) => a + p.grossRevenueCents, 0),
      report.revenue.grossCents,
    );

    assert.deepEqual(report.coupons, {
      generated: coupons.length,
      available: coupons.filter((c) => c.status === 'AVAILABLE').length,
      redeemed: coupons.filter((c) => c.status === 'REDEEMED').length,
    });
    assert.deepEqual(report.coupons, { generated: 2, available: 1, redeemed: 1 });
  });

  it('is read-only: repeated requests return the same figures and change nothing', async () => {
    const before = { products: (await api.call('GET', '/products')).body, coupons: (await api.call('GET', '/admin/coupons')).body };
    const reports = await Promise.all(Array.from({ length: 5 }, () => api.report()));
    const after = { products: (await api.call('GET', '/products')).body, coupons: (await api.call('GET', '/admin/coupons')).body };

    const strip = ({ generatedAt: _, ...rest }: { generatedAt: string }) => rest;
    for (const r of reports) assert.deepEqual(strip(r), strip(reports[0]));
    assert.deepEqual(after, before);
  });
});
