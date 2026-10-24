'use strict';
// Pure grading logic: no I/O, no clock. Safe to unit test in isolation.
//
// Question types
//   single  : answer is an option index; correct only on exact match
//   multi   : answer is an array of option indexes; all-or-nothing (set equality)
//   numeric : answer is a number; correct if |given - answer| <= tolerance
//
// Unanswered or malformed input scores 0 and never throws.

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

function gradeQuestion(q, given) {
  const max = q.points;
  if (given === undefined || given === null || given === '') {
    return { id: q.id, answered: false, correct: false, awarded: 0, max };
  }
  let correct = false;
  switch (q.type) {
    case 'single':
      correct = Number.isInteger(given) && given === q.answer;
      break;
    case 'multi': {
      if (!Array.isArray(given)) break;
      const a = new Set(given);
      const b = new Set(q.answer);
      correct = a.size === b.size && [...b].every((x) => a.has(x));
      break;
    }
    case 'numeric': {
      const n = toNumber(given);
      // The epsilon absorbs binary floating-point error: |3.13 - 3.14| is 0.010000000000000231,
      // which would wrongly fail a +/-0.01 tolerance. 1e-12 is far below any real tolerance.
      const eps = 1e-12 * Math.max(1, Math.abs(q.answer));
      correct = Number.isFinite(n) && Math.abs(n - q.answer) <= (q.tolerance || 0) + eps;
      break;
    }
    default:
      break;
  }
  return { id: q.id, answered: true, correct, awarded: correct ? max : 0, max };
}

function gradeAttempt(questions, answers) {
  const breakdown = questions.map((q) => gradeQuestion(q, answers ? answers[q.id] : undefined));
  const score = breakdown.reduce((s, b) => s + b.awarded, 0);
  const maxScore = breakdown.reduce((s, b) => s + b.max, 0);
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 10000) / 100 : 0;
  return {
    score,
    maxScore,
    percentage,
    answeredCount: breakdown.filter((b) => b.answered).length,
    breakdown,
  };
}

module.exports = { gradeQuestion, gradeAttempt };
