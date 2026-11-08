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
    warned: new Set(),   // time warnings already shown (minutes)
    qEndAt: null,        // per-question deadline (one-at-a-time with a time limit per question)
    unloading: false,    // the page is closing or reloading (reconnect allowed)
    disconnectSent: false,
    hiddenTimer: null,
    lastOkAt: 0,         // last successful contact with the server
    offlineSince: null,  // when the connection was lost
    oneAtATime: false,   // show one question at a time
    allowBack: true,     // may return to earlier questions (one-at-a-time mode)
    index: 0,            // current question in one-at-a-time mode
    locked: new Set(),   // questions that can no longer be changed
    cam: { required: false, continuous: false, warnings: 0, warningOpen: false, offenseArmed: true },
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
    $('camIndicator').classList.toggle('bad', st !== 'OK');
    $('camIndicator').textContent = st === 'OK' ? '📷 Camera on' : '📷 ' + (CAM_TEXT[st] || st);
    if (!state.attemptId) { refreshStartButton(); return; }
    if (state.cam.warningOpen) {
      paintCamBadge('faceWarnBox', 'faceWarnBadge', st);
      $('faceWarnOk').disabled = st !== 'OK';
      $('camRestartBtn').hidden = st !== 'CAMERA_OFF';
      return;
    }
    if (!state.active || !state.cam.continuous) return;
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
      const until = state.info.exam.startMs - (Date.now() + state.serverOffset);
      n.textContent = state.rules.openCountdown
        ? 'This exam opens in ' + fmtCountdown(until) + ' (' + state.info.exam.startText + '). Keep this page open: you can start as soon as it opens.'
        : 'This exam is not open yet. It opens on ' + state.info.exam.startText + '. This page will let you start once it opens.';
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
    $('factQuestions').textContent = exam.topicBreakdown
      ? exam.questionCount + ' (' + exam.topicBreakdown.map((t) => t.count + ' ' + t.topic).join(', ') + ', picked at random from ' + exam.poolSize + ')'
      : exam.poolSize
      ? exam.questionCount + ' (picked at random from ' + exam.poolSize + ')'
      : exam.questionCount + ' (' + Object.keys(exam.typeCounts).map((k) => exam.typeCounts[k] + ' ' + (types[k] || k)).join(', ') + ')';
    $('factPoints').textContent = exam.totalPoints === null ? 'Depends on your questions' : exam.totalPoints;
    $('factLimit').textContent = exam.timeLimitMinutes ? exam.timeLimitMinutes + ' minutes' : 'No limit (until the exam closes)';
    $('factWindow').textContent = (exam.startText ? 'From ' + exam.startText : 'Now') + (exam.endText ? ' until ' + exam.endText : '');
    $('accessCodeWrap').hidden = !state.info.requiresAccessCode;
    $('rulePaste').hidden = !rules.blockCopyPaste;
    state.cam.required = exam.faceMode === 'START' || exam.faceMode === 'ALWAYS';
    state.cam.continuous = exam.faceMode === 'ALWAYS';
    $('ruleCamera').hidden = !state.cam.required;
    $('checkCamera').hidden = !state.cam.required;
    $('cameraPanel').hidden = !state.cam.required;
    if (state.cam.continuous) {
      $('ruleCamera').innerHTML = '📷 <b>Your camera will be monitored throughout the exam.</b> Keep your face clearly visible. ' +
        'If your face is hidden, the camera is covered, another person appears, or a phone is seen, you get <b>one warning</b>. ' +
        'The second time, <b>your exam is voided</b>.';
      $('agreeText').textContent = 'I have read the rules. I understand that switching tabs or windows or using a second monitor will void my exam, ' +
        'and that my camera is monitored: I get one warning, and a second camera problem will void my exam.';
    } else if (state.cam.required) {
      $('ruleCamera').innerHTML = '📷 <b>Your face must be visible to the camera before you can start.</b> Sit facing the screen in a well-lit place, with only you in view.';
      $('camHelp').textContent = 'Turn on your camera so we can check that your face is visible. The camera turns off when the exam starts.';
    }
    const rs = rules.reconnectSeconds || 0;
    if (rs > 0) {
      $('ruleReload').innerHTML = '<b>If your internet drops or the page reloads</b>, reopen the same exam link within <b>' + fmtDuration(rs) +
        '</b> to continue (up to ' + rules.maxReconnects + ' time' + (rules.maxReconnects === 1 ? '' : 's') + '). Your timer keeps running. ' +
        'Taking longer voids your exam. <b>Do not close or reload this page on purpose.</b>';
    }
    if (exam.questionSeconds > 0) {
      $('ruleNav').hidden = false;
      $('ruleNav').innerHTML = 'Questions are shown <b>one at a time</b>, with <b>' + fmtDuration(exam.questionSeconds) + ' per question</b>. ' +
        'When the time is up, the exam moves on automatically. <b>You cannot go back</b> to earlier questions.';
    }
    const nav = $('ruleNav');
    if (exam.displayMode === 'ONE' && !(exam.questionSeconds > 0)) {
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
    // Skip warnings longer than the time available (no "5 minutes left" on a 3-minute exam)
    if (state.endAt !== null) (state.rules.timeWarnings || []).forEach((m) => { if (m * 60000 >= r.remainingMs) state.warned.add(m); });

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
    if (state.cam.required && !state.cam.continuous) {
      window.ExamCamera.stop(); // face was checked at the start only
    } else if (state.cam.continuous) {
      $('camFloat').appendChild($('camBox')); // moving the element pauses it, so resume
      $('camFloat').hidden = false;
      const preview = state.info.exam.cameraPreview !== false;
      $('camFloat').classList.toggle('preview-off', !preview);
      $('camIndicator').hidden = preview;
      window.ExamCamera.resume();
    }
    tick();
    state.timerId = setInterval(tick, 250);
    state.lastOkAt = Date.now();
    if (state.rules.reconnectSeconds > 0) state.pingId = setInterval(ping, 20000);
    if (r.resumed && state.rules.reconnectSeconds > 0) {
      const w = $('timeWarning');
      w.hidden = false; w.className = 'notice';
      w.textContent = 'Reconnected — you can continue. Reconnects used: ' + r.reconnects + ' of ' + state.rules.maxReconnects + '. Your timer kept running while you were away.';
    }
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
    const qs = state.info.exam.questionSeconds || 0;
    state.qEndAt = qs > 0 ? Date.now() + qs * 1000 : null;
    $('qTimer').hidden = !(qs > 0);
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
    const advance = () => advanceFrom(q);
    if (!state.allowBack && !isAnswered(q.id)) {
      confirmBox('Skip this question?', 'You have not answered Question ' + (state.index + 1) +
        '. You cannot come back to it after moving on.', 'Skip it', 'Go back', advance);
      return;
    }
    advance();
  }

  function advanceFrom(q) {
    if (!state.active || state.questions[state.index] !== q) return;
    if (!state.allowBack) {
      state.locked.add(q.id);
      lockInputs(q.id);
      const value = state.answers[q.id] === undefined ? '' : state.answers[q.id];
      sendReliably('lockAnswer', { attemptId: state.attemptId, questionId: q.id, value });
    }
    showQuestion(state.index + 1);
  }

  /** Time per question ran out: move on (or submit on the last question). */
  function questionTimeUp() {
    state.qEndAt = null;
    const q = state.questions[state.index];
    if (confirmAction) { $('confirmModal').hidden = true; confirmAction = null; }
    if (state.index === state.questions.length - 1) { submitExam(true); return; }
    advanceFrom(q);
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

  /** "2 d 03:15:20", "1:05:30", "04:59" */
  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(s / 86400);
    return (d ? d + (d === 1 ? ' day ' : ' days ') : '') + fmtTime((s % 86400) * 1000);
  }

  /** 60 → "1 minute", 90 → "1 min 30 s", 45 → "45 seconds" */
  function fmtDuration(sec) {
    const m = Math.floor(sec / 60), r = sec % 60;
    if (!m) return sec + (sec === 1 ? ' second' : ' seconds');
    if (!r) return m + (m === 1 ? ' minute' : ' minutes');
    return m + ' min ' + r + ' s';
  }

  function tick() {
    if (!state.active) return;
    tickConnection();
    if (!state.active) return;
    if (state.qEndAt !== null) {
      const ql = state.qEndAt - Date.now();
      $('qTimer').textContent = '⏱ ' + fmtTime(ql);
      $('qTimer').classList.toggle('low', ql <= 10000);
      if (ql <= 0) { questionTimeUp(); return; }
    }
    const el = $('timer');
    if (state.endAt === null) { el.textContent = 'No time limit'; return; }
    const left = state.endAt - Date.now();
    el.textContent = fmtTime(left);
    el.classList.toggle('low', left <= 60000);
    // Teacher-chosen warnings, e.g. [10, 5, 1] minutes before the end
    const due = (state.rules.timeWarnings || []).filter((m) => left <= m * 60000 && !state.warned.has(m));
    if (due.length && left > 0) {
      const m = Math.min.apply(null, due);
      state.rules.timeWarnings.forEach((x) => { if (x >= m) state.warned.add(x); });
      const smallest = Math.min.apply(null, state.rules.timeWarnings);
      const warn = $('timeWarning');
      warn.hidden = false;
      warn.className = m === smallest ? 'notice bad' : 'notice warn';
      warn.textContent = (m < 1 ? Math.round(m * 60) + ' seconds' : m + (m === 1 ? ' minute' : ' minutes')) +
        ' left. Your answers will be submitted automatically when time runs out.';
    }
    if (left <= 0) submitExam(true);
  }

  // ───────── Connection & reconnect ─────────

  function markOnline() {
    state.lastOkAt = Date.now();
    if (state.offlineSince !== null) {
      state.offlineSince = null;
      $('connBanner').hidden = true;
    }
  }

  function markOffline(since) {
    if (state.offlineSince === null) state.offlineSince = since || Date.now();
  }

  async function ping() {
    if (!state.active || !(state.rules.reconnectSeconds > 0)) return;
    try {
      const r = await api('ping', { attemptId: state.attemptId });
      markOnline();
      if (r.status === 'VOIDED') showVoid(null, 'Your exam was voided: ' + (r.reason || 'exam rules were broken') + '. Please inform your instructor.');
    } catch (e) {
      if (e.code === 'NETWORK') markOffline(state.lastOkAt);
    }
  }

  /** Shows the "connection lost" banner and voids the exam if the limit passes. */
  function tickConnection() {
    const rs = state.rules.reconnectSeconds || 0;
    if (!(rs > 0) || state.offlineSince === null) return;
    const left = rs * 1000 - (Date.now() - state.offlineSince);
    const b = $('connBanner');
    b.hidden = false;
    b.textContent = '⚠ Connection lost — trying to reconnect… Keep this page open. ' +
      'If you are not back online within ' + fmtTime(left) + ', your exam will be voided.';
    if (Date.now() - (state.lastRetryAt || 0) > 5000) { state.lastRetryAt = Date.now(); ping(); }
    if (left <= 0 && !state.submitting) voidExam('CONNECTION_LOST', 'Offline for more than ' + rs + ' s.');
  }

  /** Sends now, or keeps retrying every 5 s while offline (up to 10 minutes). */
  function sendReliably(action, payload) {
    let tries = 0;
    const attempt = () => api(action, payload).then((r) => { markOnline(); return r; }).catch((e) => {
      if (e.code === 'VOIDED') { showVoid(null, e.message); return; }
      if (e.code !== 'NETWORK') return;
      markOffline(state.lastOkAt);
      if (++tries < 120) setTimeout(attempt, 5000);
      else beacon(action, payload);
    });
    attempt();
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
    clearInterval(state.pingId);
    $('connBanner').hidden = true;
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
    CONNECTION_LOST: 'Your internet connection was lost for longer than allowed.',
  };

  function voidExam(event, detail) {
    if (!state.active || state.voided || state.unloading) return;
    state.voided = true;
    state.active = false;
    clearInterval(state.timerId);
    state.violations.push({ event, detail, at: new Date().toISOString() });
    const payload = { attemptId: state.attemptId, event, detail };

    if (document.visibilityState === 'hidden') {
      // The page may be closing: a beacon is delivered even if the tab is gone.
      if (!beacon('violation', payload)) sendReliably('violation', payload);
    } else {
      sendReliably('violation', payload);
    }
    try { localStorage.removeItem(storageKey()); } catch (e) { /* ignore */ }
    showVoid(event);
  }

  function stopCamera() {
    if (!state.cam.required) return;
    window.ExamCamera.stop();
    $('camFloat').hidden = true;
    $('camIndicator').hidden = true;
    $('faceWarnModal').hidden = true;
    state.cam.warningOpen = false;
  }

  function showVoid(event, serverMessage) {
    state.active = false;
    state.voided = true;
    clearInterval(state.timerId);
    clearInterval(state.pingId);
    $('connBanner').hidden = true;
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

  const reconnectOn = () => state.rules.reconnectSeconds > 0;

  function onHidden() {
    if (!state.active || document.visibilityState !== 'hidden') return;
    const go = () => voidExam('TAB_SWITCH', 'Page became hidden (tab switch, minimize, or another window covered it).');
    if (!reconnectOn()) { go(); return; }
    // A reload or closing the page also hides it; wait a moment to tell them apart.
    if (!state.hiddenTimer) state.hiddenTimer = setTimeout(() => { state.hiddenTimer = null; go(); }, 500);
  }

  /** Page is closing or reloading. With reconnect on, this starts the reconnect window instead of voiding. */
  function onLeaving() {
    if (!state.active || state.disconnectSent) return;
    if (!reconnectOn()) { voidExam('PAGE_CLOSED', 'pagehide'); return; }
    state.unloading = true;
    state.disconnectSent = true;
    clearTimeout(state.hiddenTimer);
    clearTimeout(blurTimer);
    clearTimeout(state.blurVoidTimer);
    beacon('disconnect', { attemptId: state.attemptId, detail: 'page closed or reloaded' });
  }

  function onBlur() {
    if (!state.active) return;
    const grace = state.rules.blurGraceSeconds * 1000;
    if (grace <= 0) {
      if (!reconnectOn()) { voidExam('LEFT_WINDOW', 'Exam window lost focus.'); return; }
      // Wait a moment so a reload (reconnect allowed) is not counted; coming back quickly still counts.
      clearTimeout(state.blurVoidTimer);
      state.blurVoidTimer = setTimeout(() => voidExam('LEFT_WINDOW', 'Exam window lost focus.'), 500);
      return;
    }
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
      if (!document.hasFocus() && !state.unloading) {
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
    window.addEventListener('pagehide', onLeaving);
    window.addEventListener('beforeunload', (e) => {
      if (!state.active) return;
      if (reconnectOn()) { onLeaving(); return; } // reload allowed: reconnect within the time limit
      e.preventDefault(); e.returnValue = '';
    });
    window.addEventListener('offline', () => { if (state.active && reconnectOn()) markOffline(Date.now()); });
    window.addEventListener('online', () => { if (state.active) ping(); });
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
