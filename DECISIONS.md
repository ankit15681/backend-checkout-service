# Design Decisions

What the service guarantees, where each guarantee is enforced, which ambiguities I
resolved and how, and what I deliberately left out.

## 1. System invariants

Each invariant is checked in application code, which returns a useful error, **and**
backed by the database (a constraint or a guarded write), which refuses to persist a
violation if a bug gets past the check.

| # | Invariant | Application check | Database backstop |
|---|---|---|---|
| I1 | Never sell more inventory than exists | `checkout()` collects all shortfalls before writing ([orders.ts](src/orders.ts)) | `UPDATE … WHERE inventory >= q` must hit 1 row; `CHECK (inventory >= 0)` |
| I2 | A cart produces at most one order | `checkout()` replays or rejects a `CHECKED_OUT` cart | `UPDATE carts … WHERE status = 'OPEN'`; `orders.cart_id UNIQUE` |
| I3 | A coupon discounts at most one order | Must be unredeemed before use | `UPDATE coupons … WHERE redeemed_order_id IS NULL`; `UNIQUE` on both sides of the link |
| I4 | Checkout is all-or-nothing | One `BEGIN IMMEDIATE` transaction; any throw rolls back ([db.ts](src/db.ts)) | same transaction |
| I5 | Coupon *k* exists only after `k × n` orders, once per milestone | `generateCoupon()` under the write lock ([coupons.ts](src/coupons.ts)) | `coupons.milestone UNIQUE` |
| I6 | `total = subtotal − discount`, `0 ≤ discount ≤ subtotal` | `discountCents` clamps ([money.ts](src/money.ts)) | `CHECK` constraints on `orders` / `order_items` |
| I7 | An order explains itself after catalog changes | Name and unit price copied into `order_items`; orders are never updated | n/a |
| I8 | A customer is never charged more per unit than they were shown | `PRICE_CHANGED` when the current price is above the line's quoted price | n/a |

A checked-out cart is frozen (every cart mutation calls `requireOpenCart`), and the
report is read-only by construction (it contains no writes).

## 2. Ambiguities and the semantics I chose

| Question | Choice |
|---|---|
| Price changes after add-to-cart | Each line stores the **quoted** price. An increase → `409 PRICE_CHANGED`, listing every affected line; the client re-confirms by `PATCH`ing the line. A decrease is charged at the lower price automatically ([Decision 4](#decision-4-price-changes-re-confirm-increases-pass-on-decreases)). |
| Availability changes after add-to-cart | No reservation ([Decision 5](#decision-5-no-stock-reservation-in-carts)). Adding checks stock as early feedback only; checkout re-checks under the lock and fails with `409 INSUFFICIENT_STOCK` (every short line, `requested` and `available`). The cart stays open. |
| What is a checkout "retry"? | Same cart, same (normalised) coupon code → replay the original order. Same cart, different coupon → `409 CART_ALREADY_CHECKED_OUT` with `orderId`. A retry of a *failed* checkout simply re-evaluates, because nothing was written. |
| Payment | None. A committed checkout counts as paid. A fake gateway called inside the transaction would model the wrong pattern (an external call while holding a lock), and the real two-phase flow ([§8](#8-multiple-instances-and-production-scale)) was more than the timebox allowed to build *and* test. One fully atomic transaction is easier to defend. |
| Which orders count toward milestones? | Every placed order, including ones that used a coupon. There are no cancellations, so the count only grows. |
| When does a coupon exist? | Reaching a milestone makes it *eligible*; an admin call *generates* it ([Decision 6](#decision-6-coupon-generation-one-per-milestone-earliest-first)). |
| Who can use a coupon? | Whoever holds the code. There is no customer identity to bind it to. No expiry, one coupon per order, no minimum spend. |
| Config changes | A coupon stores its own percentage, so changing *x* never alters issued coupons. Changing *n* re-interprets future milestones only. |
| Adding a product already in the cart | `409 ITEM_ALREADY_IN_CART`, not an increment, so a retried "add 1" cannot become 2. `PATCH` sets an absolute quantity (idempotent); `DELETE` of a missing line is a no-op. |
| Admin stock changes | Deltas (`inventoryDelta: +7`), applied as `inventory + delta WHERE inventory + delta >= 0`. An absolute "set to 10" computed from a stale read would silently undo sales made in between. |

## 3. Material design decisions

### Decision 1: Embedded SQLite with invariants in the database

**Context:** Stock, coupon and order invariants must hold under concurrent and repeated
requests, possibly across several processes.

**Options considered:** in-memory maps with per-resource locks; PostgreSQL in Docker;
embedded SQLite via Node's built-in `node:sqlite`.

**Choice:** SQLite in WAL mode.

**Why:** In-memory locks only prove one process correct, and they put every invariant in
hand-written lock code. Postgres is the production answer but makes setup depend on
Docker. SQLite gives real transactions and constraints, and it locks across processes, so I could test
**three server processes against one database file**. The SQL shape (guarded updates,
unique constraints) carries over to Postgres unchanged.

**Consequences:** Setup is `npm ci && npm start`. The cost is a single writer: all writes
serialise, even unrelated ones, and a waiting process blocks its event loop (up to the
5 s `busy_timeout`). Fine here; [§8](#8-multiple-instances-and-production-scale) covers production.

### Decision 2: One pessimistic transaction per checkout (`BEGIN IMMEDIATE`)

**Context:** Checkout reads stock, coupon and cart state and then writes all three. Any
interleaving between the read and the write risks an oversell or a double redemption.

**Options considered:** optimistic version columns with retry; app-level locks per product
or coupon; one transaction that takes the write lock before the first read.

**Choice:** The last option. `inTransaction()` issues `BEGIN IMMEDIATE`, runs a
**synchronous** callback, then commits or rolls back. Every write path uses it.

**Why:** With the lock held from the first read, every check sees the latest committed
state and nothing can change before the writes. Because SQLite holds the lock on the
database file, this works across processes, not just within one. The callback must not
`await`, or other requests on the same connection could run inside our transaction, so the
helper rejects a returned Promise. A plain `BEGIN` would start as a reader and fail with
`SQLITE_BUSY` when two processes try to upgrade at once; the tests catch that ([§4](#4-transaction-concurrency-and-idempotency-strategy)).

**Consequences:** Checkout reads as straight-line code with no retry loops. Throughput is
one writer at a time; production would use row locks.

### Decision 3: The cart is the idempotency key for checkout

**Context:** Clients retry checkout after timeouts. A retry must not create a second order
or charge stock twice, and it should return the result the client missed.

**Options considered:** a generic `Idempotency-Key` header with stored responses (the
Stripe model); the natural key, since a cart can only ever be checked out once.

**Choice:** The natural key. A repeated identical checkout returns the original order
(`200`, `Idempotent-Replayed: true`); different parameters get `409`.

**Why:** The domain already guarantees "one cart, one order" (`UNIQUE(orders.cart_id)`
plus the guarded status change). A key table would be a second source of truth, and it
would miss a client that retries with a new key. The replay is built from the stored order
snapshot, so it is identical even if prices changed since.

**Consequences:** No key storage or expiry policy for checkout. Admin coupon generation
has no natural key, so it takes an explicit `Idempotency-Key` instead ([Decision 6](#decision-6-coupon-generation-one-per-milestone-earliest-first)).

### Decision 4: Price changes: re-confirm increases, pass on decreases

**Context:** A price may change between add-to-cart and checkout. The store must not
charge more than the customer saw, and must not sell indefinitely at a stale price either.

**Options considered:** silently charge the current price; honour the price at add time;
fail checkout on any difference from the quoted price; fail only on an increase and charge
a decrease at the lower price.

**Choice:** The last. Each line stores its quoted price. An increase fails checkout with
`409 PRICE_CHANGED`; a decrease is charged at the current, lower price.

**Why:** Charging the current price silently could charge more than the customer saw.
Honouring the add-time price lets a cart pin an obsolete price forever. Failing on *any*
difference, which the first draft did, makes the customer re-confirm a price that only
got better; that is friction with no protection behind it (see §9). An increase still
needs explicit consent: the error lists every affected line, and one `PATCH` re-quotes it.

**Consequences:** The cart view's `unitPriceCents` is what checkout will charge (the
lower of quoted and current), alongside `quotedUnitPriceCents` and `currentUnitPriceCents`.
Checkout freezes the lines at the charged price, so a checked-out cart agrees with its order.

### Decision 5: No stock reservation in carts

**Context:** "Never sell more than available" can be enforced at add-to-cart (reserve) or
at checkout.

**Options considered:** reserve on add with a TTL and clean-up; advisory check on add,
authoritative check and decrement at checkout.

**Choice:** The second.

**Why:** Reservations need expiry, a sweeper and an abandoned-cart policy. Without them,
three idle carts would lock up all three limited-edition sneakers. Checking at checkout
keeps the invariant in one place, inside one transaction.

**Consequences:** An item can look available in the cart and still be gone at checkout;
the error says which lines and how many remain. Reservations become necessary once
payment is asynchronous.

### Decision 6: Coupon generation: one per milestone, earliest first

**Context:** A coupon becomes available every *n*-th order and is generated on admin
request, never twice for one milestone, even if two admins click at once.

**Options considered:** generate automatically inside the checkout that reaches the
milestone; have one admin call generate all pending coupons; have one admin call
generate one coupon.

**Choice:** One coupon per call, for the earliest reached milestone without one
(milestone *k* is reached at `k × n` orders). It runs under the write lock and is backed by
`UNIQUE(milestone)`.

**Why:** The brief says an administrator *requests* generation, and auto-generation would
couple checkout to rewards. One coupon per call is a predictable effect, and
`409 NO_ELIGIBLE_MILESTONE` shows progress (`placedOrders`, next threshold).

**Consequences:** With two milestones pending, a blind retry after a timeout would mint
the second coupon. An optional `Idempotency-Key` header closes that gap. The key is stored
on the coupon (`UNIQUE`) and looked up under the write lock, so a retry returns the
original coupon (`200`, `Idempotent-Replayed: true`) and racing retries mint exactly one.
Only successes are remembered; a retry after `409` re-evaluates, as checkout does.

## 4. Transaction, concurrency and idempotency strategy

- **Within one process:** Node runs one request at a time and the SQLite driver is
  synchronous, so a transaction callback runs start to finish uninterrupted, as long as it
  cannot `await` (enforced).
- **Across processes:** `BEGIN IMMEDIATE` takes SQLite's write lock before the first read,
  so writers queue. WAL lets reads (cart views, reports) proceed without blocking. A lock
  wait longer than `busy_timeout` returns `503 SERVICE_BUSY` with `Retry-After`; nothing was
  written, so retrying is safe.
- **Checkout, inside one transaction** ([`checkout()`](src/orders.ts)):
  1. Replay or reject if the cart is already checked out.
  2. Validate: cart not empty, coupon exists and is unused, prices unchanged, stock
     sufficient.
  3. Insert the order and its item snapshots.
  4. Guarded writes, each required to hit exactly one row: decrement stock, redeem the
     coupon, close the cart.
  5. Commit. Any throw rolls everything back.

  Under the lock the guards in step 4 can't fail today. They exist so that a refactor that
  moves validation out of the transaction fails safe instead of overselling.

| Operation | On repeat |
|---|---|
| Checkout, same cart and coupon | Original order, `200` |
| Checkout, same cart, different coupon | `409 CART_ALREADY_CHECKED_OUT` + `orderId` |
| `PATCH` quantity, `DELETE` line, `GET` report | Idempotent |
| `POST` add line | `409 ITEM_ALREADY_IN_CART` |
| `POST /admin/coupons` with `Idempotency-Key` | Original coupon, `200` |
| `POST /admin/coupons` without a key | Claims the next pending milestone, if any |

**Tested, and the tests checked against deliberately broken code.**
[`multi-instance.test.ts`](test/multi-instance.test.ts) starts three server processes on
one database file and races 30 checkouts for 3 limited items, 30 retries of one cart, and
30 checkouts sharing one coupon. To confirm the tests can catch real bugs:

- Replacing `BEGIN IMMEDIATE` with `BEGIN` still passed the single-process suite, but the
  multi-instance suite failed (`503`s from lock-upgrade conflicts).
- Removing the checkout transaction made the retry and coupon races fail. The oversell test
  at first **still passed**: the guarded update kept stock at 0 while losing checkouts left
  half-written orders behind. It now also asserts the order count and fails on that bug.

## 5. Money and rounding rules

- All amounts are integer **cents** in USD. No float is ever used for an amount.
- Bounds (unit price ≤ $1,000,000, quantity ≤ 1000 per line) keep every value a safe
  integer; the helpers assert it.
- The coupon percentage is parsed from a string into basis points (`"12.5"` → 1250),
  never via `parseFloat`.
- Discount = `round_half_up(subtotal × bps / 10000)`, computed with plain integers as
  `n = subtotal × bps + 5000`, then `(n − n mod 10000) / 10000`, so the division is exact,
  then clamped to the subtotal. A total can never go negative, even at 100%.
- That stays exact while `subtotal × bps` is a safe integer: subtotals up to about
  $9 billion even at 100%. Beyond that the function throws rather than return an imprecise
  value. (The first draft used `BigInt`, which the bounds made unnecessary; see §9.)
- One rounding step per order (on the subtotal, not per line), so an order is exactly
  reproducible from its stored fields. Per-line allocation for refunds is deferred.
- Half-up, because it is what "10% off" usually means to customers and finance. Floor
  (merchant-favouring) was the alternative; the rule lives in one function.
- Reports sum stored order fields, never current prices, so `net = gross − discounts`
  holds exactly.

## 6. Error model

`{ "error": { "code", "message", "details", "requestId" } }`. The `code` is the
contract, the status is the category, and `details` carries what the client needs to
recover.

| Status | Meaning | Codes |
|---|---|---|
| 400 | Malformed request | `VALIDATION_ERROR` (field and range, or a malformed `Idempotency-Key`), `INVALID_JSON` |
| 404 | A path resource, or the product being added, does not exist | `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ITEM_NOT_IN_CART` |
| 409 | Conflicts with current state: re-read, then decide | `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, `COUPON_ALREADY_REDEEMED`, `CART_NOT_OPEN`, `CART_ALREADY_CHECKED_OUT`, `ITEM_ALREADY_IN_CART`, `NO_ELIGIBLE_MILESTONE`, `INVENTORY_WOULD_GO_NEGATIVE` |
| 422 | Well-formed but unusable as given | `CART_EMPTY`, `COUPON_NOT_FOUND` |
| 503 | Lock contention; nothing written; retry | `SERVICE_BUSY` |
| 500 | A bug | `INTERNAL_ERROR` (stack logged, never returned) |

- `COUPON_NOT_FOUND` is `422`, not `404`: on `POST /carts/:id/checkout` a 404 would read
  as "cart not found".
- `INSUFFICIENT_STOCK` and `PRICE_CHANGED` list **all** affected lines, so a UI can fix the
  cart in one pass.
- A database constraint violation means an application check was bypassed, so it stays a
  `500` that should alert someone, not a friendly `409`.

## 7. Implemented vs deferred

**Implemented:** every required endpoint, plus product listing, admin order and coupon
listings (to reconcile the report) and admin price and stock changes (to demonstrate those
scenarios). Atomic, idempotent, concurrency-safe checkout; milestone coupons with
idempotent generation; a snapshot-consistent report; an OpenAPI contract; structured
request logs; CI on Node 22 and 24; 30 tests including the 3-process suite.

**Deferred on purpose:**

- Authentication. `/admin/*` is open, and a cart id is a bearer capability.
- Payments (see §2 and §8).
- Cancellations and refunds.
- Cart expiry and pagination.
- Coupon expiry and binding coupons to customers.
- Metrics and tracing beyond logs.
- A frontend.

## 8. Multiple instances and production scale

The service is already safe with several instances on **one SQLite file**, and the tests
do exactly that. For multiple hosts I would move to **PostgreSQL** and keep the same shape
with narrower locks:

- `SELECT … FROM carts WHERE id = $1 FOR UPDATE` serialises retries of one cart only.
- Guarded `UPDATE products … WHERE inventory >= $q` in **ascending product-id order**, so
  two multi-item checkouts cannot deadlock.
- The same guarded coupon update.
- All `UNIQUE` and `CHECK` constraints kept as the backstop. `READ COMMITTED` is enough,
  because every invariant sits behind a row lock or a single-row guarded update.
- Deadlock or serialisation errors map to a bounded retry, then `503`.
- A milestone counter row instead of `COUNT(*)`.
- An async connection pool, so lock waits stop blocking the event loop.

App instances stay stateless behind a load balancer; all coordination lives in the
database.

**Real payments** would split checkout into steps:

1. Reserve stock and the coupon, and create the order as `PENDING_PAYMENT` with an expiry.
2. Call the provider **outside** the transaction, using the order id as its idempotency
   key.
3. Mark the order `PAID`, or release the stock and coupon.
4. A sweeper releases expired reservations, so a crash between steps strands nothing.

A very hot product (a limited drop with thousands of buyers) makes one row a contention
point. I would load-test it before choosing a mitigation.

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

Then I reviewed the complete first version file by file and flow by flow, and steered
these changes:

- **Scope, from the job description.** Beyond the assignment itself, I added what the
  role emphasises: an OpenAPI 3.1 contract (design-first REST), a CI workflow, and
  structured request logs with request ids.
- **Over-engineering.** The first version overdid the documentation. DECISIONS.md had 10
  decisions and a scaling section full of technologies I could not defend in depth, and
  the API was documented three overlapping ways. I cut it to six decisions, a scaling
  section limited to what I can explain, and one API reference (OpenAPI) plus a summary
  table.
- **Three design changes.** The review surfaced choices that were stricter or heavier
  than they needed to be. I changed three of them, each in its own commit with tests:
  - *Price drops no longer block checkout.* The first version failed checkout on any
    price difference, so a customer had to re-confirm a price that had only gone down.
    Now only increases need re-confirmation ([Decision 4](#decision-4-price-changes-re-confirm-increases-pass-on-decreases)).
  - *`BigInt` removed from the discount math.* The input bounds already keep the
    arithmetic exact, so `BigInt` added complexity without benefit. It is now plain
    integer math that throws past the safe range instead of losing precision ([§5](#5-money-and-rounding-rules)).
  - *Coupon generation made idempotent.* The first version listed this as a known gap:
    with two milestones pending, an admin's retry minted a second coupon. An optional
    `Idempotency-Key` now returns the original coupon ([Decision 6](#decision-6-coupon-generation-one-per-milestone-earliest-first)).

**Problems caught by verification** (each fixed and re-tested):

- **The oversell test was too weak.** When the checkout transaction was deliberately
  removed (mutation testing), the test still passed while losing checkouts left
  half-written orders behind. It now also asserts the order count, and fails on that bug.
- **A test expectation was wrong, not the code.** A hand-computed expected discount for a
  very large amount was off by 10,000 cents. The correct value was confirmed independently
  with `BigInt` arithmetic before the test, not the code, was changed.
- **Middleware order.** A manual smoke test showed `INVALID_JSON` errors had no
  `requestId`, because the JSON parser ran before the request-id middleware.

## 10. With two more hours

1. **Payment as a reservation flow**, with tests that crash between steps. That is where
   "a failed checkout lost a coupon" bugs really live.
2. **Run the suite against PostgreSQL** behind a small repository interface, to verify §8's
   lock-ordering claims instead of only stating them.
3. **Load-test the hot-product path** across three instances (lock wait, `503` rate, tail
   latency).
4. **A property-based test** that random interleavings of checkouts, retries and coupon
   generations always reconcile in the report.
