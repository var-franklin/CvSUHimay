const jwt  = require('jsonwebtoken');
const pool = require('../db');

async function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }

  try {
    const [[row]] = await pool.query(
      'SELECT account_status, token_version FROM users WHERE id = ?',
      [decoded.id]
    );
    if (!row) return res.status(401).json({ error: 'Account no longer exists' });

    req.user = {
      ...decoded,
      account_status: row.account_status,
      _db_token_version: row.token_version,
    };
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

// Applied on top of authMiddleware for every protected route.
function requireActiveAccount(req, res, next) {
  if (req.user.account_status !== 'active') {
    return res.status(403).json({
      error: 'Account not active',
      account_status: req.user.account_status,
    });
  }
  next();
}

module.exports = authMiddleware;
module.exports.requireActiveAccount = requireActiveAccount;