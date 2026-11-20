import { withTransaction, id } from '../db/database.js';
import { nowUtcMs } from '../shared/time.js';
import { createSubscription, recordEvent } from './subscriptions.js';
import { requestCorrection } from './corrections.js';
import { writeAudit } from './audit.js';

/**
 * Provider-agnostic webhook intake. The provider event id is the idempotency
 * key stored in `webhook_events`:
 *   - first delivery  -> process once, mark `processed`
 *   - any redelivery -> marked `duplicate`, handler is NOT re-run, the first
 *                       result is returned byte-for-byte
 *
 * Handlers themselves also carry per-entity idempotency keys, so even a row
 * inserted but not yet marked processed cannot double-apply.
 */
export function ingestWebhook(db, { eventId, eventType, payload, actor = 'webhook' }) {
  if (!eventId || !eventType || typeof payload !== 'object') {
    throw Object.assign(new Error('eventId, eventType and object payload are required'), { status: 400 });
  }

  const existing = db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get(eventId);
  if (existing) {
    if (existing.status !== 'duplicate') {
      db.prepare("UPDATE webhook_events SET status = 'duplicate' WHERE event_id = ?").run(eventId);
    }
    writeAudit(db, {
      actor,
      action: 'webhook.duplicate',
      entityType: 'webhook_event',
      entityId: eventId,
      after: { originalStatus: existing.status },
    });
    return {
      duplicate: true,
      status: existing.status,
      result: existing.result_subscription_id,
      firstProcessedAt: existing.processed_at,
    };
  }

  db.prepare(
    `INSERT INTO webhook_events (event_id, event_type, payload, status, received_at)
     VALUES (?, ?, ?, 'received', ?)`,
  ).run(eventId, eventType, JSON.stringify(payload), nowUtcMs());

  try {
    const result = dispatch(db, eventType, payload, eventId, actor);
    withTransaction(db, () => {
      db.prepare(
        `UPDATE webhook_events SET status = 'processed', result_subscription_id = ?,
         processed_at = ? WHERE event_id = ?`,
      ).run(result.subscriptionId || null, nowUtcMs(), eventId);
      writeAudit(db, {
        actor,
        action: 'webhook.processed',
        entityType: 'webhook_event',
        entityId: eventId,
        after: { eventType, result },
      });
    });
    return { duplicate: false, status: 'processed', ...result };
  } catch (err) {
    db.prepare('UPDATE webhook_events SET status = ?, error_message = ? WHERE event_id = ?')
      .run('failed', String(err.message || err), eventId);
    writeAudit(db, {
      actor,
      action: 'webhook.failed',
      entityType: 'webhook_event',
      entityId: eventId,
      after: { error: String(err.message || err) },
    });
    throw err;
  }
}

function dispatch(db, eventType, payload, eventId, actor) {
  const key = (suffix) => `${eventId}:${suffix}`;
  switch (eventType) {
    case 'subscription.created': {
      const sub = createSubscription(db, {
        customerName: payload.customerName,
        planId: payload.planId,
        timezone: payload.timezone,
        anchorDate: payload.anchorDate,
        idempotencyKey: key('created'),
        actor: 'webhook',
        reason: payload.reason || 'webhook subscription.created',
      });
      return { subscriptionId: sub.id };
    }

    case 'subscription.plan_changed':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.canceled': {
      const type = eventType.replace('subscription.', '');
      const { event, subscription, duplicate } = recordEvent(db, payload.subscriptionId, {
        type,
        effectiveDate: payload.effectiveDate,
        planId: payload.planId || null,
        reason: payload.reason || `webhook ${eventType}`,
        source: 'webhook',
        idempotencyKey: key(type),
        actor,
      });

      // Duplicate lifecycle callback: nothing changed, no correction either.
      if (duplicate) return { subscriptionId: subscription.id, duplicate: true };

      // Retroactive / effective-dated change: issued bills may now be wrong.
      // Only correct when issued invoices overlap the event's effective date.
      const needsCorrection = db
        .prepare(
          `SELECT 1 FROM invoices
           WHERE subscription_id = ? AND status IN ('issued','paid')
             AND period_end > ? LIMIT 1`,
        )
        .get(payload.subscriptionId, event.effective_at);

      let correctionId = null;
      if (needsCorrection) {
        const correction = requestCorrection(db, payload.subscriptionId, event.id, {
          reason: `webhook ${eventType} effective ${payload.effectiveDate}`,
          actor,
        });
        correctionId = correction.id;
      }
      return { subscriptionId: subscription.id, eventId: event.id, correctionId };
    }

    default:
      throw Object.assign(new Error(`unsupported webhook event type: ${eventType}`), {
        status: 400,
        code: 'UNSUPPORTED_EVENT',
      });
  }
}

export function listWebhookEvents(db) {
  return db
    .prepare('SELECT * FROM webhook_events ORDER BY received_at DESC, rowid DESC LIMIT 200')
    .all()
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export { id };
