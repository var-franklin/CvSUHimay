const path = require('path');
const {
  TOTAL_MODULES,
  QUESTIONS_PER_QUIZ,
  XP_PER_CORRECT,
  XP_PASS_BONUS,
  XP_PERFECT_BONUS,
  XP_RETAKE_MULTIPLIER,
} = require('./gamification');

// ── Load all banks on startup ─────────────────────────────────────────────────
const BANK = new Map(); // moduleId (number) → questions[]

for (let m = 1; m <= TOTAL_MODULES; m++) {
  const filePath = path.join(__dirname, '..', 'data', 'quiz', `module-${m}.json`);
  const questions = require(filePath);

  // Startup validation
  if (!Array.isArray(questions) || questions.length < QUESTIONS_PER_QUIZ) {
    throw new Error(`quizBank: module-${m}.json must have at least ${QUESTIONS_PER_QUIZ} questions (got ${Array.isArray(questions) ? questions.length : 'non-array'})`);
  }
  for (const q of questions) {
    if (!q.id || !q.question || !q.option_a || !q.option_b || !q.option_c || !q.option_d) {
      throw new Error(`quizBank: module-${m}.json has a question missing required fields (id=${q.id})`);
    }
    if (!['A','B','C','D'].includes(q.correct_answer)) {
      throw new Error(`quizBank: module-${m}.json question id=${q.id} has invalid correct_answer="${q.correct_answer}"`);
    }
  }

  BANK.set(m, questions);
  console.log(`✓ Quiz bank loaded: module ${m} (${questions.length} questions)`);
}

// ── Fisher-Yates in-place shuffle ────────────────────────────────────────────
function _fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Option shuffle helper ─────────────────────────────────────────────────────
// Returns a new question object with options and correct_answer remapped after a shuffle.
function _shuffleOptions(question) {
  const opts  = ['A','B','C','D'];
  const order = _fisherYates([...opts]); 
  const newQ  = { ...question };
  // Remap option text
  const oldOpts = { A: question.option_a, B: question.option_b, C: question.option_c, D: question.option_d };
  const newOpts = {};
  order.forEach((origSlot, i) => {
    newOpts[opts[i]] = oldOpts[origSlot];
  });
  newQ.option_a = newOpts.A;
  newQ.option_b = newOpts.B;
  newQ.option_c = newOpts.C;
  newQ.option_d = newOpts.D;
  // Remap correct_answer to its new slot
  const newCorrect = opts[order.indexOf(question.correct_answer)];
  newQ.correct_answer = newCorrect;
  // Attach a mapping for server-side scoring (new letter → original letter)
  newQ._optionMap = Object.fromEntries(opts.map((newSlot, i) => [newSlot, order[i]]));
  return newQ;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns QUESTIONS_PER_QUIZ randomly selected and option-shuffled questions.
 *
 * @param {number}  moduleId
 * @param {object}  opts
 * @param {boolean} [opts.includeAnswers=false]
 * @returns {{ questions: object[], questionIds: number[] }}
 */
function getQuestionsForModule(moduleId, { includeAnswers = false } = {}) {
  const pool = BANK.get(moduleId);
  if (!pool) throw new Error(`quizBank: module ${moduleId} not found`);

  const shuffledPool = _fisherYates([...pool]);
  const selected     = shuffledPool.slice(0, QUESTIONS_PER_QUIZ);

  // Shuffle each question's answer options
  const withShuffledOpts = selected.map(_shuffleOptions);

  // Track which original question IDs were selected
  const questionIds = withShuffledOpts.map(q => q.id);

  if (includeAnswers) {
    return { questions: withShuffledOpts, questionIds };
  }

  // Strip sensitive fields before sending to the client
  const clientSafe = withShuffledOpts.map(({ correct_answer, explanation, _optionMap, ...rest }) => rest);
  return { questions: clientSafe, questionIds };
}

/**
 * Computes score by comparing client answers against the bank.
 * The server re-selects questions by IDs (not randomly), so the scoring is
 * deterministic as long as questionIds is persisted in the session.
 *
 *
 * @param {number}   moduleId
 * @param {string[]} clientAnswers  
 * @param {number[]} questionIds 
 * @param {object[]} [shuffledQuestions] 
 * @returns {{ score: number, perQuestion: object[] }}
 */
function computeScore(moduleId, clientAnswers, questionIds, shuffledQuestions) {
  const pool = BANK.get(moduleId);
  if (!pool) throw new Error(`quizBank: module ${moduleId} not found`);
  if (clientAnswers.length !== QUESTIONS_PER_QUIZ || questionIds.length !== QUESTIONS_PER_QUIZ) {
    throw new Error('quizBank: answer/questionId arrays must have exactly QUESTIONS_PER_QUIZ elements');
  }

  // Resolve questions by ID from the bank (original, unshuffled)
  const qById = new Map(pool.map(q => [q.id, q]));

  let score = 0;
  const perQuestion = questionIds.map((qid, i) => {
    const original      = qById.get(qid);
    if (!original) throw new Error(`quizBank: question id=${qid} not found in module ${moduleId}`);

    // The shuffled question tells us which client-side letter maps to which original letter.
    // If shuffledQuestions is provided, use it; otherwise score against the original correct answer directly.
    let correctClientLetter;
    if (shuffledQuestions && shuffledQuestions[i]) {
      correctClientLetter = shuffledQuestions[i].correct_answer; // already mapped during shuffle
    } else {
      correctClientLetter = original.correct_answer;
    }

    const picked    = clientAnswers[i] ?? null; 
    const isCorrect = picked !== null && picked === correctClientLetter;
    if (isCorrect) score++;

    // Falls back to original if shuffledQuestions is unavailable.
    const displayQ = (shuffledQuestions && shuffledQuestions[i]) ? shuffledQuestions[i] : original;

    return {
      questionId:    qid,
      pickedOption:  picked,
      correctOption: correctClientLetter,
      isCorrect,
      explanation:   original.explanation ?? null,
      question:      original.question,  
      optionA:       displayQ.option_a, 
      optionB:       displayQ.option_b,
      optionC:       displayQ.option_c,
      optionD:       displayQ.option_d,
    };
  });

  return { score, perQuestion };
}

/**
 * Returns the longest streak of consecutive correct answers in a perQuestion array.
 * @param {{ isCorrect: boolean }[]} perQuestion
 * @returns {number}
 */
function computeMaxStreak(perQuestion) {
  let max = 0, cur = 0;
  for (const q of perQuestion) {
    if (q.isCorrect) { cur++; max = Math.max(max, cur); }
    else cur = 0;
  }
  return max;
}

/**
 * Computes XP for a quiz attempt.
 */
function computeXpEarned({ score, passed, isPerfect, isFirstPass }) {
  if (isFirstPass) {
    let xp = score * XP_PER_CORRECT;
    if (passed)    xp += XP_PASS_BONUS;
    if (isPerfect) xp += XP_PERFECT_BONUS;
    return xp;
  }
  // Retake: halved per-correct, no bonuses
  return Math.round(score * XP_PER_CORRECT * XP_RETAKE_MULTIPLIER);
}

// Returns only question text for a given (moduleId, questionId) pair.
function getQuestionText(moduleId, questionId) {
  return BANK.get(moduleId)?.find(q => q.id === questionId)?.question ?? null;
}

module.exports = {
  getQuestionsForModule,
  computeScore,
  computeMaxStreak,
  computeXpEarned,
  getQuestionText,
};
