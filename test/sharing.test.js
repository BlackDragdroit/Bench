// Ende-zu-Ende-Test für geteilte Projekte gegen einen echten Server und eine echte Datenbank.
// Läuft nur mit TEST_DATABASE_URL (eine leere Test-Datenbank, wird überschrieben), sonst übersprungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DBURL = process.env.TEST_DATABASE_URL;
const skip = !DBURL && 'TEST_DATABASE_URL not set';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3099, B = `http://localhost:${PORT}`;
let srv, owner, guest, token, inviteId, uploads;

const cookieOf = res => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
const req = (cookie, method, url, body, raw) => fetch(B + url, { method, redirect: 'manual', headers: { cookie: cookie || '', ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'text/plain' } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
const status = async (...a) => (await req(...a)).status;
const getJson = async (...a) => (await req(...a)).json();

before(async () => {
  if (skip) return;
  const c = new pg.Client(DBURL); await c.connect();
  await c.query('DROP TABLE IF EXISTS projects, parts, sketches, drops, assets, invites');
  await c.end();
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  srv = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), DATABASE_URL: DBURL, APP_PASSWORD: 'owner-pass', SESSION_SECRET: 'x'.repeat(64), UPLOAD_DIR: uploads, OWNER_NAME: 'Gabriel', ANTHROPIC_API_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const login = await fetch(B + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=owner-pass' });
  owner = cookieOf(login);
  // Ausgangslage: zwei Projekte, Skizzen, ein Teil, Drop-Daten, je eine Datei
  for (const [id, d] of [['P', { name: 'Shared', steps: [{ id: 's1', text: 'one', done: false }], bom: [], files: [] }], ['Q', { name: 'Private', steps: [], bom: [], files: [] }]]) await req(owner, 'PUT', `/api/db/projects/${id}`, d);
  await req(owner, 'PUT', '/api/db/sketches/sP', { projectId: 'P', name: 'a', comps: [], wires: [] });
  await req(owner, 'PUT', '/api/db/sketches/sQ', { projectId: 'Q', name: 'b', comps: [], wires: [] });
  await req(owner, 'PUT', '/api/db/parts/X', { name: 'NE555', stock: 5 });
  await req(owner, 'PUT', '/api/db/drops/state', { taste: 'secret' });
  const aP = (await getJson(owner, 'POST', '/api/assets', 'pfile', true)).id, aQ = (await getJson(owner, 'POST', '/api/assets', 'qfile', true)).id;
  await req(owner, 'PATCH', '/api/db/projects/P', { files: [{ id: 'f1', assetId: aP, name: 'p.txt' }] });
  await req(owner, 'PATCH', '/api/db/projects/Q', { files: [{ id: 'f2', assetId: aQ, name: 'q.txt' }] });
  globalThis.assets = { aP, aQ };
});
after(() => { if (srv) srv.kill(); if (uploads) fs.rmSync(uploads, { recursive: true, force: true }); });

test('Einladung anlegen und über den Link beitreten', { skip }, async () => {
  assert.equal(await status(owner, 'POST', '/api/invites', { projectId: 'nope', name: 'Max' }), 404);
  const r = await getJson(owner, 'POST', '/api/invites', { projectId: 'P', name: 'Max' });
  inviteId = r.invite.id; token = r.link.split('/join/')[1];
  assert.ok(r.link.includes('/join/'));
  assert.equal((await req('', 'GET', '/join/wrong-token-' + 'x'.repeat(20))).status, 404);
  const j = await req('', 'GET', '/join/' + token);
  assert.equal(j.status, 303);
  guest = cookieOf(j);
  assert.match(guest, /bench_guest=/);
  const cfg = await (await req(guest, 'GET', '/config.js')).text();
  assert.match(cfg, /"kind":"guest"/); assert.match(cfg, /"projectId":"P"/); assert.match(cfg, /"ownerName":"Gabriel"/);
});

test('Gast sieht nur das geteilte Projekt', { skip }, async () => {
  const list = await getJson(guest, 'GET', '/api/db/projects');
  assert.deepEqual(list.docs.map(d => d.id), ['P']);
  assert.equal((await getJson(guest, 'GET', '/api/db/projects/Q')).exists, false);
  const sk = await getJson(guest, 'GET', '/api/db/sketches');
  assert.deepEqual(sk.docs.map(d => d.id), ['sP']);
  assert.equal(await status(guest, 'GET', '/api/db/sketches?field=projectId&value=Q'), 403);
  assert.equal((await getJson(guest, 'GET', '/api/db/sketches/sQ')).exists, false);
  assert.equal(await status(guest, 'GET', '/api/db/drops'), 403);
  assert.equal(await status(guest, 'GET', '/api/db/drops/state'), 403);
  assert.equal((await getJson(guest, 'GET', '/api/db/parts')).docs.length, 1);
});

test('Gast darf nichts außerhalb seines Projekts ändern', { skip }, async () => {
  assert.equal(await status(guest, 'PATCH', '/api/db/projects/Q', { name: 'hacked' }), 403);
  assert.equal(await status(guest, 'PUT', '/api/db/projects/P', { name: 'x' }), 403);
  assert.equal(await status(guest, 'DELETE', '/api/db/projects/P'), 403);
  assert.equal(await status(guest, 'PUT', '/api/db/projects/NEW', { name: 'x' }), 403);
  assert.equal(await status(guest, 'PATCH', '/api/db/parts/X', { stock: 99 }), 403);
  assert.equal(await status(guest, 'PUT', '/api/db/parts/Y', { name: 'x' }), 403);
  assert.equal(await status(guest, 'PATCH', '/api/db/drops/state', { taste: 'x' }), 403);
  assert.equal(await status(guest, 'PATCH', '/api/db/sketches/sQ', { name: 'x' }), 403);
  assert.equal(await status(guest, 'PUT', '/api/db/sketches/sQ', { projectId: 'P', name: 'stolen' }), 403);
  assert.equal(await status(guest, 'PUT', '/api/db/sketches/new1', { projectId: 'Q' }), 403);
  assert.equal(await status(guest, 'DELETE', '/api/db/sketches/sQ'), 403);
  assert.equal((await getJson(owner, 'GET', '/api/db/parts/X')).data.stock, 5);
  assert.equal((await getJson(owner, 'GET', '/api/db/projects/Q')).data.name, 'Private');
});

test('Gast darf im Projekt alles bearbeiten', { skip }, async () => {
  assert.equal(await status(guest, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'add', f: 'steps', v: { id: 's2', text: 'two', by: 'Max' } }], status: 'building' }), 200);
  assert.equal(await status(guest, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'add', f: 'bom', v: { id: 'b1', partId: 'X', qty: 2 } }] }), 200);
  assert.equal(await status(guest, 'PUT', '/api/db/sketches/gs', { projectId: 'P', name: 'guest sketch', comps: [], wires: [] }), 200);
  assert.equal(await status(guest, 'PATCH', '/api/db/sketches/sP', { name: 'renamed' }), 200);
  const p = (await getJson(owner, 'GET', '/api/db/projects/P')).data;
  assert.deepEqual(p.steps.map(s => s.id), ['s1', 's2']); assert.equal(p.status, 'building'); assert.equal(p.bom[0].partId, 'X');
});

test('Dateien: nur eigene und die des Projekts', { skip }, async () => {
  const { aP, aQ } = globalThis.assets;
  assert.equal(await status(guest, 'GET', '/_blob/' + aP), 200);
  assert.equal(await status(guest, 'GET', '/_blob/' + aQ), 404);
  assert.equal(await status(guest, 'DELETE', '/api/assets/' + aQ), 403);
  const aG = (await getJson(guest, 'POST', '/api/assets', 'guest file', true)).id;
  assert.equal(await status(guest, 'GET', '/_blob/' + aG), 200);
  assert.equal(await status(guest, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'add', f: 'files', v: { id: 'fg', assetId: aG, name: 'g.txt' } }] }), 200);
  assert.equal(await status(guest, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'add', f: 'files', v: { id: 'fx', assetId: aQ, name: 'smuggled' } }] }), 403);
  assert.equal(await status(guest, 'PATCH', '/api/db/projects/P', { files: [{ id: 'fy', assetId: aQ }] }), 403);
  assert.equal(await status(guest, 'GET', '/_blob/' + aQ), 404);
});

test('Gleichzeitige Änderungen von Besitzer und Gast gehen nicht verloren', { skip }, async () => {
  await Promise.all([
    req(owner, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'set', f: 'steps', id: 's1', v: { done: true } }] }),
    req(guest, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'add', f: 'steps', v: { id: 's3', text: 'three' } }] }),
    req(guest, 'PATCH', '/api/db/projects/P', { $ops: [{ o: 'add', f: 'steps', v: { id: 's4', text: 'four' } }] })
  ]);
  const p = (await getJson(owner, 'GET', '/api/db/projects/P')).data;
  assert.equal(p.steps.find(s => s.id === 's1').done, true);
  assert.ok(p.steps.some(s => s.id === 's3') && p.steps.some(s => s.id === 's4'));
});

test('KI, Drop, Import und Einladungen sind für Gäste gesperrt', { skip }, async () => {
  assert.equal(await status(guest, 'POST', '/api/identify', { prompt: 'x' }), 403);
  assert.equal(await status(guest, 'POST', '/api/review', { prompt: 'x' }), 403);
  assert.equal(await status(guest, 'POST', '/api/drop', { prompt: 'x' }), 403);
  assert.equal(await status(guest, 'POST', '/api/import', { app: 'Bench' }), 403);
  assert.equal(await status(guest, 'GET', '/api/invites'), 403);
  assert.equal(await status(guest, 'POST', '/api/invites', { projectId: 'Q', name: 'me' }), 403);
  // Mit KI-Freigabe kommt die Anfrage durch die Sperre (ohne API-Key antwortet der Server mit 503)
  await req(owner, 'PATCH', '/api/invites/' + inviteId, { allowAi: true });
  assert.notEqual(await status(guest, 'POST', '/api/identify', { prompt: 'x' }), 403);
  assert.equal(await status(guest, 'POST', '/api/drop', { prompt: 'x' }), 403);
});

test('Live-Updates: Gast erfährt nur von seinem Projekt', { skip }, async () => {
  const ctl = new AbortController();
  const res = await fetch(B + '/api/events', { headers: { cookie: guest }, signal: ctl.signal });
  const reader = res.body.getReader(); let text = '';
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch {} })();
  await new Promise(r => setTimeout(r, 200));
  await req(owner, 'PATCH', '/api/db/projects/Q', { notes: 'private change' });
  await req(owner, 'PATCH', '/api/db/drops/state', { taste: 'x' });
  await req(owner, 'PATCH', '/api/db/projects/P', { notes: 'shared change' });
  await new Promise(r => setTimeout(r, 400));
  ctl.abort(); await pump;
  assert.match(text, /"c":"projects","id":"P"/);
  assert.doesNotMatch(text, /"id":"Q"/);
  assert.doesNotMatch(text, /drops/);
});

test('Skizzen-Sperre: nur eine Person zeichnet', { skip }, async () => {
  const a = await getJson(owner, 'POST', '/api/presence', { sketchId: 'sP', editing: true });
  assert.equal(a.mine, true); assert.equal(a.holder, null);
  const b = await getJson(guest, 'POST', '/api/presence', { sketchId: 'sP', editing: true });
  assert.equal(b.mine, false); assert.equal(b.holder.name, 'Gabriel');
  await req(owner, 'POST', '/api/presence', { sketchId: 'sP', editing: false });
  const c = await getJson(guest, 'POST', '/api/presence', { sketchId: 'sP', editing: true });
  assert.equal(c.mine, true);
  assert.equal(await status(guest, 'POST', '/api/presence', { sketchId: 'sQ', editing: true }), 403);
});

test('Widerrufen beendet den Zugang sofort', { skip }, async () => {
  assert.equal(await status(owner, 'DELETE', '/api/invites/' + inviteId), 200);
  const r = await req(guest, 'GET', '/api/db/projects');
  assert.equal(r.status, 401); assert.equal((await r.json()).code, 'invite_ended');
  assert.equal(await status(guest, 'GET', '/'), 403);
  assert.equal((await req('', 'GET', '/join/' + token)).status, 404);
  assert.equal(await status(owner, 'GET', '/api/db/projects'), 200);
});
