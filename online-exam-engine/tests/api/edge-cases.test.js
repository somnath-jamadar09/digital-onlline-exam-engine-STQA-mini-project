'use strict';
/*
 * STQA edge-condition suite.
 *   TE-*  timer expiry          ND-*  network disconnect / retry / resume
 *   CS-*  concurrent submission VA-*  input validation & hostile input
 *   RT-*  real-clock sweeper
 * A fake clock drives the deterministic cases, so boundaries are tested to the millisecond.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { boot, makeClock, FULL, WRONG, sleep } = require('./helpers');
const { openDb } = require('../../server/db');
const { seedDemo } = require('../../server/seed');

const DURATION = 60000;
const GRACE = 2000;

async function started(ctx, sid) {
  const r = await ctx.start(sid);
  assert.equal(r.status, 200);
  return r.body;
}

// ============================================================ TIMER EXPIRY
describe('Timer expiry', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => ctx.close());
  const sid = (() => { let i = 0; return (p) => `${p}-${++i}`; })();

  test('TE-01: submit exactly at the deadline is accepted as a normal submission', async () => {
    const a = await started(ctx, sid('te01'));
    ctx.clock.advance(DURATION);
    const r = await ctx.submit(a.attemptId, { seq: 1, answers: FULL });
    assert.equal(r.body.late, false);
    assert.equal(r.body.result.status, 'submitted');
    assert.equal(r.body.result.reason, 'manual');
    assert.equal(r.body.result.score, 5);
  });

  test('TE-02: submit at deadline + grace (inclusive boundary) still counts the final answers', async () => {
    const a = await started(ctx, sid('te02'));
    ctx.clock.advance(DURATION + GRACE);
    const r = await ctx.submit(a.attemptId, { seq: 1, answers: FULL });
    assert.equal(r.body.late, false);
    assert.equal(r.body.result.score, 5);
  });

  test('TE-03: submit 1 ms after grace ignores late answers and grades the autosaved ones', async () => {
    const a = await started(ctx, sid('te03'));
    await ctx.save(a.attemptId, 1, { 'demo:1': 2 });          // saved in time: 1 correct
    ctx.clock.advance(DURATION + GRACE + 1);
    const r = await ctx.submit(a.attemptId, { seq: 2, answers: FULL }); // too late to count
    assert.equal(r.body.late, true);
    assert.equal(r.body.result.status, 'auto_submitted');
    assert.equal(r.body.result.reason, 'timer_expired');
    assert.equal(r.body.result.score, 1, 'only the in-time autosave is graded');
    assert.equal(r.body.result.submittedAt, a.deadlineAt, 'recorded at the deadline, not at arrival');
  });

  test('TE-04: autosave after expiry is rejected with 409 and cannot change the result', async () => {
    const a = await started(ctx, sid('te04'));
    await ctx.save(a.attemptId, 1, { 'demo:1': 2 });
    ctx.clock.advance(DURATION + GRACE + 1);
    const put = await ctx.save(a.attemptId, 2, FULL);
    assert.equal(put.status, 409);
    assert.equal(put.body.error, 'attempt_closed');
    const res = await ctx.result(a.attemptId);
    assert.equal(res.body.score, 1);
  });

  test('TE-05: autosave inside the grace window is accepted', async () => {
    const a = await started(ctx, sid('te05'));
    ctx.clock.advance(DURATION + 1000);
    const put = await ctx.save(a.attemptId, 1, { 'demo:1': 2 });
    assert.equal(put.status, 200);
    assert.equal(put.body.saved, true);
    assert.equal(put.body.remainingMs, 0, 'remaining never goes negative');
  });

  test('TE-06: sweeper auto-submits an abandoned attempt (no client involved)', async () => {
    const a = await started(ctx, sid('te06'));
    await ctx.save(a.attemptId, 2, { 'demo:1': 2, 'demo:2': 1 });
    ctx.clock.advance(DURATION + GRACE + 1);
    ctx.engine.sweep();
    const res = await ctx.result(a.attemptId);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'auto_submitted');
    assert.equal(res.body.score, 2);
  });

  test('TE-07: sweeper boundary: not expired at exactly deadline + grace, expired 1 ms later', async () => {
    const c = await boot();
    try {
      const a = await started(c, 'te07');
      c.clock.advance(DURATION + GRACE);
      assert.equal(c.engine.sweep(), 0);
      assert.equal((await c.state(a.attemptId)).body.status, 'in_progress');
      c.clock.advance(1);
      assert.equal(c.engine.sweep(), 1);
      assert.equal(c.engine.sweep(), 0, 'second sweep finds nothing: no double finalization');
    } finally { await c.close(); }
  });

  test('TE-08: re-opening an expired attempt shows the finished result, never a fresh timer', async () => {
    const a = await started(ctx, sid('te08'));
    ctx.clock.advance(DURATION + GRACE + 5000);
    const again = await ctx.start(a.studentId);
    assert.equal(again.body.attemptId, a.attemptId);
    assert.equal(again.body.status, 'auto_submitted');
    assert.equal(again.body.remainingMs, 0);
    assert.ok(again.body.result);
  });

  test('TE-09: the deadline is immutable; re-start and refresh never extend it', async () => {
    const a = await started(ctx, sid('te09'));
    ctx.clock.advance(10000);
    const again = (await ctx.start(a.studentId)).body;
    assert.equal(again.attemptId, a.attemptId);
    assert.equal(again.deadlineAt, a.deadlineAt);
    assert.equal(again.remainingMs, DURATION - 10000);
    ctx.clock.advance(5000);
    const sync = await ctx.call('GET', `/api/attempts/${a.attemptId}/sync`);
    assert.equal(sync.body.remainingMs, DURATION - 15000, 'remaining is monotonic non-increasing');
  });

  test('TE-10: client-supplied timestamps are ignored (client clock cannot move the deadline)', async () => {
    const r = await ctx.call('POST', '/api/exams/demo/start', {
      studentId: sid('te10'), startedAt: 1, deadlineAt: 9_999_999_999_999, now: 0, remainingMs: 10 ** 9,
    });
    assert.equal(r.body.deadlineAt - r.body.startedAt, DURATION);
    assert.equal(r.body.startedAt, ctx.clock.t);
    const sub = await ctx.call('POST', `/api/attempts/${r.body.attemptId}/submit`, { answers: FULL, clientTime: 1 });
    assert.equal(sub.body.late, false);
  });

  test('TE-11: attempt that expires with zero answers still compiles a result (0 / max)', async () => {
    const a = await started(ctx, sid('te11'));
    ctx.clock.advance(DURATION + GRACE + 1);
    const res = await ctx.result(a.attemptId);
    assert.equal(res.status, 200);
    assert.equal(res.body.score, 0);
    assert.equal(res.body.maxScore, 5);
    assert.equal(res.body.percentage, 0);
    assert.equal(res.body.breakdown.length, 5);
    assert.ok(res.body.breakdown.every((b) => b.answered === false));
  });

  test('TE-12: result of an unfinished attempt is withheld (409), then available after submit', async () => {
    const a = await started(ctx, sid('te12'));
    assert.equal((await ctx.result(a.attemptId)).status, 409);
    await ctx.submit(a.attemptId, { answers: FULL, seq: 1 });
    assert.equal((await ctx.result(a.attemptId)).status, 200);
  });
});

// ============================================================ NETWORK DISCONNECTS
describe('Network disconnects, retries and resume', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => ctx.close());
  const sid = (() => { let i = 0; return (p) => `${p}-${++i}`; })();

  test('ND-01: resume after a disconnect restores answers, seq and the remaining time', async () => {
    const a = await started(ctx, sid('nd01'));
    await ctx.save(a.attemptId, 1, { 'demo:1': 2 });
    ctx.clock.advance(5000); // student is offline for 5 s
    const back = (await ctx.start(a.studentId)).body;
    assert.equal(back.attemptId, a.attemptId);
    assert.deepEqual(back.answers, { 'demo:1': 2 });
    assert.equal(back.answerSeq, 1);
    assert.equal(back.remainingMs, DURATION - 5000, 'the clock kept running while offline');
  });

  test('ND-02: a stale (replayed) autosave cannot overwrite newer answers', async () => {
    const a = await started(ctx, sid('nd02'));
    await ctx.save(a.attemptId, 5, { 'demo:1': 2 });
    const stale = await ctx.save(a.attemptId, 3, { 'demo:1': 0 });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.saved, false);
    assert.equal(stale.body.reason, 'stale_seq');
    assert.deepEqual((await ctx.state(a.attemptId)).body.answers, { 'demo:1': 2 });
  });

  test('ND-03: out-of-order arrival (seq 3 before seq 2) keeps the newest; later seq still accepted', async () => {
    const a = await started(ctx, sid('nd03'));
    await ctx.save(a.attemptId, 3, { 'demo:1': 2, 'demo:2': 1 });
    const late = await ctx.save(a.attemptId, 2, { 'demo:1': 2 });
    assert.equal(late.body.saved, false);
    const next = await ctx.save(a.attemptId, 4, { 'demo:1': 2, 'demo:2': 1, 'demo:4': 144 });
    assert.equal(next.body.saved, true);
    assert.equal(Object.keys((await ctx.state(a.attemptId)).body.answers).length, 3);
  });

  test('ND-04: duplicate autosave with the same seq is harmless', async () => {
    const a = await started(ctx, sid('nd04'));
    const first = await ctx.save(a.attemptId, 2, { 'demo:1': 2 });
    const dup = await ctx.save(a.attemptId, 2, { 'demo:1': 2 });
    assert.equal(first.body.saved, true);
    assert.equal(dup.status, 200);
    assert.equal(dup.body.saved, false);
    assert.deepEqual((await ctx.state(a.attemptId)).body.answers, { 'demo:1': 2 });
  });

  test('ND-05: submit retried after a lost response is idempotent (same score and timestamp)', async () => {
    const a = await started(ctx, sid('nd05'));
    const first = await ctx.submit(a.attemptId, { seq: 1, answers: FULL });
    ctx.clock.advance(3000);
    const retry = await ctx.submit(a.attemptId, { seq: 1, answers: FULL });
    const retry2 = await ctx.submit(a.attemptId, { seq: 9, answers: WRONG });
    assert.equal(first.body.alreadySubmitted, false);
    assert.equal(retry.body.alreadySubmitted, true);
    assert.equal(retry2.body.alreadySubmitted, true);
    assert.deepEqual(retry.body.result, first.body.result);
    assert.deepEqual(retry2.body.result, first.body.result, 'a later, different payload cannot rewrite the result');
    assert.equal(retry.body.result.score, 5);
  });

  test('ND-06: a stale final snapshot loses to a newer autosave; a newer snapshot wins', async () => {
    const a = await started(ctx, sid('nd06a'));
    await ctx.save(a.attemptId, 10, { 'demo:1': 2, 'demo:2': 1 }); // e.g. from a second tab
    const r1 = await ctx.submit(a.attemptId, { seq: 3, answers: {} });
    assert.equal(r1.body.result.score, 2, 'stored (newer) answers were graded');

    const b = await started(ctx, sid('nd06b'));
    await ctx.save(b.attemptId, 10, { 'demo:1': 2 });
    const r2 = await ctx.submit(b.attemptId, { seq: 11, answers: FULL });
    assert.equal(r2.body.result.score, 5, 'newer final snapshot wins');
  });

  test('ND-07: malformed / truncated JSON gives 400, not 500, and leaves the attempt intact', async () => {
    const a = await started(ctx, sid('nd07'));
    await ctx.save(a.attemptId, 1, { 'demo:1': 2 });
    const bad = await ctx.call('PUT', `/api/attempts/${a.attemptId}/answers`, '{"seq":2,"answers":{"demo:1":');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_json');
    const sub = await ctx.call('POST', `/api/attempts/${a.attemptId}/submit`, '{{{');
    assert.equal(sub.status, 400);
    const st = (await ctx.state(a.attemptId)).body;
    assert.equal(st.status, 'in_progress');
    assert.deepEqual(st.answers, { 'demo:1': 2 });
  });

  test('ND-08: connection dropped mid-request leaves state untouched and the server healthy', async () => {
    const a = await started(ctx, sid('nd08'));
    await new Promise((resolve) => {
      const s = net.connect(ctx.port, '127.0.0.1', () => {
        s.write(
          `PUT /api/attempts/${a.attemptId}/answers HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
          'Content-Length: 500\r\n\r\n{"seq":9,"answers":{"demo:1":'
        );
        setTimeout(() => { s.destroy(); resolve(); }, 60); // cable pulled
      });
      s.on('error', () => {});
    });
    await sleep(50);
    assert.equal((await ctx.call('GET', '/api/health')).status, 200);
    const st = (await ctx.state(a.attemptId)).body;
    assert.equal(st.answerSeq, 0, 'half-sent request had no effect');
    assert.equal(st.status, 'in_progress');
  });

  test('ND-09: queued autosave replayed after reconnect, once the attempt is closed, gets 409 and changes nothing', async () => {
    const a = await started(ctx, sid('nd09'));
    await ctx.submit(a.attemptId, { seq: 1, answers: { 'demo:1': 2 } });
    const replay = await ctx.save(a.attemptId, 2, FULL);
    assert.equal(replay.status, 409);
    assert.equal((await ctx.result(a.attemptId)).body.score, 1);
  });

  test('ND-10: a student reconnecting from a second device gets the same attempt, not a second timer', async () => {
    const a = await started(ctx, sid('nd10'));
    ctx.clock.advance(20000);
    const dev2 = (await ctx.start(a.studentId)).body;
    assert.equal(dev2.attemptId, a.attemptId);
    assert.equal(dev2.deadlineAt, a.deadlineAt);
  });
});

// ============================================================ CONCURRENT SUBMISSIONS
describe('Concurrent submissions', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => ctx.close());

  test('CS-01: 100 simultaneous submits of one attempt: exactly one finalizes, all see the same result', async () => {
    const a = await started(ctx, 'cs01');
    const rs = await Promise.all(Array.from({ length: 100 }, () => ctx.submit(a.attemptId, { seq: 1, answers: FULL })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(rs.filter((r) => r.body.alreadySubmitted === false).length, 1, 'single winner');
    const first = JSON.stringify(rs[0].body.result);
    assert.ok(rs.every((r) => JSON.stringify(r.body.result) === first), 'identical result everywhere');
    const rows = ctx.db.prepare("SELECT COUNT(*) c FROM attempts WHERE student_id='cs01' AND status != 'in_progress'").get();
    assert.equal(Number(rows.c), 1);
  });

  test('CS-02: manual submits racing the sweeper at expiry produce exactly one finalization', async () => {
    const a = await started(ctx, 'cs02');
    ctx.clock.advance(DURATION + GRACE + 1);
    const submits = Array.from({ length: 30 }, () => ctx.submit(a.attemptId, { seq: 1, answers: FULL }));
    const swept = ctx.engine.sweep();
    const rs = await Promise.all(submits);
    const submitWinners = rs.filter((r) => r.body.alreadySubmitted === false).length;
    assert.equal(swept + submitWinners, 1, 'one and only one finalization');
    const row = ctx.db.prepare("SELECT status, submit_reason FROM attempts WHERE student_id='cs02'").get();
    assert.equal(row.status, 'auto_submitted');
    assert.equal(row.submit_reason, 'timer_expired');
    assert.ok(rs.every((r) => r.body.result.score === 0), 'late answers were not counted');
  });

  test('CS-03: 50 simultaneous starts for one student create exactly one attempt', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, () => ctx.start('cs03')));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(new Set(rs.map((r) => r.body.attemptId)).size, 1);
    assert.equal(new Set(rs.map((r) => r.body.deadlineAt)).size, 1);
    assert.equal(Number(ctx.db.prepare("SELECT COUNT(*) c FROM attempts WHERE student_id='cs03'").get().c), 1);
  });

  test('CS-04: autosave racing submit never leaves a torn state (graded answers == stored answers)', async () => {
    for (let i = 0; i < 25; i++) {
      const a = await started(ctx, `cs04-${i}`);
      await ctx.save(a.attemptId, 1, { 'demo:1': 2 });
      const [put, sub] = await Promise.all([
        ctx.save(a.attemptId, 2, FULL),
        ctx.submit(a.attemptId, {}),
      ]);
      const score = sub.body.result.score;
      const stored = JSON.parse(ctx.db.prepare('SELECT answers FROM attempts WHERE id=?').get(a.attemptId).answers);
      if (put.status === 200) { assert.equal(score, 5); assert.equal(Object.keys(stored).length, 5); }
      else { assert.equal(put.status, 409); assert.equal(score, 1); assert.deepEqual(stored, { 'demo:1': 2 }); }
    }
  });

  test('CS-05: 200 students submit at once; every result is correct and isolated', async () => {
    const N = 200;
    const pick = (i) => ({
      'demo:1': i % 2 === 0 ? 2 : 0,
      'demo:2': i % 3 === 0 ? 1 : 3,
      'demo:3': i % 5 === 0 ? [0, 2, 3] : [0],
      'demo:4': i % 7 === 0 ? 144 : 145,
      'demo:5': i % 11 === 0 ? 3.14 : 3.2,
    });
    const expected = (i) => [2, 3, 5, 7, 11].filter((m) => i % m === 0).length;

    const attempts = await Promise.all(Array.from({ length: N }, (_, i) => ctx.start(`cs05-${i}`)));
    assert.ok(attempts.every((r) => r.status === 200));
    const results = await Promise.all(attempts.map((r, i) => ctx.submit(r.body.attemptId, { seq: 1, answers: pick(i) })));

    let sum = 0;
    results.forEach((r, i) => {
      assert.equal(r.status, 200);
      assert.equal(r.body.result.score, expected(i), `student ${i}`);
      sum += expected(i);
    });
    const agg = await ctx.call('GET', '/api/admin/exams/demo/results');
    assert.ok(agg.body.submitted >= N);
    const mine = ctx.db.prepare("SELECT COUNT(*) c, SUM(score) s FROM attempts WHERE student_id LIKE 'cs05-%' AND status='submitted'").get();
    assert.equal(Number(mine.c), N);
    assert.equal(Number(mine.s), sum);
  });

  test('CS-06: attempt ids are capabilities: unknown ids are 404, nothing leaks between students', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    assert.equal((await ctx.state(ghost)).status, 404);
    assert.equal((await ctx.submit(ghost, {})).status, 404);
    assert.equal((await ctx.save(ghost, 1, {})).status, 404);
    const a = await started(ctx, 'cs06');
    assert.equal(a.questions.every((q) => q.answer === undefined && q.tolerance === undefined), true, 'answer key never sent to clients');
  });

  test('CS-07: two server instances sharing one database cannot double-finalize (real compare-and-set race)', async () => {
    const dir = path.join(__dirname, '..', '..', '.tmp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `race-${process.pid}-${Date.now()}.db`);
    const clock = makeClock();
    const dbA = openDb(file);
    seedDemo(dbA, { durationMs: DURATION });
    const dbB = openDb(file);
    const A = await boot({ db: dbA, clock, seed: false });
    const B = await boot({ db: dbB, clock, seed: false });
    try {
      const ATTEMPTS = 20, PER = 10;
      const ids = [];
      for (let i = 0; i < ATTEMPTS; i++) ids.push((await A.start(`cs07-${i}`)).body.attemptId);
      const calls = [];
      for (const id of ids) for (let k = 0; k < PER; k++) calls.push((k % 2 ? A : B).submit(id, { seq: 1, answers: FULL }).then((r) => ({ id, r })));
      const out = await Promise.all(calls);
      for (const id of ids) {
        const mine = out.filter((o) => o.id === id);
        assert.equal(mine.length, PER);
        assert.ok(mine.every((o) => o.r.status === 200), 'no SQLITE_BUSY surfaced as an error');
        assert.equal(mine.filter((o) => o.r.body.alreadySubmitted === false).length, 1, `attempt ${id}: exactly one winner`);
        assert.ok(mine.every((o) => o.r.body.result.score === 5));
      }
    } finally {
      await A.close(); await B.close();
      for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    }
  });
});

// ============================================================ VALIDATION / HOSTILE INPUT
describe('Validation and hostile input', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(() => ctx.close());

  test('VA-01: invalid or hostile student ids are rejected (incl. SQL injection and path traversal)', async () => {
    const bad = ['', ' ', 'a'.repeat(65), '../etc/passwd', "S1'; DROP TABLE attempts;--", 'a b', '<script>', undefined, 123, null, ['x']];
    for (const b of bad) {
      const r = await ctx.call('POST', '/api/exams/demo/start', { studentId: b });
      assert.equal(r.status, 400, `studentId=${JSON.stringify(b)}`);
    }
    assert.doesNotThrow(() => ctx.db.prepare('SELECT COUNT(*) FROM attempts').get(), 'attempts table intact');
    assert.equal((await ctx.call('POST', '/api/exams/demo/start', {})).status, 400);
    assert.equal((await ctx.call('POST', '/api/exams/demo/start', { studentId: 'ok.user-1@x_y' })).status, 200);
  });

  test('VA-02: unknown exam is 404', async () => {
    assert.equal((await ctx.start('someone', 'no-such-exam')).status, 404);
  });

  test('VA-03: unknown question ids and junk value types are dropped, not stored', async () => {
    const a = await started(ctx, 'va03');
    // Raw JSON string on purpose: an object literal would turn "__proto__" into a prototype, not a real key.
    const raw = '{"seq":1,"answers":{"demo:1":2,"evil:1":1,"__proto__":{"polluted":true},"constructor":{"x":1},' +
      `"demo:2":{"nested":true},"demo:3":"${'x'.repeat(100)}","demo:4":null,"demo:5":3.14}}`;
    const put = await ctx.call('PUT', `/api/attempts/${a.attemptId}/answers`, raw);
    assert.equal(put.status, 200);
    const st = (await ctx.state(a.attemptId)).body;
    assert.deepEqual(st.answers, { 'demo:1': 2, 'demo:5': 3.14 });
    assert.equal({}.polluted, undefined, 'Object.prototype not polluted');
  });

  test('VA-04: oversized body is refused with 413', async () => {
    const a = await started(ctx, 'va04');
    const big = { seq: 1, answers: { 'demo:1': 'x'.repeat(10) }, pad: 'p'.repeat(70 * 1024) };
    const r = await ctx.call('PUT', `/api/attempts/${a.attemptId}/answers`, big);
    assert.equal(r.status, 413);
  });

  test('VA-05: invalid autosave payloads give 400', async () => {
    const a = await started(ctx, 'va05');
    const send = (b) => ctx.call('PUT', `/api/attempts/${a.attemptId}/answers`, b);
    assert.equal((await send({ seq: 0, answers: {} })).status, 400);
    assert.equal((await send({ seq: '1', answers: {} })).status, 400);
    assert.equal((await send({ seq: 1.5, answers: {} })).status, 400);
    assert.equal((await send({ seq: 1, answers: [] })).status, 400);
    assert.equal((await send({ seq: 1 })).status, 400);
    assert.equal((await send({})).status, 400);
  });

  test('VA-06: admin exam creation validates input and enforces the token when configured', async () => {
    const good = { id: 'va06', title: 'T', durationSec: 30, questions: [{ type: 'single', text: 'q', options: ['a', 'b'], answer: 0 }] };
    assert.equal((await ctx.call('POST', '/api/admin/exams', { ...good, durationSec: 0.1 })).status, 400, 'duration below 500 ms');
    assert.equal((await ctx.call('POST', '/api/admin/exams', { ...good, durationSec: 999999 })).status, 400, 'duration above 6 h');
    assert.equal((await ctx.call('POST', '/api/admin/exams', { ...good, questions: [] })).status, 400);
    assert.equal((await ctx.call('POST', '/api/admin/exams', { ...good, questions: [{ type: 'single', text: 'q', options: ['a'], answer: 0 }] })).status, 400);
    assert.equal((await ctx.call('POST', '/api/admin/exams', { ...good, title: '' })).status, 400);
    assert.equal((await ctx.call('POST', '/api/admin/exams', good)).status, 201);
    assert.equal((await ctx.call('POST', '/api/admin/exams', good)).status, 409, 'duplicate id');
    const s = await ctx.start('va06-student', 'va06');
    assert.equal(s.body.exam.durationMs, 30000);

    const locked = await boot({ adminToken: 'secret' });
    try {
      assert.equal((await locked.call('POST', '/api/admin/exams', good)).status, 401);
      assert.equal((await locked.call('POST', '/api/admin/exams', good, { 'x-admin-token': 'wrong' })).status, 401);
      assert.equal((await locked.call('POST', '/api/admin/exams', good, { 'x-admin-token': 'secret' })).status, 201);
      assert.equal((await locked.call('GET', '/api/admin/exams/va06/results')).status, 401);
    } finally { await locked.close(); }
  });

  test('VA-07: a failed exam insert rolls back completely (no half-created exam)', async () => {
    const bad = { id: 'va07', title: 'T', durationSec: 30, questions: [{ type: 'single', text: 'q', options: ['a', 'b'], answer: 0 }, { type: 'single', text: 'q', options: ['a', 'b'], answer: 1 }] };
    ctx.db.exec("INSERT INTO exams (id,title,duration_ms,created_at) VALUES ('blocker','x',1000,0)");
    // Force a PK collision on the 2nd question row, then confirm nothing for 'va07' persisted.
    ctx.db.exec("INSERT INTO questions (id,exam_id,position,type,text,options,answer) VALUES ('va07:2','blocker',1,'single','z','[\"a\",\"b\"]','0')");
    const r = await ctx.call('POST', '/api/admin/exams', bad);
    assert.equal(r.status, 500);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM exams WHERE id='va07'").get().c, 0);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM questions WHERE exam_id='va07'").get().c, 0);
    assert.equal((await ctx.call('GET', '/api/health')).status, 200, 'server survived');
  });
});

// ============================================================ REAL CLOCK
describe('Real clock', () => {
  test('RT-01: a short exam is auto-submitted by the background sweeper with no client activity', async () => {
    const c = await boot({ clock: { now: () => Date.now() }, durationMs: 800, graceMs: 200 });
    try {
      c.engine.startSweeper(50);
      const a = (await c.start('rt01')).body;
      await c.save(a.attemptId, 1, { 'demo:1': 2, 'demo:4': 144 });
      await sleep(1400); // 800 ms exam + 200 ms grace + margin; the student's browser is "gone"
      const row = c.db.prepare('SELECT status, submit_reason, score FROM attempts WHERE id=?').get(a.attemptId);
      assert.equal(row.status, 'auto_submitted');
      assert.equal(row.submit_reason, 'timer_expired');
      assert.equal(row.score, 2);
    } finally { await c.close(); }
  });
});
