import { id, withTransaction } from '../db/database.js';
import { nowUtcMs, toIso } from '../shared/time.js';
import { requireInvoice } from './billing.js';
import { requireSubscription } from './subscriptions.js';
import { enqueueNotification } from './notifications.js';
import { writeAudit } from './audit.js';

/**
 * Refunds never edit invoices: they are separate credit records against an
 * existing (immutable) bill. Total refunded amount cannot exceed what the
 * customer actually paid on that invoice, and the same idempotency key always
 * returns the same refund — safe under webhook redelivery and double-clicks.
 */
export function createRefund(db, {
  subscriptionId,
  invoiceId,
  amountCents,
  reason,
  idempotencyKey,
  actor = 'api',
}) {
  if (!idempotencyKey) throw Object.assign(new Error('idempotencyKey is required'), { status: 400 });
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error('amountCents must be a positive integer'), { status: 400 });
  }

  return withTransaction(db, () => {
    const dup = db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').get(idempotencyKey);
    if (dup) return { refund: dup, duplicate: true };

    const sub = requireSubscription(db, subscriptionId);
    const invoice = requireInvoice(db, invoiceId);
    if (invoice.subscription_id !== sub.id) {
      throw Object.assign(new Error('invoice does not belong to subscription'), { status: 400 });
    }
    if (invoice.status !== 'issued' && invoice.status !== 'paid') {
      throw Object.assign(new Error(`cannot refund a ${invoice.status} invoice`), { status: 409 });
    }

    const already = db
      .prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE invoice_id = ? AND status != 'failed'",
      )
      .get(invoiceId).s;
    if (already + amountCents > invoice.total_cents) {
      throw Object.assign(
        new Error(
          `refund ${amountCents} exceeds payable balance: ${invoice.total_cents - already} cents left`,
        ),
        { status: 409, code: 'REFUND_EXCEEDS_BALANCE' },
      );
    }

    const refundId = id('ref');
    db.prepare(
      `INSERT INTO refunds
        (id, subscription_id, invoice_id, amount_cents, reason, status,
         idempotency_key, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(refundId, subscriptionId, invoiceId, amountCents, reason || '', idempotencyKey, nowUtcMs(), nowUtcMs());

    if (invoice.status === 'paid') {
      // refunds reduce cash but never mutate the historical bill's totals
    }
    enqueueNotification(db, {
      subscriptionId,
      type: 'refund_completed',
      idempotencyKey: `ntf:refund:${refundId}`,
      payload: {
        subscription_id: subscriptionId,
        refund_id: refundId,
        invoice_id: invoiceId,
        amount_cents: amountCents,
        currency: invoice.currency,
        reason,
        at: toIso(nowUtcMs()),
      },
    });
    writeAudit(db, {
      actor,
      action: 'refund.created',
      entityType: 'refund',
      entityId: refundId,
      after: { subscriptionId, invoiceId, amountCents, reason },
    });
    return { refund: getRefund(db, refundId), duplicate: false };
  });
}

export function getRefund(db, refundId) {
  return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
}

export function listRefunds(db, subscriptionId) {
  return subscriptionId
    ? db.prepare('SELECT * FROM refunds WHERE subscription_id = ? ORDER BY created_at DESC').all(subscriptionId)
    : db.prepare('SELECT * FROM refunds ORDER BY created_at DESC').all();
}
