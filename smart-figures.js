// smart-figures.js
// Isku-xirka 5-ta mabda': profile qaranka -> nooca su'aasha -> sawirka saxda ah -> hubin.
// Waxaa loo qoray dependency-injection si loo tijaabiyo iyada oo aan AI la isticmaalin (tests/figure-engine.test.cjs).

import { getProfile, planSlots, describeSlot, KINDS } from './exam-profiles.js';
import {
  renderFigure, FIGURE_SCHEMAS, checkAndRepairMcq, verifyFigureQuestion, verifySvg,
  extractTexts, answerIndex, optionText, expectedFor
} from './figure-engine.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const hash = (str) => { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const tokens = (s) => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));

// ---- Su'aalaha jajaban: qoraal la'aan, cinwaan qayb, MCQ doorasho la'aan, ama MCQ oo ah qeexid ("Define...") ----
const SECTION_LABEL = /^\s*(part|section|qaybta|القسم)\b/i;
const DEFINE_STEM = /^\s*(define|explain|describe|discuss|list|outline|state|name|relate|differentiate|distinguish|compare|examine|state\s+(?:and|two|three|four|five)|qeex|sharax|faahfaahi|taxan|ka hadal|\u0634\u0631\u062d|\u0639\u0631\u0641)\b/i;
const FIG_REF = /\b(?:figure|fig\.?|diagram|graph|chart|table)\s*\d+(?:\.\d+)?\b|\b(figure|diagram|graph|chart|table|picture|map|circuit)\s+(below|above|shown|given)|\b(in|from|on|by)\s+the\s+(figure|diagram|graph|chart|circuit|picture)\b|\bshown\s+(in|below|above)\b|\b(below|following)\s+(figure|diagram|graph|chart|circuit)|sawirka\s+(hoose|kor)|jaantuska\s+(hoose|kor)|khariidadda\s+hoose|shaxda\s+hoose/i;
const STOP = new Set('a an the of in on at to is are was were be it its this that these those which what who whom whose how why when where following correct best one ones following statement statements below above shown figure given by for with from as and or not state identify determine find describe choose select'.split(' '));
const toks = (t) => new Set(String(t || '').toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').split(' ').filter((w) => w && !STOP.has(w)));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const MCQ_STYLE = /\b(which\s+(one\s+)?of\s+the\s+following|choose\s+the|select\s+the\s+(correct|best|true)|true\s+statement|correct\s+statement|best\s+describes)\b|\b(is|are)\s+(called|known\s+as|termed|defined\s+as)\s*:?\s*(\(\s*\d+\s*marks?\s*\))?\s*$/i;
// LaTeX / formulas oo qoraal caadi ah ka dhig (π, √, ², ×) si Word-ka u muuqdaan si fiican
export function cleanMathText(t) {
  let s = String(t ?? '');
  if (!/[\\^$]/.test(s)) return s;
  s = s.replace(/\$\$?([^$]+)\$\$?/g, '$1').replace(/\\[()\[\]]/g, '');
  s = s.replace(/\\(?:text|textrm|mathrm|mathbf|textbf|mbox|rm)\s*\{([^{}]*)\}/g, '$1');
  for (let i = 0; i < 4; i++) s = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${/^[\w.]+$/.test(a) ? a : '(' + a + ')'}/${/^[\w.]+$/.test(b) ? b : '(' + b + ')'}`);
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)').replace(/\\sqrt\s*([\w.]+)/g, '√$1');
  s = s.replace(/\\(?:text|textrm|mathrm|mathbf|textbf|mbox|rm)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\(?:left|right|big|Big|bigl|bigr)\b\s*/g, '').replace(/\\(sin|cos|tan|cot|sec|csc|log|ln|exp)\b/g, '$1');
  const g = { pi: 'π', times: '×', cdot: '·', theta: 'θ', omega: 'ω', lambda: 'λ', Delta: 'Δ', delta: 'δ', mu: 'μ', rho: 'ρ', alpha: 'α', beta: 'β', phi: 'φ', approx: '≈', leq: '≤', geq: '≥', neq: '≠', rightarrow: '→', degree: '°', Omega: 'Ω', sigma: 'σ', epsilon: 'ε', infty: '∞', pm: '±' };
  s = s.replace(/\\([A-Za-z]+)/g, (m, w) => (g[w] !== undefined ? g[w] : m)).replace(/\^\{?\\?circ\}?/g, '°');
  const sup = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻' };
  s = s.replace(/\^\{?(-?\d{1,2})\}?/g, (_, n) => [...n].map((c) => sup[c] || c).join(''));
  const sub = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
  s = s.replace(/_\{?(\d{1,2})\}?/g, (_, n) => [...n].map((c) => sub[c] || c).join('')).replace(/_\{([A-Za-z]+)\}/g, '_$1');
  return s.replace(/\\\s*$/g, '').replace(/\\,|\\;|\\ /g, ' ').replace(/[{}]/g, '').replace(/\s{2,}/g, ' ').trim();
}
const timesX = (t) => String(t ?? '').replace(/(\d)\s*[x*]\s*(10\s*[⁰¹²³⁴⁵⁶⁷⁸⁹⁻^])/g, '$1 × $2');
// Sawir aan la socon su'aasha: lambarrada sawirka (k=250, x=0.08) ayaan ku jirin qoraalka (k=200, x=0.06) -> sawirka waa laga saaraa
export function dropConflictingFigures(questions) {
  let n = 0;
  const nums = (t) => new Set((String(t || '').match(/\d+(?:\.\d+)?/g) || []).map((x) => String(Number(x))));
  questions.forEach((q) => {
    const svg = q?.diagramSvg; if (!svg || typeof svg !== 'string') return;
    const fm = q.figureMeta;
    if (fm && fm.kind === 'organic_structure') {
      const isMcq = Array.isArray(q.options) && q.options.length > 0;
      const txt = `${q.question || q.text || ''} ${(q.options || []).join(' ')} ${q.answer || ''}`;
      const forms = (txt.match(/\b(?:C\d*H\d*[A-Za-z0-9]*|C[₀-₉]+H[₀-₉]+)\b/g) || []).map((f) => f.replace(/[₀-₉]/g, (d) => d.charCodeAt(0) - 8320));
      const mine = String(fm.facts?.molecular_formula || '');
      const bad = (isMcq && !fm.answerChecked) || (forms.length && mine && !forms.includes(mine));
      if (bad) { delete q.diagramSvg; delete q.diagramPng; delete q.diagram; delete q.figureMeta; n++; return; }
    }
    const labels = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)].map((m) => m[1]).join(' ');
    const fn = nums(labels); if (!fn.size) return;
    const text = `${q.question || q.text || ''} ${(q.options || []).join(' ')}`;
    if (FIG_REF.test(text)) return;
    const qn = nums(text); if (qn.size < 2) return;
    const missing = [...fn].filter((x) => !qn.has(x));
    if (missing.length && missing.length === fn.size) { delete q.diagramSvg; delete q.diagramPng; delete q.diagram; delete q.figureMeta; n++; }
  });
  return n;
}
// ---- Chemistry / general science notation: H2SO4 -> H₂SO₄, Fe3+ -> Fe³⁺, SO4^2- -> SO₄²⁻, -> -> →, <= -> ≤, degrees C -> °C
const ELEMS = new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Ag Cd Sn Sb I Xe Cs Ba Au Hg Pb Bi Ra U Pt'.split(' '));
const DIATOMIC = new Set(['H2', 'O2', 'N2', 'F2', 'Cl2', 'Br2', 'I2', 'P4', 'S8', 'O3']);
const SUB = '₀₁₂₃₄₅₆₇₈₉', SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const toSub = (d) => String(d).replace(/\d/g, (x) => SUB[x]);
const toSup = (d) => String(d).replace(/\d/g, (x) => SUP[x]).replace(/\+/g, '⁺').replace(/-/g, '⁻');
function validFormula(tok) {
  const parts = tok.match(/[A-Z][a-z]?|\d+|[()]/g) || [];
  if (parts.join('') !== tok) return false;
  let groups = 0, depth = 0;
  for (const p of parts) { if (p === '(') depth++; else if (p === ')') { if (--depth < 0) return false; } else if (/^[A-Z]/.test(p)) { if (!ELEMS.has(p)) return false; groups++; } }
  return depth === 0 && groups >= 1;
}
export function chemFormat(t) {
  let x = String(t ?? '');
  if (!x) return x;
  x = x.replace(/\\(?=[πωθλΔ])/g, '').replace(/\s*<->\s*|\s*<=>\s*|\s*⇄\s*/g, ' ⇌ ').replace(/\s*(?:-->|->|=>)\s*/g, ' → ').replace(/<=(?!>)/g, '≤').replace(/>=/g, '≥').replace(/\b(\d+(?:\.\d+)?)\s*degrees?\s*(?:C(?:elsius)?|c)\b/g, '$1 °C').replace(/(\d)\s*°\s*C\b/g, '$1 °C');
  // formula tokens (must contain a digit and be built only from real element symbols)
  x = x.replace(/(?<![A-Za-z0-9_.])(\d*)((?:[A-Z][a-z]?|\((?:[A-Z][a-z]?\d*)+\))(?:[A-Z][a-z]?|\d+|\((?:[A-Z][a-z]?\d*)+\))*)(?:\^?(\d*[+-]))?(?![A-Za-z0-9_])/g, (m, coef, f, ion) => {
    if (!/\d/.test(f) && !ion) return m;
    if (ion && /^[+-]$/.test(ion) && /^[A-Z][a-z]?\d$/.test(f)) return coef + f.replace(/\d$/, '') + toSup(f.slice(-1) + ion);
    if (!validFormula(f)) return m;
    const groups = (f.match(/[A-Z][a-z]?/g) || []).length;
    if (!ion && groups < 2 && !DIATOMIC.has(f)) return m;
    const body = f.replace(/(?<=[A-Za-z)])(\d+)/g, (_, d) => toSub(d));
    return coef + body + (ion ? toSup(ion) : '');
  });
  // already-converted subscripts followed by charge: SO₄²- / SO₄2-
  x = x.replace(/([₀-₉)])\^?(\d?)([+-])(?![A-Za-z0-9])/g, (m, a, d, sg) => a + toSup((d || '') + sg));
  x = x.replace(/([A-Za-z₀-₉)])\^(\d*[+-])/g, (m, a, c) => a + toSup(c));
  return x;
}
export function cleanQuestionMath(q) {
  if (!q || typeof q !== 'object') return q;
  for (const k of ['question', 'text', 'answer']) if (typeof q[k] === 'string') q[k] = timesX(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map((o) => (typeof o === 'string' ? timesX(o) : o));
  for (const k of ['question', 'text', 'answer']) if (typeof q[k] === 'string') q[k] = greekWords(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map((o) => (typeof o === 'string' ? greekWords(o) : o));
  for (const k of ['question', 'text', 'answer']) if (typeof q[k] === 'string') q[k] = cleanMathText(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map((o) => (typeof o === 'string' ? cleanMathText(o) : o));
  if (Array.isArray(q.keyPoints)) q.keyPoints = q.keyPoints.map((o) => (typeof o === 'string' ? cleanMathText(o) : o));
  for (const k of ['question', 'text', 'answer']) if (typeof q[k] === 'string') q[k] = chemFormat(q[k]);
  if (Array.isArray(q.options)) q.options = q.options.map((o) => (typeof o === 'string' ? chemFormat(o) : o));
  if (Array.isArray(q.keyPoints)) q.keyPoints = q.keyPoints.map((o) => (typeof o === 'string' ? chemFormat(o) : o));
  return q;
}
const figSig = (q) => { try { const m = q?.figureMeta; if (!m || !m.spec) return ''; const st = (o) => Array.isArray(o) ? o.map(st) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, st(o[k])])) : o; return m.kind + JSON.stringify(st(m.spec)); } catch (_) { return ''; } };
// Last resort: a question still points to a figure that does not exist -> drop only the sentence that mentions the figure (all data stays in the text).
const contain = (a, b) => { const m = Math.min(a.size, b.size); if (m < 3) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / m; };
const LET = 'ABCD';
function correctText(q) {
  const opts = Array.isArray(q?.options) ? q.options.map((o) => String(o || '').replace(/^\s*[A-Da-d][.)]\s*/, '').trim()) : [];
  const a = String(q?.answer || '').trim();
  if (/^[A-Da-d][.)]?$/.test(a) && opts.length) return opts[LET.indexOf(a[0].toUpperCase())] || '';
  return a;
}
function qsig(q) {
  const text = String(q?.question || q?.text || '');
  const ct = String(correctText(q)).toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').trim();
  return { all: toks(text + ' ' + ct), st: toks(text), ot: toks((Array.isArray(q?.options) ? q.options : []).join(' ')), ct, ctt: toks(ct) };
}
function nearDup(a, b) {
  if (a.st.size < 3 || b.st.size < 3) return false;
  const j = jac(a.st, b.st), c = contain(a.st, b.st);
  if (j >= 0.7 || c >= 0.85) return true;
  if (j >= 0.5 && jac(a.ot, b.ot) >= 0.5) return true;
  if (c >= 0.5 && a.ct && a.ct.length >= 2 && a.ct === b.ct) return true;
  // same idea + same answer (e.g. two questions whose answer is "constructive interference"), or heavy overlap of stem+answer words
  const call = contain(a.all, b.all);
  if (a.ct && a.ct === b.ct && a.ctt.size >= 2 && /\p{L}{3}/u.test(a.ct) && call >= 0.25) return true;
  if (Math.min(a.all.size, b.all.size) >= 6 && call >= 0.6) return true;
  if (c >= 0.5 && a.ctt.size >= 3 && jac(a.ctt, b.ctt) >= 0.6) return true;
  if (Math.min(a.ctt.size, b.ctt.size) >= 3 && jac(a.st, b.st) >= 0.3 && jac(a.ctt, b.ctt) >= 0.25) return true;
  // same fact tested twice: one correct answer contains the other and the stems share their key words
  if (Math.min(a.ctt.size, b.ctt.size) >= 3 && contain(a.ctt, b.ctt) >= 0.9 && contain(a.st, b.st) >= 0.3) return true;
  return false;
}
export function stripDanglingFigureRefs(questions) {
  let n = 0;
  for (const i of findBrokenQuestions(questions, { dangling: true }).filter((b) => b.why === 'dangling-figure').map((b) => b.index)) {
    const q = questions[i];
    for (const k of ['question', 'text']) {
      if (typeof q[k] !== 'string') continue;
      const parts = q[k].split(/(?<=[.?!:])\s+/);
      const kept = parts.filter((x) => !FIG_REF.test(x));
      const out = kept.join(' ').trim();
      if (kept.length < parts.length && out.length >= 25) { q[k] = out; n++; }
    }
  }
  return n;
}
export function similarToOthers(q, questions, index) {
  const a = qsig(q);
  return questions.some((o, i) => i !== index && o && nearDup(a, qsig(o)));
}
// Su'aalo ku saabsan manhajka/habka waxbarashada (ma aha maaddada) iyo doorashooyin isku macne ah
export const EDU_META = /\b(pedagog\w*|educational\s+(reform|outcomes?|goals?|aims?|system|policy|policies|philosophy|values?)|education(al)?\s+reform|islamic\s+values?|active\s+citizens?|civic\s+(participation|engagement)|rote\s+memori[sz]ation|experiential\s+learning|kinesthetic|learner[- ]cent(red|ered)|teacher[- ]cent(red|ered)|teaching\s+(method|methods|strategy|strategies|approach|approaches|aids?)|classroom\s+(activity|activities|management)|lesson\s+(plan|planning|objectives?)|role[- ]?play|form\s+\d\s+\w+\s+lesson|a\s+teacher\s+(asks|wants|has|uses|implements|plans|organi[sz]es|gives)|instructional|assessment\s+(strategy|strategies|methods?)|competenc(y|ies)[- ]based|learning\s+(styles?|approach|approaches|strategy|strategies|outcomes?)|modernis(e|ing|ation)\s+(of\s+)?(education|learning))\b/i;
const OFF_TOPIC = /\b(national\s+curriculum|curriculum|syllabus|scheme\s+of\s+work|learning\s+(objective|outcome)s?|bloom|(the|this)\s+(textbook|book|chapter|lesson\s+plan)|according\s+to\s+the\s+(book|textbook|text|syllabus)|teaching\s+approach(es)?|instructional\s+approach(es)?|core\s+values?|learner[- ]centred|(physics|chemistry|biology|mathematics|geography|history)\s+(textbook|book)|which\s+chapter|chapter\s+\d+\s+(covers|of\s+the))\b/i;
const SYN = [[/spring\s+constant|force\s+constant|stiffness\s+constant/g, 'forceconst'], [/\bperiodic\s+time\b|\btime\s+period\b/g, 'period'], [/\bangular\s+velocity\b|\bangular\s+frequency\b/g, 'angfreq']];
function numOf(t) { const m = String(t).replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:\s*[x×]\s*10\s*(?:\^|⁻|[⁰¹²³⁴⁵⁶⁷⁸⁹])\S*)?/); if (!m) return null; return parseFloat(m[0]); }
function nearEqualNumbers(opts) {
  const v = opts.map((o) => ({ n: numOf(o), u: String(o).replace(/-?[\d.,]+/g, '').replace(/\s+/g, '').toLowerCase() }));
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) {
    if (v[i].n === null || v[j].n === null || v[i].u !== v[j].u) continue;
    const a = v[i].n, b = v[j].n; if (a === 0 || b === 0) continue;
    if (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) < 0.02) return true;
  }
  return false;
}
// Echo / sonar / "returns after t seconds": masafadu waa v*t/2. Haddii furuhu yahay v*t (qaladka caadiga ah) -> hagaaji
export function fixEchoKeys(questions) {
  let fixed = 0;
  for (const q of questions) {
    const text = String(q?.question || q?.text || '');
    const opts = Array.isArray(q?.options) ? q.options.map(optionText) : [];
    if (opts.length !== 4 || !/\b(echo|sonar|echo[- ]sounder|ultrasound pulse|(?:return|returns|back)\b.*\b(?:reflect|seabed|wall|cliff)|reflect\w*\s+(?:off|from)\b)/i.test(text)) continue;
    const tm = text.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds?)/i), vm = text.match(/(\d+(?:\.\d+)?)\s*m\s*\/\s*s|(\d+(?:\.\d+)?)\s*m s⁻¹/i);
    if (!tm || !vm) continue;
    const t = parseFloat(tm[1]), v = parseFloat(vm[1] || vm[2]); if (!t || !v) continue;
    const half = v * t / 2, full = v * t;
    const idxHalf = opts.findIndex((o) => { const n = numOf(o); return n !== null && Math.abs(n - half) < 1e-6 * Math.max(1, half); });
    const key = answerIndex({ answer: q.answer, options: opts });
    if (idxHalf >= 0 && key !== idxHalf) { q.answer = 'ABCD'[idxHalf]; fixed++; }
    else if (idxHalf < 0 && key >= 0 && Math.abs((numOf(opts[key]) ?? -1) - full) < 1e-6 * full) { q._fix = true; q._fixWhy = 'echo round trip'; }
  }
  return fixed;
}
function hasSynonymOptions(opts) {
  if (nearEqualNumbers(opts)) return true;
  const n = opts.map((o) => { let t = String(o).toLowerCase(); for (const [re, to] of SYN) t = t.replace(re, to); return t.replace(/[^\p{L}\p{N}]+/gu, ''); });
  return new Set(n).size < n.length;
}
// Greek words -> symbols (theta, omega, lambda ...) si calaamadaha u noqdaan kuwa saxda ah
const PART_PREFIX = /^\s*(?:PART|QAYBTA)\s+[IVX\d]+\s*[—–:-]\s*(?:DIRECT\s*\/?\s*STRUCTURED\s*QUESTIONS?|MULTIPLE\s*CHOICE\s*QUESTIONS?)\s*/i;
// Notation: w -> ω inside formulas, 2pi -> 2π, sqrt(..) -> √(..), "PART IV — DIRECT / STRUCTURED QUESTIONS" prefix removed from a question
export function fixNotation(t, formulaCtx = false) {
  let x = String(t ?? '').replace(PART_PREFIX, '');
  x = x.replace(/\bsqrt\s*\(/gi, '√(').replace(/(\d|\))\s*pi\b/g, '$1π').replace(/\bpi\b(?=\s*[/*)=]|\s*$|\s*rad)/g, 'π');
  if (formulaCtx || /[=²]|\(wt\)|\bsin\b|\bcos\b/.test(x)) x = x.replace(/\(wt\)/g, '(ωt)').replace(/\bw\b(?=\s*(?:[=²*\/)(]|t\b|\^|$)|\s+[A-Za-z√(]|\s*\d)/g, 'ω').replace(/(?<=[A-Za-z]\s)w\b/g, 'ω');
  return x;
}
export function greekWords(t) {
  return fixNotation(t).replace(/\b(theta|omega|lambda|Delta|delta)\b/g, (m) => ({ theta: 'θ', omega: 'ω', lambda: 'λ', Delta: 'Δ', delta: 'δ' }[m])).replace(/\bw(\s*=\s*)(?=[√(2π\d1/])/g, 'ω$1');
}
const GENERIC_V = new Set(['calculate', 'determine', 'explain', 'describe', 'state', 'identify', 'define', 'given', 'using', 'following', 'which', 'what', 'with', 'from', 'that', 'this', 'into', 'their', 'when', 'between', 'about', 'value', 'values', 'effect', 'compare']);
const stemTok = (t) => new Set((String(t || '').toLowerCase().match(/[\p{L}]{4,}/gu) || []).map((w) => w.replace(/(ing|es|s)$/, '')).filter((w) => w.length >= 3 && !GENERIC_V.has(w)));
// Objective-ku wuxuu ku habboon yahay su'aasha kaliya haddii ay wadaagaan >=3 eray oo macno leh
export function objectiveFits(q) {
  const o = stemTok(q?.objective || ''); if (!o.size) return false;
  const t = stemTok(`${q?.question || q?.text || ''} ${correctText(q)} ${(q?.keyPoints || []).join(' ')} ${(q?.options || []).join(' ')}`);
  let n = 0; for (const w of o) if (t.has(w)) n++;
  return n >= Math.min(3, Math.ceil(o.size / 2));
}
export function findBrokenQuestions(questions, { dangling = false, partPlan = null } = {}) {
  const bad = [];
  const seenSig = new Map(), seenTxt = new Map(), seenTok = [], seenKP = [];
  questions.forEach((q, i) => {
    const text = String(q?.question || q?.text || '').trim();
    const posMcq = Array.isArray(partPlan) && partPlan.length ? /^(mcq|multiple)/i.test(partTypeAt(partPlan, i)) : false;
    const posKnown = Array.isArray(partPlan) && partPlan.length > 0;
    const isMcq = posKnown ? posMcq : /^(mcq|multiple)/i.test(q?.type || '');
    const opts = Array.isArray(q?.options) ? q.options.map((o) => String(o || '').trim()).filter(Boolean) : [];
    let why = '';
    if (text.length < 8 || /^[A-Z][A-Z0-9_ -]{3,}$/.test(text) || /^(word_bank|n\/a|none|undefined|null)$/i.test(text) || (SECTION_LABEL.test(text) && text.length < 90)) why = 'empty-or-section-title';
    else if (dangling && FIG_REF.test(text) && !q?.diagramSvg && !q?.diagramPng && !(q?.diagram && q.diagram !== 'undefined')) why = 'dangling-figure';
    else if (isMcq && opts.length !== 4) why = 'mcq-without-options';
    else if (isMcq && DEFINE_STEM.test(text)) why = 'mcq-is-open-question';
    else if (OFF_TOPIC.test(text) || EDU_META.test(text)) why = 'off-topic';
    else if (q?._fix) why = 'audit-fail';
    else if (isMcq && opts.length === 4 && opts.every((o) => /^[A-Da-d][.)]?$/.test(o))) why = 'letter-options';
    else if (isMcq && /^\s*(?:match\b|(?:use|using)\s+the\s+(?:two\s+)?columns?\b)|\bcolumn\s*(?:i|1|a)\b.*\bcolumn\s*(?:ii|2|b)\b/i.test(text)) why = 'matching-in-mcq';
    else if (!isMcq && /structured\s+(items?|exercises?)|missing\s+details|by\s+completing\s+the|complete\s+the\s+(table|items)\s+below/i.test(text)) why = 'vague-stem';
    else if (isMcq && opts.some((o) => /^[?\-–—_.\s]*$/.test(o) || /^(undefined|null|n\/a)$/i.test(o))) why = 'blank-option';
    else if (isMcq && new Set(opts.map((o) => o.toLowerCase().replace(/[^\p{L}\p{N}()]+/gu, ''))).size < opts.length) why = 'duplicate-options';
    else if (isMcq && hasSynonymOptions(opts)) why = 'duplicate-options';
    else if (!isMcq && posKnown && opts.length >= 2) why = 'mcq-style-in-written';
    else if (!isMcq && !opts.length && (MCQ_STYLE.test(text) || /^\s*[A-Da-d][.)]?\s*$/.test(String(q?.answer || '')))) why = 'mcq-style-in-written';
    else if (!isMcq && !opts.length && Number(q?.marks) >= 6 && text.split(/\s+/).length < 18 && !/\(a\)/i.test(text)) why = 'too-simple';
    if (!why) {
      const sig = figSig(q), tx = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const st = toks(text), ot = toks(opts.join(' '));
      const cur = qsig(q);
      const near = seenTok.some((p) => nearDup(cur, p.sg));
      if ((sig && seenSig.has(sig)) || (tx.length > 20 && seenTxt.has(tx)) || (st.size >= 3 && near)) why = 'duplicate';
      else { if (sig) seenSig.set(sig, i); if (tx.length > 20) seenTxt.set(tx, i); seenTok.push({ st, ot, sg: cur }); }
    }
    if (!why && !isMcq && !opts.length && Array.isArray(q?.keyPoints) && q.keyPoints.length >= 2) {
      const kt = toks(q.keyPoints.join(' ').replace(/[0-9.]+/g, ' '));
      const same = seenKP.filter((x) => jac(x, kt) >= 0.3).length;
      if (same >= 2) why = 'duplicate';
      else seenKP.push(kt);
    }
    if (why) bad.push({ index: i, why, mcq: isMcq });
  });
  return bad;
}
// "figure above" -> "figure below": sawirka waxaa la dhigaa stem-ka hoostiisa (sida sample-ka qaranka)
export function fixFigureDirection(text, lang = 'en') {
  return String(text || '')
    .replace(/\b(figure|diagram|graph|chart|table|picture|map|illustration)\s+above\b/gi, '$1 below')
    .replace(/\babove\s+(figure|diagram|graph|chart|table|picture|map|illustration)\b/gi, 'below $1')
    .replace(/\b(sawirka|jaantuska|shaxda|khariidadda)\s+(kore|sare)\b/gi, '$1 hoose');
}

export function partTypeAt(plan, i, count) {
  let n = 0;
  for (const part of Array.isArray(plan) ? plan : []) { n += Number(part.count) || 0; if (i < n) return part.type || 'MCQ'; }
  return Array.isArray(plan) && plan.length ? plan[plan.length - 1].type || 'Structured' : (i < Math.round(count * 0.45) ? 'MCQ' : 'Structured');
}

// Isla qaabka /api/generate ee objectivePlan: su'aal kasta ujeeddadeeda
// Golden-ratio stride permutation: neighbours (and the MCQ / structured parts) end up on far-apart pages.
export function interleavePlan(plan) {
  const n = plan.length; if (n < 3) return plan.slice();
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let step = Math.max(1, Math.round(n * 0.618)); while (gcd(step, n) !== 1) step++;
  return Array.from({ length: n }, (_, i) => plan[(i * step) % n]);
}
export function plannedObjectives(p, count) {
  const inv = Array.isArray(p.blueprint?.objectiveInventory?.objectives) ? p.blueprint.objectiveInventory.objectives : [];
  const byId = new Map(inv.map((o) => [String(o.id), o]));
  const rows = Array.isArray(p.blueprint?.coverage) ? p.blueprint.coverage : [];
  const selected = [...new Set(rows.flatMap((r) => (Array.isArray(r.objectiveIds) ? r.objectiveIds.map(String) : [])).filter((id) => byId.has(id)))];
  const plan = [];
  for (const row of rows) {
    const ids = [...new Set((Array.isArray(row.objectiveIds) ? row.objectiveIds : []).map(String).filter((id) => byId.has(id)))];
    const n = Math.max(0, Number(row.questionCount) || 0);
    for (let j = 0; j < n; j++) if (ids.length) plan.push(ids[j % ids.length]);
  }
  if (p.blueprint?.interleaved) { const ip = interleavePlan(plan); plan.length = 0; plan.push(...ip); }
  return Array.from({ length: count }, (_, i) => byId.get(plan[i] || selected[i % Math.max(1, selected.length)]) || null);
}

export function buildExamPlan(p, count) {
  const profile = getProfile(p.subject, p.className, p.sourceTitle);
  if (!profile) return null;
  const objs = plannedObjectives(p, count);
  const items = objs.map((o, i) => ({ index: i, type: partTypeAt(p.partPlan, i, count), objective: o?.text || '', topic: o?.topic || '' }));
  const slots = planSlots({ profileKey: profile.key, items, seed: hash(`${p.sourceTitle || ''}|${JSON.stringify(p.pageRange || {})}|${count}`), figureTarget: Number(p.figureTarget) || 0 });
  return { profile, slots, objs };
}

// Qoraal u gudba prompt-ka guud ee su'aalaha (boqolka su'aalood)
export function slotHint(plan, range = null) {
  if (!plan) return '';
  const lines = plan.slots.filter((s) => !range || (s.index >= range.from && s.index < range.to)).map((s) => `${s.index + 1}: ${describeSlot(s)}`).join('; ');
  return `NATIONAL-EXAM QUESTION-KIND PLAN for ${plan.profile.label} (follows the national sample paper: ${plan.profile.notes}). Position → kind: ${lines}.
For a "figure" position write an ordinary stand-alone question on its objective (the system will replace it by a figure-based version, so do not describe or draw any figure yourself). For "calc" positions give a computation with ONE correct numeric result and four numeric options with units. For "code" positions test a concrete symbol, step, command, flowchart element or error type, never a vague definition.`;
}

export function createSmartFigures(deps) {
  const { callGeminiJson, aiGenerateDiagram, splitMarkedPages, loadLibraryDiagrams, callGeminiVision, somaliStyle = '', languageNames = {}, log = console } = deps;
  const langName = (code) => languageNames[code] || ({ en: 'ENGLISH', so: 'AF-SOOMAALI (SOMALI)', ar: 'ARABIC' }[code] || 'ENGLISH');

  function excerptFor(p, obj) {
    try {
      const pages = splitMarkedPages(p.sourceText || '');
      const pg = pages.find((x) => obj && x.page === obj.page) || pages[0];
      return pg ? pg.text.slice(0, 3500) : '';
    } catch { return ''; }
  }

  function figurePrompt({ p, slot, obj, base, feedback, isMcq }) {
    const lang = langName(String(p.examLanguage || 'en'));
    return `You are a national-examination item writer for ${p.subject || 'the subject'} (${p.className || 'secondary school'}).
${String(p.examLanguage) === 'so' ? somaliStyle : ''}
LANGUAGE: every word the student reads (question, options, axis titles, table headers, labels) must be in ${lang}; keep numbers, units, symbols and letters.
OBJECTIVE TO MEASURE: ${obj?.text || base?.objective || ''}
TOPIC: ${obj?.topic || base?.topic || ''}
SOURCE EXCERPT (content reference): ${excerptFor(p, obj)}
FIGURE: the system DRAWS a "${slot.figure}" from the "spec" you return. You never draw. Spec format: ${FIGURE_SCHEMAS[slot.figure]}
ASK ABOUT one of: ${slot.askFacts.join(', ')} - prefer "${slot.askFacts[0]}" (put its name in "askFact"). The student must READ or COMPUTE the answer from the figure.
TOPIC FIT: the figure must belong to the same topic as the objective; if it cannot test this exact objective, test the closest idea of the same topic that the figure can show. VARIANT ${slot.variant || 1}: choose values clearly different from other figures of the same kind in this paper (different numbers, shape and number of cycles).
RULES: (1) the stem must send the student to the figure (e.g. "Study the figure below ..."); (2) the stem and the figure must NOT contain the answer; (3) choose numbers that give ONE clear, sensible answer; (4) ${isMcq ? 'exactly four options, one correct, plausible distractors from typical mistakes (wrong operation, unit slip, reading the wrong point); options are short (value + unit); "answer" is the correct letter A, B, C or D' : 'structured question: "answer" is a full model answer with working and units; "keyPoints" has 2 to 5 short marking points'}; (5) "unit" is the unit of the answer (or "").
${slot.figure === 'wave' ? 'WAVE RULE: for period/frequency use a time graph (tUnit "ms" or "s"; never mention wave speed). For wavelength use a distance graph (tUnit "m", y against x) and set askFact=wavelength. Never pair a t-axis graph with a wave speed.' : ''}
${feedback ? `PREVIOUS ATTEMPT FAILED THESE CHECKS - FIX THEM: ${feedback}` : ''}
Return ONLY JSON: {"spec":{},"askFact":"","unit":"","question":"","options":["","","",""],"answer":"A","keyPoints":[],"topic":""}`;
  }

  async function buildDeterministic({ p, slot, base, obj }) {
    const isMcq = slot.kind === KINDS.MCQ_FIGURE;
    let feedback = '', lastIssues = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let j;
      try { j = await callGeminiJson(figurePrompt({ p, slot, obj, base, feedback, isMcq }), { maxTokens: 4000, temperature: attempt ? 0.45 : 0.2 }); }
      catch (e) { lastIssues = [`AI: ${e.message}`]; continue; }
      let rendered;
      try { rendered = renderFigure(slot.figure, j.spec); } catch (e) { feedback = `spec error: ${e.message}`; lastIssues = [feedback]; continue; }
      const askFact = slot.askFacts.includes(j.askFact) ? j.askFact : null;
      const exp = askFact ? expectedFor(askFact, rendered.facts, j.spec) : null;
      if (isMcq && !askFact) { feedback = `askFact must be one of ${slot.askFacts.join(', ')}`; lastIssues = [feedback]; continue; }
      if (isMcq && askFact && !exp) { feedback = `askFact "${askFact}" is not answerable from this spec (e.g. need exactly one constant-velocity stretch / unique max); change the spec or ask another fact`; lastIssues = [feedback]; continue; }
      let q = { ...base, question: String(j.question || '').trim(), topic: j.topic || base.topic, keyPoints: Array.isArray(j.keyPoints) ? j.keyPoints.map(String) : base.keyPoints };
      let repaired = false, notes = [];
      if (isMcq) {
        q.options = (Array.isArray(j.options) ? j.options : []).map((o) => optionText(String(o)));
        q.answer = String(j.answer || '').trim();
        const chk = checkAndRepairMcq(q, { askFact, facts: rendered.facts, spec: j.spec, unitHint: String(j.unit || '') });
        q = chk.q; repaired = chk.repaired; notes = chk.issues;
        if (!chk.ok) { feedback = chk.issues.join('; '); lastIssues = chk.issues; continue; }
        q.type = base.type || 'MCQ';
      } else {
        q.options = []; q.answer = String(j.answer || '').trim();
        if (!q.answer || q.question.length < 15) { feedback = 'structured question needs a clear question and model answer'; lastIssues = [feedback]; continue; }
      }
      const ver = verifyFigureQuestion(q, { svg: rendered.svg, facts: rendered.facts, askFact, spec: j.spec });
      if (!ver.ok) { feedback = ver.issues.join('; '); lastIssues = ver.issues; continue; }
      q.question = fixFigureDirection(q.question); q.diagramSvg = rendered.svg; q.diagram = '';
      q.figureMeta = { method: 'deterministic', kind: slot.figure, askFact, answerChecked: !!exp, repaired, notes, needsReview: false, spec: j.spec, facts: slimFacts(rendered.facts) };
      return { q, status: repaired ? 'repaired' : 'ok', issues: notes };
    }
    return { q: null, status: 'failed', issues: lastIssues };
  }

  async function pickLibraryDiagram(p, obj, base) {
    if (!p.bookId || !loadLibraryDiagrams) return null;
    let rows = [];
    try { rows = await loadLibraryDiagrams(p.bookId); } catch { return null; }
    const start = Number(p.pageRange?.start) || 1, end = Number(p.pageRange?.end) || 1e9;
    const want = tokens(`${obj?.text || ''} ${obj?.topic || ''} ${base?.question || ''}`);
    let best = null, bestScore = 0;
    for (const r of rows) {
      if (r.page < start || r.page > end || !/<svg/i.test(r.svg || '')) continue;
      const have = tokens(`${r.title || ''} ${r.description || ''}`);
      let score = 0; for (const t of have) if (want.has(t)) score++;
      if (obj && r.page === obj.page) score += 2;
      if (score > bestScore) { best = r; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;
  }

  async function buildSchematic({ p, slot, base, obj, index }) {
    const isMcq = slot.kind === KINDS.MCQ_FIGURE;
    const lib = await pickLibraryDiagram(p, obj, base);
    const libLabels = lib ? extractTexts(lib.svg).map((t) => t.text).filter(Boolean).slice(0, 30) : [];
    const lang = langName(String(p.examLanguage || 'en'));
    let feedback = '', lastIssues = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = `You are a national-examination item writer for ${p.subject || ''}. ${String(p.examLanguage) === 'so' ? somaliStyle : ''}
Rewrite the question below so it is answered by LOOKING AT A DIAGRAM that will be shown above it. Language: ${lang}.
OBJECTIVE: ${obj?.text || base.objective || ''}
ORIGINAL QUESTION: ${base.question}
${lib ? `THE DIAGRAM ALREADY EXISTS (from the textbook). Title: ${lib.title || ''}. Visible labels in it: ${JSON.stringify(libLabels)}. Ask about what this diagram really shows; NEVER ask for a term that is printed in it.` : `A new diagram will be drawn from your question. The parts the student must identify are marked with NEUTRAL letters (A, B, C, D) or empty boxes only; never print the names you ask for.`}
Rules: the stem must send the student to the diagram ("Study the diagram below ..."); the answer must not appear in the stem; ${isMcq ? 'exactly four options and "answer" = A, B, C or D' : '"answer" is a complete model answer and "keyPoints" has 2-5 short marking points'}.
${feedback ? `PREVIOUS ATTEMPT FAILED: ${feedback}` : ''}
Return ONLY JSON: {"question":"","options":["","","",""],"answer":"","keyPoints":[],"topic":""}`;
      let j;
      try { j = await callGeminiJson(prompt, { maxTokens: 3000, temperature: attempt ? 0.4 : 0.2 }); } catch (e) { lastIssues = [e.message]; continue; }
      let q = { ...base, question: String(j.question || '').trim(), topic: j.topic || base.topic, keyPoints: Array.isArray(j.keyPoints) ? j.keyPoints.map(String) : base.keyPoints, answer: String(j.answer || '').trim() };
      if (isMcq) {
        q.options = (Array.isArray(j.options) ? j.options : []).map((o) => optionText(String(o)));
        const chk = checkAndRepairMcq(q, {});
        if (!chk.ok) { feedback = chk.issues.join('; '); lastIssues = chk.issues; continue; }
        q = chk.q; q.type = base.type || 'MCQ';
      } else q.options = [];
      let svg = lib ? lib.svg : '';
      if (!svg) { try { svg = await aiGenerateDiagram(p, q, index + 1); } catch (e) { lastIssues = [e.message]; continue; } }
      const ver = verifyFigureQuestion(q, { svg });
      if (!ver.ok) { feedback = ver.issues.join('; '); lastIssues = ver.issues; if (lib) break; continue; }
      q.question = fixFigureDirection(q.question); q.diagramSvg = svg; q.diagram = '';
      q.figureMeta = { method: lib ? 'library' : 'ai-svg', kind: slot.figure, askFact: null, answerChecked: false, repaired: false, notes: [], needsReview: true, libraryId: lib?.id || null };
      return { q, status: 'needs-review', issues: [] };
    }
    return { q: null, status: 'failed', issues: lastIssues };
  }

  // Sawirrada oo dhan: ku beddel su'aalaha slot-ka sawirka leh. Haddii wax fashilmaan -> su'aasha qoraalka ah ayaa hadhaysa (ma jiro sawir jaban).
  async function smartFigureStage(p, questions, plan) {
    const figSlots = plan.slots.filter((s) => (s.kind === KINDS.MCQ_FIGURE || s.kind === KINDS.STRUCT_FIGURE) && questions[s.index]);
    const report = { profile: plan.profile.key, basis: plan.profile.basis, planned: figSlots.length, built: 0, repaired: 0, needsReview: 0, fallback: 0, kinds: {}, items: [] };
    let next = 0;
    const worker = async () => {
      while (next < figSlots.length) {
        const slot = figSlots[next++];
        const base = questions[slot.index], obj = plan.objs[slot.index];
        let res;
        try {
          res = slot.deterministic ? await buildDeterministic({ p, slot, base, obj }) : await buildSchematic({ p, slot, base, obj, index: slot.index });
        } catch (e) { res = { q: null, status: 'failed', issues: [e.message] }; }
        const item = { index: slot.index + 1, kind: slot.kind, figure: slot.figure, status: res.status, issues: res.issues.slice(0, 3) };
        if (res.q) {
          questions[slot.index] = res.q;
          report.built++; if (res.status === 'repaired') report.repaired++; if (res.q.figureMeta?.needsReview) report.needsReview++;
          report.kinds[slot.figure] = (report.kinds[slot.figure] || 0) + 1;
        } else { report.fallback++; log.warn?.(`Figure slot ${slot.index + 1} (${slot.figure}) fallback:`, res.issues.join(' | ')); }
        report.items.push(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, figSlots.length) }, worker));
    report.items.sort((a, b) => a.index - b.index);
    return report;
  }

  // Hubinta aragga (sawirka PNG laga soo qaado browser-ka): ardayga indho ahaan ayuu xallinayaa.
  async function visionVerify({ question, options, answer, pngDataUrl, lang }) {
    if (!callGeminiVision) throw new Error('Vision verifier lama diyaarin');
    const idx = answerIndex({ answer, options });
    const optionsText = (options || []).map((o, i) => `${LETTERS[i]}. ${optionText(o)}`).join('\n');
    const withFigure = await callGeminiVision(`You are a student. Look at the figure, then answer the exam question.\nQUESTION: ${question}\n${optionsText}\nAlso judge the figure: is it visible and clear, are labels readable, does anything in it plainly state the answer?\nReturn ONLY JSON: {"choice":"A|B|C|D","figureVisible":true,"labelsReadable":true,"figureStatesAnswer":false,"problems":[]}`, pngDataUrl);
    const without = await callGeminiVision(`Answer this exam question WITHOUT any figure (the figure is missing). If you cannot know, choose "X".\nQUESTION: ${question}\n${optionsText}\nReturn ONLY JSON: {"choice":"A|B|C|D|X"}`, null);
    const key = idx >= 0 ? LETTERS[idx] : '';
    const flags = [];
    if (!withFigure.figureVisible) flags.push('sawirku ma muuqdo si cad');
    if (!withFigure.labelsReadable) flags.push('calaamadaha ma akhrismaan');
    if (withFigure.figureStatesAnswer) flags.push('sawirku wuxuu muujinayaa jawaabta');
    if (key && String(withFigure.choice).toUpperCase() !== key) flags.push(`ardayga sawirka eegay wuxuu doortay ${withFigure.choice}, furuhuna waa ${key}`);
    if (key && String(without.choice).toUpperCase() === key) flags.push('jawaabta waa la qiyaasi karaa sawir la\'aan (sawirku ma loo baahna?)');
    const hard = flags.filter((f) => !/sawir la'aan/.test(f));
    return { ok: hard.length === 0, flags, choiceWithFigure: withFigure.choice, choiceWithout: without.choice, key, problems: withFigure.problems || [] };
  }

  // Hagaaji su'aalaha jajaban (ilaa 5 isku mar). Haddii hagaajinta fashilanto, su'aasha asalka ah ayaa hadhaysa.
  async function repairBroken(p, questions, objs = [], opts = {}) {
    const first = await repairRound(p, questions, objs, opts);
    let last = first;
    for (let r = 0; r < 2 && last.remaining > 0 && last.repaired > 0 && !(opts.deadline && Date.now() > opts.deadline); r++) {
      const nxt = await repairRound(p, questions, objs, opts);
      first.repaired += nxt.repaired; first.failed = nxt.failed; last = nxt;
    }
    return { found: first.found, repaired: first.repaired, failed: last.remaining };
  }
  async function repairRound(p, questions, objs = [], opts = {}) {
    const bad = findBrokenQuestions(questions, { dangling: !!opts.dangling, partPlan: p.partPlan });
    const report = { found: bad.length, repaired: 0, failed: 0, remaining: bad.length };
    let next = 0;
    const lang = langName(String(p.examLanguage || 'en'));
    const worker = async () => {
      while (next < bad.length) {
        const { index, why, mcq } = bad[next++];
        const q = questions[index], isMcq = !!mcq || /^(mcq|multiple)/i.test(q.type || '');
        const objective = q.objective || objs[index]?.text || '';
        const topic = q.topic || objs[index]?.topic || '';
        const prompt = `You are a national-examination item writer for ${p.subject || 'the subject'} (${p.className || 'secondary school'}). ${String(p.examLanguage) === 'so' ? somaliStyle : ''}
Write ONE ${isMcq ? 'multiple-choice question with exactly four options and one correct answer' : 'direct written question with a short model answer'} in ${lang}.
OBJECTIVE: ${objective}
TOPIC: ${topic}
${why === 'dangling-figure' || why === 'duplicate' ? (why === 'duplicate' ? 'This replaces a duplicate question: test a DIFFERENT idea of the same objective in plain text (concept, unit, definition or reasoning). ' : '') + 'IMPORTANT: no figure, diagram, graph or table exists. The question must be fully answerable from the text alone; NEVER refer to any figure/diagram/graph/table/"below"/"above".' : ''}
${isMcq ? 'The stem must be a complete question or sentence to complete (never "Define..." or "Explain..."). Options are short and plausible; wrong options come from typical mistakes. "answer" = A, B, C or D.' : 'The question must be a WRITTEN question (never "which of the following" / "choose" / "true statement" and never an MCQ). ' + (Number(q.marks) >= 6 ? `It is worth ${q.marks} marks, so write it as 2-4 labelled parts (a), (b), (c)... with the marks of each part in brackets adding up to ${q.marks}: mix recall, calculation (with given numbers) and explanation. ` : '') + 'Give a model answer with working, and 2-5 short "keyPoints".'}
${avoidList(questions, index)}Marks: ${q.marks || 1}.
Return ONLY JSON: {"question":"","options":${isMcq ? '["","","",""]' : '[]'},"answer":"","keyPoints":[]}`;
        try {
          let j = null, lastErr = null;
          for (let a = 0; a < 2 && !j; a++) { try { j = await callGeminiJson(prompt, { maxTokens: 2500, temperature: a ? 0.5 : 0.3 }); } catch (e) { lastErr = e; } }
          if (!j) throw lastErr || new Error('AI unavailable');
          const fixed = { ...q, ...(isMcq ? { type: 'MCQ' } : {}), question: String(j.question || '').trim(), answer: String(j.answer || '').trim(), keyPoints: Array.isArray(j.keyPoints) && j.keyPoints.length ? j.keyPoints.map(String) : q.keyPoints };
          if (isMcq) {
            fixed.options = (Array.isArray(j.options) ? j.options : []).map((o) => optionText(String(o)));
            const chk = checkAndRepairMcq(fixed, {});
            if (!chk.ok) throw new Error(chk.issues.join('; '));
            Object.assign(fixed, chk.q);
          } else { fixed.options = []; if (fixed.question.length < 12 || !fixed.answer) throw new Error('structured repair incomplete'); }
          if (why === 'duplicate') { delete fixed.diagramSvg; delete fixed.diagram; delete fixed.diagramPng; delete fixed.figureMeta; }
          delete fixed._fix; delete fixed._fixWhy;
          cleanQuestionMath(fixed);
          if (findBrokenQuestions([fixed], { dangling: true }).length) throw new Error('still broken');
          if (similarToOthers(fixed, questions, index)) throw new Error('still similar to another question');
          questions[index] = fixed; report.repaired++;
        } catch (e) { report.failed++; log.warn?.(`Repair of question ${index + 1} (${why}) failed: ${e.message}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, bad.length) }, worker));
    report.remaining = findBrokenQuestions(questions, { dangling: !!opts.dangling, partPlan: p.partPlan }).length;
    return report;
  }

  function avoidList(questions, index) {
    const L = questions.map((o, i) => (i === index ? null : String(o?.question || o?.text || '').replace(/\s+/g, ' ').slice(0, 90))).filter(Boolean).slice(0, 60);
    return L.length ? `DO NOT repeat or rephrase any of these existing questions (the new question must test a clearly different fact, quantity or situation):\n- ${L.join('\n- ')}\n` : '';
  }

  // Hubin xoog leh: MCQ kasta waxaa si madaxbannaan u xalliya AI (furaha la'aan). Haddii jawaabtiisu ka duwan tahay furaha,
  // haddii laba doorasho ay sax yihiin, ama su'aashu is-diidaysaa -> waxaa lagu calaamadiyaa _fix si loo bedelo.
  async function auditMcqs(p, questions, { max = 12 } = {}) {
    const items = [];
    questions.forEach((q, i) => { const o = Array.isArray(q?.options) ? q.options.map(optionText) : []; if (o.length === 4 && !q.diagramSvg && !q.diagramPng && /^(mcq|multiple)/i.test(q.type || 'mcq')) items.push({ i, q, o }); });
    if (!items.length) return { checked: 0, flagged: 0 };
    const text = items.map((x, k) => `${k + 1}. ${String(x.q.question || x.q.text || '').replace(/\s+/g, ' ')}\n   A. ${x.o[0]}\n   B. ${x.o[1]}\n   C. ${x.o[2]}\n   D. ${x.o[3]}`).join('\n');
    const prompt = `You are a strict external examiner for ${p.subject || 'the subject'} (${p.className || 'secondary school'}). Solve EVERY multiple-choice question below yourself, independently (no answer key is given). For each question return:
- "best": the single best option letter A, B, C or D;
- "also": array of OTHER option letters that are also correct or defensible (empty if exactly one option is correct);
- "problem": "" if the question is sound, otherwise a short reason (data inconsistent or contradictory, no correct option, ambiguous, trick wording, or not about ${p.subject || 'the subject'} but about the curriculum/textbook).
Return ONLY JSON: {"results":[{"n":1,"best":"A","also":[],"problem":""}]}
QUESTIONS:
${text}`;
    let j; try { j = await callGeminiJson(prompt, { maxTokens: 6000, temperature: 0 }); } catch (e) { return { checked: 0, flagged: 0, error: e.message }; }
    const res = Array.isArray(j?.results) ? j.results : [];
    let flagged = 0;
    for (const r of res) {
      const x = items[Number(r.n) - 1]; if (!x || flagged >= max) continue;
      const key = answerIndex({ answer: x.q.answer, options: x.o });
      const best = LETTERS.indexOf(String(r.best || '').toUpperCase().trim()[0]);
      const also = (Array.isArray(r.also) ? r.also : []).filter((l) => LETTERS.includes(String(l).toUpperCase()));
      const bad = (key >= 0 && best >= 0 && best !== key) || also.length > 0 || String(r.problem || '').trim().length > 3;
      if (bad) { x.q._fix = true; x.q._fixWhy = String(r.problem || (also.length ? 'two options correct' : 'key mismatch')).slice(0, 120); flagged++; }
    }
    return { checked: items.length, flagged };
  }

  return { smartFigureStage, visionVerify, repairBroken, auditMcqs };
}

function slimFacts(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) { const s = JSON.stringify(v); if (s && s.length < 400) out[k] = v; }
  return out;
}
