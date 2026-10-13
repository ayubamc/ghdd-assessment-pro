
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// PDF-yada waaweyn waxaa lagu diraa qaybo yaryar, ma aha hal JSON weyn.
app.use(express.json({ limit: '12mb' }));

const publicCandidates = [
  path.join(__dirname, 'Public'),
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'Public'),
  path.join(process.cwd(), 'public'),
  '/app/Public',
  '/app/public'
];

const PUBLIC_DIR = publicCandidates.find(dir =>
  fs.existsSync(path.join(dir, 'index.html'))
);

if (PUBLIC_DIR) {
  console.log('Serving files from:', PUBLIC_DIR);
  app.use(express.static(PUBLIC_DIR));
} else {
  console.error('Could not find Public/index.html');
}

function makePool(url) {
  return url
    ? new Pool({
        connectionString: url,
        ssl: /railway/i.test(url) ? { rejectUnauthorized: false } : false
      })
    : null;
}

// Main database: exams, question bank, item analysis, app state.
const pool = makePool(process.env.DATABASE_URL);
// Optional second database (BOOKS_DATABASE_URL): books, OCR pages and PDF chunks.
// If it is not set, everything lives in the main database exactly as before.
const booksPool = process.env.BOOKS_DATABASE_URL ? makePool(process.env.BOOKS_DATABASE_URL) : pool;
const splitDb = !!process.env.BOOKS_DATABASE_URL && booksPool !== pool;

async function db(sql, params = []) {
  if (!pool) throw new Error('PostgreSQL lama dejin.');
  return pool.query(sql, params);
}

async function bdb(sql, params = []) {
  if (!booksPool) throw new Error('PostgreSQL lama dejin.');
  return booksPool.query(sql, params);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// ───────────────────────── Gemini model auto-selection ─────────────────────────
// Google retires models regularly. Instead of hard-coding one name, the server asks Google which Flash models
// this API key can use, picks the newest, remembers it for a few hours, and skips any model that reports
// "no longer available". GEMINI_MODEL (Railway variable) is still honoured as the first choice.
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const badModels = new Set();
let modelCache = { at: 0, list: [] };
function modelVersion(name) { const m = String(name).match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; }
function rankModels(names) {
  const ok = names.map(n => String(n).replace(/^models\//, '')).filter(n => /^gemini-\d+(?:\.\d+)?-flash(?:-lite)?$/.test(n));
  const byVer = (a, b) => modelVersion(b) - modelVersion(a);
  return [...ok.filter(n => !/lite/.test(n)).sort(byVer), ...ok.filter(n => /lite/.test(n)).sort(byVer)];
}
async function getGeminiModels() {
  const forced = String(process.env.GEMINI_MODEL || '').trim();
  const key = process.env.GEMINI_API_KEY;
  const fresh = Date.now() - modelCache.at < 6 * 3600 * 1000 && modelCache.list.length;
  if (!fresh && key) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
      const data = await r.json();
      if (r.ok && Array.isArray(data.models)) {
        const names = data.models.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name);
        const ranked = rankModels(names);
        if (ranked.length) modelCache = { at: Date.now(), list: ranked };
      }
    } catch (e) { console.warn('Model list lookup failed:', e.message); }
  }
  const base = modelCache.list.length ? modelCache.list : FALLBACK_MODELS;
  const all = [...new Set([forced, ...base, ...FALLBACK_MODELS].filter(Boolean))].filter(m => !badModels.has(m));
  return all.length ? all.slice(0, 5) : FALLBACK_MODELS.slice();
}
// ───────────────────────── Gemini key pool (automatic failover) ─────────────────────────
// Put up to three keys in Railway: GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 (or a comma list in GEMINI_API_KEYS).
// If one key is rate-limited (429) or rejected (401/403/invalid), the same request is retried at once with the next key,
// and the failed key rests (5 min for limits, 1 hour for rejected keys) before it is tried again.
function geminiKeys() {
  const list = [];
  for (const v of [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEYS])
    String(v || '').split(',').map(x => x.trim()).filter(Boolean).forEach(k => { if (!list.includes(k)) list.push(k); });
  return list;
}
if (!process.env.GEMINI_API_KEY) { const first = geminiKeys()[0]; if (first) process.env.GEMINI_API_KEY = first; }
const keyCooldown = new Map();
let keyCursor = 0;
function withKey(url, opts, key) {
  const u = String(url).replace(/([?&]key=)[^&]*/, `$1${encodeURIComponent(key)}`);
  const o = { ...(opts || {}) };
  if (o.headers && typeof o.headers === 'object' && !(typeof o.headers.get === 'function')) {
    o.headers = { ...o.headers };
    for (const h of Object.keys(o.headers)) if (h.toLowerCase() === 'x-goog-api-key') o.headers[h] = key;
  }
  return [u, o];
}
const _nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.includes('generativelanguage.googleapis.com')) return _nativeFetch(url, opts);
  const keys = geminiKeys();
  let res;
  if (!keys.length) res = await _nativeFetch(url, opts);
  else {
    const n = keys.length, start = keyCursor % n, now = Date.now();
    const order = keys.map((_, i) => (start + i) % n);
    const ready = order.filter(i => (keyCooldown.get(keys[i]) || 0) <= now);
    for (const i of (ready.length ? ready : order)) {
      res = await _nativeFetch(...withKey(url, opts, keys[i]));
      if (res.ok) { keyCursor = i; break; }
      const msg = JSON.stringify(await res.clone().json().catch(() => ({})));
      const dead = res.status === 401 || res.status === 403 || (res.status === 400 && /api key|API_KEY_INVALID/i.test(msg));
      if (dead || res.status === 429) {
        keyCooldown.set(keys[i], Date.now() + (dead ? 3600e3 : 300e3));
        console.warn(`Gemini key #${i + 1} ${dead ? 'rejected' : 'rate-limited'} (${res.status}); trying the next key`);
        continue;
      }
      break;
    }
  }
  // A "model not available" answer marks that model as bad, so the next request skips it.
  try {
    if (!res.ok && u.includes(':generateContent')) {
      const msg = JSON.stringify(await res.clone().json().catch(() => ({})));
      console.warn('Gemini call failed: model=' + ((u.match(/models\/([^:/?]+)/) || [])[1] || '?') + ' status=' + res.status + ' ' + msg.slice(0, 260));
      if (res.status === 404 || /no longer available|not found|is not supported|deprecated/i.test(msg)) {
        const model = (u.match(/models\/([^:/?]+)/) || [])[1];
        if (model) { badModels.add(model); modelCache.at = 0; console.warn('Gemini model marked unavailable:', model); }
      }
    }
  } catch (_) { /* never break the request because of bookkeeping */ }
  return res;
};

const MAX_PDF_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const blooms = ['Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'];

// ───────────────────────── Language, Bloom-confidentiality and objective helpers ─────────────────────────
const LANGUAGE_NAMES = { en: 'ENGLISH', so: 'AF-SOOMAALI (SOMALI)', ar: 'ARABIC (العربية)' };
const LANGUAGE_LABELS = { en: 'English', so: 'Af-Soomaali', ar: 'العربية' };
const QUALITY_RULES = {
  en: ['Every question is linked to a learning objective', 'Source traceability (pages)', 'No duplicate questions', 'Marks sum exactly', 'Cognitive-level alignment (teacher only)'],
  so: ['Su’aal kasta waxay ku xiran tahay ujeeddo waxbarasho', 'Raad-raaca isha (bogagga)', 'Su’aalo ku celcelis ma jiraan', 'Wadarta dhibcaha waa sax', 'Waafaqsanaanta heerka garaadka (macallinka oo keliya)'],
  ar: ['كل سؤال مرتبط بهدف تعلم', 'إمكانية تتبع المصدر (الصفحات)', 'لا توجد أسئلة مكررة', 'مجموع الدرجات صحيح', 'مواءمة المستوى المعرفي (للمعلم فقط)']
};
const EN_WORDS = new Set('the of and is are was were to in which what that for with by from as on an this these those following correct true false not be can it its or at has have how why when where who between describe explain state define give name list'.split(' '));
const SO_WORDS = new Set(['waa','iyo','ee','ka','la','oo','ku','si','ah','leh','yihiin','waxaa','kuwa','ma','sida','markii','maxay','halkee','ugu','kala','lagu','loo','soo','ayaa','baa','ayuu','uu','ay','jawaab','jawaabta','suaal','suaasha','suaalaha','sheeg','sharax','qeex','dooro','waxa','waxay','tusaale','maxaa','kuwee','midka','saxda','qaybta','ardayga','ujeeddada','sababta','mid','kale','dhammaan','haddii','laakiin','ama','wuxuu','waxaan','ayey','dhex','sidee','muxuu','intee','waxbarasho']);

function normalizeLang(code) { return ['en', 'so', 'ar'].includes(code) ? code : 'en'; }

function detectTextLanguage(text) {
  const t = String(text || '');
  const arabic = (t.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (!arabic && !latin) return 'unknown';
  if (arabic >= 3 && arabic >= latin) return 'ar';
  const words = (t.toLowerCase().match(/[\p{L}]+(?:['’ʼ][\p{L}]+)?/gu) || []).map(w => w.replace(/['’ʼ]/g, ''));
  let en = 0, so = 0;
  for (const w of words) { if (EN_WORDS.has(w)) en++; if (SO_WORDS.has(w)) so++; }
  if (en + so < 2) return 'unknown';
  return so > en ? 'so' : 'en';
}

function questionStrings(q) {
  const out = [q.question, q.text, q.answer, q.topic, q.objective];
  (Array.isArray(q.options) ? q.options : []).forEach(o => out.push(o));
  (Array.isArray(q.matches) ? q.matches : []).forEach(m => { out.push(m?.question, m?.answer); });
  return out.filter(x => typeof x === 'string' && x.trim());
}
function questionLanguageMismatch(q, target) {
  return questionStrings(q).some(s => { const d = detectTextLanguage(s); return d !== 'unknown' && d !== target; });
}

// Bloom labels are teacher-only metadata. Remove any label the AI may have leaked into student-facing text.
const BLOOM_WORDS = 'Remember|Understand|Apply|Analy[sz]e|Evaluate|Create|Xusuusasho|Faham|Ku-dhaqan|Falanqayn|Qiimayn|Abuurid|تذكر|تذكّر|فهم|تطبيق|تحليل|تقويم|تقييم|إبداع|ابتكار';
const BLOOM_TAG_RE = new RegExp(`\\s*[\\(\\[\\{]\\s*(?:Bloom[^\\)\\]\\}:\\-–]*[:\\-–]\\s*)?(?:${BLOOM_WORDS})\\s*[\\)\\]\\}]`, 'giu');
const BLOOM_LINE_RE = /\s*(?:\(|\[)?\s*(?:Bloom(?:['’]s)?(?:\s+(?:level|taxonomy|heerka|نوع|مستوى))?|Heerka Bloom|مستوى بلوم)\s*[:\-–]\s*[^\n)\]]{0,40}(?:\)|\])?/giu;
function stripBloomLabels(text) {
  if (typeof text !== 'string') return text;
  return text.replace(BLOOM_LINE_RE, '').replace(BLOOM_TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
}
function stripBloomFromQuestion(q) {
  for (const k of ['question', 'text', 'answer', 'topic', 'objective']) if (typeof q[k] === 'string') q[k] = stripBloomLabels(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map(o => stripBloomLabels(String(o)));
  if (Array.isArray(q.matches)) q.matches = q.matches.map(m => (m && typeof m === 'object') ? { ...m, question: stripBloomLabels(String(m.question || '')), answer: stripBloomLabels(String(m.answer || '')) } : m);
  return q;
}


// ───────────────────────── Math notation, source-citation and passage-MCQ helpers ─────────────────────────
function isMathSubject(subject) {
  return /xisaab|math|رياضيات|حساب|algebra|geometry|joometri|هندسة|جبر/i.test(String(subject || ''));
}
const SUP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','−':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ' };
const SUB = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','−':'₋' };
function toScript(str, map) {
  const chars = [...String(str).replace(/\s+/g, '')];
  return chars.length && chars.every(c => map[c]) ? chars.map(c => map[c]).join('') : null;
}
function wrapIfComplex(x) {
  const t = String(x).trim();
  return /^[\p{L}\p{N}.√π°²³]+$/u.test(t) ? t : '(' + t + ')';
}
// Turns LaTeX / markdown leftovers into plain textbook-style math text (Unicode), and removes decorative symbols.
function cleanMathText(text) {
  if (typeof text !== 'string' || !text) return text;
  let t = text;
  // math delimiters
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, '$1').replace(/\$([^$\n]*)\$/g, '$1').replace(/\\\(|\\\)|\\\[|\\\]/g, '');
  // \text{...}, \mathrm{...}, \textbf{...}
  t = t.replace(/\\(?:text|mathrm|textbf|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1');
  // fractions and roots (repeat for simple nesting)
  for (let i = 0; i < 4; i++) {
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${wrapIfComplex(a)}/${wrapIfComplex(b)}`);
    t = t.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_, n, x) => `${toScript(n, SUP) || '^(' + n + ')'}√${wrapIfComplex(x)}`);
    t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, x) => `√${wrapIfComplex(x)}`);
  }
  // degrees: ^\circ, ^{\circ}
  t = t.replace(/\^\s*(?:\{\s*\\circ\s*\}|\\circ)/g, '°');
  const sym = { times:'×', div:'÷', cdot:'·', pm:'±', mp:'∓', leq:'≤', le:'≤', geq:'≥', ge:'≥', neq:'≠', ne:'≠', approx:'≈', pi:'π', infty:'∞', therefore:'∴', angle:'∠', triangle:'△', perp:'⊥', parallel:'∥', circ:'°', degree:'°', alpha:'α', beta:'β', theta:'θ', sum:'Σ', Delta:'Δ', rightarrow:'→', to:'→', in:'∈', cup:'∪', cap:'∩', subset:'⊂', emptyset:'∅', sim:'∼', cong:'≅' };
  t = t.replace(/\\([A-Za-z]+)/g, (m, name) => {
    if (name === 'left' || name === 'right' || name === 'displaystyle' || name === 'quad' || name === 'qquad') return '';
    return sym[name] !== undefined ? sym[name] : name;   // unknown command: keep the plain word, drop the backslash
  });
  t = t.replace(/\\[,;:! ]/g, ' ').replace(/\\%/g, '%').replace(/\\&/g, '&').replace(/\\/g, '');
  // superscripts / subscripts
  t = t.replace(/\^\{([^{}]*)\}/g, (m, x) => toScript(x, SUP) || `^(${x})`);
  t = t.replace(/(?<=[\p{L}\p{N})\]])\^(-?[0-9n])(?![\p{L}\p{N}])/gu, (m, x) => toScript(x, SUP) || m);
  t = t.replace(/_\{([^{}]*)\}/g, (m, x) => toScript(x, SUB) || x);
  t = t.replace(/(?<=[\p{L}])_([0-9])/gu, (m, x) => SUB[x]);
  // plain-text / code style math -> textbook symbols
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\b(?:sqrt|SQRT)\s*\(([^()]*)\)/g, (_, x) => `√${wrapIfComplex(x)}`);
    t = t.replace(/\b(?:cbrt|cuberoot)\s*\(([^()]*)\)/gi, (_, x) => `∛${wrapIfComplex(x)}`);
  }
  t = t.replace(/\b(?:square\s+root\s+of|xididka\s+labaad\s+ee)\s+(\d+(?:\.\d+)?|[A-Za-z])\b/gi, '√$1');
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/!=/g, '≠').replace(/=\/=/g, '≠').replace(/\+\/-/g, '±').replace(/-->|->/g, '→');
  t = t.replace(/(?<![\p{L}\p{N}])pi(?![\p{L}\p{N}])/giu, 'π');
  t = t.replace(/(\d)\s*(?:degrees?|deg)\b/gi, '$1°');
  t = t.replace(/(?<![\p{L}\p{N}])theta(?![\p{L}\p{N}])/giu, 'θ');
  t = t.replace(/(?<=\d)\s+[xX]\s+(?=\d)/g, ' × ');
  t = t.replace(/\^\(([^()]*)\)/g, (m, x) => toScript(x, SUP) || m);
  t = t.replace(/(?<=[\p{L}\p{N})\]])\^(-?\d{1,3})(?![\p{L}\p{N}])/gu, (m, x) => toScript(x, SUP) || m);
  t = t.replace(/(?<=\d)\s*%\s*/g, '%').replace(/\s+%/g, '%');
  // markdown and decorative symbols
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`+/g, '').replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/(?<=[0-9A-Za-z)\]])\s*\*\s*(?=[0-9A-Za-z(\[])/g, ' × ').replace(/(?<=[0-9A-Za-z)\]])\s*\*\s*(?=[0-9A-Za-z(\[])/g, ' × ');
  t = t.replace(/\*+/g, '');
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  t = t.replace(/\bundefined\b|\bNaN\b/g, '');
  t = t.replace(/([.,;:!?])\1{1,}/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:?!])/g, '$1');
  return t.trim();
}
function mapQuestionText(q, fn) {
  for (const k of ['question', 'text', 'answer', 'topic', 'objective', 'distractor']) if (typeof q[k] === 'string') q[k] = fn(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map(o => fn(String(o)));
  if (Array.isArray(q.matches)) q.matches = q.matches.map(m => (m && typeof m === 'object') ? { ...m, question: fn(String(m.question || '')), answer: fn(String(m.answer || '')) } : m);
  return q;
}

// Source citations ("bogga 5aad", "page 5", "sida buugga ku qoran") must never appear in the question: the question is simply asked.
const PG_WORD = '(?:bogga|boga|bog|bogagga|page|pages|pg|pp|p|الصفحة|صفحة|صفحات|ص)';
const PG_NUM = '\\d+(?:\\s*-?\\s*(?:aad|ad|aad\\.|-aad))?(?:\\s*(?:-|–|ilaa|iyo|to|and|إلى|و)\\s*\\d+(?:\\s*-?\\s*(?:aad|ad))?)?';
const CITE_LEAD = '(?:(?:sida|siday|sidii)\\s+(?:uu\\s+|ay\\s+|ku\\s+|ay\\s+ku\\s+)?)?(?:(?:ku\\s+)?(?:xusan|qoran|sharaxan|jira|taxan|muuqda|ka\\s+muuqda|ka\\s+jira|ka\\s+hadlaya|ku\\s+saabsan)\\s+(?:tahay\\s+)?)?(?:ee\\s+|ka\\s+|gudaha\\s+|dhexdiisa\\s+)?';
const CITE_EN = '(?:according\\s+to|as\\s+(?:stated|shown|given|written|explained|described|mentioned)\\s+(?:in|on)|based\\s+on|from|in|on|see|refer\\s+to)\\s+(?:the\\s+)?';
const CITE_AR = '(?:حسب|وفق[اً]?|كما\\s+(?:ورد|جاء|هو\\s+مذكور)\\s+(?:في)?|في|من|انظر)\\s*';
const BOOK_WORD = '(?:buugga|buuga|buugaag|qoraalka\\s+buugga|textbook|the\\s+book|the\\s+text\\s*book|الكتاب\\s+المدرسي|الكتاب)';
function stripSourceCitations(text) {
  if (typeof text !== 'string' || !text) return text;
  let t = text;
  const flags = 'giu';
  // 1. bracketed citation: (bogga 5aad) [Page 5] (p. 12-14) (Isha: bogga 5)
  t = t.replace(new RegExp(`\\s*[\\(\\[（]\\s*(?:(?:isha|source|المصدر)\\s*[:：-]\\s*)?(?:${BOOK_WORD}\\s*[,،:-]?\\s*)?${PG_WORD}\\s*\\.?\\s*${PG_NUM}\\s*[\\)\\]）]`, flags), '');
  // 2. "[PAGE 5]" markers the model may copy from the source text
  t = t.replace(/\s*\[\s*PAGE\s*\d+\s*\]\s*/gi, ' ');
  // 3. Somali: "Sida ku xusan bogga 5aad, ...", "Bogga 5aad ku jira ..., ", "Su'aasha bogga 5aad: ..." at the start
  t = t.replace(new RegExp(`^\\s*(?:su['’]?aasha\\s+)?${CITE_LEAD}(?:${BOOK_WORD}\\s+)?${PG_WORD}\\s*\\.?\\s*${PG_NUM}\\s*(?:ku\\s+(?:xusan|qoran|jira)\\s*)?[,:;\\-–—]?\\s*`, flags), '');
  // 4. English / Arabic leading clause: "According to page 5, ..." "On page 5: ..." "في الصفحة 5 ..."
  t = t.replace(new RegExp(`^\\s*${CITE_EN}${PG_WORD}\\s*\\.?\\s*${PG_NUM}\\s*[,:;\\-–—]?\\s*`, flags), '');
  t = t.replace(new RegExp(`^\\s*${CITE_AR}${PG_WORD}\\s*\\.?\\s*${PG_NUM}\\s*[,،:;\\-–—]?\\s*`, flags), '');
  // 5. mid-sentence mentions: ", sida ku xusan bogga 5aad," / "(...) ee bogga 12"
  t = t.replace(new RegExp(`\\s*[,،]?\\s*${CITE_LEAD}(?:${BOOK_WORD}\\s+)?\\b${PG_WORD}\\s*\\.?\\s*${PG_NUM}(?=\\s*[,.;:?!؟)]|\\s|$)`, flags), '');
  t = t.replace(new RegExp(`\\s*[,،]?\\s*${CITE_EN}${PG_WORD}\\s*\\.?\\s*${PG_NUM}(?=\\s*[,.;:?!)]|\\s|$)`, flags), '');
  // 6. book references without a page: "sida buugga ku qoran", "according to the textbook,"
  t = t.replace(new RegExp(`\\s*[,،]?\\s*(?:sida|siday|sidii)\\s+(?:uu\\s+|ay\\s+|ku\\s+)?(?:(?:ku\\s+)?(?:xusan|qoran|sharaxan|taxan)\\s+(?:tahay\\s+)?)?(?:ee\\s+|ka\\s+|gudaha\\s+)?${BOOK_WORD}(?:\\s+(?:ku\\s+(?:xusan|qoran|sharaxan)|ee\\s+maadada))?\\s*[,:;]?`, flags), ' ');
  t = t.replace(new RegExp(`\\s*[,]?\\s*(?:according\\s+to|as\\s+(?:stated|shown|given|written|explained|described)\\s+in|based\\s+on)\\s+(?:the\\s+)?(?:textbook|book|text\\s*book|source\\s+text|lesson)\\s*[,:;]?`, flags), ' ');
  t = t.replace(/\s*[,،]?\s*(?:حسب|وفق[اً]?|كما\s+ورد\s+في)\s+الكتاب(?:\s+المدرسي)?\s*[,،:;]?/gu, ' ');
  // tidy: leftover punctuation / spacing, capitalise the first Latin letter
  t = t.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+([,.;:?!؟])/g, '$1').replace(/^[\s,;:\-–—]+/, '').replace(/[ \t]{2,}/g, ' ').trim();
  t = t.replace(/^(\p{Ll})/u, c => c.toUpperCase());
  return t;
}
function stripCitationsFromQuestion(q) {
  // Teacher-only metadata (sourcePages, topic) is untouched; everything the student reads, and the answer key, is cleaned.
  for (const k of ['question', 'text', 'answer', 'objective']) if (typeof q[k] === 'string') q[k] = stripSourceCitations(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map(o => stripSourceCitations(String(o)));
  if (Array.isArray(q.matches)) q.matches = q.matches.map(m => (m && typeof m === 'object') ? { ...m, question: stripSourceCitations(String(m.question || '')), answer: stripSourceCitations(String(m.answer || '')) } : m);
  return q;
}

// Learning-objective helpers: objectives drive the blueprint and every generated question.
function tokenSet(s) { return new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= 3)); }
function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}
function blueprintObjectives(bp) {
  const out = [];
  for (const c of (Array.isArray(bp?.coverage) ? bp.coverage : [])) {
    for (const o of (Array.isArray(c.learningOutcomes) ? c.learningOutcomes : [])) {
      const t = typeof o === 'string' ? o : (o?.text || o?.objective || '');
      if (String(t).trim()) out.push({ text: String(t).trim(), topic: c.topic || c.unit || '' });
    }
  }
  return out;
}
function linkQuestionsToObjectives(questions, bp) {
  const objs = blueprintObjectives(bp);
  if (!objs.length) return { total: 0, covered: 0, percent: 0, linkedQuestions: 0, uncovered: [] };
  const sets = objs.map(o => tokenSet(o.text));
  const covered = new Set();
  let linked = 0;
  for (const q of questions) {
    const own = tokenSet(q.objective);
    let best = -1, bestScore = 0;
    sets.forEach((st, i) => { const sc = overlapScore(own, st); if (sc > bestScore) { bestScore = sc; best = i; } });
    if (best >= 0 && bestScore >= 0.6) {
      q.objective = objs[best].text;   // snap to the exact blueprint wording
      covered.add(best); linked++;
    }
  }
  return {
    total: objs.length, covered: covered.size,
    percent: Math.round(covered.size / objs.length * 100),
    linkedQuestions: linked,
    uncovered: objs.filter((_, i) => !covered.has(i)).slice(0, 20).map(o => o.text)
  };
}

// Gemini sometimes stops mid-JSON (token limit). Salvage every COMPLETE question object instead of failing the whole exam.
function parseQuestionsJson(raw) {
  const text = String(raw || '').replace(/^\s*```json\s*|```\s*$/g, '').trim();
  try {
    const j = JSON.parse(text);
    return { questions: Array.isArray(j.questions) ? j.questions : [], passage: normalizePassage(j.passage), truncated: false };
  } catch (_) { /* fall through to salvage */ }
  const key = text.indexOf('"questions"');
  const start = text.indexOf('[', key < 0 ? 0 : key);
  if (start < 0) throw new Error('AI returned no question list');
  const out = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) { try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch (_) {} objStart = -1; }
    } else if (c === ']' && depth === 0) break;
  }
  if (!out.length) throw new Error('AI returned unreadable JSON');
  let passage = null;
  const pm = text.match(/"passage"\s*:\s*(\{[\s\S]*?\})\s*,\s*"questions"/);
  if (pm) { try { passage = normalizePassage(JSON.parse(pm[1])); } catch (_) {} }
  return { questions: out, passage, truncated: true };
}
function validAnchors(list, text) {
  const hay = String(text || '').replace(/\s+/g, ' ');
  return (Array.isArray(list) ? list : [])
    .map(a => ({ objective: String(a?.objective || '').trim(), example: String(a?.example || '').trim() }))
    .filter(a => a.objective && a.example && hay.includes(a.example.replace(/\s+/g, ' ')))
    .slice(0, 40);
}
function normalizePassage(p) {
  if (!p || typeof p !== 'object') return null;
  const text = String(p.text || '').trim();
  if (!text) return null;
  return { title: String(p.title || '').trim(), text, anchors: validAnchors(p.anchors, text) };
}
// Themes that touch the student's own life and character (the teacher can pick one, otherwise one is chosen at random).
const PASSAGE_THEMES = {
  honesty: 'honesty and telling the truth (run sheegid)',
  generosity: 'generosity and giving to others (deeqsinimo)',
  trust: 'trustworthiness: keeping a trust (amaano)',
  patriotism: 'love of the homeland and serving it (dal jacayl)',
  loyalty: 'loyalty and sincerity (daacadnimo)',
  success: 'success through hard work and perseverance (guul iyo dadaal)',
  student: 'being a good student: discipline, respect for teachers and love of learning (ardaynimo)',
  cooperation: 'cooperation and helping one another (iskaashi)',
  respect: 'respect and good manners toward parents, elders and teachers (ixtiraam)',
  patience: 'patience and self-control (samir)',
  peace: 'forgiveness, peace and good relations between people (cafis iyo nabad)'
};
function pickPassageTheme(p) {
  const key = String(p.passageTheme || '');
  if (PASSAGE_THEMES[key]) return PASSAGE_THEMES[key];
  const keys = Object.keys(PASSAGE_THEMES);
  return PASSAGE_THEMES[keys[Math.floor(Math.random() * keys.length)]];
}
// Table of Specifications support: the Bloom counts of every topic must add up to that topic's question count.
function normalizeBloomRow(row, levels) {
  const allowed = (Array.isArray(levels) && levels.length ? levels : blooms).filter(l => blooms.includes(l));
  const useLevels = allowed.length ? allowed : blooms;
  const target = Math.max(0, Math.round(Number(row.questionCount) || 0));
  const dist = {};
  blooms.forEach(k => { dist[k] = useLevels.includes(k) ? Math.max(0, Math.round(Number(row.bloomDistribution?.[k]) || 0)) : 0; });
  let sum = blooms.reduce((n, k) => n + dist[k], 0);
  if (sum === 0 && target > 0) { let i = 0; while (sum < target) { dist[useLevels[i % useLevels.length]]++; sum++; i++; } }
  let guard = 0;
  while (sum !== target && guard++ < 2000) {
    if (sum < target) { const k = useLevels.slice().sort((a, b) => dist[b] - dist[a])[0]; dist[k]++; sum++; }
    else { const k = useLevels.filter(x => dist[x] > 0).sort((a, b) => dist[b] - dist[a])[0]; if (!k) break; dist[k]--; sum--; }
  }
  row.bloomDistribution = dist;
}
// Reading-passage mode (Arabic / Somali / English language exams): the exam starts with an original passage built from the curriculum.
function passageInstructions(p, passageObj, targetLanguage) {
  if (!p.passage) return '';
  const passageText = passageObj?.text || '';
  const anchors = Array.isArray(passageObj?.anchors) ? passageObj.anchors : [];
  if (passageText) {
    return `PASSAGE MODE: this exam starts with the reading passage below (already written, in ${targetLanguage}). Do NOT write a new passage and do NOT repeat the passage in your answer.
PURPOSE: the exam measures the student's LANGUAGE ABILITY according to the CURRICULUM OBJECTIVES (grammar/naxwaha, vocabulary/ereyada, word forms, synonyms and antonyms, rhetoric and style, spelling and punctuation, and reading comprehension), using the passage as the text the questions are drawn from. The passage is NOT in the textbook; the objectives come from the curriculum text and blueprint.
FIRST MULTIPLE-CHOICE QUESTIONS (Part 1, type MCQ) \u2014 MOST IMPORTANT RULES:
1. Every MCQ is drawn OUT OF THE PASSAGE: its stem quotes or clearly points to a real word, phrase, sentence or idea that appears in the passage, so it can only be answered by using the passage.
2. Every MCQ is built on ONE curriculum objective of the blueprint (copy that objective into the \"objective\" field). The objective, not the passage content, decides the question: grammar/naxwe objectives -> parse, identify or correct a structure taken from a passage sentence; vocabulary objectives -> meaning, synonym, antonym, plural/singular, root or word form of a word taken from the passage; rhetoric/style objectives -> identify the device or its effect in a passage phrase; spelling/punctuation objectives -> the correct spelling or punctuation of a passage sentence; comprehension objectives -> main idea, detail, cause and result, inference, best title, lesson.
3. Proportion: at least 70% of the MCQs must test curriculum language skills (grammar, vocabulary, word forms, rhetoric, spelling, punctuation); at most 30% may be pure comprehension. Order them so that the language-skill questions come first and comprehension questions follow.
4. Spread the MCQs over as many DIFFERENT objectives as possible; do not repeat an objective until all objectives have been used once.
5. Do NOT ask about authors, poems, lessons or facts that are not in the passage. Stems are short and clear, in the style of the national exams. Exactly four options, one correct answer, plausible distractors of the same kind.
Questions of other types (fill in, matching, structured) follow the curriculum objectives and may also use the passage. Follow the required section plan, types and counts exactly.${anchors.length ? `\nANCHORS (curriculum objective -> example inside the passage): build the language-skill MCQs on these examples, quoting the example in the stem, and cover as many different anchors as possible:\n${JSON.stringify(anchors)}` : ''}\nPASSAGE:\n<<<${passageText}>>>`;
  }
  return `PASSAGE MODE (reading-passage language exam, MOST IMPORTANT): first write ONE original reading passage / story (a \"passage\" object with \"title\" and \"text\" next to \"questions\") in ${targetLanguage} ONLY. Length 250 to 350 words in 3 to 5 short paragraphs separated by a newline, suited to the class level. The passage must be built on a theme, vocabulary and language structures that come from the supplied curriculum text and blueprint objectives (do not copy long sentences from it). Then write ALL multiple-choice questions so they are drawn out of the passage AND built on the curriculum objectives (grammar, vocabulary, word forms, rhetoric, spelling, punctuation first; comprehension at most 30%). The passage must contain everything needed to answer, must not contain Bloom labels, and the answers must not be copied word-for-word into the options as a trick. Do not create diagrams.`;
}
function remainingPlan(plan, done) {
  let skip = done;
  return (Array.isArray(plan) ? plan : []).map(x => { const c = Number(x.count) || 0; const used = Math.min(c, skip); skip -= used; return { ...x, count: c - used }; }).filter(x => x.count > 0);
}
async function requestQuestionBatch(prompt) {
  const key = process.env.GEMINI_API_KEY;
  const models = await getGeminiModels();
  let lastError = '';
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.25, maxOutputTokens: 32000 } })
        });
        const data = await r.json();
        if (!r.ok) { lastError = data?.error?.message || `AI request failed (${r.status})`; if ([429, 500, 502, 503, 504].includes(r.status)) continue; break; }
        const raw = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
        const parsed = parseQuestionsJson(raw);
        if (parsed.questions.length) return parsed;
        lastError = 'AI returned no questions';
      } catch (e) { lastError = e.message; }
    }
  }
  throw new Error(lastError || 'AI request failed');
}

async function callGeminiJson(prompt, { maxTokens = 9000, temperature = 0.1 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing');
  const models = await getGeminiModels();
  let lastError = '';
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: maxTokens } })
      });
      const data = await r.json();
      if (!r.ok) { lastError = data?.error?.message || `AI request failed (${r.status})`; continue; }
      const raw = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').replace(/^```json|```$/g, '').trim();
      return JSON.parse(raw);
    } catch (e) { lastError = e.message; }
  }
  throw new Error(lastError || 'AI request failed');
}

// If any question still contains another language, ask the AI to rewrite only those questions in the selected language.
async function enforceQuestionLanguage(questions, targetCode) {
  const target = normalizeLang(targetCode);
  const bad = questions.map((q, i) => ({ q, i })).filter(({ q }) => questionLanguageMismatch(q, target));
  if (!bad.length) return { fixed: 0, remaining: 0 };
  const subset = bad.map(({ q, i }) => ({ index: i, question: q.question || '', answer: q.answer || '', options: q.options || [], matches: q.matches || [], topic: q.topic || '', objective: q.objective || '', diagramSvg: q.diagramSvg || '' }));
  const prompt = `You are a professional translator and exam editor. Rewrite EVERY string value of the exam questions below into ${LANGUAGE_NAMES[target]} only. Keep the meaning, the correct answer, the number and ORDER of options and matches, option letters A-D, numbers, formulas, SI symbols and proper names exactly consistent. For MCQ keep the answer consistent with the translated options. For matching, each match "answer" must equal the translated option text exactly. If diagramSvg is not empty, translate only the visible text labels inside <text> elements and keep the SVG otherwise unchanged. Do not mention Bloom or cognitive levels. Return valid JSON only: {"questions":[{"index":0,"question":"","answer":"","options":[],"matches":[{"question":"","answer":""}],"topic":"","objective":"","diagramSvg":""}]}\nQUESTIONS:\n${JSON.stringify(subset)}`;
  try {
    const out = await callGeminiJson(prompt, { maxTokens: 12000, temperature: 0.1 });
    for (const f of (Array.isArray(out.questions) ? out.questions : [])) {
      const t = questions[Number(f.index)];
      if (!t) continue;
      for (const k of ['question', 'answer', 'topic', 'objective']) if (typeof f[k] === 'string' && f[k].trim()) t[k] = f[k];
      if (Array.isArray(f.options) && f.options.length === (t.options || []).length) t.options = f.options.map(String);
      if (Array.isArray(f.matches) && f.matches.length === (t.matches || []).length) t.matches = f.matches.map(m => ({ question: String(m?.question || ''), answer: String(m?.answer || '') }));
      if (typeof f.diagramSvg === 'string' && /<svg\b/i.test(f.diagramSvg)) t.diagramSvg = f.diagramSvg;
    }
  } catch (e) { console.warn('Language enforcement pass failed:', e.message); }
  const remaining = questions.filter(q => questionLanguageMismatch(q, target)).length;
  return { fixed: bad.length - remaining, remaining };
}

// Step 1 of passage mode: a dedicated request just for the passage (more reliable than asking for it inside the questions JSON).
async function generatePassage(p, targetLanguage) {
  const objectives = blueprintObjectives(p.blueprint).map(o => o.text).slice(0, 40);
  const theme = pickPassageTheme(p);
  const prompt = `You are an expert ${targetLanguage} language teacher writing the reading passage for a school exam.
THEME: ${theme}. The passage must TOUCH the student's own life and character: an engaging short story or reflective text built around a concrete situation (use Somali names and settings where suitable) that leaves a clear moral lesson relevant to a student. It must never be a dry lecture.
LANGUAGE AND STYLE: ${targetLanguage} ONLY, in the style of the Somali national examinations, for ${p.className || 'the class'} students (subject: ${p.subject || 'language'}). Length 350 to 450 words in 4 to 6 paragraphs separated by a newline, in correct, rich, formal language.
CONCEPT (backward design from the curriculum): the passage is NOT in the students' textbook; it is a NEW text used to measure the curriculum skills. First decide where each learning objective below will be demonstrated, then write the passage so that every objective appears naturally in at least one clear example (a word, phrase or sentence) that a question can test: grammar structures and their parsing, word forms such as plurals and verb forms, figures of speech and rhetorical devices, rhyme and wordplay, punctuation and spelling, rich vocabulary with synonyms and antonyms. The same text must also allow comprehension questions (main idea, details, cause and result, inference, the lesson). Take vocabulary and structures from the CURRICULUM TEXT below; do not copy long sentences from it. Do not mention Bloom or cognitive levels.
OBJECTIVES TO EMBED: ${JSON.stringify(objectives)}
Return valid JSON only: {"title":"","text":"","anchors":[{"objective":"<objective text>","example":"<the exact word, phrase or sentence copied from your passage>"}]}. Give an anchor for as many objectives as possible (at least 8); every "example" must be copied EXACTLY from the passage text.
CURRICULUM TEXT:
${String(p.sourceText || p.text || '').slice(0, 30000)}`;
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await callGeminiJson(prompt, { maxTokens: 16000, temperature: 0.5 });
      const cand = normalizePassage(out && out.passage ? out.passage : out);
      if (cand && cand.text.split(/\s+/).length >= 60) return cand;
      last = 'passage empty or too short';
    } catch (e) { last = e.message; }
  }
  throw new Error('AI did not return a reading passage (' + last + '). Try again.');
}

// Passage mode: every multiple-choice question must really be answerable from the passage.
function normToken(w) { return w.replace(/[\u064B-\u065F\u0670]/g, '').replace(/^(?:و)?(?:ال|لل)/, '').replace(/[ةه]$/, ''); }
function contentTokens(s) { return new Set((String(s || '').toLowerCase().match(/[\p{L}]+/gu) || []).map(normToken).filter(w => w.length >= 3)); }
function isGroundedInPassage(q, passageSet) {
  const stemText = String(q.question || q.text || '');
  const quoted = [...stemText.matchAll(/["“”«»'‘’]([^"“”«»'‘’]{2,40})["“”«»'‘’]/g)].map(m => m[1]);
  for (const qt of quoted) for (const t of contentTokens(qt)) if (passageSet.has(t)) return true;
  let hits = 0; for (const t of contentTokens(stemText)) if (passageSet.has(t)) hits++;
  if (hits >= 2) return true;
  let oh = 0; for (const t of contentTokens((Array.isArray(q.options) ? q.options : []).join(' '))) if (passageSet.has(t)) oh++;
  return hits + oh >= 3;
}
async function enforcePassageGrounding(questions, passage, p, targetLanguage) {
  if (!p.passage || !passage?.text) return { rewritten: 0, remaining: 0 };
  const set = contentTokens(`${passage.title || ''} ${passage.text}`);
  const isMcq = q => q.type === 'MCQ' || (Array.isArray(q.options) && q.options.length === 4);
  const bad = questions.map((q, i) => ({ q, i })).filter(({ q }) => isMcq(q) && !isGroundedInPassage(q, set));
  if (!bad.length) return { rewritten: 0, remaining: 0 };
  const subset = bad.map(({ q, i }) => ({ index: i, objective: q.objective || '', question: q.question || '', options: q.options || [], answer: q.answer || '' }));
  const prompt = `Rewrite each multiple-choice question below so that it is answered directly from the PASSAGE (its stem must quote or clearly refer to a word, sentence, idea or example that really appears in the passage), while still measuring the SAME learning objective. Write in ${targetLanguage} ONLY. Exactly four options, ONE clearly correct, plausible distractors of the same kind, and the answer must be the correct option letter (A, B, C or D) matching your new options. Never mention Bloom or cognitive levels. Return valid JSON only: {"questions":[{"index":0,"question":"","options":["","","",""],"answer":"A","objective":""}]}
PASSAGE:
${passage.title ? passage.title + '\n' : ''}${passage.text}
QUESTIONS TO REWRITE:
${JSON.stringify(subset)}`;
  try {
    const out = await callGeminiJson(prompt, { maxTokens: 12000, temperature: 0.2 });
    for (const f of (Array.isArray(out.questions) ? out.questions : [])) {
      const t = questions[Number(f.index)];
      if (!t || !Array.isArray(f.options) || f.options.length !== 4 || !String(f.question || '').trim()) continue;
      t.question = stripBloomLabels(String(f.question));
      t.options = f.options.map(o => stripBloomLabels(String(o)));
      if (String(f.answer || '').trim()) t.answer = String(f.answer).trim();
      if (String(f.objective || '').trim()) t.objective = String(f.objective).trim();
    }
  } catch (e) { console.warn('Passage grounding pass failed:', e.message); }
  const remaining = questions.filter(q => isMcq(q) && !isGroundedInPassage(q, set)).length;
  return { rewritten: bad.length - remaining, remaining };
}

async function enforcePassageLanguage(passage, targetCode) {
  const target = normalizeLang(targetCode);
  const d = detectTextLanguage(`${passage.title} ${passage.text}`);
  if (d === 'unknown' || d === target) return;
  try {
    const out = await callGeminiJson(`Rewrite this reading passage in ${LANGUAGE_NAMES[target]} ONLY, keeping the same story, meaning, paragraphs (separated by a newline) and length. Return valid JSON only: {"title":"","text":""}\n${JSON.stringify({ title: passage.title, text: passage.text })}`, { maxTokens: 6000, temperature: 0.2 });
    if (typeof out.text === 'string' && out.text.trim()) { passage.text = out.text.trim(); if (typeof out.title === 'string') passage.title = out.title.trim(); }
  } catch (e) { console.warn('Passage language pass failed:', e.message); }
}

async function enforceBlueprintLanguage(bp, targetCode) {
  const target = normalizeLang(targetCode);
  const strs = row => [row.unit, row.topic, ...(row.learningOutcomes || [])].filter(x => typeof x === 'string' && x.trim());
  const mismatch = row => strs(row).some(x => { const d = detectTextLanguage(x); return d !== 'unknown' && d !== target; });
  const bad = bp.coverage.map((row, i) => ({ row, i })).filter(({ row }) => mismatch(row));
  if (!bad.length) return;
  const subset = bad.map(({ row, i }) => ({ index: i, unit: row.unit || '', topic: row.topic || '', learningOutcomes: row.learningOutcomes || [] }));
  const prompt = `Translate every string value below into ${LANGUAGE_NAMES[target]} only. Keep the same number and order of learningOutcomes, and keep each outcome a measurable objective starting with an observable action verb in the target language. Return valid JSON only: {"coverage":[{"index":0,"unit":"","topic":"","learningOutcomes":[""]}]}\n${JSON.stringify(subset)}`;
  try {
    const out = await callGeminiJson(prompt, { maxTokens: 6000, temperature: 0.1 });
    for (const f of (Array.isArray(out.coverage) ? out.coverage : [])) {
      const row = bp.coverage[Number(f.index)];
      if (!row) continue;
      if (typeof f.unit === 'string' && f.unit.trim()) row.unit = f.unit;
      if (typeof f.topic === 'string' && f.topic.trim()) row.topic = f.topic;
      if (Array.isArray(f.learningOutcomes) && f.learningOutcomes.length === (row.learningOutcomes || []).length) row.learningOutcomes = f.learningOutcomes.map(String);
    }
  } catch (e) { console.warn('Blueprint language pass failed:', e.message); }
}

function uid() {
  return crypto.randomUUID();
}

function auth(req, res, next) {
  if (req.path === '/health') return next();

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD && !(req.path === '/ai-test' && req.query.pw === ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Furaha maamulka waa khaldan yahay.' });
  }

  next();
}

app.use('/api', auth);

async function initDb() {
  await db(`
    CREATE TABLE IF NOT EXISTS assessments(
      id TEXT PRIMARY KEY,
      title TEXT,
      subject TEXT,
      klass TEXT,
      total_marks INT,
      duration TEXT,
      school TEXT,
      blueprint JSONB,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS question_bank(
      id TEXT PRIMARY KEY,
      subject TEXT,
      klass TEXT,
      unit TEXT,
      topic TEXT,
      lo TEXT,
      bloom TEXT,
      difficulty TEXT,
      type TEXT,
      marks INT,
      question TEXT,
      answer TEXT,
      options JSONB,
      source TEXT,
      status TEXT DEFAULT 'Approved',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS item_analysis(
      id TEXT PRIMARY KEY,
      assessment_id TEXT,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS app_state(
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await bdb(`
    CREATE TABLE IF NOT EXISTS books(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT,
      filename TEXT,
      page_count INT NOT NULL,
      pdf BYTEA NOT NULL,
      pages JSONB NOT NULL,
      text_chars INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // PDF-yada waaweyn waxaa lagu kaydiyaa qaybo database-ka ku jira.
  await bdb(`
    CREATE TABLE IF NOT EXISTS book_pdf_chunks(
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      data BYTEA NOT NULL,
      PRIMARY KEY(book_id, chunk_index)
    )
  `);

  // Indexed per-page OCR text makes page-range searches much faster than
  // loading the entire JSONB document for every request. Old books remain usable.
  await bdb(`
    CREATE TABLE IF NOT EXISTS book_pages(
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      page INT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      extraction_method TEXT NOT NULL DEFAULT 'embedded',
      confidence REAL,
      char_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY(book_id, page)
    )
  `);
  await bdb(`CREATE INDEX IF NOT EXISTS idx_book_pages_book_page ON book_pages(book_id, page)`);
}

const dbReady = initDb()
  .then(() => console.log('PostgreSQL tables are ready'))
  .catch(err => {
    console.error('Database initialization failed:', err.message);
    throw err;
  });

app.get('/api/health', async (req, res) => {
  try {
    await dbReady;
    await db('SELECT 1');
    if (splitDb) await bdb('SELECT 1');
    res.json({ ok: true, database: true, booksDatabase: splitDb ? 'separate' : 'same', maxPdfMB: 500 });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get('/api/ai-test', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY laguma dejin Railway.' });
  let listed = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    const d = await r.json();
    listed = r.ok ? (d.models || []).map(m => String(m.name).replace('models/', '')).filter(n => /flash/i.test(n)) : [`list error ${r.status}: ${d?.error?.message}`];
  } catch (e) { listed = ['list error: ' + e.message]; }
  const candidates = await getGeminiModels();
  const results = [];
  for (const model of candidates) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 64 } })
      });
      const d = await r.json().catch(() => ({}));
      results.push({ model, status: r.status, ok: r.ok, message: r.ok ? String(d.candidates?.[0]?.content?.parts?.[0]?.text || '(empty answer)').slice(0, 40) : String(d?.error?.message || '').slice(0, 300) });
    } catch (e) { results.push({ model, error: e.message }); }
  }
  res.json({ forcedModel: process.env.GEMINI_MODEL || null, listedFlashModels: listed, triedInOrder: candidates, blocked: [...badModels], results });
});

app.get('/api/ai-models', async (req, res) => {
  try { const keys = geminiKeys(); res.json({ ok: true, models: await getGeminiModels(), blocked: [...badModels], forced: process.env.GEMINI_MODEL || null, keys: keys.map((k, i) => ({ slot: i + 1, status: (keyCooldown.get(k) || 0) > Date.now() ? 'resting' : 'ready' })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', (req, res) => {
  res.json({ ok: (req.body?.password || '') === ADMIN_PASSWORD });
});

// App state
app.get('/api/state', async (req, res) => {
  try {
    await dbReady;
    const r = await db('SELECT data, updated_at FROM app_state WHERE id=$1', [1]);
    res.json({
      ok: true,
      state: r.rows[0]?.data || null,
      updatedAt: r.rows[0]?.updated_at || null
    });
  } catch (e) {
    res.status(500).json({ error: 'Xogta app-ka lama soo dejin.' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    await dbReady;
    const state = req.body?.state;

    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'Xogta app-ka ma saxna.' });
    }

    await db(`
      INSERT INTO app_state(id, data, updated_at)
      VALUES(1, $1, now())
      ON CONFLICT(id)
      DO UPDATE SET data=EXCLUDED.data, updated_at=now()
    `, [JSON.stringify(state)]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Xogta lama kaydin.' });
  }
});

// Liiska buugaagta
app.get('/api/books', async (req, res) => {
  try {
    await dbReady;
    const r = await bdb(`
      SELECT id, title, subject, filename, page_count,
             text_chars, created_at
      FROM books
      ORDER BY created_at DESC
    `);
    res.json({ books: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Buugaagta lama soo dejin.' });
  }
});

// Bilaabidda upload-ka PDF weyn
app.post('/api/books/upload/start', async (req, res) => {
  try {
    await dbReady;

    const p = req.body || {};
    const title = String(p.title || '').trim();
    const size = Number(p.size);
    const pageCount = Number(p.pageCount);

    if (!title) {
      return res.status(400).json({ error: 'Magaca buugga waa loo baahan yahay.' });
    }

    if (!Number.isFinite(size) || size < 1 || size > MAX_PDF_BYTES) {
      return res.status(413).json({ error: 'PDF-gu waa inuu ka yaraadaa 500 MB.' });
    }

    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 3000) {
      return res.status(400).json({ error: 'Bogagga waa inay u dhexeeyaan 1 iyo 3000.' });
    }

    const id = uid();

    await bdb(`
      INSERT INTO books(
        id, title, subject, filename, page_count, pdf, pages, text_chars
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,0)
    `, [
      id,
      title.slice(0, 250),
      String(p.subject || '').slice(0, 150),
      String(p.filename || 'book.pdf').slice(0, 250),
      pageCount,
      Buffer.alloc(0),
      JSON.stringify([])
    ]);

    res.json({
      ok: true,
      id,
      chunkSize: CHUNK_BYTES,
      maxBytes: MAX_PDF_BYTES
    });
  } catch (e) {
    console.error('Upload start:', e.message);
    res.status(500).json({ error: 'Upload-ka lama bilaabi karin.' });
  }
});

// Kaydinta qayb kasta oo PDF-ga ah
app.post('/api/books/:id/chunks/:index', async (req, res) => {
  try {
    await dbReady;

    const index = Number(req.params.index);
    const encoded = req.body?.chunkBase64;

    if (!Number.isInteger(index) || index < 0 || typeof encoded !== 'string') {
      return res.status(400).json({ error: 'Qaybta PDF-ga ma saxna.' });
    }

    if (encoded.length > 6 * 1024 * 1024) {
      return res.status(413).json({ error: 'Qaybta PDF-gu aad bay u weyn tahay.' });
    }

    const exists = await bdb('SELECT id FROM books WHERE id=$1', [req.params.id]);

    if (!exists.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    const data = Buffer.from(encoded, 'base64');

    if (!data.length || data.length > CHUNK_BYTES) {
      return res.status(400).json({ error: 'Cabbirka qaybta ma saxna.' });
    }

    await bdb(`
      INSERT INTO book_pdf_chunks(book_id, chunk_index, data)
      VALUES($1,$2,$3)
      ON CONFLICT(book_id,chunk_index)
      DO UPDATE SET data=EXCLUDED.data
    `, [req.params.id, index, data]);

    res.json({ ok: true, index, bytes: data.length });
  } catch (e) {
    console.error('Chunk upload:', e.message);
    res.status(500).json({ error: 'Qaybta PDF-ga lama kaydin.' });
  }
});

// Dhammeystirka upload-ka iyo kaydinta qoraalka OCR
app.post('/api/books/:id/upload/finish', async (req, res) => {
  try {
    await dbReady;

    const pages = req.body?.pages;
    if (!Array.isArray(pages)) {
      return res.status(400).json({ error: 'Qoraalka OCR waa loo baahan yahay.' });
    }

    const bookResult = await bdb(
      'SELECT id, page_count FROM books WHERE id=$1',
      [req.params.id]
    );

    if (!bookResult.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    const chunkResult = await bdb(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(octet_length(data)),0)::bigint AS bytes,
             MIN(chunk_index) AS first_chunk,
             MAX(chunk_index) AS last_chunk
      FROM book_pdf_chunks
      WHERE book_id=$1
    `, [req.params.id]);

    const stats = chunkResult.rows[0];
    const bytes = Number(stats.bytes);

    if (!stats.count || stats.first_chunk !== 0) {
      return res.status(400).json({ error: 'Qaybaha PDF-ga oo dhan lama helin.' });
    }

    if (bytes > MAX_PDF_BYTES) {
      return res.status(413).json({ error: 'PDF-gu wuxuu dhaafay 500 MB.' });
    }

    // Hubi in aanay jirin qaybo ka maqan.
    if (Number(stats.last_chunk) + 1 !== Number(stats.count)) {
      return res.status(400).json({ error: 'Qaybo PDF ah ayaa maqan. Dib u dir upload-ka.' });
    }

    const cleanPages = pages
      .map(p => ({
        page: Number(p.page),
        text: String(p.text || '').slice(0, 100000),
        method: ['ocr','embedded'].includes(String(p.method || '')) ? String(p.method) : 'embedded',
        confidence: Number.isFinite(Number(p.confidence)) && p.confidence !== null && p.confidence !== ''
          ? Math.max(0, Math.min(100, Number(p.confidence))) : null
      }))
      .filter(p =>
        Number.isInteger(p.page) &&
        p.page >= 1 &&
        p.page <= Number(bookResult.rows[0].page_count)
      );

    const chars = cleanPages.reduce((sum, p) => sum + p.text.length, 0);

    await bdb(`
      UPDATE books
      SET pages=$2::jsonb, text_chars=$3
      WHERE id=$1
    `, [req.params.id, JSON.stringify(cleanPages), chars]);

    // Upsert each page into the indexed table for fast, selective retrieval.
    // Metadata is optional so legacy clients sending only page/text still work.
    await bdb(`
      INSERT INTO book_pages(book_id, page, text, extraction_method, confidence, char_count)
      SELECT $1,
             (x->>'page')::int,
             COALESCE(x->>'text',''),
             COALESCE(NULLIF(x->>'method',''), 'embedded'),
             CASE WHEN x ? 'confidence' AND NULLIF(x->>'confidence','') IS NOT NULL
                  THEN (x->>'confidence')::real ELSE NULL END,
             length(COALESCE(x->>'text',''))
      FROM jsonb_array_elements($2::jsonb) AS x
      ON CONFLICT(book_id,page) DO UPDATE SET
        text=EXCLUDED.text,
        extraction_method=EXCLUDED.extraction_method,
        confidence=EXCLUDED.confidence,
        char_count=EXCLUDED.char_count
    `, [req.params.id, JSON.stringify(cleanPages)]);

    // KEEP_PDF=0: the exams only need the OCR text, so free the PDF space as soon as the text is saved.
    let pdfKept = true;
    if (String(process.env.KEEP_PDF ?? '1') === '0') {
      await bdb('DELETE FROM book_pdf_chunks WHERE book_id=$1', [req.params.id]);
      pdfKept = false;
    }

    const lowConfidencePages = cleanPages.filter(p =>
      p.method === 'ocr' && (Number(p.confidence || 0) < 45 || String(p.text || '').trim().length < 35)
    ).length;

    res.json({
      ok: true,
      id: req.params.id,
      pageCount: cleanPages.length,
      textChars: chars,
      bytes,
      pdfKept,
      ocrPages: cleanPages.filter(p => p.method === 'ocr').length,
      lowConfidencePages
    });
  } catch (e) {
    console.error('Upload finish:', e.message);
    res.status(500).json({ error: 'Buugga lama dhammeystirin.' });
  }
});

// PDF-yada waaweyn waxaa browser-ka loogu soo celinayaa qaybo, iyada oo aan la isku darin.
app.get('/api/books/:id/pdf', async (req, res) => {
  try {
    await dbReady;

    const r = await bdb(
      'SELECT filename, pdf FROM books WHERE id=$1',
      [req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: 'Buugga lama helin.' });
    }

    const chunks = await bdb(`
      SELECT chunk_index, data
      FROM book_pdf_chunks
      WHERE book_id=$1
      ORDER BY chunk_index
    `, [req.params.id]);

    const legacyPdf = r.rows[0].pdf;
    if (!chunks.rows.length && !(legacyPdf && legacyPdf.length)) {
      return res.status(404).json({ error: 'PDF-ga waa la tirtiray (qoraalka OCR ayaa weli la hayaa).' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(r.rows[0].filename || 'book.pdf').replace(/["\r\n]/g, '')}"`
    );

    if (chunks.rows.length) {
      for (const chunk of chunks.rows) {
        if (!res.write(chunk.data)) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
      return res.end();
    }

    return res.end(legacyPdf);
  } catch (e) {
    console.error('PDF download:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF-ga lama soo dejin.' });
    else res.destroy(e);
  }
});

app.get('/api/books/:id/text', async (req, res) => {
  try {
    await dbReady;
    const start = Math.max(1, Number(req.query.start) || 1);
    const end = Math.max(start, Number(req.query.end) || 100000);

    const r = await bdb('SELECT id, title, page_count, pages FROM books WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Buugga lama helin.' });
    const b = r.rows[0];

    const indexed = await bdb(`
      SELECT page, text, extraction_method AS method, confidence, char_count
      FROM book_pages
      WHERE book_id=$1 AND page BETWEEN $2 AND $3
      ORDER BY page
    `, [req.params.id, start, end]);

    // Old books uploaded before the indexed table existed are read from JSONB once;
    // their next successful upload/refresh will populate book_pages.
    const pages = indexed.rows.length
      ? indexed.rows.map(p => ({ page: p.page, text: p.text, method: p.method, confidence: p.confidence, charCount: p.char_count }))
      : (b.pages || []).filter(p => p.page >= start && p.page <= end);

    res.json({ id: b.id, title: b.title, pageCount: b.page_count, pages });
  } catch (e) {
    console.error('Book text retrieval:', e.message);
    res.status(500).json({ error: 'Qoraalka bogagga lama soo dejin.' });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    await dbReady;
    const r = await bdb('DELETE FROM books WHERE id=$1', [req.params.id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'Buugga lama tirtirin.' });
  }
});


// ───────────────────────── Storage management ─────────────────────────
async function sizeInfo(query) {
  const total = await query('SELECT pg_database_size(current_database())::bigint AS bytes');
  const tables = await query(`
    SELECT relname AS name, pg_total_relation_size(relid)::bigint AS bytes
    FROM pg_catalog.pg_statio_user_tables
    ORDER BY pg_total_relation_size(relid) DESC
  `);
  return { bytes: Number(total.rows[0].bytes), tables: tables.rows.map(r => ({ name: r.name, bytes: Number(r.bytes) })) };
}

app.get('/api/storage', async (req, res) => {
  try {
    await dbReady;
    const out = { split: splitDb, keepPdf: String(process.env.KEEP_PDF ?? '1') !== '0' };
    out.main = await sizeInfo(db);
    out.books = splitDb ? await sizeInfo(bdb) : out.main;
    const list = await bdb(`
      SELECT b.id, b.title, b.page_count, b.text_chars, b.created_at,
             COALESCE((SELECT SUM(octet_length(c.data)) FROM book_pdf_chunks c WHERE c.book_id = b.id), 0)::bigint AS pdf_bytes,
             COALESCE(octet_length(b.pdf), 0)::bigint AS legacy_pdf_bytes
      FROM books b
      ORDER BY b.created_at DESC
    `);
    out.bookList = list.rows.map(r => ({
      id: r.id, title: r.title, pageCount: r.page_count, textChars: r.text_chars, createdAt: r.created_at,
      pdfBytes: Number(r.pdf_bytes) + Number(r.legacy_pdf_bytes)
    }));
    out.legacyBooks = 0;
    if (splitDb) {
      try {
        const t = await db("SELECT to_regclass('public.books') AS t");
        if (t.rows[0].t) {
          const c = await db('SELECT COUNT(*)::int AS n FROM books');
          out.legacyBooks = c.rows[0].n;
        }
      } catch (_) { /* old tables not present */ }
    }
    res.json(out);
  } catch (e) {
    console.error('Storage info:', e.message);
    res.status(500).json({ error: 'Macluumaadka kaydka lama helin: ' + e.message });
  }
});

// Delete the PDF of ONE book (OCR text, pages and exams stay).
app.delete('/api/books/:id/pdf', async (req, res) => {
  try {
    await dbReady;
    const r = await bdb('DELETE FROM book_pdf_chunks WHERE book_id=$1', [req.params.id]);
    await bdb("UPDATE books SET pdf = ''::bytea WHERE id=$1 AND octet_length(pdf) > 0", [req.params.id]);
    let compacted = false;
    try { await bdb('VACUUM FULL book_pdf_chunks'); compacted = true; }
    catch (e) { console.warn('VACUUM FULL skipped:', e.message); }
    res.json({ ok: true, deletedChunks: r.rowCount, compacted });
  } catch (e) {
    console.error('Delete PDF:', e.message);
    res.status(500).json({ error: 'PDF-ga lama tirtirin: ' + e.message });
  }
});

// Delete the PDFs of ALL books at once. TRUNCATE gives the disk space back immediately.
app.post('/api/storage/purge-pdfs', async (req, res) => {
  try {
    await dbReady;
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Xaqiijin ayaa loo baahan yahay.' });
    const before = await sizeInfo(bdb);
    await bdb('TRUNCATE TABLE book_pdf_chunks');
    await bdb("UPDATE books SET pdf = ''::bytea WHERE octet_length(pdf) > 0");
    let compacted = false;
    try { await bdb('VACUUM FULL books'); compacted = true; }
    catch (e) { console.warn('VACUUM FULL skipped:', e.message); }
    const after = await sizeInfo(bdb);
    res.json({ ok: true, beforeBytes: before.bytes, afterBytes: after.bytes, compacted });
  } catch (e) {
    console.error('Purge PDFs:', e.message);
    res.status(500).json({ error: 'PDF-yada lama tirtirin: ' + e.message });
  }
});

// Move books (OCR text only, no PDF) from the old main database into the separate books database.
app.post('/api/storage/migrate-books', async (req, res) => {
  try {
    await dbReady;
    if (!splitDb) return res.status(400).json({ error: 'BOOKS_DATABASE_URL lama dejin; database labaad ma jiro.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Xaqiijin ayaa loo baahan yahay.' });
    const deleteOld = req.body?.deleteOld !== false;

    const t = await db("SELECT to_regclass('public.books') AS t");
    if (!t.rows[0].t) return res.json({ ok: true, migrated: 0, skipped: 0, note: 'Buugaag ma jiraan database-ka hore.' });

    const list = await db('SELECT id, title, subject, filename, page_count, pages, text_chars, created_at FROM books ORDER BY created_at');
    let migrated = 0, skipped = 0, failed = 0;
    for (const b of list.rows) {
      try {
        const exists = await bdb('SELECT 1 FROM books WHERE id=$1', [b.id]);
        const srcCount = (await db('SELECT COUNT(*)::int AS n FROM book_pages WHERE book_id=$1', [b.id])).rows[0].n;
        if (!exists.rows.length) {
          // Keep the legacy pages JSON only when the indexed page table has no rows for this book.
          const legacyPages = srcCount === 0 ? JSON.stringify(b.pages || []) : '[]';
          await bdb(
            'INSERT INTO books(id, title, subject, filename, page_count, pdf, pages, text_chars, created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
            [b.id, b.title, b.subject, b.filename, b.page_count, Buffer.alloc(0), legacyPages, b.text_chars, b.created_at]
          );
        } else {
          skipped++;
        }
        let offset = 0;
        for (;;) {
          const pg = await db(
            'SELECT page, text, extraction_method, confidence, char_count FROM book_pages WHERE book_id=$1 ORDER BY page LIMIT 200 OFFSET $2',
            [b.id, offset]
          );
          if (!pg.rows.length) break;
          await bdb(`
            INSERT INTO book_pages(book_id, page, text, extraction_method, confidence, char_count)
            SELECT $1, t.page, t.text, t.method, t.confidence, t.chars
            FROM unnest($2::int[], $3::text[], $4::text[], $5::real[], $6::int[]) AS t(page, text, method, confidence, chars)
            ON CONFLICT(book_id, page) DO NOTHING
          `, [
            b.id,
            pg.rows.map(r => r.page),
            pg.rows.map(r => r.text),
            pg.rows.map(r => r.extraction_method),
            pg.rows.map(r => r.confidence),
            pg.rows.map(r => r.char_count)
          ]);
          offset += pg.rows.length;
        }
        const dstCount = (await bdb('SELECT COUNT(*)::int AS n FROM book_pages WHERE book_id=$1', [b.id])).rows[0].n;
        if (dstCount !== srcCount) throw new Error(`Bogagga ma isle'eka: ${srcCount} vs ${dstCount}`);
        if (!exists.rows.length) migrated++;
      } catch (e) {
        failed++;
        console.error('Migrate book failed:', b.id, e.message);
      }
    }

    let oldCleared = false;
    if (deleteOld && failed === 0) {
      await db('TRUNCATE TABLE book_pdf_chunks, book_pages, books');
      oldCleared = true;
    }
    res.json({ ok: failed === 0, migrated, skipped, failed, oldCleared });
  } catch (e) {
    console.error('Migrate books:', e.message);
    res.status(500).json({ error: 'Wareejinta buugaagta way fashilantay: ' + e.message });
  }
});

// Kaydinta iyo soo saarista imtixaannada
app.post('/api/assessments', async (req, res) => {
  try {
    await dbReady;
    const p = req.body || {};
    const id = uid();

    await db(`
      INSERT INTO assessments(
        id,title,subject,klass,total_marks,duration,school,blueprint,data
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      id, p.title || 'Untitled Exam', p.subject || '', p.klass || '',
      p.totalMarks || 0, p.duration || '',
      p.school || 'GHDD',
      JSON.stringify(p.blueprint || {}),
      JSON.stringify(p.data || {})
    ]);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Imtixaanka lama kaydin.' });
  }
});

app.get('/api/assessments', async (req, res) => {
  try {
    await dbReady;
    const r = await db(
      `SELECT id,title,subject,klass,total_marks,duration,school,created_at,
              COALESCE(data->>'kind','exam') AS kind,
              CASE WHEN jsonb_typeof(data->'questions')='array' THEN jsonb_array_length(data->'questions') ELSE 0 END AS question_count
       FROM assessments ORDER BY created_at DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Imtixaannada lama soo dejin.' });
  }
});

app.delete('/api/assessments/:id', async (req, res) => {
  try {
    await dbReady;
    const r = await db('DELETE FROM assessments WHERE id=$1', [req.params.id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'Lama tirtirin.' });
  }
});

app.get('/api/assessments/:id', async (req, res) => {
  try {
    await dbReady;
    const r = await db('SELECT * FROM assessments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/question-bank', async (req, res) => {
  try {
    await dbReady;
    const q = req.body || {};
    const id = q.id || uid();

    await db(`
      INSERT INTO question_bank(
        id,subject,klass,unit,topic,lo,bloom,difficulty,type,marks,
        question,answer,options,source,status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(id) DO UPDATE SET
        question=EXCLUDED.question,
        answer=EXCLUDED.answer,
        options=EXCLUDED.options,
        status=EXCLUDED.status
    `, [
      id, q.subject || '', q.klass || '', q.unit || '', q.topic || '',
      q.learningOutcome || '', q.bloom || '', q.difficulty || '',
      q.type || '', q.marks || 1, q.question || '', q.answer || '',
      JSON.stringify(q.options || null), q.source || '', q.status || 'Approved'
    ]);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/question-bank', async (req, res) => {
  try {
    await dbReady;
    const r = await db(
      'SELECT * FROM question_bank ORDER BY created_at DESC LIMIT 300'
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function qualityCheck(q) {
  const issues = [];
  const text = String(q.question || q.text || '').trim();
  let score = 100;

  if (text.length < (q.type === 'MCQ' ? 8 : 15)) {
    issues.push('Question is too short');
    score -= 20;
  }

  if (!String(q.answer || '').trim()) {
    issues.push('Missing model answer');
    score -= 25;
  }

  if (q.type === 'MCQ') {
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length !== 4) {
      issues.push('MCQ should have four options');
      score -= 15;
    }
  }

  if (!blooms.includes(q.bloom)) {
    issues.push('Bloom level not recognized');
    score -= 5;
  }

  if (!String(q.objective || '').trim()) {
    issues.push('Question is not linked to a learning objective');
    score -= 10;
  }

  return {
    score: Math.max(0, score),
    status: score >= 90 ? 'Excellent' : score >= 75 ? 'Review recommended' : 'Needs revision',
    issues
  };
}

async function aiGenerate(p) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const targetLanguage = LANGUAGE_NAMES[normalizeLang(p.examLanguage)];
  const mathMode = isMathSubject(p.subject) || isMathSubject(p.className) || isMathSubject(p.sourceTitle);
  const buildPrompt = (count, partPlan, avoid = [], passageObj = null) => `
You are an expert secondary-school assessment designer and professional translator.
NON-NEGOTIABLE OUTPUT LANGUAGE: ${targetLanguage}. The user explicitly selected this language. The textbook may be in a different language; translate the educational content accurately into the selected output language. NEVER use the textbook language as the exam language unless it is the selected language. Do not mix English, Somali and Arabic.
LANGUAGE COVERAGE: Write every student-visible and teacher-visible text field in ${targetLanguage}: exam question text, all subquestions, all MCQ options, fill-in prompts and answers, matching items, matching descriptions/options, matching question instructions, topic names, section titles, answer key, marking guide, explanations, diagram labels, and any generated captions. Translate generic labels such as “Answer”, “Question”, “Column A/B”, “Instructions”, “Correct answer”, and “Marking guide”. Keep only standard scientific symbols, equations, SI unit symbols, proper names, and abbreviations that should not be translated. If source facts are technical terms, use the correct equivalent in the selected language; a short parenthetical original term may be used only when necessary for scientific clarity.
NO SOURCE CITATIONS IN QUESTIONS (MANDATORY): the student paper must simply ASK the question. Never write a page number, a page range, a lesson/unit/book reference or any phrase that cites the source inside question, options, matching items or answers. Forbidden examples: \"Bogga 5aad ...\", \"Sida ku xusan bogga 12...\", \"Su’aasha bogga 5aad\", \"(p. 7)\", \"According to page 5\", \"Sida buugga ku qoran\", \"As stated in the textbook\", \"في الصفحة 5\", \"حسب الكتاب\". The [PAGE n] markers in the source text are ONLY for filling the \\\"sourcePages\\\" field; they must never be copied into any other field. Write each question as a direct, self-contained question (the only allowed reference is to the reading passage in passage mode, e.g. \\\"sheekada\\\").${mathMode ? `
MATHEMATICS WRITING RULES (MANDATORY, this is a mathematics exam): write every number, expression, equation, unit, term and problem EXACTLY the way the textbook writes it (same notation, same order, same wording style, same number format); use the textbook's examples as the model. Use plain readable text only: digits, letters, + − × ÷ = < > ≤ ≥ ≠ ≈ ( ) [ ] { } / √ π ° % and Unicode superscripts/subscripts (x², x³, a₁). Write fractions as a/b with plain digits (the paper turns them into stacked fractions), roots as √ followed by the number or the bracketed expression (√16, √(x+1), ∛27), powers with Unicode superscripts (x², 10³) and degrees with ° (45°, ∠ABC = 60°); use × and ÷ (never * or x for multiplication), π, ≤ ≥ ≠ ≈ ± exactly as printed exam papers do. Never write the words sqrt, pi, degrees, square root or ^. NEVER use LaTeX or code notation (no $ signs, no backslashes, no \\\\frac, \\\\sqrt, \\\\times, no ^ or _ or curly-brace commands), no markdown (no *, **, #, backticks), no emoji, no decorative arrows/bullets, no unnecessary symbols, brackets, units or repeated punctuation. Do not add symbols that the textbook does not use. Keep each problem short and clear, giving only the data needed. Compute every answer carefully and verify it twice before returning: an MCQ has exactly one correct option with plausible numeric distractors; in the answer key give the final answer first, then the short working in plain text, one step per line.` : ''}
Create exactly ${count} questions using ONLY facts and concepts supported by the supplied source text. Translate supported source content into the selected language; do not invent facts or repeat questions.
${passageInstructions(p, passageObj, targetLanguage)}
OBJECTIVE-FIRST DESIGN (MOST IMPORTANT RULE): the learning objectives (learningOutcomes) in the blueprint below are exactly what this exam must measure. Before writing each question, choose ONE objective from the blueprint topic it belongs to, then write a question that directly measures that objective. The action verb of the objective decides what the student must do (define/state → recall; identify/classify → recognise; explain/describe → explanation; calculate/solve → computation; compare/analyse → comparison or analysis; justify/evaluate → reasoned judgement). Copy the chosen objective text, in ${targetLanguage}, into the question's \"objective\" field. Rules: (1) every question maps to exactly one objective; (2) spread questions across as many DIFFERENT objectives as the question count allows, and do not assess an objective a second time until every objective of that topic has been assessed once; (3) do not write questions on trivia, side facts, dates or examples unless an objective requires them; (4) the question must be answerable from the source text and must not test anything outside its objective; (5) if the blueprint has no objectives, first derive measurable objectives from the source text and use them the same way.
Use Bloom levels: ${JSON.stringify(p.levels || blooms)}. Choose each question's \"bloom\" value so it matches the objective's action verb; keep it ONLY in the JSON \"bloom\" field. BLOOM CONFIDENTIALITY: never write the word Bloom or any cognitive-level label or tag (Remember, Understand, Apply, Analyze, Evaluate, Create, or their translations) in question text, options, matching items, topics, section titles, instructions, answers or marking guides. The student must never be able to see the cognitive level.
Required ordered section plan: ${JSON.stringify(partPlan || [])}. Follow the exact section order and counts; translate every displayed section title into ${targetLanguage}.
AI-GENERATED TOPIC BLUEPRINT (use for coverage only; translate all displayed topics/outcomes into ${targetLanguage}): ${JSON.stringify(p.blueprint || {})}. Distribute questions across the blueprint topics and source pages; preserve marks and question counts per topic as closely as possible.${avoid.length ? `\nALREADY WRITTEN (continue the exam from the next question; do NOT repeat or paraphrase these, and prefer learning objectives not used yet): ${JSON.stringify(avoid)}` : ''}
SOURCE DISTRIBUTION RULE: ${p.sourceSelectionRule || 'Spread questions across different headings/topics; do not take consecutive questions from the same paragraph or heading. Prefer passages separated by at least two headings or at least one full page.'}
Do not create consecutive questions from the same paragraph or heading. Spread questions across the selected page range and distinct topics. Every question must include sourcePages and topic/heading. topic/heading text must be in ${targetLanguage}; sourcePages may use page numbers.
MCQ: exactly four options A, B, C, D and one correct answer. Translate the option wording into ${targetLanguage}; retain the option letters A-D for answer selection.
Fill in the Blanks (NATIONAL-EXAM WORD-BOX STYLE, MANDATORY): the paper shows a WORD BANK (one word per item, exactly as many words as items) above the items and the student writes the correct word from the box into the blank. So every Fill in the Blank question must be a short, complete statement (a definition, a key term, a rule, a fact, a sentence from the topic) with EXACTLY ONE blank written as ________ (eight underscores); the blank may sit in the middle of the sentence (for example My dog ________ short because she was very shy.). The \"answer\" field contains ONLY the missing word or short term (1 to 3 words, no sentence, no letter label), taken from the source text, so it fits the blank both in meaning and in grammar. Style models: \"________ waa qaybta yar ee nolosha ee dhisa unugga.\" / \"The process by which plants make food is called ________.\" / \"A triangle with three equal sides is called ________ triangle.\" Vary the forms (definition, concept, process, comparison, example); never leave the blank at a place that makes the answer guessable from grammar alone; the answers of one section must all be different words. Leave \"options\" empty for this type. Write everything in ${targetLanguage}.
Matching: create each matching question as ONE table group, not one separate mini-question per row. Return matches as [{"question":"item/term for Column A in selected language","answer":"exact matching Column B option text in selected language"}]. options must list all correct answers plus exactly ONE plausible extra distractor (so 5 items in Column A require 6 options A-F). All item and option text must be in ${targetLanguage}. On the student paper, render one four-column table: localized number; Column A item; blank for answer letter; Column B options/descriptions. Put the complete A, B, C, D, E, F option list together in the rightmost Column B cell spanning all rows. Students write only the option letter in Column 3. Never reveal correct letters or answers in the student paper.
Structured/direct questions: include clear subparts in ${targetLanguage} and a teacher-only model answer/marking guide in ${targetLanguage}. The student paper must show no solutions or model answers.
DIAGRAM RULE: Requested number of diagrams is ${Number(p.diagramCount || 0)}. Create exactly this number of diagrams across Structured questions. If it is 0, every diagram and diagramSvg field must be empty. If greater than 0, create actual, visible, accurate SVG diagrams in diagramSvg—not instructions, not placeholders, and never the word "undefined". Use a standalone SVG in the style of the NATIONAL EXAMINATIONS (see DIAGRAM STYLE rules below), all visible labels in ${targetLanguage}. No scripts, external links, images, foreignObject, markers or CSS imports. The question text must refer to the diagram in the exam way (for example \"Eeg jaantuska hoose\" / \"Study the diagram below\" / \"ادرس الشكل أدناه\") and ask something that can be answered by looking at it (label the parts, name the part marked X, read a value, find an angle or length). Diagrams must be based only on supplied source content and relevant to the question.
FINAL LANGUAGE CHECK BEFORE RETURNING: review every string that could appear on either paper. Rewrite any stray phrase in another language into ${targetLanguage}. JSON keys may remain English for the app, but their values must follow the language rules above. Return valid JSON only.
Return JSON only:
{"questions":[{"question":"","answer":"","distractor":"","type":"","section":"","options":[],"matches":[{"question":"","answer":""}],"diagram":"","diagramSvg":"","objective":"","bloom":"","difficulty":"","marks":1,"topic":"","sourcePages":""}]}
Subject: ${p.subject || ''}
Class: ${p.className || p.klass || ''}
Source title: ${p.sourceTitle || ''}
Page range: ${JSON.stringify(p.pageRange || {})}
Source text (content reference only; not the output language):
${String(p.sourceText || p.text || '').slice(0, 70000)}
`;

  let passage = null;
  if (p.passage) {
    passage = await generatePassage(p, targetLanguage);
    await enforcePassageLanguage(passage, p.examLanguage);
    passage.anchors = validAnchors(passage.anchors, passage.text);
  }
  const firstBatch = await requestQuestionBatch(buildPrompt(p.count, p.partPlan || [], [], passage));
  let questions = firstBatch.questions;
  // If the answer was cut short (long Somali/Arabic exams), ask for ONLY the missing questions and continue.
  for (let round = 0; questions.length < p.count && round < 3; round++) {
    const missing = p.count - questions.length;
    const avoid = questions.map(q => ({ question: String(q.question || '').slice(0, 140), objective: String(q.objective || '').slice(0, 140) }));
    try {
      const extra = await requestQuestionBatch(buildPrompt(missing, remainingPlan(p.partPlan, questions.length), avoid, passage));
      questions = questions.concat(extra.questions.slice(0, missing));
    } catch (e) { console.warn('Top-up batch failed:', e.message); break; }
  }
  // Bloom is teacher-only: strip any leaked label, then make sure the whole paper is in the selected language.
  questions.forEach(stripBloomFromQuestion);
  if (p.passage) {
    if (!passage?.text) throw new Error('AI did not return a reading passage. Try again.');
    passage.text = stripBloomLabels(passage.text);
    passage.title = stripBloomLabels(passage.title);
    await enforcePassageLanguage(passage, p.examLanguage);
  }
  const languageReport = await enforceQuestionLanguage(questions, p.examLanguage);
  const passageCheck = await enforcePassageGrounding(questions, passage, p, targetLanguage);
  const requestedDiagrams = Math.max(0, Math.min(30, Number(p.diagramCount || 0)));
  // Never expose "undefined" or text-only placeholders as diagrams.
  for (const q of questions) {
    if (typeof q.diagram !== 'string' || q.diagram.trim().toLowerCase() === 'undefined') q.diagram = '';
    if (typeof q.diagramSvg !== 'string' || !/<svg\\b/i.test(q.diagramSvg)) q.diagramSvg = '';
  }
  if (requestedDiagrams > 0) {
    const candidates = questions.filter(q => /structured|direct/i.test(String(q.type || '')) || /STRUCTURED|DIRECT/i.test(String(q.section || '')));
    if (candidates.length < requestedDiagrams) {
      throw new Error(`The exam plan has only ${candidates.length} structured questions, but ${requestedDiagrams} diagrams were requested. Increase question count or reduce diagrams.`);
    }
    let made = 0;
    for (const q of candidates) {
      if (made >= requestedDiagrams) break;
      if (!q.diagramSvg) q.diagramSvg = await aiGenerateDiagram(p, q, made + 1);
      q.diagram = '';
      made++;
    }
    // Remove any unrequested diagrams that the main response added.
    let kept = 0;
    for (const q of questions) {
      if (q.diagramSvg) {
        kept++;
        if (kept > requestedDiagrams) { q.diagramSvg = ''; q.diagram = ''; }
      }
    }
  } else {
    for (const q of questions) { q.diagramSvg = ''; q.diagram = ''; }
  }
  // Final clean-up of everything the student reads: no source citations; plain textbook-style notation in mathematics.
  questions.forEach(q => {
    stripCitationsFromQuestion(q);
    if (mathMode) mapQuestionText(q, cleanMathText);
  });
  if (p.passage && passage) passage.text = stripSourceCitations(passage.text);
  questions.languageReport = languageReport;
  questions.passageCheck = passageCheck;
  questions.passage = p.passage ? passage : null;
  return questions;
}


const DIAGRAM_STYLE_RULES = `DIAGRAM STYLE (copy the look of printed NATIONAL EXAMINATION papers, black on white):
- Canvas: viewBox="0 0 640 320", width="100%", height="auto", background white (<rect width="640" height="320" fill="#ffffff"/>). Leave a 20 px margin; nothing may touch or cross the edge; no text may overlap a line or another label.
- Colours: black strokes (#000) with white or very light pastel fills only. No saturated colours, no gradients, no shadows, no border around the whole drawing.
- Lines: stroke-width 1.6 for the main outline, 1 for construction/dimension/leader lines; fill="none" for outlines; dashed lines (stroke-dasharray="5,4") only for hidden or auxiliary lines.
- Text: font-family="Arial, Helvetica, sans-serif", font-size 16 for labels, never smaller than 14 and never overlapping lines or other text, text-anchor set correctly, fill="#000".
- LABEL-THE-PARTS questions (sample style): when the question asks the student to label/name parts, draw EMPTY white rectangular answer boxes (about 100 x 32, stroke #000, stroke-width 1.4) placed around the drawing, each joined to its part by a straight arrow whose tip ends exactly on the part (arrow head = small filled <polygon>). Boxes stay empty (no text inside), are the same size, never overlap the drawing or each other, and their number equals the number of parts asked.
- The drawing itself may use soft light fills (#f4d6d6, #fde9c8, #dfe9f5) with a thin black outline so parts are easy to tell apart; boxes, arrows and text stay black.
- Labelling: label parts with capital letters A, B, C, ... (or P, Q, R / X, Y) placed beside the part, joined by a thin straight leader line when the part is inside a shape. If the question asks the student to NAME the parts, draw only the letter (or a number) on the diagram and NEVER write the part name; put a short empty answer line only if the question needs it. Write names on the drawing only when the question does not ask for them.
- Geometry: draw to scale; mark right angles with a small square, equal sides/angles with tick marks, parallel lines with arrow ticks, angles with small arcs and the given values (45°, 60°), lengths with their numbers and units on the side. Vertices are labelled with capital letters outside the shape. Graphs/number lines: straight axes with arrow heads drawn as small filled triangles, evenly spaced scale marks with numbers, plotted points as small filled circles.
- Science/biology/geography: clean outline drawing with straight leader lines ending exactly on the part; flows and forces as lines with arrow heads drawn as small filled <polygon> triangles (never <marker>).
- Tables/circuits/charts: simple, aligned, with ruler-straight lines.
- Never use <image>, <use>, <marker>, <foreignObject>, <script>, url(...), external links, filters or CSS imports. Use only <rect>, <line>, <polyline>, <polygon>, <circle>, <ellipse>, <path>, <text>, <g>.`;

function extractSvg(raw) {
  const m = String(raw || '').match(/<svg\b[\s\S]*?<\/svg>/i);
  if (!m) return '';
  let svg = m[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(?:foreignObject|iframe|object|embed|image|use|marker)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s?marker-(?:start|mid|end)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none');
  if (!/viewBox\s*=/i.test(svg)) svg = svg.replace(/<svg\b/i, '<svg viewBox="0 0 640 320"');
  if (!/xmlns\s*=/i.test(svg)) svg = svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}
// Cheap structural check: balanced tags and enough drawing content, so broken/truncated SVG is retried instead of shown.
function svgLooksValid(svg) {
  if (!svg || svg.length < 200) return false;
  const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<\/?([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(stripped))) {
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) { if (stack.pop() !== tag) return false; }
    else if (m[2] !== '/') stack.push(tag);
  }
  if (stack.length) return false;
  const shapes = (stripped.match(/<(?:line|polyline|polygon|circle|ellipse|path|rect)\b/gi) || []).length;
  return shapes >= 3;
}

async function aiGenerateDiagram(p, question, index) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing; cannot create requested diagrams.');
  const lang = p.examLanguage === 'ar' ? 'Arabic' : p.examLanguage === 'so' ? 'Somali' : 'English';
  const models = await getGeminiModels();
  const prompt = `You are an exam illustrator who draws the diagrams printed in national examination papers.
TASK: draw ONE exam-ready diagram for the question below, then output it as SVG. Think first about exactly what has to be drawn (shape, parts, values) so that the diagram matches the question precisely: every letter, length, angle or value mentioned in the question must be visible in the drawing, and nothing in the drawing may contradict the question. Use only information supported by the source text; if the source gives no exact detail, draw a clearly schematic version and do not invent facts.
All visible words in the diagram are in ${lang}; letters, numbers and symbols stay as they are.
${DIAGRAM_STYLE_RULES}
QUESTION: ${String(question.question || question.text || '')}
MODEL ANSWER (for your reference only; never write the answer on the diagram): ${String(question.answer || '').slice(0, 400)}
TOPIC: ${String(question.topic || '')}
SOURCE PAGES: ${String(question.sourcePages || '')}
SOURCE TEXT: ${String(p.sourceText || '').slice(0, 16000)}
OUTPUT: ONLY the single <svg>...</svg> element, complete and closed, no markdown fences, no explanation.`;
  let lastError = '';
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: attempt ? 0.3 : 0.15, maxOutputTokens: 10000 }
          })
        });
        const data = await response.json();
        if (!response.ok) { lastError = data?.error?.message || 'Diagram generation request failed.'; if ([429, 500, 502, 503, 504].includes(response.status)) continue; break; }
        const raw = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
        const svg = extractSvg(raw);
        if (svgLooksValid(svg)) return svg;
        lastError = `AI did not return a complete SVG for diagram ${index}.`;
      } catch (e) { lastError = e.message; }
    }
  }
  throw new Error(lastError || `Diagram ${index} could not be created.`);
}

app.post('/api/blueprint', async (req, res) => {
  try {
    const p = req.body || {};
    const sourceText = String(p.sourceText || '').trim();
    if (!sourceText) return res.status(400).json({error:'Qoraalka OCR ee buugga ayaa loo baahan yahay.'});
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({error:'GEMINI_API_KEY laguma dejin Railway.'});
    const totalMarks = Math.max(10, Math.min(300, Number(p.totalMarks) || 100));
    const defaultCount = Math.min(50, Math.max(10, Math.round(totalMarks * 0.44)));
    const totalQuestions = Math.max(4, Math.min(50, Number(p.count || p.questionCount) || defaultCount));
    const lang = p.examLanguage || 'en';
    const languageName = lang === 'so' ? 'Somali (Af-Soomaali)' : lang === 'ar' ? 'Arabic (العربية)' : 'English';
    const prompt = `You are an expert secondary-school assessment designer. Create an EXAM BLUEPRINT / TABLE OF SPECIFICATIONS before the questions are generated. Use ONLY topics, headings, facts and learning outcomes supported by the supplied OCR text. Do not invent units or learning outcomes.\nMANDATORY OUTPUT LANGUAGE: ${languageName}. Translate all displayed blueprint fields including unit, topic, learning outcomes, notes and section names into this language, even when the OCR source uses another language. Do not mix languages; only JSON keys and scientific symbols may remain unchanged. Subject: ${p.subject || ''}. Class: ${p.className || ''}. Source book: ${p.sourceTitle || ''}. Selected pages: ${JSON.stringify(p.pageRange || {})}. Total marks: ${totalMarks}. Total questions: ${totalQuestions}. Format: ${p.format || 'four-part'}.\n${p.passage ? `PASSAGE-BASED LANGUAGE EXAM: this exam will begin with an original reading passage built from the curriculum, and every question will be answered through that passage. Write the learningOutcomes as language-skill objectives taken from the CURRICULUM text itself (grammar/naxwaha and sentence structure, vocabulary and word meaning, synonyms and antonyms, plurals and word forms, rhetoric and style, spelling and punctuation) so each can be tested through a passage; reading comprehension (main idea, details, inference) may take at most 30% of the objectives.\n` : ''}OBJECTIVE-FIRST BLUEPRINT (MOST IMPORTANT): the blueprint is built around learning objectives. If the source text itself states objectives (for example headings such as Objectives, Learning outcomes, Learning objectives, \"By the end of this unit/lesson students should be able to\", \"After studying this chapter you should...\"), use those objectives first and translate them faithfully into ${languageName}. Otherwise derive 2 to 5 measurable objectives per topic from the headings and content that are really present. Each objective is ONE testable statement that starts with an observable action verb (define, state, identify, describe, explain, calculate, compare, classify, interpret, justify...) and can be answered from the supplied source text. learningOutcomes must contain only such objectives, never vague aims like \"understand the topic\". Give every topic a questionCount big enough to assess its objectives (at least one question per objective when the total number of questions allows). The Bloom distribution of a topic must follow the action verbs of its objectives. Bloom levels are teacher-only information inside this blueprint and must never appear in student-facing text.\nUse Bloom levels ${JSON.stringify(p.levels || blooms)}. Spread topics across distinct headings and pages; do not base adjacent questions on the same paragraph. Determine topic/unit, measurable learning outcomes, source pages, Bloom distribution, planned question count and marks per topic. Counts must add to exactly ${totalQuestions}; marks must add to exactly ${totalMarks}. Section counts should match this section plan: ${JSON.stringify(p.partPlan || [])}. Return valid JSON only. Set the language field to exactly English, Somali, or Arabic according to the selected language. Schema: {"subject":"","language":"","totalMarks":${totalMarks},"totalQuestions":${totalQuestions},"coverage":[{"unit":"","topic":"","learningOutcomes":[""],"sourcePages":"","bloomDistribution":{"Remember":0,"Understand":0,"Apply":0,"Analyze":0,"Evaluate":0,"Create":0},"questionCount":0,"marks":0}],"sectionDistribution":[{"section":"","questionCount":0,"marks":0}],"qualityRules":["source traceability","no duplicate questions","marks sum exactly","Bloom alignment"],"notes":[]}.\nOCR SOURCE TEXT:\n${sourceText.slice(0,70000)}`;

    const models = await getGeminiModels();
    let blueprint = null, lastError = '';
    for (const model of models) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method:'POST', headers:{'content-type':'application/json','x-goog-api-key':key},
          body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.15,maxOutputTokens:9000}})
        });
        const data = await r.json();
        if (!r.ok) { lastError = data?.error?.message || `AI request failed (${r.status})`; if ([429,500,502,503,504].includes(r.status)) continue; throw new Error(lastError); }
        const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').replace(/^```json|```$/g,'').trim();
        blueprint=JSON.parse(raw); break;
      } catch (e) { lastError=e.message; }
    }
    if (!blueprint) throw new Error(lastError || 'AI Blueprint lama helin.');
    if (!Array.isArray(blueprint.coverage) || !blueprint.coverage.length) throw new Error('AI-gu ma aqoonsan mawduucyo ku filan qoraalka OCR.');

    // Reconcile AI rounding so displayed Blueprint totals always equal the selected exam totals.
    const distribute = (field, target) => {
      const rows=blueprint.coverage;
      const weights=rows.map(x=>Math.max(0,Number(x[field])||0));
      const sum=weights.reduce((a,b)=>a+b,0) || rows.length;
      let used=0;
      rows.forEach((row,i)=>{
        const weight=weights[i] || (sum===rows.length?1:0);
        let value=i===rows.length-1 ? target-used : Math.floor(target*weight/sum);
        if (target>=rows.length) value=Math.max(1,value);
        row[field]=Math.max(0,value); used+=row[field];
      });
      if (used!==target) rows[rows.length-1][field]=Math.max(0,Number(rows[rows.length-1][field]||0)+(target-used));
    };
    distribute('questionCount',totalQuestions);
    distribute('marks',totalMarks);
    blueprint.coverage.forEach(row => normalizeBloomRow(row, Array.isArray(p.levels) ? p.levels : blooms));
    blueprint.totalMarks=totalMarks;
    blueprint.totalQuestions=totalQuestions;
    blueprint.subject=blueprint.subject||p.subject||'';
    blueprint.language=LANGUAGE_LABELS[normalizeLang(lang)];
    blueprint.qualityRules=QUALITY_RULES[normalizeLang(lang)];
    blueprint.coverage.forEach(row => {
      row.learningOutcomes = (Array.isArray(row.learningOutcomes) ? row.learningOutcomes : [])
        .map(o => typeof o === 'string' ? o : (o?.text || o?.objective || ''))
        .map(o => stripBloomLabels(String(o)).trim()).filter(Boolean);
    });
    await enforceBlueprintLanguage(blueprint, lang);
    if (Array.isArray(p.partPlan) && p.partPlan.length) {
      blueprint.sectionDistribution=p.partPlan.map(x=>({section:x.section,type:x.type,questionCount:Number(x.count)||0,marks:Number(x.targetMarks)||0}));
    }
    const marksSum=blueprint.coverage.reduce((n,x)=>n+Number(x.marks||0),0);
    const countSum=blueprint.coverage.reduce((n,x)=>n+Number(x.questionCount||0),0);
    res.json({ok:true,blueprint,validation:{marksSum,countSum,marksMatch:marksSum===totalMarks,questionsMatch:countSum===totalQuestions}});
  } catch(e) {
    console.error('AI Blueprint failed:',e.message);
    res.status(502).json({error:'AI Blueprint lama samayn: '+e.message});
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const p = req.body || {};
    if (!String(p.sourceText || '').trim()) {
      return res.status(400).json({ error: 'Source text is required.' });
    }

    const count = Math.min(50, Math.max(1, Number(p.count || p.questionCount || 10)));
    const levels = Array.isArray(p.levels) && p.levels.length ? p.levels : blooms;
    let questions = [];
    let languageReport = null;
    let passage = null;

    try {
      const generated = await aiGenerate({ ...p, count, levels, partPlan: Array.isArray(p.partPlan) ? p.partPlan : [] });
      if (Array.isArray(generated)) { languageReport = generated.languageReport || null; passage = generated.passage || null; questions = generated.slice(0, count); }
    } catch (e) {
      console.error('AI generation failed:', e.message);
      return res.status(502).json({
        error: 'AI-gu ma samayn su’aalaha: ' + e.message
      });
    }

    if (!questions.length) {
      return res.status(503).json({
        error: 'AI lama heli karo. Hubi in GEMINI_API_KEY lagu dejiyey Railway.'
      });
    }

    questions = questions.map((q, i) => ({
      ...q,
      id: q.id || uid(),
      question: q.question || q.text || '',
      answer: q.answer || q.modelAnswer || '',
      section: q.section || '',
      type: q.type || '',
      options: Array.isArray(q.options) ? q.options : [],
      matches: Array.isArray(q.matches) ? q.matches : [],
      diagram: q.diagram || '',
      marks: Number(q.marks) || 1,
      status: 'Draft'
    }));

    // Snap each question to a blueprint objective, then score quality (objective link is part of the score).
    const objectiveCoverage = linkQuestionsToObjectives(questions, p.blueprint);
    questions = questions.map(q => ({ ...q, quality: qualityCheck(q) }));

    res.json({
      questions,
      totalMarks: questions.reduce((s, q) => s + Number(q.marks || 0), 0),
      objectiveCoverage,
      passage,
      languageCheck: languageReport || { fixed: 0, remaining: 0 },
      aiUsed: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/quality-check', (req, res) => {
  const questions = Array.isArray(req.body?.questions) ? req.body.questions : [];
  const checked = questions.map(q => ({ ...q, quality: qualityCheck(q) }));
  const average = checked.length
    ? Math.round(checked.reduce((s, q) => s + q.quality.score, 0) / checked.length)
    : 0;

  res.json({
    questions: checked,
    average,
    status: average >= 90 ? 'Excellent' : average >= 75 ? 'Review recommended' : 'Needs revision'
  });
});

app.post('/api/item-analysis', (req, res) => {
  const { students = [], questions = [] } = req.body || {};
  const items = questions.map((q, index) => {
    const values = students.map(s => Number(s.answers?.[index]) === 1 ? 1 : 0);
    const p = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return {
      number: index + 1,
      question: q.question,
      difficultyIndex: Math.round(p * 100),
      recommendation: p > 0.9 ? 'Too easy' : p < 0.25 ? 'Too difficult' : 'Review'
    };
  });

  res.json({
    items,
    summary: { totalQuestions: items.length }
  });
});


app.post('/api/lesson-plan/generate', async (req, res) => {
  try {
    const p = req.body || {};
    const schemeText = String(p.schemeText || '').trim();
    const textbookText = String(p.textbookText || '').trim();
    if (!schemeText || schemeText.length < 80) return res.status(400).json({ error: 'Fadlan soo qaado Scheme of Work OCR oo dhammaystiran; isagaa go’aaminaya kala-horraynta casharrada sannadka.' });
    if (!textbookText || textbookText.length < 80) return res.status(400).json({ error: 'Fadlan soo qaado qoraalka buugga maaddada OCR; isagaa laga diyaarinayaa objectives, sharaxaadda iyo Lesson Note.' });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY laguma dejin Railway.' });

    const language = String(p.language || 'auto');
    const subject = String(p.subject || 'Not specified');
    const className = String(p.className || 'Not specified');
    const teacherName = String(p.teacherName || '');
    const academicYear = String(p.academicYear || '2026-2027');
    const lessonDuration = Math.min(180, Math.max(20, Number(p.lessonDuration || 40)));
    const lessonsPerWeek = Math.min(10, Math.max(1, Number(p.lessonsPerWeek || 3)));
    const termCount = Math.min(4, Math.max(1, Number(p.termCount || 3)));
    const modelCandidates = await getGeminiModels();
    const langInstruction = language === 'auto'
      ? 'Detect the dominant language of the scheme of work and use that same language consistently for all lesson-plan and lesson-note content. Do not mix languages.'
      : `Write all generated material in ${language === 'so' ? 'Somali' : language === 'ar' ? 'Arabic' : 'English'} only. Do not mix languages.`;

    const prompt = `
You are an experienced secondary-school teacher and lesson-planning specialist. You have TWO distinct source documents and MUST NOT confuse their roles.
SOURCE A — SCHEME OF WORK: The sole authority for the yearly curriculum sequence, topic order, unit, term, week, coverage and lesson scheduling. Follow its order exactly. Do not move topics around or add topics that are not in it.
SOURCE B — OCR TEXTBOOK: The source for subject-matter explanations, lesson-specific learning objectives, key facts, definitions, examples, activities, worked examples where present, summaries and Lesson Notes. Use this textbook to develop the teaching content for each Scheme of Work topic. Match textbook material to the relevant Scheme of Work topic. Do not pretend that material is in the textbook if the OCR text does not support it; flag missing or unreadable content in assumptions.
LANGUAGE: ${langInstruction}
Create a complete lesson-planning package for academic year ${academicYear}.
School lesson-plan template to follow:
- Teacher name, class, subject, date, day, unit, lesson title, lesson duration, lesson/session number.
- Introduction.
- Lesson objectives beginning "By the end of the lesson, learners should be able to..." with observable verbs.
- Teaching methods.
- Learning aids/resources.
- Evaluation questions.
- Time management table totaling exactly ${lessonDuration} minutes (opening/previous-lesson review, attendance or settling, explanation/activity, evaluation/homework). Do not include impossible or negative time values.
- Lesson Note following the lesson plan, including the lesson title, short explanatory summary, headings/key points, examples or activities where the scheme supports them, and a concise final summary.
Requirements:
1. Plan every topic/lesson stated in the Scheme of Work across the year, keeping its order and term/week sequence. Do not skip units.
2. Use ${lessonsPerWeek} lesson sessions per week and ${lessonDuration} minutes per session unless the Scheme of Work specifies otherwise.
3. Split large topics across appropriate sessions; do not repeat identical objectives or notes.
4. Include a short, usable lesson note summary for EVERY lesson plan and align the note directly with that lesson's objectives.
5. Each session needs: week, term, unit, lessonNumber, lessonTitle, date (blank if not stated in scheme), durationMinutes, introduction, objectives (array), teachingMethods (array), learningAids (array), evaluationQuestions (array), timeManagement (array of {stage, minutes}, sum exactly ${lessonDuration}), noteSummary, noteHeadings (array of {heading, content}), homework, sourceTopic.
6. Avoid claiming that dates are fixed if the scheme gives no dates. Provide week/term placement and leave date blank when unavailable.
7. Provide a brief yearly overview and any scheme gaps/assumptions separately; do not change the scheme sequence. Term count: ${termCount}.
8. Keep the content practical, classroom-ready, and aligned to the supplied sample template. The sample lesson plan is a formatting model, not a source for subject facts.
9. Respond with valid JSON only, no markdown, no text outside JSON.
JSON shape:
{"academicYear":"${academicYear}","subject":"${subject}","className":"${className}","teacherName":"${teacherName}","language":"...","yearOverview":"...","assumptions":["..."],"lessons":[{"term":1,"week":1,"unit":"...","lessonNumber":1,"lessonTitle":"...","date":"","durationMinutes":${lessonDuration},"introduction":"...","objectives":["..."],"teachingMethods":["..."],"learningAids":["..."],"evaluationQuestions":["..."],"timeManagement":[{"stage":"...","minutes":5}],"noteSummary":"...","noteHeadings":[{"heading":"...","content":"..."}],"homework":"...","sourceTopic":"..."}]}
SCHEME OF WORK — SOURCE OF TRUTH FOR SEQUENCE, TERM, WEEK AND TOPIC ORDER:
${schemeText.slice(0, 30000)}

OCR TEXTBOOK — SOURCE FOR OBJECTIVES, TEACHING CONTENT, EXPLANATIONS, EXAMPLES, SUMMARIES AND LESSON NOTES:
${textbookText.slice(0, 55000)}
`;
    let lastError = 'AI generation failed';
    for (const model of modelCandidates) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 16000 }
          })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          lastError = data?.error?.message || `AI service returned ${r.status}`;
          if ([404, 429, 500, 502, 503].includes(r.status) || /no longer available|not found|not supported/i.test(lastError)) continue;
          return res.status(502).json({ error: `AI: ${lastError}` });
        }
        const raw = data?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
        if (!raw.trim()) { lastError = 'AI jawaab madhan ayuu soo celiyey.'; continue; }
        let parsed;
        try { parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim()); }
        catch (_) { lastError = 'Jawaabta AI ma ahayn JSON dhammaystiran. Isku day Scheme of Work ka gaaban.'; continue; }
        if (!Array.isArray(parsed.lessons) || !parsed.lessons.length) { lastError = 'AI ma soo saarin casharro qorshaysan.'; continue; }
        parsed.lessons = parsed.lessons.map((l, i) => {
          const tm = Array.isArray(l.timeManagement) ? l.timeManagement : [];
          const sum = tm.reduce((n, t) => n + Number(t.minutes || 0), 0);
          if (!tm.length || sum !== lessonDuration) {
            l.timeManagement = [
              { stage: 'Review / introduction', minutes: 5 },
              { stage: 'Attendance / settling', minutes: 3 },
              { stage: 'Teaching and learning activities', minutes: lessonDuration - 10 },
              { stage: 'Evaluation and homework', minutes: 2 }
            ];
          }
          l.lessonNumber = Number(l.lessonNumber || i + 1);
          l.durationMinutes = lessonDuration;
          l.objectives = Array.isArray(l.objectives) ? l.objectives : [];
          l.teachingMethods = Array.isArray(l.teachingMethods) ? l.teachingMethods : [];
          l.learningAids = Array.isArray(l.learningAids) ? l.learningAids : [];
          l.evaluationQuestions = Array.isArray(l.evaluationQuestions) ? l.evaluationQuestions : [];
          l.noteHeadings = Array.isArray(l.noteHeadings) ? l.noteHeadings : [];
          return l;
        });
        return res.json(parsed);
      } catch (e) {
        lastError = e.message || String(e);
      }
    }
    return res.status(502).json({ error: `AI ma dhammaystirin qorshaha: ${lastError}` });
  } catch (e) {
    console.error('Lesson-plan generation failed:', e);
    return res.status(500).json({ error: e.message || 'Khalad ayaa dhacay.' });
  }
});

app.get('*', (req, res) => {
  if (PUBLIC_DIR && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.status(500).send('Public/index.html lama helin. Hubi faylka GitHub.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`GHDD Assessment Pro running on ${port}`));
