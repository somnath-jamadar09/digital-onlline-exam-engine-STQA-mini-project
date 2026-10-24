'use strict';
// Demo exam used by the UI and by the Playwright tests.
// Exam id "demo": 10 minutes, 5 questions, 5 points total.
const DEMO_QUESTIONS = [
  { type: 'single', text: 'Which HTTP status code means "Conflict"?', options: ['400', '404', '409', '500'], answer: 2 },
  { type: 'single', text: 'Which clock should be the authority for an exam deadline?', options: ['Student browser', 'Server', 'Proctor wristwatch', 'Whichever is earlier'], answer: 1 },
  { type: 'multi', text: 'Select ALL idempotent HTTP methods.', options: ['GET', 'POST', 'PUT', 'DELETE'], answer: [0, 2, 3] },
  { type: 'numeric', text: 'What is 12 x 12?', answer: 144 },
  { type: 'numeric', text: 'Value of pi to 2 decimals (accept +/- 0.01).', answer: 3.14, tolerance: 0.01 },
];

function seedDemo(db, { id = 'demo', title = 'Software Testing Fundamentals', durationMs = 10 * 60 * 1000 } = {}) {
  if (db.prepare('SELECT 1 FROM exams WHERE id = ?').get(id)) return id;
  db.exec('BEGIN');
  db.prepare('INSERT INTO exams (id, title, duration_ms, created_at) VALUES (?,?,?,?)').run(id, title, durationMs, Date.now());
  const ins = db.prepare(
    'INSERT INTO questions (id, exam_id, position, type, text, options, answer, points, tolerance) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  DEMO_QUESTIONS.forEach((q, i) => {
    ins.run(`${id}:${i + 1}`, id, i + 1, q.type, q.text, JSON.stringify(q.options || []), JSON.stringify(q.answer), 1, q.tolerance || 0);
  });
  db.exec('COMMIT');
  return id;
}

module.exports = { seedDemo, DEMO_QUESTIONS };
