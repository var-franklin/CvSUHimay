'use strict';

// [fix] Module-level import — replaces the inline dynamic require inside checkLevelUp.
const { createNotification } = require('./notifications');

// ── XP / Level ──────────────────────────────────────────────────────────────

/**
 * Compute current level from total XP using the quadratic formula.
 * Level n requires 25 * (n-1) * n XP total.
 * n = floor( (1 + sqrt(1 + 4*XP/25)) / 2 )
 */
function computeLevel(totalPoints) {
  if (totalPoints < 50) return 1;
  const c = totalPoints / 25;
  return Math.floor((1 + Math.sqrt(1 + 4 * c)) / 2);
}

const RANK_NAMES = [
  'Novice', 'Apprentice', 'Practitioner', 'Skilled', 'Expert', 'Master',
  'Grandmaster', 'Legend', 'Mythic'
];

/**
 * Returns the rank name for a given level.
 * Falls back to "Level N" if the level exceeds the predefined names.
 */
function rankFor(level) {
  const idx = level - 1;
  return idx < RANK_NAMES.length ? RANK_NAMES[idx] : `Level ${level}`;
}

// ── Streak ───────────────────────────────────────────────────────────────────

function todayPHT() {
  const pht = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
  return pht.toISOString().slice(0, 10);
}

async function updateStreak(userId, db) {
  const today = todayPHT();

  const [[row]] = await db.query(
    'SELECT current_streak, last_active_date FROM users WHERE id = ?',
    [userId]
  );

  if (!row) return;

  const lastActive = row.last_active_date
    ? (row.last_active_date instanceof Date
        ? row.last_active_date.toISOString().slice(0, 10)
        : String(row.last_active_date).slice(0, 10))
    : null;

  if (lastActive === today) return;

  const yesterdayDate = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  const newStreak = lastActive === yesterday
    ? (row.current_streak ?? 0) + 1
    : 1;

  await db.query(
    'UPDATE users SET current_streak = ?, last_active_date = ? WHERE id = ?',
    [newStreak, today, userId]
  );
}

// ── Learning / Quiz constants ────────────────────────────────────────────────

const TOTAL_MODULES        = 5;
const PASS_THRESHOLD       = 0.7;
const QUESTIONS_PER_QUIZ   = 10;
const SECONDS_PER_QUESTION = 60;

const XP_PER_CORRECT       = 5;
const XP_PASS_BONUS        = 20;
const XP_PERFECT_BONUS     = 50;
const XP_RETAKE_MULTIPLIER = 0.5;

async function checkLevelUp(userId, oldXp, newXp) {
  const oldLevel = computeLevel(oldXp);
  const newLevel = computeLevel(newXp);
  if (newLevel <= oldLevel) return;

  // Build all notification promises, then await them together.
  const promises = [];
  for (let l = oldLevel + 1; l <= newLevel; l++) {
    promises.push(
      createNotification({
        userId,
        type:    'level_up',
        title:   `Level ${l} Reached`,
        message: `You leveled up to ${rankFor(l)}. Keep going!`,
        link:    '/student/dashboard/profile',
      })
    );
  }
  await Promise.all(promises);
}

module.exports = {
  // XP / Level (LEVEL_THRESHOLDS removed; levels are now infinite)
  computeLevel, rankFor, RANK_NAMES,
  // Streak
  updateStreak,
  // Learning constants
  TOTAL_MODULES, PASS_THRESHOLD, QUESTIONS_PER_QUIZ, SECONDS_PER_QUESTION,
  XP_PER_CORRECT, XP_PASS_BONUS, XP_PERFECT_BONUS, XP_RETAKE_MULTIPLIER,
  checkLevelUp,
};
