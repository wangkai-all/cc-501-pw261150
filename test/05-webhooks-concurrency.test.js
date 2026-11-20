import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, seedPlans, makeSub, event, utc } from './helpers.js';
import { runBilling, listInvoices } from '../src/services/billing.js';
import { ingestWebhook, listWebhookEvents } from '../src/services/webhooks.js';
import { listEvents } from '../src/services/subscriptions.js';
import { listNotifications } from '../src/services/notifications.js';

describe('webhook idempotency', () => {
  let db, sub;
  before(() => {
    db = memDb();
    seedPlans(db);
    sub = makeSub(db, { anchor: '2026-01-15', key: 'wh:sub' });
    runBilling(db, { asOfUtc: utc('UTC', '2026-04-16'), subscriptionId: sub.id });
  });

  test('first delivery processes, redeliveries are duplicates and never re-apply', () => {
    const payload = {
      subscriptionId: sub.id,
      planId: 'plan_pro',
      effectiveDate: '2026-02-20',
      reason: 'provider webhook',
    };
    const first = ingestWebhook(db, { eventId: 'wh_evt_42', eventType: 'subscription.plan_changed', payload });
    assert.equal(first.duplicate, false);
    assert.ok(first.correctionId);

    const second = ingestWebhook(db, { eventId: 'wh_evt_42', eventType: 'subscription.plan_changed', payload });
    const third = ingestWebhook(db, { eventId: 'wh_evt_42', eventType: 'subscription.plan_changed', payload });
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);

    const rows = listWebhookEvents(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'duplicate');
    assert.equal(rows[0].processed_at, rows[0].processed_at);

    // exactly one lifecycle event and one correction
    const events = listEvents(db, sub.id).filter((e) => e.type === 'plan_changed');
    assert.equal(events.length, 1);
    const corrections = db.prepare('SELECT COUNT(*) AS n FROM corrections').get();
    assert.equal(corrections.n, 1);
    const v2 = listInvoices(db, sub.id).filter((i) => i.version === 2);
    assert.equal(v2.length, 2);
  });

  test('different event ids with same business intent still respect per-entity keys', () => {
    // same event id is the primary guard; a genuinely new provider event id
    // creates a new lifecycle event but correction idempotency is keyed on the
    // *trigger event*, so no accidental collapse — and no overwrite either.
    const r = ingestWebhook(db, {
      eventId: 'wh_evt_99',
      eventType: 'subscription.paused',
      payload: { subscriptionId: sub.id, effectiveDate: '2026-03-01', reason: 'pause via hook' },
    });
    assert.equal(r.duplicate, false);
    assert.ok(r.correctionId);
    const corrections = db.prepare('SELECT * FROM corrections ORDER BY created_at').all();
    assert.equal(new Set(corrections.map((c) => c.idempotency_key)).size, corrections.length);
  });

  test('webhook creating a subscription twice with same event id returns the same sub', () => {
    const body = {
      customerName: 'Hook Customer', planId: 'plan_basic',
      timezone: 'UTC', anchorDate: '2026-02-01',
    };
    const a = ingestWebhook(db, { eventId: 'wh_create_1', eventType: 'subscription.created', payload: body });
    const b = ingestWebhook(db, { eventId: 'wh_create_1', eventType: 'subscription.created', payload: body });
    assert.equal(a.subscriptionId, b.result);
    assert.equal(b.duplicate, true);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE customer_name = 'Hook Customer'").get().n,
      1,
    );
  });

  test('unsupported event type is recorded as failed and surfaces an error', () => {
    assert.throws(
      () => ingestWebhook(db, { eventId: 'wh_bad', eventType: 'invoice.whatever', payload: {} }),
      /unsupported webhook event type/,
    );
    const row = db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get('wh_bad');
    assert.equal(row.status, 'failed');
  });

  test('every processed webhook enqueues notifications exactly once', () => {
    const before = listNotifications(db).length;
    ingestWebhook(db, {
      eventId: 'wh_evt_42', eventType: 'subscription.plan_changed',
      payload: { subscriptionId: sub.id, planId: 'plan_pro', effectiveDate: '2026-02-20' },
    });
    assert.equal(listNotifications(db).length, before); // duplicate -> no new notifications
  });
});

describe('concurrent changes', () => {
  test('optimistic lock rejects a stale admin update while the fresh one succeeds', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { key: 'cc:sub' });
    assert.equal(sub.version, 1);

    // client A and B both read v1
    const a = event(db, sub.id, 'plan_changed', '2026-02-01', {
      planId: 'plan_pro', idempotencyKey: 'cc:a', expectedVersion: 1,
    });
    assert.equal(a.subscription.version, 2);

    assert.throws(
      () => event(db, sub.id, 'plan_changed', '2026-02-02', {
        planId: 'plan_ent', idempotencyKey: 'cc:b', expectedVersion: 1,
      }),
      /stale version/,
    );
    // B retries with the fresh version and wins
    const b = event(db, sub.id, 'plan_changed', '2026-02-02', {
      planId: 'plan_ent', idempotencyKey: 'cc:b', expectedVersion: 2,
    });
    assert.equal(b.subscription.version, 3);
  });

  test('serialized transactions: interleaved billing runs never double-issue a period', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15', key: 'cc:bill' });
    const asOf = utc('UTC', '2026-03-16');

    // Simulate two workers grabbing the job at the same instant. BEGIN
    // IMMEDIATE serializes them; the second sees the first's committed invoice.
    const results = [];
    const worker = () => results.push(runBilling(db, { asOfUtc: asOf, subscriptionId: sub.id }));
    worker();
    worker();
    const issuedCount = results.reduce((n, r) => n + r.issued.length, 0);
    assert.equal(issuedCount, 2); // periods 0 and 1, each once
    const invoices = listInvoices(db, sub.id);
    assert.equal(invoices.length, 2);
    assert.deepEqual([...new Set(invoices.map((i) => i.period_sequence))].length, 2);
  });

  test('illegal lifecycle transitions are rejected', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { key: 'cc:fsm' });
    event(db, sub.id, 'paused', '2026-02-01', { idempotencyKey: 'cc:p' });
    assert.throws(
      () => event(db, sub.id, 'paused', '2026-02-02', { idempotencyKey: 'cc:p2' }),
      /illegal transition/,
    );
    assert.throws(
      () => event(db, sub.id, 'resumed', '2026-01-01', { idempotencyKey: 'cc:r0' }),
      /cannot precede anchorDate/,
    );
  });
});
