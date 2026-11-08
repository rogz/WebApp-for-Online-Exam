// Question pictures: upload window (shrinks to ≤ 2 MB), Drive / Dropbox / direct links,
// and showing them to students. Run with: node tests/images.test.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { create } = require('./mock-apps-script');

const REPO = path.resolve(__dirname, '..');
const gas = create(path.join(REPO, 'apps-script/Code.gs'));
gas.ctx.setupSheets();
const MB = 1024 * 1024;

let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const Q = () => gas.sheet('Questions');
const qRow = id => Q().data.findIndex(r => r[Q().data[0].indexOf('QuestionID')] === id) + 1;
const imageOf = id => Q().data[qRow(id) - 1][Q().data[0].indexOf('Image')];
const setImage = (id, v) => Q().set(qRow(id), Q().data[0].indexOf('Image') + 1, v);

// A small PNG to serve as an "external" picture
let PNG = null; // filled in below with a picture drawn in the browser

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let b = ''; req.on('data', d => b += d); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(gas.call(b))); });
    return;
  }
  const u = req.url.split('?')[0];
  if (u === '/pics/ok.png') { res.setHeader('content-type', 'image/png'); return res.end(PNG); }
  if (u === '/config.js') { res.setHeader('content-type', 'text/javascript'); return res.end("window.EXAM_CONFIG={API_URL:'/api'};"); }
  const f = path.join(REPO, 'docs', u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)]);
  res.end(fs.readFileSync(f));
});

async function gasPage(browser, file) {
  const page = await browser.newPage({ viewport: { width: 560, height: 620 } });
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
    window.google = { script: { run: runner(null, null), host: { close() { window.__closed = true; } } } };
  });
  await page.route('http://gas.test/', r => r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(REPO, 'apps-script', file), 'utf8') }));
  await page.goto('http://gas.test/');
  return { page, errors };
}

(async () => {
  await new Promise(r => server.listen(8127, r));
  const browser = await chromium.launch();

  // Make test pictures in the browser: a big noisy photo (> 2 MB) and a small PNG diagram
  const maker = await browser.newPage();
  const pics = await maker.evaluate(() => {
    const big = document.createElement('canvas'); big.width = 3000; big.height = 2250;
    const g = big.getContext('2d'); const d = g.createImageData(3000, 2250);
    for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; }
    g.putImageData(d, 0, 0);
    const small = document.createElement('canvas'); small.width = 400; small.height = 300;
    const s = small.getContext('2d'); s.fillStyle = '#fff'; s.fillRect(0, 0, 400, 300); s.strokeStyle = '#000'; s.lineWidth = 3;
    s.strokeRect(50, 50, 300, 200); s.beginPath(); s.moveTo(50, 150); s.lineTo(350, 150); s.stroke();
    return { big: big.toDataURL('image/jpeg', 1.0), small: small.toDataURL('image/png') };
  });
  await maker.close();
  const tmp = require('os').tmpdir();
  const bigFile = path.join(tmp, 'photo-big.jpg'), smallFile = path.join(tmp, 'diagram.png');
  fs.writeFileSync(bigFile, Buffer.from(pics.big.split(',')[1], 'base64'));
  fs.writeFileSync(smallFile, Buffer.from(pics.small.split(',')[1], 'base64'));
  PNG = Buffer.from(pics.small.split(',')[1], 'base64');
  ok(fs.statSync(bigFile).size > 2 * MB, 'test photo is ' + (fs.statSync(bigFile).size / MB).toFixed(1) + ' MB');

  // 1. Upload window: big photo is shrunk below 2 MB and saved to Drive
  gas.ss.__select('Questions', qRow('Q001'));
  let { page, errors } = await gasPage(browser, 'ImageUpload.html');
  await page.waitForFunction(() => document.querySelector('#qTitle').textContent === 'Question Q001');
  ok((await page.textContent('#qText')).includes('Red Planet'), 'window shows the selected question');
  await page.setInputFiles('#file', bigFile);
  await page.waitForFunction(() => !document.querySelector('#saveBtn').disabled, null, { timeout: 30000 });
  const note = await page.textContent('#sizeNote');
  ok(/^Shrunk from [\d.]+ MB to /.test(note), 'shrink note: ' + note);
  await page.screenshot({ path: path.join(tmp, 'image-dialog.png') });
  await page.click('#saveBtn');
  await page.waitForSelector('#msg.ok');
  const link = imageOf('Q001');
  ok(/^https:\/\/drive\.google\.com\/file\/d\//.test(link), 'Image column has the Drive link');
  const fileId = gas.ctx.driveFileId_(link);
  const saved = gas.drive.files[fileId].getBlob();
  ok(saved.getBytes().length <= 2 * MB && saved.getContentType() === 'image/jpeg', 'saved file is ' + (saved.getBytes().length / MB).toFixed(2) + ' MB JPEG');
  ok(Object.values(gas.drive.folders).some(f => f.getName() === 'Online Exam - question images'), 'saved in the "Online Exam - question images" folder');
  ok(errors.length === 0, 'no errors in upload window ' + errors.join(' | '));
  await page.close();

  // 2. A small PNG diagram is kept as it is (sharp lines)
  gas.ss.__select('Questions', qRow('Q005'));
  ({ page, errors } = await gasPage(browser, 'ImageUpload.html'));
  await page.waitForFunction(() => document.querySelector('#qTitle').textContent === 'Question Q005');
  await page.setInputFiles('#file', smallFile);
  await page.waitForFunction(() => !document.querySelector('#saveBtn').disabled);
  ok((await page.textContent('#sizeNote')).startsWith('Original kept'), 'small PNG kept: ' + await page.textContent('#sizeNote'));
  await page.click('#saveBtn'); await page.waitForSelector('#msg.ok');
  ok(gas.drive.files[gas.ctx.driveFileId_(imageOf('Q005'))].getBlob().getContentType() === 'image/png', 'stored as PNG');
  await page.close();

  // 3. Paste a link; remove a picture
  gas.ss.__select('Questions', qRow('Q003'));
  ({ page } = await gasPage(browser, 'ImageUpload.html'));
  await page.waitForFunction(() => document.querySelector('#qTitle').textContent === 'Question Q003');
  await page.click('#tabLink');
  await page.fill('#link', 'not a link');
  await page.click('#saveBtn'); await page.waitForSelector('#msg.err');
  ok((await page.textContent('#msg')).includes('Paste a Google Drive link'), 'bad link refused');
  await page.fill('#link', 'https://www.dropbox.com/scl/fi/abc/circuit.png?rlkey=k&dl=0');
  await page.click('#saveBtn'); await page.waitForSelector('#msg.ok');
  ok(imageOf('Q003') === 'https://www.dropbox.com/scl/fi/abc/circuit.png?rlkey=k&dl=0', 'Dropbox link saved as pasted');
  await page.click('#removeBtn'); await page.waitForFunction(() => /removed/.test(document.querySelector('#msg').textContent));
  ok(imageOf('Q003') === '', 'Remove picture clears it');
  await page.close();
  gas.ss.__select('Exams', 2);
  ({ page } = await gasPage(browser, 'ImageUpload.html'));
  await page.waitForSelector('#msg.err');
  ok((await page.textContent('#msg')).includes('Questions sheet'), 'asks to select a question row first');
  await page.close();

  // 4. Server rules for showing pictures
  ok(gas.ctx.externalImageUrl_('https://www.dropbox.com/s/x/p.png?dl=0') === 'https://www.dropbox.com/s/x/p.png?raw=1', 'Dropbox link turned into a direct link');
  const huge = gas.drive.addFile(gas.drive.blob(new Array(3 * MB).fill(1), 'image/jpeg', 'huge.jpg'));
  setImage('Q006', 'https://drive.google.com/file/d/' + huge.getId() + '/view');
  setImage('Q007', 'http://localhost:8127/pics/ok.png');
  setImage('Q002', 'https://drive.google.com/file/d/1MissingMissingMissingMissing00/view');
  gas.ctx.builderSaveExam({ id: 'PIC', title: 'Picture quiz', questionIds: ['Q001', 'Q005', 'Q006', 'Q007', 'Q004'], start: '', end: '', limitMin: 10, showScore: true, active: true, shuffleQuestions: false });
  gas.ctx.builderSaveExam({ id: 'PIC2', title: 'Missing picture', questionIds: ['Q002'], start: '', end: '', limitMin: 10, showScore: true, active: true });
  const st = gas.call({ action: 'start', examId: 'PIC', studentId: 'I1', name: 'x', env: { monitorCheck: 'supported' } });
  const byId = Object.fromEntries(st.questions.map(q => [q.id, q]));
  ok(byId.Q001.image.drive === true && !JSON.stringify(byId.Q001).includes(fileId), 'Drive picture: no link sent to the browser');
  ok(byId.Q007.image.src === 'http://localhost:8127/pics/ok.png' && !byId.Q004.image, 'direct link sent as is; no picture → none');
  const img = gas.call({ action: 'image', attemptId: st.attemptId, questionId: 'Q001' });
  ok(img.ok && img.dataUrl.startsWith('data:image/jpeg;base64,'), 'server sends the Drive picture');
  ok(gas.call({ action: 'image', attemptId: st.attemptId, questionId: 'Q006' }).code === 'IMAGE_TOO_LARGE', 'over 2 MB refused');
  ok(gas.call({ action: 'image', attemptId: st.attemptId, questionId: 'Q002' }).code === 'BAD_INPUT', 'only questions in the student\'s exam');
  ok(gas.call({ action: 'image', attemptId: 'nope', questionId: 'Q001' }).code === 'NO_ATTEMPT', 'only during an exam');
  const st2 = gas.call({ action: 'start', examId: 'PIC2', studentId: 'I2', name: 'x', env: { monitorCheck: 'supported' } });
  ok(gas.call({ action: 'image', attemptId: st2.attemptId, questionId: 'Q002' }).code === 'IMAGE_UNAVAILABLE', 'missing Drive file reported');
  gas.call({ action: 'submit', attemptId: st.attemptId, answers: {} });
  ok(gas.call({ action: 'image', attemptId: st.attemptId, questionId: 'Q001' }).code === 'ALREADY_SUBMITTED', 'not after submitting');
  setImage('Q004', 'ftp://example.com/x.png');
  ok(gas.ctx.validateQuestion_(gas.ctx.getQuestionBank_().Q004).some(p => /Image must be/.test(p)), 'question bank check flags a bad picture link');
  setImage('Q004', '');

  // 5. Student page
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(() => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get() { return false; } }); });
  const p = await ctx.newPage();
  const perr = []; p.on('pageerror', e => perr.push(e.message));
  await p.goto('http://localhost:8127/?exam=PIC');
  await p.waitForSelector('#screen-rules:not([hidden])');
  await p.fill('#studentId', 'I3'); await p.fill('#studentName', 'Pic Student'); await p.check('#agree'); await p.click('#startBtn');
  await p.waitForSelector('#screen-exam:not([hidden])');
  await p.waitForFunction(() => document.querySelector('.q-image[data-id="Q001"] img') && document.querySelector('.q-image[data-id="Q005"] img'), null, { timeout: 15000 });
  ok(await p.evaluate(() => document.querySelector('.q-image[data-id="Q001"] img').src.startsWith('data:image/jpeg')), 'Drive picture shown to the student');
  await p.waitForFunction(() => { const i = document.querySelector('.q-image[data-id="Q007"] img'); return i && i.complete && i.naturalWidth > 0; });
  ok(true, 'direct-link picture shown');
  await p.waitForSelector('.q-image[data-id="Q006"] .img-error');
  ok((await p.textContent('.q-image[data-id="Q006"]')).includes('larger than 2 MB'), 'too-large picture explains itself');
  ok(await p.evaluate(() => !document.querySelector('.question[data-id="Q004"] .q-image')), 'no picture area when there is no picture');
  await p.screenshot({ path: path.join(tmp, 'exam-pictures.png') });
  await p.click('.q-image[data-id="Q005"] img');
  ok(await p.isVisible('#imgZoom'), 'clicking a picture enlarges it');
  await p.screenshot({ path: path.join(tmp, 'exam-zoom.png') });
  await p.keyboard.press('Escape');
  ok(await p.isHidden('#imgZoom'), 'Escape closes the enlarged picture');
  await p.click('.q-image[data-id="Q005"] img'); await p.click('#imgZoomClose');
  ok(await p.isHidden('#imgZoom') && await p.isHidden('#voidModal'), 'Close button works, exam not voided');
  ok(perr.length === 0, 'no page errors ' + perr.join(' | '));

  await browser.close(); server.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
