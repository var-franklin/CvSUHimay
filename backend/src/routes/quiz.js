const express           = require('express');
const rateLimit         = require('express-rate-limit');
const crypto            = require('crypto');
const router            = express.Router();
const pool              = require('../db');
const authenticateToken = require('../middleware/auth');
const { createNotification }  = require('../utils/notifications');
const { evaluateAndPersist } = require('../utils/achievementUtils');
const {
  computeLevel, rankFor,
  TOTAL_MODULES, PASS_THRESHOLD, QUESTIONS_PER_QUIZ, SECONDS_PER_QUESTION,
  checkLevelUp,
} = require('../utils/gamification');
const {
  getQuestionsForModule,
  computeScore,
  computeMaxStreak,
  computeXpEarned,
} = require('../utils/quizBank');

// ── Rate limiters ────────────────────────────────────────────────────────────

const submitLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => String(req.user.id),
  message:         { error: 'RATE_LIMIT', message: 'Too many submissions. Try again in a few minutes.' },
});

const checkLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => String(req.user.id),
  message:         { error: 'RATE_LIMIT', message: 'Too many check requests. Try again in a few minutes.' },
});

const questionsLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => `${req.user.id}:${req.params.moduleId}`,
  message:         { error: 'RATE_LIMIT', message: 'Too many question fetches for this module. Please wait a few minutes before retrying.' },
});

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_OPTIONS = new Set(['A', 'B', 'C', 'D', null]);
const CHECK_OPTIONS = new Set(['A', 'B', 'C', 'D']);

const MAX_TIME_SPENT = QUESTIONS_PER_QUIZ * SECONDS_PER_QUESTION + 60;

function validateModuleId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_MODULES ? n : null;
}

function validateAnswers(answers) {
  if (!Array.isArray(answers)) return false;
  if (answers.length !== QUESTIONS_PER_QUIZ) return false;
  return answers.every(a => VALID_OPTIONS.has(a));
}

function validatePerQuestionTimeMs(arr) {
  if (arr === undefined || arr === null) return true;
  if (!Array.isArray(arr) || arr.length !== QUESTIONS_PER_QUIZ) return false;
  return arr.every(t => Number.isInteger(t) && t >= 0 && t <= SECONDS_PER_QUESTION * 1000);
}

router.get('/modules/:moduleId/questions', authenticateToken, questionsLimiter, async (req, res) => {
  const moduleId = validateModuleId(req.params.moduleId);
  if (!moduleId) return res.status(400).json({ error: 'INVALID_MODULE_ID' });

  try {
    const { questions, questionIds } = getQuestionsForModule(moduleId, { includeAnswers: true });
    const expiresAt = new Date(Date.now() + QUESTIONS_PER_QUIZ * SECONDS_PER_QUESTION * 1000 + 60_000);

    const sessionToken = crypto.randomBytes(16).toString('hex');

    await pool.query(
      `INSERT INTO quiz_sessions (user_id, module_id, question_ids, shuffled_data, session_token, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         question_ids     = VALUES(question_ids),
         shuffled_data    = VALUES(shuffled_data),
         session_token    = VALUES(session_token),
         answered_indices = '[]',
         started_at       = NOW(),
         expires_at       = VALUES(expires_at)`,
      [
        req.user.id,
        moduleId,
        JSON.stringify(questionIds),
        JSON.stringify(questions),
        sessionToken,
        expiresAt,
      ]
    );

    const clientQuestions = questions.map(({ correct_answer, explanation, _optionMap, ...rest }) => rest);
    res.json({ questions: clientQuestions, session_token: sessionToken });
  } catch (err) {
    console.error('quiz questions error', { route: 'GET /questions', userId: req.user.id, err: err.message });
    res.status(500).json({ error: 'QUIZ_QUESTIONS_FAILED' });
  }
});

router.post('/modules/:moduleId/check', authenticateToken, checkLimiter, async (req, res) => {
  const moduleId = validateModuleId(req.params.moduleId);
  if (!moduleId) return res.status(400).json({ error: 'INVALID_MODULE_ID' });

  const { questionIndex, picked } = req.body;
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= QUESTIONS_PER_QUIZ) {
    return res.status(400).json({ error: 'INVALID_QUESTION_INDEX' });
  }
  if (!CHECK_OPTIONS.has(picked)) {
    return res.status(400).json({ error: 'INVALID_OPTION' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[session]] = await conn.query(
      `SELECT id, shuffled_data, answered_indices, expires_at
       FROM quiz_sessions
       WHERE user_id = ? AND module_id = ?
       ORDER BY id DESC LIMIT 1
       FOR UPDATE`,
      [req.user.id, moduleId]
    );

    if (!session || new Date(session.expires_at) < new Date()) {
      await conn.rollback();
      return res.status(400).json({ error: 'SESSION_EXPIRED' });
    }

    const answered = Array.isArray(session.answered_indices)
      ? session.answered_indices
      : (session.answered_indices ? JSON.parse(session.answered_indices) : []);

    if (answered.includes(questionIndex)) {
      await conn.rollback();
      return res.status(409).json({ error: 'ALREADY_ANSWERED' });
    }

    // Parse the result BEFORE committing so an invalid index can still roll back
    // the answered_indices update (avoids marking an unanswerable question as answered).
    const shuffled = JSON.parse(session.shuffled_data);
    const q = shuffled[questionIndex];
    if (!q) {
      await conn.rollback();
      return res.status(400).json({ error: 'INVALID_QUESTION_INDEX' });
    }

    const newAnswered = [...answered, questionIndex];
    await conn.query(
      `UPDATE quiz_sessions SET answered_indices = ? WHERE id = ?`,
      [JSON.stringify(newAnswered), session.id]
    );

    await conn.commit();

    return res.json({
      questionIndex,
      isCorrect: picked === q.correct_answer,
      correct:   q.correct_answer,
    });
  } catch (err) {
    await conn.rollback();
    console.error('quiz check error', { route: 'POST /check', userId: req.user.id, err: err.message });
    res.status(500).json({ error: 'QUIZ_CHECK_FAILED' });
  } finally {
    conn.release();
  }
});

router.post('/modules/:moduleId/submit', authenticateToken, submitLimiter, async (req, res) => {
  const moduleId = validateModuleId(req.params.moduleId);
  if (!moduleId) return res.status(400).json({ error: 'INVALID_MODULE_ID' });

  const { answers, timeSpent, perQuestionTimeMs, session_token } = req.body;

  if (!validateAnswers(answers)) {
    return res.status(400).json({
      error:   'QUIZ_VALIDATION',
      message: `answers must be an array of exactly ${QUESTIONS_PER_QUIZ} elements, each 'A'|'B'|'C'|'D'|null`,
    });
  }

  if (typeof timeSpent !== 'number' || timeSpent < 0 || timeSpent > MAX_TIME_SPENT) {
    return res.status(400).json({
      error:   'QUIZ_VALIDATION',
      message: `timeSpent must be 0–${MAX_TIME_SPENT} seconds`,
    });
  }

  if (!validatePerQuestionTimeMs(perQuestionTimeMs)) {
    return res.status(400).json({
      error:   'QUIZ_VALIDATION',
      message: `perQuestionTimeMs must be an array of ${QUESTIONS_PER_QUIZ} integers, each 0–${SECONDS_PER_QUESTION * 1000}`,
    });
  }

  const userId = req.user.id;

  try {
    // ── 1. Load shuffled session ──────────────────────────────────────────────
    const [[session]] = await pool.query(
      `SELECT question_ids, shuffled_data, expires_at, started_at, session_token
       FROM quiz_sessions
       WHERE user_id = ? AND module_id = ?
       ORDER BY id DESC LIMIT 1`,
      [userId, moduleId]
    );
    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(400).json({ error: 'SESSION_EXPIRED', message: 'Quiz session expired. Reload the quiz.' });
    }

    if (session.session_token !== null && session_token !== session.session_token) {
      return res.status(400).json({
        error:   'SESSION_TOKEN_MISMATCH',
        message: 'Quiz session token mismatch. Reload the quiz.',
      });
    }

    const questionIds       = JSON.parse(session.question_ids);
    const shuffledQuestions = JSON.parse(session.shuffled_data);

    const serverTimeSpent = Math.min(
      Math.max(0, Math.round((Date.now() - new Date(session.started_at).getTime()) / 1000)),
      MAX_TIME_SPENT
    );

    // ── 2. Compute score server-side ─────────────────────────────────────────
    const { score, perQuestion } = computeScore(moduleId, answers, questionIds, shuffledQuestions);
    const totalQuestions  = QUESTIONS_PER_QUIZ;
    const passed          = score >= totalQuestions * PASS_THRESHOLD;
    const isPerfect       = score === totalQuestions;
    const maxStreak       = computeMaxStreak(perQuestion);
    const completedInTime = timeSpent <= totalQuestions * SECONDS_PER_QUESTION;
    const percentage      = Math.round((score / totalQuestions) * 100);

    // ── 3. All DB writes inside a transaction ─────────────────────────────────
    const conn = await pool.getConnection();
    let attemptId, newXp, isFirstPass, xpEarned, resolvedCourseId, oldXp;
    try {
      await conn.beginTransaction();

      const [[{ xp_points: oldXpVal }]] = await conn.query(
        'SELECT xp_points FROM users WHERE id = ? FOR UPDATE',
        [userId]
      );
      oldXp = oldXpVal;

      // Resolve courseId from student's most recent accepted enrollment.
      const [[enrollment]] = await conn.query(
        `SELECT course_id FROM course_enrollments
         WHERE student_id = ? AND status = 'accepted'
         ORDER BY enrolled_at DESC LIMIT 1`,
        [userId]
      );
      resolvedCourseId = enrollment?.course_id ?? null;

      // isFirstPass check — no FOR UPDATE needed: user row lock above serializes
      // concurrent submits for the same user, so this SELECT sees a stable view.
      const [[priorPass]] = await conn.query(
        `SELECT 1 FROM quiz_attempts
         WHERE user_id = ? AND module_id = ? AND passed = TRUE
         LIMIT 1`,
        [userId, moduleId]
      );
      isFirstPass = passed && !priorPass;

      // Retakes after first pass earn halved XP (isFirstPass=false → 0.5× multiplier).
      // Students should still earn XP for correct answers on retakes.
      xpEarned = computeXpEarned({ score, passed, isPerfect, isFirstPass });

      // Insert attempt row
      const [ins] = await conn.query(
        `INSERT INTO quiz_attempts
           (user_id, module_id, course_id, score, total_questions, passed,
            time_spent, server_time_spent, max_streak, completed_in_time, xp_earned, is_first_pass)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId, moduleId, resolvedCourseId, score, totalQuestions, passed ? 1 : 0,
          timeSpent, serverTimeSpent, maxStreak, completedInTime ? 1 : 0, xpEarned, isFirstPass ? 1 : 0,
        ]
      );
      attemptId = ins.insertId;

      // Insert per-question answer log
      const answerRows = perQuestion.map((q, i) => [
        attemptId, i, q.questionId,
        q.pickedOption, q.correctOption,
        q.isCorrect ? 1 : 0,
        perQuestionTimeMs?.[i] ?? 0,
      ]);
      await conn.query(
        `INSERT INTO quiz_attempt_answers
           (attempt_id, question_index, question_id, picked_option, correct_option, is_correct, time_spent_ms)
         VALUES ?`,
        [answerRows]
      );

      await conn.query('UPDATE users SET xp_points = xp_points + ? WHERE id = ?', [xpEarned, userId]);
      newXp = oldXp + xpEarned;

      if (xpEarned > 0) {
        await conn.query(
          'INSERT INTO xp_events (user_id, amount, source, reference_id) VALUES (?, ?, ?, ?)',
          [userId, xpEarned, 'quiz', attemptId]
        );
      }

      await conn.query(
        'DELETE FROM quiz_sessions WHERE user_id = ? AND module_id = ?',
        [userId, moduleId]
      );

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    // ── 4. Achievement evaluation ─────────────────────────────────────────────
    let newlyUnlocked = [];
    try {
      newlyUnlocked = await evaluateAndPersist(userId);
    } catch (achErr) {
      console.error('achievement eval error', { userId, err: achErr?.message });
    }

    // ── 5. Level-up notification using shared helper ─────────────────────────
    try {
      await checkLevelUp(userId, oldXp, newXp);
    } catch (lvlErr) {
      console.error('level-up notification error', { userId, err: lvlErr?.message });
    }

    // ── 6. Perfect-score instructor notifications ─────────────────────────────
    if (isPerfect) {
      ;(async () => {
        try {
          const [[userRow]] = await pool.query('SELECT full_name FROM users WHERE id = ?', [userId]);
          const studentName = userRow?.full_name || 'A student';
          const [instructors] = await pool.query(
            `SELECT DISTINCT c.instructor_id
             FROM courses c
             JOIN course_enrollments ce ON ce.course_id = c.id
             WHERE ce.student_id = ? AND ce.status = 'accepted'`,
            [userId]
          );
          await Promise.all(
            instructors.map(({ instructor_id }) =>
              createNotification({
                userId:  instructor_id,
                type:    'student_progress',
                title:   'Perfect Quiz Score',
                message: `${studentName} scored ${totalQuestions}/${totalQuestions} on Module ${moduleId}.`,
                link:    '/instructor/dashboard',
              })
            )
          );
        } catch (err) {
          console.error('perfect score notification error', { userId, err: err?.message });
        }
      })();
    }

    // ── 7. Respond ────────────────────────────────────────────────────────────
    res.json({
      success:      true,
      attemptId,
      score,
      totalQuestions,
      percentage,
      passed,
      isPerfect,
      maxStreak,
      completedInTime,
      xpEarned,
      newXpTotal:   newXp,
      newlyUnlocked,
      review: perQuestion.map((q, i) => ({
        index:       i,
        questionId:  q.questionId,
        question:    q.question,
        optionA:     q.optionA,
        optionB:     q.optionB,
        optionC:     q.optionC,
        optionD:     q.optionD,
        picked:      q.pickedOption,
        correct:     q.correctOption,
        isCorrect:   q.isCorrect,
        explanation: q.explanation,
      })),
    });
  } catch (err) {
    console.error('quiz submit error', { route: 'POST /submit', userId: req.user.id, err: err.message });
    res.status(500).json({ error: 'QUIZ_SUBMIT_FAILED' });
  }
});

router.get('/progress', authenticateToken, async (req, res) => {
  try {
    const [progress] = await pool.query(
      `SELECT
         module_id,
         MAX(score)                                          AS best_score,
         ROUND(AVG(ROUND((score / total_questions) * 100))) AS avg_percentage,
         COUNT(*)                                            AS attempt_count,
         MAX(created_at)                                     AS last_attempt
       FROM quiz_attempts
       WHERE user_id = ?
         AND module_id BETWEEN 1 AND ?
       GROUP BY module_id
       ORDER BY module_id ASC`,
      [req.user.id, TOTAL_MODULES]
    );
    res.json(progress);
  } catch (err) {
    console.error('quiz progress error', { userId: req.user.id, err: err.message });
    res.status(500).json({ error: 'QUIZ_PROGRESS_FAILED' });
  }
});

router.get('/modules/:id/attempts', authenticateToken, async (req, res) => {
  const moduleId = validateModuleId(req.params.id);
  if (!moduleId) return res.status(400).json({ error: 'INVALID_MODULE_ID' });

  try {
    const [attempts] = await pool.query(
      `SELECT
         id, score, total_questions, passed, time_spent, max_streak,
         completed_in_time, xp_earned, is_first_pass, created_at,
         ROUND((score / total_questions) * 100) AS percentage
       FROM quiz_attempts
       WHERE user_id = ? AND module_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.id, moduleId]
    );
    res.json({ success: true, attempts });
  } catch (err) {
    console.error('quiz attempts error', { userId: req.user.id, err: err.message });
    res.status(500).json({ error: 'QUIZ_ATTEMPTS_FAILED' });
  }
});

router.get('/attempts/:id', authenticateToken, async (req, res) => {
  const attemptId = Number(req.params.id);
  if (!Number.isInteger(attemptId) || attemptId < 1) {
    return res.status(400).json({ error: 'INVALID_ATTEMPT_ID' });
  }

  try {
    const [[attempt]] = await pool.query(
      `SELECT qa.id, qa.user_id, qa.module_id, qa.course_id,
              qa.score, qa.total_questions, qa.passed, qa.time_spent,
              qa.max_streak, qa.completed_in_time, qa.xp_earned, qa.created_at
       FROM quiz_attempts qa WHERE qa.id = ?`,
      [attemptId]
    );
    if (!attempt) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });

    const isOwner      = attempt.user_id === req.user.id;
    const isAdmin      = req.user.role === 'admin';
    let   isInstructor = false;

    if (!isOwner && !isAdmin && req.user.role === 'instructor' && attempt.course_id) {
      const [[course]] = await pool.query(
        'SELECT instructor_id FROM courses WHERE id = ?', [attempt.course_id]
      );
      isInstructor = course?.instructor_id === req.user.id;
    }

    if (!isOwner && !isAdmin && !isInstructor) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const [answers] = await pool.query(
      `SELECT question_index, question_id, picked_option, correct_option, is_correct, time_spent_ms
       FROM quiz_attempt_answers WHERE attempt_id = ? ORDER BY question_index ASC`,
      [attemptId]
    );

    res.json({ success: true, attempt, answers });
  } catch (err) {
    console.error('quiz attempt detail error', { err: err.message });
    res.status(500).json({ error: 'QUIZ_ATTEMPT_DETAIL_FAILED' });
  }
});

router.get('/all-attempts', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'instructor') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  try {
    let query, countQuery, params, countParams;

    if (req.user.role === 'admin') {
      countQuery  = `SELECT COUNT(*) AS total FROM quiz_attempts`;
      countParams = [];
      query = `
        SELECT qa.id, qa.module_id, qa.score, qa.total_questions, qa.passed,
               qa.time_spent, qa.xp_earned, qa.created_at,
               ROUND((qa.score / qa.total_questions) * 100) AS percentage,
               u.full_name, u.email,
               c.name AS course_name
        FROM quiz_attempts qa
        JOIN users u ON u.id = qa.user_id
        LEFT JOIN courses c ON c.id = qa.course_id
        ORDER BY qa.created_at DESC
        LIMIT ? OFFSET ?`;
      params = [limit, offset];
    } else {
      countQuery = `
        SELECT COUNT(*) AS total
        FROM quiz_attempts qa
        JOIN courses c ON c.id = qa.course_id
        WHERE c.instructor_id = ?`;
      countParams = [req.user.id];
      query = `
        SELECT qa.id, qa.module_id, qa.score, qa.total_questions, qa.passed,
               qa.time_spent, qa.xp_earned, qa.created_at,
               ROUND((qa.score / qa.total_questions) * 100) AS percentage,
               u.full_name, u.email,
               c.name AS course_name
        FROM quiz_attempts qa
        JOIN users u ON u.id = qa.user_id
        JOIN courses c ON c.id = qa.course_id
        WHERE c.instructor_id = ?
        ORDER BY qa.created_at DESC
        LIMIT ? OFFSET ?`;
      params = [req.user.id, limit, offset];
    }

    const [[{ total }]] = await pool.query(countQuery, countParams);
    const [attempts]    = await pool.query(query, params);

    res.json({
      success:    true,
      attempts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('quiz all-attempts error', { err: err.message });
    res.status(500).json({ error: 'QUIZ_ALL_ATTEMPTS_FAILED' });
  }
});

module.exports = router;
