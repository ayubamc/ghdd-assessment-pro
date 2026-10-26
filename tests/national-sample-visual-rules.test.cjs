const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const server = fs.readFileSync(new URL('../server.js', `file://${__filename}`).pathname, 'utf8');

test('national sample visual-stimulus rules cover the 12 provided subject areas', () => {
  for (const subject of ['Mathematics', 'Biology', 'Chemistry', 'Physics', 'Geography', 'History', 'Business', 'Technology/ICT', 'Arabic', 'Somali', 'Tarbiya', 'English']) {
    assert.ok(server.includes(subject), `Missing subject visual rule: ${subject}`);
  }
});

test('visual-stimulus guidance preserves monthly selected-page scope and answer secrecy', () => {
  assert.match(server, /MONTHLY exam/);
  assert.match(server, /never print the answer to the question on it/i);
  assert.match(server, /diagrams may be used for MCQs or structured questions/i);
});

test('requested diagram selection can include questions that explicitly refer to a visual', () => {
  assert.match(server, /structured\|direct[\s\S]*diagram\|figure\|image\|picture\|map\|graph\|chart/);
});
