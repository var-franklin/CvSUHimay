'use strict';

const pool = require('../db');

const cache = new Map(); // userId → { row, exp }
const TTL   = 60_000;   // 60 seconds

function invalidateCache(userId) {
  cache.delete(userId);
}

async function requireLiveUser(req, res, next) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Unauthenticated' });

  let row;

  // Check cache first
  const cached = cache.get(id);
  if (cached && cached.exp > Date.now()) {
    row = cached.row;
  } else {
    // Single indexed SELECT — pulls everything needed in one round-trip
    const [[freshRow]] = await pool.query(
      `SELECT id, token_version, must_change_password,
              lock_until, deleted_at
       FROM users WHERE id = ?`,
      [id]
    );

    if (!freshRow) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    cache.set(id, { row: freshRow, exp: Date.now() + TTL });
    row = freshRow;
  }

  if (row.deleted_at) {
    return res.status(401).json({ error: 'Account has been deleted' });
  }

  if (row.lock_until && new Date(row.lock_until) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
  }

  const claimedVersion = req.user.token_version ?? 0;
  if (claimedVersion < (row.token_version ?? 0)) {
    return res.status(401).json({ error: 'token_invalidated' });
  }

  if (row.must_change_password) {
    const isPasswordRoute = req.method === 'PUT' && req.path === '/password';
    const isMeRoute       = req.method === 'GET'  && req.path === '/me';
    if (!isPasswordRoute && !isMeRoute) {
      return res.status(403).json({ error: 'password_change_required' });
    }
  }

  req.userRow = row;
  next();
}

requireLiveUser.invalidateCache = invalidateCache;

module.exports = requireLiveUser;