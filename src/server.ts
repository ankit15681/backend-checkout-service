import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const server = createApp(db, config, log).listen(config.port, () => {
  const { port } = server.address() as AddressInfo;
  log({
    msg: 'listening',
    port,
    pid: process.pid,
    dbPath: config.dbPath,
    couponEveryNOrders: config.couponEveryNOrders,
    couponDiscountBps: config.couponDiscountBps,
  });
});

function shutdown(signal: string) {
  log({ msg: 'shutting down', signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
