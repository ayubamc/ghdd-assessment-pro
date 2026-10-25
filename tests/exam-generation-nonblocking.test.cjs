const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const server = fs.readFileSync(new URL('../server.js', `file://${__filename}`).pathname, 'utf8');

test('English exam validation issues are returned as warnings instead of blocking the generated exam', () => {
  assert.match(server, /const validationWarnings=\[\.\.\.pageIssues,\.\.\.englishIssues,\.\.\.objectiveIssues,\.\.\.objectivePageIssues\]/);
  assert.match(server, /Returning exam with validation warnings/);
  assert.match(server, /warnings:validationWarnings\.slice\(0,100\)/);
  assert.doesNotMatch(server, /return res\.status\(422\)\.json\(\{error:'Imtixaanka lama aqbalin: waxaa jira bogag, objectives ama source mappings aan la xaqiijin\./);
});

test('missing objective IDs no longer immediately stop exam generation', () => {
  assert.match(server, /No approved objective IDs matched the current OCR inventory; continuing with warnings/);
  assert.doesNotMatch(server, /if \(!selectedIds\.length\) return res\.status\(422\)/);
});
