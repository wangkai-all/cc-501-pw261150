import { id, withTransaction } from '../db/database.js';
import { localDateToUtc, nowUtcMs, utcToLocalDate, addLocalDays } from '../shared/time.js';
import { writeAudit } from './audit.js';
import { requirePlan } from './plans.js';

const VALID_TZ = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

export function getSubscription(db, subscriptionId) {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
}

export function requireSubscription(db, subscriptionId) {
  const sub = getSubscription(db, subscriptionId);
  if (!sub) throw Object.assign(new Error('subscription not found'), { status: 404 });
  return sub;
}

export function listSubscriptions(db) {
  return db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC').all();
}

export function listEvents(db, subscriptionId) {
  return db
    .prepare('SELECT * FROM subscription_events WHERE subscription_id = ? ORDER BY effective_at, created_at')
    .all(subscriptionId);
}

export function createSubscription(db, {
  customerName,
  planId,
  timezone,
  anchorDate,
  idempotencyKey,
  actor = 'api',
  reason = 'initial subscription',
}) {
  if (!customerName) throw Object.assign(new Error('customerName is required'), { status: 400 });
  if (!VALID_TZ.has(timezone)) {
    throw Object.assign(new Error(`unsupported timezone: ${timezone}`), { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate || '')) {
    throw Object.assign(new Error('anchorDate must be YYYY-MM-DD'), { status: 400 });
  }

  return withTransaction(db, () => {
    // Idempotent creation: same key returns the existing subscription.
    if (idempotencyKey) {
      const existing = db
        .prepare('SELECT subscription_id FROM subscription_events WHERE idempotency_key = ?')
        .get(idempotencyKey);
      if (existing) return requireSubscription(db, existing.subscription_id);
    }
    const plan = requirePlan(db, planId);
    const subId = id('sub');
    const startedAt = localDateToUtc(anchorDate, timezone);
    const now = nowUtcMs();
    db.prepare(
      `INSERT INTO subscriptions
        (id, customer_name, plan_id, status, timezone, anchor_date, started_at,
         version, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, 1, ?, ?)`,
    ).run(subId, customerName, planId, timezone, anchorDate, startedAt, now, now);

    const evId = insertEvent(db, {
      subscriptionId: subId,
      type: 'created',
      effectiveDate: anchorDate,
      timezone,
      planId,
      reason,
      source: actor === 'webhook' ? 'webhook' : 'api',
      idempotencyKey,
    });
    writeAudit(db, {
      actor,
      action: 'subscription.created',
      entityType: 'subscription',
      entityId: subId,
      after: { customerName, planId, timezone, anchorDate, eventId: evId },
    });
    return requireSubscription(db, subId);
  });
}

const TRANSITIONS = {
  plan_changed: { from: ['active', 'paused'], to: null, needsPlan: true },
  paused: { from: ['active'], to: 'paused', needsPlan: false },
  resumed: { from: ['paused'], to: 'active', needsPlan: false },
  canceled: { from: ['active', 'paused'], to: 'canceled', needsPlan: false },
};

/**
 * Record a lifecycle/plan event. Synchronous admin callers pass expectedVersion
 * for optimistic concurrency; webhook replay passes an idempotencyKey and the
 * existing event is returned unchanged on duplicate.
 */
export function recordEvent(db, subscriptionId, params) {
  const {
    type,
    effectiveDate,
    reason = '',
    source = 'api',
    idempotencyKey = null,
    expectedVersion = null,
    planId = null,
    actor = source === 'webhook' ? 'webhook' : 'api',
  } = params;

  const rule = TRANSITIONS[type];
  if (!rule) throw Object.assign(new Error(`unknown event type: ${type}`), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate || '')) {
    throw Object.assign(new Error('effectiveDate must be YYYY-MM-DD'), { status: 400 });
  }

  return withTransaction(db, () => {
    const sub = requireSubscription(db, subscriptionId);

    if (idempotencyKey) {
      const dup = db
        .prepare(
          'SELECT * FROM subscription_events WHERE subscription_id = ? AND idempotency_key = ?',
        )
        .get(subscriptionId, idempotencyKey);
      if (dup) return { event: dup, subscription: sub, duplicate: true };
    }
    if (expectedVersion !== null && sub.version !== expectedVersion) {
      throw Object.assign(
        new Error(`stale version: expected ${expectedVersion}, current ${sub.version}`),
        { status: 409, code: 'VERSION_CONFLICT' },
      );
    }
    if (!rule.from.includes(sub.status)) {
      throw Object.assign(
        new Error(`illegal transition ${type} from status ${sub.status}`),
        { status: 409, code: 'ILLEGAL_TRANSITION' },
      );
    }
    if (rule.needsPlan) requirePlan(db, planId);
    // no event may pre-date the subscription's anchor
    if (effectiveDate < sub.anchor_date) {
      throw Object.assign(new Error('effectiveDate cannot precede anchorDate'), { status: 400 });
    }

    const event = insertEvent(db, {
      subscriptionId,
      type,
      effectiveDate,
      timezone: sub.timezone,
      planId,
      reason,
      source,
      idempotencyKey,
    });

    const nextPlan = type === 'plan_changed' ? planId : sub.plan_id;
    const nextStatus = rule.to ?? sub.status;
    const canceledAt = type === 'canceled' ? localDateToUtc(effectiveDate, sub.timezone) : sub.canceled_at;
    db.prepare(
      `UPDATE subscriptions
         SET plan_id = ?, status = ?, canceled_at = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(nextPlan, nextStatus, canceledAt, nowUtcMs(), subscriptionId);

    writeAudit(db, {
      actor,
      action: `subscription.${type}`,
      entityType: 'subscription',
      entityId: subscriptionId,
      before: { status: sub.status, planId: sub.plan_id, version: sub.version },
      after: {
        status: nextStatus,
        planId: nextPlan,
        version: sub.version + 1,
        effectiveDate,
        eventId: event,
        reason,
      },
    });

    return { event: getEvent(db, event), subscription: requireSubscription(db, subscriptionId), duplicate: false };
  });
}

function insertEvent(db, {
  subscriptionId, type, effectiveDate, timezone, planId, reason, source, idempotencyKey,
}) {
  const evId = id('evt');
  db.prepare(
    `INSERT INTO subscription_events
      (id, subscription_id, type, effective_date, effective_at, plan_id, reason,
       source, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evId,
    subscriptionId,
    type,
    effectiveDate,
    localDateToUtc(effectiveDate, timezone),
    planId,
    reason,
    source,
    idempotencyKey,
    nowUtcMs(),
  );
  return evId;
}

export function getEvent(db, eventId) {
  return db.prepare('SELECT * FROM subscription_events WHERE id = ?').get(eventId);
}

/** Effective plan/status for the timeline API: replay events up to a date. */
export function stateAt(db, subscriptionId, localDate) {
  const sub = requireSubscription(db, subscriptionId);
  const events = listEvents(db, subscriptionId);
  let planId = null;
  let status = 'active';
  for (const ev of events) {
    if (ev.effective_date > localDate) break;
    if (ev.type === 'created' || ev.type === 'plan_changed') planId = ev.plan_id;
    if (ev.type === 'paused') status = 'paused';
    if (ev.type === 'resumed') status = 'active';
    if (ev.type === 'canceled') status = 'canceled';
  }
  return { subscription: sub, planId, status };
}

export { addLocalDays, utcToLocalDate };
