import { id } from '../db/database.js';

export function writeAudit(db, { actor, action, entityType, entityId, before = null, after = null }) {
  db.prepare(
    `INSERT INTO audit_log (id, actor, action, entity_type, entity_id, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id('aud'),
    actor,
    action,
    entityType,
    entityId,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    Date.now(),
  );
}

export function listAudit(db, { entityType, entityId, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit).map((r) => ({
    ...r,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));
}
