# Online Examination & Automated Evaluation Engine

Timed online tests with server-authoritative timing, autosave, automatic submission at expiry, and immediate result compilation. Includes an STQA test suite (edge cases, Playwright UI timer tests, load test).

Requires **Node 22.13+** (uses the built-in `node:sqlite`; tested on 22.22). No native build step.

## Run it

```
npm install
npm start                      # http://localhost:3000  (demo exam "demo", 10 minutes, 5 questions)
```

Open `http://localhost:3000`, enter any student ID, and start. Use `?exam=<id>` to pick an exam, and `?student=<id>` to skip the login form.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `DB_PATH` | `:memory:` | SQLite file. **In-memory means a restart loses all data**; set a path for persistence |
| `GRACE_MS` | 2000 | How long after the deadline a submit's final answers still count |
| `SWEEP_MS` | 1000 | How often expired attempts are auto-submitted |
| `ADMIN_TOKEN` | unset | If set, admin endpoints require header `x-admin-token`. **If unset, they are open** |
| `SEED` | on | `SEED=0` skips creating the demo exam |

## How it works

- The deadline is fixed on the server when the attempt starts; the browser only displays it, using a monotonic clock, so changing the computer's clock does nothing.
- Starting again (reload, second device) returns the same attempt and the same deadline.
- Answers autosave with a sequence number; stale or replayed saves are ignored.
- Submit is idempotent and finalizes exactly once, even under concurrent or duplicate requests. The result is graded and returned in the same response.
- Past `deadline + grace`, late answers are ignored and the attempt is graded from the last autosave. A background sweeper closes attempts whose browser is gone.
- Question types: single choice, multiple select (all-or-nothing), numeric with tolerance.

## API

| Method and path | Purpose |
|---|---|
| `POST /api/exams/:examId/start` `{studentId}` | Start or resume an attempt |
| `GET /api/attempts/:id` | Full state (questions, saved answers, time left) |
| `GET /api/attempts/:id/sync` | Lightweight clock sync |
| `PUT /api/attempts/:id/answers` `{seq, answers}` | Autosave |
| `POST /api/attempts/:id/submit` `{seq?, answers?}` | Submit (idempotent) |
| `GET /api/attempts/:id/result` | Result, once finished |
| `POST /api/admin/exams` | Create an exam (`id`, `title`, `durationSec`, `questions[]`) |
| `GET /api/admin/exams/:id/results` | Aggregate counts and scores |
| `GET /api/time`, `GET /api/health` | Server time, liveness |

## Tests

```
npx playwright install chromium    # once, needs internet
npm run test:api                   # 43 edge-case + unit tests (timer expiry, disconnects, concurrency, validation)
npm run test:ui                    # 21 Playwright tests (timer sync, expiry, offline), starts its own server
npm run test:perf                  # load test up to 1,000 simultaneous submitters
```

See `docs/STQA-Report.md` for method, results, defects, and limitations, and `docs/test-case-matrix.md` for every check.

## Known limitations

No student authentication (the student ID is self-declared), no question randomization, no proctoring, no free-text grading. Single process with SQLite. Not production-ready as is.

## Layout

```
server/   app.js (API), grader.js, db.js, seed.js, index.js
public/   student UI
tests/    api/ (node:test)   ui/ (Playwright)   perf/ (load test)
docs/     STQA-Report.md, test-case-matrix.md
results/  raw outputs of the last runs
```
