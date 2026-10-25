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
const context = vm.createContext({
  console, Map, Set, Number, String, Math, Array, RegExp, Object,
  isGroundedInPassage: () => true,
  contentTokens: () => new Set()
});
vm.runInContext(extractFunction('validateEnglishForm4Questions') + '\nthis.api={validateEnglishForm4Questions};', context);
const validate = context.api.validateEnglishForm4Questions;
const passage = {title:'A community story', text:'A short passage about a community.'};

test('MCQ option-count mismatch no longer blocks exam generation', () => {
  const questions = [{type:'mcq', question:'Choose the correct word.', options:['A','B'], answer:'A'}];
  const issues = Array.from(validate(questions, passage, [{count:0}]));
  assert.equal(issues.some(x => /exactly four options/i.test(x)), false);
});

test('duplicate MCQ options remain detectable', () => {
  const questions = [{type:'mcq', question:'Choose the correct word.', options:['A','A'], answer:'A'}];
  const issues = Array.from(validate(questions, passage, [{count:0}]));
  assert.ok(issues.some(x => /duplicate MCQ options/i.test(x)));
});
