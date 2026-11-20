// Schema + migrations. Invoices and their lines are append-only once issued:
// SQLite triggers physically block UPDATE/DELETE on finalized rows, so a
// correction can never overwrite an already-billed record — it must create a
// new invoice version instead.

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL CHECK (monthly_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('active','paused','canceled')),
  timezone TEXT NOT NULL,
  anchor_date TEXT NOT NULL,          -- local YYYY-MM-DD: recurring day of month
  started_at INTEGER NOT NULL,        -- UTC ms, local midnight of anchor_date
  canceled_at INTEGER,
  -- optimistic concurrency token for synchronous admin changes
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Immutable lifecycle / plan events. The timeline of truth for a subscription.
CREATE TABLE IF NOT EXISTS subscription_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  type TEXT NOT NULL CHECK (type IN (
    'created','plan_changed','paused','resumed','canceled'
  )),
  effective_date TEXT NOT NULL,       -- local YYYY-MM-DD (inclusive)
  effective_at INTEGER NOT NULL,      -- UTC ms of local midnight
  plan_id TEXT REFERENCES plans(id),  -- set for created / plan_changed
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'api', -- api | webhook
  idempotency_key TEXT,               -- unique per external source event
  created_at INTEGER NOT NULL,
  UNIQUE (subscription_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sub_events
  ON subscription_events (subscription_id, effective_at);

-- Invoices are split in two:
--   invoice_records  : append-only, trigger-frozen once issued. A correction
--                      can never rewrite amounts/tax/status — it INSERTs a new
--                      record with version = N+1 instead.
--   invoice_versions : the mutable pointer table mapping a logical bill
--                      (subscription + period_sequence) to its current record.
--                      Only superseded_by / current_record_id ever change.
CREATE TABLE IF NOT EXISTS invoice_records (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  period_sequence INTEGER NOT NULL,   -- 0-based billing period ordinal
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft','issued','voided','paid')),
  currency TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  correction_id TEXT,                 -- set when produced by a correction
  created_at INTEGER NOT NULL,
  issued_at INTEGER,
  UNIQUE (subscription_id, period_sequence, version)
);
CREATE INDEX IF NOT EXISTS idx_invoice_rec_sub
  ON invoice_records (subscription_id, period_sequence);

CREATE TABLE IF NOT EXISTS invoice_versions (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  period_sequence INTEGER NOT NULL,
  current_record_id TEXT NOT NULL REFERENCES invoice_records(id),
  PRIMARY KEY (subscription_id, period_sequence)
);

-- Backwards-compatible read view: superseded_by is derived from whether this
-- record is still the current one for its (subscription, sequence).
CREATE VIEW IF NOT EXISTS invoices AS
SELECT r.*,
  CASE WHEN v.current_record_id = r.id THEN NULL ELSE v.current_record_id END
    AS superseded_by
FROM invoice_records r
JOIN invoice_versions v
  ON v.subscription_id = r.subscription_id
 AND v.period_sequence = r.period_sequence;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoice_records(id),
  kind TEXT NOT NULL CHECK (kind IN ('charge','paused','proration','credit')),
  plan_id TEXT REFERENCES plans(id),
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  days INTEGER NOT NULL,
  unit_label TEXT NOT NULL,           -- e.g. "basic/month", "pro/day"
  amount_cents INTEGER NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines (invoice_id);

-- A correction request and its processing state. Never edited after terminal
-- state; re-running the same trigger event is idempotent.
CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  trigger_event_id TEXT NOT NULL REFERENCES subscription_events(id),
  reason TEXT NOT NULL,
  recalc_from INTEGER NOT NULL,       -- UTC ms: start of earliest recomputed period
  recalc_to INTEGER NOT NULL,         -- UTC ms: end of latest recomputed period
  status TEXT NOT NULL CHECK (status IN ('pending','applied','failed')),
  error_message TEXT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_corrections_sub ON corrections (subscription_id);

-- One row per superseded invoice: old vs new totals and signed delta.
CREATE TABLE IF NOT EXISTS invoice_diffs (
  id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES corrections(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  period_sequence INTEGER NOT NULL,
  old_invoice_id TEXT NOT NULL REFERENCES invoice_records(id),
  new_invoice_id TEXT NOT NULL REFERENCES invoice_records(id),
  old_total_cents INTEGER NOT NULL,
  new_total_cents INTEGER NOT NULL,
  delta_cents INTEGER NOT NULL,       -- new - old (positive = extra charge)
  created_at INTEGER NOT NULL,
  UNIQUE (correction_id, period_sequence)
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  invoice_id TEXT NOT NULL REFERENCES invoice_records(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refunds_sub ON refunds (subscription_id);

-- External webhooks, keyed by the provider's event id for idempotent replay.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','processed','failed','duplicate')),
  result_subscription_id TEXT,
  error_message TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- Notification delivery state with retry tracking.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  type TEXT NOT NULL,                  -- invoice_issued | invoice_corrected | refund_completed ...
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status);

-- Append-only audit trail. No UPDATE/DELETE by convention; every state change
-- that matters lands here with before/after JSON.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at);

-- ---- immutability triggers ------------------------------------------------
-- Rows that are draft may be removed (staging rollback). Once a bill is
-- issued/paid/voided its record is frozen: corrections must version, not
-- mutate. The pointer table invoice_versions is deliberately separate so the
-- "superseded" relationship can still move forward.
CREATE TRIGGER IF NOT EXISTS trg_invoice_immutable_upd
BEFORE UPDATE ON invoice_records
WHEN OLD.status IN ('issued','paid','voided')
BEGIN
  SELECT RAISE(ABORT, 'invoice record is finalized and immutable; create a new version');
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_immutable_del
BEFORE DELETE ON invoice_records
WHEN OLD.status IN ('issued','paid','voided')
BEGIN
  SELECT RAISE(ABORT, 'cannot delete a finalized invoice record');
END;

CREATE TRIGGER IF NOT EXISTS trg_line_immutable_upd
BEFORE UPDATE ON invoice_lines
WHEN EXISTS (SELECT 1 FROM invoice_records i WHERE i.id = OLD.invoice_id
             AND i.status IN ('issued','paid','voided'))
BEGIN
  SELECT RAISE(ABORT, 'line belongs to a finalized invoice');
END;

CREATE TRIGGER IF NOT EXISTS trg_line_immutable_del
BEFORE DELETE ON invoice_lines
WHEN EXISTS (SELECT 1 FROM invoice_records i WHERE i.id = OLD.invoice_id
             AND i.status IN ('issued','paid','voided'))
BEGIN
  SELECT RAISE(ABORT, 'cannot delete lines of a finalized invoice');
END;
`;

export function applySchema(db) {
  db.exec(SCHEMA_SQL);
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  }
}
