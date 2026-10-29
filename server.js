// GHDD – Nidaamka Natiijada Imtixaanka Form 4
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Calc = require('./public/js/calc.js');
const DB = require('./db.js');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_SUBJECTS = ['Somali', 'Arabic', 'English', 'Islamic Education', 'Mathematics', 'Physics',
  'Chemistry', 'Biology', 'Geography', 'History', 'Business', 'ICT'];

let db;
let settings = null; // settings-ka imtixaanka
let auth = null; // {salt, hash, secret}
let dataVersion = 0;
let computeCache = { v: -1, C: null };

const now = () => new Date().toISOString();

// ---------- caawiyeyaal ----------
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };

function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', auth.secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const exp = crypto.createHmac('sha256', auth.secret).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (_) { return null; }
}

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key) || { n: 0, reset: t + windowMs };
  if (t > b.reset) { b.n = 0; b.reset = t + windowMs; }
  b.n++; buckets.set(key, b);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k);
  if (b.n > max) fail(429, 'Isku day badan ayaa la sameeyay. Fadlan sug dhowr daqiiqo kadibna mar kale isku day.');
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

async function audit(action, details) {
  try { await db.query('INSERT INTO audit_log (at, action, details) VALUES ($1, $2, $3)', [now(), action, JSON.stringify(details || {})]); }
  catch (e) { console.error('audit', e.message); }
}

// ---------- settings ----------
async function loadSettings() {
  const rows = await db.query('SELECT key, value FROM settings');
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  settings = Calc.withDefaults(map.main || {});
  auth = map.auth || null;
}
async function saveSetting(key, value) {
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}
async function saveMain() { await saveSetting('main', settings); dataVersion++; }

async function init() {
  db = await DB.open();
  await loadSettings();
  if (!auth) {
    const salt = crypto.randomBytes(16).toString('hex');
    auth = { salt, hash: hashPw(process.env.ADMIN_PASSWORD || 'ghdd2026', salt), secret: crypto.randomBytes(32).toString('hex'), defaultPw: !process.env.ADMIN_PASSWORD };
    await saveSetting('auth', auth);
  } else if (process.env.RESET_ADMIN_PASSWORD) {
    auth.salt = crypto.randomBytes(16).toString('hex');
    auth.hash = hashPw(process.env.RESET_ADMIN_PASSWORD, auth.salt);
    auth.defaultPw = false;
    await saveSetting('auth', auth);
  }
  const main = await db.query('SELECT key FROM settings WHERE key = $1', ['main']);
  if (!main.length) await saveMain();
  const subs = await db.query('SELECT id FROM subjects');
  if (!subs.length) {
    let i = 1;
    for (const name of DEFAULT_SUBJECTS) await db.query('INSERT INTO subjects (name, sort, active) VALUES ($1, $2, 1)', [name, i++]);
  }
  const sch = await db.query('SELECT id FROM schools');
  if (!sch.length) {
    await db.query('INSERT INTO schools (code, name, region, created_at) VALUES ($1, $2, $3, $4)', ['HWD', 'Howlwadaag Secondary School', '', now()]);
  }
}

// ---------- xogta oo dhan ----------
async function loadAll() {
  const [schools, subjects, students, marks] = await Promise.all([
    db.query('SELECT id, code, name, region, head, phone FROM schools ORDER BY name'),
    db.query('SELECT id, name, sort, active FROM subjects ORDER BY sort, id'),
    db.query('SELECT id, roll_no, exam_year, school_id, full_name, mother_name, gender, parent_phone, qr_token, status, created_at FROM students ORDER BY roll_no'),
    db.query('SELECT student_id, subject_id, score, code FROM marks')
  ]);
  const num = (x) => (x == null ? x : Number(x));
  return {
    settings,
    schools: schools.map((s) => ({ ...s, id: num(s.id) })),
    subjects: subjects.map((s) => ({ ...s, id: num(s.id), sort: num(s.sort), active: num(s.active) })),
    students: students.map((s) => ({ ...s, id: num(s.id), exam_year: num(s.exam_year), school_id: num(s.school_id) })),
    marks: marks.map((m) => [num(m.student_id), num(m.subject_id), m.score == null ? null : Number(m.score), m.code])
  };
}
async function computed() {
  if (computeCache.v === dataVersion) return computeCache;
  const v = dataVersion;
  const data = await loadAll();
  const C = Calc.computeAll(data);
  computeCache = { v, C, data };
  return computeCache;
}

function rollFor(year, seq) { return String(year % 100).padStart(2, '0') + String(seq).padStart(4, '0'); }
async function allocateRolls(q, year, n) {
  const name = 'roll_' + year;
  await q('INSERT INTO counters (name, value) VALUES ($1, 0) ON CONFLICT (name) DO NOTHING', [name]);
  const r = await q('UPDATE counters SET value = value + $2 WHERE name = $1 RETURNING value', [name, n]);
  const end = Number(r[0].value);
  return Array.from({ length: n }, (_, i) => rollFor(year, end - n + 1 + i));
}

function cleanStudent(b) {
  const full = Calc.titleCase(b.full_name);
  const mother = Calc.titleCase(b.mother_name);
  const phone = String(b.parent_phone || '').replace(/[^\d+]/g, '');
  const gender = Calc.normGender(b.gender);
  const errs = [];
  if (full.split(' ').length < 3) errs.push('Magaca ardayga waa inuu noqdaa afar magac (ugu yaraan saddex)');
  if (mother.split(' ').length < 2) errs.push('Magaca hooyada oo buuxa geli');
  if (!Calc.normPhone(phone)) errs.push('Taleefanka waalidka waa khalad');
  if (!gender) errs.push('Jinsiga dooro (Wiil / Gabar)');
  return { full, mother, phone, gender, errs, nameKey: Calc.normName(full) + '|' + Calc.normName(mother) };
}

function resultPayload(st, r, schoolName) {
  const S = settings;
  const showRank = S.showRank && r.sat;
  return {
    student: { roll: st.roll_no, name: st.full_name, mother: st.mother_name, school: schoolName, gender: st.gender, year: st.exam_year },
    result: {
      status: r.status, statusLabel: Calc.STATUS[r.status].label, tone: Calc.STATUS[r.status].tone,
      scores: r.scores.map((s) => ({ name: s.name, score: s.score, code: s.code, grade: s.grade, pass: s.pass })),
      total: r.total, max: r.nSub * 100, avg: r.avg, grade: r.grade, gradeLabel: r.gradeLabel, failed: r.failed,
      weak: r.weak.map((s) => ({ name: s.name, score: s.score, code: s.code })),
      strong: r.strong.map((s) => ({ name: s.name, score: s.score })),
      rankSchool: showRank ? r.rankSchool : null, countSchool: showRank ? r.countSchool : null,
      rankAll: showRank ? r.rankAll : null, countAll: showRank ? r.countAll : null
    },
    advice: Calc.adviceFor(r, S),
    exam: { orgName: S.orgName, orgShort: S.orgShort, examTitle: S.examTitle, examYear: S.examYear, passMark: S.passMark, minAverage: S.minAverage, grades: S.grades }
  };
}

// ---------- API ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, admin: !!opts.admin });
};

route('GET', '/api/public/info', async () => ({
  orgName: settings.orgName, orgShort: settings.orgShort, examTitle: settings.examTitle,
  examYear: settings.examYear, released: !!settings.released, releasedAt: settings.releasedAt
}));

route('POST', '/api/public/result', async (req, body) => {
  rateLimit('res:' + clientIp(req), 30, 10 * 60 * 1000);
  const roll = String(body.roll || '').replace(/\D/g, '');
  const phone = Calc.normPhone(body.phone);
  if (!roll || !phone) fail(400, 'Fadlan geli Roll Number-ka iyo taleefanka waalidka.');
  if (!settings.released) fail(403, 'Natiijada imtixaanka weli lama sii dayn. Fadlan dib u soo eeg marka GHDD ay ku dhawaaqdo.');
  const rows = await db.query('SELECT * FROM students WHERE roll_no = $1', [roll]);
  const st = rows[0];
  if (!st || st.status !== 'active' || st.phone_key !== phone) fail(404, 'Roll Number-ka ama taleefanka waalidka lama helin. Hubi oo mar kale isku day.');
  const { C, data } = await computed();
  const r = C.byId.get(Number(st.id));
  if (!r) fail(404, 'Natiijada ardaygan lama helin.');
  if (r.status === 'INCOMPLETE') fail(409, 'Natiijada ardaygan weli si buuxda looma diiwaangelin. Fadlan la xiriir xafiiska GHDD.');
  const sc = data.schools.find((s) => s.id === Number(st.school_id));
  return resultPayload(st, r, sc ? sc.name : '');
});

route('GET', '/api/public/card/:token', async (req, body, p) => {
  rateLimit('card:' + clientIp(req), 60, 10 * 60 * 1000);
  const rows = await db.query('SELECT s.roll_no, s.full_name, s.mother_name, s.gender, s.exam_year, s.status, c.name AS school FROM students s LEFT JOIN schools c ON c.id = s.school_id WHERE s.qr_token = $1', [p.token]);
  if (!rows.length) fail(404, 'Kaarkan lama aqoonsan. Waxaa laga yaabaa inuu yahay mid been abuur ah.');
  const s = rows[0];
  return { roll: s.roll_no, name: s.full_name, mother: s.mother_name, gender: s.gender, year: s.exam_year, school: s.school, valid: s.status === 'active', orgName: settings.orgName, examTitle: settings.examTitle, released: !!settings.released };
});

route('POST', '/api/login', async (req, body) => {
  rateLimit('login:' + clientIp(req), 10, 10 * 60 * 1000);
  const ok = hashPw(body.password || '', auth.salt) === auth.hash;
  if (!ok) { await audit('login_fail', { ip: clientIp(req) }); fail(401, 'Furaha sirta ah waa khalad.'); }
  await audit('login', { ip: clientIp(req) });
  return { token: sign({ exp: Date.now() + 30 * 24 * 3600 * 1000 }), defaultPw: !!auth.defaultPw };
});

route('GET', '/api/admin/bootstrap', async () => {
  const data = await loadAll();
  return { ...data, version: dataVersion, defaultPw: !!auth.defaultPw, serverTime: now(), dbKind: db.kind };
}, { admin: true });

route('POST', '/api/admin/password', async (req, body) => {
  if (hashPw(body.old || '', auth.salt) !== auth.hash) fail(400, 'Furaha hore waa khalad.');
  if (String(body.new || '').length < 6) fail(400, 'Furaha cusub waa inuu ka koobnaadaa ugu yaraan 6 xaraf.');
  auth.salt = crypto.randomBytes(16).toString('hex');
  auth.hash = hashPw(body.new, auth.salt);
  auth.defaultPw = false;
  await saveSetting('auth', auth);
  await audit('password_change', {});
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/settings', async (req, body) => {
  const s = Object.assign({}, settings);
  const str = (k, max = 200) => { if (body[k] != null) s[k] = String(body[k]).trim().slice(0, max); };
  str('orgName'); str('orgShort', 30); str('examTitle'); str('parentNote', 500);
  const num = (k, lo, hi) => { if (body[k] != null && body[k] !== '') { const n = Number(body[k]); if (!isFinite(n) || n < lo || n > hi) fail(400, `Qiimaha ${k} waa khalad`); s[k] = n; } };
  num('examYear', 2000, 2100); num('passMark', 0, 100); num('minAverage', 0, 100);
  if ('maxFailed' in body) s.maxFailed = body.maxFailed === '' || body.maxFailed == null ? null : Math.max(0, Math.floor(Number(body.maxFailed)) || 0);
  if ('showRank' in body) s.showRank = !!body.showRank;
  if (body.publicUrl != null) {
    const u = String(body.publicUrl).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+/.test(u)) fail(400, 'Link-ga dadweynaha waa inuu ku bilaabmaa https://');
    s.publicUrl = u.slice(0, 200);
  }
  if (body.advice) for (const k of ['top', 'good', 'pass', 'fail']) if (body.advice[k] != null) s.advice[k] = String(body.advice[k]).slice(0, 600);
  if (body.grades) {
    if (!Array.isArray(body.grades) || body.grades.length < 2 || body.grades.length > 15) fail(400, 'Grade-yada waa inay noqdaan 2 ilaa 15.');
    const g = body.grades.map((x) => ({ g: String(x.g || '').trim().slice(0, 4), min: Number(x.min), label: String(x.label || '').trim().slice(0, 40) }));
    if (g.some((x) => !x.g || !isFinite(x.min) || x.min < 0 || x.min > 100)) fail(400, 'Grade kasta waa inuu leeyahay magac iyo dhibic 0-100.');
    if (new Set(g.map((x) => x.g)).size !== g.length) fail(400, 'Magacyada grade-yadu waa inay kala duwanaadaan.');
    if (new Set(g.map((x) => x.min)).size !== g.length) fail(400, 'Grade kasta dhibic bilow oo ka duwan geli.');
    g.sort((a, b) => b.min - a.min);
    g[g.length - 1].min = 0;
    s.grades = g;
  }
  settings = Calc.withDefaults(s);
  await saveMain();
  await audit('settings', { keys: Object.keys(body) });
  return { settings };
}, { admin: true });

route('POST', '/api/admin/release', async (req, body) => {
  if ('released' in body) { settings.released = !!body.released; settings.releasedAt = settings.released ? now() : null; }
  if ('locked' in body) settings.locked = !!body.locked;
  await saveMain();
  await audit('release', { released: settings.released, locked: settings.locked });
  return { settings };
}, { admin: true });

route('POST', '/api/admin/schools', async (req, body) => {
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const name = String(body.name || '').trim().slice(0, 120);
  if (!code || !name) fail(400, 'Geli magaca dugsiga iyo koodkiisa.');
  const fields = [String(body.region || '').trim().slice(0, 80), String(body.head || '').trim().slice(0, 80), String(body.phone || '').trim().slice(0, 30)];
  const dup = await db.query('SELECT id FROM schools WHERE code = $1', [code]);
  if (body.id) {
    if (dup.length && Number(dup[0].id) !== Number(body.id)) fail(409, 'Koodkan dugsi kale ayaa haysta.');
    await db.query('UPDATE schools SET code = $1, name = $2, region = $3, head = $4, phone = $5 WHERE id = $6', [code, name, ...fields, Number(body.id)]);
  } else {
    if (dup.length) fail(409, 'Koodkan dugsi kale ayaa haysta.');
    await db.query('INSERT INTO schools (code, name, region, head, phone, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [code, name, ...fields, now()]);
  }
  dataVersion++;
  await audit('school_save', { code, name });
  return { schools: (await loadAll()).schools };
}, { admin: true });

route('DELETE', '/api/admin/schools/:id', async (req, body, p) => {
  const n = await db.query('SELECT id FROM students WHERE school_id = $1 LIMIT 1', [Number(p.id)]);
  if (n.length) fail(409, 'Dugsigan arday ayaa ka diiwaangashan, lama tirtiri karo.');
  await db.query('DELETE FROM schools WHERE id = $1', [Number(p.id)]);
  dataVersion++;
  await audit('school_delete', { id: p.id });
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/subjects', async (req, body) => {
  const list = Array.isArray(body.subjects) ? body.subjects : fail(400, 'Liiska maaddooyinka waa khalad.');
  await db.tx(async (q) => {
    let i = 1;
    for (const s of list) {
      const name = String(s.name || '').trim().slice(0, 60);
      if (!name) continue;
      if (s.id) await q('UPDATE subjects SET name = $1, sort = $2, active = $3 WHERE id = $4', [name, i++, s.active ? 1 : 0, Number(s.id)]);
      else await q('INSERT INTO subjects (name, sort, active) VALUES ($1, $2, $3)', [name, i++, s.active === false ? 0 : 1]);
    }
  });
  dataVersion++;
  await audit('subjects_save', { n: list.length });
  return { subjects: (await loadAll()).subjects };
}, { admin: true });

async function insertStudents(q, schoolId, rows) {
  const year = settings.examYear;
  const rolls = await allocateRolls(q, year, rows.length);
  const out = [];
  const t = now();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals = [], params = [];
    chunk.forEach((r, j) => {
      const roll = rolls[i + j];
      const token = crypto.randomBytes(9).toString('base64url');
      const b = params.length;
      vals.push(`(${Array.from({ length: 13 }, (_, k) => '$' + (b + k + 1)).join(', ')})`);
      params.push(roll, year, schoolId, r.full, r.mother, r.gender, r.phone, Calc.normPhone(r.phone), r.nameKey, token, 'active', t, t);
      out.push({ roll, token, ...r });
    });
    const ins = await q(`INSERT INTO students (roll_no, exam_year, school_id, full_name, mother_name, gender, parent_phone, phone_key, name_key, qr_token, status, created_at, updated_at) VALUES ${vals.join(', ')} RETURNING id, roll_no`, params);
    const ids = new Map(ins.map((x) => [x.roll_no, Number(x.id)]));
    out.slice(i, i + chunk.length).forEach((o) => (o.id = ids.get(o.roll)));
  }
  return out;
}

async function schoolExists(id) {
  const r = await db.query('SELECT id FROM schools WHERE id = $1', [Number(id)]);
  if (!r.length) fail(400, 'Dugsiga la doortay lama helin.');
}

route('POST', '/api/admin/students', async (req, body) => {
  await schoolExists(body.school_id);
  const c = cleanStudent(body);
  if (c.errs.length) fail(400, c.errs.join('. '));
  const dup = await db.query('SELECT s.roll_no, c.name AS school FROM students s LEFT JOIN schools c ON c.id = s.school_id WHERE s.name_key = $1 AND s.status = $2 AND s.exam_year = $3', [c.nameKey, 'active', settings.examYear]);
  if (dup.length) fail(409, `Ardaygan horay ayaa loo diiwaangeliyay (Roll No ${dup[0].roll_no}, ${dup[0].school || ''}). Arday hal mar ayuu roll number qaataa.`, { roll: dup[0].roll_no });
  const created = await db.tx((q) => insertStudents(q, Number(body.school_id), [c]));
  dataVersion++;
  await audit('student_add', { roll: created[0].roll, name: c.full });
  return { student: created[0] };
}, { admin: true });

route('POST', '/api/admin/students/bulk', async (req, body) => {
  await schoolExists(body.school_id);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 3000) : fail(400, 'Xogta ardayda lama helin.');
  const existing = new Map((await db.query('SELECT name_key, roll_no FROM students WHERE status = $1 AND exam_year = $2', ['active', settings.examYear])).map((r) => [r.name_key, r.roll_no]));
  const ok = [], skipped = [], seen = new Set();
  rows.forEach((r, i) => {
    const c = cleanStudent(r);
    if (c.errs.length) return skipped.push({ row: i + 1, name: c.full, reason: c.errs.join('; ') });
    if (existing.has(c.nameKey)) return skipped.push({ row: i + 1, name: c.full, reason: `Horay ayaa loo diiwaangeliyay (Roll No ${existing.get(c.nameKey)})` });
    if (seen.has(c.nameKey)) return skipped.push({ row: i + 1, name: c.full, reason: 'Laba jeer ayuu ku jiraa faylka' });
    seen.add(c.nameKey);
    ok.push(c);
  });
  if (body.dryRun) return { valid: ok.length, skipped };
  const created = ok.length ? await db.tx((q) => insertStudents(q, Number(body.school_id), ok)) : [];
  dataVersion++;
  await audit('student_bulk', { school_id: body.school_id, created: created.length, skipped: skipped.length });
  return { created: created.map((c) => ({ id: c.id, roll: c.roll, name: c.full, mother: c.mother })), skipped };
}, { admin: true });

route('PUT', '/api/admin/students/:id', async (req, body, p) => {
  const id = Number(p.id);
  const cur = (await db.query('SELECT * FROM students WHERE id = $1', [id]))[0] || fail(404, 'Ardayga lama helin.');
  await schoolExists(body.school_id);
  const c = cleanStudent(body);
  if (c.errs.length) fail(400, c.errs.join('. '));
  await db.query('UPDATE students SET full_name = $1, mother_name = $2, gender = $3, parent_phone = $4, phone_key = $5, name_key = $6, school_id = $7, updated_at = $8 WHERE id = $9',
    [c.full, c.mother, c.gender, c.phone, Calc.normPhone(c.phone), c.nameKey, Number(body.school_id), now(), id]);
  dataVersion++;
  await audit('student_edit', { roll: cur.roll_no, before: { name: cur.full_name, mother: cur.mother_name, phone: cur.parent_phone, school: cur.school_id }, after: { name: c.full, mother: c.mother, phone: c.phone, school: body.school_id } });
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/students/:id/status', async (req, body, p) => {
  const status = body.status === 'active' ? 'active' : 'cancelled';
  const cur = (await db.query('SELECT roll_no FROM students WHERE id = $1', [Number(p.id)]))[0] || fail(404, 'Ardayga lama helin.');
  await db.query('UPDATE students SET status = $1, updated_at = $2 WHERE id = $3', [status, now(), Number(p.id)]);
  dataVersion++;
  await audit('student_status', { roll: cur.roll_no, status });
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/marks', async (req, body) => {
  if (settings.locked) fail(423, 'Natiijada waa la xiray (locked). Si aad wax u beddesho, ka fur qaybta Dejinta.');
  const changes = Array.isArray(body.changes) ? body.changes : fail(400, 'Isbeddel lama helin.');
  if (changes.length > 20000) fail(400, 'Isbeddello aad u badan hal mar.');
  const students = new Set((await db.query('SELECT id FROM students WHERE status = $1', ['active'])).map((r) => Number(r.id)));
  const subjects = new Set((await db.query('SELECT id FROM subjects')).map((r) => Number(r.id)));
  const ups = new Map(), dels = [], errors = [];
  for (const ch of changes) {
    const [sid, subId, val] = [Number(ch[0]), Number(ch[1]), ch[2]];
    if (!students.has(sid) || !subjects.has(subId)) { errors.push({ change: ch, reason: 'Arday ama maaddo aan jirin' }); continue; }
    const m = Calc.parseMark(val);
    if (m.error) { errors.push({ change: ch, reason: 'Dhibic khaldan (0-100, M ama X)' }); continue; }
    if (m.clear) dels.push([sid, subId]);
    else ups.set(sid + ':' + subId, [sid, subId, m.score == null ? null : m.score, m.code || null]);
  }
  const t = now();
  let before = [];
  const small = ups.size + dels.length <= 30;
  if (small && (ups.size || dels.length)) {
    const ids = [...new Set([...ups.values(), ...dels].map((x) => x[0]))];
    before = await db.query(`SELECT m.student_id, m.subject_id, m.score, m.code, s.roll_no FROM marks m JOIN students s ON s.id = m.student_id WHERE m.student_id IN (${ids.map((_, i) => '$' + (i + 1)).join(', ')})`, ids);
  }
  await db.tx(async (q) => {
    const list = [...ups.values()];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const params = [];
      const vals = chunk.map((r) => { const b = params.length; params.push(r[0], r[1], r[2], r[3], t); return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`; });
      await q(`INSERT INTO marks (student_id, subject_id, score, code, updated_at) VALUES ${vals.join(', ')} ON CONFLICT (student_id, subject_id) DO UPDATE SET score = excluded.score, code = excluded.code, updated_at = excluded.updated_at`, params);
    }
    for (const d of dels) await q('DELETE FROM marks WHERE student_id = $1 AND subject_id = $2', d);
  });
  dataVersion++;
  const detail = { saved: ups.size, cleared: dels.length, errors: errors.length, source: body.source || 'gacan' };
  if (small) {
    const old = new Map(before.map((b) => [b.student_id + ':' + b.subject_id, b]));
    const roll = new Map(before.map((b) => [Number(b.student_id), b.roll_no]));
    detail.items = [...ups.values()].map((u) => { const o = old.get(u[0] + ':' + u[1]); return { s: u[0], roll: roll.get(u[0]), sub: u[1], from: o ? (o.code || o.score) : null, to: u[3] || u[2] }; });
  }
  await audit('marks', detail);
  return { saved: ups.size, cleared: dels.length, errors };
}, { admin: true });

route('GET', '/api/admin/result/:id', async (req, body, p) => {
  const { C, data } = await computed();
  const st = data.students.find((s) => s.id === Number(p.id)) || fail(404, 'Ardayga lama helin.');
  const r = C.byId.get(st.id) || fail(404, 'Ardaygan sannadka imtixaanka hadda ma laha natiijo.');
  const sc = data.schools.find((s) => s.id === st.school_id);
  return resultPayload(st, r, sc ? sc.name : '');
}, { admin: true });

route('GET', '/api/admin/audit', async () => {
  const rows = await db.query('SELECT id, at, action, details FROM audit_log ORDER BY id DESC LIMIT 300');
  return { rows: rows.map((r) => ({ ...r, details: JSON.parse(r.details || '{}') })) };
}, { admin: true });

route('GET', '/api/admin/backup', async () => {
  const data = await loadAll();
  const counters = await db.query('SELECT name, value FROM counters');
  const tokens = await db.query('SELECT id, phone_key, name_key, updated_at FROM students');
  return { kind: 'ghdd-backup', version: 1, at: now(), data, counters, extra: tokens };
}, { admin: true });

route('POST', '/api/admin/restore', async (req, body) => {
  if (!body || body.kind !== 'ghdd-backup' || !body.data) fail(400, 'Faylkan ma aha kayd GHDD.');
  if (body.confirm !== 'SOO CELI') fail(400, 'Xaqiijin ayaa loo baahan yahay.');
  const d = body.data;
  const extra = new Map((body.extra || []).map((e) => [Number(e.id), e]));
  await db.tx(async (q) => {
    for (const t of ['marks', 'students', 'subjects', 'schools']) await q(`DELETE FROM ${t}`);
    for (const s of d.schools) await q('INSERT INTO schools (id, code, name, region, head, phone, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [s.id, s.code, s.name, s.region || '', s.head || '', s.phone || '', now()]);
    for (const s of d.subjects) await q('INSERT INTO subjects (id, name, sort, active) VALUES ($1, $2, $3, $4)', [s.id, s.name, s.sort, s.active]);
    for (const s of d.students) {
      const e = extra.get(s.id) || {};
      await q('INSERT INTO students (id, roll_no, exam_year, school_id, full_name, mother_name, gender, parent_phone, phone_key, name_key, qr_token, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        [s.id, s.roll_no, s.exam_year, s.school_id, s.full_name, s.mother_name, s.gender, s.parent_phone, e.phone_key || Calc.normPhone(s.parent_phone), e.name_key || (Calc.normName(s.full_name) + '|' + Calc.normName(s.mother_name)), s.qr_token, s.status, s.created_at || now(), e.updated_at || now()]);
    }
    for (let i = 0; i < d.marks.length; i += 400) {
      const chunk = d.marks.slice(i, i + 400), params = [];
      const vals = chunk.map((m) => { const b = params.length; params.push(m[0], m[1], m[2], m[3], now()); return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`; });
      if (chunk.length) await q(`INSERT INTO marks (student_id, subject_id, score, code, updated_at) VALUES ${vals.join(', ')}`, params);
    }
    // Roll number-ka marna dib looma isticmaalo: counter-ku waa inuu ka weynaadaa kan ugu sarreeya
    for (const c of body.counters || []) {
      await q('INSERT INTO counters (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = CASE WHEN counters.value > excluded.value THEN counters.value ELSE excluded.value END', [c.name, Number(c.value)]);
    }
    if (db.kind === 'postgres') {
      for (const t of ['schools', 'subjects', 'students']) await q(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
    }
  });
  if (d.settings) { settings = Calc.withDefaults(Object.assign({}, d.settings)); await saveMain(); }
  dataVersion++;
  await audit('restore', { students: d.students.length, marks: d.marks.length });
  return { ok: true };
}, { admin: true });

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function send(req, res, status, body, type, extraHeaders = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extraHeaders };
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '') && /text|json|javascript|svg/.test(type)) {
    buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), MIME['.json'], { 'Cache-Control': 'no-store' });

const PAGES = { '/': 'index.html', '/natiijo': 'index.html', '/admin': 'admin.html', '/sw.js': 'sw.js' };
const fileCache = new Map();
function serveStatic(req, res, pathname) {
  let rel = PAGES[pathname];
  if (!rel && /^\/kaar\/[\w-]+$/.test(pathname)) rel = 'kaar.html';
  if (!rel) rel = pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(req, res, 403, 'Forbidden', 'text/plain');
  let buf = fileCache.get(file);
  if (!buf) {
    try { buf = fs.readFileSync(file); } catch (_) { return send(req, res, 404, 'Bogga lama helin', 'text/plain; charset=utf-8'); }
    if (process.env.NODE_ENV === 'production') fileCache.set(file, buf);
  }
  const ext = path.extname(file);
  const headers = { 'Cache-Control': rel.startsWith('vendor/') ? 'public, max-age=604800' : 'no-cache' };
  if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  send(req, res, 200, buf, MIME[ext] || 'application/octet-stream', headers);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 25 * 1024 * 1024) { reject(new HttpError(413, 'Xogta aad soo dirtay waa ay weyn tahay.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new HttpError(400, 'Xog JSON khaldan.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res, pathname);
  }
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) fail(404, 'API lama helin.');
    if (r.admin) {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!verify(tok)) fail(401, 'Fadlan mar kale gal (login).');
    }
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler(req, body, params, url);
    json(req, res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return json(req, res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    json(req, res, 500, { error: 'Cillad ayaa ka dhacday server-ka: ' + e.message });
  }
});

init().then(() => {
  server.listen(PORT, () => console.log(`GHDD Natiijo wuxuu ka shaqaynayaa port ${PORT} (${db.kind})`));
}).catch((e) => { console.error('Bilaabidda waa ku guuldareysatay:', e); process.exit(1); });

module.exports = { server };
