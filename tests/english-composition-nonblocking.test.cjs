const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist`);
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
const context = vm.createContext({
  console, Map, Set, Number, String, Math, Array, RegExp, Object,
  isGroundedInPassage: () => true,
  contentTokens: () => new Set()
});
vm.runInContext(extractFunction('validateEnglishForm4Questions') + '\nthis.validate=validateEnglishForm4Questions;', context);
const validate = context.validate;
function examWithComposition(questionText) {
  const qs = Array.from({length:50}, (_,i) => ({
    type: i < 40 ? 'mcq' : i < 49 ? 'structured' : 'composition',
    options: i < 40 ? ['A','B','C','D'] : undefined,
    question: i === 49 ? questionText : `Question ${i+1}`,
    answer: i < 40 ? 'A' : undefined,
    section: i === 49 ? 'Writing Skills — Composition' : ''
  }));
  return qs;
}
const passage = {title:'A Day at School', text:'Students worked together to improve their school.'};

test('Q50 with two topic choices does not block exam generation', () => {
  const issues = Array.from(validate(examWithComposition('Choose ONE topic. A. My school. B. A helpful neighbour.'), passage, [{count:10}]));
  assert.equal(issues.some(x => /Q50: Composition must offer exactly three/i.test(x)), false);
  assert.equal(issues.some(x => /Q50: Composition instructions must clearly/i.test(x)), false);
});

test('Q50 without explicit choose-one wording does not block exam generation', () => {
  const issues = Array.from(validate(examWithComposition('Write about your school.'), passage, [{count:10}]));
  assert.equal(issues.some(x => /Q50: Composition instructions must clearly/i.test(x)), false);
});
