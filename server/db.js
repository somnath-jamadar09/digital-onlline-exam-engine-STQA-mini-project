'use strict';
// SQLite via Node's built-in node:sqlite (no native build step needed).
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exams (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id        TEXT PRIMARY KEY,
  exam_id   TEXT NOT NULL REFERENCES exams(id),
  position  INTEGER NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('single','multi','numeric')),
  text      TEXT NOT NULL,
  options   TEXT NOT NULL DEFAULT '[]',
  answer    TEXT NOT NULL,
  points    REAL NOT NULL DEFAULT 1,
  tolerance REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id, position);

CREATE TABLE IF NOT EXISTS attempts (
  id            TEXT PRIMARY KEY,
  exam_id       TEXT NOT NULL REFERENCES exams(id),
  student_id    TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('in_progress','submitted','auto_submitted')),
  answers       TEXT NOT NULL DEFAULT '{}',
  answer_seq    INTEGER NOT NULL DEFAULT 0,
  submit_reason TEXT,
  submitted_at  INTEGER,
  score         REAL,
  max_score     REAL,
  breakdown     TEXT,
  UNIQUE (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_open ON attempts(status, deadline_at);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin','student')),
  display_name TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
