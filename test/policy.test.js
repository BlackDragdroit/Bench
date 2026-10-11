import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pol from '../server/policy.js';

const owner = { kind: 'owner' };
const guest = { kind: 'guest', inviteId: 'inv1', projectId: 'P', allowAi: false };
const aiGuest = { ...guest, allowAi: true };
const denies = fn => assert.throws(fn, e => e.status === 403);

test('Besitzer darf alles', () => {
  assert.equal(pol.canRead(owner, 'drops', 'state', {}), true);
  pol.checkWrite(owner, 'parts', 'x', 'delete', {}, null);
  pol.checkWrite(owner, 'projects', 'Q', 'set', null, {});
  pol.checkFeature(owner, 'ai'); pol.checkFeature(owner, 'drop');
  assert.deepEqual(pol.listScope(owner, 'drops', null), { where: null });
});

test('Gast sieht nur sein Projekt und dessen Skizzen', () => {
  assert.equal(pol.canRead(guest, 'projects', 'P'), true);
  assert.equal(pol.canRead(guest, 'projects', 'Q'), false);
  assert.equal(pol.canRead(guest, 'sketches', 's', { projectId: 'P' }), true);
  assert.equal(pol.canRead(guest, 'sketches', 's', { projectId: 'Q' }), false);
  assert.equal(pol.canRead(guest, 'sketches', 's', null), false);
  assert.equal(pol.canRead(guest, 'parts', 'x', {}), true);
  assert.equal(pol.canRead(guest, 'drops', 'state', {}), false);
  const ps = pol.listScope(guest, 'projects', null);
  assert.equal(ps.keep({ id: 'P' }), true); assert.equal(ps.keep({ id: 'Q' }), false);
  assert.deepEqual(pol.listScope(guest, 'sketches', null).where, { field: 'projectId', value: 'P' });
  denies(() => pol.listScope(guest, 'sketches', { field: 'projectId', value: 'Q' }));
  denies(() => pol.listScope(guest, 'sketches', { field: 'name', value: 'x' }));
  denies(() => pol.listScope(guest, 'drops', null));
  denies(() => pol.listScope(guest, 'assets', null));
});

test('Gast darf sein Projekt ändern, aber nicht anlegen oder löschen', () => {
  pol.checkWrite(guest, 'projects', 'P', 'update', { name: 'x' }, { steps: [] });
  denies(() => pol.checkWrite(guest, 'projects', 'Q', 'update', {}, {}));
  denies(() => pol.checkWrite(guest, 'projects', 'P', 'set', {}, {}));
  denies(() => pol.checkWrite(guest, 'projects', 'P', 'delete', {}, null));
});

test('Gast darf die Bibliothek nicht ändern und keine Drop-Daten', () => {
  for (const m of ['set', 'update', 'delete']) {
    denies(() => pol.checkWrite(guest, 'parts', 'x', m, { stock: 3 }, { stock: 9 }));
    denies(() => pol.checkWrite(guest, 'drops', 'state', m, {}, {}));
  }
});

test('Skizzen: nur im geteilten Projekt anlegen, ändern, löschen', () => {
  pol.checkWrite(guest, 'sketches', 'n', 'set', null, { projectId: 'P' });
  pol.checkWrite(guest, 'sketches', 's', 'update', { projectId: 'P' }, { name: 'y' });
  pol.checkWrite(guest, 'sketches', 's', 'delete', { projectId: 'P' }, null);
  denies(() => pol.checkWrite(guest, 'sketches', 'n', 'set', null, { projectId: 'Q' }));
  denies(() => pol.checkWrite(guest, 'sketches', 'n', 'set', null, {}));
  denies(() => pol.checkWrite(guest, 'sketches', 's', 'set', { projectId: 'Q' }, { projectId: 'P' }));   // fremde Skizze übernehmen
  denies(() => pol.checkWrite(guest, 'sketches', 's', 'update', { projectId: 'Q' }, { name: 'y' }));
  denies(() => pol.checkWrite(guest, 'sketches', 's', 'update', { projectId: 'P' }, { projectId: 'Q' })); // wegschieben
  denies(() => pol.checkWrite(guest, 'sketches', 's', 'update', null, { projectId: 'P' }));
  denies(() => pol.checkWrite(guest, 'sketches', 's', 'delete', { projectId: 'Q' }, null));
});

test('Dateien: eigenes Projekt oder selbst hochgeladen', () => {
  const proj = { files: [{ assetId: 'a1' }] };
  assert.equal(pol.canUseAsset(guest, { id: 'a1' }, proj), true);
  assert.equal(pol.canUseAsset(guest, { id: 'a2', invite_id: 'inv1' }, proj), true);
  assert.equal(pol.canUseAsset(guest, { id: 'a3', invite_id: 'other' }, proj), false);
  assert.equal(pol.canUseAsset(guest, { id: 'a4' }, proj), false);
  assert.equal(pol.canUseAsset(guest, null, proj), false);
  assert.equal(pol.canUseAsset(owner, { id: 'a4' }, null), true);
});

test('KI nur wenn erlaubt, Drop und Import nie für Gäste', () => {
  denies(() => pol.checkFeature(guest, 'ai'));
  pol.checkFeature(aiGuest, 'ai');
  denies(() => pol.checkFeature(aiGuest, 'drop'));
  denies(() => pol.checkFeature(aiGuest, 'import'));
  denies(() => pol.checkFeature(aiGuest, 'invites'));
});

test('Live-Updates nur für sichtbare Dinge', () => {
  assert.equal(pol.canSeeEvent(guest, { c: 'projects', id: 'P' }), true);
  assert.equal(pol.canSeeEvent(guest, { c: 'projects', id: 'Q' }), false);
  assert.equal(pol.canSeeEvent(guest, { c: 'sketches', projectId: 'Q' }), false);
  assert.equal(pol.canSeeEvent(guest, { c: 'drops' }), false);
  assert.equal(pol.canSeeEvent(guest, { c: 'parts' }), true);
  assert.equal(pol.canSeeEvent(guest, { c: 'presence', sketchId: 's', projectId: 'P' }), true);
  assert.equal(pol.canSeeEvent(guest, { c: 'presence', sketchId: 's', projectId: 'Q' }), false);
  assert.equal(pol.canSeeEvent(guest, { c: 'presence', sketchId: 's' }), false);
});
