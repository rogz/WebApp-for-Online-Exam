// End-to-end test: runs apps-script/Code.gs against an in-memory fake of Google Sheets
// and drives docs/ in Chromium. Run with: node tests/e2e.test.js  (needs the playwright package)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { create } = require('./mock-apps-script');
const REPO = path.resolve(__dirname, '..');
const gas = create(path.join(REPO, 'apps-script/Code.gs'));
gas.ctx.setupSheets();

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let b = ''; req.on('data', d => b += d); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(gas.call(b))); });
    return;
  }
  const u = req.url.split('?')[0];
  if (u === '/config.js') { res.setHeader('content-type', 'text/javascript'); return res.end("window.EXAM_CONFIG={API_URL:'/api'};"); }
  const f = path.join(REPO, 'docs', u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)]);
  res.end(fs.readFileSync(f));
});

const attempts = () => gas.sheet('Attempts').objects();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(8123, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return !!window.__ext; } });
  });
  const errors = [];
  async function open(exam = 'SAMPLE-QUIZ') {
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:8123/?exam=' + exam);
    return p;
  }
  async function startAs(p, id, name) {
    await p.waitForSelector('#screen-rules:not([hidden])');
    await p.fill('#studentId', id); await p.fill('#studentName', name);
    await p.check('#agree');
    await p.click('#startBtn');
  }

  // 1. Full happy path + grading
  let p = await open();
  await p.waitForSelector('#screen-rules:not([hidden])');
  ok(await p.isDisabled('#startBtn'), 'start disabled before agreeing');
  ok((await p.textContent('#checkMonitor')).includes('One screen'), 'single monitor detected');
  await startAs(p, '00123', 'Ana Santos');
  await p.waitForSelector('#screen-exam:not([hidden])');
  const qs = await p.$$eval('.question', els => els.map(e => e.dataset.id));
  ok(qs.length === 8, '8 questions rendered');
  // answer correctly using the bank
  const bank = Object.fromEntries(gas.sheet('Questions').objects().map(q => [q.QuestionID, q]));
  for (const id of qs) {
    const q = bank[id];
    const li = `.question[data-id="${id}"]`;
    if (q.Type === 'MC') {
      const want = q.Choices.split('|').map(s => s.trim())[q.Answer.charCodeAt(0) - 65];
      await p.click(`${li} .choice:has-text("${want}")`);
    } else if (q.Type === 'TF') await p.check(`${li} input[value="${q.Answer === true ? 'TRUE' : 'FALSE'}"]`);
    else if (q.Type === 'FIB') await p.fill(`${li} input.blank`, id === 'Q005' ? ' au ' : String(q.Answer).split('|')[0]);
    else await p.fill(`${li} textarea`, 'Because of Rayleigh scattering.');
  }
  ok((await p.textContent('#progress')).startsWith('8 / 8'), 'progress counts answers');
  await p.click('#submitBtn'); await p.click('#confirmYes');
  await p.waitForSelector('#screen-result:not([hidden])');
  const scoreTxt = await p.textContent('#resultScore');
  ok(scoreTxt.includes('7 / 12'), 'score shown: ' + scoreTxt);
  let a = attempts()[0];
  ok(a.Status === 'SUBMITTED' && a.Score === 7 && a.PendingEssays === 1, 'attempt recorded ' + JSON.stringify([a.Status, a.Score, a.PendingEssays, a.StudentID]));
  ok(gas.sheet('Responses').objects().length === 8, '8 responses rows');
  await p.close();

  // 2. same student again (with leading-zero variation) → already submitted
  p = await open();
  await startAs(p, '123', 'Ana Santos');
  await p.waitForSelector('#startError:not([hidden])');
  ok((await p.textContent('#startError')).includes('already submitted'), 'second attempt blocked');
  await p.close();

  // 3. tab switch voids (beacon path)
  p = await open();
  await startAs(p, 'S2', 'Ben Cruz');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForSelector('#voidModal:not([hidden])');
  ok((await p.textContent('#voidReason')).includes('switched'), 'void modal for tab switch');
  await sleep(500);
  a = attempts().find(x => x.StudentID === 'S2');
  ok(a.Status === 'VOIDED', 'attempt voided via beacon: ' + a.Status);
  ok(gas.sheet('Violations').objects().some(v => v.Event === 'TAB_SWITCH'), 'violation logged');
  await p.evaluate(() => { delete document.visibilityState; });
  await p.close();

  // 4. voided student blocked, then retake allowed
  p = await open();
  await startAs(p, 'S2', 'Ben Cruz');
  await p.waitForSelector('#startError:not([hidden])');
  ok((await p.textContent('#startError')).includes('voided'), 'voided student blocked');
  const sh = gas.sheet('Attempts'); const hdr = sh.data[0]; const rowIdx = sh.data.findIndex(r => r[hdr.indexOf('StudentID')] === 'S2');
  sh.set(rowIdx + 1, hdr.indexOf('AllowRetake') + 1, true);
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok((await p.textContent('#studentLine')).includes('Retake'), 'retake started');
  // 5. blur voids
  await p.evaluate(() => window.dispatchEvent(new Event('blur')));
  await p.waitForSelector('#voidModal:not([hidden])');
  ok((await p.textContent('#voidReason')).includes('left the exam window'), 'blur voids');
  await sleep(300);
  ok(attempts().filter(x => x.StudentID === 'S2').map(x => x.Status).join() === 'VOIDED,VOIDED', 'two voided attempts');
  await p.close();

  // 6. second monitor before start and during exam
  p = await open();
  await p.evaluate(() => { window.__ext = true; });
  await p.waitForSelector('#screen-rules:not([hidden])');
  await p.check('#agree');
  await sleep(1200);
  ok(await p.isDisabled('#startBtn'), 'start disabled with second monitor');
  ok((await p.textContent('#checkMonitor')).includes('second monitor'), 'second monitor message');
  await p.evaluate(() => { window.__ext = false; });
  await sleep(1200);
  ok(!(await p.isDisabled('#startBtn')), 'start enabled after disconnect');
  await p.fill('#studentId', 'S3'); await p.fill('#studentName', 'Cara Lim');
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.evaluate(() => { window.__ext = true; screen.dispatchEvent(new Event('change')); });
  await p.waitForSelector('#voidModal:not([hidden])');
  ok((await p.textContent('#voidReason')).includes('second monitor'), 'second monitor mid-exam voids');
  await p.close();

  // 7. unsupported browser blocked
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => { delete Screen.prototype.isExtended; });
  p = await ctx2.newPage(); await p.goto('http://localhost:8123/?exam=SAMPLE-QUIZ');
  await p.waitForSelector('#screen-rules:not([hidden])'); await p.check('#agree');
  ok(await p.isDisabled('#startBtn'), 'unsupported browser cannot start');
  ok(gas.call({ action: 'start', examId: 'SAMPLE-QUIZ', studentId: 'X', name: 'X', env: { monitorCheck: 'unsupported' } }).code === 'UNSUPPORTED_BROWSER', 'server rejects unsupported');
  await ctx2.close();

  // 8. time limit auto-submit + window not yet open
  const ex = gas.sheet('Exams'); const eh = ex.data[0];
  const row = eh.map(h => ({ ExamID: 'FAST', Title: 'Fast quiz', QuestionIDs: 'Q001, Q005', StartDateTime: new Date(Date.now() - 1000), EndDateTime: new Date(Date.now() + 3600e3), TimeLimitMinutes: 0.05, ShowScore: true, Active: true }[h] ?? ''));
  ex.appendRow(row);
  ex.appendRow(eh.map(h => ({ ExamID: 'LATER', Title: 'Later', QuestionIDs: 'Q001', StartDateTime: new Date(Date.now() + 86400e3), Active: true }[h] ?? '')));
  p = await open('FAST');
  await startAs(p, 'S4', 'Dan Reyes');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.fill('.question[data-id="Q005"] input.blank', 'Au');
  await p.waitForSelector('#screen-result:not([hidden])', { timeout: 10000 });
  ok((await p.textContent('#resultScore')).includes('1 / 2'), 'auto-submitted at time limit');
  await p.close();
  p = await open('LATER');
  await p.waitForSelector('#screen-rules:not([hidden])'); await p.check('#agree');
  ok(await p.isDisabled('#startBtn') && (await p.textContent('#windowNotice')).includes('opens in'), 'not-yet-open exam blocked');
  ok(gas.call({ action: 'start', examId: 'LATER', studentId: 'Z', name: 'Z', env: { monitorCheck: 'supported' } }).code === 'NOT_YET_OPEN', 'server enforces window');
  await p.close();

  // 9. Server-side: answers not leaked, formula injection, recalc
  const st = gas.call({ action: 'start', examId: 'SAMPLE-QUIZ', studentId: 'S5', name: '=HYPERLINK("x")', env: { monitorCheck: 'supported' } });
  ok(!JSON.stringify(st).includes('"answer"') && !JSON.stringify(st).includes('Rayleigh'), 'no answer key in start response');
  const sub = gas.call({ action: 'submit', attemptId: st.attemptId, answers: { Q006: '=1+1' } });
  ok(sub.ok && sub.score === 0, 'submit ok');
  ok(attempts().some(x => x.Name === '=HYPERLINK("x")'), 'name stored as text');
  const R = gas.sheet('Responses'); const rh = R.data[0];
  const essayRow = R.data.findIndex(r => r[rh.indexOf('QuestionID')] === 'Q008');
  R.set(essayRow + 1, rh.indexOf('PointsEarned') + 1, 4);
  gas.ctx.recalculateScores();
  a = attempts().find(x => x.StudentID === '00123' || x.StudentID === 123);
  ok(a.Score === 11 && a.PendingEssays === 0 && a.Percent === 91.67, 'recalc after essay grading ' + JSON.stringify([a.Score, a.PendingEssays, a.Percent]));
  ok(gas.call({ action: 'submit', attemptId: st.attemptId, answers: {} }).ok, 'double submit idempotent');

  // 10. Course enrolment (one student in two courses)
  const env = { monitorCheck: 'supported' };
  const ro = gas.sheet('Roster'); const roh = ro.data[0];
  ok(roh.includes('Courses'), 'Roster has Courses column');
  const addStudent = (o) => ro.appendRow(roh.map(h => o[h] ?? ''));
  addStudent({ StudentID: "'2024-001", Name: 'Ana Santos', Courses: 'MATH101, SCI201' });
  addStudent({ StudentID: "'2024-002", Name: 'Ben Cruz', Courses: 'sci 201' });
  const mk = (id, course) => gas.ctx.builderSaveExam({ id, title: id, course, questionIds: ['Q001', 'Q003'], start: '', end: '', limitMin: 10, showScore: true, active: true });
  const m = mk('MATH-MID', 'MATH101');
  ok(!m.warning, 'no warning when students are enrolled');
  mk('SCI-MID', 'SCI201');
  ok(/No student/.test(mk('ENG-MID', 'ENG110').warning), 'warning for course with no students');
  mk('OPEN-QUIZ', '');
  const st1 = gas.call({ action: 'start', examId: 'MATH-MID', studentId: '2024-001', name: '', env });
  const st2 = gas.call({ action: 'start', examId: 'SCI-MID', studentId: '2024-001', name: '', env });
  ok(st1.ok && st2.ok && st1.studentName === 'Ana Santos', 'student in two courses can take both exams');
  const no = gas.call({ action: 'start', examId: 'MATH-MID', studentId: '2024-002', name: '', env });
  ok(no.code === 'NOT_ENROLLED' && /MATH101/.test(no.error), 'non-enrolled student blocked: ' + no.error);
  ok(gas.call({ action: 'start', examId: 'SCI-MID', studentId: '2024-002', name: '', env }).ok, 'course match ignores case/spaces');
  ok(gas.call({ action: 'start', examId: 'OPEN-QUIZ', studentId: '2024-002', name: '', env }).ok, 'exam without course open to roster');
  ok(gas.call({ action: 'start', examId: 'OPEN-QUIZ', studentId: 'NOPE', name: 'x', env }).code === 'NOT_IN_ROSTER', 'unknown ID still blocked');
  ok(attempts().find(x => x.AttemptID === st1.attemptId).Course === 'MATH101', 'attempt records course');
  ok(gas.ctx.builderGetData().courses.join() === 'ENG110,MATH101,SCI201', 'builder course list: ' + gas.ctx.builderGetData().courses.join());

  // 11. Upgrading an existing Sheet adds new columns without touching data
  const old = create(path.join(REPO, 'apps-script/Code.gs'));
  const r0 = old.ss.insertSheet('Roster'); r0.appendRow(['StudentID', 'Name', 'Email', 'AccessCode']); r0.appendRow(["'007", 'Old Student', '', '']);
  old.ctx.setupSheets();
  const after = old.sheet('Roster');
  ok(after.data[0].join() === 'StudentID,Name,Email,AccessCode,Courses' && after.data[1][1] === 'Old Student', 'setup adds Courses column, keeps data');

  // 12. One question at a time, going back allowed
  ro.data.splice(1); // empty the roster again so anyone can take the next exams
  const mk2 = (id, displayMode, allowBack) => gas.ctx.builderSaveExam({ id, title: id, questionIds: ['Q001', 'Q003', 'Q005'], start: '', end: '', limitMin: 10, showScore: true, active: true, displayMode, allowBack, shuffleQuestions: false });
  mk2('ONE-BACK', 'ONE', true);
  mk2('ONE-NOBACK', 'ONE', false);
  mk2('SCROLL-NOBACK', 'ALL', false);
  ok(gas.ctx.builderGetData().exams.find(e => e.id === 'SCROLL-NOBACK').allowBack === true, 'scroll mode always allows back');
  const visibleIds = pg => pg.$$eval('.question', els => els.filter(e => !e.hidden).map(e => e.dataset.id));
  p = await open('ONE-BACK');
  await p.waitForSelector('#screen-rules:not([hidden])');
  ok((await p.textContent('#ruleNav')).includes('can go back'), 'rules mention one-at-a-time with back');
  await startAs(p, 'N1', 'Nina One');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok((await visibleIds(p)).join() === 'Q001', 'only first question visible');
  ok(await p.isVisible('#palette') && (await p.$$('#palette button')).length === 3, 'palette shown');
  ok(await p.isDisabled('#prevBtn'), 'previous disabled on first');
  await p.click('.question[data-id="Q001"] .choice:has-text("Mars")');
  await p.click('#nextBtn');
  ok((await visibleIds(p)).join() === 'Q003' && (await p.textContent('#pagerCount')) === 'Question 2 of 3', 'next shows question 2');
  await p.click('#prevBtn');
  ok((await visibleIds(p)).join() === 'Q001', 'previous goes back');
  ok(await p.isChecked('.question[data-id="Q001"] input[type=radio]:checked'), 'answer kept after going back');
  await p.click('#palette button:nth-child(3)');
  ok((await p.textContent('#nextBtn')) === 'Submit exam', 'last question shows Submit');
  await p.fill('.question[data-id="Q005"] input.blank', 'Au');
  await p.screenshot({ path: path.join(require('os').tmpdir(), 'one-at-a-time.png') });
  await p.click('#nextBtn'); await p.click('#confirmYes');
  await p.waitForSelector('#screen-result:not([hidden])');
  ok((await p.textContent('#resultScore')).includes('2 / 3'), 'one-at-a-time submit graded');
  await p.close();

  // 13. One at a time, no going back
  p = await open('ONE-NOBACK');
  await p.waitForSelector('#screen-rules:not([hidden])');
  ok((await p.textContent('#ruleNav')).includes('cannot go back'), 'rules warn no going back');
  await startAs(p, 'N2', 'Noel Two');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok(await p.isHidden('#prevBtn') && await p.isHidden('#palette'), 'no previous button or palette');
  await p.click('.question[data-id="Q001"] .choice:has-text("Venus")'); // wrong answer, gets locked
  await p.click('#nextBtn');
  await sleep(300);
  await p.click('#nextBtn'); // skipping an unanswered question asks first
  ok(await p.isVisible('#confirmModal') && (await p.textContent('#confirmTitle')).includes('Skip'), 'skip warning shown');
  await p.click('#confirmNo');
  ok((await visibleIds(p)).join() === 'Q003', 'stayed on question after Go back');
  await p.check('.question[data-id="Q003"] input[value="TRUE"]');
  await p.click('#nextBtn');
  await sleep(300);
  const att = attempts().find(x => x.StudentID === 'N2');
  const prog = gas.sheet('Progress').objects().filter(r => r.AttemptID === att.AttemptID);
  ok(prog.map(r => r.QuestionID).join() === 'Q001,Q003', 'answers locked on server: ' + prog.map(r => r.QuestionID).join());
  const res = gas.call({ action: 'start', examId: 'ONE-NOBACK', studentId: 'N2', name: 'Noel Two', env });
  ok(res.resumed && res.lockedIds.join() === 'Q001,Q003', 'resume returns locked questions');
  const marsKey = res.questions.find(q => q.id === 'Q001').choices.find(c => c.text === 'Mars').key;
  const tam = gas.call({ action: 'submit', attemptId: att.AttemptID, answers: { Q001: marsKey, Q003: 'TRUE', Q005: 'Au' } });
  ok(tam.score === 2, 'locked wrong answer stays wrong: score ' + tam.score);
  ok(gas.call({ action: 'lockAnswer', attemptId: att.AttemptID, questionId: 'Q005', value: 'x' }).code === 'ALREADY_SUBMITTED', 'no locking after submit');
  await p.close();

  // 14. Random set of questions per student (e.g. 10 from a pool of 30)
  const Q = gas.sheet('Questions'); const qh = Q.data[0];
  const pool = [];
  for (let i = 101; i <= 130; i++) {
    const id = 'P' + i; pool.push(id);
    Q.appendRow(qh.map(h => ({ QuestionID: id, Type: 'MC', Question: 'Pool question ' + i, Choices: 'right | wrong | also wrong', Answer: 'A', Points: 1, Topic: 'POOL' }[h] ?? '')));
  }
  let err = null;
  try { gas.ctx.builderSaveExam({ id: 'POOL-BAD', title: 'x', questionIds: pool.slice(0, 5), start: '', end: '', limitMin: 10, pickCount: 6 }); } catch (e) { err = e.message; }
  ok(/more than the 5 questions/.test(err || ''), 'cannot ask for more questions than selected: ' + err);
  gas.ctx.builderSaveExam({ id: 'POOL', title: 'Pool quiz', questionIds: pool, start: '', end: '', limitMin: 10, showScore: true, active: true, pickCount: 10, shuffleQuestions: false });
  ok(gas.ctx.builderGetData().exams.find(e => e.id === 'POOL').pickCount === 10, 'pick count saved');
  const info = gas.call({ action: 'getExam', examId: 'POOL' });
  ok(info.exam.questionCount === 10 && info.exam.poolSize === 30 && info.exam.totalPoints === 10, 'exam info: 10 from 30, 10 points');
  const sets = [];
  for (let i = 1; i <= 6; i++) {
    const st = gas.call({ action: 'start', examId: 'POOL', studentId: 'PS' + i, name: 'Pool ' + i, env });
    const ids = st.questions.map(q => q.id);
    ok(ids.length === 10 && ids.every(id => pool.includes(id)) && new Set(ids).size === 10, `student ${i} gets 10 different pool questions`);
    sets.push({ st, ids });
  }
  ok(new Set(sets.map(x => x.ids.slice().sort().join())).size >= 5, 'students get different sets: ' + new Set(sets.map(x => x.ids.slice().sort().join())).size + ' distinct of 6');
  ok(sets[0].ids.join() === pool.filter(id => sets[0].ids.includes(id)).join(), 'without shuffle, picked questions keep the bank order');
  const again = gas.call({ action: 'start', examId: 'POOL', studentId: 'PS1', name: 'Pool 1', env });
  ok(again.resumed && again.questions.map(q => q.id).join() === sets[0].ids.join(), 'same set after reconnecting');
  const answers = {}; sets[0].st.questions.forEach(q => { answers[q.id] = q.choices.find(c => c.text === 'right').key; });
  const graded = gas.call({ action: 'submit', attemptId: sets[0].st.attemptId, answers });
  ok(graded.score === 10 && graded.maxScore === 10, 'graded on own 10 questions: ' + graded.score + '/' + graded.maxScore);
  ok(gas.sheet('Responses').objects().filter(r => r.AttemptID === sets[0].st.attemptId).length === 10, '10 response rows, not 30');
  // forward-only mode only accepts the student's own questions
  gas.ctx.builderSaveExam({ id: 'POOL-ONE', title: 'Pool one', questionIds: pool, start: '', end: '', limitMin: 10, showScore: true, active: true, pickCount: 5, displayMode: 'ONE', allowBack: false });
  const one = gas.call({ action: 'start', examId: 'POOL-ONE', studentId: 'PS9', name: 'x', env });
  const notMine = pool.find(id => !one.questions.some(q => q.id === id));
  ok(gas.call({ action: 'lockAnswer', attemptId: one.attemptId, questionId: notMine, value: '0' }).code === 'BAD_INPUT', 'cannot lock a question outside own set');
  ok(gas.call({ action: 'lockAnswer', attemptId: one.attemptId, questionId: one.questions[0].id, value: '0' }).ok, 'can lock own question');
  // Student page
  p = await open('POOL');
  await p.waitForSelector('#screen-rules:not([hidden])');
  ok((await p.textContent('#factQuestions')) === '10 (picked at random from 30)', 'rules: ' + await p.textContent('#factQuestions'));
  await startAs(p, 'PS20', 'Pool Page');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok((await p.$$('.question')).length === 10 && (await p.textContent('#progress')) === '0 / 10 answered', 'page shows 10 questions');
  await p.close();
  // Different points in the pool → total shown as "depends"
  Q.set(Q.data.findIndex(r => r[qh.indexOf('QuestionID')] === 'P101') + 1, qh.indexOf('Points') + 1, 5);
  ok(gas.call({ action: 'getExam', examId: 'POOL' }).exam.totalPoints === null, 'total points "depends" when pool points differ');

  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close(); server.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
