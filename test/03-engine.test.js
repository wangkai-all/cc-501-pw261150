import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDayTimeline, computePeriods } from '../src/billing/engine.js';
import { localDateToUtc } from '../src/shared/time.js';
import { memDb, seedPlans, makeSub, event, utc } from './helpers.js';
import { listEvents } from '../src/services/subscriptions.js';

function analyze(db, sub, asOfDate) {
  const plans = seedPlansMap(db);
  const events = listEvents(db, sub.id);
  const timeline = buildDayTimeline(sub, events, utc(sub.timezone, asOfDate));
  const periods = computePeriods(timeline, sub.anchor_date, plans);
  return { timeline, periods };
}

function seedPlansMap(db) {
  seedPlans(db);
  return Object.fromEntries(db.prepare('SELECT * FROM plans').all().map((p) => [p.id, p]));
}

describe('billing engine — daily proration', () => {
  test('full untouched month bills exactly the plan price', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15' });
    const { periods } = analyze(db, sub, '2026-02-16');
    // period 0 is complete; period 1 has just accrued its first open day
    assert.equal(periods.length, 2);
    assert.equal(periods[0].complete, true);
    assert.equal(periods[0].totalCents, 3000);
    assert.equal(periods[0].lines[0].kind, 'charge');
    assert.equal(periods[0].lines[0].days, 31);
    assert.equal(periods[1].complete, false);
    assert.equal(periods[1].endedByCancel, false);
  });

  test('mid-month upgrade splits the period into two rated segments', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15' });
    event(db, sub.id, 'plan_changed', '2026-02-10', { planId: 'plan_pro', idempotencyKey: 'k1' });
    const { periods } = analyze(db, sub, '2026-02-16');
    const p = periods[0];
    assert.equal(p.lines.length, 2);
    assert.equal(p.lines[0].planId, 'plan_basic');
    assert.equal(p.lines[0].days, 26); // Jan 15 .. Feb 9
    assert.equal(p.lines[1].planId, 'plan_pro');
    assert.equal(p.lines[1].days, 5);  // Feb 10 .. Feb 14
    // 3000*26/31 + 9000*5/31 = 2516.13 + 1451.61 -> 2516 + 1452
    assert.equal(p.lines[0].amountCents, 2516);
    assert.equal(p.lines[1].amountCents, 1452);
    assert.equal(p.totalCents, 3968);
  });

  test('downgrade reduces the total below the original price', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { plan: 'plan_pro', anchor: '2026-01-15' });
    event(db, sub.id, 'plan_changed', '2026-02-01', { planId: 'plan_basic', idempotencyKey: 'd1' });
    const { periods } = analyze(db, sub, '2026-02-16');
    assert.ok(periods[0].totalCents < 9000);
    // 17 days pro + 14 days basic
    assert.equal(periods[0].lines[0].days, 17);
    assert.equal(periods[0].lines[1].days, 14);
  });

  test('paused days are free and extend the period until full active days accrue', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15' });
    event(db, sub.id, 'paused', '2026-02-01', { idempotencyKey: 'p1' });
    event(db, sub.id, 'resumed', '2026-02-06', { idempotencyKey: 'p2' }); // 5 paused days
    const { periods, timeline } = analyze(db, sub, '2026-02-21');
    // Jan15..Feb20 = 37 calendar days, 5 paused -> 32 active; nominal 31.
    const pausedDayCount = timeline.filter((d) => !d.billable).length;
    assert.equal(pausedDayCount, 5);
    const p = periods[0];
    assert.equal(p.activeDays, 31);
    assert.equal(p.complete, true);
    // nominal boundary Feb 15 + 5 paused days -> actual end Feb 20
    assert.equal(p.endDate, '2026-02-20');
    assert.ok(p.lines.some((l) => l.kind === 'paused' && l.days === 5 && l.amountCents === 0));
    // only 31 active days charged at basic
    assert.equal(p.totalCents, 3000);
  });

  test('pause spanning two calendar months pushes the end into the next month', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15' });
    event(db, sub.id, 'paused', '2026-02-10', { idempotencyKey: 'p1' });
    event(db, sub.id, 'resumed', '2026-03-03', { idempotencyKey: 'p2' }); // 21 paused days
    const { periods } = analyze(db, sub, '2026-03-20');
    const p = periods[0];
    assert.equal(p.endDate > '2026-03-01', true);
    assert.equal(p.activeDays, 31);
    const paused = p.lines.filter((l) => l.kind === 'paused');
    assert.equal(paused.reduce((s, l) => s + l.days, 0), 21);
    assert.equal(p.totalCents, 3000);
  });

  test('cancellation produces a final partial period billed by active days', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15' });
    event(db, sub.id, 'canceled', '2026-01-25', { idempotencyKey: 'c1' });
    const { periods } = analyze(db, sub, '2026-02-01');
    assert.equal(periods.length, 1);
    const p = periods[0];
    assert.equal(p.endedByCancel, true);
    assert.equal(p.complete, false);
    assert.equal(p.activeDays, 10); // Jan 15..24
    assert.equal(p.totalCents, Math.round((3000 * 10) / 31));
  });

  test('cross-month anchor Jan 31 clamps Feb period to Feb 28', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-31' });
    const { periods } = analyze(db, sub, '2026-03-02');
    assert.equal(periods[0].startDate, '2026-01-31');
    assert.equal(periods[0].nominalDays, 28);
    assert.equal(periods[0].endDate, '2026-02-28');
    assert.equal(periods[1].startDate, '2026-02-28');
    assert.equal(periods[1].nominalDays, 31);
  });

  test('DST timezone still yields the same calendar day counts', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { tz: 'America/New_York', anchor: '2026-02-15' });
    event(db, sub.id, 'plan_changed', '2026-03-10', { planId: 'plan_pro', idempotencyKey: 'e1' });
    const { periods } = analyze(db, sub, '2026-03-16');
    // Feb 15 .. Mar 14 across the Mar 8 spring-forward: 28 calendar days total
    const totalDays = periods[0].lines.reduce((s, l) => s + l.days, 0);
    assert.equal(totalDays, 28);
    assert.equal(periods[0].lines[0].days, 23);
    assert.equal(periods[0].lines[1].days, 5);
  });

  test('same-day events apply in creation order', () => {
    const db = memDb();
    seedPlans(db);
    const sub = makeSub(db, { anchor: '2026-01-15' });
    event(db, sub.id, 'plan_changed', '2026-02-01', { planId: 'plan_pro', idempotencyKey: 'a' });
    event(db, sub.id, 'plan_changed', '2026-02-01', { planId: 'plan_basic', idempotencyKey: 'b' });
    const { periods } = analyze(db, sub, '2026-02-16');
    // last write wins for that day; no pro segment remains
    assert.deepEqual(periods[0].lines.map((l) => l.planId), ['plan_basic']);
  });
});
