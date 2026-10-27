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
  assert.ok(figs >= 10 && figs <= 20, `physics figure count ${figs}`); // 35-50% target, a bit lower when the same kind would repeat
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

test('broken questions are detected and repaired; figure direction fixed; topology drawn', async () => {
  const { findBrokenQuestions, fixFigureDirection, createSmartFigures } = await load('smart-figures.js');
  const { renderFigure, verifySvg } = await load('figure-engine.js');
  const { getProfile } = await load('exam-profiles.js');
  const qs = [
    { type: 'MCQ', question: 'Define the System Development Life Cycle (SDLC):', options: ['Hargeysa', 'Kismayo', 'Garowe', 'Mogadishu'], answer: 'A' },
    { type: 'MCQ', question: 'What is a database?', options: [], answer: '' },
    { type: 'Structured', question: 'PART IV — DIRECT / STRUCTURED QUESTIONS', options: [] },
    { type: 'MCQ', question: 'Which device connects computers in a LAN?', options: ['Hub', 'Pen', 'Cup', 'Bag'], answer: 'A' },
    { type: 'Structured', question: 'Explain the Waterfall Model.', options: [] }
  ];
  assert.deepEqual(findBrokenQuestions(qs).map((b) => b.index), [0, 1, 2]);
  assert.equal(fixFigureDirection('Study the figure above. Which one?'), 'Study the figure below. Which one?');
  assert.equal(fixFigureDirection('Eeg sawirka kore'), 'Eeg sawirka hoose');
  let n = 0;
  const sf = createSmartFigures({ callGeminiJson: async (pr) => (++n && /four options/.test(pr) ? { question: 'Which term describes the process of building information systems? (' + n + ')', options: ['SDLC', 'Spreadsheet', 'Firewall', 'Router'], answer: 'A', keyPoints: [] } : { question: 'Explain how a query retrieves data from a table.', options: [], answer: 'It filters records.', keyPoints: ['filters', 'returns records'] }), aiGenerateDiagram: async () => '', splitMarkedPages: () => [] });
  const rep = await sf.repairBroken({ subject: 'Technology', examLanguage: 'en' }, qs, []);
  assert.equal(rep.repaired, 3); assert.equal(findBrokenQuestions(qs).length, 0);
  assert.equal(qs[3].options[0], 'Hub'); // good questions untouched
  for (const t of ['star', 'ring', 'bus', 'mesh', 'tree']) { const r = renderFigure('network_topology', { type: t, nodes: 5 }); assert.equal(verifySvg(r.svg).ok, true, t); assert.equal(r.facts.topology_name, t); }
  const tech = getProfile('Technology', 'Form 4');
  assert.equal(tech.style.mcq, 'Choose the Correct answer'); assert.equal(tech.style.letters, 'ABCD'); assert.equal(getProfile('Taariikh', '').style.letters, 'BTJX');
});

test('physics: real symbols (spring, pendulum), varied figure kinds and no dangling figure references', async () => {
  const { renderFigure, verifySvg, checkAndRepairMcq } = await load('figure-engine.js');
  const { planSlots, KINDS } = await load('exam-profiles.js');
  const { findBrokenQuestions } = await load('smart-figures.js');
  const sp = renderFigure('spring_mass', { k: 100, x: 0.05, direction: 'right' });
  assert.equal(sp.facts.restoring_force, 5); assert.equal(sp.facts.potential_energy, 0.125); assert.equal(verifySvg(sp.svg).ok, true, verifySvg(sp.svg).issues.join('|'));
  const pd = renderFigure('pendulum', { length: 1 }); assert.equal(pd.facts.period, 2); assert.equal(verifySvg(pd.svg).ok, true);
  const r = checkAndRepairMcq({ options: ['0.5 N', '5 N', '50 N', '500 N'], answer: 'C' }, { askFact: 'restoring_force', facts: sp.facts });
  assert.equal(r.q.answer, 'B');
  // tight canvas: forces figure is much shorter than the default canvas
  assert.match(renderFigure('forces', { left: [300], right: [300] }).svg, /viewBox="0 0 640 1[0-9]{2}"/);
  const objs = ['Determine the amplitude of a wave from a graph', 'Find the period of a wave', 'Find the frequency of a wave from the graph', 'Calculate the restoring force of a spring', 'State the energy stored in a spring', 'Period of a simple pendulum', 'Interpret velocity-time graph', 'Calculate the resultant force', 'Define sound'];
  const items = Array.from({ length: 40 }, (_, i) => ({ index: i, type: 'MCQ', objective: objs[i % objs.length], topic: '' }));
  const slots = planSlots({ profileKey: 'physics', items, seed: 7 });
  const figs = slots.filter((s) => s.kind === KINDS.MCQ_FIGURE), by = {};
  figs.forEach((s) => { by[s.figure] = (by[s.figure] || 0) + 1; });
  assert.ok(Math.max(...Object.values(by)) <= Math.max(2, Math.ceil(figs.length / 3)), JSON.stringify(by));
  assert.ok(Object.keys(by).length >= 3, JSON.stringify(by));
  const waves = figs.filter((s) => s.figure === 'wave'); assert.ok(new Set(waves.map((s) => s.askFacts[0])).size >= Math.min(2, waves.length));
  const dang = findBrokenQuestions([{ type: 'MCQ', question: 'Study the figure below. What is the frequency?', options: ['a', 'b', 'c', 'd'] }, { type: 'MCQ', question: 'Study the figure below. What is the period?', options: ['a', 'b', 'c', 'd'], diagramSvg: '<svg/>' }], { dangling: true });
  assert.deepEqual(dang.map((b) => b.why), ['dangling-figure']);
});

test('duplicates and position-aware MCQ gaps are detected; wave distance graph gives wavelength', async () => {
  const { findBrokenQuestions } = await load('smart-figures.js');
  const { renderFigure } = await load('figure-engine.js');
  const spec = { kind: 'spring_mass', spec: { k: 150, x: 0.04 } };
  const qs = [
    { type: 'MCQ', question: 'Study the figure below. What is the restoring force?', options: ['a', 'b', 'c', 'd'], figureMeta: spec },
    { type: 'MCQ', question: 'Study the figure below. Determine the force needed to hold it.', options: ['a', 'b', 'c', 'd'], figureMeta: { kind: 'spring_mass', spec: { x: 0.04, k: 150 } } },
    { type: 'Calculation', question: 'A suspended mass makes 40 oscillations in 10 s. Find frequency.', options: [] }
  ];
  const bad = findBrokenQuestions(qs, { partPlan: [{ type: 'MCQ', count: 3 }] });
  assert.deepEqual(bad.map((b) => [b.index, b.why]), [[1, 'duplicate'], [2, 'mcq-without-options']]);
  const r = renderFigure('wave', { amplitude: 4, period: 6, cycles: 2, tUnit: 'm', unit: 'cm' });
  assert.equal(r.facts.wavelength, 6); assert.equal(r.facts.frequency, null);
});

test('figureTarget sets the exact number of figure slots', async () => {
  const { planSlots } = await load('exam-profiles.js');
  const objs = ['pendulum period', 'spring force', 'wave frequency', 'diffraction', 'refraction', 'units', 'energy', 'sound', 'light', 'heat'];
  const items = Array.from({ length: 30 }, (_, i) => ({ index: i, type: i < 25 ? 'MCQ' : 'Structured', objective: objs[i % objs.length] + ' ' + i, topic: 't' }));
  for (const T of [3, 8, 14]) {
    const s = planSlots({ profileKey: 'physics', items, seed: 7, figureTarget: T });
    assert.equal(s.filter((x) => /figure/.test(x.kind)).length, T, 'T=' + T);
  }
});
