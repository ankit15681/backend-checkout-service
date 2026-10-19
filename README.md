# Checkout & Rewards Service

Backend for an e-commerce checkout: carts, idempotent and concurrency-safe checkout,
"every *n*th order earns an *x*% coupon" rewards, and admin reporting.

- **Stack:** TypeScript on Node.js (native type stripping, no build step), Express 5,
  embedded SQLite via the built-in `node:sqlite` module. No external services and no
  native add-ons to compile.
- **Design notes:** [`DECISIONS.md`](DECISIONS.md) covers invariants, semantics, trade-offs and the concurrency strategy.
- **API contract:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1) is the full reference; a summary is below.

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
npm test                  # 30 tests, including a 3-process concurrency suite (~1.5 s)
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

Request and response schemas are in [`openapi.yaml`](openapi.yaml). Conventions:

- Money is integer **cents** (`…Cents`) in USD; percentages are **basis points** (1000 = 10%).
- Errors are `{ "error": { "code", "message", "details", "requestId" } }`. Branch on `code`.
- **Administrative** operations are everything under `/admin/*` (unauthenticated in this exercise).

| Endpoint | Purpose | Success | Notable errors |
|---|---|---|---|
| `GET /products`, `GET /products/:id` | Catalog with current price and stock | `200` | `404 PRODUCT_NOT_FOUND` |
| `POST /carts` | Create a cart | `201` | none |
| `GET /carts/:cartId` | View the cart: quoted and current prices, totals, `checkoutReady`, `issues` | `200` | `404 CART_NOT_FOUND` |
| `POST /carts/:cartId/items` `{productId, quantity}` | Add a line (not an upsert) | `201` | `400 VALIDATION_ERROR`, `404 PRODUCT_NOT_FOUND`, `409 ITEM_ALREADY_IN_CART` / `INSUFFICIENT_STOCK` / `CART_NOT_OPEN` |
| `PATCH /carts/:cartId/items/:productId` `{quantity}` | Set quantity (idempotent); re-quotes the price | `200` | `404 ITEM_NOT_IN_CART`, `409 INSUFFICIENT_STOCK` / `CART_NOT_OPEN` |
| `DELETE /carts/:cartId/items/:productId` | Remove a line (no-op if absent) | `200` | `409 CART_NOT_OPEN` |
| `POST /carts/:cartId/checkout` `{couponCode?}` | Place the order, atomically | `201` new, `200` replay (`Idempotent-Replayed`) | `422 CART_EMPTY` / `COUPON_NOT_FOUND`, `409 PRICE_CHANGED` / `INSUFFICIENT_STOCK` / `COUPON_ALREADY_REDEEMED` / `CART_ALREADY_CHECKED_OUT`, `503 SERVICE_BUSY` |
| `GET /orders/:orderId` | Order snapshot (items, prices, discount, total) | `200` | `404 ORDER_NOT_FOUND` |
| `POST /admin/coupons` (optional `Idempotency-Key` header) | Generate the coupon for the earliest reached, unrewarded milestone | `201` new, `200` replay | `409 NO_ELIGIBLE_MILESTONE`, `400 VALIDATION_ERROR` (bad key) |
| `GET /admin/coupons`, `GET /admin/orders` | Listings, to reconcile the report | `200` | none |
| `GET /admin/report` | Quantities by product, gross / discounts / net, coupon counts, order count | `200` | none |
| `PATCH /admin/products/:id` `{priceCents?, inventoryDelta?}` | Change price or adjust stock by a delta | `200` | `409 INVENTORY_WOULD_GO_NEGATIVE` |

Behaviour worth knowing:

- **Checkout is retry-safe.** Repeating it for an already checked-out cart with the same
  `couponCode` returns the original order (`200`). A different `couponCode` gets
  `409 CART_ALREADY_CHECKED_OUT` with `details.orderId`.
- **A failed checkout writes nothing**: no stock, coupon or order is consumed.
- **Price changes:** if a line's price went **up** since it was added, checkout returns
  `409 PRICE_CHANGED`; `PATCH` the line to accept it. A price **drop** is charged automatically.
- **Coupon generation is retry-safe** with an `Idempotency-Key`: repeating a successful
  request returns the same coupon instead of minting the next pending milestone.
- `INSUFFICIENT_STOCK` and `PRICE_CHANGED` list every affected line in `details.items`.
- `503 SERVICE_BUSY` (with `Retry-After`) means nothing was written; retry.

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

## Time spent

About **4 hours** in total. The service was built feature by feature (foundations, HTTP
skeleton, catalog, carts, coupons, checkout, report, then tests, contract and docs). The
rest went on reviewing it file by file and flow by flow, trimming the documentation, and
three design changes (the later commits). See
[DECISIONS.md §9](DECISIONS.md#9-how-i-built-it-with-claude-code).
