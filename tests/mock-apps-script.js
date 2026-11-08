// In-memory fake of the Apps Script services used by Code.gs
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');

function convert(v) {
  if (typeof v === 'string') {
    if (v.startsWith("'")) return v.slice(1);
    if (/^(true|false)$/i.test(v)) return v.toUpperCase() === 'TRUE';
    if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  }
  return v;
}
class Range {
  constructor(sh, r, c, nr = 1, nc = 1) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; }
  setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); return this; }
  setValue(v) { this.sh.set(this.r, this.c, v); return this; }
  insertCheckboxes() { for (let i = 0; i < this.nr; i++) { const cur = (this.sh.data[this.r - 1 + i] || [])[this.c - 1]; if (cur === '' || cur === undefined) this.sh.set(this.r + i, this.c, false); } return this; }
  setFontWeight() { return this; } setBackground() { return this; }
  getRow() { return this.r; } getNumRows() { return this.nr; }
}
class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = convert(v); }
  getName() { return this.name; }
  getLastRow() { for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i].some(v => v !== '' && v !== undefined)) return i + 1; return 0; }
  getLastColumn() { let m = 0; this.data.forEach(r => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== undefined) { m = Math.max(m, j + 1); break; } }); return m; }
  getDataRange() { return new Range(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, j) => this.set(r, j + 1, v)); }
  setFrozenRows() {}
  // helpers for tests
  objects() { const [h, ...rows] = this.getDataRange().getValues(); return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); }
}
function create(codePath) {
  const sheets = [new Sheet('Sheet1')];
  const ss = {
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet: s => sheets.splice(sheets.indexOf(s), 1),
    getId: () => 'mock-id', getSpreadsheetTimeZone: () => 'Asia/Manila',
    getActiveSheet: () => active.sheet || sheets[0],
  };
  // The selected cell (for menu actions that use the current row)
  const active = { sheet: null, row: 1 };
  Sheet.prototype.getActiveRange = function () { return { getRow: () => active.row }; };
  ss.__select = (name, row) => { active.sheet = ss.getSheetByName(name); active.row = row; };
  // Google Drive
  const drive = { files: {}, folders: {} };
  const newId = () => crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(33, 'x').slice(0, 33);
  const blob = (bytes, type, name) => ({ getBytes: () => bytes, getContentType: () => type, getName: () => name });
  const addFile = (b) => { const id = newId(); drive.files[id] = { getId: () => id, getUrl: () => 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk', getBlob: () => b, getName: () => b.getName() }; return drive.files[id]; };
  drive.addFile = addFile;
  drive.blob = blob;
  const folder = (name) => { const id = newId(); return (drive.folders[id] = { getId: () => id, getName: () => name, createFile: addFile }); };
  const props = {};
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, getUi: () => { throw new Error('no ui'); } },
    PropertiesService: { getScriptProperties: () => ({ setProperty: (k, v) => { props[k] = v; }, getProperty: k => props[k] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    DriveApp: {
      createFolder: folder,
      getFolderById: id => { if (!drive.folders[id]) throw new Error('no folder'); return drive.folders[id]; },
      getFileById: id => { if (!drive.files[id]) throw new Error('No item with the given ID could be found'); return drive.files[id]; },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(d),
      parseDate: s => new Date(s),
      base64Decode: s => Array.from(Buffer.from(s, 'base64')),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      newBlob: (bytes, type, name) => blob(bytes, type, name),
    },
    ContentService: { createTextOutput: s => ({ content: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    HtmlService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: 'Code.gs' });
  return { ctx, ss, drive, sheet: n => ss.getSheetByName(n), call: body => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).content) };
}
module.exports = { create };
