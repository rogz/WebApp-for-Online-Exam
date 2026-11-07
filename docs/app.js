/* Online Exam — student page.
 * Talks to the Google Apps Script backend (see apps-script/Code.gs).
 * Detects tab switches, leaving the window and second monitors, and voids the exam.
 */
(function () {
  'use strict';

  const API_URL = (window.EXAM_CONFIG && window.EXAM_CONFIG.API_URL) || '';
  const $ = (id) => document.getElementById(id);

  const state = {
    examId: new URLSearchParams(location.search).get('exam') || '',
    info: null,          // getExam response
    rules: { blurGraceSeconds: 0, requireMonitorCheck: true, blockCopyPaste: true },
    serverOffset: 0,     // serverNow - clientNow
    attemptId: null,
    student: null,
    questions: [],
    answers: {},
    endAt: null,         // client timestamp when time is up
    active: false,       // exam in progress, guards on
    voided: false,
    submitting: false,
    violations: [],
    warned5: false,
    warned1: false,
    oneAtATime: false,   // show one question at a time
    allowBack: true,     // may return to earlier questions (one-at-a-time mode)
    index: 0,            // current question in one-at-a-time mode
    locked: new Set(),   // questions that can no longer be changed
    cam: { required: false, warnings: 0, warningOpen: false, offenseArmed: true },
  };

  // ───────── API ─────────

  async function api(action, payload, tries = 1) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          // text/plain avoids a CORS preflight, which Apps Script does not support
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ action }, payload || {})),
          redirect: 'follow',
        });
        const data = await res.json();
        if (!data.ok) {
          const e = new Error(data.error || 'Something went wrong.');
          e.code = data.code;
          throw e;
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (err.code) throw err;           // server answered with an error: don't retry
        if (i < tries - 1) await sleep(1500 * (i + 1));
      }
    }
    const e = new Error('Could not reach the exam server. Check your internet connection.');
    e.code = 'NETWORK';
    e.cause = lastErr;
    throw e;
  }

  function beacon(action, payload) {
    try {
      const body = new Blob([JSON.stringify(Object.assign({ action }, payload))], { type: 'text/plain;charset=UTF-8' });
      return navigator.sendBeacon && navigator.sendBeacon(API_URL, body);
    } catch (e) { return false; }
  }

  // ───────── Screens ─────────

  function show(screen) {
    ['loading', 'error', 'rules', 'exam', 'result'].forEach((s) => { $('screen-' + s).hidden = s !== screen; });
    $('examBar').hidden = screen !== 'exam';
    window.scrollTo(0, 0);
  }

  function showError(msg) {
    $('errorText').textContent = msg;
    show('error');
  }

  function busy(on, text) {
    $('busyText').textContent = text || 'Please wait…';
    $('busyModal').hidden = !on;
  }

  // ───────── Monitor & browser checks ─────────

  /** 'single' | 'multiple' | 'unsupported' */
  function monitorStatus() {
    if (!window.screen || !('isExtended' in window.screen)) return 'unsupported';
    return window.screen.isExtended ? 'multiple' : 'single';
  }

  function setCheck(id, ok, text) {
    const li = $(id);
    li.className = ok ? 'ok' : 'bad';
    let msg = li.querySelector('.msg');
    if (!msg) { msg = document.createElement('span'); msg.className = 'msg'; li.appendChild(msg); }
    msg.textContent = text;
  }

  function preChecksPass() {
    const m = monitorStatus();
    const browserOk = m !== 'unsupported' || !state.rules.requireMonitorCheck;
    setCheck('checkBrowser', browserOk, m === 'unsupported'
      ? (state.rules.requireMonitorCheck
        ? 'This browser cannot check for extra monitors. Open this link in Google Chrome or Microsoft Edge on a laptop or desktop computer.'
        : 'This browser cannot check for extra monitors. Make sure only one screen is connected.')
      : 'Supported');
    if (m === 'unsupported') setCheck('checkMonitor', !state.rules.requireMonitorCheck, 'Cannot be checked in this browser');
    else setCheck('checkMonitor', m === 'single', m === 'single'
      ? 'One screen detected'
      : 'A second monitor is connected. Disconnect it to start the exam.');
    return browserOk && m !== 'multiple' && cameraCheckPasses();
  }

  // ───────── Camera ─────────

  const CAM_TEXT = {
    OFF: 'Camera off',
    LOADING: 'Loading face detection…',
    OK: '✓ Face detected',
    NO_FACE: 'No face detected',
    CAMERA_BLOCKED: 'Camera is covered or too dark',
    MULTIPLE_FACES: 'More than one person in view',
    PHONE_DETECTED: 'Phone detected',
    CAMERA_OFF: 'Camera turned off',
  };
  const CAM_HELP = {
    NO_FACE: 'Make sure your whole face is visible and well lit, facing the screen.',
    CAMERA_BLOCKED: 'Uncover the camera and make sure the room is bright enough.',
    MULTIPLE_FACES: 'Only you may be in front of the camera.',
    PHONE_DETECTED: 'Put your phone away, out of the camera\'s view.',
    CAMERA_OFF: 'Your camera stopped. Turn it back on to continue.',
  };

  function cameraCheckPasses() {
    if (!state.cam.required) return true;
    const st = window.ExamCamera.status();
    setCheck('checkCamera', st === 'OK', st === 'OK' ? 'Face detected'
      : st === 'OFF' ? 'Turn on your camera below.'
        : st === 'LOADING' ? 'Loading face detection…' : CAM_TEXT[st] + '. ' + (CAM_HELP[st] || ''));
    return st === 'OK';
  }

  function paintCamBadge(boxId, badgeId, st) {
    const box = $(boxId);
    box.classList.toggle('ok', st === 'OK');
    box.classList.toggle('bad', st !== 'OK' && st !== 'LOADING' && st !== 'OFF');
    $(badgeId).textContent = CAM_TEXT[st] || st;
  }

  async function turnOnCamera() {
    $('camBtn').disabled = true;
    $('camError').hidden = true;
    try {
      await window.ExamCamera.start($('camVideo'), { phoneDetection: state.rules.phoneDetection, onStatus: onCamStatus });
      $('camBtn').hidden = true;
    } catch (e) {
      $('camError').textContent = e.message;
      $('camError').hidden = false;
      $('camBtn').disabled = false;
    }
    refreshStartButton();
  }

  /** Called by camera.js about twice a second. */
  function onCamStatus(st, ageMs) {
    paintCamBadge('camBox', 'camBadge', st);
    if (!state.attemptId) { refreshStartButton(); return; }
    if (state.cam.warningOpen) {
      paintCamBadge('faceWarnBox', 'faceWarnBadge', st);
      $('faceWarnOk').disabled = st !== 'OK';
      $('camRestartBtn').hidden = st !== 'CAMERA_OFF';
      return;
    }
    if (!state.active || !state.cam.required) return;
    if (st === 'OK') { state.cam.offenseArmed = true; return; }
    if (st === 'LOADING' || st === 'OFF' || !state.cam.offenseArmed) return;
    const graceMs = st === 'CAMERA_OFF' ? 0 : Math.max(1, state.rules.faceGraceSeconds || 3) * 1000;
    if (ageMs >= graceMs) cameraOffense(st, CAM_TEXT[st] + ' for ' + Math.round(ageMs / 1000) + ' s.');
  }

  /** 1st offense: warning. 2nd offense: void. The server applies the same rule. */
  function cameraOffense(event, detail) {
    state.cam.offenseArmed = false;
    state.cam.warnings++;
    if (state.cam.warnings >= 2) { voidExam(event, detail); return; }
    showFaceWarning(event);
    api('violation', { attemptId: state.attemptId, event, detail }, 3)
      .then((r) => { if (r.status === 'VOIDED') { state.violations.push({ event, detail }); showVoid(event); } })
      .catch((e) => { if (e.code === 'VOIDED') showVoid(event); else beacon('violation', { attemptId: state.attemptId, event, detail }); });
  }

  function showFaceWarning(event) {
    state.cam.warningOpen = true;
    $('faceWarnReason').textContent = REASONS[event] || CAM_TEXT[event];
    window.ExamCamera.mirrorTo($('faceWarnVideo'));
    $('faceWarnOk').disabled = true;
    $('faceWarnModal').hidden = false;
  }

  function closeFaceWarning() {
    if (window.ExamCamera.status() !== 'OK') return;
    $('faceWarnModal').hidden = true;
    state.cam.warningOpen = false;
    state.cam.offenseArmed = true;
  }

  function windowStatusNow() {
    const now = Date.now() + state.serverOffset;
    const e = state.info.exam;
    if (e.startMs && now < e.startMs) return 'NOT_YET_OPEN';
    if (e.endMs && now > e.endMs) return 'CLOSED';
    return 'OPEN';
  }

  function refreshStartButton() {
    if (!state.info || state.attemptId) return;
    const checksOk = preChecksPass();
    const ws = windowStatusNow();
    const n = $('windowNotice');
    if (ws === 'NOT_YET_OPEN') {
      n.hidden = false; n.className = 'notice';
      n.textContent = 'This exam is not open yet. It opens on ' + state.info.exam.startText + '. This page will let you start once it opens.';
    } else if (ws === 'CLOSED') {
      n.hidden = false; n.className = 'notice bad';
      n.textContent = 'This exam closed on ' + state.info.exam.endText + '. If your instructor allowed you a retake, you can still start.';
    } else {
      n.hidden = true;
    }
    // CLOSED is still allowed through: the server decides (approved retakes may start late).
    $('startBtn').disabled = !(checksOk && ws !== 'NOT_YET_OPEN' && $('agree').checked);
  }

  // ───────── Rules screen ─────────

  function renderRules() {
    const { exam, rules } = state.info;
    state.rules = rules;
    document.title = exam.title + ' — Online Exam';
    $('brand').textContent = exam.title;
    $('examTitle').textContent = exam.title;
    $('examInstructions').textContent = exam.instructions;
    $('examInstructions').hidden = !exam.instructions;
    const types = { MC: 'multiple choice', TF: 'true/false', FIB: 'fill in the blank', ESSAY: 'essay' };
    $('factQuestions').textContent = exam.questionCount + ' (' + Object.keys(exam.typeCounts).map((k) => exam.typeCounts[k] + ' ' + (types[k] || k)).join(', ') + ')';
    $('factPoints').textContent = exam.totalPoints;
    $('factLimit').textContent = exam.timeLimitMinutes ? exam.timeLimitMinutes + ' minutes' : 'No limit (until the exam closes)';
    $('factWindow').textContent = (exam.startText ? 'From ' + exam.startText : 'Now') + (exam.endText ? ' until ' + exam.endText : '');
    $('accessCodeWrap').hidden = !state.info.requiresAccessCode;
    $('rulePaste').hidden = !rules.blockCopyPaste;
    state.cam.required = !!exam.faceMonitor;
    $('ruleCamera').hidden = !state.cam.required;
    $('checkCamera').hidden = !state.cam.required;
    $('cameraPanel').hidden = !state.cam.required;
    if (state.cam.required) {
      $('agreeText').textContent = 'I have read the rules. I understand that switching tabs or windows or using a second monitor will void my exam, ' +
        'and that my camera is monitored: I get one warning, and a second camera problem will void my exam.';
    }
    const nav = $('ruleNav');
    if (exam.displayMode === 'ONE') {
      nav.hidden = false;
      nav.innerHTML = exam.allowBack
        ? 'Questions are shown <b>one at a time</b>. You can go back to earlier questions before submitting.'
        : 'Questions are shown <b>one at a time</b>. <b>You cannot go back</b> to a question once you click <i>Next</i>, so answer each one before moving on.';
    }
    show('rules');
    refreshStartButton();
  }

  async function onStart(ev) {
    ev.preventDefault();
    const err = $('startError');
    err.hidden = true;
    const studentId = $('studentId').value.trim();
    const name = $('studentName').value.trim();
    if (!studentId || (!name && !state.info.rosterEnabled)) {
      err.textContent = 'Please enter your Student ID and full name.';
      err.hidden = false;
      return;
    }
    if (!preChecksPass()) return;
    const m = monitorStatus();
    $('startBtn').disabled = true;
    busy(true, 'Starting exam…');
    try {
      const r = await api('start', {
        examId: state.examId,
        studentId,
        name,
        accessCode: $('accessCode').value.trim(),
        env: {
          userAgent: navigator.userAgent,
          isExtended: m === 'multiple',
          monitorCheck: m === 'unsupported' ? 'unsupported' : 'supported',
          camera: state.cam.required && window.ExamCamera.status() === 'OK' ? 'ok' : 'none',
        },
      }, 2);
      busy(false);
      beginExam(r);
    } catch (e) {
      busy(false);
      err.textContent = e.message;
      err.hidden = false;
      refreshStartButton();
    }
  }

  // ───────── Exam ─────────

  function storageKey() { return 'exam-answers:' + state.attemptId; }

  function saveLocal() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state.answers)); } catch (e) { /* ignore */ }
  }

  function beginExam(r) {
    state.attemptId = r.attemptId;
    state.student = { id: r.studentId, name: r.studentName };
    state.questions = r.questions;
    state.answers = {};
    if (r.resumed) {
      try { state.answers = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {}; } catch (e) { state.answers = {}; }
    }
    state.endAt = r.remainingMs === null || r.remainingMs === undefined ? null : Date.now() + r.remainingMs;

    state.oneAtATime = state.info.exam.displayMode === 'ONE';
    state.allowBack = !state.oneAtATime || state.info.exam.allowBack !== false;
    state.locked = new Set(state.allowBack ? [] : (r.lockedIds || []));
    const firstOpen = state.questions.findIndex((q) => !state.locked.has(q.id));
    state.index = firstOpen === -1 ? state.questions.length - 1 : firstOpen;

    $('examTitle2').textContent = state.info.exam.title;
    $('studentLine').textContent = state.student.name + ' · ' + state.student.id + (r.isRetake ? ' · Retake' : '') + (r.resumed ? ' · Resumed' : '');
    renderQuestions();
    show('exam');
    if (state.oneAtATime) setupPager();
    if (state.rules.blockCopyPaste) document.body.classList.add('locked');
    state.active = true;
    if (state.cam.required) {
      $('camFloat').appendChild($('camBox')); // moving the element pauses it, so resume
      $('camFloat').hidden = false;
      window.ExamCamera.resume();
    }
    tick();
    state.timerId = setInterval(tick, 250);
    // A monitor may have been connected while the start request was in flight
    checkMonitorDuringExam();
  }

  function renderQuestions() {
    const ol = $('questions');
    ol.textContent = '';
    state.questions.forEach((q, qi) => {
      const li = document.createElement('li');
      li.className = 'card question';
      li.dataset.id = q.id;

      const head = document.createElement('div');
      head.className = 'q-head';
      const num = document.createElement('span'); num.className = 'q-num';
      num.textContent = 'Question ' + (qi + 1);
      const meta = document.createElement('span'); meta.className = 'q-meta';
      meta.textContent = ({ MC: 'Multiple choice', TF: 'True or false', FIB: 'Fill in the blank', ESSAY: 'Essay' }[q.type]) +
        ' · ' + q.points + (q.points === 1 ? ' point' : ' points');
      head.append(num, meta);
      li.appendChild(head);

      const text = document.createElement('p');
      text.className = 'q-text';
      li.appendChild(text);

      const saved = state.answers[q.id];

      if (q.type === 'FIB') {
        const input = document.createElement('input');
        input.className = 'blank';
        input.setAttribute('aria-label', 'Your answer');
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = saved || '';
        input.addEventListener('input', () => setAnswer(q.id, input.value));
        const parts = q.text.split(/_{3,}/);
        if (parts.length > 1) {
          text.append(parts[0], input, parts.slice(1).join('____'));
        } else {
          text.textContent = q.text;
          input.style.width = '100%';
          input.style.margin = '0';
          li.appendChild(input);
        }
      } else {
        text.textContent = q.text;
      }

      if (q.type === 'MC' || q.type === 'TF') {
        const opts = q.type === 'MC'
          ? q.choices.map((c, i) => ({ value: c.key, label: c.text, letter: String.fromCharCode(65 + i) }))
          : [{ value: 'TRUE', label: 'True' }, { value: 'FALSE', label: 'False' }];
        const wrap = document.createElement('div');
        wrap.className = 'choices';
        wrap.setAttribute('role', 'radiogroup');
        opts.forEach((o) => {
          const lab = document.createElement('label');
          lab.className = 'choice';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'q_' + q.id;
          input.value = o.value;
          input.checked = saved === o.value;
          input.addEventListener('change', () => {
            setAnswer(q.id, o.value);
            wrap.querySelectorAll('.choice').forEach((c) => c.classList.toggle('selected', c.contains(input)));
          });
          lab.appendChild(input);
          if (o.letter) { const l = document.createElement('span'); l.className = 'letter'; l.textContent = o.letter + '.'; lab.appendChild(l); }
          const t = document.createElement('span'); t.textContent = o.label; lab.appendChild(t);
          if (input.checked) lab.classList.add('selected');
          wrap.appendChild(lab);
        });
        li.appendChild(wrap);
      }

      if (q.type === 'ESSAY') {
        const ta = document.createElement('textarea');
        ta.className = 'essay';
        ta.setAttribute('aria-label', 'Your answer');
        ta.maxLength = 20000;
        ta.value = saved || '';
        const wc = document.createElement('div');
        wc.className = 'wordcount';
        const count = () => { const n = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0; wc.textContent = n + (n === 1 ? ' word' : ' words'); };
        ta.addEventListener('input', () => { setAnswer(q.id, ta.value); count(); });
        count();
        li.append(ta, wc);
      }

      ol.appendChild(li);
    });
    updateProgress();
  }

  function setAnswer(id, value) {
    state.answers[id] = value;
    saveLocal();
    updateProgress();
  }

  function isAnswered(id) {
    const v = state.answers[id];
    return v !== undefined && v !== null && String(v).trim() !== '';
  }

  function updateProgress() {
    const n = state.questions.filter((q) => isAnswered(q.id)).length;
    const t = n + ' / ' + state.questions.length + ' answered';
    $('progress').textContent = t;
    $('progress2').textContent = t;
    document.querySelectorAll('.question').forEach((li) => li.classList.toggle('answered', isAnswered(li.dataset.id)));
    document.querySelectorAll('#palette button').forEach((b) => b.classList.toggle('answered', isAnswered(b.dataset.id)));
  }

  // ───────── One question at a time ─────────

  function setupPager() {
    $('pager').hidden = false;
    $('submitBar').hidden = true;
    const pal = $('palette');
    pal.textContent = '';
    pal.hidden = !state.allowBack;
    if (state.allowBack) {
      state.questions.forEach((q, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = String(i + 1);
        b.dataset.id = q.id;
        b.setAttribute('aria-label', 'Go to question ' + (i + 1));
        b.addEventListener('click', () => showQuestion(i));
        pal.appendChild(b);
      });
    }
    state.locked.forEach((id) => lockInputs(id));
    updateProgress();
    showQuestion(state.index);
  }

  function showQuestion(i) {
    state.index = Math.max(0, Math.min(i, state.questions.length - 1));
    const id = state.questions[state.index].id;
    document.querySelectorAll('.question').forEach((li) => { li.hidden = li.dataset.id !== id; });
    document.querySelectorAll('#palette button').forEach((b, j) => b.classList.toggle('current', j === state.index));
    const last = state.index === state.questions.length - 1;
    $('pagerCount').textContent = 'Question ' + (state.index + 1) + ' of ' + state.questions.length;
    $('prevBtn').hidden = !state.allowBack;
    $('prevBtn').disabled = state.index === 0;
    $('nextBtn').textContent = last ? 'Submit exam' : 'Next →';
    window.scrollTo(0, 0);
  }

  function lockInputs(id) {
    const li = document.querySelector('.question[data-id="' + CSS.escape(id) + '"]');
    if (!li) return;
    li.classList.add('locked');
    li.querySelectorAll('input, textarea').forEach((el) => { el.disabled = true; });
  }

  function goNext() {
    if (!state.active) return;
    const q = state.questions[state.index];
    const last = state.index === state.questions.length - 1;
    if (last) { askSubmit(); return; }
    const advance = () => {
      if (!state.allowBack) {
        state.locked.add(q.id);
        lockInputs(q.id);
        const value = state.answers[q.id] === undefined ? '' : state.answers[q.id];
        api('lockAnswer', { attemptId: state.attemptId, questionId: q.id, value }, 3).catch((e) => {
          if (e.code === 'VOIDED') showVoid(null, e.message);
        });
      }
      showQuestion(state.index + 1);
    };
    if (!state.allowBack && !isAnswered(q.id)) {
      confirmBox('Skip this question?', 'You have not answered Question ' + (state.index + 1) +
        '. You cannot come back to it after moving on.', 'Skip it', 'Go back', advance);
      return;
    }
    advance();
  }

  function goPrev() {
    if (state.active && state.allowBack) showQuestion(state.index - 1);
  }

  let confirmAction = null;
  function confirmBox(title, text, yesLabel, noLabel, onYes) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yesLabel;
    $('confirmNo').textContent = noLabel;
    confirmAction = onYes;
    $('confirmModal').hidden = false;
    $('confirmNo').focus();
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(sec);
  }

  function tick() {
    if (!state.active) return;
    const el = $('timer');
    if (state.endAt === null) { el.textContent = 'No time limit'; return; }
    const left = state.endAt - Date.now();
    el.textContent = fmtTime(left);
    el.classList.toggle('low', left <= 60000);
    const warn = $('timeWarning');
    if (left <= 300000 && !state.warned5 && left > 60000) {
      state.warned5 = true; warn.hidden = false; warn.textContent = '5 minutes left. Your answers will be submitted automatically when time runs out.';
    }
    if (left <= 60000 && !state.warned1) {
      state.warned1 = true; warn.hidden = false; warn.className = 'notice bad'; warn.textContent = 'Less than 1 minute left!';
    }
    if (left <= 0) submitExam(true);
  }

  // ───────── Submit ─────────

  function askSubmit() {
    const unanswered = state.questions.map((q, i) => (isAnswered(q.id) ? null : i + 1)).filter(Boolean);
    confirmBox('Submit your exam?', unanswered.length
      ? 'You have ' + unanswered.length + ' unanswered question(s): #' + unanswered.join(', #') + '. You cannot change your answers after submitting.'
      : 'You answered all questions. You cannot change your answers after submitting.',
    'Submit now', 'Keep answering', () => submitExam(false));
  }

  async function submitExam(auto) {
    if (!state.active || state.submitting) return;
    state.submitting = true;
    $('confirmModal').hidden = true;
    $('submitBtn').disabled = true;
    busy(true, auto ? 'Time is up — submitting your answers…' : 'Submitting your answers…');
    try {
      const r = await api('submit', { attemptId: state.attemptId, answers: state.answers, violations: state.violations }, 4);
      finishExam();
      busy(false);
      showResult(r);
    } catch (e) {
      busy(false);
      state.submitting = false;
      if (e.code === 'VOIDED') { showVoid(null, e.message); return; }
      if (e.code === 'ALREADY_SUBMITTED') { finishExam(); showResult({ showScore: false }); return; }
      $('submitBtn').disabled = false;
      const warn = $('timeWarning');
      warn.hidden = false; warn.className = 'notice bad';
      warn.textContent = 'Your answers were NOT submitted yet: ' + e.message + ' Stay on this page and click "Submit exam" again.';
      window.scrollTo(0, 0);
      if (auto) setTimeout(() => submitExam(true), 5000);
    }
  }

  function finishExam() {
    state.active = false;
    clearInterval(state.timerId);
    stopCamera();
    document.body.classList.remove('locked');
    try { localStorage.removeItem(storageKey()); } catch (e) { /* ignore */ }
  }

  function showResult(r) {
    show('result');
    $('resultText').textContent = 'Thank you, ' + (state.student ? state.student.name : '') + '. Your answers have been recorded.';
    if (r.showScore) {
      $('resultScore').hidden = false;
      $('resultScore').textContent = r.score + ' / ' + r.maxScore + ' (' + r.percent + '%)';
      $('resultNote').textContent = r.pendingEssays
        ? r.pendingEssays + ' essay question(s) still need to be graded by your instructor, so your final score may change.'
        : '';
    } else {
      $('resultNote').textContent = 'Your instructor will release the results.';
    }
  }

  // ───────── Violations ─────────

  const REASONS = {
    TAB_SWITCH: 'You switched to another tab or minimized the exam window.',
    LEFT_WINDOW: 'You left the exam window (for example, Alt+Tab to another application).',
    SECOND_MONITOR: 'A second monitor was connected during the exam.',
    PAGE_CLOSED: 'You closed or reloaded the exam page.',
    NO_FACE: 'Your face was not visible to the camera.',
    CAMERA_BLOCKED: 'Your camera was covered or blocked.',
    MULTIPLE_FACES: 'More than one person was in front of the camera.',
    PHONE_DETECTED: 'A mobile phone was seen on camera.',
    CAMERA_OFF: 'Your camera was turned off or disconnected.',
  };

  function voidExam(event, detail) {
    if (!state.active || state.voided) return;
    state.voided = true;
    state.active = false;
    clearInterval(state.timerId);
    state.violations.push({ event, detail, at: new Date().toISOString() });
    const payload = { attemptId: state.attemptId, event, detail };

    if (document.visibilityState === 'hidden') {
      // The page may be closing: a beacon is delivered even if the tab is gone.
      if (!beacon('violation', payload)) api('violation', payload, 3).catch(() => {});
    } else {
      api('violation', payload, 3).catch(() => beacon('violation', payload));
    }
    try { localStorage.removeItem(storageKey()); } catch (e) { /* ignore */ }
    showVoid(event);
  }

  function stopCamera() {
    if (!state.cam.required) return;
    window.ExamCamera.stop();
    $('camFloat').hidden = true;
    $('faceWarnModal').hidden = true;
    state.cam.warningOpen = false;
  }

  function showVoid(event, serverMessage) {
    state.active = false;
    state.voided = true;
    clearInterval(state.timerId);
    stopCamera();
    $('confirmModal').hidden = true;
    busy(false);
    $('voidReason').textContent = event ? REASONS[event] : (serverMessage || 'Exam rules were broken.');
    $('voidStudent').textContent = state.student ? state.student.name + ' (' + state.student.id + ')' : '';
    $('voidExam').textContent = state.info ? state.info.exam.title : '';
    $('voidTime').textContent = new Date().toLocaleString();
    $('voidRef').textContent = state.attemptId ? state.attemptId.slice(0, 8).toUpperCase() : '';
    $('questions').textContent = ''; // hide the questions
    $('voidModal').hidden = false;
  }

  let blurTimer = null;
  let unfocusedSince = null;

  function onHidden() {
    if (state.active && document.visibilityState === 'hidden') {
      voidExam('TAB_SWITCH', 'Page became hidden (tab switch, minimize, or another window covered it).');
    }
  }

  function onBlur() {
    if (!state.active) return;
    const grace = state.rules.blurGraceSeconds * 1000;
    if (grace <= 0) { voidExam('LEFT_WINDOW', 'Exam window lost focus.'); return; }
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (state.active && !document.hasFocus()) voidExam('LEFT_WINDOW', 'Exam window lost focus for more than ' + state.rules.blurGraceSeconds + ' s.');
    }, grace);
  }

  function onFocus() { clearTimeout(blurTimer); unfocusedSince = null; }

  function checkMonitorDuringExam() {
    if (state.active && monitorStatus() === 'multiple') {
      voidExam('SECOND_MONITOR', 'screen.isExtended became true during the exam.');
    }
  }

  /** Backup checks every second, in case an event was missed. */
  function watchdog() {
    if (state.active) {
      checkMonitorDuringExam();
      if (!state.active) return;
      if (document.visibilityState === 'hidden') { onHidden(); return; }
      if (!document.hasFocus()) {
        if (unfocusedSince === null) unfocusedSince = Date.now();
        const limit = Math.max(1000, state.rules.blurGraceSeconds * 1000);
        if (Date.now() - unfocusedSince >= limit) voidExam('LEFT_WINDOW', 'Exam window did not have focus.');
      } else {
        unfocusedSince = null;
      }
    } else if (state.info && !state.attemptId && !$('screen-rules').hidden) {
      refreshStartButton();
    }
  }

  function blockIfActive(e) {
    if (state.active && state.rules.blockCopyPaste) e.preventDefault();
  }

  // ───────── Boot ─────────

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function boot() {
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', () => { if (state.active) voidExam('PAGE_CLOSED', 'pagehide'); });
    window.addEventListener('beforeunload', (e) => { if (state.active) { e.preventDefault(); e.returnValue = ''; } });
    if (window.screen && typeof window.screen.addEventListener === 'function') {
      window.screen.addEventListener('change', () => { checkMonitorDuringExam(); if (!state.attemptId && state.info) refreshStartButton(); });
    }
    ['copy', 'cut', 'paste', 'contextmenu', 'drop', 'dragstart'].forEach((t) => document.addEventListener(t, blockIfActive));
    setInterval(watchdog, 1000);

    $('startForm').addEventListener('submit', onStart);
    $('agree').addEventListener('change', refreshStartButton);
    $('submitBtn').addEventListener('click', askSubmit);
    $('confirmNo').addEventListener('click', () => { $('confirmModal').hidden = true; });
    $('confirmYes').addEventListener('click', () => {
      $('confirmModal').hidden = true;
      const f = confirmAction; confirmAction = null;
      if (f) f();
    });
    $('nextBtn').addEventListener('click', goNext);
    $('camBtn').addEventListener('click', turnOnCamera);
    $('faceWarnOk').addEventListener('click', closeFaceWarning);
    $('camRestartBtn').addEventListener('click', () => { window.ExamCamera.restart().catch(() => {}); });
    $('prevBtn').addEventListener('click', goPrev);

    if (!API_URL || API_URL.indexOf('PASTE_') === 0) {
      showError('This exam page is not set up yet: the instructor needs to put the Apps Script Web App URL in config.js.');
      return;
    }
    if (!state.examId) {
      showError('This link has no exam ID. Ask your instructor for the correct exam link (it ends with ?exam=…).');
      return;
    }
    try {
      state.info = await api('getExam', { examId: state.examId }, 3);
      state.serverOffset = state.info.exam.serverNow - Date.now();
      renderRules();
    } catch (e) {
      showError(e.message);
    }
  }

  boot();
})();
