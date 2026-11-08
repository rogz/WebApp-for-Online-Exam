// Timers and reconnect: opening countdown, warning times, time per question,
// reconnecting after a reload or lost connection. Run with: node tests/timing.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { create } = require('./mock-apps-script');

const REPO = path.resolve(__dirname, '..');
const gas = create(path.join(REPO, 'apps-script/Code.gs'));
gas.ctx.setupSheets();

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const attempts = () => gas.sheet('Attempts').objects();
const setSetting = (key, value) => {
  const st = gas.sheet('Settings'); const h = st.data[0];
  st.data.forEach((r, i) => { if (r[h.indexOf('Key')] === key) st.set(i + 1, h.indexOf('Value') + 1, value); });
};
const exam = (id, extra) => gas.ctx.builderSaveExam(Object.assign({ id, title: id, questionIds: ['Q001', 'Q003', 'Q005'], start: '', end: '', limitMin: 10, showScore: true, active: true, shuffleQuestions: false }, extra));
const rowOf = id => { const a = gas.sheet('Attempts'); const h = a.data[0]; return { sheet: a, h, i: a.data.findIndex(r => r[h.indexOf('StudentID')] === id) + 1 }; };

let offline = false; // simulates the server being unreachable
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    if (offline) { req.socket.destroy(); return; }
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

(async () => {
  await new Promise(r => server.listen(8125, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return false; } }); });
  const errors = [];
  const open = async (id, pg) => { const p = pg || await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto('http://localhost:8125/?exam=' + id); await p.waitForSelector('#screen-rules:not([hidden])'); return p; };
  const start = async (p, sid) => { await p.fill('#studentId', sid); await p.fill('#studentName', 'Student ' + sid); await p.check('#agree'); await p.click('#startBtn'); };

  // 1. Countdown before the exam opens
  exam('LATER', { start: new Date(Date.now() + (2 * 86400 + 3 * 3600 + 120) * 1000).toISOString().slice(0, 16) });
  let p = await open('LATER');
  let t = await p.textContent('#windowNotice');
  ok(/opens in 2 days 3:0[12]:\d\d/.test(t), 'countdown shows days and time: ' + t.slice(0, 45));
  const t1 = t; await sleep(1500); t = await p.textContent('#windowNotice');
  ok(t !== t1, 'countdown ticks every second');
  setSetting('OPEN_COUNTDOWN', false);
  await open('LATER', p);
  ok((await p.textContent('#windowNotice')).includes('not open yet'), 'countdown can be turned off');
  setSetting('OPEN_COUNTDOWN', true);
  exam('SOON', { start: new Date(Date.now() + 63 * 1000).toISOString().slice(0, 16) }); // opens at the next minute
  await open('SOON', p);
  await p.fill('#studentId', 'W0'); await p.fill('#studentName', 'Waiter'); await p.check('#agree');
  ok(await p.isDisabled('#startBtn'), 'start locked before opening');
  await p.waitForFunction(() => !document.querySelector('#startBtn').disabled, null, { timeout: 130000 });
  ok(true, 'start unlocks by itself when the countdown reaches zero');
  await p.close();

  // 2. Warning times chosen by the teacher
  setSetting('TIME_WARNINGS', '0.1, 0.05'); // 6 s and 3 s before the end
  exam('WARN', { limitMin: 0.15 });        // 9 s
  p = await open('WARN');
  await start(p, 'W1');
  await p.waitForSelector('#timeWarning:not([hidden])', { timeout: 6000 });
  ok((await p.textContent('#timeWarning')).startsWith('6 seconds left') && (await p.getAttribute('#timeWarning', 'class')).includes('warn'), 'first warning: ' + await p.textContent('#timeWarning'));
  await p.waitForFunction(() => document.querySelector('#timeWarning').textContent.startsWith('3 seconds'), null, { timeout: 6000 });
  ok((await p.getAttribute('#timeWarning', 'class')).includes('bad'), 'last warning is red');
  await p.waitForSelector('#screen-result:not([hidden])', { timeout: 15000 });
  await p.close();
  setSetting('TIME_WARNINGS', '');
  p = await open('WARN');
  await start(p, 'W2');
  await p.waitForSelector('#screen-result:not([hidden])', { timeout: 15000 });
  ok(true, 'auto-submitted');
  ok(await p.evaluate(() => document.querySelector('#timeWarning').hidden), 'no warnings when TIME_WARNINGS is empty');
  await p.close();
  setSetting('TIME_WARNINGS', '5, 1');
  exam('SHORT', { limitMin: 0.1 }); // 6-second exam: the 5- and 1-minute warnings don't apply
  p = await open('SHORT');
  await start(p, 'W3');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await sleep(1000);
  ok(await p.evaluate(() => document.querySelector('#timeWarning').hidden), 'no "5 minutes left" on a shorter exam');
  await p.waitForSelector('#screen-result:not([hidden])', { timeout: 15000 });
  await p.close();
  setSetting('TIME_WARNINGS', '5, 1');

  // 3. Time limit per question
  exam('PERQ', { displayMode: 'ONE', allowBack: true, questionSeconds: 3 });
  const pq = gas.ctx.builderGetData().exams.find(e => e.id === 'PERQ');
  ok(pq.questionSeconds === 3 && pq.allowBack === false, 'per-question limit forces no going back');
  p = await open('PERQ');
  ok((await p.textContent('#ruleNav')).includes('3 seconds per question'), 'rules mention time per question');
  await start(p, 'Q1');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok(await p.isVisible('#qTimer') && /⏱ 00:0[23]/.test(await p.textContent('#qTimer')), 'question timer shown: ' + await p.textContent('#qTimer'));
  await p.click('.question[data-id="Q001"] .choice:has-text("Mars")');
  await p.waitForFunction(() => document.querySelector('#pagerCount').textContent === 'Question 2 of 3', null, { timeout: 5000 });
  ok(true, 'moved to question 2 automatically');
  await p.click('#nextBtn'); // unanswered → skip warning appears
  await p.waitForFunction(() => document.querySelector('#pagerCount').textContent === 'Question 3 of 3', null, { timeout: 5000 });
  ok(await p.isHidden('#confirmModal'), 'time-up closes the skip warning and moves on');
  await p.fill('.question[data-id="Q005"] input.blank', 'Au');
  await p.waitForSelector('#screen-result:not([hidden])', { timeout: 6000 });
  ok((await p.textContent('#resultScore')).includes('2 / 3'), 'last question time-up submits: ' + await p.textContent('#resultScore'));
  const att = attempts().find(x => x.StudentID === 'Q1');
  ok(gas.sheet('Progress').objects().filter(r => r.AttemptID === att.AttemptID).length === 2, 'answers locked as time ran out');
  await p.close();

  // 4. Reconnect after reloading the page (default 60 s, max 3)
  exam('RC', {});
  p = await open('RC');
  ok((await p.textContent('#ruleReload')).includes('within 1 minute') && (await p.textContent('#ruleReload')).includes('up to 3 times'), 'rules explain reconnect');
  await start(p, 'R1');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.click('.question[data-id="Q001"] .choice:has-text("Mars")');
  for (let n = 1; n <= 3; n++) {
    await p.reload();
    await p.waitForSelector('#screen-rules:not([hidden])');
    await sleep(300);
    ok(attempts().find(x => x.StudentID === 'R1').Status === 'IN_PROGRESS', `reload ${n} did not void`);
    await start(p, 'R1');
    await p.waitForSelector('#screen-exam:not([hidden])');
    ok((await p.textContent('#timeWarning')).includes(`Reconnects used: ${n} of 3`), `resumed after reload ${n}`);
  }
  ok(await p.isChecked('.question[data-id="Q001"] input[type=radio]:checked'), 'answers kept after reconnecting');
  ok(gas.sheet('Violations').objects().filter(v => v.Event === 'RECONNECTED').length === 3, 'reconnects logged for the teacher');
  await p.reload();
  await p.waitForSelector('#screen-rules:not([hidden])');
  await start(p, 'R1');
  await p.waitForSelector('#startError:not([hidden])');
  ok((await p.textContent('#startError')).includes('more times than allowed'), '4th reconnect voids: ' + await p.textContent('#startError'));
  await p.close();

  // 5. Coming back too late
  p = await open('RC');
  await start(p, 'R2');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.close(); // tab closed → disconnect beacon
  await sleep(300);
  let r = rowOf('R2');
  ok(r.sheet.data[r.i - 1][r.h.indexOf('DisconnectedAt')] !== '', 'closing the page starts the reconnect window');
  r.sheet.set(r.i, r.h.indexOf('DisconnectedAt') + 1, new Date(Date.now() - 61000)); // pretend 61 s passed
  p = await open('RC');
  await start(p, 'R2');
  await p.waitForSelector('#startError:not([hidden])');
  ok((await p.textContent('#startError')).includes('disconnected for longer than allowed'), 'too late voids: ' + await p.textContent('#startError'));
  await p.close();

  // 6. Tab switch still voids at once (not mistaken for a reload)
  p = await open('RC');
  await start(p, 'R3');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 3000 });
  ok(true, 'tab switch still voids with reconnect on');
  await p.close();
  p = await open('RC');
  await start(p, 'R4');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.evaluate(() => { window.dispatchEvent(new Event('blur')); setTimeout(() => window.dispatchEvent(new Event('focus')), 100); });
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 3000 });
  ok(true, 'quick Alt+Tab and back still voids');
  await p.close();

  // 7. Losing the connection while the page is open
  setSetting('RECONNECT_SECONDS', 4);
  p = await open('RC');
  await start(p, 'R5');
  await p.waitForSelector('#screen-exam:not([hidden])');
  offline = true; await ctx.setOffline(true);
  await p.waitForSelector('#connBanner:not([hidden])', { timeout: 5000 });
  ok((await p.textContent('#connBanner')).includes('Connection lost'), 'banner when connection drops');
  await p.click('.question[data-id="Q001"] .choice:has-text("Mars")');
  ok(true, 'can keep answering while offline');
  await sleep(1500);
  offline = false; await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.waitForSelector('#connBanner', { state: 'hidden', timeout: 8000 });
  ok(await p.isHidden('#voidModal'), 'reconnected in time: exam continues');
  offline = true; await ctx.setOffline(true);
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 15000 });
  ok((await p.textContent('#voidReason')).includes('connection was lost'), 'offline too long voids');
  offline = false; await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.waitForFunction(() => true);
  for (let i = 0; i < 30 && attempts().find(x => x.StudentID === 'R5').Status !== 'VOIDED'; i++) await sleep(500);
  ok(attempts().find(x => x.StudentID === 'R5').Status === 'VOIDED', 'void reaches the server once back online');
  await p.close();
  // Server enforces the limit too (e.g. if the page was tampered with)
  const s6 = gas.call({ action: 'start', examId: 'RC', studentId: 'R6', name: 'x', env: { monitorCheck: 'supported' } });
  r = rowOf('R6'); r.sheet.set(r.i, r.h.indexOf('LastSeen') + 1, new Date(Date.now() - 40000));
  ok(gas.call({ action: 'ping', attemptId: s6.attemptId }).status === 'VOIDED', 'server voids on a long silence');
  setSetting('RECONNECT_SECONDS', 60);

  // 8. Reconnect turned off: reloading voids, like before
  setSetting('RECONNECT_SECONDS', 0);
  p = await open('RC');
  ok((await p.textContent('#ruleReload')).includes('Do not refresh'), 'rules say reload voids');
  await start(p, 'R7');
  await p.waitForSelector('#screen-exam:not([hidden])');
  p.on('dialog', d => d.accept());
  await p.reload();
  await sleep(500);
  ok(attempts().find(x => x.StudentID === 'R7').Status === 'VOIDED', 'with reconnect off, reload voids');
  await p.close();

  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close(); server.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
