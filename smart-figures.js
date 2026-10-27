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
const DEFINE_STEM = /^\s*(define|explain|describe|discuss|list|outline|state\s+(?:and|two|three|four|five)|qeex|sharax|faahfaahi|taxan|ka hadal|\u0634\u0631\u062d|\u0639\u0631\u0641)\b/i;
const FIG_REF = /\b(figure|diagram|graph|chart|table|picture|map|circuit)\s+(below|above|shown)|\b(below|following)\s+(figure|diagram|graph|chart|circuit)|sawirka\s+(hoose|kor)|jaantuska\s+(hoose|kor)|khariidadda\s+hoose|shaxda\s+hoose/i;
const figSig = (q) => { try { const m = q?.figureMeta; if (!m || !m.spec) return ''; const st = (o) => Array.isArray(o) ? o.map(st) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, st(o[k])])) : o; return m.kind + JSON.stringify(st(m.spec)); } catch (_) { return ''; } };
export function findBrokenQuestions(questions, { dangling = false, partPlan = null } = {}) {
  const bad = [];
  const seenSig = new Map(), seenTxt = new Map();
  questions.forEach((q, i) => {
    const text = String(q?.question || q?.text || '').trim();
    const posMcq = Array.isArray(partPlan) && partPlan.length ? /^(mcq|multiple)/i.test(partTypeAt(partPlan, i)) : false;
    const isMcq = /^(mcq|multiple)/i.test(q?.type || '') || posMcq;
    const opts = Array.isArray(q?.options) ? q.options.map((o) => String(o || '').trim()).filter(Boolean) : [];
    let why = '';
    if (text.length < 8 || (SECTION_LABEL.test(text) && text.length < 90)) why = 'empty-or-section-title';
    else if (dangling && FIG_REF.test(text) && !q?.diagramSvg && !q?.diagramPng && !(q?.diagram && q.diagram !== 'undefined')) why = 'dangling-figure';
    else if (isMcq && opts.length !== 4) why = 'mcq-without-options';
    else if (isMcq && DEFINE_STEM.test(text)) why = 'mcq-is-open-question';
    if (!why) {
      const sig = figSig(q), tx = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if ((sig && seenSig.has(sig)) || (tx.length > 20 && seenTxt.has(tx))) why = 'duplicate';
      else { if (sig) seenSig.set(sig, i); if (tx.length > 20) seenTxt.set(tx, i); }
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
    const bad = findBrokenQuestions(questions, { dangling: !!opts.dangling, partPlan: p.partPlan });
    const report = { found: bad.length, repaired: 0, failed: 0 };
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
${isMcq ? 'The stem must be a complete question or sentence to complete (never "Define..." or "Explain..."). Options are short and plausible; wrong options come from typical mistakes. "answer" = A, B, C or D.' : 'The question must be complete (never a section title). Give 2-5 short "keyPoints".'}
Marks: ${q.marks || 1}.
Return ONLY JSON: {"question":"","options":${isMcq ? '["","","",""]' : '[]'},"answer":"","keyPoints":[]}`;
        try {
          const j = await callGeminiJson(prompt, { maxTokens: 1500, temperature: 0.3 });
          const fixed = { ...q, ...(isMcq ? { type: 'MCQ' } : {}), question: String(j.question || '').trim(), answer: String(j.answer || '').trim(), keyPoints: Array.isArray(j.keyPoints) && j.keyPoints.length ? j.keyPoints.map(String) : q.keyPoints };
          if (isMcq) {
            fixed.options = (Array.isArray(j.options) ? j.options : []).map((o) => optionText(String(o)));
            const chk = checkAndRepairMcq(fixed, {});
            if (!chk.ok) throw new Error(chk.issues.join('; '));
            Object.assign(fixed, chk.q);
          } else { fixed.options = []; if (fixed.question.length < 12 || !fixed.answer) throw new Error('structured repair incomplete'); }
          if (why === 'duplicate') { delete fixed.diagramSvg; delete fixed.diagram; delete fixed.diagramPng; delete fixed.figureMeta; }
          if (findBrokenQuestions([fixed], { dangling: true }).length) throw new Error('still broken');
          questions[index] = fixed; report.repaired++;
        } catch (e) { report.failed++; log.warn?.(`Repair of question ${index + 1} (${why}) failed: ${e.message}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, bad.length) }, worker));
    return report;
  }

  return { smartFigureStage, visionVerify, repairBroken };
}

function slimFacts(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) { const s = JSON.stringify(v); if (s && s.length < 400) out[k] = v; }
  return out;
}
