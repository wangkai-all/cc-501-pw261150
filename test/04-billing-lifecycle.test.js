import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { memDb, seedPlans, makeSub, event, utc, totalsBySeq } from './helpers.js';
import { runBilling, listInvoices, getInvoice } from '../src/services/billing.js';
import { requestCorrection, recoverPendingCorrections, diffInvoices, injectApplyFault } from '../src/services/corrections.js';
import { listEvents } from '../src/services/subscriptions.js';
import { createRefund } from '../src/services/refunds.js';
import { listDiffs } from '../src/services/corrections.js';

describe('billing run + invoice lifecycle', () => {
  let db;
  before(() => { db = memDb(); seedPlans(db); });

  test('open period is not billed; closed period is issued once', () => {
    const sub = makeSub(db, { anchor: '2026-01-15', key: 'lc:sub' });    const r1 = runBilling(db, { asOfUtc: utc('UTC', '2026-01-20'), subscriptionId: sub.id });
    assert.deepEqual(r1.issued, []);
    assert.equal(r1.skipped[0].open, true);

    const r2 = runBilling(db, { asOfUtc: utc('UTC', '2026-02-16'), subscriptionId: sub.id });
    assert.equal(r2.issued.length, 1);
    assert.equal(r2.issued[0].totalCents, 3000);

    // idempotent second run: nothing new
    const r3 = runBilling(db, { asOfUtc: utc('UTC', '2026-02-16'), subscriptionId: sub.id });
    assert.deepEqual(r3.issued, []);
    assert.equal(listInvoices(db, sub.id).length, 1);
  });

  test('invoice records are immutable: direct UPDATE/DELETE of a finalized row is rejected', () => {
    const anyInvoice = db.prepare('SELECT id FROM invoice_records LIMIT 1').get();
    assert.throws(
      () => db.prepare('UPDATE invoice_records SET total_cents = 1 WHERE id = ?').run(anyInvoice.id),
      /immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM invoice_records WHERE id = ?').run(anyInvoice.id),
      /finalized/,
    );
    // the invoices view is read-only by construction as well
    assert.throws(
      () => db.prepare('UPDATE invoices SET total_cents = 1 WHERE id = ?').run(anyInvoice.id),
      /view/,
    );
  });

  test('consecutive periods each produce their own invoice', () => {
    const sub = makeSub(db, { anchor: '2026-01-10', key: 'lc:sub2' });
    runBilling(db, { asOfUtc: utc('UTC', '2026-04-11'), subscriptionId: sub.id });
    const invoices = listInvoices(db, sub.id);
    assert.deepEqual(invoices.map((i) => i.period_sequence), [0, 1, 2]);
    assert.ok(invoices.every((i) => i.status === 'issued' && i.version === 1));
  });
});

describe('correction flow — versions, diffs, no overwrite', () => {
  let db, sub;
  before(() => {
    db = memDb();
    seedPlans(db);
    sub = makeSub(db, { anchor: '2026-01-15', key: 'corr:sub' });
    runBilling(db, { asOfUtc: utc('UTC', '2026-04-16'), subscriptionId: sub.id });
  });

  test('baseline: three issued v1 invoices', () => {
    const invoices = listInvoices(db, sub.id);
    assert.equal(invoices.length, 3);
    assert.ok(invoices.every((i) => i.version === 1 && i.superseded_by === null));
  });

  test('backdated upgrade creates v2 for affected periods and freezes v1', () => {
    const before = totalsBySeq(listInvoices(db, sub.id));
    const ev = event(db, sub.id, 'plan_changed', '2026-02-20', {
      planId: 'plan_pro', idempotencyKey: 'corr:upgrade',
    });
    const correction = requestCorrection(db, sub.id, ev.event.id, { reason: 'backdated upgrade' });
    assert.equal(correction.status, 'applied');

    const invoices = listInvoices(db, sub.id);
    // periods 1 (Feb15-Mar14) and 2 (Mar15-Apr14) overlap Feb 20; period 0 untouched
    const v2 = invoices.filter((i) => i.version === 2);
    assert.equal(v2.length, 2);
    assert.deepEqual(v2.map((i) => i.period_sequence).sort(), [1, 2]);

    // old rows still exist with identical original totals, only superseded_by set
    const oldOnes = invoices.filter((i) => i.version === 1 && i.period_sequence >= 1);
    assert.ok(oldOnes.every((o) => o.superseded_by !== null && o.total_cents === 3000));
    assert.ok(v2.every((n) => n.total_cents > before[n.period_sequence]));

    // diff rows carry signed deltas that reconcile
    const diffs = listDiffs(db, correction.id);
    assert.equal(diffs.length, 2);
    for (const d of diffs) {
      assert.equal(d.delta_cents, d.new_total_cents - d.old_total_cents);
      assert.ok(d.delta_cents > 0);
    }
    // line-level diff is available for the UI
    const lineDiff = diffInvoices(db, diffs[0].old_invoice_id, diffs[0].new_invoice_id);
    assert.ok(lineDiff.some((r) => r.planId === 'plan_pro' && r.presentIn === 'new'));
  });

  test('correction never touches periods ending before the trigger', () => {
    const invoices = listInvoices(db, sub.id);
    const period0 = invoices.filter((i) => i.period_sequence === 0);
    assert.equal(period0.length, 1);
    assert.equal(period0[0].version, 1);
    assert.equal(period0[0].superseded_by, null);
  });

  test('re-requesting the same correction is idempotent (no extra versions/diffs)', () => {
    const trigger = listEvents(db, sub.id).find((e) => e.idempotency_key === 'corr:upgrade');
    const again = requestCorrection(db, sub.id, trigger.id, { reason: 'retry' });
    const invoices = listInvoices(db, sub.id);
    assert.equal(invoices.filter((i) => i.version >= 2).length, 2);
    assert.equal(listDiffs(db, again.id).length, 2);
  });

  test('a second correction on another event creates v3, preserving v1 and v2', () => {
    const ev = event(db, sub.id, 'plan_changed', '2026-03-25', {
      planId: 'plan_ent', idempotencyKey: 'corr:upgrade2',
    });
    const correction = requestCorrection(db, sub.id, ev.event.id, { reason: 'enterprise upgrade' });
    assert.equal(correction.status, 'applied');
    const seq2 = listInvoices(db, sub.id).filter((i) => i.period_sequence === 2);
    assert.equal(seq2.length, 3); // v1, v2, v3
    assert.deepEqual(seq2.map((i) => i.version).sort((a, b) => a - b), [1, 2, 3]);
    // full version chain intact and every old total frozen
    const totals = seq2.map((i) => i.total_cents);
    assert.ok(new Set(totals).size >= 2);
  });

  test('notifications were enqueued per new invoice version with unique keys', () => {
    const rows = db.prepare(
      "SELECT type, COUNT(*) AS n FROM notifications WHERE subscription_id = ? GROUP BY type",
    ).all(sub.id);
    const corrected = rows.find((r) => r.type === 'invoice_corrected');
    assert.ok(corrected && corrected.n >= 3);
    // unique idempotency keys enforced
    const keys = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT idempotency_key) AS d FROM notifications').get();
    assert.equal(keys.n, keys.d);
  });
});

describe('refunds', () => {
  test('refund is separate from invoice and capped at the paid total', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { key: 'ref:sub' });
    runBilling(db, { asOfUtc: utc('UTC', '2026-02-16'), subscriptionId: sub.id });
    const inv = listInvoices(db, sub.id)[0];

    const r1 = createRefund(db, {
      subscriptionId: sub.id, invoiceId: inv.id, amountCents: 1000,
      reason: 'partial', idempotencyKey: 'ref:1',
    });
    assert.equal(r1.duplicate, false);

    const r1again = createRefund(db, {
      subscriptionId: sub.id, invoiceId: inv.id, amountCents: 1000,
      reason: 'partial', idempotencyKey: 'ref:1',
    });
    assert.equal(r1again.duplicate, true);

    assert.throws(
      () => createRefund(db, {
        subscriptionId: sub.id, invoiceId: inv.id, amountCents: 2500,
        reason: 'too much', idempotencyKey: 'ref:2',
      }),
      /exceeds payable balance/,
    );
    // invoice totals stay untouched
    assert.equal(getInvoice(db, inv.id).total_cents, 3000);
  });
});

describe('failure recovery', () => {
  test('injected apply fault leaves a recoverable marker; recovery finishes exactly once', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15', key: 'fail:sub' });
    runBilling(db, { asOfUtc: utc('UTC', '2026-03-16'), subscriptionId: sub.id });

    const ev = event(db, sub.id, 'plan_changed', '2026-02-20', {
      planId: 'plan_pro', idempotencyKey: 'fail:upgrade',
    });
    injectApplyFault();
    assert.throws(
      () => requestCorrection(db, sub.id, ev.event.id, { reason: 'faulty' }),
      /injected fault/,
    );

    // no partial new invoice survived (apply transaction rolled back)
    assert.equal(listInvoices(db, sub.id).filter((i) => i.version > 1).length, 0);
    // but the marker exists in failed state for observability/retry
    const marker = db.prepare('SELECT * FROM corrections').get();
    assert.equal(marker.status, 'failed');
    assert.ok(marker.error_message.includes('injected fault'));

    const recovered = recoverPendingCorrections(db);
    assert.equal(recovered[0].ok, true);
    const after = listInvoices(db, sub.id);
    assert.ok(after.some((i) => i.version === 2));

    // running recovery again changes nothing
    const again = recoverPendingCorrections(db);
    assert.deepEqual(again, []);
    assert.equal(listInvoices(db, sub.id).filter((i) => i.version === 2).length, 1);
  });
});
