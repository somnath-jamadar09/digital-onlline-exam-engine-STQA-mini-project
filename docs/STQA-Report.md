# STQA Report: Online Examination & Automated Evaluation Engine

Prepared 11 Oct 2026. Every number below comes from a test run on this build; raw results are in `results/`, and the full per-check list is in [`test-case-matrix.md`](test-case-matrix.md).

## 1. Summary

| Deliverable | What was done | Outcome |
|---|---|---|
| Edge-condition test cases (timer expiry, network disconnects, concurrent submissions) | 43 automated cases (API + unit), deterministic fake clock plus one real-clock case | 43 / 43 pass. **1 real defect found and fixed** (section 6, D-1) |
| Automated UI timer-synchronicity tests | 21 Playwright cases in Chromium | 21 / 21 pass in the final run. Largest measured browser-vs-server drift: **232 ms** (limit set: 500 ms). One unexplained intermittent failure earlier (section 6, T-2) |
| Performance test, hundreds of simultaneous submissions | 5 scenarios, up to 1,000 simultaneous submitters | 40 / 41 criteria met. **1 pre-declared criterion failed** (DUP-500 p95, section 5.3). 1,000 simultaneous submits completed in 605 ms wall time with zero errors and 100 % correct scores |

Overall: 104 of 105 executed checks passed. Section 7 lists what this testing does **not** cover.

## 2. System under test

A Node 22 / Express 5 service with SQLite (built-in `node:sqlite`, WAL mode) and a vanilla-JS student client.

Design rules the tests target:

1. **The server clock is the only authority.** The deadline is fixed when the attempt starts. The client only displays it, computing remaining time as `deadline - performance.now()`, so changing the OS clock cannot move it.
2. **Finalization is a compare-and-set** (`UPDATE ... WHERE status='in_progress'`). Concurrent, duplicate or racing submits finalize an attempt exactly once; later calls return the stored result (idempotent).
3. **Grace window (2 s default).** A submit up to `deadline + grace` counts its final answers. After that, the attempt is graded from the last autosaved answers and late answers are ignored.
4. **Autosave carries a sequence number**, so replayed or out-of-order requests after a network flap cannot overwrite newer answers.
5. **A background sweeper** auto-submits expired attempts even if the student's browser is gone.
6. Results are compiled at finalization, so they are available immediately.

## 3. Test environment

| Item | Value |
|---|---|
| Runtime | Node v22.22.0, Express 5, SQLite 3.50.4 |
| Browser automation | Playwright 1.56.1 with Chromium 141 (**Chromium only**; Selenium not used) |
| Machine | 2 vCPU, 8 GB RAM, Linux. **Server and load generator shared the same 2 cores**; all traffic over loopback, no TLS |
| Clock handling | API tests use an injected fake clock for exact millisecond boundaries; Playwright and perf tests use the real clock |

## 4. Edge-condition test design

Cases were derived from boundary-value analysis on the time axis (`deadline`, `deadline + grace`, `+1 ms`) and from state-transition analysis of an attempt (`in_progress -> submitted | auto_submitted`, which must happen exactly once).

### 4.1 Timer expiry (TE-01 to TE-12, RT-01)
- Boundaries: submit exactly at the deadline, at `deadline + grace` (accepted), and 1 ms later (rejected, graded from autosave).
- Late autosave gets `409`; autosave inside the grace window is accepted.
- Sweeper boundary: does not act at exactly `deadline + grace`, does 1 ms later, and a second sweep does nothing.
- The deadline never extends on re-start or refresh; client-supplied timestamps are ignored.
- An exam that expires with zero answers still produces a 0 / max result.
- RT-01 uses the real clock: a short exam is closed by the sweeper with no client activity.

### 4.2 Network disconnects (ND-01 to ND-10)
- Resume restores answers and sequence number, and the clock kept running while offline.
- Stale, out-of-order and duplicate autosaves are harmless.
- Submit retried after a lost response returns the identical result; a different later payload cannot rewrite it.
- A stale final snapshot loses to a newer autosave from another tab; a newer snapshot wins.
- Truncated JSON gives `400`, not `500`, and leaves the attempt intact. A raw socket dropped mid-request leaves state untouched and the server healthy.
- A queued autosave replayed after the attempt closed gets `409` and changes nothing.

### 4.3 Concurrent submissions (CS-01 to CS-07)
- 100 simultaneous submits for one attempt: exactly one winner, identical results.
- 30 submits racing the sweeper at expiry: exactly one finalization.
- 50 simultaneous starts: exactly one attempt row.
- Autosave racing submit (25 rounds): graded answers always equal stored answers (no torn state).
- 200 students submitting at once: each score matches a per-student known value.
- CS-07 runs **two server instances on one database file** and races 200 submits across them. This exercises the compare-and-set itself, not just Node's single-threaded request handling. Result: exactly one winner per attempt, no `SQLITE_BUSY` errors surfaced.

### 4.4 Supporting areas
Grading logic (GR-01 to GR-06: single, multi, numeric tolerance, malformed input) and validation/hostile input (VA-01 to VA-07: SQL-injection-style student ids, `__proto__` keys, oversized bodies, admin token enforcement, transactional rollback of a failed exam insert).

**Result: 43 / 43 pass.**

## 5. Automated UI testing (Playwright)

### 5.1 Method
*Drift* = (time left shown in the browser) - (time left according to the server) at the same instant, sampled by reading the timer's `data-remaining-ms` and calling the server's sync endpoint in parallel. The display refreshes every 200 ms and sampling adds a few ms of latency, so the acceptance limit was set at **±500 ms** (±1000 ms under 6x CPU throttling) before running.

### 5.2 Results

| Case | Condition | Measured |
|---|---|---|
| UI-02 | 30 samples over 15 s | max \|drift\| 196 ms, mean +88 ms |
| UI-04 | OS clock +2 h / -3 h / +10 years | 78 / 89 / 72 ms |
| UI-05 | 6x CPU throttling | 158 ms |
| UI-06 | main thread frozen for 2.5 s | 154 ms |
| UI-07 | same student on two devices, second joins 2.5 s late | tabs differ by 97 ms; timer did not restart |
| UI-08 | 8 students starting together | max \|drift\| 232 ms |
| UI-15 | 5 s fully offline, then reconnect | 83 ms |
| UI-03 | reload mid-exam | 85.3 s remaining on a 90 s exam after ≥ 4 s elapsed (a reset would show ~90 s); answer restored |

Also verified: auto-submit at 00:00 with the answers given (UI-10), a 0 / 5 result on an unanswered expiry (UI-11), a double-click on Submit sends exactly one request (UI-12), reopening a finished exam shows the result and no timer (UI-13), and offline behaviours (UI-14, 16 to 19).

The mean drift is positive (+88 ms): the display can lag the server by up to one tick (200 ms), so the student sees slightly **more** time than remains, never less. This is well inside the 2 s grace window.

`UI-10`'s "time to result" figure (7.1 s on a 6 s exam) includes page load and typing before the clock started, so it is only an upper bound. The tighter measure of deadline-to-result latency is the API-level CLIFF scenario below (p50 33 ms).

### 5.3 A business rule these tests surfaced (UI-19)
If a student is offline **through** `deadline + grace`, the server closes the attempt from the last answers it received, and answers typed offline after that point are not counted. This is correct under the stated rules, but it is a policy decision stakeholders should confirm (R-1).

## 6. Performance testing

### 6.1 Acceptance criteria (fixed before the first run)

| Criterion | Limit |
|---|---|
| Failed requests | 0 |
| Result correctness | 100 % |
| Finalizations per attempt | exactly 1 |
| Submit latency during a simultaneous spike | p95 ≤ 1,000 ms, p99 ≤ 2,000 ms |
| Deadline to result visible (cliff) | p95 ≤ 1,500 ms |
| Event-loop stall seen by other users during mass expiry | ≤ 250 ms |
| All abandoned attempts closed after grace ends | ≤ 5,000 ms |
| Steady-state autosave | p95 ≤ 250 ms |

### 6.2 Results

| Scenario | Load | Latency (ms) | Outcome |
|---|---|---|---|
| SPIKE-100 | 100 simultaneous submits | p95 102, p99 107; wall 111 ms | all pass |
| SPIKE-250 | 250 | p95 168, p99 172; wall 181 ms | all pass |
| SPIKE-500 | 500 | p95 334, p99 341; wall 352 ms | all pass |
| SPIKE-1000 | 1,000 | p95 576, p99 588; wall 605 ms (1,652 submits/s) | all pass |
| DUP-500 | 500 students × 3 concurrent submits = 1,500 requests at once | p50 407, **p95 1,261**, p99 1,287; wall 1,320 ms | **p95 criterion failed**; correctness and exactly-once passed (500 / 500 winners) |
| CLIFF-500 | 500 students whose timers hit 00:00 together | deadline to result: p50 33, p95 60, max 79 | all pass; 0 submissions outside grace |
| SWEEP-1000 | 1,000 abandoned attempts expire together | all closed 412 ms after grace ended; longest stall seen by another user 77.8 ms | all pass |
| SOAK-300 | 300 students, ~299 req/s for 30 s (9,294 requests) | autosave p50 0.8, p95 1.5, p99 4.6, max 53.6 | all pass |

In every scenario: zero failed requests and every score matched its known expected value. The direct database check for exactly one finalization per attempt was run in all scenarios except SOAK (which was verified from the responses only).

Server resources: server CPU averaged up to 78 % of one core over the SPIKE-1000 scenario (measured from the start of the scenario, so it includes setup and idle gaps, not just the burst); memory peaked at about 141 MB.

### 6.3 The failed criterion (DUP-500)
The p95 of 1,261 ms exceeds the 1,000 ms limit. The criterion was **not** relaxed afterwards. Context for reading it:
- All 1,500 requests arrive in the same instant, so latency is essentially queueing time. The whole burst took 1,320 ms, which is about 1,136 requests/s. Meeting 1,000 ms at this burst size needs roughly 1,500+ requests/s.
- Duplicate submits return the stored result with its per-question breakdown, which costs more per request than a first submit (SPIKE-1000 sustained 1,652/s).
- The load generator competed for the same 2 cores, so real headroom is unknown.

A 500-student class double-clicking at the same moment is a plausible but pessimistic case, and nothing was lost or double-counted. If this matters, options are running several server processes (CS-07 shows the compare-and-set is safe across instances) or trimming the duplicate-response payload. Neither was done or measured here.

## 7. Defects and observations

| ID | Type | Description | Status |
|---|---|---|---|
| D-1 | **Defect (fixed)** | Numeric answers on the exact tolerance boundary could be marked wrong because of binary floating point. With key 3.14 and ±0.01, a student answering 3.13 was marked incorrect (`\|3.13-3.14\|` evaluates to 0.010000000000000231). Found by GR-03. Fixed with a 1e-12 relative epsilon in `server/grader.js`; GR-03 now passes | Closed |
| T-1 | Test flaw (fixed) | First version of UI-16 reconnected before reloading, so the autosave had already reached the server and the "Saved" badge never appeared. The product behaved correctly. The test now blocks only the autosave endpoint across the reload | Closed |
| T-2 | **Unexplained intermittent** | After the T-1 rewrite, UI-16 failed once in a full-suite run (waiting for "Saved"). It was not reproduced in 12 parallel repeats of that test, nor in 5 further complete suite runs (including the final run, which is the one reported). Playwright overwrote the failure's trace and screenshot on the next run, so the root cause is **unconfirmed**. It could be a test-harness timing issue or a rare client race in the recovery path | **Open**, monitor |
| P-1 | Criterion failure | DUP-500 p95 (section 6.3) | Open, decision for the team |
| R-1 | Business rule to confirm | Answers entered offline and not synced by `deadline + grace` are not counted (UI-19) | Needs sign-off |
| R-2 | **Security gap (out of scope of the build)** | There is no student authentication. `studentId` is self-declared, so anyone who knows or guesses an id can open that student's attempt. Attempt ids are unguessable UUIDs, but start is not protected. Admin endpoints are open unless `ADMIN_TOKEN` is set | Must be addressed before real use |
| R-3 | Scaling limit | One Node process plus one SQLite file. The sweeper is synchronous (up to 1,000 attempts per pass); at 1,000 expiring at once it stalled other users for at most 77.8 ms | Fine for this load; re-test if classes grow |
| R-4 | Persistence default | `npm start` uses an in-memory database unless `DB_PATH` is set; a restart loses everything | Documented in the README |

## 8. What this testing does not cover

- **Browsers**: Chromium only. Firefox, WebKit and mobile browsers were not run.
- **Load testing used HTTP clients, not real browsers.** Browser behaviour under load (for example 500 tabs) was not measured.
- **Performance environment**: one 2-core machine shared by server and generator, loopback networking, no TLS, one run per load level (no repetitions or confidence intervals). The numbers show behaviour and relative headroom; they should not be extrapolated to a production deployment.
- **Not built or tested**: login/authentication, question randomization, proctoring, manual grading of free-text answers, accessibility, localization, backup and recovery, long-duration (hours) soak.
- Real-clock coverage is limited to RT-01, the Playwright suite and the perf scenarios; the other timer-boundary cases use a fake clock.

## 9. Reproducing the results

```
npm install
npx playwright install chromium     # on a machine with internet access
npm run test:api                    # 43 cases, writes results/api-junit.xml
npm run test:ui                     # 21 cases, starts its own server on :3200
npm run test:perf                   # full load test, writes results/perf-results.json (roughly 1-2 minutes)
npm run test:perf:quick             # smaller smoke version
node scripts/gen-matrix.js          # rebuilds docs/test-case-matrix.md
```
