import { id } from '../db/database.js';
import { writeAudit } from './audit.js';

/**
 * Notifications are an outbox: business logic only ever enqueues rows inside
 * the same transaction as the state change. A separate delivery step marks
 * them sent/failed with attempt counts, so a crash can never lose a notice and
 * duplicate keys can never produce two customer emails for one bill.
 */
export function enqueueNotification(db, { subscriptionId, type, payload, idempotencyKey }) {
  db.prepare(
    `INSERT INTO notifications
       (id, subscription_id, type, payload, status, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
  ).run(id('ntf'), subscriptionId, type, JSON.stringify(payload), idempotencyKey, Date.now());
}

/**
 * Attempt delivery of pending (and retryable failed) notifications.
 * `transport` defaults to an in-process console transport; inject a failing one
 * in tests to prove retry/backoff bookkeeping.
 */
export function deliverPending(db, transport = defaultTransport, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE status = 'pending'
          OR (status = 'failed' AND attempts < max_attempts)
       ORDER BY created_at LIMIT ?`,
    )
    .all(limit);

  const outcomes = [];
  for (const row of rows) {
    const attempts = row.attempts + 1;
    try {
      transport({ type: row.type, payload: JSON.parse(row.payload) });
      db.prepare(
        `UPDATE notifications SET status = 'sent', attempts = ?, last_error = NULL, sent_at = ?
         WHERE id = ?`,
      ).run(attempts, Date.now(), row.id);
      writeAudit(db, {
        actor: 'notifier',
        action: 'notification.sent',
        entityType: 'notification',
        entityId: row.id,
        after: { type: row.type, attempts },
      });
      outcomes.push({ id: row.id, ok: true });
    } catch (err) {
      const status = attempts >= row.max_attempts ? 'failed' : 'pending';
      db.prepare(
        `UPDATE notifications SET status = ?, attempts = ?, last_error = ? WHERE id = ?`,
      ).run(status, attempts, String(err.message || err), row.id);
      writeAudit(db, {
        actor: 'notifier',
        action: 'notification.delivery_failed',
        entityType: 'notification',
        entityId: row.id,
        after: { type: row.type, attempts, status, error: String(err.message || err) },
      });
      outcomes.push({ id: row.id, ok: false, error: String(err.message || err) });
    }
  }
  return outcomes;
}

export function listNotifications(db, { subscriptionId, limit = 200 } = {}) {
  const rows = subscriptionId
    ? db
        .prepare(
          'SELECT * FROM notifications WHERE subscription_id = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(subscriptionId, limit)
    : db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function defaultTransport({ type, payload }) {
  // Real deployments would call an email/SMS/webhook provider here.
  console.log(`[notify] ${type} -> sub ${payload.subscriptionId ?? payload.subscription_id}:`,
    JSON.stringify(payload));
}
