// Read models for the analysis page: merged timeline, billing analysis,
// invoice version history and correction recalc ranges.

import { toIso, utcToLocalDate, localDateToUtc } from '../shared/time.js';
import { buildDayTimeline, computePeriods } from '../billing/engine.js';
import { plansById } from './plans.js';
import { listEvents, getSubscription, listSubscriptions } from './subscriptions.js';
import { listInvoices, currentInvoices } from './billing.js';
import { listCorrections, listDiffs } from './corrections.js';
import { listRefunds } from './refunds.js';
import { listNotifications } from './notifications.js';
import { listAudit } from './audit.js';

function eventView(ev, tz) {
  return {
    id: ev.id,
    type: ev.type,
    effectiveDate: ev.effective_date,
    effectiveAt: ev.effective_at,
    effectiveAtIso: toIso(ev.effective_at),
    planId: ev.plan_id,
    reason: ev.reason,
    source: ev.source,
    idempotencyKey: ev.idempotency_key,
    createdAtIso: toIso(ev.created_at),
    localDay: utcToLocalDate(ev.effective_at, tz),
  };
}

/** Merge lifecycle events, invoices, corrections and refunds into one timeline. */
export function subscriptionTimeline(db, subscriptionId) {
  const sub = getSubscription(db, subscriptionId);
  if (!sub) throw Object.assign(new Error('subscription not found'), { status: 404 });
  const tz = sub.timezone;
  const items = [];

  for (const ev of listEvents(db, subscriptionId)) {
    items.push({ kind: 'event', at: ev.effective_at, data: eventView(ev, tz) });
  }
  for (const inv of listInvoices(db, subscriptionId)) {
    items.push({
      kind: 'invoice',
      at: inv.created_at,
      data: {
        id: inv.id,
        sequence: inv.period_sequence,
        version: inv.version,
        status: inv.status,
        supersededBy: inv.superseded_by,
        totalCents: inv.total_cents,
        currency: inv.currency,
        periodStart: toIso(inv.period_start),
        periodEnd: toIso(inv.period_end),
        correctionId: inv.correction_id,
      },
    });
  }
  for (const c of listCorrections(db, subscriptionId)) {
    items.push({
      kind: 'correction',
      at: c.created_at,
      data: {
        id: c.id,
        status: c.status,
        reason: c.reason,
        recalcFrom: toIso(c.recalc_from),
        recalcTo: toIso(c.recalc_to),
        diffs: c.diffs,
        appliedAt: c.applied_at ? toIso(c.applied_at) : null,
      },
    });
  }
  for (const r of listRefunds(db, subscriptionId)) {
    items.push({
      kind: 'refund',
      at: r.created_at,
      data: {
        id: r.id,
        invoiceId: r.invoice_id,
        amountCents: r.amount_cents,
        reason: r.reason,
        status: r.status,
      },
    });
  }

  items.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
  return {
    subscription: { ...sub, startedAtIso: toIso(sub.started_at) },
    timezone: tz,
    items: items.map((i) => ({ kind: i.kind, ...i.data })),
  };
}

/**
 * Billing analysis: recompute the full deterministic schedule from events and
 * present it alongside what is currently invoiced — the "what should the bill
 * be" view behind every correction.
 */
export function billingAnalysis(db, subscriptionId, { asOfUtc = Date.now() } = {}) {
  const sub = getSubscription(db, subscriptionId);
  if (!sub) throw Object.assign(new Error('subscription not found'), { status: 404 });
  const plans = plansById(db);
  const events = listEvents(db, subscriptionId);
  const timeline = buildDayTimeline(sub, events, asOfUtc);
  const periods = computePeriods(timeline, sub.anchor_date, plans);
  const invoiced = currentInvoices(db, subscriptionId);
  const invoicedBySeq = new Map(invoiced.map((i) => [i.period_sequence, i]));

  const periodViews = periods.map((p) => {
    const inv = invoicedBySeq.get(p.sequence);
    return {
      sequence: p.sequence,
      startDate: p.startDate,
      endDate: p.endDate,
      nominalDays: p.nominalDays,
      activeDays: p.activeDays,
      complete: p.complete,
      endedByCancel: p.endedByCancel,
      computedTotalCents: p.totalCents,
      lines: p.lines,
      invoice: inv
        ? {
            id: inv.id,
            version: inv.version,
            status: inv.status,
            totalCents: inv.total_cents,
            matchesComputed: inv.total_cents === p.totalCents,
          }
        : null,
    };
  });

  const daySummary = summarizeDays(timeline, plans);
  return {
    subscriptionId,
    timezone: sub.timezone,
    asOf: toIso(asOfUtc),
    totals: {
      computedCents: periods.reduce((s, p) => s + p.totalCents, 0),
      invoicedCents: invoiced.reduce((s, i) => s + i.total_cents, 0),
      refundsCents: listRefunds(db, subscriptionId)
        .filter((r) => r.status === 'completed')
        .reduce((s, r) => s + r.amount_cents, 0),
    },
    daySummary,
    periods: periodViews,
  };
}

function summarizeDays(timeline, plans) {
  const byPlan = {};
  let pausedDays = 0;
  let activeDays = 0;
  for (const d of timeline) {
    if (!d.billable) {
      pausedDays += 1;
      continue;
    }
    activeDays += 1;
    const name = plans[d.planId]?.name || d.planId;
    byPlan[name] = (byPlan[name] || 0) + 1;
  }
  return { totalDays: timeline.length, activeDays, pausedDays, activeDaysByPlan: byPlan };
}

export function correctionDetail(db, correctionId) {
  const c = db.prepare('SELECT * FROM corrections WHERE id = ?').get(correctionId);
  if (!c) throw Object.assign(new Error('correction not found'), { status: 404 });
  const sub = getSubscription(db, c.subscription_id);
  const diffs = listDiffs(db, correctionId).map((d) => ({
    ...d,
    oldInvoice: db.prepare('SELECT id, version, total_cents, status, period_start, period_end FROM invoices WHERE id = ?').get(d.old_invoice_id),
    newInvoice: db.prepare('SELECT id, version, total_cents, status, period_start, period_end FROM invoices WHERE id = ?').get(d.new_invoice_id),
  }));
  return {
    id: c.id,
    subscriptionId: c.subscription_id,
    reason: c.reason,
    status: c.status,
    recalc: { from: toIso(c.recalc_from), to: toIso(c.recalc_to) },
    recalcLocal: {
      from: utcToLocalDate(c.recalc_from, sub.timezone),
      to: utcToLocalDate(c.recalc_to, sub.timezone),
    },
    createdAt: toIso(c.created_at),
    appliedAt: c.applied_at ? toIso(c.applied_at) : null,
    errorMessage: c.error_message,
    diffs,
    netDeltaCents: diffs.reduce((s, d) => s + d.delta_cents, 0),
  };
}

export function overview(db) {
  const subs = listSubscriptions(db);
  const stats = {
    subscriptions: subs.length,
    active: subs.filter((s) => s.status === 'active').length,
    paused: subs.filter((s) => s.status === 'paused').length,
    canceled: subs.filter((s) => s.status === 'canceled').length,
  };
  stats.invoices = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  stats.finalizedVersions = db
    .prepare("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('issued','paid')").get().n;
  stats.superseded = db
    .prepare('SELECT COUNT(*) AS n FROM invoices WHERE superseded_by IS NOT NULL').get().n;
  stats.corrections = db.prepare('SELECT COUNT(*) AS n FROM corrections').get().n;
  stats.pendingCorrections = db
    .prepare("SELECT COUNT(*) AS n FROM corrections WHERE status IN ('pending','failed')").get().n;
  stats.webhooks = db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n;
  stats.pendingNotifications = db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE status != 'sent'").get().n;
  stats.billedCents = db
    .prepare('SELECT COALESCE(SUM(total_cents),0) AS s FROM invoices WHERE superseded_by IS NULL')
    .get().s;
  stats.refundedCents = db
    .prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE status = 'completed'")
    .get().s;
  return stats;
}

export {
  listAudit,
  listNotifications,
  listCorrections,
  listRefunds,
  listInvoices,
  localDateToUtc,
};
