import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createApp } from '../src/app.ts';
import { type Config, percentToBps } from '../src/config.ts';
import { openDatabase } from '../src/db.ts';

export interface HttpResult {
  status: number;
  headers: Headers;
  // Tests assert on response shapes; `any` keeps them readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export type Api = ReturnType<typeof client>;

export function client(baseUrl: string) {
  async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  return {
    baseUrl,
    call,
    async createCart(items: [productId: string, quantity: number][] = []): Promise<string> {
      const cartId: string = (await call('POST', '/carts')).body.id;
      for (const [productId, quantity] of items) {
        const res = await call('POST', `/carts/${cartId}/items`, { productId, quantity });
        if (res.status !== 201) throw new Error(`setup: add ${productId} failed: ${JSON.stringify(res.body)}`);
      }
      return cartId;
    },
    checkout: (cartId: string, couponCode?: string) =>
      call('POST', `/carts/${cartId}/checkout`, couponCode === undefined ? {} : { couponCode }),
    getCart: async (cartId: string) => (await call('GET', `/carts/${cartId}`)).body,
    inventory: async (productId: string): Promise<number> =>
      (await call('GET', `/products/${productId}`)).body.availableInventory,
    report: async () => (await call('GET', '/admin/report')).body,
    /** Places `count` simple orders (one USB-C cable each), e.g. to reach coupon milestones. */
    async placeOrders(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const cartId = await this.createCart([['usb-c-cable', 1]]);
        const res = await this.checkout(cartId);
        if (res.status !== 201) throw new Error(`setup: checkout failed: ${JSON.stringify(res.body)}`);
      }
    },
    async generateCoupon(): Promise<string> {
      const res = await call('POST', '/admin/coupons');
      if (res.status !== 201) throw new Error(`setup: coupon generation failed: ${JSON.stringify(res.body)}`);
      return res.body.code;
    },
  };
}

export function tempDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'checkout-test-'));
  return { dbPath: join(dir, 'checkout.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Starts the real HTTP app in-process on an ephemeral port with a fresh database file. */
export async function startServer(opts: { everyNOrders?: number; discountPercent?: string } = {}) {
  const { dbPath, cleanup } = tempDbPath();
  const config: Config = {
    port: 0,
    dbPath,
    couponEveryNOrders: opts.everyNOrders ?? 5,
    couponDiscountBps: percentToBps(opts.discountPercent ?? '10'),
  };
  const db = openDatabase(dbPath);
  const server = createApp(db, config).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    ...client(`http://127.0.0.1:${port}`),
    db,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      cleanup();
    },
  };
}

/** Spawns `src/server.ts` as a separate OS process: a genuinely separate app instance. */
export async function spawnInstance(dbPath: string, env: Record<string, string> = {}) {
  const child: ChildProcess = spawn(process.execPath, ['src/server.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: '0', DB_PATH: dbPath, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('instance did not start')), 10_000);
    child.once('exit', (code) => reject(new Error(`instance exited early with ${code}`)));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const entry = JSON.parse(line);
      if (entry.msg === 'listening') {
        clearTimeout(timer);
        resolve(entry.port);
      }
    });
  });
  return {
    ...client(`http://127.0.0.1:${port}`),
    async stop() {
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}

export function countBy<T>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}
