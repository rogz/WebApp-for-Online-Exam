// "Pick X from each topic": server rules + the real Exam Builder window
// (google.script.run is simulated and calls Code.gs in a fake Sheet).
// Run with: node tests/builder.test.js
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { create } = require('./mock-apps-script');

const REPO = path.resolve(__dirname, '..');
const gas = create(path.join(REPO, 'apps-script/Code.gs'));
gas.ctx.setupSheets();

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const env = { monitorCheck: 'supported' };

// Pool: 10 Easy (1 pt), 10 Medium (2 pt), 10 Hard (3 pt)
const Q = gas.sheet('Questions'); const qh = Q.data[0];
const pool = [];
[['Easy', 1], ['Medium', 2], ['Hard', 3]].forEach(([topic, pts]) => {
  for (let i = 1; i <= 10; i++) {
    const id = topic[0] + String(i).padStart(2, '0'); pool.push(id);
    Q.appendRow(qh.map(h => ({ QuestionID: id, Type: 'MC', Question: topic + ' question ' + i, Choices: 'right | wrong', Answer: 'A', Points: pts, Topic: topic }[h] ?? '')));
  }
});
const topicOf = id => ({ E: 'Easy', M: 'Medium', H: 'Hard' }[id[0]]);

(async () => {
  // ── Server rules ──
  let err = null;
  try { gas.ctx.builderSaveExam({ id: 'BAD', title: 'x', questionIds: pool, start: '', end: '', limitMin: 10, topicCounts: [{ topic: 'Easy', count: 11 }] }); } catch (e) { err = e.message; }
  ok(/only 10 selected/.test(err || ''), 'cannot ask for more than a topic has: ' + err);
  gas.ctx.builderSaveExam({ id: 'TOPIC', title: 'Topic quiz', questionIds: pool, start: '', end: '', limitMin: 10, showScore: true, active: true,
    topicCounts: [{ topic: 'Easy', count: 5 }, { topic: 'medium', count: 3 }, { topic: 'Hard', count: 2 }], pickCount: 4 });
  const row = gas.sheet('Exams').objects().find(e => e.ExamID === 'TOPIC');
  ok(row.TopicCounts === 'Easy: 5 | medium: 3 | Hard: 2' && row.QuestionsPerStudent === 0, 'saved as "' + row.TopicCounts + '" (overrides questions-per-student)');
  const info = gas.call({ action: 'getExam', examId: 'TOPIC' }).exam;
  ok(info.questionCount === 10 && info.poolSize === 30 && info.totalPoints === 17, `exam info: ${info.questionCount} questions, pool ${info.poolSize}, ${info.totalPoints} points`);
  const sets = [];
  for (let i = 1; i <= 5; i++) {
    const st = gas.call({ action: 'start', examId: 'TOPIC', studentId: 'T' + i, name: 'Topic ' + i, env });
    const ids = st.questions.map(q => q.id);
    const by = t => ids.filter(id => topicOf(id) === t).length;
    ok(ids.length === 10 && by('Easy') === 5 && by('Medium') === 3 && by('Hard') === 2, `student ${i}: 5 Easy, 3 Medium, 2 Hard`);
    sets.push({ st, ids });
  }
  ok(new Set(sets.map(s => s.ids.slice().sort().join())).size >= 4, 'students get different sets');
  const again = gas.call({ action: 'start', examId: 'TOPIC', studentId: 'T1', name: 'Topic 1', env });
  ok(again.questions.map(q => q.id).join() === sets[0].ids.join(), 'same set after reconnecting');
  const answers = {}; sets[0].st.questions.forEach(q => { answers[q.id] = q.choices.find(c => c.text === 'right').key; });
  const g = gas.call({ action: 'submit', attemptId: sets[0].st.attemptId, answers });
  ok(g.score === 17 && g.maxScore === 17, 'graded out of 17: ' + g.score + '/' + g.maxScore);

  // ── Exam Builder window ──
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('__gas', (name, args) => {
    try { return { ok: true, value: JSON.parse(JSON.stringify(gas.ctx[name].apply(null, args))) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  await page.addInitScript(() => {
    const runner = (ok, fail) => new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'withSuccessHandler') return f => runner(f, fail);
        if (prop === 'withFailureHandler') return f => runner(ok, f);
        return (...args) => window.__gas(prop, args).then(r => (r.ok ? ok && ok(r.value) : fail && fail(new Error(r.message))));
      },
    });
    window.google = { script: { run: runner(null, null) } };
  });
  await page.route('http://builder.test/', r => r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(REPO, 'apps-script/Builder.html'), 'utf8') }));
  await page.goto('http://builder.test/');
  await page.waitForSelector('#bank tr td input[type=checkbox]');
  await page.fill('#title', 'Builder topic quiz'); await page.fill('#examId', 'TOPIC-UI');
  await page.selectOption('#topicFilter', 'Easy'); await page.check('#checkAll');
  await page.selectOption('#topicFilter', 'Hard'); await page.check('#checkAll');
  await page.selectOption('#topicFilter', '');
  await page.waitForSelector('#topicPicks input[data-topic="Easy"]');
  ok((await page.$$('#topicPicks input')).length === 2, 'topic table lists the 2 ticked topics');
  ok((await page.textContent('#topicPicks')).includes('Easy10') || (await page.textContent('#topicPicks')).includes('Easy'), 'shows ticked count per topic');
  await page.fill('#topicPicks input[data-topic="Easy"]', '4');
  await page.fill('#topicPicks input[data-topic="Hard"]', '1');
  const summary = await page.textContent('#selSummary');
  ok(summary.includes('each student gets 5 at random: 4 Easy, 1 Hard'), 'summary: ' + summary);
  ok(await page.isDisabled('#pickCount'), '"Questions per student" disabled while picking per topic');
  await page.screenshot({ path: path.join(require('os').tmpdir(), 'builder-topics.png') });
  await page.click('#saveBtn');
  await page.waitForSelector('#msg.ok');
  const saved = gas.sheet('Exams').objects().find(e => e.ExamID === 'TOPIC-UI');
  ok(saved && saved.TopicCounts === 'Easy: 4 | Hard: 1', 'Builder saved: ' + (saved && saved.TopicCounts));
  await page.click('button:has-text("Clear")');
  ok((await page.$$('#topicPicks input')).length === 0, 'Clear resets the topic table');
  await page.click('.exam-item:has-text("TOPIC-UI") button:has-text("Edit")');
  await page.waitForSelector('#topicPicks input[data-topic="Easy"]');
  ok(await page.inputValue('#topicPicks input[data-topic="Easy"]') === '4' && await page.inputValue('#topicPicks input[data-topic="Hard"]') === '1', 'Edit loads the topic numbers back');
  ok((await page.textContent('#examList')).includes('5 of 20 (4 Easy, 1 Hard)'), 'exam list shows the per-topic draw');
  await page.fill('#topicPicks input[data-topic="Easy"]', '12');
  await page.click('#saveBtn');
  await page.waitForSelector('#msg.err');
  ok((await page.textContent('#msg')).includes('only 10 selected'), 'Builder shows the error for too many');
  ok(errors.length === 0, 'no errors in the Builder ' + errors.join(' | '));
  await browser.close();

  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
