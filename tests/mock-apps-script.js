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
    getId: () => 'mock-id', getSpreadsheetTimeZone: () => 'Asia/Manila', getActiveSheet: () => sheets[0],
  };
  const props = {};
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, getUi: () => { throw new Error('no ui'); } },
    PropertiesService: { getScriptProperties: () => ({ setProperty: (k, v) => { props[k] = v; }, getProperty: k => props[k] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(d),
      parseDate: s => new Date(s),
    },
    ContentService: { createTextOutput: s => ({ content: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    HtmlService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: 'Code.gs' });
  return { ctx, ss, sheet: n => ss.getSheetByName(n), call: body => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).content) };
}
module.exports = { create };
