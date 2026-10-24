'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradeQuestion, gradeAttempt } = require('../../server/grader');

const single = { id: 's', type: 'single', answer: 2, points: 1 };
const multi = { id: 'm', type: 'multi', answer: [0, 2, 3], points: 2 };
const numeric = { id: 'n', type: 'numeric', answer: 3.14, tolerance: 0.01, points: 1 };

test('GR-01: single choice, exact match only', () => {
  assert.equal(gradeQuestion(single, 2).correct, true);
  assert.equal(gradeQuestion(single, 1).correct, false);
  assert.equal(gradeQuestion(single, '2').correct, false, 'string "2" is not the integer index');
  assert.equal(gradeQuestion(single, 2.0).correct, true);
  assert.equal(gradeQuestion(single, 2.5).correct, false);
});

test('GR-02: multi select is all-or-nothing, order and duplicates irrelevant', () => {
  assert.equal(gradeQuestion(multi, [3, 0, 2]).correct, true);
  assert.equal(gradeQuestion(multi, [0, 2, 3, 3]).correct, true, 'duplicates collapse');
  assert.equal(gradeQuestion(multi, [0, 2]).correct, false, 'missing one');
  assert.equal(gradeQuestion(multi, [0, 1, 2, 3]).correct, false, 'extra one');
  assert.equal(gradeQuestion(multi, []).correct, false, 'empty selection');
  assert.equal(gradeQuestion(multi, 0).correct, false, 'non-array');
  assert.equal(gradeQuestion(multi, [0, 2, 3]).awarded, 2, 'awards full points value');
});

test('GR-03: numeric tolerance boundaries', () => {
  assert.equal(gradeQuestion(numeric, 3.14).correct, true);
  assert.equal(gradeQuestion(numeric, 3.15).correct, true, 'on the upper boundary');
  assert.equal(gradeQuestion(numeric, 3.13).correct, true, 'on the lower boundary');
  assert.equal(gradeQuestion(numeric, 3.151).correct, false);
  assert.equal(gradeQuestion(numeric, 3.129).correct, false);
  assert.equal(gradeQuestion(numeric, '3.14').correct, true, 'numeric string accepted');
  assert.equal(gradeQuestion({ ...numeric, tolerance: 0, answer: 144 }, 144.0000001).correct, false, 'zero tolerance is exact');
});

test('GR-04: malformed, hostile and missing input scores 0 and never throws', () => {
  const junk = [undefined, null, '', NaN, Infinity, {}, [], [[]], 'abc', true, { a: 1 }, () => 1, Symbol.iterator];
  for (const q of [single, multi, numeric]) {
    for (const j of junk) {
      assert.doesNotThrow(() => gradeQuestion(q, j), `${q.type} with ${String(j)}`);
      assert.equal(gradeQuestion(q, j).awarded, 0, `${q.type} with ${String(j)}`);
    }
  }
  assert.equal(gradeQuestion(single, undefined).answered, false);
  assert.equal(gradeQuestion(single, 0).answered, true, 'index 0 is an answer, not "blank"');
});

test('GR-05: attempt total, percentage rounding and breakdown', () => {
  const qs = [single, multi, numeric];
  const g = gradeAttempt(qs, { s: 2, m: [0, 2, 3], n: 9 });
  assert.equal(g.score, 3);
  assert.equal(g.maxScore, 4);
  assert.equal(g.percentage, 75);
  assert.equal(g.answeredCount, 3);
  assert.deepEqual(g.breakdown.map((b) => b.correct), [true, true, false]);

  const third = gradeAttempt([single, { ...single, id: 's2' }, { ...single, id: 's3' }], { s: 2 });
  assert.equal(third.percentage, 33.33, 'rounded to 2 decimals');
});

test('GR-06: empty answers, null answers and zero-question exam', () => {
  assert.equal(gradeAttempt([single, multi], {}).score, 0);
  assert.equal(gradeAttempt([single, multi], null).score, 0);
  const g = gradeAttempt([], {});
  assert.equal(g.maxScore, 0);
  assert.equal(g.percentage, 0, 'no division by zero');
});
