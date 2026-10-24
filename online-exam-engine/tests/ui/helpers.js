'use strict';
const { expect } = require('@playwright/test');

const crypto = require('node:crypto');

let counter = 0;
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

// Same shape as the demo exam: 5 questions, 1 point each.
const QUESTIONS = [
  { type: 'single', text: 'Which HTTP status code means "Conflict"?', options: ['400', '404', '409', '500'], answer: 2 },
  { type: 'single', text: 'Which clock should be the authority for an exam deadline?', options: ['Browser', 'Server', 'Wristwatch', 'Earlier one'], answer: 1 },
  { type: 'multi', text: 'Select ALL idempotent HTTP methods.', options: ['GET', 'POST', 'PUT', 'DELETE'], answer: [0, 2, 3] },
  { type: 'numeric', text: 'What is 12 x 12?', answer: 144 },
  { type: 'numeric', text: 'Pi to 2 decimals', answer: 3.14, tolerance: 0.01 },
];

async function createExam(request, durationSec) {
  const id = uid('ex');
  const r = await request.post('/api/admin/exams', {
    data: { id, title: `UI Test Exam (${durationSec}s)`, durationSec, questions: QUESTIONS },
  });
  expect(r.status()).toBe(201);
  return id;
}

/** Open the exam page, sign in as `studentId`, wait until the timer is running. */
async function startUI(page, examId, studentId, query = '') {
  await page.goto(`/?exam=${examId}&retry=500${query}`);
  await page.getByTestId('student-id').fill(studentId);
  await page.getByTestId('start-btn').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('timer')).toHaveAttribute('data-remaining-ms', /^\d+$/);
}

const uiRemaining = async (page) => Number(await page.getByTestId('timer').getAttribute('data-remaining-ms'));

/** The server's own view of this attempt (idempotent start returns current state). */
async function serverState(request, examId, studentId) {
  const r = await request.post(`/api/exams/${examId}/start`, { data: { studentId } });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function serverRemaining(request, attemptId) {
  const r = await request.get(`/api/attempts/${attemptId}/sync`);
  return (await r.json()).remainingMs;
}

/** Sample UI vs server remaining time at (nearly) the same instant. Returns signed drift in ms. */
async function sampleDrift(page, request, attemptId) {
  const [ui, server] = await Promise.all([uiRemaining(page), serverRemaining(request, attemptId)]);
  return { ui, server, drift: ui - server };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { uid, QUESTIONS, createExam, startUI, uiRemaining, serverState, serverRemaining, sampleDrift, wait };
