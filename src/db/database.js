import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.js';

let singleton = null;

export function openDb(filename = process.env.BILLING_DB || './data/billing.db') {
  const db = new DatabaseSync(filename);
  // Wait up to 5s on a contended write lock instead of throwing SQLITE_BUSY
  // immediately; BEGIN IMMEDIATE then cleanly serializes concurrent writers.
  db.exec('PRAGMA busy_timeout = 5000');
  applySchema(db);
  return db;
}

export function getDb(filename) {
  if (!singleton) singleton = openDb(filename);
  return singleton;
}

export function closeDb(db = singleton) {
  if (db) {
    db.close();
    if (db === singleton) singleton = null;
  }
}

/**
 * Run `fn` inside BEGIN IMMEDIATE ... COMMIT. BEGIN IMMEDIATE acquires the
 * write lock up front, so concurrent API requests serialize instead of
 * hitting SQLITE_BUSY mid-work; any throw rolls the whole unit back.
 *
 * node:sqlite does not expose SAVEPOINT nesting helpers, so nested calls reuse
 * the outer transaction (savepoint emulation for safety).
 */
export function withTransaction(db, fn) {
  const depth = db._txDepth || 0;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE');
    db._txDepth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      db._txDepth = 0;
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* connection may already be rolled back */
      }
      db._txDepth = 0;
      throw err;
    }
  }
  db.exec(`SAVEPOINT sp_${depth}`);
  db._txDepth = depth + 1;
  try {
    const result = fn();
    db.exec(`RELEASE sp_${depth}`);
    db._txDepth = depth;
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO sp_${depth}`);
    db.exec(`RELEASE sp_${depth}`);
    db._txDepth = depth;
    throw err;
  }
}

export function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
