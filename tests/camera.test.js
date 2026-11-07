// Camera monitoring test with the REAL MediaPipe face detector.
// A fake webcam (canvas) shows a face photo, nothing, a black image or two faces.
//
// Setup (once):
//   npm install @mediapipe/tasks-vision@1.1.1      (in any folder)
//   put in one folder: blaze_face_short_range.tflite, efficientdet_lite0.tflite
//   (from storage.googleapis.com/mediapipe-models/...) and a photo of one face named face.jpg
// Run:
//   MP_PKG=/path/node_modules/@mediapipe/tasks-vision MP_ASSETS=/path/assets node tests/camera.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { create } = require('./mock-apps-script');

const REPO = path.resolve(__dirname, '..');
const MP_PKG = process.env.MP_PKG, ASSETS = process.env.MP_ASSETS;
if (!MP_PKG || !ASSETS) { console.log('SKIP camera test: set MP_PKG and MP_ASSETS'); process.exit(0); }

const gas = create(path.join(REPO, 'apps-script/Code.gs'));
gas.ctx.setupSheets();
const st = gas.sheet('Settings'); const sh = st.data[0];
st.data.forEach((r, i) => { if (r[sh.indexOf('Key')] === 'FACE_GRACE_SECONDS') st.set(i + 1, sh.indexOf('Value') + 1, 1); });
gas.ctx.builderSaveExam({ id: 'CAM', title: 'Camera quiz', questionIds: ['Q001', 'Q003'], start: '', end: '', limitMin: 10, showScore: true, active: true, faceMode: 'ALWAYS' });
gas.ctx.builderSaveExam({ id: 'CAM-START', title: 'Start check quiz', questionIds: ['Q001', 'Q003'], start: '', end: '', limitMin: 10, showScore: true, active: true, faceMode: 'START' });
gas.ctx.builderSaveExam({ id: 'CAM-OFF', title: 'No camera quiz', questionIds: ['Q001', 'Q003'], start: '', end: '', limitMin: 10, showScore: true, active: true, faceMode: 'OFF' });

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

const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.jpg': 'image/jpeg' };
const serveFile = (route, file) => route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });

(async () => {
  await new Promise(r => server.listen(8124, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ['camera'] });
  // CDN + model files served from local copies
  await ctx.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/**', r => serveFile(r, path.join(MP_PKG, new URL(r.request().url()).pathname.split('tasks-vision@1.1.1/')[1])));
  await ctx.route('https://storage.googleapis.com/mediapipe-models/**', r => serveFile(r, path.join(ASSETS, path.basename(new URL(r.request().url()).pathname))));
  await ctx.route('**/__test/face.jpg', r => serveFile(r, path.join(ASSETS, 'face.jpg')));
  // Fake webcam
  await ctx.addInitScript(() => {
    Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return false; } });
    window.__cam = 'face';
    const img = new Image(); img.src = '/__test/face.jpg';
    let tracks = [];
    window.__stopCam = () => tracks.forEach(t => t.stop());
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      const draw = () => {
        g.fillStyle = '#000'; g.fillRect(0, 0, 640, 480);
        if (window.__cam === 'none') { // an empty room: textured, not flat
          for (let x = 0; x < 640; x += 40) for (let y = 0; y < 480; y += 40) { g.fillStyle = ((x + y) / 40) % 2 ? '#8a7f70' : '#b8ad9c'; g.fillRect(x, y, 40, 40); }
        } else if (window.__cam === 'face' && img.complete) {
          g.drawImage(img, 150, 0, 520, 390, 0, 0, 640, 480);
        } else if (window.__cam === 'two' && img.complete) {
          g.drawImage(img, 150, 0, 520, 390, 0, 60, 320, 240);
          g.drawImage(img, 150, 0, 520, 390, 320, 60, 320, 240);
        } // 'black' leaves it black
        requestAnimationFrame(draw);
      };
      draw();
      const s = c.captureStream(15);
      tracks = s.getVideoTracks();
      return s;
    };
  });
  const errors = [];
  const open = async (exam = 'CAM') => { const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto('http://localhost:8124/?exam=' + exam); await p.waitForSelector('#screen-rules:not([hidden])'); return p; };
  const setCam = (p, v) => p.evaluate(v => { window.__cam = v; }, v);
  const camCheck = p => p.textContent('#checkCamera');

  // Rules screen
  let p = await open();
  ok(await p.isVisible('#ruleCamera') && await p.isVisible('#cameraPanel'), 'camera rule and panel shown');
  await p.fill('#studentId', 'C1'); await p.fill('#studentName', 'Cam One'); await p.check('#agree');
  ok(await p.isDisabled('#startBtn'), 'cannot start with camera off');
  await p.click('#camBtn');
  await p.waitForFunction(() => document.querySelector('#checkCamera').className === 'ok', null, { timeout: 60000 });
  ok(true, 'real detector finds the face');
  ok(!(await p.isDisabled('#startBtn')), 'start enabled with face');
  await p.screenshot({ path: path.join(require('os').tmpdir(), 'cam-rules.png'), fullPage: true });
  await setCam(p, 'none');
  await p.waitForFunction(() => document.querySelector('#checkCamera').className === 'bad', null, { timeout: 10000 });
  ok((await camCheck(p)).includes('No face') && await p.isDisabled('#startBtn'), 'no face blocks start: ' + await camCheck(p));
  await setCam(p, 'black');
  await p.waitForFunction(() => /covered/.test(document.querySelector('#checkCamera').textContent), null, { timeout: 10000 });
  ok(true, 'black camera detected as covered');
  await setCam(p, 'two');
  await p.waitForFunction(() => /More than one/.test(document.querySelector('#checkCamera').textContent), null, { timeout: 10000 });
  ok(true, 'two faces detected');
  await setCam(p, 'face');
  await p.waitForFunction(() => document.querySelector('#checkCamera').className === 'ok', null, { timeout: 10000 });

  // Exam: first offense = warning
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok(await p.isVisible('#camFloat video'), 'floating camera preview during exam');
  ok(await p.evaluate(() => !document.querySelector('#camVideo').paused), 'preview still playing after moving');
  await setCam(p, 'none');
  await p.waitForSelector('#faceWarnModal:not([hidden])', { timeout: 10000 });
  ok((await p.textContent('#faceWarnReason')).includes('face was not visible'), 'warning shown for missing face');
  await sleep(500);
  let a = attempts().find(x => x.StudentID === 'C1');
  ok(a.Status === 'IN_PROGRESS' && a.Warnings === 1, 'server recorded warning, not void: ' + a.Status + ' ' + a.Warnings);
  ok(gas.sheet('Violations').objects().some(v => v.Event === 'NO_FACE' && /WARNING/.test(v.Detail)), 'warning logged in Violations');
  ok(await p.isDisabled('#faceWarnOk'), 'cannot continue while face missing');
  await setCam(p, 'face');
  await p.waitForFunction(() => !document.querySelector('#faceWarnOk').disabled, null, { timeout: 10000 });
  await p.screenshot({ path: path.join(require('os').tmpdir(), 'cam-warning.png') });
  await p.click('#faceWarnOk');
  ok(await p.isHidden('#faceWarnModal'), 'warning dismissed once face is back');
  await sleep(2000);
  ok(await p.isHidden('#voidModal'), 'no void while face visible');

  // Second offense = void
  await setCam(p, 'black');
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 10000 });
  ok((await p.textContent('#voidReason')).includes('covered'), 'second offense voids (camera covered)');
  await sleep(500);
  a = attempts().find(x => x.StudentID === 'C1');
  ok(a.Status === 'VOIDED' && /covered/.test(a.VoidReason), 'server voided: ' + a.VoidReason);
  ok(await p.isHidden('#camFloat'), 'camera stopped after void');
  await p.close();

  // Another student: two people → warning; camera turned off → void
  p = await open();
  await setCam(p, 'face');
  await p.fill('#studentId', 'C2'); await p.fill('#studentName', 'Cam Two'); await p.check('#agree');
  await p.click('#camBtn');
  await p.waitForFunction(() => document.querySelector('#checkCamera').className === 'ok', null, { timeout: 60000 });
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await setCam(p, 'two');
  await p.waitForSelector('#faceWarnModal:not([hidden])', { timeout: 10000 });
  ok((await p.textContent('#faceWarnReason')).includes('More than one'), 'warning for two people');
  await setCam(p, 'face');
  await p.waitForFunction(() => !document.querySelector('#faceWarnOk').disabled, null, { timeout: 10000 });
  await p.click('#faceWarnOk');
  await p.evaluate(() => window.__stopCam());
  await p.waitForSelector('#voidModal:not([hidden])', { timeout: 10000 });
  ok((await p.textContent('#voidReason')).includes('turned off'), 'camera turned off on 2nd offense voids');
  await p.close();

  // Server rules
  ok(gas.call({ action: 'start', examId: 'CAM', studentId: 'C3', name: 'x', env: { monitorCheck: 'supported' } }).code === 'CAMERA_REQUIRED', 'server requires camera');
  const s3 = gas.call({ action: 'start', examId: 'CAM', studentId: 'C3', name: 'x', env: { monitorCheck: 'supported', camera: 'ok' } });
  ok(gas.call({ action: 'violation', attemptId: s3.attemptId, event: 'PHONE_DETECTED', detail: 'x' }).warned === true, '1st phone = warning');
  ok(gas.call({ action: 'violation', attemptId: s3.attemptId, event: 'PHONE_DETECTED', detail: 'x' }).status === 'VOIDED', '2nd phone = void');
  const s4 = gas.call({ action: 'start', examId: 'CAM', studentId: 'C4', name: 'x', env: { monitorCheck: 'supported', camera: 'ok' } });
  ok(gas.call({ action: 'violation', attemptId: s4.attemptId, event: 'TAB_SWITCH' }).status === 'VOIDED', 'tab switch still voids at once');

  // Face check at the start only
  p = await open('CAM-START');
  ok((await p.textContent('#ruleCamera')).includes('before you can start') && !(await p.textContent('#ruleCamera')).includes('warning'), 'start-only rule text');
  await setCam(p, 'face');
  await p.fill('#studentId', 'S1'); await p.fill('#studentName', 'Start Only'); await p.check('#agree');
  ok(await p.isDisabled('#startBtn'), 'start-only: camera needed to start');
  await p.click('#camBtn');
  await p.waitForFunction(() => document.querySelector('#checkCamera').className === 'ok', null, { timeout: 60000 });
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok(await p.isHidden('#camFloat'), 'start-only: no camera preview during exam');
  ok(await p.evaluate(() => window.ExamCamera.status()) === 'OFF', 'start-only: camera turned off after start');
  await setCam(p, 'none');
  await sleep(2500);
  ok(await p.isHidden('#faceWarnModal') && await p.isHidden('#voidModal'), 'start-only: no warnings during exam');
  await p.close();

  // No camera at all
  p = await open('CAM-OFF');
  ok(await p.isHidden('#cameraPanel') && await p.isHidden('#ruleCamera') && await p.isHidden('#checkCamera'), 'off: no camera UI');
  await p.fill('#studentId', 'O1'); await p.fill('#studentName', 'No Cam'); await p.check('#agree');
  ok(!(await p.isDisabled('#startBtn')), 'off: can start without camera');
  await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  ok(true, 'off: exam started without camera');
  await p.close();

  // Older sheets: FaceMonitor TRUE means monitor always
  ok(gas.ctx.parseFaceMode_(true) === 'ALWAYS' && gas.ctx.parseFaceMode_('TRUE') === 'ALWAYS' && gas.ctx.parseFaceMode_('') === 'OFF' && gas.ctx.parseFaceMode_('start') === 'START', 'FaceMonitor values parsed');
  ok(gas.sheet('Exams').objects().find(e => e.ExamID === 'CAM-START').FaceMonitor === 'START', 'sheet stores START');

  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close(); server.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
