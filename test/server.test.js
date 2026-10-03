import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../server/identify.js';
import { makeToken, tokenValid, passwordMatches } from '../server/auth.js';

test('extractJson liest reines JSON', () => {
  assert.deepEqual(extractJson('{"found": true, "name": "LM358"}'), { found: true, name: 'LM358' });
});

test('extractJson liest JSON im Codeblock', () => {
  assert.deepEqual(extractJson('Hier:\n```json\n{"found": false, "note": "x"}\n```'), { found: false, note: 'x' });
});

test('extractJson liest JSON mit Text drumherum und Klammern in Strings', () => {
  assert.deepEqual(extractJson('Ergebnis {"name": "a } b", "pins": ["{"]} fertig'), { name: 'a } b', pins: ['{'] });
});

test('extractJson meldet invalid_json', () => {
  assert.throws(() => extractJson('keine Ahnung'), e => e.code === 'invalid_json');
});

test('Session-Token: gültig, manipuliert, falsches Secret', () => {
  const s = 'x'.repeat(40);
  const t = makeToken(s);
  assert.equal(tokenValid(s, t), true);
  assert.equal(tokenValid(s, t.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))), false);
  assert.equal(tokenValid('y'.repeat(40), t), false);
  assert.equal(tokenValid(s, '1.abc'), false);
  assert.equal(tokenValid(s, null), false);
});

test('Passwortvergleich', () => {
  assert.equal(passwordMatches('geheim', 'geheim'), true);
  assert.equal(passwordMatches('geheim!', 'geheim'), false);
  assert.equal(passwordMatches('', 'geheim'), false);
});
