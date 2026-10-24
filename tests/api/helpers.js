'use strict';
const { openDb } = require('../../server/db');
const { createApp } = require('../../server/app');
const { seedDemo } = require('../../server/seed');

/** Fake clock: tests move time explicitly, so expiry boundaries are exact and fast. */
function makeClock(start = 1_800_000_000_000) {
  const c = {
    t: start,
    now: () => c.t,
    advance(ms) { c.t += ms; return c.t; },
  };
  return c;
}

// Answer sets for the seeded "demo" exam (5 questions, 1 point each).
const FULL = { 'demo:1': 2, 'demo:2': 1, 'demo:3': [0, 2, 3], 'demo:4': 144, 'demo:5': 3.14 }; // 5/5
const WRONG = { 'demo:1': 0, 'demo:2': 3, 'demo:3': [0], 'demo:4': 145, 'demo:5': 3.2 };        // 0/5

async function boot(opts = {}) {
  const clock = opts.clock || makeClock();
  const db = opts.db || openDb(opts.dbPath || ':memory:');
  const engine = createApp({
    db,
    now: clock.now,
    graceMs: opts.graceMs === undefined ? 2000 : opts.graceMs,
    adminToken: opts.adminToken === undefined ? '' : opts.adminToken,
  });
  if (opts.seed !== false) seedDemo(db, { durationMs: opts.durationMs === undefined ? 60000 : opts.durationMs });

  const server = await new Promise((resolve) => {
    const s = engine.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const r = await fetch(base + path, init);
    let json = null;
    try { json = await r.json(); } catch (_) { /* empty */ }
    return { status: r.status, body: json };
  }

  const close = () => new Promise((resolve) => {
    engine.stopSweeper();
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });

  return {
    clock, db, engine, base, port, call, close,
    start: (sid, exam = 'demo') => call('POST', `/api/exams/${exam}/start`, { studentId: sid }),
    save: (id, seq, answers) => call('PUT', `/api/attempts/${id}/answers`, { seq, answers }),
    submit: (id, body = {}) => call('POST', `/api/attempts/${id}/submit`, body),
    state: (id) => call('GET', `/api/attempts/${id}`),
    result: (id) => call('GET', `/api/attempts/${id}/result`),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { boot, makeClock, FULL, WRONG, sleep };
