'use strict';

const pool = require('../db');
const { NOTIFICATION_TYPES } = require('./notificationTypes');

// Inserts a single notification row.
async function createNotification({ userId, type, title, message, link = null }) {
  if (!NOTIFICATION_TYPES.has(type)) {
    throw new Error(`createNotification: unknown type "${type}"`);
  }
  await pool.query(
    'INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)',
    [userId, type, title, message, link]
  );
}

// Inserts multiple notification rows in transactional chunks of 1000.
async function createNotifications(rows) {
  if (!rows || rows.length === 0) return;

  // Validate all rows upfront before touching the DB.
  for (const r of rows) {
    if (!NOTIFICATION_TYPES.has(r.type)) {
      throw new Error(`createNotifications: unknown type "${r.type}"`);
    }
    if (r.userId == null || r.title == null || r.message == null) {
      throw new Error('createNotifications: row missing required field (userId, title, or message)');
    }
  }

  const BATCH = 1000;
  const conn  = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk  = rows.slice(i, i + BATCH);
      const values = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = chunk.flatMap(r => [r.userId, r.type, r.title, r.message, r.link ?? null]);
      await conn.query(
        `INSERT INTO notifications (user_id, type, title, message, link) VALUES ${values}`,
        params
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { createNotification, createNotifications };
