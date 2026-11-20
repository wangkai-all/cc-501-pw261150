import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from '../src/db/schema.js';
import { createApp } from '../src/server/server.js';
import { insertPlan } from '../src/services/plans.js';
import { deliverPending } from '../src/services/notifications.js';

function testServer() {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const { server } = createApp(db);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      const call = async (method, p, body) => {
        const res = await fetch(base + p, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json();
        return { status: res.status, json };
      };
      resolve({
        db,
        baseUrl: base,
        call,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('HTTP API end-to-end', () => {
  let app;
  before(async () => { app = await testServer(); });
  after(async () => app.close());

  test('full happy path: plan -> subscription -> events -> billing -> correction -> refund -> notifications', async () => {
    const { call, db } = app;
    insertPlan(db, { id: 'p_basic', name: 'Basic', monthlyPriceCents: 3000 });
    insertPlan(db, { id: 'p_pro', name: 'Pro', monthlyPriceCents: 9000 });

    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);

    const created = await call('POST', '/api/subscriptions', {
      customerName: 'E2E Inc', planId: 'p_basic',
      timezone: 'America/New_York', anchorDate: '2026-01-31',
      idempotencyKey: 'e2e:create',
    });
    assert.equal(created.status, 200);
    const subId = created.json.id;

    // duplicate create returns the same subscription
    const dup = await call('POST', '/api/subscriptions', {
      customerName: 'E2E Inc', planId: 'p_basic',
      timezone: 'America/New_York', anchorDate: '2026-01-31',
      idempotencyKey: 'e2e:create',
    });
    assert.equal(dup.json.id, subId);

    await call('POST', `/api/subscriptions/${subId}/events`, {
      type: 'plan_changed', planId: 'p_pro', effectiveDate: '2026-02-10',
      idempotencyKey: 'e2e:up',
    });

    const billed = await call('POST', '/api/billing/run', {
      asOf: '2026-04-20T12:00:00Z', subscriptionId: subId,
    });
    assert.ok(billed.json.issued.length >= 2);

    const invoices = await call('GET', `/api/subscriptions/${subId}/invoices`);
    assert.ok(invoices.json.length >= 2);
    const firstId = invoices.json[0].id;

    // backdated correction through the API
    const ev = await call('POST', `/api/subscriptions/${subId}/events`, {
      type: 'plan_changed', planId: 'p_pro', effectiveDate: '2026-02-05',
      idempotencyKey: 'e2e:backdated',
    });
    const corr = await call('POST', `/api/subscriptions/${subId}/corrections`, {
      triggerEventId: ev.json.event.id, reason: 'e2e backdated',
    });
    assert.equal(corr.json.status, 'applied');
    assert.ok(corr.json.diffs.length >= 1);

    const detail = await call('GET', `/api/corrections/${corr.json.id}`);
    assert.equal(detail.json.netDeltaCents,
      detail.json.diffs.reduce((s, d) => s + d.delta_cents, 0));

    // line diff endpoint
    const d0 = corr.json.diffs[0];
    const lineDiff = await call('GET', `/api/invoices/${d0.old_invoice_id}/diff/${d0.new_invoice_id}`);
    assert.ok(Array.isArray(lineDiff.json));

    // refund against a current invoice
    const refund = await call('POST', `/api/subscriptions/${subId}/refunds`, {
      invoiceId: firstId, amountCents: 250, reason: 'e2e credit',
      idempotencyKey: 'e2e:refund',
    });
    assert.equal(refund.status, 200);
    const refundDup = await call('POST', `/api/subscriptions/${subId}/refunds`, {
      invoiceId: firstId, amountCents: 250, reason: 'e2e credit',
      idempotencyKey: 'e2e:refund',
    });
    assert.equal(refundDup.json.duplicate, true);

    // timeline + analysis + audit views respond
    const tl = await call('GET', `/api/subscriptions/${subId}/timeline`);
    assert.ok(tl.json.items.length >= 4);
    const analysis = await call('GET', `/api/subscriptions/${subId}/analysis`);
    assert.ok(analysis.json.periods.length >= 1);
    const audit = await call('GET', '/api/audit');
    assert.ok(audit.json.length >= 5);

    // notifications deliver and become sent
    const pendingBefore = (await call('GET', '/api/notifications')).json
      .filter((n) => n.status !== 'sent').length;
    assert.ok(pendingBefore > 0);
    await call('POST', '/api/notifications/deliver');
    const after = (await call('GET', '/api/notifications')).json;
    assert.ok(after.every((n) => n.status === 'sent'));
  });

  test('error cases return proper status codes', async () => {
    const { call } = app;
    const badTz = await call('POST', '/api/subscriptions', {
      customerName: 'X', planId: 'p_basic', timezone: 'Mars/Olympus', anchorDate: '2026-01-01',
    });
    assert.equal(badTz.status, 400);

    const missing = await call('GET', '/api/subscriptions/sub_nope/timeline');
    assert.equal(missing.status, 404);

    const badRoute = await call('GET', '/api/nope');
    assert.equal(badRoute.status, 404);
  });

  test('static page and assets are served', async () => {
    const html = await fetch(app.baseUrl + '/').then((r) => ({ status: r.status, text: r.text() }));
    assert.equal(html.status, 200);
    assert.match(await html.text, /订阅账单分析与更正平台/);
    const js = await fetch(app.baseUrl + '/app.js');
    assert.equal(js.status, 200);
    assert.match(await js.text(), /renderTimeline/);
  });
});

describe('notification retry semantics', () => {
  test('failing transport increments attempts and keeps row retryable', async () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    insertPlan(db, { id: 'p', name: 'P', monthlyPriceCents: 100 });
    const { createSubscription } = await import('../src/services/subscriptions.js');
    const sub = createSubscription(db, {
      customerName: 'N', planId: 'p', timezone: 'UTC', anchorDate: '2026-01-01',
      idempotencyKey: 'ntf:sub',
    });
    const { enqueueNotification } = await import('../src/services/notifications.js');
    enqueueNotification(db, {
      subscriptionId: sub.id, type: 'invoice_issued',
      idempotencyKey: 'ntf:x', payload: { hello: 'world' },
    });
    let attempts = 0;
    const failing = () => { attempts += 1; throw new Error('smtp down'); };
    const out1 = deliverPending(db, failing);
    assert.equal(out1[0].ok, false);
    const row = db.prepare('SELECT * FROM notifications').get();
    assert.equal(row.attempts, 1);
    assert.equal(row.status, 'pending');
    assert.match(row.last_error, /smtp down/);
  });
});
