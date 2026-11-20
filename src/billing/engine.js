// Pure billing engine. No I/O, no DB: given immutable subscription events it
// produces a deterministic day timeline and the invoice lines for every
// billing period. Re-running it with the same events always yields the same
// money, which is what makes corrections safe and auditable.
//
// Model:
//  - a billing day is a calendar day in the subscription's IANA timezone
//  - plan changes apply from local midnight of their effective date
//  - paused days are never charged and extend the billing period: a customer
//    keeps paying for whole months of *active* service, pause pushes renewal
//  - daily rate = monthly price / nominal length in days of that calendar month
//  - money is integer cents, half-up rounding per segment

import { roundHalfUp } from '../shared/money.js';
import {
  addLocalDays,
  addLocalMonthsClamped,
  utcToLocalDate,
  localDateToUtc,
  countLocalDays,
} from '../shared/time.js';

function diffLocalDays(aLocal, bLocal) {
  return Math.round((Date.parse(`${bLocal}T00:00:00Z`) - Date.parse(`${aLocal}T00:00:00Z`)) / 86_400_000);
}

/**
 * Expand subscription events into one record per calendar day from the anchor
 * up to (excluding) asOfUtc.
 *
 * @returns {Array<{date:string, planId:string|null, paused:boolean,
 *   billable:boolean, canceled:boolean}>}
 */
export function buildDayTimeline(sub, events, asOfUtc) {
  const tz = sub.timezone;
  const startDate = utcToLocalDate(sub.started_at, tz);
  const endDate = utcToLocalDate(asOfUtc, tz); // exclusive

  const byDate = new Map();
  for (const ev of [...events].sort((a, b) => a.effective_at - b.effective_at
    || a.created_at - b.created_at)) {
    if (!byDate.has(ev.effective_date)) byDate.set(ev.effective_date, []);
    byDate.get(ev.effective_date).push(ev);
  }

  const days = [];
  let planId = null;
  let paused = false;
  let canceled = false;

  for (let date = startDate; date < endDate; date = addLocalDays(date, 1)) {
    for (const ev of byDate.get(date) || []) {
      switch (ev.type) {
        case 'created':
        case 'plan_changed':
          planId = ev.plan_id;
          break;
        case 'paused':
          paused = true;
          break;
        case 'resumed':
          paused = false;
          break;
        case 'canceled':
          canceled = true;
          break;
      }
    }
    days.push({
      date,
      planId,
      paused,
      // the cancellation day itself is not billed; service stops at that day
      billable: !paused && !canceled,
      canceled,
    });
    if (canceled) break;
  }
  return days;
}

function buildLines(span, nominalDays, plansById) {
  const lines = [];
  let run = null;

  const flushCharge = () => {
    if (!run) return;
    const plan = plansById[run.planId];
    if (!plan) throw new Error(`unknown plan ${run.planId} while rating days`);
    const amount = roundHalfUp(plan.monthly_price_cents * run.days, nominalDays);
    lines.push({
      kind: 'charge',
      planId: run.planId,
      startDate: run.startDate,
      endDate: run.endDate, // exclusive
      days: run.days,
      amountCents: amount,
      detail: `${plan.name} x ${run.days} active day(s), `
        + `${plan.monthly_price_cents} cents / ${nominalDays}-day month`,
    });
    run = null;
  };

  const flushPause = () => {
    if (!run) return;
    lines.push({
      kind: 'paused',
      planId: null,
      startDate: run.startDate,
      endDate: run.endDate,
      days: run.days,
      amountCents: 0,
      detail: `paused for ${run.days} day(s), not charged; period extended`,
    });
    run = null;
  };

  for (const day of span) {
    const kind = day.billable ? 'charge' : 'paused';
    const key = day.billable ? day.planId : '__paused__';
    if (run && (run.kind !== kind || run.planId !== key)) {
      run.kind === 'charge' ? flushCharge() : flushPause();
    }
    if (!run) {
      run = { kind, planId: key, startDate: day.date, endDate: day.date, days: 0 };
    }
    run.days += 1;
    run.endDate = addLocalDays(day.date, 1);
  }
  if (run) (run.kind === 'charge' ? flushCharge : flushPause)();
  return lines;
}

/**
 * Walk the day timeline into billing periods. Each period nominally covers one
 * calendar month from the anchor (clamped, e.g. Jan 31 -> Feb 28), but the
 * actual boundary slides forward across paused days until the full nominal
 * count of *active* days has been consumed.
 *
 * @returns {Array<{sequence:number, startDate:string, endDate:string,
 *   nominalDays:number, complete:boolean, lines:Array, totalCents:number}>}
 */
export function computePeriods(timeline, anchorLocalDate, plansById) {
  const byDate = new Map(timeline.map((d) => [d.date, d]));
  const periods = [];
  if (timeline.length === 0) return periods;

  let cursor = timeline[0].date;
  const lastDate = timeline[timeline.length - 1].date;
  let sequence = 0;

  while (cursor <= lastDate) {
    const nominalStart = addLocalMonthsClamped(anchorLocalDate, sequence);
    const nominalEnd = addLocalMonthsClamped(anchorLocalDate, sequence + 1);
    const nominalDays = diffLocalDays(nominalStart, nominalEnd);

    const span = [];
    let collected = 0;
    let endedByCancel = false;
    let d = cursor;

    while (collected < nominalDays && d <= lastDate) {
      const day = byDate.get(d);
      if (!day) break; // gap-free timeline; defensive
      span.push(day);
      if (day.billable) collected += 1;
      d = addLocalDays(d, 1);
      if (day.canceled) {
        endedByCancel = true;
        break;
      }
    }

    // Timeline ended before any day of this period existed (e.g. asOf lands
    // exactly on a boundary): there is nothing to bill yet.
    if (span.length === 0) break;

    const complete = collected === nominalDays && !endedByCancel;
    const lines = buildLines(span, nominalDays, plansById);
    const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);

    periods.push({
      sequence,
      startDate: cursor,
      endDate: d,
      nominalStart,
      nominalEnd,
      nominalDays,
      activeDays: collected,
      complete,
      endedByCancel,
      lines,
      totalCents,
    });

    cursor = d;
    sequence += 1;
    if (endedByCancel || !complete) break;
  }
  return periods;
}

/** Convert engine local-date lines into UTC-ms invoice lines for persistence. */
export function linesToUtc(lines, timezone) {
  return lines.map((l) => ({
    kind: l.kind,
    plan_id: l.planId,
    range_start: localDateToUtc(l.startDate, timezone),
    range_end: localDateToUtc(l.endDate, timezone),
    days: l.days,
    amount_cents: l.amountCents,
    detail: l.detail,
    unit_label: l.kind === 'charge' ? `${l.planId}/day` : 'paused/day',
  }));
}

export function periodBoundsUtc(period, timezone) {
  return {
    periodStart: localDateToUtc(period.startDate, timezone),
    periodEnd: localDateToUtc(period.endDate, timezone),
  };
}

/**
 * Which already-issued period sequences are touched by an event taking effect
 * at effectiveUtc? Any period whose (exclusive) end is after the event — the
 * period containing the event and every later one. Closed periods only; the
 * still-open period is picked up by the next normal billing run.
 */
export function affectedSequences(issuedPeriods, effectiveUtc, timezone) {
  return issuedPeriods
    .filter((p) => localDateToUtc(p.endDate, timezone) > effectiveUtc)
    .map((p) => p.sequence);
}

export { countLocalDays, diffLocalDays };
