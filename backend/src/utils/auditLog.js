const pool = require('../db');

async function auditLog({
  courseId     = null,
  actorId,
  actorRole,
  action,
  targetUserId = null,
  metadata     = null,
}) {
  try {
    await pool.query(
      `INSERT INTO course_audit_log
         (course_id, actor_id, actor_role, action, target_user_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        courseId,
        actorId,
        actorRole,
        action,
        targetUserId,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (e) {
    console.error('auditLog failed:', e.message);
  }
}

async function auditLogBatch(entries) {
  if (!entries || entries.length === 0) return;
  try {
    const values = entries.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params = entries.flatMap(e => [
      e.courseId     ?? null,
      e.actorId,
      e.actorRole,
      e.action,
      e.targetUserId ?? null,
      e.metadata     ? JSON.stringify(e.metadata) : null,
    ]);
    await pool.query(
      `INSERT INTO course_audit_log
         (course_id, actor_id, actor_role, action, target_user_id, metadata)
       VALUES ${values}`,
      params
    );
  } catch (e) {
    console.error('auditLogBatch failed:', e.message);
  }
}

module.exports = { auditLog, auditLogBatch };
