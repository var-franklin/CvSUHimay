'use strict';

const pool = require('../db');

// Runs a single ALTER statement and swallows "Duplicate column/key" errors.
async function safeAlter(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    // 1060 = ER_DUP_FIELDNAME  (column already exists)
    // 1061 = ER_DUP_KEYNAME    (index already exists)
    if (err.errno !== 1060 && err.errno !== 1061) throw err;
  }
}

async function safeCreateIndex(table, indexName, definition) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
       AND INDEX_NAME   = ?`,
    [table, indexName]
  );
  if (Number(row.cnt) === 0) {
    await pool.query(`CREATE INDEX ${indexName} ON ${table} ${definition}`);
  }
}

// Creates a UNIQUE index only if it does not already exist.
async function safeCreateUniqueIndex(table, indexName, columns) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
       AND INDEX_NAME   = ?`,
    [table, indexName]
  );

  if (Number(row.cnt) > 0) return; 
  
  const colList = columns.replace(/^\(|\)$/g, '').trim();

  // Delete all but the highest-id row for every duplicate key group.
  await pool.query(`
    DELETE t1
    FROM ${table} t1
    INNER JOIN ${table} t2
      ON  ${colList.split(',').map(c => `t1.${c.trim()} <=> t2.${c.trim()}`).join('\n      AND ')}
      AND t1.id < t2.id
  `);

  // Now the data is clean — build the index.
  await pool.query(`CREATE UNIQUE INDEX ${indexName} ON ${table} ${columns}`);
}

async function ensureTables() {
  // ── Additive column migrations (idempotent — skipped if column already exists) ──

  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP NULL`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status ENUM('active','pending_approval','rejected','suspended') NOT NULL DEFAULT 'active'`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_role ENUM('student','instructor') NULL`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_decision_by INT NULL`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_decision_at TIMESTAMP NULL`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_rejection_reason TEXT NULL`);

  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_badges JSON DEFAULT NULL`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT UNSIGNED NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_password_changed_at TIMESTAMP NULL`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL`);
  await safeCreateIndex('users', 'idx_users_deleted_at', '(deleted_at)');

  await safeAlter(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS allow_reapply TINYINT(1) NOT NULL DEFAULT 1`);
  await safeAlter(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
  await safeAlter(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS code_name VARCHAR(32) NULL AFTER name`);

  await safeAlter(`ALTER TABLE course_enrollments ADD COLUMN IF NOT EXISTS rejection_reason TEXT DEFAULT NULL`);

  await safeAlter(`ALTER TABLE module_progress ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP NULL DEFAULT NULL`);

  await safeAlter(`ALTER TABLE attempts ADD COLUMN IF NOT EXISTS course_id INT NULL`);

  await safeAlter(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS course_id INT NULL`);
  await safeAlter(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS max_streak INT NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS completed_in_time TINYINT(1) NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS xp_earned INT NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS is_first_pass TINYINT(1) NOT NULL DEFAULT 0`);
  await safeAlter(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS server_time_spent INT NOT NULL DEFAULT 0`);
  await safeCreateIndex('quiz_attempts', 'idx_course_created', '(course_id, created_at DESC)');

  // ── Simulation analytics tables ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      attempt_id INT NOT NULL,
      user_id INT NOT NULL,
      course_id INT NULL,
      attempt_number INT NOT NULL DEFAULT 1,
      raw_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      score_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      grade VARCHAR(2) NULL,
      passed TINYINT(1) NOT NULL DEFAULT 0,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      duration_seconds INT NOT NULL DEFAULT 0,
      total_errors INT NOT NULL DEFAULT 0,
      hints_used INT NOT NULL DEFAULT 0,
      steps_completed INT NOT NULL DEFAULT 0,
      wash_quality_percent INT NOT NULL DEFAULT 0,
      bones_total INT NOT NULL DEFAULT 0,
      scoring_version VARCHAR(8) NOT NULL DEFAULT 'v2',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_id (user_id),
      INDEX idx_attempt_id (attempt_id),
      INDEX idx_course_id (course_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  {
    const [[{ cnt: hasNewCol }]] = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'sim_step_results'
        AND COLUMN_NAME  = 'sim_attempt_id'
    `);
    if (Number(hasNewCol) === 0) {
      await pool.query(`DROP TABLE IF EXISTS sim_step_results`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sim_step_results (
          id INT AUTO_INCREMENT PRIMARY KEY,
          sim_attempt_id INT NOT NULL,
          step_id INT NOT NULL,
          step_key VARCHAR(64) NOT NULL DEFAULT '',
          score_weight INT NOT NULL DEFAULT 0,
          earned_score DECIMAL(6,2) NOT NULL DEFAULT 0,
          accuracy_factor DECIMAL(6,3) NOT NULL DEFAULT 0,
          efficiency_factor DECIMAL(6,3) NOT NULL DEFAULT 0,
          quality_factor DECIMAL(6,3) NOT NULL DEFAULT 0,
          error_count INT NOT NULL DEFAULT 0,
          correct_actions INT NOT NULL DEFAULT 0,
          time_spent_seconds INT NOT NULL DEFAULT 0,
          completed TINYINT(1) NOT NULL DEFAULT 0,
          hint_level TINYINT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (sim_attempt_id) REFERENCES sim_attempts(id) ON DELETE CASCADE,
          INDEX idx_sim_attempt_step (sim_attempt_id, step_id),
          INDEX idx_step (step_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
  }

  // sim_error_log: one row per error event per step.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_error_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sim_attempt_id INT NOT NULL,
      step_id INT NOT NULL,
      error_class VARCHAR(64) NOT NULL,
      severity ENUM('minor','major','critical') NOT NULL DEFAULT 'major',
      tool_active VARCHAR(64) NULL,
      client_timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sim_attempt_id) REFERENCES sim_attempts(id) ON DELETE CASCADE,
      INDEX idx_sim_attempt (sim_attempt_id),
      INDEX idx_step_class (step_id, error_class)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // sim_bone_counts: bone extraction totals per sim_attempt.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_bone_counts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sim_attempt_id INT NOT NULL,
      rib INT NOT NULL DEFAULT 0,
      dorsal INT NOT NULL DEFAULT 0,
      ventral INT NOT NULL DEFAULT 0,
      lateral INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sim_attempt_id) REFERENCES sim_attempts(id) ON DELETE CASCADE,
      UNIQUE KEY uq_sim_attempt (sim_attempt_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // rib column added for step-6 (Rib Bones) tracking
  await safeAlter(`ALTER TABLE sim_bone_counts ADD COLUMN IF NOT EXISTS rib INT NOT NULL DEFAULT 0 AFTER sim_attempt_id`);
  await safeAlter(`ALTER TABLE sim_bone_counts DROP COLUMN IF EXISTS rib_target`);
  await safeAlter(`ALTER TABLE sim_bone_counts DROP COLUMN IF EXISTS dorsal_target`);
  await safeAlter(`ALTER TABLE sim_bone_counts DROP COLUMN IF EXISTS ventral_target`);
  await safeAlter(`ALTER TABLE sim_bone_counts DROP COLUMN IF EXISTS lateral_target`);

  // sim_tool_usage: aggregated tool-selection stats per step per sim_attempt.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_tool_usage (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sim_attempt_id INT NOT NULL,
      step_id INT NOT NULL,
      tool_name VARCHAR(64) NOT NULL,
      selection_count INT NOT NULL DEFAULT 0,
      active_seconds INT NOT NULL DEFAULT 0,
      wrong_tool_triggers INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sim_attempt_id) REFERENCES sim_attempts(id) ON DELETE CASCADE,
      UNIQUE KEY uq_attempt_step_tool (sim_attempt_id, step_id, tool_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // sim_event_log: append-only FSM event stream per sim_attempt.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_event_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sim_attempt_id INT NOT NULL,
      step_id INT NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      payload JSON NULL,
      geometric_trace JSON NULL,
      client_timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sim_attempt_id) REFERENCES sim_attempts(id) ON DELETE CASCADE,
      INDEX idx_sim_attempt (sim_attempt_id),
      INDEX idx_step_event (step_id, event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // sim_mastery: running per-step mastery score per student.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_mastery (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      step_id INT NOT NULL,
      mastery_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      attempts_count INT NOT NULL DEFAULT 0,
      best_accuracy DECIMAL(6,3) NOT NULL DEFAULT 0,
      avg_accuracy DECIMAL(6,3) NOT NULL DEFAULT 0,
      avg_time_seconds INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_user_step (user_id, step_id),
      INDEX idx_step (step_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeCreateIndex('sim_attempts', 'idx_sim_attempts_course_completed', '(course_id, completed)');

  await safeCreateIndex('sim_error_log', 'idx_sim_error_log_attempt', '(sim_attempt_id)');

  await safeCreateIndex('sim_attempts', 'idx_sim_attempts_user_course', '(user_id, course_id)');

  await safeCreateIndex('sim_step_results', 'idx_sim_step_results_attempt', '(sim_attempt_id)');

  await pool.query('ALTER TABLE sim_attempts DROP INDEX uq_sim_attempt_user_number').catch(() => {});
  await safeCreateUniqueIndex('sim_attempts', 'uq_sim_attempt_user_course_number', '(user_id, course_id, attempt_number)');

  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 0`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_date DATE DEFAULT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_attempt_answers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      attempt_id INT NOT NULL,
      question_index INT NOT NULL,
      question_id INT NOT NULL,
      picked_option CHAR(1) NULL,
      correct_option CHAR(1) NOT NULL,
      is_correct TINYINT(1) NOT NULL,
      time_spent_ms INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (attempt_id) REFERENCES quiz_attempts(id) ON DELETE CASCADE,
      INDEX idx_attempt (attempt_id),
      INDEX idx_question (question_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      module_id INT NOT NULL,
      question_ids JSON NOT NULL,
      shuffled_data JSON NOT NULL,
      answered_indices JSON NULL DEFAULT NULL,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_user_module (user_id, module_id),
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeAlter(`ALTER TABLE quiz_sessions MODIFY COLUMN expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  await safeAlter(`ALTER TABLE quiz_sessions ADD COLUMN IF NOT EXISTS answered_indices JSON NULL DEFAULT NULL`);

  await safeAlter(`ALTER TABLE quiz_sessions ADD COLUMN IF NOT EXISTS session_token CHAR(32) NULL DEFAULT NULL`);

  await safeCreateUniqueIndex('quiz_sessions', 'uq_user_module', '(user_id, module_id)');

  // Unique index for notification deduplication.
  const [[_dedupTitleCol]] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = 'notifications'
       AND INDEX_NAME   = 'uq_notif_dedup'
       AND COLUMN_NAME  = 'title'`
  );
  if (Number(_dedupTitleCol.cnt) === 0) {
    await pool.query('ALTER TABLE notifications DROP INDEX uq_notif_dedup').catch(() => {});
  }
  await safeCreateUniqueIndex('notifications', 'uq_notif_dedup', '(user_id, type, title, link)');

  const [[sidColRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'student_id'`
  );
  if (Number(sidColRow.cnt) > 0) {
    const [[sidIdxRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_student_id'`
    );
    if (Number(sidIdxRow.cnt) === 0) {
      await pool.query(`
        DELETE t1 FROM users t1
        INNER JOIN users t2
          ON t1.student_id = t2.student_id
         AND t1.id < t2.id
        WHERE t1.student_id IS NOT NULL
      `);
      await pool.query(`CREATE UNIQUE INDEX uq_student_id ON users (student_id)`);
    }
  }

  // ── XP Audit Trail table ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      amount INT NOT NULL,
      source ENUM('quiz','achievement','simulation','manual') NOT NULL DEFAULT 'manual',
      reference_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_created (user_id, created_at DESC),
      INDEX idx_source (source)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeAlter(`ALTER TABLE xp_events MODIFY COLUMN source ENUM('quiz','achievement','simulation','manual') NOT NULL DEFAULT 'manual'`);

  await safeCreateIndex('users', 'idx_users_role_xp', '(role, xp_points DESC)');
  await safeCreateIndex('users', 'idx_users_leaderboard', '(role, deleted_at, xp_points)');

  // ── New feature tables (sessions, settings, account export) ───────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      device VARCHAR(255) NULL,
      user_agent TEXT NULL,
      ip VARCHAR(45) NULL,
      last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INT PRIMARY KEY,
      settings JSON NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_exports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      status ENUM('pending','processing','ready','failed') NOT NULL DEFAULT 'pending',
      download_url VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── Activity logs (admin action audit trail) ──────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      admin_id    INT UNSIGNED NOT NULL,
      admin_name  VARCHAR(255) NOT NULL,
      action      VARCHAR(64)  NOT NULL,
      target_id   INT UNSIGNED NULL,
      target_name VARCHAR(255) NULL,
      details     JSON         NULL,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_admin_id   (admin_id),
      INDEX idx_action     (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── Admin seed (only when the users table is empty = brand-new database) ──
  const [[{ cnt }]] = await pool.query('SELECT COUNT(*) AS cnt FROM users');
  if (Number(cnt) === 0) {
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('Admin@1234', 10);
    await pool.query(
      `INSERT INTO users
         (email, password_hash, role, full_name, auth_provider,
          account_status, must_change_password)
       VALUES (?, ?, 'admin', 'System Admin', 'local', 'active', 1)`,
      ['admin@cvsuhimay.edu.ph', hash]
    );
    console.log('✓ Default admin seeded (email: admin@cvsuhimay.edu.ph — change password on first login)');
  }

  // Create student_profiles if absent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_profiles (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      user_id          INT NOT NULL,
      student_id       VARCHAR(50) NULL,
      department       VARCHAR(100) NULL,
      year_level       VARCHAR(20) NULL,
      experience_level ENUM('beginner','some','intermediate','advanced') DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_user (user_id),
      UNIQUE KEY uq_student_id (student_id),
      INDEX idx_department (department)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // If student_id still exists on users, migrate data then drop the 7 columns.
  const [[{ hasStudentId }]] = await pool.query(`
    SELECT COUNT(*) AS hasStudentId
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'student_id'
  `);

  if (Number(hasStudentId) > 0) {
    const migConn = await pool.getConnection();
    try {
      await migConn.beginTransaction();

      await migConn.query(`
        INSERT IGNORE INTO student_profiles (user_id, student_id, department, year_level, experience_level)
        SELECT id, student_id, department, year_level, experience_level
          FROM users
         WHERE role = 'student'
           AND deleted_at IS NULL
      `);

      await migConn.commit();
    } catch (err) {
      await migConn.rollback();
      throw err;
    } finally {
      migConn.release();
    }

    await pool.query(`
      ALTER TABLE users
        DROP COLUMN student_id,
        DROP COLUMN department,
        DROP COLUMN year_level,
        DROP COLUMN experience_level,
        DROP COLUMN specialization,
        DROP COLUMN office_location,
        DROP COLUMN office_hours
    `);
  }

  const [[{ gradeIsGenerated }]] = await pool.query(`
    SELECT COUNT(*) AS gradeIsGenerated
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'sim_attempts'
      AND COLUMN_NAME  = 'grade'
      AND EXTRA LIKE '%GENERATED%'
  `);

  if (Number(gradeIsGenerated) === 0) {
    await pool.query(`
      ALTER TABLE sim_attempts
        DROP COLUMN IF EXISTS grade,
        ADD COLUMN grade VARCHAR(2) AS (
          CASE
            WHEN score_percent >= 90 THEN 'A'
            WHEN score_percent >= 80 THEN 'B'
            WHEN score_percent >= 70 THEN 'C'
            WHEN score_percent >= 60 THEN 'D'
            ELSE 'F'
          END
        ) STORED
    `);
  }

  const [[{ isStored }]] = await pool.query(`
    SELECT COUNT(*) AS isStored
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'module_progress'
      AND COLUMN_NAME  = 'completed'
      AND EXTRA NOT LIKE '%GENERATED%'
  `);

  if (Number(isStored) > 0) {
    const [[{ idxExists }]] = await pool.query(`
      SELECT COUNT(*) AS idxExists FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'module_progress' AND INDEX_NAME = 'idx_user_completed'
    `);
    if (Number(idxExists) > 0) {
      await pool.query(`ALTER TABLE module_progress DROP INDEX idx_user_completed`);
    }
    await pool.query(`
      ALTER TABLE module_progress
        DROP COLUMN completed,
        ADD COLUMN completed TINYINT(1) GENERATED ALWAYS AS (completed_at IS NOT NULL) VIRTUAL
    `);
    await safeCreateIndex('module_progress', 'idx_user_completed', '(user_id, completed)');
  }

  console.log('✓ Migrations applied');
}

module.exports = { ensureTables };

module.exports.initializeAdmin = async function initializeAdmin() {};
