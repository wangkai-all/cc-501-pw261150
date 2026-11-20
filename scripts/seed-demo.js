// Deterministic demo data. Run: npm run seed
// Scenario A: America/New_York subscription anchored Jan 31 (cross-month
// clamping + DST), upgraded mid-February, paused/resumed in March, then a
// BACKDATED webhook arrives later and forces invoice versioning + diffs.
// Scenario B: Pacific/Auckland (UTC+13, opposite DST) for boundary tests.

import { openDb, closeDb, id } from '../src/db/database.js';
import { insertPlan } from '../src/services/plans.js';
import { createSubscription, recordEvent } from '../src/services/subscriptions.js';
import { runBilling } from '../src/services/billing.js';
import { ingestWebhook } from '../src/services/webhooks.js';
import { createRefund } from '../src/services/refunds.js';
import { deliverPending } from '../src/services/notifications.js';
import { recoverPendingCorrections } from '../src/services/corrections.js';
import { localDateToUtc } from '../src/shared/time.js';

const db = openDb(process.env.BILLING_DB || './data/billing.db');

function reset() {
  db.exec(`
    DELETE FROM audit_log; DELETE FROM notifications; DELETE FROM webhook_events;
    DELETE FROM refunds; DELETE FROM invoice_diffs; DELETE FROM corrections;
    DELETE FROM invoice_lines; DELETE FROM invoice_versions; DELETE FROM invoice_records;
    DELETE FROM subscription_events; DELETE FROM subscriptions; DELETE FROM plans;
  `);
}

reset();

const basic = insertPlan(db, { id: 'plan_basic', name: 'Basic', monthlyPriceCents: 3000 });
const pro = insertPlan(db, { id: 'plan_pro', name: 'Pro', monthlyPriceCents: 9000 });
const enterprise = insertPlan(db, { id: 'plan_ent', name: 'Enterprise', monthlyPriceCents: 25000 });
console.log('plans:', [basic, pro, enterprise].map((p) => `${p.name}=$${p.monthly_price_cents / 100}`).join(', '));

// --- Scenario A -------------------------------------------------------------
const subA = createSubscription(db, {
  customerName: 'Acme Corp (US-East)',
  planId: basic.id,
  timezone: 'America/New_York',
  anchorDate: '2026-01-31',
  idempotencyKey: 'seed:subA:created',
  reason: 'seed scenario A',
});
console.log('subscription A:', subA.id, subA.timezone, 'anchor', subA.anchor_date);

// Feb 10: upgrade Basic -> Pro (proration inside the Jan-31->Feb-28 period)
recordEvent(db, subA.id, {
  type: 'plan_changed', planId: pro.id, effectiveDate: '2026-02-10',
  reason: 'sales-led upgrade', idempotencyKey: 'seed:subA:upgrade-feb',
});
// Mar 5 -> Mar 12: pause. 7 paused days extend the March period.
recordEvent(db, subA.id, {
  type: 'paused', effectiveDate: '2026-03-05',
  reason: 'implementation freeze', idempotencyKey: 'seed:subA:pause',
});
recordEvent(db, subA.id, {
  type: 'resumed', effectiveDate: '2026-03-12',
  reason: 'freeze over', idempotencyKey: 'seed:subA:resume',
});

// Bill everything closed up to the end of April.
const asOfAprilEnd = localDateToUtc('2026-05-02', subA.timezone);
let r = runBilling(db, { asOfUtc: asOfAprilEnd, subscriptionId: subA.id });
console.log('billing run 1:', JSON.stringify(r));

// Refund part of the first invoice (immutable bill + separate credit record).
const firstInvoice = db
  .prepare('SELECT id FROM invoices WHERE subscription_id = ? ORDER BY period_sequence LIMIT 1')
  .get(subA.id);
createRefund(db, {
  subscriptionId: subA.id,
  invoiceId: firstInvoice.id,
  amountCents: 300,
  reason: 'service credit for slow onboarding',
  idempotencyKey: 'seed:subA:refund-1',
});

// A backdated webhook: provider says the upgrade actually happened Feb 5.
// Issued bills must not be overwritten — versions + diffs + notifications.
const backdated = ingestWebhook(db, {
  eventId: 'wh_seed_001',
  eventType: 'subscription.plan_changed',
  payload: {
    subscriptionId: subA.id,
    planId: pro.id,
    effectiveDate: '2026-02-05',
    reason: 'provider correction: upgrade effective 5 Feb',
  },
});
console.log('backdated webhook:', JSON.stringify(backdated));

// Redeliver the SAME provider event id -> must be a no-op duplicate.
const replay = ingestWebhook(db, {
  eventId: 'wh_seed_001',
  eventType: 'subscription.plan_changed',
  payload: { subscriptionId: subA.id, planId: pro.id, effectiveDate: '2026-02-05' },
});
console.log('redelivered webhook:', JSON.stringify(replay));

// --- Scenario B: UTC+13, month-end anchor, cancellation --------------------
const subB = createSubscription(db, {
  customerName: 'Kiwi Cloud Ltd (NZ)',
  planId: enterprise.id,
  timezone: 'Pacific/Auckland',
  anchorDate: '2026-01-31',
  idempotencyKey: 'seed:subB:created',
  reason: 'seed scenario B',
});
recordEvent(db, subB.id, {
  type: 'paused', effectiveDate: '2026-02-20',
  reason: 'NZ public holiday shutdown', idempotencyKey: 'seed:subB:pause',
});
recordEvent(db, subB.id, {
  type: 'resumed', effectiveDate: '2026-02-25',
  reason: 'back to work', idempotencyKey: 'seed:subB:resume',
});
recordEvent(db, subB.id, {
  type: 'canceled', effectiveDate: '2026-04-10',
  reason: 'contract non-renewal', idempotencyKey: 'seed:subB:cancel',
});
r = runBilling(db, {
  asOfUtc: localDateToUtc('2026-05-02', subB.timezone),
  subscriptionId: subB.id,
});
console.log('billing run 2:', JSON.stringify(r));

// --- notifications + recovery sanity ---------------------------------------
const recovery = recoverPendingCorrections(db);
const delivered = deliverPending(db);
console.log('recovery:', JSON.stringify(recovery), 'notifications delivered:', delivered.length);

console.log('\nseed complete.');
closeDb(db);
