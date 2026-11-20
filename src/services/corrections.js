import { id, withTransaction } from '../db/database.js';
import { nowUtcMs, toIso, localDateToUtc, utcToLocalDate } from '../shared/time.js';
import { requireSubscription, listEvents, getEvent } from './subscriptions.js';
import { recomputeAll, insertInvoice } from './billing.js';
import { enqueueNotification } from './notifications.js';
import { writeAudit } from './audit.js';

// Failure injection switch for the failure-recovery tests/demo. When set, the
// apply phase throws after the correction row exists but before commit, so the
// DB transaction rolls back while the *pending* marker (written in phase 1)
// survives — exactly the real-world "crash between reserve and apply" case.
let faultOnNextApply = false;
export function injectApplyFault() {
  faultOnNextApply = true;
}

export function listCorrections(db, subscriptionId) {
  const rows = subscriptionId
    ? db.prepare('SELECT * FROM corrections WHERE subscription_id = ? ORDER BY created_at DESC').all(subscriptionId)
    : db.prepare('SELECT * FROM corrections ORDER BY created_at DESC').all();
  return rows.map((r) => ({ ...r, diffs: listDiffs(db, r.id) }));
}

export function getCorrection(db, correctionId) {
  const row = db.prepare('SELECT * FROM corrections WHERE id = ?').get(correctionId);
  return row ? { ...row, diffs: listDiffs(db, row.id) } : null;
}

export function listDiffs(db, correctionId) {
  return db
    .prepare('SELECT * FROM invoice_diffs WHERE correction_id = ? ORDER BY period_sequence')
    .all(correctionId);
}

export function correctionKey(subscriptionId, triggerEventId) {
  return `corr:${subscriptionId}:${triggerEventId}`;
}

/**
 * Entry point used by webhook handling and the admin API. Idempotent on
 * (subscription, trigger event): the same event can be delivered any number of
 * times and produces exactly one correction.
 *
 * Two phases:
 *   1. reserve  — own transaction, persists a `pending` correction + recalc
 *                 range. Survives crashes of phase 2.
 *   2. apply    — own transaction, builds new invoice versions + diffs +
 *                 notifications, then flips the marker to `applied`.
 */
export function requestCorrection(db, subscriptionId, triggerEventId, {
  reason,
  asOfUtc = nowUtcMs(),
  actor = 'system',
} = {}) {
  const sub = requireSubscription(db, subscriptionId);
  const trigger = getEvent(db, triggerEventId);
  if (!trigger) throw Object.assign(new Error('trigger event not found'), { status: 404 });
  const key = correctionKey(subscriptionId, triggerEventId);

  // Fast path: already applied -> return the existing correction unchanged.
  const existing = db.prepare('SELECT * FROM corrections WHERE idempotency_key = ?').get(key);
  if (existing && existing.status === 'applied') {
    return getCorrection(db, existing.id);
  }

  let correctionId = existing?.id;
  if (!existing) {
    correctionId = reserveCorrection(db, {
      subscriptionId,
      triggerEventId,
      reason: reason || `correction after ${trigger.type}`,
      asOfUtc,
      actor,
      key,
    });
  }

  try {
    applyCorrection(db, correctionId, { asOfUtc, actor });
  } catch (err) {
    // The apply transaction rolled back. Keep the pending marker so recovery
    // (or a webhook redelivery) can finish the job; record failure only if the
    // marker itself is still present.
    const marker = db.prepare('SELECT * FROM corrections WHERE id = ?').get(correctionId);
    if (marker && marker.status === 'pending') {
      db.prepare('UPDATE corrections SET status = ?, error_message = ? WHERE id = ?')
        .run('failed', String(err.message || err), correctionId);
      writeAudit(db, {
        actor,
        action: 'correction.failed',
        entityType: 'correction',
        entityId: correctionId,
        after: { error: String(err.message || err) },
      });
    }
    throw err;
  }
  return getCorrection(db, correctionId);
}

function reserveCorrection(db, { subscriptionId, triggerEventId, reason, asOfUtc, actor, key }) {
  return withTransaction(db, () => {
    const sub = requireSubscription(db, subscriptionId);
    const trigger = getEvent(db, triggerEventId);
    // Recalc range: from the start of the billing period containing the event
    // up to "now" (the latest period that could have been billed wrongly).
    const recalcFrom = trigger.effective_at;
    const recalcTo = asOfUtc;
    const correctionId = id('cor');
    db.prepare(
      `INSERT INTO corrections
        (id, subscription_id, trigger_event_id, reason, recalc_from, recalc_to,
         status, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(correctionId, subscriptionId, triggerEventId, reason, recalcFrom, recalcTo, key, nowUtcMs());
    writeAudit(db, {
      actor,
      action: 'correction.reserved',
      entityType: 'correction',
      entityId: correctionId,
      after: {
        subscriptionId,
        triggerEventId,
        recalcFrom: toIso(recalcFrom),
        recalcTo: toIso(recalcTo),
        triggerDate: trigger.effective_date,
      },
    });
    return correctionId;
  });
}

function applyCorrection(db, correctionId, { asOfUtc = nowUtcMs(), actor = 'system' } = {}) {
  withTransaction(db, () => {
    const correction = db.prepare('SELECT * FROM corrections WHERE id = ?').get(correctionId);
    if (!correction) throw new Error('correction marker vanished');
    if (correction.status === 'applied') return; // idempotent retry inside apply

    const sub = requireSubscription(db, correction.subscription_id);
    const drafts = recomputeAll(db, sub, { asOfUtc, correctionId });

    // Current (non-superseded) invoice per sequence.
    const currentBySeq = new Map(
      db
        .prepare(
          `SELECT * FROM invoices WHERE subscription_id = ? AND superseded_by IS NULL`,
        )
        .all(sub.id)
        .map((inv) => [inv.period_sequence, inv]),
    );

    let changedPeriods = 0;
    for (const draft of drafts) {
      const old = currentBySeq.get(draft.periodSequence);
      if (!old) continue; // open period / never billed -> normal billing handles it
      // Only periods at/after the trigger can differ; skip untouched history.
      if (old.period_end <= correction.recalc_from) continue;
      if (old.status !== 'issued' && old.status !== 'paid') continue;

      if (old.total_cents === draft.total && sameLines(old.id, draft, db)) continue;

      const newVersion = old.version + 1;
      const newInvoiceId = insertInvoice(db, draft, {
        version: newVersion,
        status: 'issued',
        issued: true,
      });

      // The old record's amounts never change; only the version pointer moves.
      db.prepare(
        `UPDATE invoice_versions SET current_record_id = ?
         WHERE subscription_id = ? AND period_sequence = ?`,
      ).run(newInvoiceId, sub.id, draft.periodSequence);

      const delta = draft.total - old.total_cents;
      db.prepare(
        `INSERT INTO invoice_diffs
          (id, correction_id, subscription_id, period_sequence, old_invoice_id,
           new_invoice_id, old_total_cents, new_total_cents, delta_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id('dif'),
        correctionId,
        sub.id,
        draft.periodSequence,
        old.id,
        newInvoiceId,
        old.total_cents,
        draft.total,
        delta,
        nowUtcMs(),
      );

      enqueueNotification(db, {
        subscriptionId: sub.id,
        type: 'invoice_corrected',
        idempotencyKey: `ntf:invoice_corrected:${newInvoiceId}`,
        payload: {
          subscription_id: sub.id,
          correction_id: correctionId,
          old_invoice_id: old.id,
          new_invoice_id: newInvoiceId,
          period_sequence: draft.periodSequence,
          old_total_cents: old.total_cents,
          new_total_cents: draft.total,
          delta_cents: delta,
          currency: draft.currency,
          period: { start: toIso(draft.periodStart), end: toIso(draft.periodEnd) },
        },
      });
      writeAudit(db, {
        actor,
        action: 'invoice.versioned',
        entityType: 'invoice',
        entityId: newInvoiceId,
        before: { invoiceId: old.id, version: old.version, totalCents: old.total_cents },
        after: {
          invoiceId: newInvoiceId,
          version: newVersion,
          totalCents: draft.total,
          deltaCents: delta,
          correctionId,
        },
      });
      changedPeriods += 1;
    }

    db.prepare(
      `UPDATE corrections SET status = 'applied', applied_at = ?, error_message = NULL WHERE id = ?`,
    ).run(nowUtcMs(), correctionId);
    writeAudit(db, {
      actor,
      action: 'correction.applied',
      entityType: 'correction',
      entityId: correctionId,
      after: { changedPeriods },
    });

    if (faultOnNextApply) {
      faultOnNextApply = false;
      throw new Error('injected fault during correction apply');
    }
  });
}

function sameLines(oldInvoiceId, draft, db) {
  const oldLines = db
    .prepare('SELECT kind, plan_id, range_start, range_end, days, amount_cents FROM invoice_lines WHERE invoice_id = ?')
    .all(oldInvoiceId);
  if (oldLines.length !== draft.lines.length) return false;
  return oldLines.every((l, i) => {
    const n = draft.lines[i];
    return (
      l.kind === n.kind &&
      l.plan_id === n.plan_id &&
      l.range_start === n.range_start &&
      l.range_end === n.range_end &&
      l.days === n.days &&
      l.amount_cents === n.amount_cents
    );
  });
}

/**
 * Startup recovery: finish any correction that was reserved but never applied
 * (process crash, injected fault, redelivered webhook). Applied corrections are
 * untouched, which is what makes redelivery idempotent.
 */
export function recoverPendingCorrections(db, { asOfUtc = nowUtcMs(), actor = 'recovery' } = {}) {
  const pending = db
    .prepare("SELECT * FROM corrections WHERE status IN ('pending','failed') ORDER BY created_at")
    .all();
  const results = [];
  for (const c of pending) {
    try {
      // reset a failed marker back to pending for a clean retry trail
      db.prepare("UPDATE corrections SET status = 'pending', error_message = NULL WHERE id = ?")
        .run(c.id);
      applyCorrection(db, c.id, { asOfUtc, actor });
      results.push({ id: c.id, ok: true });
    } catch (err) {
      db.prepare('UPDATE corrections SET status = ?, error_message = ? WHERE id = ?')
        .run('failed', String(err.message || err), c.id);
      results.push({ id: c.id, ok: false, error: String(err.message || err) });
    }
  }
  return results;
}

/** Line-level comparison between two invoice versions for the diff UI. */
export function diffInvoices(db, oldInvoiceId, newInvoiceId) {
  const oldLines = db
    .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid')
    .all(oldInvoiceId);
  const newLines = db
    .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid')
    .all(newInvoiceId);
  const key = (l) => `${l.kind}|${l.plan_id ?? ''}|${l.range_start}|${l.range_end}`;
  const oldMap = new Map(oldLines.map((l) => [key(l), l]));
  const newMap = new Map(newLines.map((l) => [key(l), l]));
  const rows = [];
  for (const [k, n] of newMap) {
    const o = oldMap.get(k);
    rows.push({
      key: k,
      kind: n.kind,
      planId: n.plan_id,
      rangeStart: n.range_start,
      rangeEnd: n.range_end,
      days: n.days,
      oldAmount: o ? o.amount_cents : 0,
      newAmount: n.amount_cents,
      delta: n.amount_cents - (o ? o.amount_cents : 0),
      presentIn: o ? 'both' : 'new',
    });
  }
  for (const [k, o] of oldMap) {
    if (!newMap.has(k)) {
      rows.push({
        key: k,
        kind: o.kind,
        planId: o.plan_id,
        rangeStart: o.range_start,
        rangeEnd: o.range_end,
        days: o.days,
        oldAmount: o.amount_cents,
        newAmount: 0,
        delta: -o.amount_cents,
        presentIn: 'removed',
      });
    }
  }
  return rows;
}

export { localDateToUtc, utcToLocalDate, listEvents };
