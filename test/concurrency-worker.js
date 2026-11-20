// Separate SQLite connection per worker thread — drives real lock contention
// against the same database file as the other workers.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../src/db/database.js';
import { insertPlan } from '../src/services/plans.js';
import { createSubscription, recordEvent } from '../src/services/subscriptions.js';
import { runBilling } from '../src/services/billing.js';
import { requestCorrection } from '../src/services/corrections.js';
import { localDateToUtc } from '../src/shared/time.js';

const { dbFile, payload } = workerData;
const db = openDb(dbFile);

function reply(fn) {
  Promise.resolve()
    .then(fn)
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((err) => parentPort.postMessage({ ok: false, error: String(err.message || err) }));
}

reply(() => {
  switch (payload.op) {
    case 'setup': {
      insertPlan(db, { id: 'plan_basic', name: 'Basic', monthlyPriceCents: 3000 });
      insertPlan(db, { id: 'plan_pro', name: 'Pro', monthlyPriceCents: 9000 });
      insertPlan(db, { id: 'plan_ent', name: 'Enterprise', monthlyPriceCents: 25000 });
      const sub = createSubscription(db, {
        customerName: 'Concurrency Co', planId: 'plan_basic', timezone: 'UTC',
        anchorDate: '2026-01-15', idempotencyKey: 'setup-sub',
      });
      return { subscriptionId: sub.id, asOf: localDateToUtc('2026-03-16', 'UTC') };
    }

    case 'bill': {
      const r = runBilling(db, {
        asOfUtc: payload.asOf, subscriptionId: payload.subscriptionId,
      });
      return { issued: r.issued, skipped: r.skipped.length, errors: r.errors };
    }

    case 'countInvoices':
      return db
        .prepare('SELECT COUNT(*) AS n FROM invoice_records WHERE subscription_id = ?')
        .get(payload.subscriptionId).n;

    case 'changeAndCorrect': {
      const { event } = recordEvent(db, payload.subscriptionId, {
        type: 'plan_changed', planId: payload.plan,
        effectiveDate: payload.effectiveDate, idempotencyKey: payload.key,
      });
      const correction = requestCorrection(db, payload.subscriptionId, event.id, {
        reason: `worker ${payload.key}`,
      });
      return { applied: correction.status === 'applied' ? 1 : 0, id: correction.id };
    }

    case 'versionsForSeq2':
      return db
        .prepare(
          `SELECT id, version FROM invoice_records
           WHERE subscription_id = ? AND period_sequence = 2 ORDER BY version`,
        )
        .all(payload.subscriptionId);

    case 'currentCount': {
      const pointers = db
        .prepare('SELECT COUNT(*) AS n FROM invoice_versions WHERE subscription_id = ?')
        .get(payload.subscriptionId).n;
      const sequences = db
        .prepare(
          `SELECT COUNT(DISTINCT period_sequence) AS n FROM invoice_records
           WHERE subscription_id = ?`,
        )
        .get(payload.subscriptionId).n;
      return { pointers, sequences };
    }

    case 'guardedChange': {
      const r = recordEvent(db, payload.subscriptionId, {
        type: 'plan_changed', planId: 'plan_pro', effectiveDate: '2026-02-01',
        expectedVersion: payload.expectedVersion, idempotencyKey: payload.key,
      });
      return { version: r.subscription.version };
    }

    default:
      throw new Error(`unknown op ${payload.op}`);
  }
});
