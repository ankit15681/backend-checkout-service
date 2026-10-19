# Design Decisions

This document explains what the service guarantees, where each guarantee is enforced,
which ambiguous requirements I resolved and how, and what I deliberately left out.

Contents:

1. [System invariants](#1-system-invariants)
2. [Ambiguities and the semantics I chose](#2-ambiguities-and-the-semantics-i-chose)
3. [Material design decisions](#3-material-design-decisions)
4. [Transaction, concurrency and idempotency strategy](#4-transaction-concurrency-and-idempotency-strategy)
5. [Money and rounding rules](#5-money-and-rounding-rules)
6. [Error model](#6-error-model)
7. [Implemented vs deferred](#7-implemented-vs-deferred)
8. [Multiple instances and production scale](#8-multiple-instances-and-production-scale)
9. [How I built it with Claude Code](#9-how-i-built-it-with-claude-code)
10. [With two more hours](#10-with-two-more-hours)

---

## 1. System invariants

Every invariant is checked in application code, which returns a useful error, **and**
backed by a database constraint or a guarded write, which refuses to persist a violation
if a bug or an unexpected writer gets past the check.

| # | Invariant | Application check | Database backstop |
|---|---|---|---|
| I1 | Inventory never goes below zero; we never sell more than we have | `checkout()` collects all shortfalls before writing ([orders.ts](src/orders.ts)) | Guarded `UPDATE … SET inventory = inventory - q WHERE inventory >= q` (row count must be 1); `CHECK (inventory >= 0)` |
| I2 | A cart produces at most one order | `checkout()` replays or rejects when the cart is `CHECKED_OUT` | `UPDATE carts … WHERE status = 'OPEN'` (row count must be 1); `orders.cart_id UNIQUE` |
| I3 | A coupon discounts at most one order | Checked for `redeemed_order_id IS NULL` before use | Guarded `UPDATE coupons … WHERE redeemed_order_id IS NULL`; `coupons.redeemed_order_id UNIQUE`; `orders.coupon_code UNIQUE` |
| I4 | Checkout is all-or-nothing: order, items, stock, coupon and cart state commit together | One `BEGIN IMMEDIATE` transaction; any throw rolls back ([db.ts](src/db.ts) `inTransaction`) | Same transaction |
| I5 | Coupon *k* exists only once `k × n` orders are placed, and at most one coupon per milestone | `generateCoupon()` under the write lock ([coupons.ts](src/coupons.ts)) | `coupons.milestone UNIQUE` |
| I6 | `total = subtotal − discount`, `0 ≤ discount ≤ subtotal`, `line = unit × qty` | [money.ts](src/money.ts) clamps the discount | `CHECK` constraints on `orders` and `order_items` |
| I7 | An order is an immutable snapshot that explains itself even after catalog changes | Name and unit price copied into `order_items`; no order mutation endpoints | n/a |
| I8 | A checked-out cart can no longer change | `requireOpenCart()` in every cart mutation | Writes run in the same transaction as the status check |
| I9 | A customer is never charged a unit price they were not shown | `PRICE_CHANGED` check against each line's quoted price | n/a |
| I10 | Cart lines reference real products with quantity 1–1000 | Strict validation in [app.ts](src/app.ts) plus product lookup | Foreign keys; `CHECK (quantity > 0)` |
| I11 | Reports are a pure function of orders and coupons, and reading them changes nothing | `getReport()` performs only reads inside one snapshot | n/a |

---

## 2. Ambiguities and the semantics I chose

| Question | Choice |
|---|---|
| Price changes between add-to-cart and checkout | Each cart line stores the **quoted** unit price. If the current price differs, in either direction, checkout fails with `409 PRICE_CHANGED`, listing old and new prices for every affected line. The client re-confirms by `PATCH`ing the line, which re-quotes it. See [Decision 4](#decision-4-price-changes-quote-on-the-cart-line-and-refuse-to-guess-at-checkout). |
| Availability changes after add-to-cart | Carts do **not** reserve stock. Adding validates against current stock as early feedback only. Checkout re-validates under the lock and fails with `409 INSUFFICIENT_STOCK`, listing **all** short lines (`requested`, `available`). The cart stays open so the customer can adjust it. |
| What is a "retry" of checkout? | A second checkout of the **same cart** with the **same coupon code** (after normalisation) is a retry: it returns the original order. The same cart with a different coupon is a conflicting request: `409 CART_ALREADY_CHECKED_OUT`, with `details.orderId`. |
| Retry of a checkout that **failed** | Failures write nothing, so a retry simply re-evaluates. That is useful: stock may have been replenished. |
| Which orders count toward milestones? | Every successfully placed order, including orders that used a coupon. There is no cancellation or refund flow, so the count only grows. |
| When does a coupon exist? | Reaching a milestone makes a coupon *eligible*; an admin call *generates* it. Pending milestones accumulate. Each admin call mints **one** coupon, for the earliest unrewarded milestone, so missed milestones are never lost but are also never minted in surprise batches. |
| Who can use a coupon? | Anyone holding the code (a bearer code). There is no customer identity in this system, so it cannot be bound to whoever placed the n-th order. Distribution is out of band. |
| Expiry, stacking, minimum spend | No expiry. At most one coupon per order. No minimum spend. |
| What is discounted? | The order subtotal, as a whole (see [§5](#5-money-and-rounding-rules)). |
| Config changes | A coupon stores its own `discount_bps` at generation, so changing *x* never alters outstanding coupons. Changing *n* re-interprets future milestones (`next = last rewarded + 1`, threshold `next × n`). That is acceptable for a deploy-time setting, but noted. |
| Add an item that is already in the cart | `409 ITEM_ALREADY_IN_CART` rather than incrementing; see [Decision 9](#decision-9-add-is-not-an-upsert-set-and-remove-are-idempotent). |
| Remove an item that is not in the cart | `200` no-op (idempotent delete). |
| Validation order at checkout | Cart state → empty cart → coupon → prices → stock. Deterministic: the first failing category is reported, with every offending line in that category. |
| Coupon on a zero-value order | Allowed: it discounts 0 and is consumed. No zero-price products are seeded. A real store might reject it. |

---

## 3. Material design decisions

### Decision 1: Embedded SQLite with invariants in the database, not an in-memory store

**Context:** The service must preserve stock, coupon and order invariants under concurrent
and repeated requests, and the evaluation may run against multiple processes. The
assignment allows in-memory storage only if it still demonstrates overlap safety.

**Options considered:**
1. In-memory maps with per-resource mutexes.
2. PostgreSQL in Docker.
3. Embedded SQLite (`node:sqlite`), with constraints and transactions.

**Choice:** SQLite in WAL mode, accessed through Node's built-in synchronous driver.

**Why:** In-memory locks prove only that one process is correct. They say nothing about two
instances, and they push all invariant enforcement into hand-written lock code.
PostgreSQL is the production answer but makes setup depend on Docker. SQLite offers
real transactions, `UNIQUE`/`CHECK`/foreign-key constraints, and multi-process locking on
a file. The same SQL shape (guarded updates and unique constraints) carries straight over to
Postgres. Since `node:sqlite` is built in, there is nothing to install or compile.

**Consequences:** Setup is `npm ci && npm start`. I could write a test that runs **three
OS processes against one database file**, a realistic stand-in for horizontal scaling.
The cost: SQLite has a single writer per database, so all writes serialise, even
unrelated ones. The synchronous driver blocks a process's event loop while it waits for
the lock (bounded by `busy_timeout = 5s`). Both are fine at exercise scale; [§8](#8-multiple-instances-and-production-scale) covers production.

### Decision 2: One pessimistic write transaction per checkout (`BEGIN IMMEDIATE`)

**Context:** Checkout reads stock, coupon and cart state, then writes all three. Any
interleaving between the read and the write is a potential oversell or double redemption.

**Options considered:**
1. Optimistic concurrency: version columns, retry on conflict.
2. Application-level locks per product or coupon.
3. A single serialisable write transaction that takes the write lock up front.

**Choice:** Option 3. `inTransaction()` issues `BEGIN IMMEDIATE`, runs a **synchronous**
callback, and commits or rolls back. Checkout, cart edits, coupon generation and admin
product changes all use it.

**Why:** With the write lock held from the first read, every check sees the latest committed
state and nothing can change before the writes. That holds for requests in other processes
too, because the lock is SQLite's file lock, not a JavaScript mutex. The callback must not
`await`. Otherwise other requests on the same connection could run statements inside our
transaction, so the helper rejects a returned Promise. I chose `IMMEDIATE` deliberately
over a default deferred `BEGIN`. A deferred transaction starts as a reader and tries to
upgrade on its first write; two processes doing that at once produce `SQLITE_BUSY`
instead of waiting their turn.

**Consequences:** The checkout code reads as straight-line logic, with no retry loops or
version juggling. I verified that the tests depend on this choice (see [§4](#4-transaction-concurrency-and-idempotency-strategy)). The cost is
throughput: one writer at a time. Production would use row-level locks instead.

### Decision 3: The cart is the idempotency key for checkout

**Context:** Clients retry checkout after timeouts. A retry must not create a second order
or decrement stock twice, and it should give the client the result it missed.

**Options considered:**
1. A generic `Idempotency-Key` header: store the key, a request fingerprint and the
   response, and replay on a match (the Stripe model).
2. A natural key: a cart can be checked out at most once, so the cart id itself
   identifies the operation.

**Choice:** The natural key. `POST /carts/:id/checkout` on an already checked-out cart with
identical parameters returns the original order (`200`, `Idempotent-Replayed: true`).
Different parameters get `409 CART_ALREADY_CHECKED_OUT` with the order id.

**Why:** The domain already has the property an idempotency key would add: one cart, one
order. That property is enforced by `UNIQUE(orders.cart_id)` and the guarded status
transition. A separate key table would be a second source of truth that could disagree with
the first. It would also miss a client that retries with a *new* key, which the natural key
still catches. The replay comes from the stored order snapshot, so it is identical even if
prices changed since.

**Consequences:** No key storage, no expiry policy, and correctness under concurrent
retries comes from the same transaction that guards stock. Operations without a
natural key, such as admin coupon generation, are not idempotent; see [§7](#7-implemented-vs-deferred).

### Decision 4: Price changes: quote on the cart line and refuse to guess at checkout

**Context:** Between add-to-cart and checkout an admin may change a price. The store must
not charge a surprise amount, and must not sell indefinitely at a stale price either.

**Options considered:**
1. Silently charge the current price.
2. Honour the price from when the item was added (price lock).
3. Charge the lower of the two (asymmetric).
4. Store the quoted price and fail checkout on any difference until the customer re-confirms.

**Choice:** Option 4, symmetric: any difference, up or down, triggers `409 PRICE_CHANGED`.

**Why:** Option 1 breaks the rule "never charge a price the customer did not see". Option 2
lets a cart pin an obsolete price forever. Option 3 is customer-friendly, but it means the
amount charged differs from what the client displayed, and it is easy to get wrong in
reporting. Option 4 is deterministic and explicit: the response lists every changed line,
and one `PATCH` per line re-quotes. The cart view surfaces `priceChanged` and `issues`, so
a UI can prompt *before* checkout.

**Consequences:** One extra round-trip for the customer after a price change. A price
*decrease* also blocks checkout. That is a product trade-off I would revisit with the
business (Option 3 is a small change in `checkout()`).

### Decision 5: No stock reservation in carts; checkout is the single point of truth

**Context:** "Must not sell more than available" could be enforced at add-to-cart
(reservation) or at checkout.

**Options considered:**
1. Reserve stock when an item is added, released by removal or a TTL.
2. Advisory check at add time, authoritative check and decrement at checkout.

**Choice:** Option 2.

**Why:** Reservations need expiry, a cleanup process and a policy for abandoned carts.
Without them, abandoned carts lock up limited stock (with 3 sneakers in stock, three
idle carts would block every buyer). Deciding at checkout keeps the invariant in one place,
inside one transaction.

**Consequences:** A customer can see an item as available in their cart and then lose
it at checkout. The error says exactly which lines and how many remain. Reservations
become necessary once payment is asynchronous ([§8](#8-multiple-instances-and-production-scale)).

### Decision 6: Coupon generation: one coupon per milestone, earliest first, one per call

**Context:** "Every n-th order makes a coupon available", generated on admin request, never
twice for the same milestone, and safe if two admins click at once.

**Options considered:**
1. Generate automatically inside the checkout transaction that reaches the milestone.
2. Admin call generates coupons for *all* pending milestones.
3. Admin call generates **one** coupon for the earliest pending milestone.

**Choice:** Option 3. Milestone *k* is reached when `placedOrders ≥ k × n`. The next
milestone is `max(milestone) + 1`. Generation runs under the write lock, and
`UNIQUE(milestone)` backs it up. A concurrent-generation test asserts exactly one `201`
out of ten parallel requests.

**Why:** The assignment says an administrator *requests* generation, which rules out
Option 1, and Option 1 would also couple checkout to rewards. Option 3 gives one
predictable effect per request and a clear `409 NO_ELIGIBLE_MILESTONE` that includes
progress (`placedOrders`, `nextMilestoneOrderThreshold`).

**Consequences:** If an admin retries after a timeout while **two** milestones are
pending, the retry mints the second coupon. That is legitimate, since it was earned, but
it is not idempotent at the request level. An `Idempotency-Key` would fix it (deferred).

### Decision 7: No payment abstraction; a committed checkout counts as paid

**Context:** No real payment integration is required.

**Options considered:**
1. No payment step: the commit is the payment success.
2. A fake synchronous gateway called inside the transaction.
3. A realistic two-phase flow: reserve stock and coupon (`PENDING_PAYMENT`), call the
   gateway outside the transaction, then confirm or compensate.

**Choice:** Option 1.

**Why:** Option 2 teaches the wrong pattern: calling an external service while holding a
database lock. It also cannot fail in an interesting way without Option 3's machinery.
Option 3 is the right production design, but it adds a state machine, expiry of
reservations and crash-recovery paths that I could not test properly in the timebox. I
preferred one fully atomic transaction I can defend over a half-built saga.

**Consequences:** "A coupon must not be consumed by a checkout that ultimately fails" holds
trivially: every failure rolls back, and a test asserts it. The evolution to Option 3 is
in [§8](#8-multiple-instances-and-production-scale).

### Decision 8: Admin inventory changes are deltas, not absolute values

**Context:** Admins need to restock or correct inventory while checkouts are running.

**Options considered:** `PATCH {inventory: 10}` (absolute) or `PATCH {inventoryDelta: +7}`.

**Choice:** Deltas, applied as `inventory = inventory + delta WHERE inventory + delta >= 0`.

**Why:** An absolute value is usually computed from a read the admin made earlier. If two
units sold in between, "set to 10" silently resurrects them and can lead to overselling.
A delta composes correctly with concurrent sales.

**Consequences:** A stock-take correction needs the admin to compute the delta. Negative
results are refused with `409 INVENTORY_WOULD_GO_NEGATIVE`.

### Decision 9: "Add" is not an upsert; "set" and "remove" are idempotent

**Context:** Cart edits get retried too. An increment-on-add endpoint turns a retried
"add 1" into 2.

**Choice:** `POST /items` creates a line and fails with `409 ITEM_ALREADY_IN_CART` if one
exists. `PATCH /items/:productId {quantity}` sets an absolute quantity. `DELETE` is a no-op
when the line is absent.

**Why:** Every cart mutation is then either idempotent or loudly non-repeatable, never
silently non-idempotent.

**Consequences:** A client that wants "add one more" reads the cart and PATCHes the new
quantity.

### Decision 10: Error contract: stable codes, status as category, structured details

**Context:** Errors must be distinguishable and useful to API clients.

**Choice:** `{ error: { code, message, details, requestId } }`. See [§6](#6-error-model).

**Why:** Several different failures share HTTP 409, so the status alone is not
actionable. The `code` is the contract, and `details` carries what the client needs to
recover: which lines, how much stock, which order already exists.

---

## 4. Transaction, concurrency and idempotency strategy

**Within one process.** Node runs JavaScript on one thread, and the SQLite driver is
synchronous. A transaction callback therefore runs start to finish without another request
interleaving. This holds *only* because the callback cannot `await`, which `inTransaction`
enforces.

**Across processes.** Each instance has its own connection to the same database file.
`BEGIN IMMEDIATE` takes SQLite's reserved (write) lock before the first read, so
checkouts in different processes queue up. WAL mode lets readers (cart views, reports) run
without blocking writers. If the lock cannot be acquired within `busy_timeout`, the request
fails with `503 SERVICE_BUSY` and `Retry-After`; nothing was written, so retrying is safe.

**Inside the checkout transaction** ([orders.ts](src/orders.ts) `checkout()`):

1. Load the cart. If it is `CHECKED_OUT`, replay (same coupon) or return `409`.
2. Load lines joined with *current* product rows; reject an empty cart.
3. Validate the coupon (exists, unredeemed), then prices (`PRICE_CHANGED`), then stock
   (`INSUFFICIENT_STOCK`). Each check reports every offending line.
4. Compute money; insert the order and the item snapshots.
5. Guarded writes, each required to affect exactly one row: decrement stock
   `WHERE inventory >= q`, redeem the coupon `WHERE redeemed_order_id IS NULL`, close the
   cart `WHERE status = 'OPEN'`.
6. Commit. Any exception at any step rolls back everything.

The guarded writes in step 5 are redundant while step 3 runs under the same lock. They
exist so that a future refactor that moves validation out of the transaction fails safe
instead of overselling.

**Idempotency summary:**

| Operation | Behaviour on repeat |
|---|---|
| Checkout, same cart and coupon | Replays the original order (`200`) |
| Checkout, same cart, different coupon | `409 CART_ALREADY_CHECKED_OUT` + `orderId` |
| `PATCH` quantity, `DELETE` line | Idempotent |
| `POST` add line | `409 ITEM_ALREADY_IN_CART` (not silently repeated) |
| `GET` report | Read-only |
| `POST /admin/coupons` | Not idempotent when several milestones are pending (deferred) |

**How the strategy is tested.** `test/multi-instance.test.ts` starts **three server
processes on one database file**. It races 30 checkouts for 3 limited-stock items, 30
retries of one cart, and 30 checkouts with one coupon, spreading requests across
instances. The in-process tests cover the same races through HTTP on one instance.

I checked that the tests can catch an incorrect implementation by breaking the code on
purpose:

- **`BEGIN IMMEDIATE` replaced with a plain `BEGIN`:** the single-process suite still
  passed. The multi-instance suite failed with `503`s from lock-upgrade conflicts.
- **Checkout transaction removed entirely:** duplicate-retry and coupon races failed with
  `500`s, but the oversell test initially *still passed*. The guarded `UPDATE` kept stock
  at 0, while losing checkouts left half-written orders behind. I strengthened the test to
  also assert the number of placed orders. It now fails on that bug (5 orders instead of 3)
  and passes on the real code.

---

## 5. Money and rounding rules

- All amounts are **integer cents** (`INTEGER` columns, `*Cents` fields). One currency
  (USD). No floating-point value is ever stored or used to compute an amount.
- Bounds keep everything a safe integer: unit price ≤ $1,000,000, quantity per line
  ≤ 1000. `lineTotalCents` and `sumCents` assert `Number.isSafeInteger`.
- The coupon percentage is configured as a decimal string with up to 2 places and parsed
  **as a string** into basis points (`"12.5"` → 1250). There is no `parseFloat`, so
  values like `"0.1"` never pick up binary drift.
- **Discount** = `round_half_up(subtotal × bps / 10000)`, computed with `BigInt` as
  `(subtotal × bps + 5000) / 10000` using integer division, then clamped to
  `≤ subtotal`. The total can never go negative, even with `x = 100` or a
  misconfiguration above 100%; both are tested.
- The discount is computed **once per order on the subtotal**, not per line, so there is
  exactly one rounding step and the order is exactly reproducible from its stored fields.
  Allocating the discount across lines, needed for partial refunds, would use a
  largest-remainder split (deferred).
- I chose half-up over banker's rounding because it is what customers and finance teams
  usually expect from "10% off". Floor (always in the merchant's favour) was the other
  credible option. The rule lives in one function, `discountCents`.
- Report totals are sums of stored order fields, never recomputed from current prices,
  so `net = gross − discounts` holds exactly. The tests check this along with per-product
  quantities against `/admin/orders`.

---

## 6. Error model

```json
{ "error": { "code": "COUPON_ALREADY_REDEEMED", "message": "…", "details": { "couponCode": "…" }, "requestId": "…" } }
```

| Status | Meaning | Codes |
|---|---|---|
| 400 | Malformed request; fix the request | `VALIDATION_ERROR` (with `field`, range), `INVALID_JSON` |
| 404 | A resource in the **path**, or the product being added, does not exist | `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ITEM_NOT_IN_CART`, `ROUTE_NOT_FOUND` |
| 409 | Conflicts with current state; re-read and decide | `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, `COUPON_ALREADY_REDEEMED`, `CART_NOT_OPEN`, `CART_ALREADY_CHECKED_OUT`, `ITEM_ALREADY_IN_CART`, `NO_ELIGIBLE_MILESTONE`, `INVENTORY_WOULD_GO_NEGATIVE` |
| 422 | Well-formed but cannot be processed as given | `CART_EMPTY`, `COUPON_NOT_FOUND` |
| 503 | Transient lock contention; nothing written; retry | `SERVICE_BUSY` (+ `Retry-After`) |
| 500 | Bug | `INTERNAL_ERROR` (stack logged with `requestId`, never returned) |

Choices:

- `COUPON_NOT_FOUND` is `422`, not `404`: the coupon is a body parameter, and a `404` on
  `POST /carts/:id/checkout` would read as "cart not found".
- `INSUFFICIENT_STOCK` and `PRICE_CHANGED` return **all** affected lines, so a UI can fix
  the cart in one pass.
- A database constraint violation means an application check was bypassed. It surfaces
  as `500`, not as a friendly `409`, because it signals a bug that should alert someone.
- Every response carries `X-Request-Id`, which is also logged and included in error bodies.

---

## 7. Implemented vs deferred

**Implemented:** all required endpoints, plus product listing, an admin orders/coupons
listing for reconciliation, and admin price and inventory changes. Atomic, idempotent,
concurrency-safe checkout. Milestone coupons. A snapshot-consistent report. An OpenAPI
3.1 contract. Structured request logging. A CI workflow (typecheck and tests on Node 22
and 24). 26 tests, including a 3-process concurrency suite. An executable demo script.

**Deferred, on purpose:**

- **Authentication and authorisation.** `/admin/*` is open. Carts are bearer capabilities:
  anyone with the unguessable UUID can use one. Production needs customer identity, cart
  ownership and an admin role.
- **Payments** with reservation and confirm/compensate ([Decision 7](#decision-7-no-payment-abstraction-a-committed-checkout-counts-as-paid)).
- **`Idempotency-Key` for admin coupon generation** ([Decision 6](#decision-6-coupon-generation-one-coupon-per-milestone-earliest-first-one-per-call)).
- **Order lifecycle**: cancellation, refunds, discount allocation per line. Milestone
  counting would then need a rule for cancelled orders; I would count *placed* orders
  so that coupons already issued are never invalidated.
- **Cart expiry** and clean-up; pagination on admin listings; rate limiting.
- **Coupon distribution and expiry**; binding coupons to customers.
- **Metrics and tracing** beyond structured logs (see [§8](#8-multiple-instances-and-production-scale)).
- **A frontend.** It is optional, and the timebox went to correctness.

---

## 8. Multiple instances and production scale

The service is already safe with several instances against **one SQLite file**, and the
tests do exactly that. SQLite is not a production database for multiple hosts, though. The
move would be:

**PostgreSQL with row-level locking.** The SQL shape stays, but the lock gets narrower:

- `SELECT … FROM carts WHERE id = $1 FOR UPDATE`: same-cart retries serialise on that
  row only, not on the whole database.
- Products: guarded `UPDATE products SET inventory = inventory - $q WHERE id = $id AND inventory >= $q`
  with a row-count check, in **ascending product-id order** so two multi-item checkouts
  cannot deadlock.
- Coupons: the same guarded `UPDATE … WHERE redeemed_order_id IS NULL`.
- Keep every `UNIQUE` and `CHECK` constraint as the backstop. `READ COMMITTED` is enough
  because each invariant is protected by a row lock or a guarded single-row update. Map
  serialisation or deadlock errors to a bounded server-side retry, then `503`.
- Milestones: replace `COUNT(*)` with a counter row updated in the checkout transaction,
  and generate coupons under `SELECT … FOR UPDATE` on that row.
- Use an async connection pool so lock waits no longer block the event loop.

**Stateless app instances** behind a load balancer. All coordination happens in the
database, so instances can scale horizontally and be deployed continuously.

**Real payments** turn checkout into a short state machine:

1. Transaction: decrement stock, mark the coupon `RESERVED`, and create the order as
   `PENDING_PAYMENT` with an expiry.
2. Call the payment provider **outside** any transaction, passing the order id as the
   provider's idempotency key.
3. Transaction: mark the order `PAID`, or release the stock and coupon (compensation).
4. A sweeper releases expired reservations, so a crash between steps cannot strand stock
   or a coupon.

**Hot inventory** (a limited drop with thousands of buyers) makes one product row a
contention point. Options, in order of complexity:

- A fast admission gate, such as an atomic Redis `DECR`, in front of the database
  transaction.
- Splitting stock across several counter rows (bucketed inventory).
- A queue that serialises purchases of that one product.

**Reporting and analytics.** Publish `OrderPlaced` and `CouponRedeemed` events through a
transactional outbox to a stream (Kafka or Kinesis). That feeds real-time dashboards
without loading the transactional database, and a periodic job reconciles stream
aggregates against the ledger. Admin reports read from a replica.

**Operations.** Metrics on checkout outcomes by error code, lock-wait and transaction
latency, and alerts on any `INTERNAL_ERROR`, since a constraint violation means an
invariant check was bypassed. Distributed tracing keyed on the request id.

---

## 9. How I built it with Claude Code

I built this with **Claude Code** as the coding tool, and I navigated it end to end. I
set the order of work, defined the scope of each step, and reviewed and tested each step
before moving on to the next. The code was written by Claude Code under that direction,
feature by feature, each step small enough to review on its own and each leaving the code
type-checking:

1. **Foundations.** Project setup, configuration, integer-cent money helpers (with their
   tests), the error model, and the SQLite schema with its invariant-backing constraints.
2. **HTTP skeleton.** Request ids, structured logs and the error handler, before any
   business route, so every later feature got consistent errors and logging for free.
3. **Features, one at a time:** catalog and admin product updates, then carts, then
   milestone coupons, then the atomic, idempotent checkout, then the admin report. Each
   built only on what already existed.
4. **Tests by feature area:** carts, checkout, coupons, report, and finally a
   multi-process suite where separate service instances race on one database file.
5. **Contract and tooling:** the OpenAPI 3.1 contract, an executable demo script and CI.
6. **Documentation:** the README, then this document.

Problems caught along the way (each fixed and re-tested):

- **The oversell test was too weak.** When the checkout transaction was removed on
  purpose, the cross-instance oversell test still passed: the guarded decrement kept stock
  at 0 while ghost orders were being written. The test now also asserts the order count,
  and it fails on that bug.
- **A test assertion was wrong, not the code.** A hand-computed expected value for a
  large-number discount was off by 10,000 cents. I verified the right value independently
  with `BigInt` arithmetic before changing the test, rather than bending the code to fit
  the test.
- **Middleware ordering bug.** A manual smoke test showed `INVALID_JSON` errors had no
  `requestId`, because the JSON parser ran before the request-id middleware. Reordered.
- **Test setup bug.** A report test tried to add an already sold-out item to a new cart.
  That is correctly rejected at add time, so the setup was changed to create the cart
  before the stock ran out.

---

## 10. With two more hours

1. **Payment as a reservation flow** (`PENDING_PAYMENT` → `PAID` / released), with tests
   that crash the process between steps. This is the most realistic source of
   "coupon or stock lost by a failed checkout" bugs, and the current design sidesteps it.
2. **Run the same test suite against PostgreSQL** behind a small repository interface, to
   validate the claims in [§8](#8-multiple-instances-and-production-scale) (lock ordering, deadlock retry) instead of only asserting them.
3. **Load-test the hot-product path** (e.g. `autocannon`, 500 concurrent buyers for 3
   items across 3 instances), measuring lock wait, `503` rate and tail latency.
4. **`Idempotency-Key` on `POST /admin/coupons`** and a property-based test that random
   interleavings of checkouts, retries and generations always reconcile in the report.
