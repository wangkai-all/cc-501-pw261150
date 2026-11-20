import { DatabaseSync } from 'node:sqlite';
import { applySchema } from '../src/db/schema.js';
import { insertPlan } from '../src/services/plans.js';
import { createSubscription, recordEvent } from '../src/services/subscriptions.js';
import { localDateToUtc } from '../src/shared/time.js';

export function memDb() {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  return db;
}

export function seedPlans(db) {
  return {
    basic: insertPlan(db, { id: 'plan_basic', name: 'Basic', monthlyPriceCents: 3000 }),
    pro: insertPlan(db, { id: 'plan_pro', name: 'Pro', monthlyPriceCents: 9000 }),
    ent: insertPlan(db, { id: 'plan_ent', name: 'Enterprise', monthlyPriceCents: 25000 }),
  };
}

export function makeSub(db, { plan = 'plan_basic', tz = 'UTC', anchor = '2026-01-15', key = null } = {}) {
  return createSubscription(db, {
    customerName: 'Test Co',
    planId: plan,
    timezone: tz,
    anchorDate: anchor,
    idempotencyKey: key,
  });
}

export function event(db, subId, type, effectiveDate, extra = {}) {
  return recordEvent(db, subId, { type, effectiveDate, ...extra });
}

export function utc(tz, localDate) {
  return localDateToUtc(localDate, tz);
}

export function totalsBySeq(invoices) {
  return Object.fromEntries(
    invoices.filter((i) => !i.superseded_by).map((i) => [i.period_sequence, i.total_cents]),
  );
}
