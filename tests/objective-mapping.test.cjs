const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist in server.js`);
  const signatureEnd = source.indexOf(') {', start);
  const brace = signatureEnd + 2;
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = brace; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}
const names = ['parsePageRefs','normalizeBlueprintObjectiveSelection','validateBlueprintObjectiveCoverage','validateQuestionObjectiveCoverage','validateQuestionObjectivePageMatch'];
const context = vm.createContext({console, Map, Set, Number, String, Math, Array, RegExp, Object});
vm.runInContext(names.map(extractFunction).join('\n') + '\nthis.api={' + names.map(n => `${n}:${n}`).join(',') + '};', context);
const api = context.api;

function inventory(n = 20) {
  return {start:3,end:84,pageCount:82,objectives:Array.from({length:n},(_,i)=>({id:`P${3+Math.floor(i/3)}-O${i%3+1}`,page:3+Math.floor(i/3),unit:`Unit ${Math.floor(i/3)+1}`,topic:`Topic ${Math.floor(i/3)+1}`,text:`Objective measurable skill ${i+1}`}))};
}

test('selected objective count never exceeds question count and inventory remains complete', () => {
  const inv = inventory(24);
  const bp = {coverage:[
    {topic:'Topic 1',sourcePages:'3',questionCount:2,marks:2,objectiveIds:['P3-O1'],learningOutcomes:['Objective measurable skill 1']},
    {topic:'Topic 2',sourcePages:'4-5',questionCount:1,marks:1,objectiveIds:[],learningOutcomes:['Objective measurable skill']},
    {topic:'Topic 3',sourcePages:'6',questionCount:1,marks:1,objectiveIds:['INVALID'],learningOutcomes:['Objective measurable skill']}
  ]};
  const report = api.normalizeBlueprintObjectiveSelection(bp, inv, 4, {});
  assert.equal(inv.objectives.length, 24);
  assert.ok(report.selectedObjectiveCount <= 4);
  assert.equal(new Set(bp.coverage.flatMap(r=>r.objectiveIds)).size, report.selectedObjectiveCount);
  for (const row of bp.coverage) for (const id of row.objectiveIds) assert.ok(inv.objectives.some(o=>o.id===id));
  assert.deepEqual(Array.from(api.validateBlueprintObjectiveCoverage(bp, inv, 4)), []);
});

test('unused curriculum objectives do not cause Blueprint rejection', () => {
  const inv = inventory(30);
  const bp = {coverage:[{topic:'Selected topic',questionCount:2,objectiveIds:['P3-O1'],sourcePages:'3'}]};
  assert.deepEqual(Array.from(api.validateBlueprintObjectiveCoverage(bp, inv, 2)), []);
});

test('question mapping accepts reuse of an approved objective but rejects unselected IDs', () => {
  const inv = inventory(6);
  const bp = {coverage:[{objectiveIds:['P3-O1'],questionCount:3}]};
  const repeated = [{objectiveIds:['P3-O1']},{objectiveIds:['P3-O1']}];
  assert.deepEqual(Array.from(api.validateQuestionObjectiveCoverage(repeated, inv, bp)), []);
  const bad = [{objectiveIds:['P4-O1']}];
  assert.match(Array.from(api.validateQuestionObjectiveCoverage(bad, inv, bp)).join(' '), /not selected in the approved Blueprint/);
});

test('objective page matching rejects invented or missing source page references', () => {
  const inv = inventory(6);
  assert.deepEqual(Array.from(api.validateQuestionObjectivePageMatch([{objectiveIds:['P3-O1'],sourcePages:'3'}], inv)), []);
  assert.match(Array.from(api.validateQuestionObjectivePageMatch([{objectiveIds:['P3-O1'],sourcePages:'4'}], inv)).join(' '), /missing PDF\/OCR page/);
});

test('PDF/OCR page ranges expand every page inclusively', () => {
  assert.deepEqual(Array.from(api.parsePageRefs('3, 7–9, 12 to 13')), [3,7,8,9,12,13]);
});

test('English Form 4 composition formatting is not a hard validation gate', () => {
  // Q50 must remain a Composition question, but wording/number-of-topic-label checks
  // must not reject the whole exam; these are advisory generation preferences only.
  assert.match(source, /Q50: must be the Composition question\./);
  assert.doesNotMatch(source, /Q50: Composition must offer exactly three clearly labelled topic choices/);
  assert.doesNotMatch(source, /Q50: Composition instructions must clearly tell the student to choose ONE topic/);
});
