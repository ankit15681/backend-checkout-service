import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { countBy, startServer } from './helpers.ts';

describe('coupons', () => {
  let api: Awaited<ReturnType<typeof startServer>>;
  afterEach(() => api.close());

  it('generates exactly one coupon per reached milestone', async () => {
    api = await startServer({ everyNOrders: 2 });
    const generate = () => api.call('POST', '/admin/coupons');

    assert.equal((await generate()).body.error.code, 'NO_ELIGIBLE_MILESTONE');
    await api.placeOrders(1);
    assert.equal((await generate()).status, 409);
    await api.placeOrders(1);

    const first = await generate();
    assert.equal(first.status, 201);
    assert.equal(first.body.milestone, 1);
    assert.equal(first.body.orderThreshold, 2);
    assert.equal(first.body.status, 'AVAILABLE');
    assert.equal((await generate()).body.error.code, 'NO_ELIGIBLE_MILESTONE');

    // Milestones the admin did not claim in time can still be claimed, one per request.
    await api.placeOrders(4);
    assert.equal((await generate()).body.milestone, 2);
    assert.equal((await generate()).body.milestone, 3);
    assert.equal((await generate()).status, 409);
  });

  it('mints a single coupon when admins request generation concurrently', async () => {
    api = await startServer({ everyNOrders: 2 });
    await api.placeOrders(2);
    const results = await Promise.all(Array.from({ length: 10 }, () => api.call('POST', '/admin/coupons')));

    assert.deepEqual(countBy(results.map((r) => r.status)), new Map([[201, 1], [409, 9]]));
    assert.equal((await api.call('GET', '/admin/coupons')).body.coupons.length, 1);
  });

  it('replays a retried generation that carries the same Idempotency-Key', async () => {
    api = await startServer({ everyNOrders: 1 });
    await api.placeOrders(3); // three milestones pending: a blind retry would mint another
    const generate = (key?: string) =>
      api.call('POST', '/admin/coupons', undefined, key === undefined ? {} : { 'Idempotency-Key': key });

    const first = await generate('gen-1');
    const retry = await generate('gen-1');
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(retry.body, first.body);

    // A new key (or no key) is a new request and claims the next milestone.
    assert.equal((await generate('gen-2')).body.milestone, 2);
    assert.equal((await generate()).body.milestone, 3);
    assert.equal((await api.call('GET', '/admin/coupons')).body.coupons.length, 3);

    const bad = await generate('x'.repeat(129));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  });

  it('mints one coupon when retries with the same key race each other', async () => {
    api = await startServer({ everyNOrders: 1 });
    await api.placeOrders(5);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.call('POST', '/admin/coupons', undefined, { 'Idempotency-Key': 'same' })),
    );

    assert.deepEqual(countBy(results.map((r) => r.status)), new Map([[201, 1], [200, 9]]));
    assert.equal(new Set(results.map((r) => r.body.code)).size, 1);
    assert.equal((await api.call('GET', '/admin/coupons')).body.coupons.length, 1);
  });

  it('remembers only successful generations, so a key can be retried after a 409', async () => {
    api = await startServer({ everyNOrders: 2 });
    await api.placeOrders(1);
    const generate = () => api.call('POST', '/admin/coupons', undefined, { 'Idempotency-Key': 'early' });

    assert.equal((await generate()).body.error.code, 'NO_ELIGIBLE_MILESTONE');
    await api.placeOrders(1);
    assert.equal((await generate()).status, 201);
  });

  it('applies a deterministic, half-up rounded discount and redeems only once', async () => {
    api = await startServer({ everyNOrders: 1, discountPercent: '10' });
    await api.placeOrders(1);
    const code = await api.generateCoupon();

    const cartId = await api.createCart([['usb-c-cable', 1]]);
    const res = await api.checkout(cartId, `  ${code.toLowerCase()} `); // codes are normalised
    assert.equal(res.status, 201);
    assert.equal(res.body.subtotalCents, 999);
    assert.deepEqual(res.body.discount, { couponCode: code, percentBps: 1000, amountCents: 100 }); // 99.9 -> 100
    assert.equal(res.body.totalCents, 899);

    // An identical retry replays; it does not count as a second redemption.
    const retry = await api.checkout(cartId, code);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, res.body.id);

    const reuse = await api.checkout(await api.createCart([['mouse', 1]]), code);
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.error.code, 'COUPON_ALREADY_REDEEMED');

    const unknown = await api.checkout(await api.createCart([['mouse', 1]]), 'REWARD-NOPE');
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.code, 'COUPON_NOT_FOUND');
  });

  it('never makes a total negative, even with a 100% coupon', async () => {
    api = await startServer({ everyNOrders: 1, discountPercent: '100' });
    await api.placeOrders(1);
    const code = await api.generateCoupon();
    const res = await api.checkout(await api.createCart([['monitor', 1]]), code);
    assert.equal(res.body.discountCents, 32_999);
    assert.equal(res.body.totalCents, 0);
  });

  it('does not consume a coupon when the checkout fails', async () => {
    api = await startServer({ everyNOrders: 1 });
    await api.placeOrders(1);
    const code = await api.generateCoupon();

    const doomed = await api.createCart([['mouse', 1], ['limited-sneakers', 3]]);
    assert.equal((await api.checkout(await api.createCart([['limited-sneakers', 1]]))).status, 201);

    const failed = await api.checkout(doomed, code);
    assert.equal(failed.body.error.code, 'INSUFFICIENT_STOCK');
    const [coupon] = (await api.call('GET', '/admin/coupons')).body.coupons;
    assert.equal(coupon.status, 'AVAILABLE');

    const ok = await api.checkout(await api.createCart([['mouse', 1]]), code);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.discount.couponCode, code);
  });

  it('lets exactly one of many concurrent checkouts redeem the same coupon', async () => {
    api = await startServer({ everyNOrders: 1 });
    await api.placeOrders(1);
    const code = await api.generateCoupon();

    const carts = await Promise.all(Array.from({ length: 12 }, () => api.createCart([['keyboard', 1]])));
    const results = await Promise.all(carts.map((c) => api.checkout(c, code)));

    const outcomes = countBy(results.map((r) => r.body.error?.code ?? r.status));
    assert.deepEqual(outcomes, new Map<unknown, number>([[201, 1], ['COUPON_ALREADY_REDEEMED', 11]]));

    // Losers were not half-checked-out: their carts are still open and can proceed without it.
    const loser = carts[results.findIndex((r) => r.status !== 201)]!;
    assert.equal((await api.getCart(loser)).status, 'OPEN');
    assert.equal((await api.checkout(loser)).status, 201);
    assert.equal(await api.inventory('keyboard'), 50 - 2);
  });
});
