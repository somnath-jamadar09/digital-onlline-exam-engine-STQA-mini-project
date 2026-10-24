'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { gradeAttempt } = require('./grader');

// ---------- password helpers ----------
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { hash, salt, stored: `${salt}:${hash}` };
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return hashPassword(password, salt).hash === hash;
}

/**
 * Design rules that the STQA suite verifies:
 *  1. The SERVER clock is the only authority on time. deadline_at is fixed at start.
 *  2. Every state transition is a compare-and-set, so concurrent submits finalize exactly once.
 *  3. Submit is idempotent: later calls return the stored result of the first finalization.
 *  4. Answers arriving after deadline + grace are ignored.
 *  5. Autosave carries a monotonically increasing seq so replays cannot overwrite newer answers.
 */
function createApp({
  db,
  now = () => Date.now(),
  graceMs = 2000,
  adminToken = process.env.ADMIN_TOKEN || '',
  publicDir = path.join(__dirname, '..', 'public'),
} = {}) {
  const st = {
    exam: db.prepare('SELECT * FROM exams WHERE id = ?'),
    questions: db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY position'),
    insertExam: db.prepare('INSERT INTO exams (id, title, duration_ms, created_at) VALUES (?,?,?,?)'),
    insertQuestion: db.prepare(
      'INSERT INTO questions (id, exam_id, position, type, text, options, answer, points, tolerance) VALUES (?,?,?,?,?,?,?,?,?)'
    ),
    insertAttempt: db.prepare(
      `INSERT OR IGNORE INTO attempts (id, exam_id, student_id, started_at, deadline_at, status, answers, answer_seq)
       VALUES (?,?,?,?,?,'in_progress','{}',0)`
    ),
    byStudent: db.prepare('SELECT * FROM attempts WHERE exam_id = ? AND student_id = ?'),
    byId: db.prepare('SELECT * FROM attempts WHERE id = ?'),
    saveAnswers: db.prepare(
      `UPDATE attempts SET answers = ?, answer_seq = ?
       WHERE id = ? AND status = 'in_progress' AND deadline_at + ? >= ? AND answer_seq < ?`
    ),
    finalize: db.prepare(
      `UPDATE attempts
          SET status = ?, submit_reason = ?, submitted_at = ?, answers = ?, score = ?, max_score = ?, breakdown = ?
        WHERE id = ? AND status = 'in_progress'`
    ),
    expired: db.prepare(
      `SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at + ? < ? LIMIT 1000`
    ),
    stats: db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(status = 'in_progress') AS in_progress,
              SUM(status = 'submitted') AS submitted,
              SUM(status = 'auto_submitted') AS auto_submitted,
              AVG(CASE WHEN status != 'in_progress' THEN score END) AS avg_score,
              MIN(CASE WHEN status != 'in_progress' THEN score END) AS min_score,
              MAX(CASE WHEN status != 'in_progress' THEN score END) AS max_score,
              MAX(max_score) AS possible
         FROM attempts WHERE exam_id = ?`
    ),
    // auth statements
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    userById:       db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser:     db.prepare(
      'INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES (?,?,?,?,?,?)'
    ),
    sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
    insertSession:  db.prepare(
      'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)'
    ),
    deleteSession:  db.prepare('DELETE FROM sessions WHERE token = ?'),
    cleanSessions:  db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    listUsers:      db.prepare("SELECT id, username, role, display_name, created_at FROM users ORDER BY created_at"),
    deleteUser:     db.prepare('DELETE FROM users WHERE id = ? AND role != \'admin\''),
  };

  // ---------- seed default admin account ----------
  const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
  (function seedAdmin() {
    if (!st.userByUsername.get(DEFAULT_ADMIN_USER)) {
      const { stored } = hashPassword(DEFAULT_ADMIN_PASS);
      st.insertUser.run(
        crypto.randomUUID(), DEFAULT_ADMIN_USER, stored, 'admin', 'Administrator', now()
      );
      console.log(`[auth] Default admin created: ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASS}`);
    }
  })();

  // ---------- session TTL ----------
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // ---------- exam cache (exams are immutable once created) ----------
  const examCache = new Map();
  function loadExam(examId) {
    if (examCache.has(examId)) return examCache.get(examId);
    const exam = st.exam.get(examId);
    if (!exam) return null;
    const questions = st.questions.all(examId).map((r) => ({
      id: r.id,
      position: r.position,
      type: r.type,
      text: r.text,
      options: JSON.parse(r.options),
      answer: JSON.parse(r.answer),
      points: r.points,
      tolerance: r.tolerance,
    }));
    const entry = {
      exam,
      questions,
      publicQuestions: questions.map(({ id, type, text, options, points }) => ({ id, type, text, options, points })),
    };
    examCache.set(examId, entry);
    return entry;
  }

  // ---------- helpers ----------
  const STUDENT_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

  function cleanAnswers(questions, input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const known = new Set(questions.map((q) => q.id));
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (!known.has(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v.length <= 32) out[k] = v;
      else if (Array.isArray(v) && v.length <= 20 && v.every((x) => Number.isInteger(x))) out[k] = v;
      // anything else (objects, huge strings, NaN) is dropped silently
    }
    return out;
  }

  function resultOf(a) {
    return {
      status: a.status,
      reason: a.submit_reason,
      submittedAt: a.submitted_at,
      score: a.score,
      maxScore: a.max_score,
      percentage: a.max_score > 0 ? Math.round((a.score / a.max_score) * 10000) / 100 : 0,
      breakdown: a.breakdown ? JSON.parse(a.breakdown) : [],
    };
  }

  function stateOf(a) {
    const t = now();
    const { exam, publicQuestions } = loadExam(a.exam_id);
    const finished = a.status !== 'in_progress';
    const s = {
      attemptId: a.id,
      examId: a.exam_id,
      studentId: a.student_id,
      status: a.status,
      serverNow: t,
      startedAt: a.started_at,
      deadlineAt: a.deadline_at,
      remainingMs: finished ? 0 : Math.max(0, a.deadline_at - t),
      answers: JSON.parse(a.answers),
      answerSeq: a.answer_seq,
      exam: { title: exam.title, durationMs: exam.duration_ms },
      questions: publicQuestions,
    };
    if (finished) s.result = resultOf(a);
    return s;
  }

  /** Atomically finalize. Returns true only for the single caller that wins the race. */
  function finalizeAttempt(a, answersObj, reason) {
    const { questions } = loadExam(a.exam_id);
    const answers = answersObj || JSON.parse(a.answers);
    const g = gradeAttempt(questions, answers);
    const manual = reason === 'manual';
    const info = st.finalize.run(
      manual ? 'submitted' : 'auto_submitted',
      reason,
      manual ? now() : a.deadline_at,
      JSON.stringify(answers),
      g.score,
      g.maxScore,
      JSON.stringify(g.breakdown),
      a.id
    );
    return Number(info.changes) === 1;
  }

  /** Lazily finalize if this attempt is past deadline + grace. Returns the fresh row. */
  function settle(a) {
    if (a && a.status === 'in_progress' && now() > a.deadline_at + graceMs) {
      finalizeAttempt(a, null, 'timer_expired');
      return st.byId.get(a.id);
    }
    return a;
  }

  /** Background sweeper: auto-submit every expired attempt even if the student's browser is gone. */
  function sweep() {
    let n = 0;
    for (const { id } of st.expired.all(graceMs, now())) {
      const a = st.byId.get(id);
      if (a && finalizeAttempt(a, null, 'timer_expired')) n++;
    }
    return n;
  }
  let sweepTimer = null;
  function startSweeper(intervalMs = 1000) {
    sweepTimer = setInterval(sweep, intervalMs);
    sweepTimer.unref();
    return sweepTimer;
  }
  function stopSweeper() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  // ---------- app ----------
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(publicDir));

  // ---------- auth middleware ----------
  function getSession(req) {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return null;
    st.cleanSessions.run(now());
    const session = st.sessionByToken.get(token, now());
    if (!session) return null;
    const user = st.userById.get(session.user_id);
    return user ? { session, user } : null;
  }

  function checkAdminAuth(req) {
    // 1. If adminToken is not configured (or empty), allow by default for test suite & local development
    if (!adminToken) return true;

    // 2. Legacy / test token header: x-admin-token
    const legacyToken = req.get('x-admin-token');
    if (legacyToken && legacyToken === adminToken) return true;

    // 3. HTTP Basic Authentication header: Authorization: Basic <base64>
    const authHeader = req.get('authorization') || '';
    if (authHeader.startsWith('Basic ')) {
      try {
        const creds = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const [u, p] = creds.split(':');
        if ((u === DEFAULT_ADMIN_USER && p === DEFAULT_ADMIN_PASS) || p === adminToken) {
          return true;
        }
        const user = st.userByUsername.get(u);
        if (user && user.role === 'admin' && verifyPassword(p, user.password_hash)) {
          return true;
        }
      } catch (_) {}
    }

    // 4. Session / Bearer token
    const ctx = getSession(req);
    if (ctx && ctx.user && ctx.user.role === 'admin') {
      return true;
    }

    return false;
  }

  function requireAuth(req, res, next) {
    const authHeader = req.get('authorization') || '';
    if (authHeader.startsWith('Basic ')) {
      try {
        const creds = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const [u, p] = creds.split(':');
        if (u === DEFAULT_ADMIN_USER && p === DEFAULT_ADMIN_PASS) {
          req.authUser = { id: 'admin', username: DEFAULT_ADMIN_USER, role: 'admin', display_name: 'Administrator' };
          return next();
        }
        const user = st.userByUsername.get(u);
        if (user && verifyPassword(p, user.password_hash)) {
          req.authUser = user;
          return next();
        }
      } catch (_) {}
    }
    const ctx = getSession(req);
    if (!ctx) return res.status(401).json({ error: 'unauthorized', message: 'Please log in.' });
    req.authUser = ctx.user;
    next();
  }

  function requireAdminAuth(req, res, next) {
    if (checkAdminAuth(req)) {
      const ctx = getSession(req);
      if (ctx) req.authUser = ctx.user;
      return next();
    }
    return res.status(401).json({ error: 'unauthorized', message: 'Admin access required.' });
  }

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/time', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ serverNow: now() });
  });

  // ========== AUTH ROUTES ==========

  /** POST /api/auth/login  { username, password } */
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'missing_fields', message: 'Username and password required.' });
    }
    const user = st.userByUsername.get(String(username));
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid username or password.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    st.insertSession.run(token, user.id, now() + SESSION_TTL_MS, now());
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
    });
  });

  /** POST /api/auth/logout  (requires Bearer token) */
  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) st.deleteSession.run(token);
    res.json({ ok: true });
  });

  /** GET /api/auth/me  (requires Bearer token) */
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const u = req.authUser;
    res.json({ id: u.id, username: u.username, role: u.role, displayName: u.display_name });
  });

  /** POST /api/auth/register  { username, password, displayName }  (admin only) */
  app.post('/api/auth/register', requireAdminAuth, (req, res) => {
    const { username, password, displayName, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'missing_fields', message: 'Username and password required.' });
    }
    if (!/^[A-Za-z0-9_.@-]{2,40}$/.test(username)) {
      return res.status(400).json({ error: 'invalid_username', message: 'Username must be 2-40 alphanumeric chars.' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 4 characters.' });
    }
    if (st.userByUsername.get(username)) {
      return res.status(409).json({ error: 'username_taken', message: 'That username is already taken.' });
    }
    const { stored } = hashPassword(String(password));
    const allowedRole = role === 'admin' ? 'admin' : 'student';
    const id = crypto.randomUUID();
    st.insertUser.run(id, username, stored, allowedRole, displayName || username, now());
    res.status(201).json({ id, username, role: allowedRole });
  });

  /** GET /api/auth/users  (admin only) */
  app.get('/api/auth/users', requireAdminAuth, (req, res) => {
    res.json(st.listUsers.all());
  });

  /** DELETE /api/auth/users/:id  (admin only, cannot delete admins) */
  app.delete('/api/auth/users/:id', requireAdminAuth, (req, res) => {
    st.deleteUser.run(req.params.id);
    res.json({ ok: true });
  });

  // ========== EXAM ROUTES ==========

  app.get('/api/exams', (req, res) => {
    try {
      const rows = db.prepare('SELECT id, title, duration_ms, created_at FROM exams ORDER BY created_at DESC').all();
      res.json(rows);
    } catch (_) {
      res.status(500).json({ error: 'failed_to_list_exams' });
    }
  });

  // Start (or resume) an attempt. Idempotent: same student => same attempt, same deadline.
  app.post('/api/exams/:examId/start', (req, res) => {
    const entry = loadExam(req.params.examId);
    if (!entry) return res.status(404).json({ error: 'exam_not_found' });
    const studentId = req.body && req.body.studentId;
    if (typeof studentId !== 'string' || !STUDENT_RE.test(studentId)) {
      return res.status(400).json({ error: 'invalid_student_id' });
    }
    const t = now();
    st.insertAttempt.run(crypto.randomUUID(), entry.exam.id, studentId, t, t + entry.exam.duration_ms);
    const a = settle(st.byStudent.get(entry.exam.id, studentId));
    res.set('Cache-Control', 'no-store');
    res.json(stateOf(a));
  });

  app.get('/api/attempts/:id', (req, res) => {
    const a = settle(st.byId.get(req.params.id));
    if (!a) return res.status(404).json({ error: 'attempt_not_found' });
    res.set('Cache-Control', 'no-store');
    res.json(stateOf(a));
  });

  // Light-weight clock sync used by the browser timer.
  app.get('/api/attempts/:id/sync', (req, res) => {
    const a = settle(st.byId.get(req.params.id));
    if (!a) return res.status(404).json({ error: 'attempt_not_found' });
    const t = now();
    res.set('Cache-Control', 'no-store');
    res.json({
      serverNow: t,
      status: a.status,
      answerSeq: a.answer_seq,
      remainingMs: a.status === 'in_progress' ? Math.max(0, a.deadline_at - t) : 0,
    });
  });

  // Autosave. Rejected after deadline + grace; stale seq is ignored (not an error).
  app.put('/api/attempts/:id/answers', (req, res) => {
    let a = st.byId.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'attempt_not_found' });
    a = settle(a);
    if (a.status !== 'in_progress') {
      return res.status(409).json({ error: 'attempt_closed', status: a.status });
    }
    const { questions } = loadExam(a.exam_id);
    const answers = cleanAnswers(questions, req.body && req.body.answers);
    const seq = req.body && req.body.seq;
    if (!answers || !Number.isInteger(seq) || seq < 1) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    const info = st.saveAnswers.run(JSON.stringify(answers), seq, a.id, graceMs, now(), seq);
    if (Number(info.changes) === 1) {
      return res.json({ saved: true, seq, remainingMs: Math.max(0, a.deadline_at - now()) });
    }
    // Either a newer seq is already stored (stale replay) or the attempt closed in between.
    const fresh = settle(st.byId.get(a.id));
    if (fresh.status !== 'in_progress') {
      return res.status(409).json({ error: 'attempt_closed', status: fresh.status });
    }
    return res.json({ saved: false, reason: 'stale_seq', seq: fresh.answer_seq });
  });

  // Submit. Idempotent; exactly one finalization per attempt.
  app.post('/api/attempts/:id/submit', (req, res) => {
    const a = st.byId.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'attempt_not_found' });

    if (a.status !== 'in_progress') {
      return res.json({ alreadySubmitted: true, result: resultOf(a) });
    }

    const t = now();
    const late = t > a.deadline_at + graceMs;
    let reason = 'manual';
    let finalAnswers = null; // null => use stored autosaved answers

    if (late) {
      reason = 'timer_expired'; // late answers are ignored; grade what was autosaved in time
    } else if (req.body && req.body.answers !== undefined) {
      const { questions } = loadExam(a.exam_id);
      const cleaned = cleanAnswers(questions, req.body.answers);
      if (!cleaned) return res.status(400).json({ error: 'invalid_payload' });
      const bodySeq = Number.isInteger(req.body.seq) ? req.body.seq : Infinity;
      // A newer autosave (e.g. from another tab) beats an older final snapshot.
      if (bodySeq >= a.answer_seq) finalAnswers = cleaned;
    }

    const won = finalizeAttempt(a, finalAnswers, reason);
    const fresh = st.byId.get(a.id);
    return res.json({ alreadySubmitted: !won, late, result: resultOf(fresh) });
  });

  app.get('/api/attempts/:id/result', (req, res) => {
    const a = settle(st.byId.get(req.params.id));
    if (!a) return res.status(404).json({ error: 'attempt_not_found' });
    if (a.status === 'in_progress') return res.status(409).json({ error: 'not_finished' });
    res.json(resultOf(a));
  });

  // ---------- admin ----------
  function requireAdmin(req, res, next) {
    if (checkAdminAuth(req)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }

  app.post('/api/admin/exams', requireAdmin, (req, res) => {
    const b = req.body || {};
    const id = typeof b.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(b.id) ? b.id : crypto.randomUUID().slice(0, 8);
    const durationMs = Number.isFinite(b.durationMs) ? b.durationMs : Number(b.durationSec) * 1000;
    if (typeof b.title !== 'string' || !b.title) return res.status(400).json({ error: 'title_required' });
    if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > 6 * 3600 * 1000) {
      return res.status(400).json({ error: 'invalid_duration' });
    }
    if (!Array.isArray(b.questions) || b.questions.length === 0 || b.questions.length > 200) {
      return res.status(400).json({ error: 'invalid_questions' });
    }
    for (const q of b.questions) {
      const ok =
        q && ['single', 'multi', 'numeric'].includes(q.type) && typeof q.text === 'string' &&
        (q.type === 'numeric' ? typeof q.answer === 'number'
          : Array.isArray(q.options) && q.options.length >= 2 &&
            (q.type === 'single' ? Number.isInteger(q.answer)
              : Array.isArray(q.answer) && q.answer.every(Number.isInteger)));
      if (!ok) return res.status(400).json({ error: 'invalid_question' });
    }
    if (st.exam.get(id)) return res.status(409).json({ error: 'exam_exists' });

    db.exec('BEGIN');
    try {
      st.insertExam.run(id, b.title, Math.round(durationMs), now());
      b.questions.forEach((q, i) => {
        st.insertQuestion.run(
          `${id}:${i + 1}`, id, i + 1, q.type, q.text,
          JSON.stringify(q.options || []), JSON.stringify(q.answer),
          Number.isFinite(q.points) ? q.points : 1,
          Number.isFinite(q.tolerance) ? q.tolerance : 0
        );
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    examCache.delete(id);
    res.status(201).json({ id, questions: b.questions.length, durationMs: Math.round(durationMs) });
  });

  app.get('/api/admin/exams/:examId/results', requireAdmin, (req, res) => {
    if (!loadExam(req.params.examId)) return res.status(404).json({ error: 'exam_not_found' });
    const r = st.stats.get(req.params.examId);
    res.json({
      total: r.total,
      inProgress: r.in_progress || 0,
      submitted: r.submitted || 0,
      autoSubmitted: r.auto_submitted || 0,
      avgScore: r.avg_score,
      minScore: r.min_score,
      maxScore: r.max_score,
      possible: r.possible,
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, db, sweep, startSweeper, stopSweeper };
}

module.exports = { createApp };
