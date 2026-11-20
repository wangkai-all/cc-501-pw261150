// End-to-end HTTP smoke test against a running server (npm start first).
const BASE = process.env.BASE || 'http://localhost:3000';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error}`);
  return json;
}

const run = async () => {
  const sub = (await call('GET', '/api/subscriptions')).find((s) => s.status === 'active');
  console.log('active sub:', sub.id, sub.timezone, 'anchor', sub.anchor_date);

  const plan = await call('POST', '/api/plans', { name: 'Ultra', monthlyPriceCents: 19900 });
  console.log('plan created:', plan.id);

  // backdated plan change inside already-invoiced history
  const { event } = await call('POST', `/api/subscriptions/${sub.id}/events`, {
    type: 'plan_changed', planId: plan.id, effectiveDate: '2026-02-01',
    idempotencyKey: 'smoke-change-1',
  });
  const c1 = await call('POST', `/api/subscriptions/${sub.id}/corrections`, {
    triggerEventId: event.id, reason: 'smoke backdated upgrade',
  });
  console.log(`correction ${c1.id}: ${c1.status}, ${c1.diffs.length} versioned periods,`,
    'net delta', c1.diffs.reduce((s, d) => s + d.delta_cents, 0));

  // idempotent re-request
  const c1b = await call('POST', `/api/subscriptions/${sub.id}/corrections`, {
    triggerEventId: event.id, reason: 'replay',
  });
  console.log('re-request idempotent:', c1b.id === c1.id);

  // detail + line diff
  const detail = await call('GET', `/api/corrections/${c1.id}`);
  console.log('recalc range (local):', detail.recalcLocal.from, '->', detail.recalcLocal.to);
  const d0 = detail.diffs[0];
  const lineDiff = await call('GET', `/api/invoices/${d0.old_invoice_id}/diff/${d0.new_invoice_id}`);
  console.log('line diff rows:', lineDiff.map((r) =>
    `${r.kind}/${r.planId || '-'} ${r.days}d ${r.oldAmount}->${r.newAmount} (${r.presentIn})`));

  // duplicate webhook delivery
  const wh = {
    eventId: 'smoke_wh_001',
    eventType: 'subscription.paused',
    payload: { subscriptionId: sub.id, effectiveDate: '2026-03-20', reason: 'smoke pause' },
  };
  const w1 = await call('POST', '/api/webhooks', wh);
  const w2 = await call('POST', '/api/webhooks', wh);
  const w3 = await call('POST', '/api/webhooks', wh);
  console.log('webhook:', { first: w1.duplicate, replays: [w2.duplicate, w3.duplicate], correction: !!w1.correctionId });

  // fault injection -> failed correction -> recovery
  await call('POST', '/api/test/inject-fault', {});
  const { event: ev2 } = await call('POST', `/api/subscriptions/${sub.id}/events`, {
    type: 'plan_changed', planId: plan.id, effectiveDate: '2026-02-15',
    idempotencyKey: 'smoke-change-2',
  });
  let failed = null;
  try {
    await call('POST', `/api/subscriptions/${sub.id}/corrections`, { triggerEventId: ev2.id });
  } catch (e) {
    failed = e.message;
  }
  console.log('faulty apply rejected:', /injected fault/.test(failed || ''));
  const recovered = await call('POST', '/api/corrections/recover', {});
  console.log('recovery:', recovered);

  // notifications + audit + analysis + timeline
  const delivered = await call('POST', '/api/notifications/deliver', {});
  const pending = (await call('GET', '/api/notifications')).filter((n) => n.status !== 'sent');
  console.log('notifications delivered:', delivered.length, 'still pending:', pending.length);
  const analysis = await call('GET', `/api/subscriptions/${sub.id}/analysis`);
  console.log('analysis periods:', analysis.periods.length,
    'computed:', analysis.totals.computedCents, 'invoiced:', analysis.totals.invoicedCents,
    'mismatches:', analysis.periods.filter((p) => p.invoice && !p.invoice.matchesComputed).length);
  const timeline = await call('GET', `/api/subscriptions/${sub.id}/timeline`);
  console.log('timeline items:', timeline.items.length,
    'kinds:', [...new Set(timeline.items.map((i) => i.kind))].join(','));
  const audit = await call('GET', '/api/audit?limit=500');
  console.log('audit rows:', audit.length);

  // refund idempotency on a current invoice
  const invoice = (await call('GET', `/api/subscriptions/${sub.id}/invoices`)).find((i) => !i.superseded_by);
  const refund = await call('POST', `/api/subscriptions/${sub.id}/refunds`, {
    invoiceId: invoice.id, amountCents: 123, reason: 'smoke', idempotencyKey: 'smoke-ref-1',
  });
  const refundDup = await call('POST', `/api/subscriptions/${sub.id}/refunds`, {
    invoiceId: invoice.id, amountCents: 123, reason: 'smoke', idempotencyKey: 'smoke-ref-1',
  });
  console.log('refund idempotent:', refundDup.duplicate === true);

  console.log('\nSMOKE OK');
};

run().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
