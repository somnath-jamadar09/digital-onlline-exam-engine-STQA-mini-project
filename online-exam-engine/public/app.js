'use strict';
/*
 * Student examination and admin evaluation application.
 *
 * Timer correctness rules:
 *  - The deadline lives on the server. The client only ever DISPLAYS it.
 *  - Remaining time = deadlinePerf - performance.now(). performance.now() is monotonic and
 *    unaffected by the student changing the OS clock or by timezone / NTP jumps.
 *  - deadlinePerf is (re)anchored from the server's remainingMs, compensated by half the round trip.
 *  - Tab throttling cannot cause drift because we always recompute remaining from performance.now().
 */
(function () {
  const params = new URLSearchParams(location.search);
  let EXAM_ID = params.get('exam') || 'demo';
  const SYNC_MS = Number(params.get('sync')) || 5000;
  const AUTOSAVE_DEBOUNCE_MS = Number(params.get('debounce')) || 300;
  const RETRY_MS = Number(params.get('retry')) || 1500;
  const LS_KEY = (sid) => `exam:${EXAM_ID}:${sid}`;
  const AUTH_KEY = 'exam_auth_token';

  const $ = (id) => document.getElementById(id);

  // ---------- Ripple animation helper ----------
  function addRipple(btn) {
    if (btn._rippleAttached) return;
    btn._rippleAttached = true;
    btn.addEventListener('click', function (e) {
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top  - size / 2;
      const circle = document.createElement('span');
      circle.className = 'ripple-circle';
      circle.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;`;
      btn.appendChild(circle);
      circle.addEventListener('animationend', () => circle.remove());
    });
  }
  function attachRipples() {
    document.querySelectorAll('button').forEach(addRipple);
  }

  // ---------- Auth state ----------
  let authUser = null; // { id, username, role, displayName }
  let authToken = localStorage.getItem(AUTH_KEY) || null;

  function getAuthHeaders() {
    return authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
  }

  const el = {
    // Admin auth elements
    adminAuthCard:  $('admin-auth-card'),
    adminContent:   $('admin-content'),
    adminAuthUser:  $('admin-auth-user'),
    adminAuthPass:  $('admin-auth-pass'),
    adminAuthError: $('admin-auth-error'),
    adminLoginBtn:  $('admin-login-btn'),
    adminDemoBtn:   $('admin-demo-btn'),
    adminLogoutBtn: $('admin-logout-btn'),

    // Main app
    title: $('exam-title'), timer: $('timer'), net: $('net-status'), save: $('save-status'),
    login: $('login'), sid: $('student-id'), start: $('start-btn'), loginErr: $('login-error'),
    exam: $('exam'), form: $('questions'), submit: $('submit-btn'), note: $('submit-note'),
    result: $('result'), score: $('result-score'), meta: $('result-meta'), breakdown: $('result-breakdown'),
    tabStudent: $('tab-student'), tabAdmin: $('tab-admin'),
    studentView: $('student-view'), adminView: $('admin-view'),
    examSelect: $('exam-select-dropdown'),
    loginTitle: $('login-exam-title'), loginDuration: $('login-exam-duration'),
    progressText: $('q-progress-text'), progressFill: $('q-progress-fill'),
    restartBtn: $('restart-view-btn'),
    adminExamLabel: $('admin-active-exam-label'), adminRefreshBtn: $('admin-refresh-btn'),
    statTotal: $('stat-total'), statInProgress: $('stat-inprogress'),
    statSubmitted: $('stat-submitted'), statAutoSubmitted: $('stat-auto-submitted'),
    statAvg: $('stat-avg'), statAvgSub: $('stat-avg-sub'),
    statRange: $('stat-range'), statRangeSub: $('stat-range-sub'),
    createExamBtn: $('create-exam-btn'), addQuestionBtn: $('add-question-btn'),
    questionsContainer: $('questions-builder-container'),
    createToast: $('create-exam-toast'),
    newExamId: $('new-exam-id'), newExamTitle: $('new-exam-title'), newExamDuration: $('new-exam-duration'),
    // User management
    userAvatarBtn: $('user-avatar-btn'), userInitial: $('user-initial'),
    userDropdown: $('user-dropdown'), logoutBtn: $('logout-btn'),
    ddUsername: $('dd-username'), ddRole: $('dd-role'),
    addUserToggleBtn: $('add-user-toggle-btn'),
    addUserForm: $('add-user-form'),
    umUsername: $('um-username'), umDisplayname: $('um-displayname'),
    umPassword: $('um-password'), umRole: $('um-role'),
    umCreateBtn: $('um-create-btn'), umCancelBtn: $('um-cancel-btn'),
    umError: $('um-error'), umToast: $('um-toast'),
    usersTbody: $('users-tbody'),
  };

  let S = null; // student session state
  let currentQuestions = [];
  const setState = (v) => { document.body.dataset.state = v; };

  // ---------- network helpers ----------
  async function api(method, url, body, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...getAuthHeaders() };
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON */ }
      setOnline(true);
      return { status: res.status, ok: res.ok, data };
    } catch (e) {
      setOnline(false);
      return { status: 0, ok: false, data: null, networkError: true };
    } finally {
      clearTimeout(to);
    }
  }

  function setOnline(on) {
    el.net.dataset.online = String(on);
    el.net.textContent = on ? 'Online' : 'Offline';
    el.net.className = 'pill ' + (on ? 'ok' : 'bad');
    if (on && S && S.dirty) scheduleSave(0);
  }
  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('online', () => {
    setOnline(true);
    if (S && S.running) {
      resync();
      if (S.dirty) scheduleSave(0);
      if (S.pendingSubmit) doSubmit();
    }
  });

  function setSaveStatus(text, cls) {
    const icons = { ok: '✓ ', warn: '⟳ ', bad: '✕ ', '': '' };
    el.save.textContent = text ? (icons[cls] || '') + text : '\u00a0';
    el.save.className = 'pill ' + (cls || '');
    el.save.dataset.status = text || '';
  }

  // ---------- timer ----------
  function anchor(remainingMs, tSent, tRecv) {
    const mid = tSent + (tRecv - tSent) / 2;
    S.deadlinePerf = mid + remainingMs;
  }
  const remaining = () => (S && S.deadlinePerf != null ? S.deadlinePerf - performance.now() : 0);

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function tick() {
    if (!S || !S.running) return;
    const r = remaining();
    el.timer.textContent = fmt(r);
    el.timer.dataset.remainingMs = String(Math.max(0, Math.round(r)));
    el.timer.className = 'timer' + (r <= 10000 ? ' critical' : r <= 60000 ? ' low' : '');
    if (r <= 0 && !S.pendingSubmit && !S.submitted) {
      S.autoSubmitted = true;
      doSubmit();
    }
  }

  async function resync() {
    if (!S || !S.running) return;
    const t0 = performance.now();
    const r = await api('GET', `/api/attempts/${S.attemptId}/sync`, null, 4000);
    const t1 = performance.now();
    if (!r.ok) return;
    if (r.data.status !== 'in_progress') return finishFromServer();
    anchor(r.data.remainingMs, t0, t1);
    tick();
  }

  // ---------- rendering ----------
  function updateProgress() {
    if (!currentQuestions.length || !S) return;
    const total = currentQuestions.length;
    let answered = 0;
    currentQuestions.forEach((q) => {
      const a = S.answers[q.id];
      if (a !== undefined && a !== null && (!Array.isArray(a) || a.length > 0)) answered++;
    });
    if (el.progressText) el.progressText.textContent = `Answered ${answered} of ${total}`;
    if (el.progressFill) el.progressFill.style.width = `${Math.round((answered / total) * 100)}%`;
  }

  function renderQuestions(questions, answers) {
    currentQuestions = questions;
    el.form.innerHTML = '';
    questions.forEach((q, i) => {
      const box = document.createElement('div');
      box.className = 'q';
      box.dataset.testid = `q-${i + 1}`;

      const header = document.createElement('div');
      header.className = 'q-header';
      const badgeGroup = document.createElement('div');
      badgeGroup.className = 'q-badge-group';

      const typeBadge = document.createElement('span');
      typeBadge.className = 'q-type-badge';
      typeBadge.textContent = q.type === 'single' ? 'Single Choice' : q.type === 'multi' ? 'Multiple Select' : 'Numeric';
      badgeGroup.appendChild(typeBadge);

      const ptBadge = document.createElement('span');
      ptBadge.className = 'q-points-badge';
      ptBadge.textContent = `${q.points || 1} pt${(q.points || 1) > 1 ? 's' : ''}`;
      badgeGroup.appendChild(ptBadge);

      header.appendChild(badgeGroup);
      box.appendChild(header);

      const t = document.createElement('div');
      t.className = 'q-text';
      t.textContent = `${i + 1}. ${q.text}`;
      box.appendChild(t);

      const cur = answers[q.id];
      if (q.type === 'numeric') {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.placeholder = 'Enter numerical answer…';
        inp.setAttribute('data-testid', `q-${i + 1}-input`);
        if (cur !== undefined) inp.value = cur;
        inp.addEventListener('input', () => {
          setAnswer(q.id, inp.value === '' ? undefined : Number(inp.value));
          updateProgress();
        });
        box.appendChild(inp);

        if (q.tolerance) {
          const tolHint = document.createElement('div');
          tolHint.className = 'numeric-helper';
          tolHint.textContent = `Tolerance allowed: ±${q.tolerance}`;
          box.appendChild(tolHint);
        }
      } else {
        q.options.forEach((label, oi) => {
          const row = document.createElement('label');
          row.className = 'opt';
          const inp = document.createElement('input');
          inp.type = q.type === 'single' ? 'radio' : 'checkbox';
          inp.name = q.id;
          inp.value = String(oi);
          inp.setAttribute('data-testid', `q-${i + 1}-opt-${oi}`);
          inp.checked = q.type === 'single' ? cur === oi : Array.isArray(cur) && cur.includes(oi);
          inp.addEventListener('change', () => {
            if (q.type === 'single') {
              setAnswer(q.id, oi);
            } else {
              const set = new Set(Array.isArray(S.answers[q.id]) ? S.answers[q.id] : []);
              inp.checked ? set.add(oi) : set.delete(oi);
              setAnswer(q.id, set.size ? [...set].sort((a, b) => a - b) : undefined);
            }
            updateProgress();
          });
          row.append(inp, document.createTextNode(label));
          box.appendChild(row);
        });
      }
      el.form.appendChild(box);
    });
    updateProgress();
    attachRipples();
  }

  function showResult(result) {
    if (S) { S.running = false; S.submitted = true; }
    setState('done');
    el.exam.hidden = true;
    el.result.hidden = false;
    el.score.textContent = `${result.score} / ${result.maxScore} (${result.percentage}%)`;
    el.meta.textContent = result.reason === 'timer_expired' ? 'Time expired: auto-submitted.' : 'Submitted on time.';
    el.meta.dataset.reason = result.reason || '';
    el.breakdown.innerHTML = '';
    result.breakdown.forEach((b, i) => {
      const li = document.createElement('li');
      li.className = b.correct ? 'ok' : 'bad';
      li.textContent = `Question ${i + 1}: ${b.correct ? 'correct' : b.answered ? 'incorrect' : 'not answered'} (${b.awarded}/${b.max})`;
      el.breakdown.appendChild(li);
    });
    el.timer.className = 'timer';
    el.timer.dataset.remainingMs = '0';
    el.timer.textContent = '00:00';
    if (S) {
      try { localStorage.removeItem(LS_KEY(S.studentId)); } catch (_) {}
    }
  }

  async function finishFromServer() {
    const r = await api('GET', `/api/attempts/${S.attemptId}/result`);
    if (r.ok) showResult(r.data);
  }

  // ---------- answers & autosave ----------
  function setAnswer(qid, value) {
    if (!S) return;
    if (value === undefined) delete S.answers[qid]; else S.answers[qid] = value;
    S.seq += 1;
    S.dirty = true;
    persistLocal();
    setSaveStatus('Saving…', 'warn');
    scheduleSave(AUTOSAVE_DEBOUNCE_MS);
  }

  function persistLocal() {
    try { localStorage.setItem(LS_KEY(S.studentId), JSON.stringify({ answers: S.answers, seq: S.seq })); } catch (_) {}
  }

  function scheduleSave(delay) {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flushSave, delay);
  }

  async function flushSave() {
    if (!S || !S.running || S.saving || !S.dirty) return;
    S.saving = true;
    const seqAtSend = S.seq;
    const r = await api('PUT', `/api/attempts/${S.attemptId}/answers`, { answers: S.answers, seq: seqAtSend });
    S.saving = false;
    if (r.ok) {
      if (S.seq === seqAtSend) { S.dirty = false; setSaveStatus('Saved', 'ok'); }
      else scheduleSave(0);
    } else if (r.status === 409) {
      finishFromServer();
    } else {
      setSaveStatus(r.networkError ? 'Offline: saved locally' : 'Retrying…', 'bad');
      scheduleSave(RETRY_MS);
    }
  }

  // ---------- submit ----------
  async function doSubmit() {
    if (!S || S.submitted || S.submitting) return;
    S.submitting = true;
    S.pendingSubmit = true;
    setState('submitting');
    el.submit.disabled = true;
    el.note.textContent = S.autoSubmitted ? 'Time is up: submitting…' : 'Submitting…';
    clearTimeout(S.saveTimer);
    const r = await api('POST', `/api/attempts/${S.attemptId}/submit`, { answers: S.answers, seq: S.seq }, 10000);
    S.submitting = false;
    if (r.ok) {
      S.pendingSubmit = false;
      showResult(r.data.result);
      return;
    }
    el.note.textContent = 'Connection lost: will retry automatically (your answers are saved on this device).';
    setTimeout(doSubmit, RETRY_MS);
  }

  // ---------- start / resume ----------
  async function start(studentId) {
    el.loginErr.textContent = '';
    const t0 = performance.now();
    const r = await api('POST', `/api/exams/${encodeURIComponent(EXAM_ID)}/start`, { studentId });
    const t1 = performance.now();
    if (!r.ok) {
      el.loginErr.textContent = r.networkError ? 'Cannot reach the server. Check your connection.' :
        (r.data && r.data.error) || 'Could not start the exam.';
      return;
    }
    const d = r.data;
    S = {
      studentId, attemptId: d.attemptId, answers: d.answers || {}, seq: d.answerSeq || 0,
      dirty: false, running: true, saving: false, submitted: false, submitting: false, pendingSubmit: false,
    };
    el.title.textContent = d.exam.title;
    if (d.status !== 'in_progress') {
      el.login.hidden = true;
      return showResult(d.result);
    }

    try {
      const local = JSON.parse(localStorage.getItem(LS_KEY(studentId)) || 'null');
      if (local && local.seq > S.seq) {
        S.answers = local.answers;
        S.seq = local.seq;
        S.dirty = true;
      }
    } catch (_) {}

    anchor(d.remainingMs, t0, t1);
    el.login.hidden = true;
    el.exam.hidden = false;
    renderQuestions(d.questions, S.answers);
    setState('running');
    tick();
    S.tickTimer = setInterval(tick, 200);
    S.syncTimer = setInterval(resync, SYNC_MS);
    if (S.dirty) scheduleSave(0);
  }

  // ---------- exam listing & info ----------
  async function loadExams() {
    const r = await api('GET', '/api/exams');
    if (!r.ok || !Array.isArray(r.data)) return;
    if (el.examSelect) {
      el.examSelect.innerHTML = '';
      r.data.forEach((ex) => {
        const opt = document.createElement('option');
        opt.value = ex.id;
        opt.textContent = `${ex.title} (${Math.round(ex.duration_ms / 1000)}s)`;
        if (ex.id === EXAM_ID) opt.selected = true;
        el.examSelect.appendChild(opt);
      });
      el.examSelect.addEventListener('change', () => {
        EXAM_ID = el.examSelect.value;
        const u = new URL(location);
        u.searchParams.set('exam', EXAM_ID);
        window.history.replaceState({}, '', u.toString());
        updateExamOverview(r.data);
        if (el.adminView && !el.adminView.hidden) loadAdminStats();
      });
    }
    updateExamOverview(r.data);
  }

  function updateExamOverview(examsList) {
    const cur = examsList && examsList.find((e) => e.id === EXAM_ID);
    if (cur) {
      if (el.loginTitle) el.loginTitle.textContent = cur.title;
      if (el.loginDuration) {
        const s = Math.round(cur.duration_ms / 1000);
        el.loginDuration.textContent = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? (s % 60) + 's' : ''}` : `${s} seconds`;
      }
      if (el.adminExamLabel) el.adminExamLabel.textContent = `Exam: ${cur.title} (${cur.id})`;
    } else {
      if (el.loginTitle) el.loginTitle.textContent = EXAM_ID;
      if (el.adminExamLabel) el.adminExamLabel.textContent = `Exam ID: ${EXAM_ID}`;
    }
  }

  // ---------- admin analytics ----------
  async function loadAdminStats() {
    if (!el.statTotal) return;
    const r = await api('GET', `/api/admin/exams/${encodeURIComponent(EXAM_ID)}/results`);
    if (!r.ok || !r.data) return;
    const d = r.data;
    el.statTotal.textContent = d.total ?? 0;
    el.statInProgress.textContent = d.inProgress ?? 0;
    el.statSubmitted.textContent = d.submitted ?? 0;
    el.statAutoSubmitted.textContent = d.autoSubmitted ?? 0;
    el.statAvg.textContent = d.avgScore != null ? Number(d.avgScore).toFixed(1) : '--';
    if (el.statAvgSub) el.statAvgSub.textContent = d.possible ? `Max possible: ${d.possible}` : 'Out of total score';
    el.statRange.textContent = d.minScore != null && d.maxScore != null ? `${d.minScore} — ${d.maxScore}` : '--';
  }

  // ---------- user management ----------
  async function loadUsers() {
    if (!el.usersTbody) return;
    el.usersTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading…</td></tr>';
    const r = await api('GET', '/api/auth/users');
    if (!r.ok || !Array.isArray(r.data)) {
      el.usersTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Failed to load users.</td></tr>';
      return;
    }
    if (r.data.length === 0) {
      el.usersTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No users found.</td></tr>';
      return;
    }
    el.usersTbody.innerHTML = '';
    r.data.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escHtml(u.username)}</strong></td>
        <td>${escHtml(u.display_name || u.username)}</td>
        <td><span class="user-role-badge ${escHtml(u.role)}">${escHtml(u.role)}</span></td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : '--'}</td>
        <td>${u.role !== 'admin' ? `<button class="btn-del" data-uid="${escHtml(u.id)}">Remove</button>` : ''}</td>
      `;
      el.usersTbody.appendChild(tr);
    });
    // Attach delete handlers
    el.usersTbody.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this user?')) return;
        const uid = btn.dataset.uid;
        const r2 = await api('DELETE', `/api/auth/users/${uid}`);
        if (r2.ok) loadUsers(); else alert('Failed to remove user.');
      });
    });
  }

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function createUser() {
    const username = el.umUsername.value.trim();
    const displayName = el.umDisplayname.value.trim();
    const password = el.umPassword.value;
    const role = el.umRole.value;
    el.umError.textContent = '';

    if (!username || !password) { el.umError.textContent = 'Username and password are required.'; return; }
    if (password.length < 4) { el.umError.textContent = 'Password must be at least 4 characters.'; return; }

    el.umCreateBtn.disabled = true;
    const r = await api('POST', '/api/auth/register', { username, password, displayName, role });
    el.umCreateBtn.disabled = false;

    if (r.ok) {
      el.umUsername.value = ''; el.umDisplayname.value = '';
      el.umPassword.value = ''; el.umRole.value = 'student';
      showUmToast(`✓ User "${username}" created!`, 'ok');
      loadUsers();
    } else {
      el.umError.textContent = (r.data && r.data.message) || 'Failed to create user.';
    }
  }

  function showUmToast(msg, type) {
    el.umToast.textContent = msg;
    el.umToast.className = `toast show ${type}`;
    setTimeout(() => { el.umToast.className = 'toast'; }, 5000);
  }

  // ---------- question builder ----------
  let builderQuestions = [];
  function addBuilderQuestion(type = 'single') {
    const qObj = {
      type,
      text: '',
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      answer: type === 'single' ? 0 : type === 'multi' ? [0] : 0,
      tolerance: 0.01,
      points: 1,
    };
    builderQuestions.push(qObj);
    renderBuilderUI();
  }

  function renderBuilderUI() {
    if (!el.questionsContainer) return;
    el.questionsContainer.innerHTML = '';
    builderQuestions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'question-builder-item';

      const head = document.createElement('div');
      head.className = 'question-builder-header';
      head.innerHTML = `<strong>Question ${idx + 1}</strong>`;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary';
      removeBtn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
      removeBtn.textContent = '✕ Remove';
      removeBtn.onclick = () => { builderQuestions.splice(idx, 1); renderBuilderUI(); };
      head.appendChild(removeBtn);
      card.appendChild(head);

      const typeRow = document.createElement('div');
      typeRow.className = 'form-row';
      typeRow.innerHTML = `
        <div>
          <label>Question Type</label>
          <select class="b-type" style="width: 100%;">
            <option value="single" ${q.type === 'single' ? 'selected' : ''}>Single Choice</option>
            <option value="multi" ${q.type === 'multi' ? 'selected' : ''}>Multiple Select</option>
            <option value="numeric" ${q.type === 'numeric' ? 'selected' : ''}>Numeric (with tolerance)</option>
          </select>
        </div>
        <div>
          <label>Points</label>
          <input type="number" class="b-points" min="1" value="${q.points}" style="width: 100%;">
        </div>
      `;
      const typeSelect = typeRow.querySelector('.b-type');
      typeSelect.onchange = () => {
        q.type = typeSelect.value;
        if (q.type === 'single') q.answer = 0;
        else if (q.type === 'multi') q.answer = [0];
        else if (q.type === 'numeric') q.answer = 100;
        renderBuilderUI();
      };
      const ptsInput = typeRow.querySelector('.b-points');
      ptsInput.oninput = () => { q.points = Number(ptsInput.value) || 1; };
      card.appendChild(typeRow);

      const textLabel = document.createElement('label');
      textLabel.textContent = 'Question Prompt / Text';
      card.appendChild(textLabel);
      const textInp = document.createElement('input');
      textInp.type = 'text';
      textInp.value = q.text;
      textInp.placeholder = 'e.g. What is the derivative of sin(x)?';
      textInp.oninput = () => { q.text = textInp.value; };
      card.appendChild(textInp);

      if (q.type === 'numeric') {
        const numRow = document.createElement('div');
        numRow.className = 'form-row';
        numRow.style.marginTop = '12px';
        numRow.innerHTML = `
          <div>
            <label>Correct Value</label>
            <input type="number" step="any" class="b-num-ans" value="${q.answer}">
          </div>
          <div>
            <label>Tolerance (±)</label>
            <input type="number" step="any" class="b-num-tol" value="${q.tolerance}">
          </div>
        `;
        numRow.querySelector('.b-num-ans').oninput = (e) => { q.answer = Number(e.target.value); };
        numRow.querySelector('.b-num-tol').oninput = (e) => { q.tolerance = Number(e.target.value); };
        card.appendChild(numRow);
      } else {
        const optsDiv = document.createElement('div');
        optsDiv.className = 'options-builder';
        const optTitle = document.createElement('label');
        optTitle.textContent = q.type === 'single' ? 'Options (Select the correct radio):' : 'Options (Check all correct answers):';
        optsDiv.appendChild(optTitle);

        q.options.forEach((optText, oi) => {
          const row = document.createElement('div');
          row.className = 'option-builder-row';
          const selector = document.createElement('input');
          selector.type = q.type === 'single' ? 'radio' : 'checkbox';
          selector.name = `ans-q-${idx}`;
          selector.checked = q.type === 'single' ? q.answer === oi : Array.isArray(q.answer) && q.answer.includes(oi);
          selector.onchange = () => {
            if (q.type === 'single') {
              q.answer = oi;
            } else {
              const set = new Set(Array.isArray(q.answer) ? q.answer : []);
              selector.checked ? set.add(oi) : set.delete(oi);
              q.answer = [...set].sort((a, b) => a - b);
            }
          };

          const optInput = document.createElement('input');
          optInput.type = 'text';
          optInput.value = optText;
          optInput.oninput = () => { q.options[oi] = optInput.value; };

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'secondary';
          delBtn.style.padding = '6px 10px';
          delBtn.textContent = '✕';
          delBtn.onclick = () => {
            if (q.options.length <= 2) { alert('Each question must have at least 2 options.'); return; }
            q.options.splice(oi, 1);
            if (q.type === 'single' && q.answer >= q.options.length) q.answer = 0;
            renderBuilderUI();
          };

          row.append(selector, optInput, delBtn);
          optsDiv.appendChild(row);
        });

        const addOptBtn = document.createElement('button');
        addOptBtn.type = 'button';
        addOptBtn.className = 'secondary';
        addOptBtn.style.cssText = 'align-self: flex-start; margin-top: 6px; padding: 6px 12px; font-size: 13px;';
        addOptBtn.textContent = '➕ Add Option';
        addOptBtn.onclick = () => {
          q.options.push(`Option ${String.fromCharCode(65 + q.options.length)}`);
          renderBuilderUI();
        };
        optsDiv.appendChild(addOptBtn);
        card.appendChild(optsDiv);
      }

      el.questionsContainer.appendChild(card);
    });
    attachRipples();
  }

  async function handleCreateExam() {
    const rawId = (el.newExamId.value.trim() || `ex-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const title = el.newExamTitle.value.trim();
    const durationSec = Number(el.newExamDuration.value);

    if (!title) { showToast('Please provide an exam title.', 'bad'); return; }
    if (!Number.isFinite(durationSec) || durationSec < 5) { showToast('Duration must be at least 5 seconds.', 'bad'); return; }
    if (!builderQuestions.length) { showToast('Add at least one question.', 'bad'); return; }

    const payload = {
      id: rawId,
      title,
      durationSec,
      questions: builderQuestions.map((q) => ({
        type: q.type,
        text: q.text || 'Question Prompt',
        options: q.type === 'numeric' ? [] : q.options,
        answer: q.answer,
        tolerance: q.type === 'numeric' ? q.tolerance : 0,
        points: q.points || 1,
      })),
    };

    const r = await api('POST', '/api/admin/exams', payload);
    if (r.ok) {
      showToast(`✓ Exam "${title}" published! (ID: ${rawId})`, 'ok');
      await loadExams();
      EXAM_ID = rawId;
      if (el.examSelect) el.examSelect.value = rawId;
      loadAdminStats();
    } else {
      showToast(r.data && r.data.error === 'exam_exists' ? 'An exam with this ID already exists. Try another ID.' : 'Failed to create exam.', 'bad');
    }
  }

  function showToast(msg, type) {
    if (!el.createToast) return;
    el.createToast.textContent = msg;
    el.createToast.className = `toast show ${type}`;
    setTimeout(() => { el.createToast.className = 'toast'; }, 6000);
  }

  // ============================================================
  // AUTH SYSTEM (Clean & Basic)
  // ============================================================
  let isAdminUnlocked = false;

  function updateAuthUI() {
    if (isAdminUnlocked) {
      if (el.adminAuthCard) el.adminAuthCard.hidden = true;
      if (el.adminContent) el.adminContent.hidden = false;
      if (el.userInitial) el.userInitial.textContent = 'A';
      if (el.ddUsername) el.ddUsername.textContent = 'Administrator';
      if (el.ddRole) el.ddRole.textContent = 'admin';
    } else {
      if (el.adminAuthCard) el.adminAuthCard.hidden = false;
      if (el.adminContent) el.adminContent.hidden = true;
      const initial = authUser && authUser.studentId ? authUser.studentId[0].toUpperCase() : '?';
      if (el.userInitial) el.userInitial.textContent = initial;
      if (el.ddUsername) el.ddUsername.textContent = authUser && authUser.studentId ? authUser.studentId : 'Guest Student';
      if (el.ddRole) el.ddRole.textContent = 'student';
    }
  }

  async function tryAdminLogin() {
    const username = (el.adminAuthUser && el.adminAuthUser.value.trim()) || 'admin';
    const password = (el.adminAuthPass && el.adminAuthPass.value) || '';
    if (el.adminAuthError) el.adminAuthError.textContent = '';

    if (!username || !password) {
      if (el.adminAuthError) el.adminAuthError.textContent = 'Username and password required.';
      return;
    }

    if (el.adminLoginBtn) el.adminLoginBtn.disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.token) {
        authToken = data.token;
        localStorage.setItem(AUTH_KEY, authToken);
        isAdminUnlocked = true;
        updateAuthUI();
        loadAdminStats();
        loadUsers();
        showToast('✓ Admin Dashboard unlocked!', 'ok');
      } else {
        if (el.adminAuthError) el.adminAuthError.textContent = (data && data.message) || 'Invalid admin credentials.';
      }
    } catch (_) {
      if (el.adminAuthError) el.adminAuthError.textContent = 'Server connection error.';
    } finally {
      if (el.adminLoginBtn) el.adminLoginBtn.disabled = false;
    }
  }

  function adminLogout() {
    if (authToken) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
      }).catch(() => {});
    }
    authToken = null;
    localStorage.removeItem(AUTH_KEY);
    isAdminUnlocked = false;
    updateAuthUI();
    showToast('Admin dashboard locked.', '');
  }

  async function checkExistingSession() {
    if (!authToken) {
      updateAuthUI();
      return;
    }
    try {
      const r = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (r.ok) {
        const u = await r.json();
        if (u.role === 'admin') {
          isAdminUnlocked = true;
        }
      } else {
        localStorage.removeItem(AUTH_KEY);
        authToken = null;
      }
    } catch (_) {}
    updateAuthUI();
  }

  // ============================================================
  // EVENT BINDINGS — MAIN APP
  // ============================================================
  function initMainApp() {
    setState('login');

    // Student portal
    el.start.addEventListener('click', () => {
      const sid = el.sid.value.trim();
      if (!sid) { el.loginErr.textContent = 'Enter your student ID.'; return; }
      start(sid);
    });
    el.sid.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.start.click(); });
    el.submit.addEventListener('click', () => doSubmit());

    // Portal tabs
    el.tabStudent.addEventListener('click', () => {
      el.tabStudent.classList.add('active');
      el.tabAdmin.classList.remove('active');
      el.studentView.hidden = false;
      el.adminView.hidden = true;
    });
    el.tabAdmin.addEventListener('click', () => {
      el.tabAdmin.classList.add('active');
      el.tabStudent.classList.remove('active');
      el.studentView.hidden = true;
      el.adminView.hidden = false;
      if (isAdminUnlocked) {
        loadAdminStats();
        loadUsers();
      }
    });

    // Admin Auth bindings
    if (el.adminLoginBtn) el.adminLoginBtn.addEventListener('click', tryAdminLogin);
    if (el.adminAuthPass) el.adminAuthPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAdminLogin(); });
    if (el.adminAuthUser) el.adminAuthUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.adminAuthPass.focus(); });
    if (el.adminDemoBtn) {
      el.adminDemoBtn.addEventListener('click', () => {
        if (el.adminAuthUser) el.adminAuthUser.value = 'admin';
        if (el.adminAuthPass) el.adminAuthPass.value = 'admin123';
        tryAdminLogin();
      });
    }
    if (el.adminLogoutBtn) el.adminLogoutBtn.addEventListener('click', adminLogout);

    // User avatar / dropdown
    if (el.userAvatarBtn) {
      el.userAvatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.userDropdown.hidden = !el.userDropdown.hidden;
      });
    }
    document.addEventListener('click', () => { if (el.userDropdown) el.userDropdown.hidden = true; });
    if (el.logoutBtn) {
      el.logoutBtn.addEventListener('click', () => {
        if (isAdminUnlocked) adminLogout();
        else {
          el.result.hidden = true;
          el.exam.hidden = true;
          el.login.hidden = false;
          setState('login');
          authUser = null;
          updateAuthUI();
        }
      });
    }

    if (el.adminRefreshBtn) el.adminRefreshBtn.addEventListener('click', () => loadAdminStats());
    if (el.addQuestionBtn) el.addQuestionBtn.addEventListener('click', () => addBuilderQuestion('single'));
    if (el.createExamBtn) el.createExamBtn.addEventListener('click', handleCreateExam);

    if (el.restartBtn) {
      el.restartBtn.addEventListener('click', () => {
        el.result.hidden = true;
        el.login.hidden = false;
        setState('login');
      });
    }

    // User management toggle
    if (el.addUserToggleBtn) {
      el.addUserToggleBtn.addEventListener('click', () => {
        el.addUserForm.hidden = !el.addUserForm.hidden;
        if (!el.addUserForm.hidden) el.umUsername.focus();
      });
    }
    if (el.umCancelBtn) el.umCancelBtn.addEventListener('click', () => { el.addUserForm.hidden = true; });
    if (el.umCreateBtn) el.umCreateBtn.addEventListener('click', createUser);

    // Init builder + load data
    addBuilderQuestion('single');
    builderQuestions[0].text = 'Which component acts as the single source of truth for the deadline?';
    builderQuestions[0].options = ['Client Browser', 'Server Database Clock', 'Operating System Clock', 'Network Router'];
    builderQuestions[0].answer = 1;

    addBuilderQuestion('numeric');
    builderQuestions[1].text = 'What is the speed of light in vacuum (in x10^8 m/s, approx 3.0)?';
    builderQuestions[1].answer = 3;
    builderQuestions[1].tolerance = 0.05;

    renderBuilderUI();
    loadExams();
    attachRipples();

    const pre = params.get('student');
    if (pre) { el.sid.value = pre; start(pre); }
  }

  // ============================================================
  // BOOT
  // ============================================================
  attachRipples();
  initMainApp();
  checkExistingSession();
})();
