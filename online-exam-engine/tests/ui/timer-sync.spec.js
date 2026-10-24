'use strict';
/*
 * Automated UI tests for timer synchronicity (Playwright, Chromium).
 * "Drift" = (time left shown in the browser) - (time left according to the server) at the same instant.
 * The display updates every 200 ms and the sampling request adds a few ms of latency,
 * so the acceptance tolerance is +/-500 ms (+/-1000 ms under 6x CPU throttling).
 */
const { test, expect } = require('@playwright/test');
const {
  uid, createExam, startUI, uiRemaining, serverState, sampleDrift, wait,
} = require('./helpers');

const TOL = 500;

function note(testInfo, type, description) {
  testInfo.annotations.push({ type, description: String(description) });
}

test.describe('Timer synchronicity', () => {
  test('UI-01: timer starts at the full duration and counts down monotonically', async ({ page, request }, testInfo) => {
    const exam = await createExam(request, 60);
    const sid = uid('s');
    await startUI(page, exam, sid);
    const first = await uiRemaining(page);
    expect(first).toBeGreaterThan(58_000);
    expect(first).toBeLessThanOrEqual(60_000);
    await expect(page.getByTestId('timer')).toHaveText(/^0[01]:\d\d$/);

    let prev = first;
    for (let i = 0; i < 6; i++) {
      await wait(500);
      const cur = await uiRemaining(page);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
    expect(first - prev).toBeGreaterThan(2_000);
    expect(first - prev).toBeLessThan(5_000);
    note(testInfo, 'elapsed-over-3s-wait', `${first - prev} ms`);
  });

  test('UI-02: no drift against the server clock over 15 seconds (sampled every 500 ms)', async ({ page, request }, testInfo) => {
    const exam = await createExam(request, 120);
    const sid = uid('s');
    await startUI(page, exam, sid, '&sync=3000');
    const st = await serverState(request, exam, sid);

    const drifts = [];
    for (let i = 0; i < 30; i++) {
      drifts.push((await sampleDrift(page, request, st.attemptId)).drift);
      await wait(500);
    }
    const max = Math.max(...drifts.map(Math.abs));
    const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    note(testInfo, 'max-abs-drift-ms', Math.round(max));
    note(testInfo, 'mean-drift-ms', Math.round(mean));
    note(testInfo, 'samples', drifts.length);
    expect(max).toBeLessThan(TOL);
  });

  test('UI-03: reload mid-exam resumes from the server deadline, not from a fresh timer; answers restored', async ({ page, request }, testInfo) => {
    const exam = await createExam(request, 90);
    const sid = uid('s');
    await startUI(page, exam, sid);
    await page.getByTestId('q-1-opt-2').check();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'Saved');
    await wait(4000);

    await page.reload();
    await page.getByTestId('student-id').fill(sid);
    await page.getByTestId('start-btn').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('timer')).toHaveAttribute('data-remaining-ms', /^\d+$/);

    const after = await uiRemaining(page);
    note(testInfo, 'remaining-after-reload-ms', after);
    expect(after).toBeLessThan(87_000);   // 90 s minus >= 4 s elapsed (a reset would show ~90 s)
    expect(after).toBeGreaterThan(80_000);
    await expect(page.getByTestId('q-1-opt-2')).toBeChecked();

    const st = await serverState(request, exam, sid);
    const { drift } = await sampleDrift(page, request, st.attemptId);
    expect(Math.abs(drift)).toBeLessThan(TOL);
  });

  for (const skew of [{ name: '+2 hours', ms: 2 * 3600e3 }, { name: '-3 hours', ms: -3 * 3600e3 }, { name: '+10 years', ms: 10 * 365 * 86400e3 }]) {
    test(`UI-04: student's system clock set ${skew.name} does not affect the timer`, async ({ page, request }, testInfo) => {
      await page.addInitScript((offset) => {
        const RealDate = Date;
        class SkewedDate extends RealDate {
          constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a); }
          static now() { return RealDate.now() + offset; }
        }
        // eslint-disable-next-line no-global-assign
        Date = SkewedDate;
      }, skew.ms);

      const exam = await createExam(request, 60);
      const sid = uid('s');
      await startUI(page, exam, sid);
      const st = await serverState(request, exam, sid);
      expect(await page.evaluate(() => Date.now())).not.toBeCloseTo(Date.now(), -4); // skew really applied
      await wait(3000);
      const { drift, ui } = await sampleDrift(page, request, st.attemptId);
      note(testInfo, 'drift-ms', Math.round(drift));
      expect(Math.abs(drift)).toBeLessThan(TOL);
      expect(ui).toBeLessThan(58_000);
    });
  }

  test('UI-05: timer stays accurate under 6x CPU throttling', async ({ page, request, context }, testInfo) => {
    const exam = await createExam(request, 60);
    const sid = uid('s');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await startUI(page, exam, sid);
    const st = await serverState(request, exam, sid);
    await wait(6000);
    const { drift } = await sampleDrift(page, request, st.attemptId);
    note(testInfo, 'drift-ms', Math.round(drift));
    expect(Math.abs(drift)).toBeLessThan(1000);
  });

  test('UI-06: a 2.5 s frozen main thread (busy loop) does not make the timer lose time', async ({ page, request }, testInfo) => {
    const exam = await createExam(request, 60);
    const sid = uid('s');
    await startUI(page, exam, sid);
    const st = await serverState(request, exam, sid);
    await page.evaluate(() => { const end = performance.now() + 2500; while (performance.now() < end) { /* freeze */ } });
    await expect(page.getByTestId('timer')).toHaveAttribute('data-remaining-ms', /^\d+$/);
    await wait(300); // let one tick run
    const { drift } = await sampleDrift(page, request, st.attemptId);
    note(testInfo, 'drift-after-freeze-ms', Math.round(drift));
    expect(Math.abs(drift)).toBeLessThan(TOL + 300);
  });

  test('UI-07: two tabs of the same student show the same timer and share one attempt', async ({ browser, request }, testInfo) => {
    const exam = await createExam(request, 90);
    const sid = uid('s');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext(); // e.g. second device
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await startUI(a, exam, sid);
      await wait(2500); // second device joins later; the timer must NOT restart
      await startUI(b, exam, sid);
      await wait(500);
      const [ra, rb] = await Promise.all([uiRemaining(a), uiRemaining(b)]);
      note(testInfo, 'tab-difference-ms', Math.abs(ra - rb));
      expect(Math.abs(ra - rb)).toBeLessThan(TOL + 200);
      expect(rb).toBeLessThan(88_000);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('UI-08: 8 students starting together each track the server clock within tolerance', async ({ browser, request }, testInfo) => {
    const exam = await createExam(request, 90);
    const N = 8;
    const ctxs = await Promise.all(Array.from({ length: N }, () => browser.newContext()));
    try {
      const pages = await Promise.all(ctxs.map((c) => c.newPage()));
      const sids = pages.map((_, i) => uid(`m${i}`));
      await Promise.all(pages.map((p, i) => startUI(p, exam, sids[i])));
      await wait(4000);
      const states = await Promise.all(sids.map((s) => serverState(request, exam, s)));
      const drifts = [];
      for (let i = 0; i < N; i++) drifts.push((await sampleDrift(pages[i], request, states[i].attemptId)).drift);
      const max = Math.max(...drifts.map(Math.abs));
      note(testInfo, 'max-abs-drift-ms', Math.round(max));
      note(testInfo, 'students', N);
      expect(max).toBeLessThan(TOL + 200);
    } finally { await Promise.all(ctxs.map((c) => c.close())); }
  });

  test('UI-09: timer colour states change at 60 s and 10 s remaining', async ({ page, request }) => {
    const exam = await createExam(request, 14);
    await startUI(page, exam, uid('s'));
    await expect(page.getByTestId('timer')).toHaveClass(/low/);       // already <= 60 s
    await expect(page.getByTestId('timer')).not.toHaveClass(/critical/);
    await expect(page.getByTestId('timer')).toHaveClass(/critical/, { timeout: 8000 }); // <= 10 s
  });
});

test.describe('Timer expiry in the browser', () => {
  test('UI-10: at 00:00 the exam is auto-submitted with the answers given, and the result appears immediately', async ({ page, request }, testInfo) => {
    const exam = await createExam(request, 6);
    const sid = uid('s');
    const t0 = Date.now();
    await startUI(page, exam, sid);
    await page.getByTestId('q-1-opt-2').check();    // correct
    await page.getByTestId('q-4-input').fill('144'); // correct
    await page.getByTestId('q-2-opt-0').check();     // wrong
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'Saved');

    await expect(page.getByTestId('result')).toBeVisible({ timeout: 15_000 });
    const elapsed = Date.now() - t0;
    note(testInfo, 'time-to-result-ms', elapsed);
    expect(elapsed).toBeGreaterThan(5_000);   // not before the deadline
    expect(elapsed).toBeLessThan(9_000);      // and promptly after it

    await expect(page.getByTestId('result-score')).toHaveText('2 / 5 (40%)');
    await expect(page.getByTestId('timer')).toHaveAttribute('data-remaining-ms', '0');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'done');

    const st = await serverState(request, exam, sid);
    expect(st.status).not.toBe('in_progress');
    expect(st.result.score).toBe(2);
  });

  test('UI-11: unanswered exam expiring still shows a 0 / 5 result (nothing hangs)', async ({ page, request }) => {
    const exam = await createExam(request, 4);
    await startUI(page, exam, uid('s'));
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('result-score')).toHaveText('0 / 5 (0%)');
  });

  test('UI-12: double-clicking Submit sends one request and produces one result', async ({ page, request }) => {
    const exam = await createExam(request, 60);
    const sid = uid('s');
    await startUI(page, exam, sid);
    await page.getByTestId('q-1-opt-2').check();
    let submits = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/submit')) submits++; });
    await page.getByTestId('submit-btn').dblclick();
    await expect(page.getByTestId('result')).toBeVisible();
    await expect(page.getByTestId('result-score')).toHaveText('1 / 5 (20%)');
    expect(submits).toBe(1);
  });

  test('UI-13: re-opening the exam after it finished shows the result and no new timer', async ({ page, request }) => {
    const exam = await createExam(request, 60);
    const sid = uid('s');
    await startUI(page, exam, sid);
    await page.getByTestId('q-4-input').fill('144');
    await page.getByTestId('submit-btn').click();
    await expect(page.getByTestId('result')).toBeVisible();

    await page.goto(`/?exam=${exam}`);
    await page.getByTestId('student-id').fill(sid);
    await page.getByTestId('start-btn').click();
    await expect(page.getByTestId('result')).toBeVisible();
    await expect(page.getByTestId('result-score')).toHaveText('1 / 5 (20%)');
    await expect(page.getByTestId('submit-btn')).toBeHidden();
  });
});

test.describe('Network disconnects in the browser', () => {
  test('UI-14: going offline is shown; answers are kept and synced on reconnect', async ({ page, request, context }) => {
    const exam = await createExam(request, 90);
    const sid = uid('s');
    await startUI(page, exam, sid);

    await context.setOffline(true);
    await expect(page.getByTestId('net-status')).toHaveAttribute('data-online', 'false');
    await page.getByTestId('q-1-opt-2').check();
    await page.getByTestId('q-4-input').fill('144');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', /Offline/, { timeout: 5000 });

    // The server has not seen anything yet.
    expect((await serverState(request, exam, sid)).answers).toEqual({});

    await context.setOffline(false);
    await expect(page.getByTestId('net-status')).toHaveAttribute('data-online', 'true');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'Saved', { timeout: 8000 });
    const answers = (await serverState(request, exam, sid)).answers;
    expect(answers[`${exam}:1`]).toBe(2);
    expect(answers[`${exam}:4`]).toBe(144);
  });

  test('UI-15: timer keeps running while offline and is correct on reconnect', async ({ page, request, context }, testInfo) => {
    const exam = await createExam(request, 90);
    const sid = uid('s');
    await startUI(page, exam, sid);
    const st = await serverState(request, exam, sid);

    await context.setOffline(true);
    await wait(5000);
    expect(await uiRemaining(page)).toBeLessThan(86_000); // kept counting with no network at all
    await context.setOffline(false);
    await wait(1200);
    const { drift } = await sampleDrift(page, request, st.attemptId);
    note(testInfo, 'drift-after-5s-offline-ms', Math.round(drift));
    expect(Math.abs(drift)).toBeLessThan(TOL + 200);
  });

  test('UI-16: answers that never reached the server survive a page reload (recovered from the device) and sync later', async ({ page, request }) => {
    const exam = await createExam(request, 90);
    const sid = uid('s');
    await startUI(page, exam, sid);

    // Block ONLY the autosave endpoint so the page itself can still reload (setOffline would block that too).
    const blockSaves = (route) => route.abort('connectionfailed');
    await page.route('**/api/attempts/*/answers', blockSaves);
    await page.getByTestId('q-5-input').fill('3.14');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', /Offline/, { timeout: 5000 });
    expect((await serverState(request, exam, sid)).answers).toEqual({}); // server really has nothing

    // Student refreshes (or the browser crashes) while saves are still failing.
    await page.reload();
    await page.getByTestId('student-id').fill(sid);
    await page.getByTestId('start-btn').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('q-5-input')).toHaveValue('3.14');             // restored from localStorage
    expect((await serverState(request, exam, sid)).answers).toEqual({});          // still not on the server

    // Connectivity returns: the recovered answer is pushed automatically.
    await page.unroute('**/api/attempts/*/answers', blockSaves);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'Saved', { timeout: 8000 });
    expect((await serverState(request, exam, sid)).answers[`${exam}:5`]).toBe(3.14);
  });

  test('UI-17: clicking Submit while offline retries automatically and succeeds on reconnect', async ({ page, request, context }) => {
    const exam = await createExam(request, 90);
    const sid = uid('s');
    await startUI(page, exam, sid);
    await page.getByTestId('q-1-opt-2').check();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'Saved');

    await context.setOffline(true);
    await page.getByTestId('q-2-opt-1').check();
    await page.getByTestId('submit-btn').click();
    await expect(page.getByTestId('submit-note')).toContainText(/retry/i, { timeout: 5000 });
    await expect(page.getByTestId('result')).toBeHidden();

    await context.setOffline(false);
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('result-score')).toHaveText('2 / 5 (40%)'); // includes the answer given offline
  });

  test('UI-18: offline answer made before the deadline, reconnect before the deadline: counted', async ({ page, request, context }) => {
    const exam = await createExam(request, 12);
    const sid = uid('s');
    await startUI(page, exam, sid);
    await context.setOffline(true);
    await page.getByTestId('q-1-opt-2').check();
    await wait(1500);
    await context.setOffline(false);
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 20_000 }); // auto-submit at 00:00
    await expect(page.getByTestId('result-score')).toHaveText('1 / 5 (20%)');
  });

  test('UI-19: offline THROUGH the deadline + grace: server auto-submits what it had; late offline answers are not counted', async ({ page, request, context }, testInfo) => {
    const exam = await createExam(request, 8);
    const sid = uid('s');
    await startUI(page, exam, sid);
    await page.getByTestId('q-1-opt-2').check();   // reaches the server
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'Saved');

    await context.setOffline(true);
    await page.getByTestId('q-4-input').fill('144'); // never reaches the server in time
    await wait(8000 + 1500 + 1500);                  // past deadline + grace + sweeper tick

    const st = await serverState(request, exam, sid);
    expect(st.status).toBe('auto_submitted');         // closed by the server sweeper while the student was offline
    expect(st.result.score).toBe(1);

    await context.setOffline(false);
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('result-score')).toHaveText('1 / 5 (20%)');
    await expect(page.getByTestId('result-meta')).toHaveAttribute('data-reason', 'timer_expired');
    note(testInfo, 'business-rule', 'answers entered offline and not synced before deadline+grace are not counted');
  });
});
