import { id, withTransaction } from '../db/database.js';
import { writeAudit } from './audit.js';

export function createPlan(db, { name, monthlyPriceCents, currency = 'USD' }) {
  if (!name) throw new Error('plan name is required');
  if (!Number.isInteger(monthlyPriceCents) || monthlyPriceCents < 0) {
    throw new Error('monthlyPriceCents must be a non-negative integer');
  }
  const planId = id('plan');
  db.prepare(
    'INSERT INTO plans (id, name, monthly_price_cents, currency, active, created_at) VALUES (?,?,?,? ,1,?)',
  ).run(planId, name, monthlyPriceCents, currency, Date.now());
  writeAudit(db, {
    actor: 'api',
    action: 'plan.created',
    entityType: 'plan',
    entityId: planId,
    after: { name, monthlyPriceCents: monthlyPriceCents, currency },
  });
  return getPlan(db, planId);
}

export function getPlan(db, planId) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}

export function listPlans(db) {
  return db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY monthly_price_cents').all();
}

export function plansById(db) {
  const map = {};
  for (const p of db.prepare('SELECT * FROM plans').all()) map[p.id] = p;
  return map;
}

/** Convenience for deterministic seeds/tests: fixed id, no audit noise. */
export function insertPlan(db, { id: planId, name, monthlyPriceCents, currency = 'USD' }) {
  db.prepare(
    `INSERT OR REPLACE INTO plans (id, name, monthly_price_cents, currency, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(planId, name, monthlyPriceCents, currency, Date.now());
  return getPlan(db, planId);
}

export function requirePlan(db, planId) {
  const plan = getPlan(db, planId);
  if (!plan) throw Object.assign(new Error(`plan not found: ${planId}`), { status: 404 });
  return plan;
}

export { withTransaction };
