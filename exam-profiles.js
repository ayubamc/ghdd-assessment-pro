// exam-profiles.js
// Mabda'a 1 + 2 + 3: app-ku wuxuu ogaadaa maadada, qaabka sample-ka qaranka, iyo nooca su'aasha ku habboon casharka.
//
// XOGTA: waxay ka timid 12-ka sample ee Imtixaanka Qaranka F4 2024-2025 (Physics, Chemistry, Biology, Xisaab,
// Geography, Technology, English, Business, History, Soomaali, Arabic, Tarbiya).
//   basis = 'sampled'  -> bogagga maadadan si toos ah ayaa loo eegay (qaab-dhismeedka iyo sawirrada)
//   basis = 'assumed'  -> maadadan si fudud ayaa loo eegay; hubi markaad isticmaalayso
// figureShare = qaybta (min..max) su'aalaha MCQ ee sawirka ku salaysan ee sample-ka laga arkay.

export const OPTION_LETTERS = {
  latin: ['A', 'B', 'C', 'D'],
  somali: ['B', 'T', 'J', 'X'] // Geography, History, Soomaali sample-yada ayaa adeegsaday b / t / j / x
};

// Noocyada su'aasha (Mabda'a 3)
export const KINDS = {
  MCQ_TEXT: 'mcq_text',          // MCQ qoraal ah
  MCQ_FIGURE: 'mcq_figure',      // MCQ sawir ku salaysan (jaantus/graph/circuit/map)
  MCQ_CALC: 'mcq_calc',          // MCQ xisaabin
  MCQ_CODE: 'mcq_code',          // MCQ koodh / UI / flowchart
  MCQ_CHART: 'mcq_chart',        // MCQ jaantus la fasirayo (chart/table/graph xog ah)
  STRUCT_TEXT: 'struct_text',    // su'aal qoraal ah
  STRUCT_CALC: 'struct_calc',    // su'aal xisaabin ah
  STRUCT_FIGURE: 'struct_figure',// su'aal jaantus ku salaysan (label, qor, fasir)
  STRUCT_CODE: 'struct_code'     // su'aal koodh/flowchart/topology
};

// Noocyada sawirka ee uu app-ku si deterministic ah u sameyn karo (sax 100%)
export const DETERMINISTIC_FIGURES = [
  'network_topology', 'spring_mass', 'pendulum', 'vt_graph', 'wave', 'forces', 'right_triangle', 'bar_chart', 'line_chart',
  'pie_chart', 'data_table', 'logic_gate', 'flowchart', 'resistor_circuit', 'coord_line', 'organic_structure'
];
// Noocyada u baahan sawir AI/buug (biology, geography, map)
export const SCHEMATIC_FIGURES = ['labelled_schematic', 'map', 'textbook_diagram'];

const P = (o) => o;

export const NATIONAL_PROFILES = {
  physics: P({
    style: {"mcq": "Choose the correct answer for each of the following", "structured": "Part Two: Direct Questions", "marksWord": "Marks", "letters": "abcd", "suffix": "."},
    label: 'Physics', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 60, marks: 60 }, structured: { marks: 40, count: 8 },
    figureShare: [0.35, 0.5],
    figures: ['vt_graph', 'wave', 'forces', 'spring_mass', 'pendulum', 'resistor_circuit', 'coord_line', 'textbook_diagram'],
    notes: 'MCQ-yada waxaa ku jira v-t graph, wave, circuit, force, sawirro buug'
  }),
  chemistry: P({
    style: {"mcq": "Choose the correct answer for each of the following", "structured": "Part Two: Direct Questions", "marksWord": "Marks", "letters": "abcd", "suffix": "."},
    label: 'Chemistry', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 60, marks: 60 }, structured: { marks: 40, count: 8 },
    figureShare: [0.2, 0.35],
    figures: ['organic_structure', 'labelled_schematic', 'bar_chart', 'data_table', 'textbook_diagram'],
    calcShare: [0.15, 0.3],
    notes: 'Formula qaab, pH/mole xisaabin, jaantus xaaladaha shayga, qaab-dhismeed organic'
  }),
  biology: P({
    style: {"mcq": "Choose the correct answer for each of the following", "structured": "Part Two: Direct Questions", "marksWord": "Marks", "letters": "abcd", "suffix": "."},
    label: 'Biology', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 60, marks: 60 }, structured: { marks: 40, count: 8 },
    figureShare: [0.25, 0.4],
    figures: ['labelled_schematic', 'textbook_diagram', 'bar_chart', 'data_table'],
    notes: 'Jaantus unugyada, maqaarka, neuron, ubaxa, sawirro qalab (PCR) - badanaa sawir buug'
  }),
  math: P({
    style: {"mcq": "Choose the correct answer for each of the following", "structured": "Part Two: Direct Questions", "marksWord": "Marks", "letters": "abcd", "suffix": "."},
    label: 'Mathematics', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 60, marks: 60 }, structured: { marks: 40, count: 8 },
    figureShare: [0.1, 0.2],
    calcShare: [0.5, 0.75],
    figures: ['coord_line', 'right_triangle', 'bar_chart', 'data_table'],
    notes: 'Badanaa xisaabin; calculus, complex numbers, probability, sets; sawir yar'
  }),
  geography: P({
    style: {"mcq": "B. Goobo geli jawaabta saxda ah", "structured": "QAYBTA 2AAD EE IMTIXAANKA", "marksWord": "Dhibcood", "letters": "btjx", "suffix": "."},
    label: 'Geography', basis: 'sampled', language: 'so', letters: 'somali',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 12 },
    figureShare: [0.08, 0.2],
    figures: ['map', 'textbook_diagram', 'bar_chart', 'line_chart', 'pie_chart', 'data_table'],
    notes: 'Khariidad Soomaaliya/Afrika, sawir tamar dabeyl, volcano; xisaabin cufnaan (qof/km²)'
  }),
  technology: P({
    style: {"mcq": "Choose the Correct answer", "structured": "PART TWO: STRUCTURED QUESTIONS", "marksWord": "Marks", "letters": "ABCD", "suffix": ")"},
    label: 'Technology', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 8 },
    figureShare: [0.12, 0.25],
    figures: ['flowchart', 'network_topology', 'data_table', 'logic_gate', 'textbook_diagram'],
    codeShare: [0.15, 0.3],
    notes: 'Flowchart, UI Word/Excel/PowerPoint, topology, binary, koodh (compiler, errors)'
  }),
  english: P({
    style: {"mcq": "SECTION ONE: Multiple choice questions", "structured": "SECTION TWO: ANSWER THESE QUESTIONS", "marksWord": "Marks", "letters": "ABCD", "suffix": ")"},
    label: 'English', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 10 },
    figureShare: [0, 0], figures: [],
    passage: true,
    notes: 'Passage (Q1-10) + Grammar + Literature + Vocabulary; sawir ma jiro'
  }),
  business: P({
    style: {"mcq": "A. CIRCLE THE CORRECT ANSWER", "structured": "SECTION 2: DIRECT QUESTIONS", "marksWord": "Points", "letters": "ABCD", "suffix": "."},
    label: 'Business', basis: 'sampled', language: 'en', letters: 'latin',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 6 },
    figureShare: [0.1, 0.22],
    calcShare: [0.1, 0.2],
    figures: ['line_chart', 'data_table', 'bar_chart', 'textbook_diagram'],
    notes: 'Supply curve, income statement, liability xisaabin, sawirro xafiis; jadwal demand/supply'
  }),
  history: P({
    style: {"mcq": "B. Goobo geli jawaabta saxda ah", "structured": "QAYBTA 2AAD EE IMTIXAANKA", "marksWord": "Dhibcood", "letters": "BTJX", "suffix": ")"},
    label: 'History', basis: 'sampled', language: 'so', letters: 'somali',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 15 },
    figureShare: [0, 0.03], figures: [],
    notes: 'MCQ qoraal ah oo keliya (taariikh, sanado, magacyo); sawir ma jiro'
  }),
  somali: P({
    style: {"mcq": "B. Goobo geli jawaabta saxda ah", "structured": "Qaybta 2aad: Curis", "marksWord": "Dhibcood", "letters": "btjx", "suffix": "."},
    label: 'Soomaali', basis: 'sampled', language: 'so', letters: 'somali',
    mcq: { count: 40, marks: 80 }, structured: { marks: 20, count: 2 },
    figureShare: [0, 0], figures: [],
    passage: true,
    notes: 'Qaybta 1aad: qiidcada + MCQ luqad (40 su\'aal = 80 dhibcood); Qaybta 2aad: curis 20 dhibcood'
  }),
  arabic: P({
    style: {"mcq": "اختر الإجابة الصحيحة", "structured": "القسم الثاني: الأسئلة المباشرة", "marksWord": "درجة", "letters": "ABCD", "suffix": ")"},
    label: 'Arabic', basis: 'assumed', language: 'ar', letters: 'latin',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 10 },
    figureShare: [0, 0.05], figures: [],
    notes: 'La qiyaasay: MCQ + qoraal; hubi sample-ka'
  }),
  tarbiya: P({
    style: {"mcq": "Dooro jawaabta saxda ah", "structured": "Qaybta 2aad: Su'aalaha toosan", "marksWord": "Dhibcood", "letters": "ABCD", "suffix": ")"},
    label: 'Tarbiya Islaamiga', basis: 'assumed', language: 'so', letters: 'latin',
    mcq: { count: 40, marks: 40 }, structured: { marks: 60, count: 10 },
    figureShare: [0, 0.03], figures: [],
    notes: 'La qiyaasay: MCQ + qoraal; hubi sample-ka'
  })
};

const SUBJECT_PATTERNS = [
  ['physics', /phys|fiisi|فيزياء/i],
  ['chemistry', /chem|kimis|كيمياء/i],
  ['biology', /biolog|bayooloj|أحياء/i],
  ['math', /math|xisaab|رياضيات/i],
  ['geography', /geograph|jugraaf|جغرافيا/i],
  ['technology', /technolog|tiknooloj|computer|ict|\bit\b|تقنية/i],
  ['english', /english|ingiriis/i],
  ['business', /business|ganacsi|تجارة/i],
  ['history', /histor|taariikh|تاريخ/i],
  ['somali', /soomaali|somali(?!a\b)/i],
  ['arabic', /arab|carab|عربي/i],
  ['tarbiya', /tarbiy|islaam|islam|تربية/i]
];

export function detectSubject(subject = '', className = '', sourceTitle = '') {
  const hay = `${subject} ${sourceTitle} ${className}`;
  for (const [key, re] of SUBJECT_PATTERNS) if (re.test(hay)) return key;
  return '';
}

export function getProfile(subject, className, sourceTitle) {
  const key = detectSubject(subject, className, sourceTitle);
  return key ? { key, ...NATIONAL_PROFILES[key] } : null;
}

// ---- Mabda'a 3: nooca su'aasha ee casharka ku habboon ---------------------------------------------------------
// Ujeeddada (objective) iyo ereyga ficilka ayaa go'aamiya nooca su'aasha + nooca sawirka.
const FIGURE_RULES = [
  // [subjects, regex on objective/topic, figureKind, askFacts]
  [['physics'], /pendulum/i, 'pendulum', ['period', 'frequency']],
  [['physics'], /spring|hooke|restoring force|elastic potential|mass-?spring/i, 'spring_mass', ['restoring_force', 'potential_energy']],
  [['physics'], /velocity.?time|v-?t graph|speed.?time|displacement.?time|acceler|uniform motion|kinematic|dhaqdhaqaaq/i, 'vt_graph', ['constant_interval', 'max_value', 'acceleration']],
  [['physics'], /amplitude|wavelength|frequency|period|wave|hirar|mowjad|sound|light wave/i, 'wave', ['amplitude', 'period', 'frequency', 'wavelength']],
  [['physics'], /resultant|net force|balanced|unbalanced|tug|newton'?s (first|second|third)|force/i, 'forces', ['resultant', 'direction']],
  [['physics'], /series|parallel|resist|ohm|circuit|current|voltage|potential diff/i, 'resistor_circuit', ['equivalent_resistance', 'total_current']],
  [['physics', 'technology'], /logic gate|and gate|or gate|not gate|\bnand\b|\bnor\b|boolean|digital electronics/i, 'logic_gate', ['gate_name']],
  [['technology'], /topology|network layout|star network|ring network|bus network|mesh network|hub and switch/i, 'network_topology', ['topology_name']],
  [['technology'], /flow ?chart|algorithm|decision symbol|process symbol|program flow|pseudocode/i, 'flowchart', ['symbol_type']],
  [['math', 'physics'], /straight line|gradient|slope|linear (graph|equation)|y ?= ?mx|coordinate/i, 'coord_line', ['gradient', 'y_intercept']],
  [['math'], /pythag|hypotenuse|right.?angle|trigonomet|triangle/i, 'right_triangle', ['hypotenuse', 'area', 'perimeter']],
  [['chemistry'], /branch|isomer|structural formula|displayed formula|hydrocarbon|alkane|alkene|alkyne|alcohol|carboxylic|organic|functional group|homologous|ester|aldehyde|ketone|iupac|nomenclature|carbon compound/i, 'organic_structure', ['iupac_name', 'molecular_formula', 'carbon_count', 'hydrogen_count', 'longest_chain', 'branch_count', 'functional_group']],
  [['business', 'geography', 'history', 'chemistry', 'biology', 'math'], /trend|compare|data|statistic|bar chart|graph|chart|production|rainfall|population|sales|profit|price|demand|supply/i, 'bar_chart', ['max_label', 'min_label', 'total', 'difference']],
  [['geography', 'business'], /pie|percentage share|proportion/i, 'pie_chart', ['largest_share', 'smallest_share']],
  [['business', 'technology', 'geography'], /table|income statement|balance sheet|schedule/i, 'data_table', ['cell_lookup', 'column_total']],
  [['biology', 'chemistry', 'geography'], /label|parts? of|structure of|diagram|cell|organ|neuron|flower|skin|heart|map|region|volcano|rock cycle/i, 'labelled_schematic', ['part_identification']]
];

const CALC_RX = /calculate|compute|solve|find the (value|area|volume|mass|force|speed|density|ph|concentration|molar)|evaluate|differentiate|integrate|simplify|probability|xisaabi|ka dhig/i;
const CODE_RX = /flow ?chart|algorithm|program|code|binary|compiler|software|hardware|network|topology|excel|word|powerpoint|database|html|python|ip address|osi|security|malware/i;
const WRITTEN_RX = /explain|describe|discuss|compare|differenti|outline|justify|evaluate|importance|advantages|disadvantages|fasir|sharax|qor|xus/i;

function seededRand(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function hashStr(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// Go'aami nooca su'aasha ee u dhigma ujeeddo gaar ah.
export function chooseKindForObjective({ profileKey, objective = '', topic = '', type = 'MCQ', bloom = '' }) {
  const text = `${objective} ${topic}`;
  const isMcq = /mcq|multiple/i.test(type);
  const prof = NATIONAL_PROFILES[profileKey] || null;
  const allowed = prof ? new Set(prof.figures) : new Set();
  let figure = null, facts = [];
  for (const [subjects, rx, kind, askFacts] of FIGURE_RULES) {
    if (!subjects.includes(profileKey)) continue;
    if (!rx.test(text)) continue;
    // Kaliya sawirrada ku jira profile-ka maadada ayaa la isticmaalaa (tusaale History/English sawir ma yeelan)
    const okKind = allowed.has(kind) || (kind === 'labelled_schematic' && (allowed.has('textbook_diagram') || allowed.has('map')));
    if (!okKind) continue;
    figure = kind; facts = askFacts; break;
  }
  if (figure === 'labelled_schematic' && prof && !allowed.has('labelled_schematic') && !allowed.has('textbook_diagram')) figure = null;
  const calc = CALC_RX.test(text);
  const code = CODE_RX.test(text) && profileKey === 'technology';
  if (isMcq) {
    if (figure) return { kind: KINDS.MCQ_FIGURE, figure, askFacts: facts, deterministic: DETERMINISTIC_FIGURES.includes(figure) };
    if (calc) return { kind: KINDS.MCQ_CALC };
    if (code) return { kind: KINDS.MCQ_CODE };
    return { kind: KINDS.MCQ_TEXT };
  }
  if (figure && !WRITTEN_RX.test(text)) return { kind: KINDS.STRUCT_FIGURE, figure, askFacts: facts, deterministic: DETERMINISTIC_FIGURES.includes(figure) };
  if (calc) return { kind: KINDS.STRUCT_CALC };
  if (code) return { kind: KINDS.STRUCT_CODE };
  return { kind: KINDS.STRUCT_TEXT };
}

// Qorshee dhammaan su'aalaha: sample-ka qaranka ayaa go'aaminaya TIRADA sawirrada; casharku wuxuu go'aaminayaa NOOCA.
// items: [{index, type, objective, topic}]
// Sawirka waa inuu ku habboonaa mawduuca su'aasha (tusaale: circuit-ka resistor-ka ma gelayo imtixaanka mowjadaha)
const FIG_TOPIC = { organic_structure: /organic|hydrocarbon|alkane|alkene|alkyne|alcohol|carboxyl|isomer|branch|functional|homologous|ester|aldehyde|ketone|carbon|iupac|structural/i, resistor_circuit: /circuit|current|resistor|resistance|voltage|ohm|electric|electron|charge/i, spring_mass: /spring|oscillat|harmonic|hooke|vibrat|period|elastic/i, pendulum: /pendulum|oscillat|harmonic|period|gravity/i, wave: /wave|sound|frequency|wavelength|light|period|amplitude|ultrasound|echo|seismic/i, vt_graph: /motion|velocity|speed|accelerat|kinematic|displacement|distance/i, forces: /force|newton|friction|weight|equilibrium|moment|pressure/i };
const figFits = (f, it) => { const re = FIG_TOPIC[f]; if (!re) return true; return re.test(`${it?.objective || ''} ${it?.topic || ''}`); };
export function planSlots({ profileKey, items, seed = 1, figureTarget = 0 }) {
  const prof = NATIONAL_PROFILES[profileKey] || null;
  const rnd = seededRand(hashStr(`${profileKey}:${seed}:${items.length}`));
  const mcqs = items.filter((x) => /mcq|multiple/i.test(x.type || ''));
  const slots = items.map((it) => ({ index: it.index, ...chooseKindForObjective({ profileKey, ...it }) }));
  if (!prof) return slots;

  // 1) Tirada sawirrada MCQ: ku dhaw sample-ka qaranka (figureShare)
  const [lo, hi] = prof.figureShare || [0, 0];
  const targetFigs = mcqs.length ? Math.round(mcqs.length * (lo + (hi - lo) * rnd())) : 0;
  const figSlots = slots.filter((s) => s.kind === KINDS.MCQ_FIGURE);
  // Ka jar haddii casharku ku dhex yaalo sawirro ka badan inta sample-ku sheegayo
  if (figSlots.length > targetFigs) {
    const drop = figSlots.slice(targetFigs).filter((_, i) => i % 1 === 0);
    for (const s of drop) { s.kind = KINDS.MCQ_TEXT; delete s.figure; delete s.askFacts; delete s.deterministic; }
  }
  // 2b) Kala-duwanaansho: hal nooc sawir ma badnaan karo (sample-ka qaranka wuxuu isku daraa noocyo kala duwan)
  const capKind = () => Math.max(2, Math.ceil(slots.filter((x) => x.kind === KINDS.MCQ_FIGURE).length / 3));
  const used = {}; const detPool = prof.figures.filter((f) => DETERMINISTIC_FIGURES.includes(f));
  for (const sl of slots.filter((x) => x.kind === KINDS.MCQ_FIGURE)) {
    used[sl.figure] = (used[sl.figure] || 0) + 1;
    if (used[sl.figure] > capKind()) {
      used[sl.figure]--;
      const alt = detPool.filter((f) => f !== sl.figure && (used[f] || 0) < capKind()).sort((x, y) => (used[x] || 0) - (used[y] || 0))[0];
      if (alt && sl.forced) { sl.figure = alt; sl.askFacts = defaultFacts(alt); sl.deterministic = true; used[alt] = (used[alt] || 0) + 1; }
      else { sl.kind = KINDS.MCQ_TEXT; delete sl.figure; delete sl.askFacts; delete sl.deterministic; }
    }
  }
  // 2) Haddii ay yar yihiin, ka dhig kuwa u dhow sawir (kaliya haddii maadadu sawir leedahay)
  const have = slots.filter((s) => s.kind === KINDS.MCQ_FIGURE).length;
  if (have < targetFigs && prof.figures.length) {
    const preferred = prof.figures.filter((f) => DETERMINISTIC_FIGURES.includes(f));
    const pool = slots.filter((s) => s.kind === KINDS.MCQ_TEXT || s.kind === KINDS.MCQ_CALC);
    let need = targetFigs - have;
    // kala firdhi: ha la isku xirin su'aalo is-xigta
    for (let i = 0; i < pool.length && need > 0; i += Math.max(1, Math.floor(pool.length / (need + 1)))) {
      const s = pool[i]; if (!s || s.kind === KINDS.MCQ_FIGURE) continue;
      const cnt = (k) => slots.filter((x) => x.figure === k).length;
      const okPref = preferred.filter((g) => figFits(g, items[s.index]));
      const f = okPref.length ? [...okPref].sort((x, y) => cnt(x) - cnt(y) || rnd() - 0.5)[0] : null;
      if (!f) continue;
      Object.assign(s, { kind: KINDS.MCQ_FIGURE, figure: f, askFacts: defaultFacts(f), deterministic: DETERMINISTIC_FIGURES.includes(f), forced: true });
      need--;
    }
  }
  // Mid kasta oo isku nooc ah wuxuu su'aal kala duwan ka weydiinayaa (amplitude, ka dibna period, ...) iyo qiimayaal kala duwan
  const seenKind = {};
  for (const sl of slots.filter((x) => x.figure && /figure/.test(x.kind))) {
    const n = (seenKind[sl.figure] = (seenKind[sl.figure] || 0) + 1); sl.variant = n;
    const f = sl.askFacts || []; if (f.length > 1) { const r = (n - 1) % f.length; sl.askFacts = [...f.slice(r), ...f.slice(0, r)]; }
  }
  // 3) Su'aalaha qoran (structured): sawirrada ha ka badnaan ~25% (sample-ka qaranka sawirrada badankoodu waa MCQ)
  const structFig = slots.filter((s) => s.kind === KINDS.STRUCT_FIGURE);
  const structTotal = slots.filter((s) => /^struct/.test(s.kind)).length || 1;
  const maxStructFig = prof.figureShare[1] > 0.1 ? Math.max(1, Math.round(structTotal * 0.25)) : (prof.figureShare[1] > 0 ? 1 : 0);
  structFig.slice(maxStructFig).forEach((s) => { s.kind = KINDS.STRUCT_TEXT; delete s.figure; delete s.askFacts; delete s.deterministic; });
  // 4) Macallinku wuxuu dejiyay tirada sawirrada -> imtixaanku wuxuu sameeyaa TIRADAAS saxda ah (kala firdhisan)
  const T = Math.max(0, Math.floor(Number(figureTarget) || 0));
  if (T > 0) {
    const isFig = (s) => s.kind === KINDS.MCQ_FIGURE || s.kind === KINDS.STRUCT_FIGURE;
    const pick = (arr, n) => { const out = []; for (let i = 0; i < n && i < arr.length; i++) out.push(arr[Math.min(arr.length - 1, Math.floor((i + 0.5) * arr.length / n))]); return [...new Set(out)]; };
    const figs = slots.filter(isFig);
    if (figs.length > T) {
      const keep = new Set(pick(figs, T));
      for (const s of figs) if (!keep.has(s)) { s.kind = s.kind === KINDS.STRUCT_FIGURE ? KINDS.STRUCT_TEXT : KINDS.MCQ_TEXT; delete s.figure; delete s.askFacts; delete s.deterministic; }
    } else if (figs.length < T) {
      const det = prof.figures.filter((f) => DETERMINISTIC_FIGURES.includes(f));
      const cnt = (k) => slots.filter((x) => x.figure === k).length;
      let need = T - figs.length;
      for (const kindSet of [[KINDS.MCQ_TEXT, KINDS.MCQ_CALC], [KINDS.STRUCT_TEXT]]) {
        if (need <= 0) break;
        const pool = slots.filter((s) => kindSet.includes(s.kind));
        for (const s of pick(pool, pool.length)) {
          if (need <= 0) break;
          const okDet = det.filter((g) => figFits(g, items[s.index]));
          const f = okDet.length ? [...okDet].sort((x, y) => cnt(x) - cnt(y) || rnd() - 0.5)[0] : null;
          if (!f) continue;
          Object.assign(s, { kind: kindSet[0] === KINDS.STRUCT_TEXT ? KINDS.STRUCT_FIGURE : KINDS.MCQ_FIGURE, figure: f, askFacts: defaultFacts(f), deterministic: DETERMINISTIC_FIGURES.includes(f), forced: true });
          need--;
        }
      }
    }
    const seen2 = {};
    for (const sl of slots.filter((x) => x.figure && /figure/.test(x.kind))) { const n = (seen2[sl.figure] = (seen2[sl.figure] || 0) + 1); sl.variant = n; const f = sl.askFacts || []; if (f.length > 1) { const r = (n - 1) % f.length; sl.askFacts = [...f.slice(r), ...f.slice(0, r)]; } }
  }
  return slots;
}

export function defaultFacts(figure) {
  const rule = FIGURE_RULES.find((r) => r[2] === figure);
  return rule ? rule[3] : [];
}

export function describeSlot(slot) {
  const tag = {
    [KINDS.MCQ_TEXT]: 'MCQ qoraal ah (sawir la\'aan)',
    [KINDS.MCQ_FIGURE]: `MCQ sawir ku salaysan (${slot.figure})`,
    [KINDS.MCQ_CALC]: 'MCQ xisaabin (tallaabo yar, jawaab tiro ah)',
    [KINDS.MCQ_CODE]: 'MCQ koodh / flowchart / UI',
    [KINDS.MCQ_CHART]: 'MCQ jaantus xog',
    [KINDS.STRUCT_TEXT]: 'su\'aal qoraal ah',
    [KINDS.STRUCT_CALC]: 'su\'aal xisaabin oo tallaabo-tallaabo ah',
    [KINDS.STRUCT_FIGURE]: `su'aal sawir ku salaysan (${slot.figure})`,
    [KINDS.STRUCT_CODE]: 'su\'aal koodh / flowchart'
  }[slot.kind];
  return tag || slot.kind;
}
