import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

// Constraints here are the last line of defence: the service checks every rule first
// and returns a useful error, but if a bug (or a second writer) slips past those checks,
// the database rejects the write instead of persisting a broken invariant.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  inventory   INTEGER NOT NULL CHECK (inventory >= 0),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id                 TEXT NOT NULL REFERENCES carts(id),
  product_id              TEXT NOT NULL REFERENCES products(id),
  quantity                INTEGER NOT NULL CHECK (quantity > 0),
  quoted_unit_price_cents INTEGER NOT NULL CHECK (quoted_unit_price_cents >= 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  cart_id        TEXT NOT NULL UNIQUE REFERENCES carts(id),  -- one order per cart, ever
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  coupon_code    TEXT UNIQUE,                                -- a coupon discounts at most one order
  discount_bps   INTEGER,
  discount_cents INTEGER NOT NULL CHECK (discount_cents BETWEEN 0 AND subtotal_cents),
  total_cents    INTEGER NOT NULL CHECK (total_cents = subtotal_cents - discount_cents),
  created_at     TEXT NOT NULL
);

-- Snapshot of what was bought, independent of later product edits.
CREATE TABLE IF NOT EXISTS order_items (
  order_id         TEXT NOT NULL REFERENCES orders(id),
  product_id       TEXT NOT NULL,
  product_name     TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents = unit_price_cents * quantity),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code              TEXT PRIMARY KEY,
  milestone         INTEGER NOT NULL UNIQUE CHECK (milestone >= 1),  -- one coupon per milestone
  order_threshold   INTEGER NOT NULL,
  discount_bps      INTEGER NOT NULL CHECK (discount_bps BETWEEN 1 AND 10000),
  created_at        TEXT NOT NULL,
  redeemed_order_id TEXT UNIQUE REFERENCES orders(id),
  redeemed_at       TEXT,
  idempotency_key   TEXT UNIQUE                                     -- replays a retried admin request
);
`;

export const SEED_PRODUCTS = [
  { id: 'keyboard', name: 'Mechanical Keyboard', priceCents: 7_999, inventory: 50 },
  { id: 'mouse', name: 'Wireless Mouse', priceCents: 2_499, inventory: 100 },
  { id: 'monitor', name: '27-inch 4K Monitor', priceCents: 32_999, inventory: 20 },
  { id: 'usb-c-cable', name: 'USB-C Cable (2m)', priceCents: 999, inventory: 500 },
  { id: 'headphones', name: 'Noise-Cancelling Headphones', priceCents: 19_999, inventory: 10 },
  { id: 'limited-sneakers', name: 'Limited Edition Sneakers', priceCents: 14_999, inventory: 3 },
] as const;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first: other processes may hold the lock while we set up.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

/**
 * Upgrades databases created before a column existed. Runs under the write lock and
 * re-checks inside it, so several instances starting at once cannot both apply it.
 */
function migrate(db: DB): void {
  inTransaction(db, () => {
    const columns = (db.prepare('PRAGMA table_info(coupons)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('idempotency_key')) {
      db.exec('ALTER TABLE coupons ADD COLUMN idempotency_key TEXT');
      db.exec('CREATE UNIQUE INDEX coupons_idempotency_key ON coupons (idempotency_key)');
    }
  });
}

function seed(db: DB): void {
  // INSERT OR IGNORE: safe to run from several instances starting at once, and never
  // resets inventory of an existing database.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO products (id, name, price_cents, inventory, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  inTransaction(db, () => {
    for (const p of SEED_PRODUCTS) insert.run(p.id, p.name, p.priceCents, p.inventory, now);
  });
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE ... COMMIT. IMMEDIATE takes SQLite's write lock up
 * front, so every read inside `fn` sees the latest committed state and no other writer
 * (in this or any other process) can interleave until we commit or roll back.
 *
 * `fn` must be synchronous: an `await` inside would let other requests on this same
 * connection run statements inside our transaction.
 */
export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('inTransaction callback must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Read-only snapshot: a deferred transaction gives all reads one consistent view. */
export function inReadSnapshot<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    if (db.isTransaction) db.exec('COMMIT');
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
