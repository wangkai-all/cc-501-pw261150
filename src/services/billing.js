import { id, withTransaction } from '../db/database.js';
import { localDateToUtc, utcToLocalDate, nowUtcMs, toIso } from '../shared/time.js';
import {
  buildDayTimeline,
  computePeriods,
  linesToUtc,
  periodBoundsUtc,
} from '../billing/engine.js';
import { plansById } from './plans.js';
import { listEvents, requireSubscription } from './subscriptions.js';
import { enqueueNotification } from './notifications.js';
import { writeAudit } from './audit.js';

/** All invoice rows for one subscription with lines, newest version first. */
export function listInvoices(db, subscriptionId) {
  const invoices = db
    .prepare(
      `SELECT * FROM invoices WHERE subscription_id = ?
       ORDER BY period_sequence, version DESC`,
    )
    .all(subscriptionId);
  return invoices.map((inv) => attachLines(db, inv));
}

/** The current (non-superseded) invoice per period sequence. */
export function currentInvoices(db, subscriptionId) {
  return db
    .prepare(
      `SELECT * FROM invoices
       WHERE subscription_id = ? AND superseded_by IS NULL
       ORDER BY period_sequence`,
    )
    .all(subscriptionId)
    .map((inv) => attachLines(db, inv));
}

export function getInvoice(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  return inv ? attachLines(db, inv) : null;
}

export function requireInvoice(db, invoiceId) {
  const inv = getInvoice(db, invoiceId);
  if (!inv) throw Object.assign(new Error('invoice not found'), { status: 404 });
  return inv;
}

function attachLines(db, inv) {
  const lines = db
    .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid')
    .all(inv.id);
  return { ...inv, lines };
}

function buildInvoiceDraft(db, sub, period, currency, { correctionId = null } = {}) {
  const { periodStart, periodEnd } = periodBoundsUtc(period, sub.timezone);
  const lines = linesToUtc(period.lines, sub.timezone);
  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  // Simple deterministic tax rule: 0%. Kept as an explicit field so a tax
  // engine can be plugged in without touching the versioning model.
  const tax = 0;
  return {
    subscriptionId: sub.id,
    periodStart,
    periodEnd,
    periodSequence: period.sequence,
    currency,
    subtotal,
    tax,
    total: subtotal + tax,
    lines,
    correctionId,
  };
}

function insertInvoice(db, draft, { version, status, issued }) {
  const invoiceId = id('inv');
  db.prepare(
    `INSERT INTO invoice_records
      (id, subscription_id, period_start, period_end, period_sequence, version,
       status, currency, subtotal_cents, tax_cents, total_cents, correction_id,
       created_at, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invoiceId,
    draft.subscriptionId,
    draft.periodStart,
    draft.periodEnd,
    draft.periodSequence,
    version,
    status,
    draft.currency,
    draft.subtotal,
    draft.tax,
    draft.total,
    draft.correctionId,
    nowUtcMs(),
    issued ? nowUtcMs() : null,
  );
  // Point the logical bill at this record. Corrections later move this pointer.
  db.prepare(
    `INSERT INTO invoice_versions (subscription_id, period_sequence, current_record_id)
     VALUES (?, ?, ?)
     ON CONFLICT (subscription_id, period_sequence)
     DO UPDATE SET current_record_id = excluded.current_record_id`,
  ).run(draft.subscriptionId, draft.periodSequence, invoiceId);
  for (const line of draft.lines) {
    db.prepare(
      `INSERT INTO invoice_lines
        (id, invoice_id, kind, plan_id, range_start, range_end, days,
         unit_label, amount_cents, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id('ln'),
      invoiceId,
      line.kind,
      line.plan_id,
      line.range_start,
      line.range_end,
      line.days,
      line.unit_label,
      line.amount_cents,
      line.detail,
    );
  }
  return invoiceId;
}

/**
 * Issue all billable periods that have closed as of `asOfUtc`. Idempotent:
 * already-invoised sequences are skipped (the UNIQUE(period, version) plus an
 * explicit existence check make concurrent double-runs collapse to one bill).
 */
export function runBilling(db, { asOfUtc = nowUtcMs(), subscriptionId = null, actor = 'billing-job' } = {}) {
  const subs = subscriptionId
    ? [requireSubscription(db, subscriptionId)]
    : db.prepare("SELECT * FROM subscriptions WHERE status != 'canceled' OR canceled_at IS NOT NULL").all();
  const summary = { issued: [], skipped: [], errors: [] };
  const plans = plansById(db);

  for (const sub of subs) {
    try {
      withTransaction(db, () => {
        const events = listEvents(db, sub.id);
        const timeline = buildDayTimeline(sub, events, asOfUtc);
        const periods = computePeriods(timeline, sub.anchor_date, plans);
        const existing = new Set(
          db
            .prepare('SELECT period_sequence FROM invoices WHERE subscription_id = ?')
            .all(sub.id)
            .map((r) => r.period_sequence),
        );

        for (const period of periods) {
          if (existing.has(period.sequence)) {
            summary.skipped.push({ subscriptionId: sub.id, sequence: period.sequence });
            continue;
          }
          // Open period: still accruing active days and not canceled.
          if (!period.complete && !period.endedByCancel) {
            summary.skipped.push({ subscriptionId: sub.id, sequence: period.sequence, open: true });
            continue;
          }
          const plan = plans[events.find((e) => e.plan_id)?.plan_id] || plans[sub.plan_id];
          const draft = buildInvoiceDraft(db, sub, period, plan?.currency || 'USD');
          const invoiceId = insertInvoice(db, draft, { version: 1, status: 'issued', issued: true });
          enqueueNotification(db, {
            subscriptionId: sub.id,
            type: 'invoice_issued',
            idempotencyKey: `ntf:invoice_issued:${invoiceId}`,
            payload: {
              subscription_id: sub.id,
              invoice_id: invoiceId,
              period_sequence: period.sequence,
              total_cents: draft.total,
              currency: draft.currency,
              period: {
                start: toIso(draft.periodStart),
                end: toIso(draft.periodEnd),
              },
            },
          });
          writeAudit(db, {
            actor,
            action: 'invoice.issued',
            entityType: 'invoice',
            entityId: invoiceId,
            after: { subscriptionId: sub.id, sequence: period.sequence, totalCents: draft.total },
          });
          summary.issued.push({ subscriptionId: sub.id, sequence: period.sequence, invoiceId, totalCents: draft.total });
        }
      });
    } catch (err) {
      summary.errors.push({ subscriptionId: sub.id, error: String(err.message || err) });
    }
  }
  return summary;
}

/**
 * Recompute every period of a subscription from its immutable events. Used by
 * corrections: returns fresh drafts for *all* sequences so callers can diff
 * against whatever version is currently issued.
 */
export function recomputeAll(db, sub, { asOfUtc = nowUtcMs(), correctionId = null } = {}) {
  const plans = plansById(db);
  const events = listEvents(db, sub.id);
  const timeline = buildDayTimeline(sub, events, asOfUtc);
  const periods = computePeriods(timeline, sub.anchor_date, plans);
  return periods.map((period) => {
    const plan = plans[period.lines.find((l) => l.planId)?.planId] || plans[sub.plan_id];
    return buildInvoiceDraft(db, sub, period, plan?.currency || 'USD', { correctionId });
  });
}

export { insertInvoice, buildInvoiceDraft };
export { localDateToUtc, utcToLocalDate };
