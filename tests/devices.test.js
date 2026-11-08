// "Allowed devices": computers / tablets / phones, emulated with Playwright device profiles.
// Run with: node tests/devices.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium, devices } = require('playwright');
const { create } = require('./mock-apps-script');

const REPO = path.resolve(__dirname, '..');
const gas = create(path.join(REPO, 'apps-script/Code.gs'));
gas.ctx.setupSheets();
const exam = (id, allowedDevices) => gas.ctx.builderSaveExam({ id, title: id, questionIds: ['Q001', 'Q003', 'Q005', 'Q008'], start: '', end: '', limitMin: 10, showScore: true, active: true, allowedDevices });
exam('DEV-COMP'); exam('DEV-TAB', 'TABLET'); exam('DEV-ANY', 'ANY');

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const attempts = () => gas.sheet('Attempts').objects();

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

// Safari (iPad / iPhone) has no monitor API; Chrome on Android tablets may have one.
const NO_MONITOR_API = () => { delete Screen.prototype.isExtended; };
const EXTENDED_SCREEN = () => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return true; } }); };
const ONE_SCREEN = () => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return false; } }); };
const IPADOS_TOUCH = () => { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get() { return 5; } }); };

(async () => {
  await new Promise(r => server.listen(8126, r));
  const browser = await chromium.launch();
  const errors = [];
  async function openOn(profile, scripts, examId) {
    const ctx = await browser.newContext(profile);
    for (const s of scripts) await ctx.addInitScript(s);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:8126/?exam=' + examId);
    await p.waitForSelector('#screen-rules:not([hidden])');
    return { p, ctx };
  }
  const fill = async (p, id) => { await p.fill('#studentId', id); await p.fill('#studentName', 'Student ' + id); await p.check('#agree'); };
  const check = (p, id) => p.textContent('#' + id);

  const IPAD = devices['iPad (gen 7)'];
  const IPADOS_DESKTOP = { viewport: { width: 1024, height: 1366 }, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' };
  const TAB = devices['Galaxy Tab S4'];
  const IPHONE = devices['iPhone 13'];
  const PIXEL = devices['Pixel 5'];
  const DESKTOP = { viewport: { width: 1280, height: 800 } };

  // 1. Computers only (the default): tablets are turned away
  let { p, ctx } = await openOn(IPAD, [NO_MONITOR_API], 'DEV-COMP');
  await fill(p, 'D1');
  ok((await check(p, 'checkDevice')).includes('must be taken on a laptop or desktop'), 'iPad on computers-only exam: ' + await check(p, 'checkDevice'));
  ok(await p.isDisabled('#startBtn'), 'iPad cannot start a computers-only exam');
  await ctx.close();

  // 2. Computers and tablets: iPad (Safari, no monitor API)
  ({ p, ctx } = await openOn(IPAD, [NO_MONITOR_API], 'DEV-TAB'));
  ok((await check(p, 'checkDevice')).includes('Tablet') && (await check(p, 'checkMonitor')).includes('Not checked on tablets'), 'iPad: device Tablet, monitor check skipped');
  ok((await check(p, 'ruleMonitor')).includes('Stay in this browser'), 'tablet rules talk about switching apps, not monitors');
  await fill(p, 'D2');
  ok(!(await p.isDisabled('#startBtn')), 'iPad can start');
  await p.screenshot({ path: path.join(require('os').tmpdir(), 'ipad-rules.png') });
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok(attempts().find(a => a.StudentID === 'D2').Device === 'tablet', 'Attempts records Device = tablet');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling on iPad');
  await p.screenshot({ path: path.join(require('os').tmpdir(), 'ipad-exam.png') });
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 3000 });
  ok(true, 'switching apps on the iPad voids the exam');
  await ctx.close();

  // 3. iPad in desktop mode (reports "Macintosh") is still a tablet
  ({ p, ctx } = await openOn(IPADOS_DESKTOP, [NO_MONITOR_API, IPADOS_TOUCH], 'DEV-TAB'));
  ok((await check(p, 'checkDevice')).trim().endsWith('Tablet'), 'iPad desktop-mode detected as Tablet: ' + await check(p, 'checkDevice'));
  await fill(p, 'D3');
  ok(!(await p.isDisabled('#startBtn')), 'iPad desktop-mode can start');
  await ctx.close();

  // 4. Android tablet: even if Chrome says "extended screen", tablets skip the monitor check
  ({ p, ctx } = await openOn(TAB, [EXTENDED_SCREEN], 'DEV-TAB'));
  ok((await check(p, 'checkDevice')).includes('Tablet'), 'Galaxy Tab detected as Tablet');
  await fill(p, 'D4');
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await sleep(1500);
  ok(await p.isHidden('#voidModal'), 'Android tablet not voided by the monitor check');
  await ctx.close();

  // 5. Phones: blocked on tablet exams, allowed on "any device" exams
  ({ p, ctx } = await openOn(IPHONE, [NO_MONITOR_API], 'DEV-TAB'));
  ok((await check(p, 'checkDevice')).includes('computer or a tablet, not a phone'), 'iPhone on tablet exam: ' + await check(p, 'checkDevice'));
  await fill(p, 'D5');
  ok(await p.isDisabled('#startBtn'), 'iPhone cannot start a computers + tablets exam');
  await ctx.close();
  for (const [name, prof] of [['iPhone', IPHONE], ['Pixel', PIXEL]]) {
    ({ p, ctx } = await openOn(prof, [NO_MONITOR_API], 'DEV-ANY'));
    ok((await check(p, 'checkDevice')).includes('Phone'), name + ' detected as Phone');
    await fill(p, 'D6' + name);
    await p.click('#startBtn');
    await p.waitForSelector('#screen-exam:not([hidden])');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), name + ': exam fits the phone screen');
    if (name === 'iPhone') await p.screenshot({ path: path.join(require('os').tmpdir(), 'iphone-exam.png') });
    await ctx.close();
  }

  // 6. Computers keep the monitor check, even on a tablet-friendly exam
  ({ p, ctx } = await openOn(DESKTOP, [NO_MONITOR_API], 'DEV-TAB'));
  await fill(p, 'D7');
  ok((await check(p, 'checkDevice')).includes('Computer') && await p.isDisabled('#startBtn'), 'computer without monitor API still blocked');
  await ctx.close();
  ({ p, ctx } = await openOn(DESKTOP, [ONE_SCREEN], 'DEV-TAB'));
  await fill(p, 'D8');
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.evaluate(() => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return true; } }); });
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 3000 });
  ok(true, 'computer connecting a monitor mid-exam still voids');
  await ctx.close();

  // 7. Server rules
  const UA = { iphone: IPHONE.userAgent, desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36' };
  ok(gas.call({ action: 'start', examId: 'DEV-COMP', studentId: 'S1', name: 'x', env: { device: 'tablet', userAgent: IPAD.userAgent } }).code === 'DEVICE_NOT_ALLOWED', 'server: tablet refused on computers-only exam');
  ok(gas.call({ action: 'start', examId: 'DEV-TAB', studentId: 'S2', name: 'x', env: { device: 'computer', userAgent: UA.iphone, monitorCheck: 'supported' } }).code === 'DEVICE_NOT_ALLOWED', 'server: phone pretending to be a computer is refused');
  ok(gas.call({ action: 'start', examId: 'DEV-TAB', studentId: 'S3', name: 'x', env: { device: 'computer', userAgent: UA.desktop } }).code === 'UNSUPPORTED_BROWSER', 'server: computers still need the monitor check');
  ok(gas.call({ action: 'start', examId: 'DEV-TAB', studentId: 'S4', name: 'x', env: { device: 'tablet', userAgent: IPAD.userAgent } }).ok, 'server: tablet allowed without monitor check');
  ok(gas.sheet('Exams').objects().find(e => e.ExamID === 'DEV-ANY').AllowedDevices === 'ANY', 'sheet stores AllowedDevices');
  ok(gas.call({ action: 'getExam', examId: 'Q-OLD' }).code === 'EXAM_NOT_FOUND' && gas.ctx.parseAllowedDevices_('') === 'COMPUTER', 'empty AllowedDevices = computers only (older exams)');

  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close(); server.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
