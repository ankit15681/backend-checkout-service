import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer } from './helpers.ts';

describe('carts', () => {
  let api: Awaited<ReturnType<typeof startServer>>;
  before(async () => (api = await startServer()));
  after(() => api.close());

  it('rejects invalid products and quantities without changing the cart', async () => {
    const cartId = await api.createCart();
    const attempts: [unknown, string, number][] = [
      [{ productId: 'mouse', quantity: 0 }, 'VALIDATION_ERROR', 400],
      [{ productId: 'mouse', quantity: -1 }, 'VALIDATION_ERROR', 400],
      [{ productId: 'mouse', quantity: 2.5 }, 'VALIDATION_ERROR', 400],
      [{ productId: 'mouse', quantity: '2' }, 'VALIDATION_ERROR', 400],
      [{ productId: 'mouse', quantity: 1001 }, 'VALIDATION_ERROR', 400],
      [{ productId: 'mouse' }, 'VALIDATION_ERROR', 400],
      [{ quantity: 1 }, 'VALIDATION_ERROR', 400],
      [[{ productId: 'mouse', quantity: 1 }], 'VALIDATION_ERROR', 400],
      [{ productId: 'does-not-exist', quantity: 1 }, 'PRODUCT_NOT_FOUND', 404],
      [{ productId: 'limited-sneakers', quantity: 4 }, 'INSUFFICIENT_STOCK', 409],
    ];
    for (const [body, code, status] of attempts) {
      const res = await api.call('POST', `/carts/${cartId}/items`, body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(res.body.error.code, code, JSON.stringify(body));
    }
    const cart = await api.getCart(cartId);
    assert.deepEqual(cart.items, []);
    assert.equal(cart.subtotalCents, 0);
  });

  it('distinguishes add (not repeatable) from set-quantity and remove (idempotent)', async () => {
    const cartId = await api.createCart([['mouse', 1]]);

    const dup = await api.call('POST', `/carts/${cartId}/items`, { productId: 'mouse', quantity: 1 });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'ITEM_ALREADY_IN_CART');

    for (let i = 0; i < 2; i++) {
      const res = await api.call('PATCH', `/carts/${cartId}/items/mouse`, { quantity: 3 });
      assert.equal(res.status, 200);
      assert.equal(res.body.items[0].quantity, 3);
      assert.equal(res.body.subtotalCents, 3 * 2_499);
    }

    for (let i = 0; i < 2; i++) {
      const res = await api.call('DELETE', `/carts/${cartId}/items/mouse`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items, []);
    }

    const missing = await api.call('PATCH', `/carts/${cartId}/items/mouse`, { quantity: 1 });
    assert.equal(missing.body.error.code, 'ITEM_NOT_IN_CART');
  });

  it('freezes a cart once it has been checked out', async () => {
    const cartId = await api.createCart([['mouse', 1]]);
    const order = (await api.checkout(cartId)).body;

    const attempts = [
      api.call('POST', `/carts/${cartId}/items`, { productId: 'keyboard', quantity: 1 }),
      api.call('PATCH', `/carts/${cartId}/items/mouse`, { quantity: 5 }),
      api.call('DELETE', `/carts/${cartId}/items/mouse`),
    ];
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'CART_NOT_OPEN');
      assert.equal(res.body.error.details.orderId, order.id);
    }
    const cart = await api.getCart(cartId);
    assert.equal(cart.status, 'CHECKED_OUT');
    assert.equal(cart.orderId, order.id);
  });

  it('returns distinguishable errors for unknown resources and malformed bodies', async () => {
    assert.equal((await api.call('GET', '/carts/nope')).body.error.code, 'CART_NOT_FOUND');
    assert.equal((await api.call('GET', '/orders/nope')).body.error.code, 'ORDER_NOT_FOUND');
    assert.equal((await api.call('POST', '/carts/nope/checkout')).body.error.code, 'CART_NOT_FOUND');

    const malformed = await fetch(`${api.baseUrl}/carts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    const body = await malformed.json();
    assert.equal(body.error.code, 'INVALID_JSON');
    assert.ok(body.error.requestId);
  });
});
