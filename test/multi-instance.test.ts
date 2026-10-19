import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openDatabase } from '../src/db.ts';
import { countBy, spawnInstance, tempDbPath } from './helpers.ts';

/**
 * In-process tests serialise on one Node event loop. Here three separate OS processes
 * share one database file, so checkouts genuinely race each other for the write lock,
 * which is the shape of a horizontally scaled deployment.
 */
describe('multiple service instances sharing one database', () => {
  const { dbPath, cleanup } = tempDbPath();
  let instances: Awaited<ReturnType<typeof spawnInstance>>[] = [];
  const pick = (i: number) => instances[i % instances.length]!;

  before(async () => {
    openDatabase(dbPath).close(); // create schema + seed once, up front
    instances = await Promise.all([1, 2, 3].map(() => spawnInstance(dbPath, { COUPON_EVERY_N_ORDERS: '1' })));
  });
  after(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    cleanup();
  });

  it('never oversells when checkouts arrive at different instances', async () => {
    const carts = await Promise.all(Array.from({ length: 30 }, (_, i) => pick(i).createCart([['limited-sneakers', 1]])));
    const results = await Promise.all(carts.map((cartId, i) => pick(i + 1).checkout(cartId)));

    const outcomes = countBy(results.map((r) => r.body.error?.code ?? r.status));
    assert.deepEqual(outcomes, new Map<unknown, number>([[201, 3], ['INSUFFICIENT_STOCK', 27]]));
    for (const instance of instances) assert.equal(await instance.inventory('limited-sneakers'), 0);
    // Losing checkouts must leave no trace (no half-written orders).
    const report = await pick(0).report();
    assert.equal(report.placedOrders, 3);
    assert.equal((await pick(0).call('GET', '/admin/orders')).body.orders.length, 3);
  });

  it('creates one order when retries of the same checkout hit every instance', async () => {
    const cartId = await pick(0).createCart([['monitor', 1]]);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => pick(i).checkout(cartId)));

    assert.deepEqual(countBy(results.map((r) => r.status)), new Map([[201, 1], [200, 29]]));
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(await pick(2).inventory('monitor'), 19);
  });

  it('lets one checkout win a coupon raced across instances', async () => {
    const code = await pick(0).generateCoupon();
    const carts = await Promise.all(Array.from({ length: 30 }, (_, i) => pick(i).createCart([['mouse', 1]])));
    const results = await Promise.all(carts.map((cartId, i) => pick(i + 2).checkout(cartId, code)));

    const outcomes = countBy(results.map((r) => r.body.error?.code ?? r.status));
    assert.deepEqual(outcomes, new Map<unknown, number>([[201, 1], ['COUPON_ALREADY_REDEEMED', 29]]));
    const report = await pick(1).report();
    assert.equal(report.coupons.redeemed, 1);
    assert.equal(report.placedOrders, 3 + 1 + 1);
  });
});
