const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', f)).href);

test('renderers draw valid, answer-free SVG and compute facts', async () => {
  const { renderFigure, verifySvg } = await load('figure-engine.js');
  const vt = renderFigure('vt_graph', { points: [[0, 0], [20, 60], [30, 60], [40, 0]], ids: ['O', 'K', 'L', 'M'] });
  assert.deepEqual(vt.facts.constant_intervals, [{ from: 'K', to: 'L' }]);
  assert.equal(vt.facts.max_value, 60);
  assert.equal(verifySvg(vt.svg).ok, true, verifySvg(vt.svg).issues.join('|'));
  const wave = renderFigure('wave', { amplitude: 4, period: 30, cycles: 2 });
  assert.equal(wave.facts.amplitude, 4); assert.equal(wave.facts.frequency, 33.33);
  assert.equal(verifySvg(wave.svg).ok, true, verifySvg(wave.svg).issues.join('|'));
  assert.equal(renderFigure('forces', { left: [300], right: [300] }).facts.resultant, 0);
  assert.equal(renderFigure('right_triangle', { a: 6, b: 8 }).facts.hypotenuse, 10);
  assert.equal(renderFigure('resistor_circuit', { mode: 'parallel', values: [6, 12, 4], voltage: 12 }).facts.equivalent_resistance, 2);
  assert.equal(renderFigure('resistor_circuit', { mode: 'series', values: [4, 6], voltage: 12 }).facts.total_current, 1.2);
  assert.equal(renderFigure('logic_gate', { gate: 'nand' }).facts.gate_name, 'NAND');
  assert.throws(() => renderFigure('vt_graph', { points: [[0, 0], [0, 5], [3, 5]] }));
  assert.throws(() => renderFigure('bar_chart', { labels: ['a', 'b', 'c'], values: [5, 5, 3] }), /ugu weyn/);
});

test('verifier catches overlaps, out-of-canvas parts and leaked answers', async () => {
  const { verifySvg } = await load('figure-engine.js');
  const T = (x, y, s, role = 'annot') => `<text x="${x}" y="${y}" font-size="16" text-anchor="middle" data-role="${role}">${s}</text>`;
  const wrap = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect x="10" y="10" width="100" height="50" fill="none" stroke="#000"/><line x1="0" y1="100" x2="300" y2="100" stroke="#000"/><circle cx="200" cy="200" r="20" fill="none" stroke="#000"/>${b}</svg>`;
  assert.equal(verifySvg(wrap(T(300, 200, 'A') + T(400, 200, 'B'))).ok, true);
  assert.match(verifySvg(wrap(T(300, 200, 'Hello') + T(305, 202, 'World'))).issues.join(), /is-qaba/);
  assert.match(verifySvg(wrap('<rect x="600" y="10" width="100" height="40" fill="none" stroke="#000"/>')).issues.join(), /canvas|xad/);
  assert.match(verifySvg(wrap(T(300, 200, 'Mitochondria')), { answerTexts: ['Mitochondria'] }).issues.join(), /jawaabta/);
  assert.equal(verifySvg(wrap(T(300, 200, '40', 'tick')), { expectedNumbers: [40] }).ok, true); // axis numbers are data, not leaks
  assert.match(verifySvg(wrap(T(300, 200, 'Velocity = 40 m/s')), { expectedNumbers: [40] }).issues.join(), /jawaabta/);
  assert.match(verifySvg('<svg viewBox="0 0 640 360"><script>alert(1)</script></svg>').issues.join(), /aan la oggolayn/);
});

test('MCQ answer key is repaired from the figure facts (correct answer must exist and be unique)', async () => {
  const { renderFigure, checkAndRepairMcq } = await load('figure-engine.js');
  const { facts } = renderFigure('vt_graph', { points: [[0, 0], [20, 60], [30, 60], [40, 0]], ids: ['O', 'K', 'L', 'M'] });
  // wrong key: AI says C but the true interval (K to L) is option B
  let r = checkAndRepairMcq({ options: ['Between O and K', 'Between K and L', 'Between L and M', 'Between O and M'], answer: 'C' }, { askFact: 'constant_interval', facts });
  assert.equal(r.q.answer, 'B'); assert.equal(r.repaired, true); assert.equal(r.ok, true);
  // correct answer missing from options: it is rebuilt
  r = checkAndRepairMcq({ options: ['Between O and K', 'Between L and M', 'Between O and M', 'Between K and M'], answer: 'A' }, { askFact: 'constant_interval', facts });
  assert.equal(r.ok, true); assert.match(r.q.options[0], /K.*L/);
  // numeric: two options carry the right number -> one is replaced
  const wave = renderFigure('wave', { amplitude: 4, period: 30, cycles: 2 }).facts;
  r = checkAndRepairMcq({ options: ['4 cm', '4 cm', '2 cm', '8 cm'], answer: 'A' }, { askFact: 'amplitude', facts: wave, unitHint: 'cm' });
  const nums = r.q.options.map((o) => parseFloat(o)); assert.equal(nums.filter((n) => n === 4).length, 1); assert.equal(new Set(nums).size, 4);
  // structure-only issues
  r = checkAndRepairMcq({ options: ['a', 'a', 'b', 'c'], answer: 'A' }, {});
  assert.equal(r.ok, false);
});

test('national profiles + question-kind planner follow the sample papers', async () => {
  const { getProfile, planSlots, chooseKindForObjective, KINDS } = await load('exam-profiles.js');
  assert.equal(getProfile('Physics', 'Form 4').key, 'physics');
  assert.equal(getProfile('Taariikh', 'F4').key, 'history');
  assert.equal(getProfile('Xisaab', '').key, 'math');
  assert.equal(chooseKindForObjective({ profileKey: 'physics', objective: 'Interpret a velocity-time graph', type: 'MCQ' }).figure, 'vt_graph');
  assert.equal(chooseKindForObjective({ profileKey: 'history', objective: 'Explain trend of population data graph', type: 'MCQ' }).kind, KINDS.MCQ_TEXT); // History sample has no figures
  assert.equal(chooseKindForObjective({ profileKey: 'chemistry', objective: 'Calculate the pH of a solution', type: 'MCQ' }).kind, KINDS.MCQ_CALC);
  assert.equal(chooseKindForObjective({ profileKey: 'technology', objective: 'Identify the decision symbol in a flowchart', type: 'MCQ' }).figure, 'flowchart');
  const items = Array.from({ length: 40 }, (_, i) => ({ index: i, type: 'MCQ', objective: 'Interpret velocity-time graph and wave amplitude', topic: '' }));
  const figs = planSlots({ profileKey: 'physics', items, seed: 1 }).filter((s) => s.kind === KINDS.MCQ_FIGURE).length;
  assert.ok(figs >= 14 && figs <= 20, `physics figure count ${figs}`);
  const none = planSlots({ profileKey: 'english', items, seed: 1 }).filter((s) => s.kind === KINDS.MCQ_FIGURE).length;
  assert.equal(none, 0);
});

test('smart stage: replaces figure slots, repairs wrong keys, never ships a broken figure', async () => {
  const { createSmartFigures, buildExamPlan } = await load('smart-figures.js');
  let calls = 0;
  const replies = [
    // slot 1: wrong key (C instead of B) -> repaired
    { spec: { points: [[0, 0], [20, 60], [30, 60], [40, 0]], ids: ['O', 'K', 'L', 'M'] }, askFact: 'constant_interval', unit: '', question: 'Study the figure below. At what interval is the velocity constant?', options: ['Between O and K', 'Between K and L', 'Between L and M', 'Between O and M'], answer: 'C', topic: 't' },
    // slot 2: three bad specs -> fallback
    { spec: { points: [[0, 0]] }, askFact: 'max_value', question: 'x', options: [], answer: 'A' },
    { spec: { points: [[0, 0]] }, askFact: 'max_value', question: 'x', options: [], answer: 'A' },
    { spec: { points: [[0, 0]] }, askFact: 'max_value', question: 'x', options: [], answer: 'A' }
  ];
  const deps = { callGeminiJson: async () => replies[calls++] || replies[replies.length - 1], aiGenerateDiagram: async () => '', splitMarkedPages: () => [], languageNames: {} };
  const sf = createSmartFigures(deps);
  const p = { subject: 'Physics', className: 'Form 4', sourceTitle: 'Physics F4', pageRange: { start: 1, end: 5 }, partPlan: [{ type: 'MCQ', count: 2 }], blueprint: { objectiveInventory: { objectives: [{ id: 'O1', page: 1, text: 'Interpret a velocity-time graph', topic: 'Motion' }] }, coverage: [{ objectiveIds: ['O1'], questionCount: 2 }] } };
  const plan = buildExamPlan(p, 2);
  plan.slots.forEach((s) => Object.assign(s, { kind: 'mcq_figure', figure: 'vt_graph', askFacts: ['constant_interval', 'max_value'], deterministic: true }));
  const questions = [{ question: 'base1', options: ['a', 'b', 'c', 'd'], answer: 'A', type: 'MCQ' }, { question: 'base2', options: ['a', 'b', 'c', 'd'], answer: 'A', type: 'MCQ' }];
  const rep = await sf.smartFigureStage(p, questions, plan);
  assert.equal(questions[0].answer, 'B'); assert.match(questions[0].diagramSvg, /^<svg/); assert.equal(questions[0].figureMeta.answerChecked, true);
  assert.equal(questions[1].question, 'base2'); assert.equal(questions[1].diagramSvg, undefined);
  assert.equal(rep.built, 1); assert.equal(rep.repaired, 1); assert.equal(rep.fallback, 1);
});
