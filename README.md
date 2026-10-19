# Checkout & Rewards Service

Backend for an e-commerce checkout: carts, idempotent and concurrency-safe checkout,
"every *n*th order earns an *x*% coupon" rewards, and admin reporting.

- **Stack:** TypeScript on Node.js (native type stripping, no build step), Express 5,
  embedded SQLite via the built-in `node:sqlite` module. No external services and no
  native add-ons to compile.
- **Design notes:** [`DECISIONS.md`](DECISIONS.md) covers invariants, semantics, trade-offs and the concurrency strategy.
- **API contract:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), summarised below.

## Setup and run

Requires **Node.js ≥ 22.18** (tested on 22.23 and 24.15).

```bash
npm ci
npm start                 # http://localhost:3000, database at data/checkout.db (auto-created and seeded)
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (`0` = random) |
| `DB_PATH` | `data/checkout.db` | SQLite file (created on first start) |
| `COUPON_EVERY_N_ORDERS` | `5` | *n*: a coupon becomes available after every *n*th placed order |
| `COUPON_DISCOUNT_PERCENT` | `10` | *x*: coupon percentage, `(0, 100]`, up to 2 decimals |

```bash
npm test                  # 26 tests, including a 3-process concurrency suite (~1.5 s)
npm run typecheck
npm run db:reset          # delete the local database; it is re-seeded on next start
```

Executable walkthrough against a running server:

```bash
COUPON_EVERY_N_ORDERS=2 npm start
```

```bash
./scripts/demo.sh
```

Logs are one JSON line per request (`requestId`, method, path, status, error code, latency).
Send `X-Request-Id` to correlate; it is echoed in the response and in error bodies.

### Seed data

| id | name | price | inventory |
|---|---|---|---|
| `keyboard` | Mechanical Keyboard | $79.99 | 50 |
| `mouse` | Wireless Mouse | $24.99 | 100 |
| `monitor` | 27-inch 4K Monitor | $329.99 | 20 |
| `usb-c-cable` | USB-C Cable (2m) | $9.99 | 500 |
| `headphones` | Noise-Cancelling Headphones | $199.99 | 10 |
| `limited-sneakers` | Limited Edition Sneakers | $149.99 | **3** (limited) |

## API

Conventions:

- Money is integer **cents** (`…Cents`), currency `USD`. Percentages are **basis points** (`percentBps`: 1000 = 10%).
- Errors always look like this. Branch on `code`; the HTTP status is only the category.
  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "…", "details": { "items": [{ "productId": "limited-sneakers", "requested": 2, "available": 1 }] }, "requestId": "…" } }
  ```
- **Administrative operations** are everything under `/admin/*`. They are unauthenticated in this exercise and would sit behind a separate auth policy in production.

### Catalog

| Method & path | Success | Errors |
|---|---|---|
| `GET /products` | `200 {products: Product[]}` | none |
| `GET /products/:productId` | `200 Product` | `404 PRODUCT_NOT_FOUND` |

### Carts

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /carts` | none | `201 Cart` + `Location` | none |
| `GET /carts/:cartId` | none | `200 Cart` | `404 CART_NOT_FOUND` |
| `POST /carts/:cartId/items` | `{productId, quantity}` | `201 Cart` | `400 VALIDATION_ERROR`, `404 PRODUCT_NOT_FOUND`, `409 ITEM_ALREADY_IN_CART`, `409 INSUFFICIENT_STOCK`, `409 CART_NOT_OPEN` |
| `PATCH /carts/:cartId/items/:productId` | `{quantity}` | `200 Cart` | `400 VALIDATION_ERROR`, `404 ITEM_NOT_IN_CART`, `409 INSUFFICIENT_STOCK`, `409 CART_NOT_OPEN` |
| `DELETE /carts/:cartId/items/:productId` | none | `200 Cart` (no-op if absent) | `404 CART_NOT_FOUND`, `409 CART_NOT_OPEN` |

- `quantity` must be a JSON integer from 1 to 1000. `"2"`, `2.5`, `0` and negatives are rejected, never coerced.
- `POST …/items` **adds** a new line and is deliberately not an upsert, so a retried "add 1" cannot become 2. `PATCH` **sets** an absolute quantity, so it is idempotent.
- Each line records the **unit price quoted** when it was added or last changed. The cart view shows that price, the current price, `priceChanged`, `availableInventory`, line totals, `subtotalCents`, an advisory `checkoutReady` flag and an `issues` list.
- If a price changes, checkout returns `409 PRICE_CHANGED`. The client re-confirms by `PATCH`ing the line, which re-quotes it at the current price.

Example `Cart`:

```json
{
  "id": "4f0c…", "status": "OPEN", "orderId": null, "currency": "USD",
  "items": [
    { "productId": "keyboard", "name": "Mechanical Keyboard", "quantity": 2,
      "unitPriceCents": 7999, "currentUnitPriceCents": 7999, "priceChanged": false,
      "availableInventory": 50, "lineTotalCents": 15998 }
  ],
  "itemCount": 2, "subtotalCents": 15998, "checkoutReady": true, "issues": [],
  "createdAt": "…", "updatedAt": "…"
}
```

### Checkout and orders

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /carts/:cartId/checkout` | `{couponCode?}` (body optional) | `201 Order` (new) or `200 Order` (replay); header `Idempotent-Replayed: true\|false` | `404 CART_NOT_FOUND`, `422 CART_EMPTY`, `422 COUPON_NOT_FOUND`, `409 COUPON_ALREADY_REDEEMED`, `409 PRICE_CHANGED`, `409 INSUFFICIENT_STOCK`, `409 CART_ALREADY_CHECKED_OUT`, `503 SERVICE_BUSY` |
| `GET /orders/:orderId` | none | `200 Order` | `404 ORDER_NOT_FOUND` |

- **Atomic.** Inventory decrement, coupon redemption, order snapshot and cart closure commit together or not at all. A failed checkout consumes nothing.
- **Retries are safe.** Repeating a checkout for a cart that already succeeded, with the same `couponCode`, returns the original order with status `200`. A different `couponCode` gets `409 CART_ALREADY_CHECKED_OUT`, and `details.orderId` names the existing order.
- `INSUFFICIENT_STOCK` and `PRICE_CHANGED` list **every** affected line in `details.items`.
- `503 SERVICE_BUSY` (with `Retry-After`) means the database lock could not be acquired in time. Nothing was written, so retrying is safe.

Example `Order`:

```json
{
  "id": "9b1e…", "cartId": "4f0c…", "status": "PLACED", "currency": "USD",
  "items": [{ "productId": "monitor", "name": "27-inch 4K Monitor", "unitPriceCents": 32999, "quantity": 1, "lineTotalCents": 32999 }],
  "subtotalCents": 32999,
  "discount": { "couponCode": "REWARD-Q3XNAJ2ZY7", "percentBps": 1000, "amountCents": 3300 },
  "discountCents": 3300, "totalCents": 29699, "createdAt": "…"
}
```

### Administration

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /admin/coupons` | none | `201 Coupon` | `409 NO_ELIGIBLE_MILESTONE` (`details` shows milestone progress) |
| `GET /admin/coupons` | none | `200 {coupons: Coupon[]}` | none |
| `GET /admin/orders` | none | `200 {orders: Order[]}` | none |
| `GET /admin/report` | none | `200 Report` | none |
| `PATCH /admin/products/:productId` | `{priceCents?, inventoryDelta?}` | `200 Product` | `400 VALIDATION_ERROR`, `404 PRODUCT_NOT_FOUND`, `409 INVENTORY_WOULD_GO_NEGATIVE` |

- Milestone *k* is reached once `k × n` orders have been placed. Each `POST /admin/coupons` mints **one** coupon for the earliest reached milestone that has none yet. If the admin fell behind, repeated calls catch up one milestone at a time.
- `GET /admin/report` is read-only and computed from a single consistent snapshot. It returns `placedOrders`; `productsPurchased[]` with quantity and gross per product; `revenue` with `grossCents`, `discountsCents` and `netCents`; `coupons` with `generated`, `available` and `redeemed`; and `milestones` progress.
- `PATCH /admin/products` exists so price changes and restocks can be demonstrated. Inventory changes are **deltas** (see DECISIONS.md).

## Project layout

```
src/
  server.ts     process entry: config, DB, HTTP listener, graceful shutdown
  app.ts        routes, input validation, error mapping, request logging
  carts.ts      cart lifecycle and cart view
  orders.ts     checkout (the critical transaction) and order views
  coupons.ts    milestone logic and coupon generation
  report.ts     admin summary
  products.ts   catalog and admin product changes
  db.ts         schema (with invariant-backing constraints), seed, transaction helpers
  money.ts      integer-cent arithmetic and discount rounding
  errors.ts     error codes
test/           node:test suites; multi-instance.test.ts spawns 3 server processes
openapi.yaml    API contract
scripts/demo.sh executable API walkthrough
```
