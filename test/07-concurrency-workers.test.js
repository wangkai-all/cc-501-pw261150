import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDateToUtc } from '../src/shared/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'concurrency-worker.js');

function runWorker(dbFile, payload) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { dbFile, payload } });
    w.on('message', (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
    w.on('error', reject);
    w.on('exit', (code) => code !== 0 && reject(new Error(`worker exited ${code}`)));
  });
}

describe('real cross-connection concurrency (shared file DB, WAL + BEGIN IMMEDIATE)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'billing-conc-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('two connections billing the same subscription concurrently never double-issue', async () => {
    const dbFile = path.join(dir, 'conc.db');
    // connection 1 provisions data
    const setup = await runWorker(dbFile, { op: 'setup' });
    assert.ok(setup.subscriptionId);

    // connections 2 and 3 run the billing job at the same instant
    const [a, b] = await Promise.all([
      runWorker(dbFile, { op: 'bill', subscriptionId: setup.subscriptionId, asOf: setup.asOf }),
      runWorker(dbFile, { op: 'bill', subscriptionId: setup.subscriptionId, asOf: setup.asOf }),
    ]);
    const totalIssued = a.issued.length + b.issued.length;
    // periods 0 and 1 are closed; across both workers exactly those two issue
    assert.equal(totalIssued, 2);
    assert.deepEqual([...new Set([...a.issued, ...b.issued].map((i) => i.sequence))].sort(), [0, 1]);

    const count = await runWorker(dbFile, { op: 'countInvoices', subscriptionId: setup.subscriptionId });
    assert.equal(count, 2);
  });

  test('concurrent corrections for different trigger events create distinct versions without loss', async () => {
    const dbFile = path.join(dir, 'conc2.db');
    const setup = await runWorker(dbFile, { op: 'setup' });
    // bill through mid-April so periods 0, 1 and 2 are all finalized first
    await runWorker(dbFile, {
      op: 'bill', subscriptionId: setup.subscriptionId,
      asOf: localDateToUtc('2026-04-16', 'UTC'),
    });

    // two retroactive plan changes, applied by two connections simultaneously
    const [r1, r2] = await Promise.all([
      runWorker(dbFile, { op: 'changeAndCorrect', subscriptionId: setup.subscriptionId,
        effectiveDate: '2026-02-20', plan: 'plan_pro', key: 'c-pro' }),
      runWorker(dbFile, { op: 'changeAndCorrect', subscriptionId: setup.subscriptionId,
        effectiveDate: '2026-03-25', plan: 'plan_ent', key: 'c-ent' }),
    ]);
    assert.equal(r1.applied + r2.applied, 2);

    // both corrections persisted; invoice versions form an unbroken chain
    const versions = await runWorker(dbFile, {
      op: 'versionsForSeq2', subscriptionId: setup.subscriptionId,
    });
    assert.ok(versions.length >= 2);
    assert.equal(new Set(versions.map((v) => v.version)).size, versions.length);
    // no orphaned/superseded pointer: exactly one current record per sequence
    const currents = await runWorker(dbFile, {
      op: 'currentCount', subscriptionId: setup.subscriptionId,
    });
    assert.equal(currents.pointers, currents.sequences);
  });

  test('optimistic version conflict is reported across connections', async () => {
    const dbFile = path.join(dir, 'conc3.db');
    const setup = await runWorker(dbFile, { op: 'setup' });
    const [winner, loser] = await Promise.allSettled([
      runWorker(dbFile, { op: 'guardedChange', subscriptionId: setup.subscriptionId,
        expectedVersion: 1, key: 'win' }),
      runWorker(dbFile, { op: 'guardedChange', subscriptionId: setup.subscriptionId,
        expectedVersion: 1, key: 'lose' }),
    ]);
    const results = [winner, loser];
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected');
    assert.match(String(failed.reason), /stale version|SQLITE_BUSY|locked/);
  });
});
