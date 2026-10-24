'use strict';
/*
 * Performance / load test for the exam engine. Zero external dependencies.
 *
 *   node tests/perf/load-test.js [--levels 100,250,500,1000] [--soak-sec 30] [--soak-users 300] [--quick]
 *
 * It spawns the server as a separate OS process (file-backed SQLite, WAL), so the numbers include
 * real HTTP, JSON, SQLite and event-loop costs. Each simulated student owns one keep-alive socket,
 * like a browser tab would.
 *
 * Scenarios
 *   SPIKE   N students start, autosave, then ALL submit in the same instant.
 *   DUP     same, but every student sends 3 concurrent submits (double-click / retry storm).
 *   CLIFF   N students whose timers all hit 00:00 together; every client auto-submits at its deadline.
 *   SWEEP   N abandoned attempts expire at once; the server-side sweeper must close them without
 *           freezing the event loop for everyone else.
 *   SOAK    steady load: N concurrent students autosaving every ~1 s for D seconds, then submitting.
 *
 * Acceptance criteria are fixed here, BEFORE results are seen, and printed with every run.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3300;
const BASE = { host: '127.0.0.1', port: PORT };
const GRACE_MS = 2000;

// ---------------------------------------------------------------- acceptance criteria
const SLO = {
  maxErrorRate: 0,            // zero failed requests (non-2xx or network error)
  correctness: 1.0,           // every result must equal the expected score
  exactlyOnce: true,          // exactly one finalization per attempt
  submitP95Ms: 1000,          // p95 of submit latency during a simultaneous spike
  submitP99Ms: 2000,          // p99
  cliffResultP95Ms: 1500,     // deadline -> result visible, p95
  sweepStallMs: 250,          // longest event-loop stall seen by other users during mass expiry
  sweepCompleteMs: 5000,      // all abandoned attempts closed within this after deadline+grace
  soakAutosaveP95Ms: 250,     // steady-state autosave p95
};

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const QUICK = argv.includes('--quick');
const LEVELS = (arg('levels', QUICK ? '50,100' : '100,250,500,1000')).split(',').map(Number);
const SOAK_SEC = Number(arg('soak-sec', QUICK ? 8 : 30));
const SOAK_USERS = Number(arg('soak-users', QUICK ? 50 : 300));

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    n: s.length, min: r(s[0] ?? null), p50: r(pct(s, 0.5)), p90: r(pct(s, 0.9)),
    p95: r(pct(s, 0.95)), p99: r(pct(s, 0.99)), max: r(s[s.length - 1] ?? null),
    mean: s.length ? r(s.reduce((a, b) => a + b, 0) / s.length) : null,
  };
}

function call(agent, method, p, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = now();
    const req = http.request({
      ...BASE, method, path: p, agent,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { /* ignore */ }
        resolve({ status: res.statusCode, json, ms: now() - t0, wall: Date.now() });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, json: null, ms: now() - t0, wall: Date.now(), err: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}

const adminAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const admin = (m, p, b) => call(adminAgent, m, p, b);

// ---------------------------------------------------------------- server process
let server = null;
const DB_FILE = path.join(ROOT, '.tmp', 'perf.db');

async function startServer() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { fs.unlinkSync(f); } catch (_) { /* none */ } }
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB_FILE, GRACE_MS: String(GRACE_MS), SWEEP_MS: '1000', SEED: '0', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  server = { child, pid: child.pid, log: () => log };
  for (let i = 0; i < 100; i++) {
    const r = await admin('GET', '/api/health');
    if (r.status === 200) return;
    await sleep(100);
  }
  throw new Error('server did not start:\n' + log);
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.child.once('exit', () => resolve());
    server.child.kill('SIGTERM');
    setTimeout(() => { try { server.child.kill('SIGKILL'); } catch (_) {} resolve(); }, 3000).unref();
  });
}

function cpuTicks(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]); // utime + stime, in 1/100 s
  } catch (_) {
    return 0;
  }
}
function memKb(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const g = (k) => Number((t.match(new RegExp(`${k}:\\s+(\\d+)`)) || [0, 0])[1]);
    return { rss: g('VmRSS'), peak: g('VmHWM') };
  } catch (_) {
    return { rss: 0, peak: 0 };
  }
}
function resourceProbe() {
  const t0 = now(); const c0 = cpuTicks(server.pid);
  return () => {
    const wallS = (now() - t0) / 1000;
    const cpuS = (cpuTicks(server.pid) - c0) / 100;
    const m = memKb(server.pid);
    return {
      serverCpuPct: wallS > 0 && cpuS > 0 ? Math.round((cpuS / wallS) * 100) : 0,
      serverRssMb: Math.round(m.rss / 1024),
      serverPeakRssMb: Math.round(m.peak / 1024),
    };
  };
}

// ---------------------------------------------------------------- exam + students
const QUESTIONS = [
  { type: 'single', text: 'Q1', options: ['a', 'b', 'c', 'd'], answer: 2 },
  { type: 'single', text: 'Q2', options: ['a', 'b', 'c', 'd'], answer: 1 },
  { type: 'multi', text: 'Q3', options: ['a', 'b', 'c', 'd'], answer: [0, 2, 3] },
  { type: 'numeric', text: 'Q4', answer: 144 },
  { type: 'numeric', text: 'Q5', answer: 3.14, tolerance: 0.01 },
];

async function createExam(id, durationSec) {
  const r = await admin('POST', '/api/admin/exams', { id, title: id, durationSec, questions: QUESTIONS });
  if (r.status !== 201) throw new Error(`createExam failed: ${r.status} ${JSON.stringify(r.json)}`);
  return id;
}

// Deterministic per-student answer pattern => a different, known score for each student.
function pattern(exam, i) {
  return {
    answers: {
      [`${exam}:1`]: i % 2 === 0 ? 2 : 0,
      [`${exam}:2`]: i % 3 === 0 ? 1 : 3,
      [`${exam}:3`]: i % 5 === 0 ? [0, 2, 3] : [0],
      [`${exam}:4`]: i % 7 === 0 ? 144 : 145,
      [`${exam}:5`]: i % 11 === 0 ? 3.14 : 3.2,
    },
    expected: [2, 3, 5, 7, 11].filter((m) => i % m === 0).length,
  };
}

function makeStudents(exam, n, tag) {
  return Array.from({ length: n }, (_, i) => ({
    i, exam, sid: `${tag}-${i}`,
    agent: new http.Agent({ keepAlive: true, maxSockets: 1 }), // one socket per student
    ...pattern(exam, i),
  }));
}
const closeAll = (students) => students.forEach((s) => s.agent.destroy());

async function startAll(students) {
  return Promise.all(students.map(async (s) => {
    const r = await call(s.agent, 'POST', `/api/exams/${s.exam}/start`, { studentId: s.sid });
    s.startRes = r;
    if (r.status === 200) { s.attemptId = r.json.attemptId; s.deadlineAt = r.json.deadlineAt; s.serverNow = r.json.serverNow; s.startWall = r.wall; }
    return r;
  }));
}
const saveAll = (students, seq = 1) =>
  Promise.all(students.map(async (s) => { s.saveRes = await call(s.agent, 'PUT', `/api/attempts/${s.attemptId}/answers`, { seq, answers: s.answers }); return s.saveRes; }));

function statusHistogram(results) {
  const h = {};
  for (const r of results) { const k = r.status === 0 ? `ERR:${r.err}` : String(r.status); h[k] = (h[k] || 0) + 1; }
  return h;
}
const errorsOf = (results) => results.filter((r) => r.status < 200 || r.status >= 300).length;

function dbCheck(exam, n) {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const row = db.prepare(
      `SELECT COUNT(*) total, SUM(status='in_progress') open, SUM(status!='in_progress') finalized FROM attempts WHERE exam_id=?`
    ).get(exam);
    return { total: Number(row.total), open: Number(row.open || 0), finalized: Number(row.finalized || 0), expectedTotal: n };
  } finally { db.close(); }
}
function dbScoresMatch(exam, students) {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const rows = db.prepare('SELECT student_id, score, status FROM attempts WHERE exam_id=?').all(exam);
    const byStudent = new Map(rows.map((r) => [r.student_id, r]));
    let ok = 0;
    for (const s of students) { const r = byStudent.get(s.sid); if (r && r.status !== 'in_progress' && r.score === s.expected) ok++; }
    return ok;
  } finally { db.close(); }
}

const verdicts = [];
function check(scenario, name, pass, detail) {
  verdicts.push({ scenario, name, pass: !!pass, detail });
  console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

// ---------------------------------------------------------------- scenarios
async function spike(N) {
  const label = `SPIKE-${N}`;
  console.log(`\n== ${label}: ${N} students start, autosave, then all submit in the same instant`);
  const exam = await createExam(`spike${N}-${Date.now().toString(36)}`, 600);
  const students = makeStudents(exam, N, 'sp');
  const probe = resourceProbe();

  const tStart0 = now(); const starts = await startAll(students); const startWall = now() - tStart0;
  await saveAll(students);
  await sleep(300);

  const t0 = now();
  const subs = await Promise.all(students.map(async (s) => {
    const r = await call(s.agent, 'POST', `/api/attempts/${s.attemptId}/submit`, { seq: 2, answers: s.answers });
    s.subRes = r; return r;
  }));
  const wall = now() - t0;
  const res = probe();

  const lat = stats(subs.map((r) => r.ms));
  const errs = errorsOf(subs) + errorsOf(starts);
  const correct = students.filter((s) => s.subRes.json && s.subRes.json.result && s.subRes.json.result.score === s.expected).length;
  const winners = students.filter((s) => s.subRes.json && s.subRes.json.alreadySubmitted === false).length;
  const db = dbCheck(exam, N);
  const agg = (await admin('GET', `/api/admin/exams/${exam}/results`)).json;
  const expectedAvg = students.reduce((a, s) => a + s.expected, 0) / N;

  console.log(`   start storm: ${stats(starts.map((r) => r.ms)).p95} ms p95; submit: p50=${lat.p50} p95=${lat.p95} p99=${lat.p99} max=${lat.max} ms; wall=${Math.round(wall)} ms (${Math.round(N / (wall / 1000))} submits/s)`);
  check(label, 'no failed requests', errs / (2 * N) <= SLO.maxErrorRate, `${errs} errors, statuses ${JSON.stringify(statusHistogram(subs))}`);
  check(label, 'every result correct', correct / N >= SLO.correctness, `${correct}/${N}`);
  check(label, 'exactly one finalization per attempt', winners === N && db.finalized === N && db.open === 0, `winners=${winners}, db finalized=${db.finalized}/${N}, still open=${db.open}`);
  check(label, 'admin aggregate matches ground truth', agg.submitted === N && Math.abs(agg.avgScore - expectedAvg) < 1e-9, `avg ${agg.avgScore} vs ${expectedAvg}`);
  check(label, `submit p95 <= ${SLO.submitP95Ms} ms`, lat.p95 <= SLO.submitP95Ms, `${lat.p95} ms`);
  check(label, `submit p99 <= ${SLO.submitP99Ms} ms`, lat.p99 <= SLO.submitP99Ms, `${lat.p99} ms`);
  closeAll(students);
  return { scenario: label, students: N, startStormMs: stats(starts.map((r) => r.ms)), submitMs: lat, wallMs: Math.round(wall), submitsPerSec: Math.round(N / (wall / 1000)), errors: errs, correct, winners, db, ...res };
}

async function dup(N) {
  const label = `DUP-${N}`;
  console.log(`\n== ${label}: ${N} students, each sends 3 concurrent submits (${3 * N} requests at once)`);
  const exam = await createExam(`dup${N}-${Date.now().toString(36)}`, 600);
  const students = makeStudents(exam, N, 'dp');
  // 3 sockets per student so the duplicates are truly concurrent
  students.forEach((s) => { s.agent.destroy(); s.agent = new http.Agent({ keepAlive: true, maxSockets: 3 }); });
  const probe = resourceProbe();
  await startAll(students); await saveAll(students); await sleep(300);

  const t0 = now();
  const all = await Promise.all(students.flatMap((s) => [0, 1, 2].map(async () => {
    const r = await call(s.agent, 'POST', `/api/attempts/${s.attemptId}/submit`, { seq: 2, answers: s.answers });
    (s.dupRes = s.dupRes || []).push(r); return r;
  })));
  const wall = now() - t0;
  const res = probe();
  const lat = stats(all.map((r) => r.ms));
  const exactlyOne = students.filter((s) => s.dupRes.filter((r) => r.json && r.json.alreadySubmitted === false).length === 1).length;
  const consistent = students.filter((s) => {
    const sc = new Set(s.dupRes.map((r) => r.json && r.json.result && r.json.result.score));
    return sc.size === 1 && sc.has(s.expected);
  }).length;
  const db = dbCheck(exam, N);

  console.log(`   ${3 * N} submits: p50=${lat.p50} p95=${lat.p95} p99=${lat.p99} max=${lat.max} ms; wall=${Math.round(wall)} ms`);
  check(label, 'no failed requests', errorsOf(all) === 0, `${errorsOf(all)} errors, ${JSON.stringify(statusHistogram(all))}`);
  check(label, 'exactly one winner per student', exactlyOne === N, `${exactlyOne}/${N}`);
  check(label, 'all 3 responses agree and are correct', consistent === N, `${consistent}/${N}`);
  check(label, 'database has exactly N finalized attempts', db.finalized === N && db.total === N, JSON.stringify(db));
  check(label, `submit p95 <= ${SLO.submitP95Ms} ms`, lat.p95 <= SLO.submitP95Ms, `${lat.p95} ms`);
  closeAll(students);
  return { scenario: label, students: N, requests: 3 * N, submitMs: lat, wallMs: Math.round(wall), exactlyOne, consistent, db, ...res };
}

async function cliff(N) {
  const label = `CLIFF-${N}`;
  const DURATION_S = 8;
  console.log(`\n== ${label}: ${N} students, ${DURATION_S}s exam; every client auto-submits at its own 00:00`);
  const exam = await createExam(`cliff${N}-${Date.now().toString(36)}`, DURATION_S);
  const students = makeStudents(exam, N, 'cl');
  const probe = resourceProbe();
  await startAll(students); await saveAll(students);

  await Promise.all(students.map(async (s) => {
    const offset = s.serverNow - s.startWall;               // same host => ~0, computed anyway
    s.deadlineLocal = s.deadlineAt - offset;
    await sleep(Math.max(0, s.deadlineLocal - Date.now()) + Math.random() * 50); // fire at 00:00 (+ <=50 ms jitter)
    const r = await call(s.agent, 'POST', `/api/attempts/${s.attemptId}/submit`, { seq: 2, answers: s.answers });
    s.subRes = r; s.deadlineToResult = r.wall - s.deadlineLocal;
  }));
  const res = probe();
  const subs = students.map((s) => s.subRes);
  const d2r = stats(students.map((s) => s.deadlineToResult));
  const late = students.filter((s) => s.subRes.json && s.subRes.json.late).length;
  const correct = students.filter((s) => s.subRes.json && s.subRes.json.result && s.subRes.json.result.score === s.expected).length;
  const db = dbCheck(exam, N);
  const spreadMs = Math.max(...students.map((s) => s.deadlineAt)) - Math.min(...students.map((s) => s.deadlineAt));

  console.log(`   deadlines spread over ${spreadMs} ms; deadline->result: p50=${d2r.p50} p95=${d2r.p95} max=${d2r.max} ms; late(beyond grace)=${late}`);
  check(label, 'no failed requests', errorsOf(subs) === 0, `${JSON.stringify(statusHistogram(subs))}`);
  check(label, 'every result correct (autosave == final answers)', correct === N, `${correct}/${N}`);
  check(label, 'every attempt finalized exactly once', db.finalized === N && db.open === 0, JSON.stringify(db));
  check(label, `deadline -> result p95 <= ${SLO.cliffResultP95Ms} ms`, d2r.p95 <= SLO.cliffResultP95Ms, `${d2r.p95} ms`);
  check(label, 'no submission fell outside the grace window', late === 0, `${late} late`);
  closeAll(students);
  return { scenario: label, students: N, deadlineSpreadMs: spreadMs, deadlineToResultMs: d2r, lateBeyondGrace: late, correct, db, ...res };
}

async function sweepStorm(N) {
  const label = `SWEEP-${N}`;
  const DURATION_S = 5;
  console.log(`\n== ${label}: ${N} abandoned attempts (browsers gone) expire together; sweeper must close them`);
  const exam = await createExam(`sweep${N}-${Date.now().toString(36)}`, DURATION_S);
  const students = makeStudents(exam, N, 'sw');
  const probe = resourceProbe();
  await startAll(students); await saveAll(students);
  const lastDeadline = Math.max(...students.map((s) => s.deadlineAt));
  const closeAt = lastDeadline + GRACE_MS;                  // earliest instant the sweeper may act on the last one

  // Probe latency as "another student" while the sweeper works: any event-loop stall shows up here.
  const probeAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const healthMs = []; let completedAt = null;
  const tEnd = Date.now() + (DURATION_S + 2) * 1000 + SLO.sweepCompleteMs + 4000;
  while (Date.now() < tEnd) {
    const h = await call(probeAgent, 'GET', '/api/health');
    if (Date.now() > students[0].deadlineAt) healthMs.push(h.ms);
    if (completedAt === null && Date.now() > closeAt) {
      const a = (await admin('GET', `/api/admin/exams/${exam}/results`)).json;
      if (a.inProgress === 0) { completedAt = Date.now(); }
    }
    if (completedAt !== null && Date.now() > completedAt + 1000) break;
    await sleep(15);
  }
  const res = probe();
  const hl = stats(healthMs);
  const completeAfterMs = completedAt === null ? null : completedAt - closeAt;
  const okScores = dbScoresMatch(exam, students);
  const db = dbCheck(exam, N);

  console.log(`   all closed ${completeAfterMs === null ? 'NEVER' : completeAfterMs + ' ms'} after the last grace window ended; health probe during sweep: p50=${hl.p50} p99=${hl.p99} max=${hl.max} ms`);
  check(label, `all ${N} attempts closed within ${SLO.sweepCompleteMs} ms of the grace window ending`, completeAfterMs !== null && completeAfterMs <= SLO.sweepCompleteMs, `${completeAfterMs} ms`);
  check(label, 'every auto-submitted score correct', okScores === N, `${okScores}/${N}`);
  check(label, 'no attempt left open', db.open === 0 && db.finalized === N, JSON.stringify(db));
  check(label, `longest stall seen by other users <= ${SLO.sweepStallMs} ms`, hl.max !== null && hl.max <= SLO.sweepStallMs, `${hl.max} ms`);
  probeAgent.destroy(); closeAll(students);
  return { scenario: label, students: N, completeAfterGraceMs: completeAfterMs, healthProbeMs: hl, correct: okScores, db, ...res };
}

async function soak(N, seconds) {
  const label = `SOAK-${N}x${seconds}s`;
  console.log(`\n== ${label}: ${N} concurrent students autosaving about once per second for ${seconds}s, then submitting`);
  const exam = await createExam(`soak${N}-${Date.now().toString(36)}`, 600);
  const students = makeStudents(exam, N, 'so');
  const probe = resourceProbe();
  await startAll(students);
  const saveLat = []; const allRes = [];
  const t0 = now();
  await Promise.all(students.map(async (s) => {
    await sleep(Math.random() * 1000);
    let seq = 0;
    while (now() - t0 < seconds * 1000) {
      seq += 1;
      const r = await call(s.agent, 'PUT', `/api/attempts/${s.attemptId}/answers`, { seq, answers: s.answers });
      saveLat.push(r.ms); allRes.push(r);
      await sleep(900 + Math.random() * 200);
    }
    s.seq = seq;
    s.subRes = await call(s.agent, 'POST', `/api/attempts/${s.attemptId}/submit`, { seq: seq + 1, answers: s.answers });
    allRes.push(s.subRes);
  }));
  const elapsed = (now() - t0) / 1000;
  const res = probe();
  const lat = stats(saveLat);
  const correct = students.filter((s) => s.subRes.json && s.subRes.json.result && s.subRes.json.result.score === s.expected).length;
  const rate = Math.round(allRes.length / elapsed);

  console.log(`   ${allRes.length} requests, ~${rate} req/s; autosave: p50=${lat.p50} p95=${lat.p95} p99=${lat.p99} max=${lat.max} ms`);
  check(label, 'no failed requests', errorsOf(allRes) === 0, `${errorsOf(allRes)} of ${allRes.length}`);
  check(label, 'every result correct', correct === N, `${correct}/${N}`);
  check(label, `autosave p95 <= ${SLO.soakAutosaveP95Ms} ms`, lat.p95 <= SLO.soakAutosaveP95Ms, `${lat.p95} ms`);
  closeAll(students);
  return { scenario: label, students: N, durationSec: seconds, requests: allRes.length, reqPerSec: rate, autosaveMs: lat, correct, ...res };
}

// ---------------------------------------------------------------- main
(async () => {
  console.log('Exam engine load test');
  console.log(`  node ${process.version}, ${require('os').cpus().length} cores (server and load generator share this machine)`);
  console.log(`  levels=${LEVELS.join(',')} soak=${SOAK_USERS} users x ${SOAK_SEC}s ${QUICK ? '(quick mode)' : ''}`);
  console.log('  Acceptance criteria:', JSON.stringify(SLO));

  const out = { startedAt: new Date().toISOString(), node: process.version, cores: require('os').cpus().length, slo: SLO, scenarios: [] };
  await startServer();
  try {
    for (const n of LEVELS) out.scenarios.push(await spike(n));
    out.scenarios.push(await dup(LEVELS.includes(500) ? 500 : LEVELS[LEVELS.length - 1]));
    out.scenarios.push(await cliff(LEVELS.includes(500) ? 500 : LEVELS[LEVELS.length - 1]));
    out.scenarios.push(await sweepStorm(LEVELS.includes(1000) ? 1000 : LEVELS[LEVELS.length - 1]));
    out.scenarios.push(await soak(SOAK_USERS, SOAK_SEC));
  } finally {
    out.serverLogTail = server ? server.log().split('\n').slice(-10) : [];
    await stopServer();
  }
  out.verdicts = verdicts;
  out.passed = verdicts.filter((v) => v.pass).length;
  out.failed = verdicts.filter((v) => !v.pass).length;
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  const file = path.join(ROOT, 'results', QUICK ? 'perf-results-quick.json' : 'perf-results.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nChecks: ${out.passed} passed, ${out.failed} failed. Results written to ${path.relative(ROOT, file)}`);
  process.exit(out.failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stopServer(); process.exit(2); });
