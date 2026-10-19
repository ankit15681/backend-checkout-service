import type { SQLInputValue } from 'node:sqlite';
import type { DB } from './db.ts';

// Thin typed wrappers: node:sqlite returns loosely-typed rows; callers declare the shape.

export function one<T>(db: DB, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function many<T>(db: DB, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Executes a write and returns the number of rows it changed. */
export function run(db: DB, sql: string, ...params: SQLInputValue[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}
