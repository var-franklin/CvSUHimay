const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const DEFAULTS = {
  notifications: { email: true, inApp: true, push: false, digest: 'daily' },
  gamification: { leaderboardVisible: false, showBadges: true, anonymityMode: false },
  accessibility: { theme: 'system', reduceMotion: false },
  profileVisible: true,
};

async function loadSettings(userId) {
  const [[row]] = await pool.query('SELECT settings FROM user_settings WHERE user_id = ?', [userId]);
  const stored = row ? row.settings : null;
  const parsed = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : {};
  return { ...DEFAULTS, ...parsed };
}

async function saveSettings(userId, newSettings) {
  const json = JSON.stringify(newSettings);
  await pool.query(
    'INSERT INTO user_settings (user_id, settings) VALUES (?, ?) ON DUPLICATE KEY UPDATE settings = ?',
    [userId, json, json]
  );
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const settings = await loadSettings(req.user.id);
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/notifications', authMiddleware, async (req, res) => {
  try {
    const cur = await loadSettings(req.user.id);
    const updated = { ...cur, notifications: { ...cur.notifications, ...req.body } };
    await saveSettings(req.user.id, updated);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save notifications' });
  }
});

router.patch('/gamification', authMiddleware, async (req, res) => {
  try {
    const cur = await loadSettings(req.user.id);
    const updated = { ...cur, gamification: { ...cur.gamification, ...req.body } };
    await saveSettings(req.user.id, updated);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save gamification settings' });
  }
});

router.patch('/accessibility', authMiddleware, async (req, res) => {
  try {
    const cur = await loadSettings(req.user.id);
    const updated = { ...cur, accessibility: { ...cur.accessibility, ...req.body } };
    await saveSettings(req.user.id, updated);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save accessibility settings' });
  }
});

module.exports = router;
