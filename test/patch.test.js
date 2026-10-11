import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPublic } from '../server/load-public.js';

const P = loadPublic('patch.js');
const s = (id, text, done = false) => ({ id, text, done });
const plain = x => JSON.parse(JSON.stringify(x));

test('Diff und Anwenden ergeben die neue Liste', () => {
  const a = [s('1', 'a'), s('2', 'b'), s('3', 'c')];
  const b = [s('3', 'c'), s('1', 'A', true), s('4', 'd')];
  const patch = P.toOps({ steps: a }, { steps: b, name: 'x' });
  assert.equal(patch.name, 'x');
  assert.ok(patch.$ops.length > 0);
  assert.deepEqual(plain(P.applyPatch({ steps: a }, patch).steps), b);
});

test('Gleichzeitige Änderungen gehen nicht verloren', () => {
  const base = { steps: [s('1', 'a'), s('2', 'b')] };
  // Person A hakt Schritt 1 ab, Person B fügt Schritt 3 hinzu – beide auf Basis des alten Stands
  const pa = P.toOps(base, { steps: [s('1', 'a', true), s('2', 'b')] });
  const pb = P.toOps(base, { steps: [s('1', 'a'), s('2', 'b'), s('3', 'c')] });
  const server = P.applyPatch(P.applyPatch(base, pa), pb);
  assert.deepEqual(plain(server.steps), [s('1', 'a', true), s('2', 'b'), s('3', 'c')]);
});

test('Löschen und Ändern desselben Eintrags', () => {
  const base = { bom: [{ id: 'x', qty: 1 }, { id: 'y', qty: 2 }] };
  const del = P.toOps(base, { bom: [{ id: 'y', qty: 2 }] });
  const set = P.toOps(base, { bom: [{ id: 'x', qty: 5 }, { id: 'y', qty: 2 }] });
  const r = P.applyPatch(P.applyPatch(base, del), set);
  assert.deepEqual(plain(r.bom), [{ id: 'y', qty: 2 }]);
});

test('Umsortieren lässt fremde Einträge an ihrem Platz', () => {
  const base = { steps: [s('a', 'own1'), s('d1', 'drop1'), s('b', 'own2'), s('d2', 'drop2')] };
  const r = P.applyOps(base, [{ o: 'order', f: 'steps', ids: ['b', 'a'] }]);
  assert.deepEqual(r.steps.map(x => x.id), ['b', 'd1', 'a', 'd2']);
});

test('Patches zusammenfassen und unbekannte Felder ignorieren', () => {
  const m = P.mergePatch({ name: 'a', $ops: [{ o: 'del', f: 'steps', id: '1' }] }, { status: 'done', $ops: [{ o: 'del', f: 'steps', id: '2' }] });
  assert.equal(m.$ops.length, 2);
  assert.equal(m.name, 'a'); assert.equal(m.status, 'done');
  const r = P.applyOps({ comps: [1] }, [{ o: 'del', f: 'comps', id: 1 }]);
  assert.deepEqual(plain(r), { comps: [1] });
});

test('Entfernte Felder eines Eintrags werden null', () => {
  const p = P.toOps({ bom: [{ id: 'x', drop: true, qty: 1 }] }, { bom: [{ id: 'x', qty: 1 }] });
  assert.deepEqual(plain(p.$ops), [{ o: 'set', f: 'bom', id: 'x', v: { drop: null } }]);
});
