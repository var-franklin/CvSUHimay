const express         = require('express');
const rateLimit       = require('express-rate-limit');
const router          = express.Router();
const pool            = require('../db');
const auth            = require('../middleware/auth');
const requireLiveUser = require('../middleware/requireLiveUser');
const studentOnly     = require('../middleware/studentOnly');

router.use(auth, requireLiveUser, studentOnly);

// Rate limiter — 10 requests per minute per user.
const leaderboardLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => String(req.user.id),
  message:         { error: 'RATE_LIMIT', message: 'Too many leaderboard requests. Try again in a minute.' },
});

const CACHE_TTL = 60_000;
const rowCache  = new Map();

function getCachedRows(key) {
  const entry = rowCache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
  return entry.rows;
}

function setCachedRows(key, rows) {
  rowCache.set(key, { rows, ts: Date.now() });
}

// ── Helpers ───────────────────────────────────────────────────────────

// Assigns sequential ranks (ties share a rank, next rank skips accordingly).
function assignRanks(rows, scoreKey) {
  let rank = 1;
  return rows.map((row, i) => {
    if (i > 0 && row[scoreKey] < rows[i - 1][scoreKey]) rank = i + 1;
    return { ...row, rank };
  });
}

function displayName(row) {
  return row.username?.trim() || row.full_name || 'Student';
}

function parseEquippedBadges(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatEntry(row, scoreKey, scoreLabel, currentUserId) {
  return {
    rank:            row.rank,
    user_id:         row.id,
    username:        row.username || null,
    display_name:    displayName(row),
    avatar_url:      row.avatar_url || null,
    score:           row[scoreKey] ?? 0,
    score_label:     scoreLabel,
    is_current_user: row.id === currentUserId,
    xp_points:       row.xp_points ?? 0,
    equipped_badges: parseEquippedBadges(row.equipped_badges),
  };
}

// Out-of-range fallback helpers ─────────────────────────────

async function xpFallback(userId) {
  const [[userRow]] = await pool.query(
    `SELECT id, username, full_name, avatar_url, xp_points, equipped_badges
     FROM   users
     WHERE  id = ? AND role = 'student' AND deleted_at IS NULL`,
    [userId]
  );
  if (!userRow) return null;

  const [[{ rank }]] = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM   users
     WHERE  role = 'student' AND deleted_at IS NULL AND xp_points > ?`,
    [userRow.xp_points]
  );

  return formatEntry({ ...userRow, rank: Number(rank) }, 'xp_points', 'XP', userId);
}

async function quizFallback(userId) {
  const [[quizRow]] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.avatar_url, u.xp_points, u.equipped_badges,
            ROUND(AVG((qa.score / NULLIF(qa.total_questions, 0)) * 100)) AS avg_score,
            COUNT(*) AS attempt_count
     FROM   users u JOIN quiz_attempts qa ON qa.user_id = u.id
     WHERE  u.id = ? AND u.role = 'student' AND u.deleted_at IS NULL
     GROUP  BY u.id
     HAVING COUNT(*) >= 3`,
    [userId]
  );
  if (!quizRow) return null

  // Count qualified students with a strictly higher average score.
  const [[{ rank }]] = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM (
       SELECT ROUND(AVG((qa2.score / NULLIF(qa2.total_questions, 0)) * 100)) AS avg_score
       FROM   users u2 JOIN quiz_attempts qa2 ON qa2.user_id = u2.id
       WHERE  u2.role = 'student' AND u2.deleted_at IS NULL
       GROUP  BY u2.id
       HAVING COUNT(*) >= 3
          AND ROUND(AVG((qa2.score / NULLIF(qa2.total_questions, 0)) * 100)) > ?
     ) ranked`,
    [quizRow.avg_score]
  );

  return {
    ...formatEntry({ ...quizRow, rank: Number(rank) }, 'avg_score', '%', userId),
    attempt_count: quizRow.attempt_count,
  };
}

async function achievementsFallback(userId) {
  const [[achRow]] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.avatar_url, u.xp_points, u.equipped_badges,
            COUNT(ua.achievement_id) AS achievement_count
     FROM   users u LEFT JOIN user_achievements ua ON ua.user_id = u.id
     WHERE  u.id = ? AND u.role = 'student' AND u.deleted_at IS NULL
     GROUP  BY u.id`,
    [userId]
  );
  if (!achRow) return null;

  // Count students with strictly more achievements.
  const [[{ rank }]] = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM (
       SELECT COUNT(ua2.achievement_id) AS achievement_count
       FROM   users u2 LEFT JOIN user_achievements ua2 ON ua2.user_id = u2.id
       WHERE  u2.role = 'student' AND u2.deleted_at IS NULL
       GROUP  BY u2.id
       HAVING COUNT(ua2.achievement_id) > ?
     ) ranked`,
    [achRow.achievement_count]
  );

  return formatEntry({ ...achRow, rank: Number(rank) }, 'achievement_count', 'unlocked', userId);
}

// ── GET /api/leaderboard/xp ───────────────────────────────────────────
router.get('/xp', leaderboardLimiter, async (req, res) => {
  try {
    const currentUserId = Number(req.user.id);

    let rankedRows = getCachedRows('xp');
    if (!rankedRows) {
      const [rows] = await pool.query(`
        SELECT id, username, full_name, avatar_url, xp_points, equipped_badges
        FROM   users
        WHERE  role = 'student'
          AND  deleted_at IS NULL
        ORDER  BY xp_points DESC, id ASC
        LIMIT  500
      `);
      rankedRows = assignRanks(rows, 'xp_points');
      setCachedRows('xp', rankedRows);
    }

    const entries = rankedRows.map(row =>
      formatEntry(row, 'xp_points', 'XP', currentUserId)
    );

    let currentUserEntry = entries.find(e => e.is_current_user) || null;
    if (!currentUserEntry) {
      currentUserEntry = await xpFallback(currentUserId);
    }

    res.json({ entries, currentUserEntry });
  } catch (err) {
    console.error('Leaderboard XP error:', err);
    res.status(500).json({ error: 'Failed to fetch XP leaderboard' });
  }
});

// ── GET /api/leaderboard/quiz ─────────────────────────────────────────
router.get('/quiz', leaderboardLimiter, async (req, res) => {
  try {
    const currentUserId = Number(req.user.id); // [fix 1]

    let rankedRows = getCachedRows('quiz'); // [fix 8]
    if (!rankedRows) {
      const [rows] = await pool.query(`
        SELECT
          u.id,
          u.username,
          u.full_name,
          u.avatar_url,
          u.xp_points,
          u.equipped_badges,
          -- [fix 5] NULLIF prevents silent NULL from division by zero distorting AVG.
          ROUND(AVG((qa.score / NULLIF(qa.total_questions, 0)) * 100)) AS avg_score,
          COUNT(*)                                                       AS attempt_count
        FROM   users u
        JOIN   quiz_attempts qa ON qa.user_id = u.id
        WHERE  u.role = 'student'
          AND  u.deleted_at IS NULL
        -- [fix 6] GROUP BY primary key only — other columns are functionally dependent on u.id.
        GROUP  BY u.id
        HAVING COUNT(*) >= 3
        ORDER  BY avg_score DESC, u.id ASC
        LIMIT  500
      `);
      rankedRows = assignRanks(rows, 'avg_score');
      setCachedRows('quiz', rankedRows);
    }

    const entries = rankedRows.map(row => ({
      ...formatEntry(row, 'avg_score', '%', currentUserId),
      attempt_count: row.attempt_count,
    }));

    let currentUserEntry = entries.find(e => e.is_current_user) || null;
    if (!currentUserEntry) {
      currentUserEntry = await quizFallback(currentUserId);
    }

    res.json({ entries, currentUserEntry });
  } catch (err) {
    console.error('Leaderboard Quiz error:', err);
    res.status(500).json({ error: 'Failed to fetch Quiz leaderboard' });
  }
});

// ── GET /api/leaderboard/simulation ──────────────────────────────────
// Simulations not yet scored — returns an honest empty state.
router.get('/simulation', leaderboardLimiter, async (_req, res) => {
  res.json({ entries: [], currentUserEntry: null, is_mock: true });
});

// ── GET /api/leaderboard/achievements ────────────────────────────────
// Ranks students by total achievements unlocked.
// LEFT JOIN ensures students with zero achievements appear ranked last.
router.get('/achievements', leaderboardLimiter, async (req, res) => {
  try {
    const currentUserId = Number(req.user.id); // [fix 1]

    let rankedRows = getCachedRows('achievements'); // [fix 8]
    if (!rankedRows) {
      const [rows] = await pool.query(`
        SELECT
          u.id,
          u.username,
          u.full_name,
          u.avatar_url,
          u.xp_points,
          u.equipped_badges,
          COUNT(ua.achievement_id) AS achievement_count
        FROM   users u
        LEFT JOIN user_achievements ua ON ua.user_id = u.id
        WHERE  u.role = 'student'
          AND  u.deleted_at IS NULL
        -- [fix 6] GROUP BY primary key only.
        GROUP  BY u.id
        ORDER  BY achievement_count DESC, u.id ASC
        LIMIT  500
      `);
      rankedRows = assignRanks(rows, 'achievement_count');
      setCachedRows('achievements', rankedRows);
    }

    const entries = rankedRows.map(row =>
      formatEntry(row, 'achievement_count', 'unlocked', currentUserId)
    );

    let currentUserEntry = entries.find(e => e.is_current_user) || null;
    if (!currentUserEntry) {
      currentUserEntry = await achievementsFallback(currentUserId);
    }

    res.json({ entries, currentUserEntry });
  } catch (err) {
    console.error('Leaderboard Achievements error:', err);
    res.status(500).json({ error: 'Failed to fetch Achievements leaderboard' });
  }
});

module.exports = router;
