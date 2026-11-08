/**
 * Online Exam — Google Apps Script backend
 * =========================================
 * Bind this script to a Google Sheet (Extensions → Apps Script) and deploy it
 * as a Web App. The Sheet is the whole "database":
 *
 *   Questions   – the question bank (MC, TF, FIB, ESSAY)
 *   Exams       – each exam: which questions, time window, time limit
 *   Roster      – (optional) allowed students and access codes
 *   Attempts    – one row per student attempt (status, score, retake checkbox)
 *   Responses   – one row per answered question (teachers grade essays here)
 *   Violations  – tab switches / left window / second monitor events
 *   Settings    – app-wide options
 *
 * The student page (docs/ folder, hosted free on GitHub Pages) talks to this
 * script through doPost(). Correct answers never leave this script; grading
 * happens here, on Google's servers.
 */

// ───────────────────────────── Constants ─────────────────────────────

const SHEET = {
  QUESTIONS: 'Questions',
  EXAMS: 'Exams',
  ROSTER: 'Roster',
  ATTEMPTS: 'Attempts',
  RESPONSES: 'Responses',
  VIOLATIONS: 'Violations',
  PROGRESS: 'Progress',
  SETTINGS: 'Settings',
};

const HEADERS = {
  Questions: ['QuestionID', 'Type', 'Question', 'Choices', 'Answer', 'Points', 'Topic'],
  Exams: ['ExamID', 'Title', 'Instructions', 'QuestionIDs', 'StartDateTime', 'EndDateTime',
    'TimeLimitMinutes', 'ShuffleQuestions', 'ShuffleChoices', 'ShowScore', 'Active', 'Course',
    'DisplayMode', 'AllowBack', 'FaceMonitor', 'CameraPreview'],
  Roster: ['StudentID', 'Name', 'Email', 'AccessCode', 'Courses'],
  Attempts: ['AttemptID', 'ExamID', 'StudentID', 'Name', 'Status', 'StartedAt', 'Deadline',
    'SubmittedAt', 'Score', 'MaxScore', 'Percent', 'PendingEssays', 'Late', 'VoidReason',
    'VoidedAt', 'AllowRetake', 'IsRetake', 'UserAgent', 'Course', 'Warnings'],
  Responses: ['AttemptID', 'ExamID', 'StudentID', 'QuestionID', 'Type', 'Question',
    'StudentAnswer', 'CorrectAnswer', 'IsCorrect', 'PointsEarned', 'MaxPoints'],
  Violations: ['Timestamp', 'AttemptID', 'ExamID', 'StudentID', 'Name', 'Event', 'Detail'],
  Progress: ['Timestamp', 'AttemptID', 'QuestionID', 'Answer'],
  Settings: ['Key', 'Value', 'Description'],
};

const DEFAULT_SETTINGS = [
  ['STUDENT_APP_URL', '', 'Address of the student exam page (your GitHub Pages URL). Used to build exam links.'],
  ['BLUR_GRACE_SECONDS', 0, 'Seconds the exam window may lose focus (Alt+Tab, clicking another app) before the exam is voided. 0 = immediately.'],
  ['REQUIRE_MONITOR_CHECK', true, 'TRUE = only browsers that can detect extra monitors (Chrome / Edge on a computer) may take exams.'],
  ['BLOCK_COPY_PASTE', true, 'TRUE = disable copy, paste and right-click on the exam page.'],
  ['SUBMIT_GRACE_SECONDS', 60, 'Extra seconds after the deadline during which a submission is still on time (network delays).'],
  ['FACE_GRACE_SECONDS', 3, 'Camera-monitored exams: seconds a problem (face hidden, camera covered, extra person, phone) must last before it counts. 1st time = warning, 2nd time = voided.'],
  ['PHONE_DETECTION', true, 'Camera-monitored exams: TRUE = also watch for a mobile phone held in front of the camera.'],
];

/** Camera events give one warning first; the next one voids the exam. */
const WARNABLE_EVENTS = ['NO_FACE', 'CAMERA_BLOCKED', 'MULTIPLE_FACES', 'PHONE_DETECTED', 'CAMERA_OFF'];

const STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
  VOIDED: 'VOIDED',
  EXPIRED: 'EXPIRED',
};

const VIOLATION_LABELS = {
  TAB_SWITCH: 'Switched to another tab or minimized the exam window',
  LEFT_WINDOW: 'Left the exam window (for example Alt+Tab to another application)',
  SECOND_MONITOR: 'A second monitor was connected during the exam',
  PAGE_CLOSED: 'Closed or reloaded the exam page',
  NO_FACE: 'Face was not visible to the camera',
  CAMERA_BLOCKED: 'The camera was covered or blocked',
  MULTIPLE_FACES: 'More than one person was in front of the camera',
  PHONE_DETECTED: 'A mobile phone was seen on camera',
  CAMERA_OFF: 'The camera was turned off or disconnected',
};

// ───────────────────────────── Web App API ─────────────────────────────

function doGet() {
  return json_({ ok: true, service: 'online-exam', message: 'The exam API is running. Students should use the exam page link, not this URL.' });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = API_[req.action];
    if (!handler) throw apiError_('BAD_ACTION', 'Unknown action.');
    out = Object.assign({ ok: true }, handler(req));
  } catch (err) {
    out = { ok: false, code: err.code || 'SERVER_ERROR', error: err.message || String(err) };
    if (!err.code) console.error(err && err.stack ? err.stack : err);
  }
  return json_(out);
}

const API_ = {
  /** Public exam info for the rules screen. No questions are sent. */
  getExam(req) {
    const exam = examConfig_(getExamRow_(req.examId));
    const bank = getQuestionBank_();
    const questions = examQuestions_(exam, bank);
    const settings = getSettings_();
    const roster = readTable_(SHEET.ROSTER).rows.filter(r => String(r.StudentID).trim() !== '');
    const tz = tz_();
    const now = new Date();
    return {
      exam: {
        id: exam.id,
        title: exam.title,
        course: exam.course,
        displayMode: exam.displayMode,
        faceMode: exam.faceMode,
        cameraPreview: exam.cameraPreview,
        allowBack: exam.allowBack,
        instructions: exam.instructions,
        questionCount: questions.length,
        totalPoints: sum_(questions.map(q => q.points)),
        typeCounts: countBy_(questions, q => q.type),
        timeLimitMinutes: exam.limitMin,
        startMs: exam.start ? exam.start.getTime() : null,
        endMs: exam.end ? exam.end.getTime() : null,
        startText: exam.start ? fmtDate_(exam.start, tz) : '',
        endText: exam.end ? fmtDate_(exam.end, tz) : '',
        timeZone: tz,
        windowStatus: windowStatus_(exam, now),
        serverNow: now.getTime(),
      },
      rules: {
        blurGraceSeconds: settings.BLUR_GRACE_SECONDS,
        requireMonitorCheck: settings.REQUIRE_MONITOR_CHECK,
        blockCopyPaste: settings.BLOCK_COPY_PASTE,
        faceGraceSeconds: settings.FACE_GRACE_SECONDS,
        phoneDetection: settings.PHONE_DETECTION,
      },
      rosterEnabled: roster.length > 0,
      requiresAccessCode: roster.some(r => String(r.AccessCode).trim() !== ''),
    };
  },

  /** Starts (or resumes) an attempt and returns the questions without answers. */
  start(req) {
    return withLock_(() => {
      const exam = examConfig_(getExamRow_(req.examId));
      const bank = getQuestionBank_();
      const questions = examQuestions_(exam, bank);
      const settings = getSettings_();
      const env = req.env || {};
      const now = new Date();

      let studentId = String(req.studentId || '').trim();
      let name = String(req.name || '').trim().replace(/\s+/g, ' ');
      if (!studentId) throw apiError_('MISSING_ID', 'Please enter your Student ID.');
      if (studentId.length > 64 || name.length > 120) throw apiError_('BAD_INPUT', 'Student ID or name is too long.');

      // Optional roster check
      const roster = readTable_(SHEET.ROSTER).rows.filter(r => String(r.StudentID).trim() !== '');
      if (roster.length) {
        const r = roster.find(x => normId_(x.StudentID) === normId_(studentId));
        if (!r) throw apiError_('NOT_IN_ROSTER', 'Student ID "' + studentId + '" is not on the class list. Check your ID or contact your instructor.');
        const code = String(r.AccessCode).trim();
        if (code && code !== String(req.accessCode || '').trim()) {
          throw apiError_('BAD_ACCESS_CODE', 'The access code is incorrect.');
        }
        if (exam.course && !parseCourses_(r.Courses).some(c => c === normCourse_(exam.course))) {
          throw apiError_('NOT_ENROLLED', 'You are not enrolled in ' + exam.course + ', so you cannot take this exam. ' +
            'Check that you opened the right exam link, or contact your instructor.');
        }
        if (String(r.Name).trim()) name = String(r.Name).trim();
        studentId = String(r.StudentID).trim();
      }
      if (!name) throw apiError_('MISSING_NAME', 'Please enter your full name.');

      const attempts = readTable_(SHEET.ATTEMPTS);
      const mine = attempts.rows.filter(a =>
        String(a.ExamID).trim().toLowerCase() === exam.id.toLowerCase() &&
        normId_(a.StudentID) === normId_(studentId));
      const last = mine[mine.length - 1];

      let attempt = null;
      let isRetake = false;
      let resumed = false;

      if (last) {
        if (last.Status === STATUS.IN_PROGRESS) {
          const dl = toDate_(last.Deadline);
          if (!dl || now <= dl) {
            attempt = last; // resume (e.g. browser crashed or lost connection)
            resumed = true;
          } else {
            updateFields_(attempts, last, { Status: STATUS.EXPIRED });
          }
        }
        if (!attempt) {
          if (!toBool_(last.AllowRetake, false)) throw blockedError_(last);
          isRetake = true;
        }
      }

      if (!attempt) {
        const status = windowStatus_(exam, now);
        if (status === 'NOT_YET_OPEN') {
          throw apiError_('NOT_YET_OPEN', 'This exam opens on ' + fmtDate_(exam.start, tz_()) + '.');
        }
        // A retake approved by the instructor is allowed even after the window closes.
        if (status === 'CLOSED' && !isRetake) {
          throw apiError_('CLOSED', 'This exam closed on ' + fmtDate_(exam.end, tz_()) + '.');
        }
        if (env.isExtended === true) {
          throw apiError_('SECOND_MONITOR', 'A second monitor is connected. Disconnect it before starting the exam.');
        }
        if (settings.REQUIRE_MONITOR_CHECK && env.monitorCheck !== 'supported') {
          throw apiError_('UNSUPPORTED_BROWSER', 'Please open the exam in Google Chrome or Microsoft Edge on a laptop or desktop computer.');
        }
        if (exam.faceMode !== 'OFF' && env.camera !== 'ok') {
          throw apiError_('CAMERA_REQUIRED', 'This exam requires your camera. Turn it on and make sure your face is visible.');
        }

        let deadline = exam.limitMin > 0 ? new Date(now.getTime() + exam.limitMin * 60000) : null;
        if (!isRetake && exam.end && (!deadline || exam.end < deadline)) deadline = exam.end;

        attempt = {
          AttemptID: Utilities.getUuid(),
          ExamID: exam.id,
          StudentID: asText_(studentId),
          Name: asText_(name),
          Status: STATUS.IN_PROGRESS,
          StartedAt: now,
          Deadline: deadline || '',
          SubmittedAt: '',
          Score: '',
          MaxScore: sum_(questions.map(q => q.points)),
          Percent: '',
          PendingEssays: '',
          Late: '',
          VoidReason: '',
          VoidedAt: '',
          AllowRetake: false,
          IsRetake: isRetake,
          UserAgent: asText_(String(env.userAgent || '').slice(0, 300)),
          Course: asText_(exam.course),
        };
        appendObj_(attempts, attempt, ['AllowRetake']);
      }

      const deadline = toDate_(attempt.Deadline);
      const ordered = exam.shuffleQuestions ? seededShuffle_(questions, attempt.AttemptID) : questions;
      return {
        attemptId: attempt.AttemptID,
        studentId: studentId,
        studentName: name,
        resumed: resumed,
        isRetake: toBool_(attempt.IsRetake, false),
        deadlineMs: deadline ? deadline.getTime() : null,
        remainingMs: deadline ? Math.max(0, deadline.getTime() - now.getTime()) : null,
        questions: ordered.map(q => publicQuestion_(q, exam, attempt.AttemptID)),
        lockedIds: resumed && !exam.allowBack ? Object.keys(lockedAnswers_(attempt.AttemptID)) : [],
      };
    });
  },

  /** Records a violation and voids the attempt. Also used through navigator.sendBeacon. */
  violation(req) {
    return withLock_(() => {
      const attempts = readTable_(SHEET.ATTEMPTS);
      const a = findAttempt_(attempts, req.attemptId);
      const event = VIOLATION_LABELS[req.event] ? req.event : 'TAB_SWITCH';
      if (a.Status !== STATUS.IN_PROGRESS) {
        logViolation_(a, event, req.detail);
        return { status: a.Status, reason: a.VoidReason };
      }
      if (WARNABLE_EVENTS.indexOf(event) !== -1 && !(Number(a.Warnings) > 0)) {
        logViolation_(a, event, 'WARNING (1st offense): ' + String(req.detail || ''));
        updateFields_(attempts, a, { Warnings: 1 });
        return { status: a.Status, warned: true };
      }
      logViolation_(a, event, (WARNABLE_EVENTS.indexOf(event) !== -1 ? 'VOIDED (2nd offense): ' : 'VOIDED: ') + String(req.detail || ''));
      voidAttempt_(attempts, a, event);
      return { status: a.Status, reason: a.VoidReason };
    });
  },

  /** One-question-at-a-time without going back: saves and locks an answer when the student moves on. */
  lockAnswer(req) {
    return withLock_(() => {
      const attempts = readTable_(SHEET.ATTEMPTS);
      const a = findAttempt_(attempts, req.attemptId);
      if (a.Status !== STATUS.IN_PROGRESS) throw blockedError_(a);
      const exam = examConfig_(getExamRow_(a.ExamID, true));
      if (exam.allowBack) return { locked: false };
      const qid = String(req.questionId || '');
      if (exam.questionIds.indexOf(qid) === -1) throw apiError_('BAD_INPUT', 'Unknown question.');
      const locked = lockedAnswers_(a.AttemptID);
      if (!(qid in locked)) {
        const v = req.value === undefined || req.value === null ? '' : String(req.value).slice(0, 20000);
        appendObj_(readTable_(SHEET.PROGRESS), { Timestamp: new Date(), AttemptID: a.AttemptID, QuestionID: asText_(qid), Answer: asText_(v) });
      }
      return { locked: true };
    });
  },

  /** Grades and records the submission. */
  submit(req) {
    return withLock_(() => {
      const attempts = readTable_(SHEET.ATTEMPTS);
      const a = findAttempt_(attempts, req.attemptId);
      const exam = examConfig_(getExamRow_(a.ExamID, true));

      if (a.Status === STATUS.SUBMITTED) return resultFor_(a, exam); // double submit / retry
      if (a.Status === STATUS.VOIDED) throw blockedError_(a);
      if (a.Status !== STATUS.IN_PROGRESS) throw blockedError_(a);

      const reported = Array.isArray(req.violations) ? req.violations : [];
      if (reported.length) {
        const v = reported[0] || {};
        const event = VIOLATION_LABELS[v.event] ? v.event : 'TAB_SWITCH';
        logViolation_(a, event, v.detail);
        voidAttempt_(attempts, a, event);
        throw blockedError_(a);
      }

      const settings = getSettings_();
      const now = new Date();
      const deadline = toDate_(a.Deadline);
      const late = !!deadline && now.getTime() > deadline.getTime() + settings.SUBMIT_GRACE_SECONDS * 1000;

      const bank = getQuestionBank_();
      const questions = examQuestions_(exam, bank);
      const answers = Object.assign({}, (req.answers && typeof req.answers === 'object') ? req.answers : {});
      if (!exam.allowBack) Object.assign(answers, lockedAnswers_(a.AttemptID)); // locked answers can't be changed

      let score = 0, max = 0, pending = 0;
      const rows = questions.map(q => {
        const g = gradeQuestion_(q, answers[q.id]);
        max += q.points;
        if (g.pending) pending++; else score += g.points;
        return {
          AttemptID: a.AttemptID,
          ExamID: exam.id,
          StudentID: asText_(String(a.StudentID)),
          QuestionID: asText_(q.id),
          Type: q.type,
          Question: asText_(q.text),
          StudentAnswer: asText_(g.studentText),
          CorrectAnswer: asText_(g.correctText),
          IsCorrect: g.pending ? '' : g.correct,
          PointsEarned: g.pending ? '' : g.points,
          MaxPoints: q.points,
        };
      });
      appendObjs_(readTable_(SHEET.RESPONSES), rows);

      updateFields_(attempts, a, {
        Status: STATUS.SUBMITTED,
        SubmittedAt: now,
        Score: score,
        MaxScore: max,
        Percent: max ? round2_(score / max * 100) : 0,
        PendingEssays: pending,
        Late: late,
      });
      return resultFor_(a, exam);
    });
  },
};

// ───────────────────────────── Grading ─────────────────────────────

function gradeQuestion_(q, raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).slice(0, 20000);
  const out = { correct: false, points: 0, pending: false, studentText: value, correctText: '' };

  if (q.type === 'MC') {
    const ci = mcCorrectIndex_(q);
    out.correctText = ci >= 0 ? letter_(ci) + '. ' + q.choices[ci] : String(q.answer);
    if (value !== '' && /^\d+$/.test(value) && q.choices[Number(value)] !== undefined) {
      const idx = Number(value);
      out.studentText = letter_(idx) + '. ' + q.choices[idx];
      out.correct = idx === ci;
    } else {
      out.studentText = '';
    }
  } else if (q.type === 'TF') {
    const expected = parseTF_(q.answer);
    const given = parseTF_(value);
    out.correctText = expected === null ? String(q.answer) : (expected ? 'True' : 'False');
    out.studentText = given === null ? '' : (given ? 'True' : 'False');
    out.correct = given !== null && given === expected;
  } else if (q.type === 'FIB') {
    const accepted = String(q.answer).split('|').map(normText_).filter(Boolean);
    out.correctText = String(q.answer).split('|').map(s => s.trim()).filter(Boolean).join(' / ');
    out.correct = value.trim() !== '' && accepted.indexOf(normText_(value)) !== -1;
  } else { // ESSAY – graded by the teacher in the Responses sheet
    out.pending = true;
    out.correctText = String(q.answer || '');
  }
  if (out.correct) out.points = q.points;
  return out;
}

function mcCorrectIndex_(q) {
  const ans = String(q.answer).trim();
  if (/^[A-Za-z]$/.test(ans)) {
    const i = ans.toUpperCase().charCodeAt(0) - 65;
    return i < q.choices.length ? i : -1;
  }
  const n = normText_(ans);
  return q.choices.findIndex(c => normText_(c) === n);
}

function parseTF_(v) {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1'].indexOf(s) !== -1) return true;
  if (['false', 'f', 'no', 'n', '0'].indexOf(s) !== -1) return false;
  return null;
}

function normText_(v) {
  return String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

function letter_(i) { return String.fromCharCode(65 + i); }

function resultFor_(a, exam) {
  if (!exam.showScore) return { submitted: true, showScore: false };
  return {
    submitted: true,
    showScore: true,
    score: Number(a.Score) || 0,
    maxScore: Number(a.MaxScore) || 0,
    percent: Number(a.Percent) || 0,
    pendingEssays: Number(a.PendingEssays) || 0,
  };
}

// ───────────────────────────── Exams & questions ─────────────────────────────

function getExamRow_(examId, allowInactive) {
  const id = String(examId || '').trim();
  if (!id) throw apiError_('NO_EXAM', 'This link has no exam ID. Ask your instructor for the correct exam link.');
  const row = readTable_(SHEET.EXAMS).rows.find(r => String(r.ExamID).trim().toLowerCase() === id.toLowerCase());
  if (!row || (!allowInactive && !toBool_(row.Active, true))) {
    throw apiError_('EXAM_NOT_FOUND', 'Exam "' + id + '" was not found or is not active.');
  }
  return row;
}

/**
 * Exams → FaceMonitor:
 *   OFF    – no camera needed
 *   START  – face must be visible before starting; camera turns off when the exam begins
 *   ALWAYS – face checked before starting AND monitored during the exam (1 warning, then void)
 * TRUE (older sheets) means ALWAYS; FALSE / empty means OFF.
 */
function parseFaceMode_(v) {
  if (v === true) return 'ALWAYS';
  const s = String(v === undefined || v === null ? '' : v).trim().toUpperCase();
  if (s === 'START' || s === 'ALWAYS') return s;
  return toBool_(s, false) ? 'ALWAYS' : 'OFF';
}

function examConfig_(row) {
  const cfg = {
    id: String(row.ExamID).trim(),
    title: String(row.Title || row.ExamID),
    instructions: String(row.Instructions || ''),
    questionIds: parseIdList_(row.QuestionIDs),
    start: toDate_(row.StartDateTime),
    end: toDate_(row.EndDateTime),
    limitMin: Math.max(0, Number(row.TimeLimitMinutes) || 0),
    shuffleQuestions: toBool_(row.ShuffleQuestions, false),
    shuffleChoices: toBool_(row.ShuffleChoices, false),
    showScore: toBool_(row.ShowScore, true),
    course: String(row.Course || '').trim(),
    displayMode: String(row.DisplayMode || '').trim().toUpperCase() === 'ONE' ? 'ONE' : 'ALL',
    faceMode: parseFaceMode_(row.FaceMonitor),
    cameraPreview: toBool_(row.CameraPreview, true),
  };
  // "No going back" only makes sense when questions are shown one at a time
  cfg.allowBack = cfg.displayMode === 'ONE' ? toBool_(row.AllowBack, true) : true;
  return cfg;
}

function getQuestionBank_() {
  const map = {};
  readTable_(SHEET.QUESTIONS).rows.forEach(r => {
    const id = String(r.QuestionID).trim();
    if (!id) return;
    const type = normType_(r.Type);
    map[id] = {
      id: id,
      type: type,
      rawType: String(r.Type),
      text: String(r.Question),
      choices: type === 'MC' ? String(r.Choices).split('|').map(s => s.trim()).filter(s => s !== '') : [],
      answer: r.Answer,
      points: Number(r.Points) > 0 ? Number(r.Points) : 1,
      topic: String(r.Topic || '').trim(),
      row: r._row,
    };
  });
  return map;
}

function examQuestions_(exam, bank) {
  if (!exam.questionIds.length) throw apiError_('CONFIG', 'Exam "' + exam.id + '" has no questions yet.');
  return exam.questionIds.map(id => {
    const q = bank[id];
    if (!q) throw apiError_('CONFIG', 'Exam "' + exam.id + '" uses question "' + id + '", which is not in the Questions sheet.');
    const problems = validateQuestion_(q);
    if (problems.length) throw apiError_('CONFIG', 'Question "' + id + '" has a problem: ' + problems.join('; '));
    return q;
  });
}

function validateQuestion_(q) {
  const p = [];
  if (!q.type) p.push('unknown Type "' + q.rawType + '" (use MC, TF, FIB or ESSAY)');
  if (!String(q.text).trim()) p.push('the Question text is empty');
  if (q.type === 'MC') {
    if (q.choices.length < 2) p.push('needs at least 2 choices separated by |');
    else if (mcCorrectIndex_(q) < 0) p.push('Answer must be a letter (A, B, C…) or the exact text of one choice');
  }
  if (q.type === 'TF' && parseTF_(q.answer) === null) p.push('Answer must be TRUE or FALSE');
  if (q.type === 'FIB' && !String(q.answer).trim()) p.push('Answer is empty (separate accepted answers with |)');
  return p;
}

function publicQuestion_(q, exam, attemptId) {
  const out = { id: q.id, type: q.type, text: q.text, points: q.points };
  if (q.type === 'MC') {
    let choices = q.choices.map((t, i) => ({ key: String(i), text: t }));
    if (exam.shuffleChoices) choices = seededShuffle_(choices, attemptId + ':' + q.id);
    out.choices = choices;
  }
  return out;
}

function normType_(t) {
  const s = String(t || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (['MC', 'MCQ', 'MULTIPLECHOICE'].indexOf(s) !== -1) return 'MC';
  if (['TF', 'TRUEFALSE', 'TRUEORFALSE'].indexOf(s) !== -1) return 'TF';
  if (['FIB', 'FILLINTHEBLANK', 'FILLINTHEBLANKS', 'BLANK', 'IDENTIFICATION'].indexOf(s) !== -1) return 'FIB';
  if (['ESSAY', 'SHORTESSAY'].indexOf(s) !== -1) return 'ESSAY';
  return '';
}

function windowStatus_(exam, now) {
  if (exam.start && now < exam.start) return 'NOT_YET_OPEN';
  if (exam.end && now > exam.end) return 'CLOSED';
  return 'OPEN';
}

// ───────────────────────────── Attempts ─────────────────────────────

/** Answers locked for an attempt: { questionId: answer } (first save wins). */
function lockedAnswers_(attemptId) {
  const out = {};
  readTable_(SHEET.PROGRESS).rows.forEach(r => {
    const q = String(r.QuestionID);
    if (String(r.AttemptID) === String(attemptId) && !(q in out)) out[q] = r.Answer === null ? '' : String(r.Answer);
  });
  return out;
}

function findAttempt_(table, attemptId) {
  const id = String(attemptId || '').trim();
  const a = id && table.rows.find(r => String(r.AttemptID) === id);
  if (!a) throw apiError_('NO_ATTEMPT', 'This exam session was not found. Reload the exam link.');
  return a;
}

function voidAttempt_(table, a, event) {
  updateFields_(table, a, { Status: STATUS.VOIDED, VoidReason: VIOLATION_LABELS[event], VoidedAt: new Date() });
}

function logViolation_(a, event, detail) {
  appendObj_(readTable_(SHEET.VIOLATIONS), {
    Timestamp: new Date(),
    AttemptID: a.AttemptID,
    ExamID: a.ExamID,
    StudentID: asText_(String(a.StudentID)),
    Name: asText_(String(a.Name)),
    Event: event,
    Detail: asText_(String(detail || '').slice(0, 500)),
  });
}

function blockedError_(a) {
  switch (a.Status) {
    case STATUS.VOIDED:
      return apiError_('VOIDED', 'Your exam was voided: ' + (a.VoidReason || 'exam rules were broken') +
        '. Please inform your instructor about this event. Only your instructor can allow you to take it again.');
    case STATUS.SUBMITTED:
      return apiError_('ALREADY_SUBMITTED', 'You have already submitted this exam. Contact your instructor if you need to take it again.');
    case STATUS.EXPIRED:
      return apiError_('EXPIRED', 'The time for your attempt ran out before it was submitted. Contact your instructor.');
    default:
      return apiError_('NOT_ACTIVE', 'This attempt can no longer be continued.');
  }
}

// ───────────────────────────── Teacher menu ─────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Exam Admin')
    .addItem('Set up sheets (run once)', 'setupSheets')
    .addItem('Exam Builder…', 'openExamBuilder')
    .addItem('Show exam links', 'showExamLinks')
    .addSeparator()
    .addItem('Allow retake for selected attempt(s)', 'allowRetakeForSelection')
    .addItem('Recalculate scores (after grading essays)', 'recalculateScores')
    .addItem('Check question bank for errors', 'checkQuestionBank')
    .addToUi();
}

/** Creates all sheets with headers, default settings and sample data. Safe to run again. */
function setupSheets() {
  const ss = ss_();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const wanted = HEADERS[name];
    const lastCol = sh.getLastColumn();
    const existing = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim()) : [];
    const missing = wanted.filter(h => existing.indexOf(h) === -1);
    if (missing.length) {
      const startCol = existing.filter(h => h !== '').length + 1;
      sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
    }
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#e8eefc');
    sh.setFrozenRows(1);
  });

  // Settings
  const settings = readTable_(SHEET.SETTINGS);
  const haveKeys = settings.rows.map(r => String(r.Key).trim());
  DEFAULT_SETTINGS.forEach(s => {
    if (haveKeys.indexOf(s[0]) === -1) appendObj_(settings, { Key: s[0], Value: s[1], Description: s[2] });
  });

  // Sample questions and exam (only when empty)
  const qTable = readTable_(SHEET.QUESTIONS);
  if (!qTable.rows.length) appendObjs_(qTable, SAMPLE_QUESTIONS_());
  const eTable = readTable_(SHEET.EXAMS);
  if (!eTable.rows.length) {
    const now = new Date();
    appendObj_(eTable, {
      ExamID: 'SAMPLE-QUIZ',
      Title: 'Sample Quiz',
      Instructions: 'Answer all questions. Essay answers are graded by your instructor.',
      QuestionIDs: 'Q001, Q002, Q003, Q004, Q005, Q006, Q007, Q008',
      StartDateTime: new Date(now.getTime() - 3600000),
      EndDateTime: new Date(now.getTime() + 30 * 86400000),
      TimeLimitMinutes: 30,
      ShuffleQuestions: true,
      ShuffleChoices: true,
      ShowScore: true,
      Active: true,
    });
  }

  // Remove the empty default sheet, if any
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  safeAlert_('Setup complete.\n\nNext: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone). ' +
    'Paste the Web app URL into docs/config.js, and put your student page address in Settings → STUDENT_APP_URL.');
}

function SAMPLE_QUESTIONS_() {
  return [
    ['Q001', 'MC', 'Which planet is known as the Red Planet?', 'Venus | Mars | Jupiter | Saturn', 'B', 1, 'Science'],
    ['Q002', 'MC', 'What is 7 × 8?', '54 | 56 | 64 | 48', 'B', 1, 'Math'],
    ['Q003', 'TF', 'The Pacific Ocean is the largest ocean on Earth.', '', 'TRUE', 1, 'Geography'],
    ['Q004', 'TF', 'Water boils at 50 °C at sea level.', '', 'FALSE', 1, 'Science'],
    ['Q005', 'FIB', 'The chemical symbol for gold is ____.', '', 'Au', 1, 'Science'],
    ['Q006', 'FIB', 'The capital city of Japan is ____.', '', 'Tokyo', 1, 'Geography'],
    ['Q007', 'FIB', 'The longest side of a right triangle is called the ____.', '', 'hypotenuse | the hypotenuse', 1, 'Math'],
    ['Q008', 'ESSAY', 'In 3–5 sentences, explain why the sky appears blue during the day.', '', 'Sunlight is scattered by air molecules; blue light (shorter wavelength) scatters the most (Rayleigh scattering).', 5, 'Science'],
  ].map(r => ({ QuestionID: r[0], Type: r[1], Question: r[2], Choices: r[3], Answer: r[4], Points: r[5], Topic: r[6] }));
}

function openExamBuilder() {
  const html = HtmlService.createHtmlOutputFromFile('Builder').setWidth(1000).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, 'Exam Builder');
}

/** Called by Builder.html */
function builderGetData() {
  const tz = tz_();
  const bank = getQuestionBank_();
  const settings = getSettings_();
  const exams = readTable_(SHEET.EXAMS).rows.filter(r => String(r.ExamID).trim()).map(r => {
    const e = examConfig_(r);
    return {
      id: e.id, title: e.title, course: e.course, instructions: e.instructions, questionIds: e.questionIds,
      start: e.start ? Utilities.formatDate(e.start, tz, "yyyy-MM-dd'T'HH:mm") : '',
      end: e.end ? Utilities.formatDate(e.end, tz, "yyyy-MM-dd'T'HH:mm") : '',
      limitMin: e.limitMin, shuffleQuestions: e.shuffleQuestions, shuffleChoices: e.shuffleChoices,
      showScore: e.showScore, active: toBool_(r.Active, true), link: examLink_(e.id, settings),
      displayMode: e.displayMode, allowBack: e.allowBack, faceMode: e.faceMode, cameraPreview: e.cameraPreview,
    };
  });
  return {
    timeZone: tz,
    now: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm"),
    studentAppUrl: settings.STUDENT_APP_URL,
    questions: Object.keys(bank).map(id => {
      const q = bank[id];
      return { id: q.id, type: q.type || q.rawType, text: q.text, choices: q.choices, points: q.points, topic: q.topic, problems: validateQuestion_(q) };
    }),
    exams: exams,
    courses: knownCourses_(),
  };
}

/** Course codes used in the Roster and in Exams, for the Builder's dropdown. */
function knownCourses_() {
  const seen = {};
  const add = c => { const k = normCourse_(c); if (k && !seen[k]) seen[k] = String(c).trim(); };
  readTable_(SHEET.ROSTER).rows.forEach(r => String(r.Courses || '').split(/[,;\n]+/).forEach(add));
  readTable_(SHEET.EXAMS).rows.forEach(r => add(r.Course || ''));
  return Object.keys(seen).sort().map(k => seen[k]);
}

/** Called by Builder.html — creates or updates an exam row. */
function builderSaveExam(form) {
  const tz = tz_();
  const title = String(form.title || '').trim();
  if (!title) throw new Error('Please enter a title.');
  const ids = (form.questionIds || []).map(String);
  if (!ids.length) throw new Error('Select at least one question.');
  const bank = getQuestionBank_();
  ids.forEach(id => {
    if (!bank[id]) throw new Error('Question ' + id + ' no longer exists.');
    const p = validateQuestion_(bank[id]);
    if (p.length) throw new Error('Question ' + id + ': ' + p.join('; '));
  });
  const parse = s => s ? Utilities.parseDate(String(s), tz, "yyyy-MM-dd'T'HH:mm") : '';
  const start = parse(form.start), end = parse(form.end);
  if (start && end && end <= start) throw new Error('The end date/time must be after the start.');
  const limit = Number(form.limitMin) || 0;
  if (limit < 0) throw new Error('Time limit cannot be negative.');

  let examId = String(form.id || '').trim().replace(/\s+/g, '-');
  if (examId && !/^[A-Za-z0-9_-]+$/.test(examId)) throw new Error('Exam ID may contain only letters, numbers, - and _.');
  if (!examId) examId = 'EXAM-' + Utilities.formatDate(new Date(), tz, 'yyMMdd-HHmmss');

  const table = readTable_(SHEET.EXAMS);
  const fields = {
    ExamID: examId,
    Title: asText_(title),
    Instructions: asText_(String(form.instructions || '')),
    QuestionIDs: asText_(ids.join(', ')),
    StartDateTime: start,
    EndDateTime: end,
    TimeLimitMinutes: limit,
    ShuffleQuestions: !!form.shuffleQuestions,
    ShuffleChoices: !!form.shuffleChoices,
    ShowScore: !!form.showScore,
    Active: form.active !== false,
    Course: asText_(String(form.course || '').trim()),
    DisplayMode: form.displayMode === 'ONE' ? 'ONE' : 'ALL',
    FaceMonitor: parseFaceMode_(form.faceMode),
    CameraPreview: form.cameraPreview !== false,
    AllowBack: form.displayMode === 'ONE' ? form.allowBack !== false : true,
  };
  const existing = table.rows.find(r => String(r.ExamID).trim().toLowerCase() === examId.toLowerCase());
  if (existing) {
    if (!form.editing) throw new Error('An exam with ID "' + examId + '" already exists. Choose another ID or edit that exam.');
    updateFields_(table, existing, fields);
  } else {
    appendObj_(table, fields);
  }
  // Warn (but still save) when nobody on the Roster is enrolled in this course
  let warning = '';
  const course = normCourse_(form.course || '');
  const roster = readTable_(SHEET.ROSTER).rows.filter(r => String(r.StudentID).trim() !== '');
  if (course && roster.length) {
    const n = roster.filter(r => parseCourses_(r.Courses).indexOf(course) !== -1).length;
    if (!n) warning = 'No student in the Roster has "' + String(form.course).trim() + '" in their Courses column, so nobody can take this exam yet.';
  }
  if (course && !roster.length) warning = 'The Roster is empty, so anyone with the link can take this exam. Fill in the Roster to limit it to ' + String(form.course).trim() + ' students.';
  return { id: examId, link: examLink_(examId, getSettings_()), warning: warning };
}

function showExamLinks() {
  const settings = getSettings_();
  const rows = readTable_(SHEET.EXAMS).rows.filter(r => String(r.ExamID).trim());
  const items = rows.map(r => {
    const id = String(r.ExamID).trim();
    const link = examLink_(id, settings);
    return '<li><b>' + esc_(r.Title || id) + '</b> <small>(' + esc_(id) + (String(r.Course || '').trim() ? ', ' + esc_(r.Course) : '') + (toBool_(r.Active, true) ? '' : ', inactive') + ')</small><br>' +
      (link ? '<input style="width:100%" readonly onclick="this.select()" value="' + esc_(link) + '">' : '<i>Set STUDENT_APP_URL in the Settings sheet first.</i>') + '</li>';
  }).join('');
  const html = '<div style="font:14px Arial,sans-serif"><p>Copy a link and post it in Google Classroom (Classwork → Create → Assignment → Add → Link).</p><ul style="padding-left:18px;line-height:1.6">' +
    (items || '<li>No exams yet.</li>') + '</ul></div>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(640).setHeight(420), 'Exam links');
}

function allowRetakeForSelection() {
  const ui = SpreadsheetApp.getUi();
  const sheet = ss_().getActiveSheet();
  if (sheet.getName() !== SHEET.ATTEMPTS) {
    ui.alert('Open the "Attempts" sheet and select the row(s) of the student attempt(s) first.');
    return;
  }
  const table = readTable_(SHEET.ATTEMPTS);
  const rowNums = {};
  sheet.getActiveRangeList().getRanges().forEach(rg => {
    for (let r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) if (r > 1) rowNums[r] = true;
  });
  const picked = table.rows.filter(r => rowNums[r._row]);
  if (!picked.length) { ui.alert('Select at least one attempt row (not the header).'); return; }
  const names = picked.map(r => '• ' + r.Name + ' (' + r.StudentID + ') — ' + r.ExamID + ' — ' + r.Status).join('\n');
  if (ui.alert('Allow these students to take the exam again?\n\n' + names, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  picked.forEach(r => updateFields_(table, r, { AllowRetake: true }));
  ui.alert('Done. These students can now open the exam link again.\n(A retake gets the full time limit, even if the exam window has closed.)');
}

/** Totals PointsEarned from Responses (after you grade essays there) back into Attempts. */
function recalculateScores() {
  const responses = readTable_(SHEET.RESPONSES).rows;
  const byAttempt = {};
  responses.forEach(r => {
    const id = String(r.AttemptID);
    const t = byAttempt[id] || (byAttempt[id] = { score: 0, max: 0, pending: 0 });
    t.max += Number(r.MaxPoints) || 0;
    if (r.PointsEarned === '' || r.PointsEarned === null) { if (normType_(r.Type) === 'ESSAY') t.pending++; }
    else t.score += Number(r.PointsEarned) || 0;
  });
  const attempts = readTable_(SHEET.ATTEMPTS);
  let n = 0;
  attempts.rows.forEach(a => {
    const t = byAttempt[String(a.AttemptID)];
    if (!t || a.Status !== STATUS.SUBMITTED) return;
    updateFields_(attempts, a, { Score: t.score, MaxScore: t.max, Percent: t.max ? round2_(t.score / t.max * 100) : 0, PendingEssays: t.pending });
    n++;
  });
  safeAlert_('Recalculated ' + n + ' submitted attempt(s).');
}

function checkQuestionBank() {
  const bank = getQuestionBank_();
  const problems = [];
  Object.keys(bank).forEach(id => {
    const p = validateQuestion_(bank[id]);
    if (p.length) problems.push('Row ' + bank[id].row + ' (' + id + '): ' + p.join('; '));
  });
  safeAlert_(problems.length ? 'Problems found:\n\n' + problems.join('\n') : 'All ' + Object.keys(bank).length + ' questions look good.');
}

// ───────────────────────────── Sheet helpers ─────────────────────────────

function ss_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* not bound */ }
  if (!ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw apiError_('CONFIG', 'Spreadsheet not found. Open the Sheet and run Exam Admin → Set up sheets.');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

function tz_() { return ss_().getSpreadsheetTimeZone(); }

/** Reads a sheet into objects keyed by header. Each object has _row (1-based sheet row). */
function readTable_(name) {
  const sheet = ss_().getSheetByName(name);
  if (!sheet) throw apiError_('CONFIG', 'Sheet "' + name + '" is missing. Run Exam Admin → Set up sheets.');
  const values = sheet.getLastRow() ? sheet.getDataRange().getValues() : [[]];
  const headers = values[0].map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v.every(c => c === '' || c === null)) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) o[h] = v[j]; });
    rows.push(o);
  }
  return { sheet: sheet, headers: headers, rows: rows };
}

function appendObj_(table, obj, checkboxCols) {
  const values = table.headers.map(h => (obj[h] === undefined ? '' : obj[h]));
  table.sheet.appendRow(values);
  const row = table.sheet.getLastRow();
  (checkboxCols || []).forEach(h => {
    const c = table.headers.indexOf(h);
    if (c !== -1) table.sheet.getRange(row, c + 1).insertCheckboxes();
  });
  obj._row = row;
  table.rows.push(obj);
  return obj;
}

function appendObjs_(table, objs) {
  if (!objs.length) return;
  const values = objs.map(o => table.headers.map(h => (o[h] === undefined ? '' : o[h])));
  const start = table.sheet.getLastRow() + 1;
  table.sheet.getRange(start, 1, values.length, table.headers.length).setValues(values);
}

function updateFields_(table, obj, fields) {
  Object.keys(fields).forEach(k => {
    const c = table.headers.indexOf(k);
    if (c === -1) return;
    table.sheet.getRange(obj._row, c + 1).setValue(fields[k]);
    obj[k] = fields[k];
  });
}

function getSettings_() {
  const s = {};
  DEFAULT_SETTINGS.forEach(d => { s[d[0]] = d[1]; });
  try {
    readTable_(SHEET.SETTINGS).rows.forEach(r => {
      const k = String(r.Key).trim();
      if (k && r.Value !== '' && r.Value !== null) s[k] = r.Value;
    });
  } catch (e) { /* use defaults */ }
  s.BLUR_GRACE_SECONDS = Math.max(0, Number(s.BLUR_GRACE_SECONDS) || 0);
  s.SUBMIT_GRACE_SECONDS = Math.max(0, Number(s.SUBMIT_GRACE_SECONDS) || 0);
  s.FACE_GRACE_SECONDS = Math.max(1, Number(s.FACE_GRACE_SECONDS) || 3);
  s.PHONE_DETECTION = toBool_(s.PHONE_DETECTION, true);
  s.REQUIRE_MONITOR_CHECK = toBool_(s.REQUIRE_MONITOR_CHECK, true);
  s.BLOCK_COPY_PASTE = toBool_(s.BLOCK_COPY_PASTE, true);
  s.STUDENT_APP_URL = String(s.STUDENT_APP_URL || '').trim();
  return s;
}

function examLink_(examId, settings) {
  const base = settings.STUDENT_APP_URL;
  if (!base) return '';
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'exam=' + encodeURIComponent(examId);
}

// ───────────────────────────── Small utilities ─────────────────────────────

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function apiError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

function toDate_(v) {
  if (isDate_(v)) return v;
  if (v === '' || v === null || v === undefined) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function toBool_(v, def) {
  if (v === '' || v === null || v === undefined) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toUpperCase();
  if (['TRUE', 'YES', 'Y', '1'].indexOf(s) !== -1) return true;
  if (['FALSE', 'NO', 'N', '0'].indexOf(s) !== -1) return false;
  return def;
}

/** Stops Sheets from turning text into formulas or numbers (e.g. "=HYPERLINK…", "00123"). */
function asText_(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@]/.test(s) || /^[\d\s.,]+$/.test(s.trim()) && s.trim() !== '') return "'" + s;
  return s;
}

/** Leading zeros and case don't matter when matching student IDs. */
function normId_(v) { return String(v).trim().toLowerCase().replace(/^0+(?=\d)/, ''); }

/** "MATH 101" and "math101" count as the same course. */
function normCourse_(v) { return String(v || '').trim().toUpperCase().replace(/\s+/g, ''); }

/** A Roster "Courses" cell like "MATH101, SCI201" → ['MATH101', 'SCI201'] */
function parseCourses_(v) { return String(v || '').split(/[,;\n]+/).map(normCourse_).filter(Boolean); }

function parseIdList_(v) { return String(v || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean); }

function sum_(arr) { return arr.reduce((a, b) => a + b, 0); }

function round2_(n) { return Math.round(n * 100) / 100; }

function countBy_(arr, fn) { const o = {}; arr.forEach(x => { const k = fn(x); o[k] = (o[k] || 0) + 1; }); return o; }

function fmtDate_(d, tz) { return Utilities.formatDate(d, tz, 'MMM d, yyyy h:mm a') + ' (' + tz + ')'; }

function esc_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

/** Deterministic shuffle so a resumed attempt sees the same order. */
function seededShuffle_(arr, seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}
