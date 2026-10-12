
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
function normalizePassage(p) {
  if (!p || typeof p !== 'object') return null;
  const text = String(p.text || '').trim();
  if (!text) return null;
  return { title: String(p.title || '').trim(), text };
}
// Reading-passage mode (Arabic / Somali / English language exams): the exam starts with an original passage built from the curriculum.
function passageInstructions(p, passageText, targetLanguage) {
  if (!p.passage) return '';
  if (passageText) {
    return `PASSAGE MODE: this exam starts with the reading passage below (already written). Base ALL questions on it, in ${targetLanguage}. Question stems should refer to the passage naturally. Do NOT write a new passage and do NOT repeat the passage in your answer. The exam has an open-topic reading passage, but the QUESTIONS are drawn from the CURRICULUM learning objectives of the blueprint, and they must follow the required section plan and question types exactly as given (do not change types or counts). Use the passage as the text for the questions wherever the objective allows it: reading comprehension, meaning/synonym/antonym of words in the passage, grammar, word forms, rhetoric and style taken from the passage's own words and sentences. MULTIPLE-CHOICE GROUP RULE (MOST IMPORTANT): every question of type MCQ must be answered from the PASSAGE above and from nothing else: its stem quotes or clearly refers to a word, sentence, idea or example that really appears in the passage (for example the main idea, details, cause and result, inference, the best title, the meaning, synonym or antonym of a quoted word, the grammar or rhetoric of a quoted phrase). The passage was written to carry the curriculum ideas, so these questions still measure the blueprint objectives. Do NOT ask MCQs about authors, poems, lessons or facts that do not appear in the passage. Questions of other types follow the curriculum objectives (and may also use the passage). This rule overrides the source distribution rule for the MCQ group. Keep stems short and clear in the style of national exams. Every question maps to ONE curriculum objective.\nPASSAGE:\n<<<${passageText}>>>`;
  }
  return `PASSAGE MODE (reading-passage language exam, MOST IMPORTANT): first write ONE original reading passage / story (a "passage" object with "title" and "text" next to "questions") in ${targetLanguage} ONLY. Length 250 to 350 words in 3 to 5 short paragraphs separated by a newline, suited to the class level. The passage must be built on a theme, vocabulary and language structures that come from the supplied curriculum text and blueprint topics (do not copy long sentences from the curriculum). Then write ALL questions so they are answered from the passage and still measure the blueprint learning objectives through it: main idea, details, vocabulary in context, inference, grammar/usage taken from passage sentences, opinion/evaluation, according to each objective's action verb. Question stems may say "according to the passage" naturally (in ${targetLanguage}). The passage must contain everything needed to answer, must not contain Bloom labels, and the answers must not be copied word-for-word into the options as a trick. Do not create diagrams.`;
}
function remainingPlan(plan, done) {
  let skip = done;
  return (Array.isArray(plan) ? plan : []).map(x => { const c = Number(x.count) || 0; const used = Math.min(c, skip); skip -= used; return { ...x, count: c - used }; }).filter(x => x.count > 0);
}
async function requestQuestionBatch(prompt) {
  const key = process.env.GEMINI_API_KEY;
  const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'])];
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
  const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'])];
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
  const prompt = `You are an expert ${targetLanguage} language teacher writing the reading passage for a school exam.
Write ONE original reading passage in ${targetLanguage} ONLY, in the style of the Somali national examinations, for ${p.className || 'the class'} students (subject: ${p.subject || 'language'}). The topic is OPEN: choose any interesting, educational theme (for example a value such as generosity or cooperation, Somali life and culture, science, nature, health, history, or a short story); it does not have to match a textbook chapter. It is a connected text written in correct, rich, formal language, 350 to 450 words in 4 to 6 paragraphs separated by a newline. Although the topic is free, the language of the passage must serve the CURRICULUM TEXT below: deliberately include varied, clearly identifiable examples of what the curriculum teaches and these learning objectives test (for example grammar structures, word forms such as plurals and verb forms, figures of speech and rhetorical devices, punctuation, rich vocabulary with synonyms and antonyms) so that questions on those objectives can use the words and sentences of the passage. Do not copy long sentences from the curriculum text. Do not mention Bloom or cognitive levels. Objectives to be tested: ${JSON.stringify(objectives)}. Return valid JSON only: {"title":"","text":""}
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

  if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
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
  const buildPrompt = (count, partPlan, avoid = [], passageText = '') => `
You are an expert secondary-school assessment designer and professional translator.
NON-NEGOTIABLE OUTPUT LANGUAGE: ${targetLanguage}. The user explicitly selected this language. The textbook may be in a different language; translate the educational content accurately into the selected output language. NEVER use the textbook language as the exam language unless it is the selected language. Do not mix English, Somali and Arabic.
LANGUAGE COVERAGE: Write every student-visible and teacher-visible text field in ${targetLanguage}: exam question text, all subquestions, all MCQ options, fill-in prompts and answers, matching items, matching descriptions/options, matching question instructions, topic names, section titles, answer key, marking guide, explanations, diagram labels, and any generated captions. Translate generic labels such as “Answer”, “Question”, “Column A/B”, “Instructions”, “Correct answer”, and “Marking guide”. Keep only standard scientific symbols, equations, SI unit symbols, proper names, and abbreviations that should not be translated. If source facts are technical terms, use the correct equivalent in the selected language; a short parenthetical original term may be used only when necessary for scientific clarity.
Create exactly ${count} questions using ONLY facts and concepts supported by the supplied source text. Translate supported source content into the selected language; do not invent facts or repeat questions.
${passageInstructions(p, passageText, targetLanguage)}
OBJECTIVE-FIRST DESIGN (MOST IMPORTANT RULE): the learning objectives (learningOutcomes) in the blueprint below are exactly what this exam must measure. Before writing each question, choose ONE objective from the blueprint topic it belongs to, then write a question that directly measures that objective. The action verb of the objective decides what the student must do (define/state → recall; identify/classify → recognise; explain/describe → explanation; calculate/solve → computation; compare/analyse → comparison or analysis; justify/evaluate → reasoned judgement). Copy the chosen objective text, in ${targetLanguage}, into the question's \"objective\" field. Rules: (1) every question maps to exactly one objective; (2) spread questions across as many DIFFERENT objectives as the question count allows, and do not assess an objective a second time until every objective of that topic has been assessed once; (3) do not write questions on trivia, side facts, dates or examples unless an objective requires them; (4) the question must be answerable from the source text and must not test anything outside its objective; (5) if the blueprint has no objectives, first derive measurable objectives from the source text and use them the same way.
Use Bloom levels: ${JSON.stringify(p.levels || blooms)}. Choose each question's \"bloom\" value so it matches the objective's action verb; keep it ONLY in the JSON \"bloom\" field. BLOOM CONFIDENTIALITY: never write the word Bloom or any cognitive-level label or tag (Remember, Understand, Apply, Analyze, Evaluate, Create, or their translations) in question text, options, matching items, topics, section titles, instructions, answers or marking guides. The student must never be able to see the cognitive level.
Required ordered section plan: ${JSON.stringify(partPlan || [])}. Follow the exact section order and counts; translate every displayed section title into ${targetLanguage}.
AI-GENERATED TOPIC BLUEPRINT (use for coverage only; translate all displayed topics/outcomes into ${targetLanguage}): ${JSON.stringify(p.blueprint || {})}. Distribute questions across the blueprint topics and source pages; preserve marks and question counts per topic as closely as possible.${avoid.length ? `\nALREADY WRITTEN (continue the exam from the next question; do NOT repeat or paraphrase these, and prefer learning objectives not used yet): ${JSON.stringify(avoid)}` : ''}
SOURCE DISTRIBUTION RULE: ${p.sourceSelectionRule || 'Spread questions across different headings/topics; do not take consecutive questions from the same paragraph or heading. Prefer passages separated by at least two headings or at least one full page.'}
Do not create consecutive questions from the same paragraph or heading. Spread questions across the selected page range and distinct topics. Every question must include sourcePages and topic/heading. topic/heading text must be in ${targetLanguage}; sourcePages may use page numbers.
MCQ: exactly four options A, B, C, D and one correct answer. Translate the option wording into ${targetLanguage}; retain the option letters A-D for answer selection.
Fill in the Blanks: one clear blank and a clear answer, entirely in ${targetLanguage}.
Matching: create each matching question as ONE table group, not one separate mini-question per row. Return matches as [{"question":"item/term for Column A in selected language","answer":"exact matching Column B option text in selected language"}]. options must list all correct answers plus exactly ONE plausible extra distractor (so 5 items in Column A require 6 options A-F). All item and option text must be in ${targetLanguage}. On the student paper, render one four-column table: localized number; Column A item; blank for answer letter; Column B options/descriptions. Put the complete A, B, C, D, E, F option list together in the rightmost Column B cell spanning all rows. Students write only the option letter in Column 3. Never reveal correct letters or answers in the student paper.
Structured/direct questions: include clear subparts in ${targetLanguage} and a teacher-only model answer/marking guide in ${targetLanguage}. The student paper must show no solutions or model answers.
DIAGRAM RULE: Requested number of diagrams is ${Number(p.diagramCount || 0)}. Create exactly this number of diagrams across Structured questions. If it is 0, every diagram and diagramSvg field must be empty. If greater than 0, create actual, visible, accurate SVG diagrams in diagramSvg—not instructions, not placeholders, and never the word "undefined". Use standalone SVG with viewBox="0 0 640 300", width="100%", height="auto", all visible labels in ${targetLanguage}, basic shapes/lines only. No scripts, external links, images, foreignObject, or CSS imports. Diagrams must be based only on supplied source content and relevant to the question.
FINAL LANGUAGE CHECK BEFORE RETURNING: review every string that could appear on either paper. Rewrite any stray phrase in another language into ${targetLanguage}. JSON keys may remain English for the app, but their values must follow the language rules above. Return valid JSON only.
Return JSON only:
{"questions":[{"question":"","answer":"","type":"","section":"","options":[],"matches":[{"question":"","answer":""}],"diagram":"","diagramSvg":"","objective":"","bloom":"","difficulty":"","marks":1,"topic":"","sourcePages":""}]}
Subject: ${p.subject || ''}
Class: ${p.className || p.klass || ''}
Source title: ${p.sourceTitle || ''}
Page range: ${JSON.stringify(p.pageRange || {})}
Source text (content reference only; not the output language):
${String(p.sourceText || p.text || '').slice(0, 70000)}
`;

  let passage = null;
  if (p.passage) passage = await generatePassage(p, targetLanguage);
  const firstBatch = await requestQuestionBatch(buildPrompt(p.count, p.partPlan || [], [], passage?.text || ''));
  let questions = firstBatch.questions;
  // If the answer was cut short (long Somali/Arabic exams), ask for ONLY the missing questions and continue.
  for (let round = 0; questions.length < p.count && round < 3; round++) {
    const missing = p.count - questions.length;
    const avoid = questions.map(q => ({ question: String(q.question || '').slice(0, 140), objective: String(q.objective || '').slice(0, 140) }));
    try {
      const extra = await requestQuestionBatch(buildPrompt(missing, remainingPlan(p.partPlan, questions.length), avoid, passage?.text || ''));
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
  questions.languageReport = languageReport;
  questions.passageCheck = passageCheck;
  questions.passage = p.passage ? passage : null;
  return questions;
}


async function aiGenerateDiagram(p, question, index) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing; cannot create requested diagrams.');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const lang = p.examLanguage === 'ar' ? 'Arabic' : p.examLanguage === 'so' ? 'Somali' : 'English';
  const prompt = `Create one accurate, student-exam-ready educational diagram as SVG for this question. Diagram labels must be in ${lang}. Use only source-supported information; if the source does not support exact details, make a clearly schematic diagram and avoid invented labels.
Question: ${String(question.question || question.text || '')}
Topic: ${String(question.topic || '')}
Source pages: ${String(question.sourcePages || '')}
Source text: ${String(p.sourceText || '').slice(0, 18000)}
Return ONLY a single standalone SVG element, no markdown or explanation. Requirements: viewBox="0 0 640 300", width="100%", height="auto"; clear readable labels; simple shapes/lines; white background; no scripts, no external links, no images, no foreignObject, no CSS imports.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {'content-type':'application/json','x-goog-api-key':key},
    body: JSON.stringify({
      contents:[{role:'user',parts:[{text:prompt}]}],
      generationConfig:{temperature:0.2,maxOutputTokens:3000}
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Diagram generation request failed.');
  const raw=(data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim();
  const svgMatch=raw.match(/<svg\b[\s\S]*?<\/svg>/i);
  if (!svgMatch) throw new Error(`AI did not return a valid SVG for diagram ${index}.`);
  const svg=svgMatch[0]
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<\/?(?:foreignObject|iframe|object|embed|image|use)\b[^>]*>/gi,'')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/url\s*\([^)]*\)/gi,'none');
  return svg;
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
    const prompt = `You are an expert secondary-school assessment designer. Create an EXAM BLUEPRINT / TABLE OF SPECIFICATIONS before the questions are generated. Use ONLY topics, headings, facts and learning outcomes supported by the supplied OCR text. Do not invent units or learning outcomes.\nMANDATORY OUTPUT LANGUAGE: ${languageName}. Translate all displayed blueprint fields including unit, topic, learning outcomes, notes and section names into this language, even when the OCR source uses another language. Do not mix languages; only JSON keys and scientific symbols may remain unchanged. Subject: ${p.subject || ''}. Class: ${p.className || ''}. Source book: ${p.sourceTitle || ''}. Selected pages: ${JSON.stringify(p.pageRange || {})}. Total marks: ${totalMarks}. Total questions: ${totalQuestions}. Format: ${p.format || 'four-part'}.\n${p.passage ? `PASSAGE-BASED LANGUAGE EXAM: this exam will begin with an original reading passage built from the curriculum, and every question will be answered through that passage. Write the learningOutcomes as language-skill objectives taken from the curriculum text (for example reading comprehension: main idea, details, inference; vocabulary in context; grammar, structure and usage; writing conventions; opinion and evaluation) so they can be tested through a passage.\n` : ''}OBJECTIVE-FIRST BLUEPRINT (MOST IMPORTANT): the blueprint is built around learning objectives. If the source text itself states objectives (for example headings such as Objectives, Learning outcomes, Learning objectives, \"By the end of this unit/lesson students should be able to\", \"After studying this chapter you should...\"), use those objectives first and translate them faithfully into ${languageName}. Otherwise derive 2 to 5 measurable objectives per topic from the headings and content that are really present. Each objective is ONE testable statement that starts with an observable action verb (define, state, identify, describe, explain, calculate, compare, classify, interpret, justify...) and can be answered from the supplied source text. learningOutcomes must contain only such objectives, never vague aims like \"understand the topic\". Give every topic a questionCount big enough to assess its objectives (at least one question per objective when the total number of questions allows). The Bloom distribution of a topic must follow the action verbs of its objectives. Bloom levels are teacher-only information inside this blueprint and must never appear in student-facing text.\nUse Bloom levels ${JSON.stringify(p.levels || blooms)}. Spread topics across distinct headings and pages; do not base adjacent questions on the same paragraph. Determine topic/unit, measurable learning outcomes, source pages, Bloom distribution, planned question count and marks per topic. Counts must add to exactly ${totalQuestions}; marks must add to exactly ${totalMarks}. Section counts should match this section plan: ${JSON.stringify(p.partPlan || [])}. Return valid JSON only. Set the language field to exactly English, Somali, or Arabic according to the selected language. Schema: {"subject":"","language":"","totalMarks":${totalMarks},"totalQuestions":${totalQuestions},"coverage":[{"unit":"","topic":"","learningOutcomes":[""],"sourcePages":"","bloomDistribution":{"Remember":0,"Understand":0,"Apply":0,"Analyze":0,"Evaluate":0,"Create":0},"questionCount":0,"marks":0}],"sectionDistribution":[{"section":"","questionCount":0,"marks":0}],"qualityRules":["source traceability","no duplicate questions","marks sum exactly","Bloom alignment"],"notes":[]}.\nOCR SOURCE TEXT:\n${sourceText.slice(0,70000)}`;

    const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'])];
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
    const modelCandidates = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'].filter(Boolean))];
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
          if ([429, 500, 502, 503].includes(r.status)) continue;
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
