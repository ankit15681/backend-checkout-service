import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { AppError, errors } from './errors.ts';
import { MAX_UNIT_PRICE_CENTS } from './money.ts';
import { getProduct, listProducts, updateProduct } from './products.ts';

export type Logger = (entry: Record<string, unknown>) => void;

export function createApp(db: DB, config: Config, log: Logger = () => {}) {
  const app = express();
  app.disable('x-powered-by');

  // Request id + one structured log line per request. Registered before body parsing
  // so malformed-JSON errors are also tagged and logged.
  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') || randomUUID();
    res.locals.requestId = requestId;
    res.set('X-Request-Id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      log({
        msg: 'request',
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        errorCode: res.locals.errorCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ---- Catalog ---------------------------------------------------------------
  app.get('/products', (_req, res) => {
    res.json({ products: listProducts(db) });
  });
  app.get('/products/:productId', (req, res) => {
    res.json(getProduct(db, req.params.productId));
  });

  // ---- Administration (unauthenticated by design of the exercise) ------------
  app.patch('/admin/products/:productId', (req, res) => {
    const body = objectBody(req);
    const patch: { priceCents?: number; inventoryDelta?: number } = {};
    if (body.priceCents !== undefined) patch.priceCents = integerInRange(body.priceCents, 'priceCents', 0, MAX_UNIT_PRICE_CENTS);
    if (body.inventoryDelta !== undefined) {
      patch.inventoryDelta = integerInRange(body.inventoryDelta, 'inventoryDelta', -1_000_000, 1_000_000);
    }
    if (patch.priceCents === undefined && patch.inventoryDelta === undefined) {
      throw errors.validation('Provide priceCents and/or inventoryDelta');
    }
    res.json(updateProduct(db, req.params.productId, patch));
  });

  app.use((req, _res, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId as string;
    const appError = toAppError(err);
    if (!appError) log({ msg: 'unhandled error', requestId, error: err instanceof Error ? err.stack : String(err) });
    const e = appError ?? new AppError(500, 'INTERNAL_ERROR', 'Unexpected server error');
    res.locals.errorCode = e.code;
    if (e.code === 'SERVICE_BUSY') res.set('Retry-After', '1');
    res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details ?? null, requestId } });
  });

  return app;
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  const e = err as { type?: string; code?: string; errcode?: number };
  if (e?.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (e?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  // SQLITE_BUSY (5) after busy_timeout: lock contention, safe for the client to retry.
  if (e?.code === 'ERR_SQLITE_ERROR' && ((e.errcode ?? 0) & 0xff) === 5) {
    return new AppError(503, 'SERVICE_BUSY', 'Database is busy; retry the request');
  }
  return null;
}

// ---- Input validation -------------------------------------------------------

function objectBody(req: Request): Record<string, unknown> {
  if (req.body === undefined) return {};
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    throw errors.validation('Request body must be a JSON object');
  }
  return req.body as Record<string, unknown>;
}

function integerInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw errors.validation(`${field} must be an integer between ${min} and ${max}`, { field, min, max });
  }
  return value;
}
