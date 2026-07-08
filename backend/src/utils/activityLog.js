const pool = require('../db');

const logActivity = async (adminId, action, targetId, targetName, details = null) => {
  try {
    const [[admin]] = await pool.query(
      'SELECT full_name, email FROM users WHERE id = ?', [adminId]
    );
    const adminName = admin?.full_name || admin?.email || 'Admin';

    await pool.query(
      `INSERT INTO activity_logs (admin_id, admin_name, action, target_id, target_name, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        adminId,
        adminName,
        action,
        targetId  ?? null,
        targetName ?? null,
        details != null ? JSON.stringify(details) : null,
      ]
    );
  } catch (e) {
    console.error('[activityLog] write failed:', e.message);
  }
};

module.exports = { logActivity };
