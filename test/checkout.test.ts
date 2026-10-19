import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { countBy, startServer } from './helpers.ts';

describe('checkout', () => {
  let api: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => (api = await startServer()));
  afterEach(() => api.close());

  it('creates an order whose snapshot survives later product changes', async () => {
    const cartId = await api.createCart([['keyboard', 2], ['usb-c-cable', 3]]);
    const res = await api.checkout(cartId);

    assert.equal(res.status, 201);
    assert.equal(res.headers.get('location'), `/orders/${res.body.id}`);
    assert.equal(res.body.subtotalCents, 2 * 7_999 + 3 * 999);
    assert.equal(res.body.totalCents, res.body.subtotalCents);
    assert.equal(await api.inventory('keyboard'), 48);

    await api.call('PATCH', '/admin/products/keyboard', { priceCents: 1 });
    const order = (await api.call('GET', `/orders/${res.body.id}`)).body;
    assert.deepEqual(order, res.body);
    assert.equal(order.items.find((i: { productId: string }) => i.productId === 'keyboard').unitPriceCents, 7_999);
  });

  it('refuses to charge a price the customer did not see, until the line is re-confirmed', async () => {
    const cartId = await api.createCart([['monitor', 1]]);
    await api.call('PATCH', '/admin/products/monitor', { priceCents: 34_999 });

    const view = await api.getCart(cartId);
    assert.equal(view.checkoutReady, false);
    assert.deepEqual(view.issues, [{ productId: 'monitor', code: 'PRICE_CHANGED' }]);

    const refused = await api.checkout(cartId);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'PRICE_CHANGED');
    assert.deepEqual(refused.body.error.details.items, [
      { productId: 'monitor', quotedUnitPriceCents: 32_999, currentUnitPriceCents: 34_999 },
    ]);
    assert.equal(await api.inventory('monitor'), 20);

    await api.call('PATCH', `/carts/${cartId}/items/monitor`, { quantity: 1 }); // re-quote
    const placed = await api.checkout(cartId);
    assert.equal(placed.status, 201);
    assert.equal(placed.body.totalCents, 34_999);
  });

  it('fails a multi-line checkout atomically when any line is short of stock', async () => {
    const slow = await api.createCart([['mouse', 2], ['limited-sneakers', 3]]);
    const fast = await api.createCart([['limited-sneakers', 1]]);
    assert.equal((await api.checkout(fast)).status, 201);

    const res = await api.checkout(slow);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
    assert.deepEqual(res.body.error.details.items, [{ productId: 'limited-sneakers', requested: 3, available: 2 }]);

    // Nothing from the failed attempt leaked: mouse untouched, cart still open and fixable.
    assert.equal(await api.inventory('mouse'), 100);
    assert.equal((await api.getCart(slow)).status, 'OPEN');
    await api.call('PATCH', `/carts/${slow}/items/limited-sneakers`, { quantity: 2 });
    assert.equal((await api.checkout(slow)).status, 201);
    assert.equal(await api.inventory('limited-sneakers'), 0);
  });

  it('rejects an empty cart', async () => {
    const res = await api.checkout(await api.createCart());
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'CART_EMPTY');
  });

  it('replays the original order when the same checkout is retried', async () => {
    const cartId = await api.createCart([['headphones', 2]]);
    const first = await api.checkout(cartId);
    const retry = await api.checkout(cartId);

    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replayed'), 'false');
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(retry.body, first.body);
    assert.equal(await api.inventory('headphones'), 8); // charged once
    assert.equal((await api.report()).placedOrders, 1);

    // A different request against the same cart is not a retry.
    const different = await api.checkout(cartId, 'REWARD-ANYTHING');
    assert.equal(different.status, 409);
    assert.equal(different.body.error.code, 'CART_ALREADY_CHECKED_OUT');
    assert.equal(different.body.error.details.orderId, first.body.id);
  });

  it('creates exactly one order when the same cart is checked out concurrently', async () => {
    const cartId = await api.createCart([['headphones', 1]]);
    const results = await Promise.all(Array.from({ length: 25 }, () => api.checkout(cartId)));

    assert.deepEqual(countBy(results.map((r) => r.status)), new Map([[201, 1], [200, 24]]));
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(await api.inventory('headphones'), 9);
    assert.equal((await api.report()).placedOrders, 1);
  });

  it('never oversells limited stock under concurrent checkouts', async () => {
    const carts = await Promise.all(Array.from({ length: 15 }, () => api.createCart([['limited-sneakers', 1]])));
    const results = await Promise.all(carts.map((c) => api.checkout(c)));

    const outcomes = countBy(results.map((r) => r.body.error?.code ?? r.status));
    assert.deepEqual(outcomes, new Map<unknown, number>([[201, 3], ['INSUFFICIENT_STOCK', 12]]));
    assert.equal(await api.inventory('limited-sneakers'), 0);
    const report = await api.report();
    assert.equal(report.placedOrders, 3);
    assert.equal(report.productsPurchased.find((p: { productId: string }) => p.productId === 'limited-sneakers').quantity, 3);
  });
});
