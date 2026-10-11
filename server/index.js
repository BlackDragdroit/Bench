import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as auth from './auth.js';
import * as pol from './policy.js';
import { identify, identifyAvailable, dropGenerate, reviewCircuit } from './identify.js';
import { importBackup } from './importer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const APP_PASSWORD = process.env.APP_PASSWORD;
const OWNER_NAME = (process.env.OWNER_NAME || 'Owner').trim().slice(0, 40) || 'Owner';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(here, '..', 'data', 'uploads'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1048576;

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!APP_PASSWORD) { console.error('APP_PASSWORD fehlt – ohne Passwort startet Bench nicht.'); process.exit(1); }
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  if (PROD) { console.error('SESSION_SECRET fehlt oder ist kürzer als 32 Zeichen.'); process.exit(1); }
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET nicht gesetzt – zufälliger Wert, Logins gelten nur bis zum Neustart.');
}

const pool = db.createPool();
await db.migrate(pool);
await fsp.mkdir(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN'
  });
  next();
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Änderungsmeldungen (Live-Updates über Server-Sent Events) ---------- */
const bus = new EventEmitter(); bus.setMaxListeners(0);
const emit = ev => bus.emit('change', ev);

/* ---------- Wer fragt? Besitzer (Passwort) oder Gast (Einladungslink) ---------- */
const inviteCache = new Map();          // id → { invite, at }
async function loadInvite(id) {
  const hit = inviteCache.get(id);
  if (hit && Date.now() - hit.at < 10000) return hit.invite;
  const invite = await db.getInvite(pool, id);
  inviteCache.set(id, { invite, at: Date.now() });
  return invite;
}
async function resolveActor(req) {
  if (auth.tokenValid(SESSION_SECRET, auth.readCookie(req))) return { kind: 'owner', name: OWNER_NAME, key: 'owner' };
  const id = auth.guestInviteId(SESSION_SECRET, auth.readGuestCookie(req));
  if (!id) return null;
  const inv = await loadInvite(id);
  if (!inv || inv.revoked) return { kind: 'ended' };
  db.touchInvite(pool, id).catch(() => {});
  return { kind: 'guest', inviteId: id, projectId: inv.projectId, name: inv.name, allowAi: inv.allowAi, key: 'g:' + id };
}

/* ---------- ohne Login ---------- */
app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

const loginPage = fs.readFileSync(path.join(here, 'login.html'), 'utf8');
const sendLogin = (res, error, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-store')
  .send(loginPage.replace('<!--ERROR-->', error ? `<p class="err" role="alert">${error}</p>` : ''));
const messagePage = fs.readFileSync(path.join(here, 'message.html'), 'utf8');
const sendMessage = (res, title, text, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-store')
  .send(messagePage.replace('<!--TITLE-->', esc(title)).replace('<!--TEXT-->', esc(text)));

app.get('/login', (req, res) => {
  if (auth.tokenValid(SESSION_SECRET, auth.readCookie(req))) return res.redirect('/');
  sendLogin(res);
});
app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const ip = req.ip;
  if (auth.loginBlocked(ip)) return sendLogin(res, 'Too many attempts. Wait 15 minutes and try again.', 429);
  if (!auth.passwordMatches(req.body?.password || '', APP_PASSWORD)) {
    auth.noteFailure(ip);
    return sendLogin(res, 'Wrong password.', 401);
  }
  auth.clearFailures(ip);
  auth.setSessionCookie(req, res, auth.makeToken(SESSION_SECRET));
  res.redirect(303, '/');
});
app.post('/logout', wrap(async (req, res) => {
  const wasGuest = !auth.tokenValid(SESSION_SECRET, auth.readCookie(req)) && !!auth.readGuestCookie(req);
  auth.clearSessionCookie(req, res); auth.clearGuestCookie(req, res);
  if (wasGuest) return sendMessage(res, 'You left the project', 'Open your invite link again to come back.');
  res.redirect(303, '/login');
}));

// Einladungslink: setzt das Gast-Cookie und öffnet das Projekt
app.get('/join/:token', wrap(async (req, res) => {
  if (auth.tokenValid(SESSION_SECRET, auth.readCookie(req)))
    return sendMessage(res, 'You’re signed in as the owner', 'This is a guest link. To see what your guest sees, open it in a private window.');
  const inv = await db.findInviteByToken(pool, req.params.token);
  if (!inv) return sendMessage(res, 'This invite link doesn’t work anymore', `Ask ${OWNER_NAME} for a new one.`, 404);
  auth.setGuestCookie(req, res, auth.makeGuestToken(SESSION_SECRET, inv.id));
  res.redirect(303, '/');
}));

// Manifest, Icons und Service Worker braucht der Browser auch ohne Session.
const pub = f => (req, res) => res.sendFile(path.join(PUBLIC, f), { headers: { 'Cache-Control': 'no-cache' } });
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(PUBLIC, 'manifest.webmanifest'), { headers: { 'Cache-Control': 'no-cache' } }));
app.get('/sw.js', pub('sw.js'));
app.use('/icons', express.static(path.join(PUBLIC, 'icons'), { maxAge: '7d' }));

/* ---------- ab hier nur mit Login oder gültiger Einladung ---------- */
app.use(wrap(async (req, res, next) => {
  const actor = await resolveActor(req);
  const api = req.path.startsWith('/api/') || req.path.startsWith('/_blob/');
  if (actor && actor.kind !== 'ended') { req.actor = actor; return next(); }
  if (actor && actor.kind === 'ended') {
    auth.clearGuestCookie(req, res);
    if (api) return res.status(401).json({ code: 'invite_ended' });
    return sendMessage(res, 'This invite has ended', `${OWNER_NAME} stopped sharing this project with you.`, 403);
  }
  if (api) return res.status(401).json({ code: 'unauthenticated' });
  res.redirect(302, '/login');
}));
const ownerOnly = (req, res, next) => req.actor.kind === 'owner' ? next() : res.status(403).json({ code: 'forbidden' });

app.get(['/', '/index.html'], pub('bench.html'));
app.get('/runtime.js', pub('runtime.js'));
app.get('/sim.js', pub('sim.js'));
app.get('/patch.js', pub('patch.js'));
app.get('/config.js', (req, res) => {
  const a = req.actor;
  const me = a.kind === 'guest' ? { kind: 'guest', name: a.name, projectId: a.projectId, allowAi: a.allowAi } : { kind: 'owner', name: OWNER_NAME };
  res.type('js').set('Cache-Control', 'no-store').send(
    `window.BENCH_CONFIG=${JSON.stringify({ maxUploadMB: MAX_UPLOAD_MB, identify: identifyAvailable(), me, ownerName: OWNER_NAME })};`);
});

/* ---------- Datenbank ---------- */
const collParam = (req, res, next) => {
  if (!db.COLLECTIONS.includes(req.params.coll)) return res.status(404).json({ code: 'not_found' });
  next();
};
const idOk = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const json = express.json({ limit: '20mb' });

app.get('/api/db/:coll', collParam, wrap(async (req, res) => {
  const where = req.query.field ? { field: String(req.query.field), value: String(req.query.value ?? '') } : null;
  const scope = pol.listScope(req.actor, req.params.coll, where);
  const etag = await db.tableVersion(pool, req.params.coll);
  res.set({ 'ETag': etag, 'Cache-Control': 'no-cache', 'Vary': 'Cookie' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  let docs = await db.listDocs(pool, req.params.coll, scope.where);
  if (scope.keep) docs = docs.filter(scope.keep);
  res.json({ docs });
}));
app.get('/api/db/:coll/:id', collParam, wrap(async (req, res) => {
  const d = await db.getDoc(pool, req.params.coll, req.params.id);
  if (!pol.canRead(req.actor, req.params.coll, req.params.id, d && d.data)) {
    if (req.actor.kind === 'guest' && !['projects', 'parts', 'sketches'].includes(req.params.coll)) return res.status(403).json({ code: 'forbidden' });
    return res.set('Cache-Control', 'no-store').json({ exists: false, id: req.params.id });
  }
  res.set('Cache-Control', 'no-store').json(d ? { exists: true, ...d } : { exists: false, id: req.params.id });
}));
const writeRoute = (method, fn) => [collParam, json, wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!idOk(id)) return res.status(400).json({ code: 'invalid_argument' });
  if (method !== 'delete' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ code: 'invalid_argument' });
  const old = await db.getDoc(pool, coll, id);
  pol.checkWrite(req.actor, coll, id, method, old ? old.data : null, req.body);
  if (req.actor.kind === 'guest' && coll === 'projects') await checkGuestFileRefs(req.actor, old ? old.data : {}, req.body);
  await fn(pool, coll, id, req.body);
  emit({ c: coll, id, projectId: coll === 'sketches' ? ((req.body && req.body.projectId) || (old && old.data.projectId)) : undefined });
  res.json({ ok: true });
})];
// Gäste dürfen in der Dateiliste nur Dateien eintragen, die schon im Projekt sind oder
// die sie selbst hochgeladen haben. Sonst ließe sich eine fremde Datei-ID "einschmuggeln".
async function checkGuestFileRefs(actor, oldData, body) {
  const known = new Set((oldData.files || []).map(f => f && f.assetId).filter(Boolean));
  const refs = new Set();
  for (const f of Array.isArray(body.files) ? body.files : []) if (f && f.assetId) refs.add(f.assetId);
  for (const op of Array.isArray(body.$ops) ? body.$ops : []) {
    if (op && op.f === 'files' && op.v && op.v.assetId) refs.add(op.v.assetId);
  }
  const unknown = [...refs].filter(a => !known.has(a));
  if (!unknown.length) return;
  const { rows } = await pool.query('SELECT id FROM assets WHERE id = ANY($1) AND invite_id = $2', [unknown, actor.inviteId]);
  if (rows.length !== unknown.length) throw pol.forbidden('unknown file');
}
app.put('/api/db/:coll/:id', ...writeRoute('set', db.setDoc));
app.patch('/api/db/:coll/:id', ...writeRoute('update', db.updateDoc));
app.delete('/api/db/:coll/:id', ...writeRoute('delete', db.deleteDoc));

/* ---------- Live-Updates ---------- */
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const actor = req.actor;
  const on = ev => {
    if (ev.revoked && actor.kind === 'guest' && ev.revoked === actor.inviteId) { res.write('event: ended\ndata: {}\n\n'); res.end(); return; }
    if (ev.c && pol.canSeeEvent(actor, ev)) res.write(`data: ${JSON.stringify({ c: ev.c, id: ev.id, sketchId: ev.sketchId })}\n\n`);
  };
  bus.on('change', on);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); bus.off('change', on); });
});

/* ---------- Wer bearbeitet gerade welche Skizze? ---------- */
// Nur eine Person zeichnet gleichzeitig; die anderen sehen zu, bis sie fertig ist.
const locks = new Map();                 // sketchId → { key, name, until }
app.post('/api/presence', express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const sid = String(req.body?.sketchId || ''), editing = !!req.body?.editing;
  if (!idOk(sid)) return res.status(400).json({ code: 'invalid_argument' });
  const sk = await db.getDoc(pool, 'sketches', sid);
  if (sk && !pol.canRead(req.actor, 'sketches', sid, sk.data)) return res.status(403).json({ code: 'forbidden' });
  const now = Date.now(), cur = locks.get(sid), live = cur && cur.until > now;
  let changed = false;
  if (editing) {
    if (!live || cur.key === req.actor.key) { changed = !live; locks.set(sid, { key: req.actor.key, name: req.actor.name, until: now + 45000 }); }
  } else if (live && cur.key === req.actor.key) { locks.delete(sid); changed = true; }
  const l = locks.get(sid);
  const holder = l && l.until > now && l.key !== req.actor.key ? { name: l.name } : null;
  if (changed) emit({ c: 'presence', sketchId: sid, projectId: sk && sk.data.projectId });
  res.json({ holder, mine: !!(l && l.until > now && l.key === req.actor.key) });
}));

/* ---------- Dateien ---------- */
const assetPath = id => path.join(UPLOAD_DIR, id);
const assetIdOk = id => /^[a-f0-9]{32}$/.test(id);
const cleanType = t => (/^[\w.+-]+\/[\w.+-]+$/.test(String(t || '').split(';')[0].trim()) ? String(t).split(';')[0].trim().toLowerCase() : 'application/octet-stream');
async function assetAllowed(actor, id) {
  const { rows } = await pool.query('SELECT id, type, invite_id FROM assets WHERE id = $1', [id]);
  const asset = rows[0] || null;
  if (!asset) return { asset: null, ok: false };
  if (actor.kind !== 'guest') return { asset, ok: true };
  const p = await db.getDoc(pool, 'projects', actor.projectId);
  return { asset, ok: pol.canUseAsset(actor, asset, p && p.data) };
}

async function usage() {
  const { rows } = await pool.query('SELECT COALESCE(SUM(size), 0)::bigint AS bytes FROM assets');
  const bytes = Number(rows[0].bytes);
  let free = 0;
  try { const s = await fsp.statfs(UPLOAD_DIR); free = s.bavail * s.bsize; } catch {}
  return { bytes, maxBytes: bytes + free };
}

app.post('/api/assets', wrap(async (req, res) => {
  const len = Number(req.headers['content-length']);
  if (len > MAX_UPLOAD) return res.status(413).json({ code: 'too_large' });
  const id = crypto.randomBytes(16).toString('hex');
  const type = cleanType(req.headers['content-type']);
  const tmp = assetPath(id) + '.part';
  let size = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return cb(Object.assign(new Error('too large'), { code: 'too_large' }));
      cb(null, chunk);
    }
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e.code === 'too_large') return res.status(413).json({ code: 'too_large' });
    throw e;
  }
  if (!size) { await fsp.rm(tmp, { force: true }); return res.status(400).json({ code: 'empty' }); }
  await fsp.rename(tmp, assetPath(id));
  await pool.query('INSERT INTO assets (id, type, size, invite_id) VALUES ($1, $2, $3, $4)', [id, type, size, req.actor.kind === 'guest' ? req.actor.inviteId : null]);
  res.json({ id, url: '/_blob/' + id });
}));
app.get('/api/assets/usage', wrap(async (req, res) => res.set('Cache-Control', 'no-store').json({ usage: await usage() })));
app.delete('/api/assets/:id', wrap(async (req, res) => {
  if (!assetIdOk(req.params.id)) return res.status(400).json({ code: 'invalid_argument' });
  const { asset, ok } = await assetAllowed(req.actor, req.params.id);
  if (asset && !ok) return res.status(403).json({ code: 'forbidden' });
  await pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  await fsp.rm(assetPath(req.params.id), { force: true });
  res.json({ ok: true });
}));

// Bilder, Videos, Audio und PDFs dürfen direkt angezeigt werden. Alles andere
// (SVG, HTML, …) läuft in einer Sandbox, damit hochgeladene Dateien kein Skript
// im Namen der App ausführen können.
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf$)/;
app.get('/_blob/:id', wrap(async (req, res) => {
  if (!assetIdOk(req.params.id)) return res.status(404).end();
  const { asset, ok } = await assetAllowed(req.actor, req.params.id);
  if (!asset || !ok) return res.status(404).end();
  const headers = { 'Content-Type': asset.type, 'Cache-Control': 'private, max-age=31536000, immutable' };
  if (!INLINE_SAFE.test(asset.type)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  res.sendFile(assetPath(req.params.id), { headers }, err => { if (err && !res.headersSent) res.status(404).end(); });
}));

/* ---------- KI: Teilesuche, Drop, Schaltungsprüfung ---------- */
const feature = name => (req, res, next) => { try { pol.checkFeature(req.actor, name); next(); } catch (e) { res.status(403).json({ code: 'forbidden' }); } };
// Grobe Bremse wie in Random Drop: höchstens 20 Anfragen pro Minute.
const aiHits = [];
const limited = (req, res, next) => {
  const now = Date.now();
  while (aiHits.length && now - aiHits[0] > 60000) aiHits.shift();
  if (aiHits.length >= 20) return res.status(429).json({ code: 'rate_limited' });
  aiHits.push(now); next();
};
const aiRoute = fn => wrap(async (req, res) => {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try { res.json(await fn(req.body, ctl.signal)); }
  catch (e) {
    if (e.code === 'cancelled') return;
    res.status(e.status || 500).json({ code: e.code || 'upstream' });
  }
});
app.post('/api/identify', feature('ai'), express.json({ limit: '30mb' }), aiRoute(identify));
app.post('/api/drop', feature('drop'), limited, express.json({ limit: '256kb' }), aiRoute(dropGenerate));
app.post('/api/review', feature('ai'), limited, express.json({ limit: '512kb' }), aiRoute(reviewCircuit));

/* ---------- Einladungen (nur Besitzer) ---------- */
const inviteLink = (req, token) => `${req.protocol}://${req.get('host')}/join/${token}`;
app.get('/api/invites', ownerOnly, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ invites: await db.listInvites(pool, req.query.projectId ? String(req.query.projectId) : null) });
}));
app.post('/api/invites', ownerOnly, express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const projectId = String(req.body?.projectId || ''), name = String(req.body?.name || '').trim().slice(0, 40);
  if (!idOk(projectId) || !name) return res.status(400).json({ code: 'invalid_argument' });
  if (!await db.getDoc(pool, 'projects', projectId)) return res.status(404).json({ code: 'not_found' });
  const { invite, token } = await db.createInvite(pool, projectId, name, !!req.body?.allowAi);
  res.json({ invite, link: inviteLink(req, token) });
}));
app.patch('/api/invites/:id', ownerOnly, express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const inv = await db.updateInvite(pool, req.params.id, { name: typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 40) : undefined, allowAi: req.body?.allowAi });
  if (!inv) return res.status(404).json({ code: 'not_found' });
  inviteCache.delete(req.params.id);
  res.json({ invite: inv });
}));
app.post('/api/invites/:id/renew', ownerOnly, wrap(async (req, res) => {
  const token = await db.renewInviteToken(pool, req.params.id);
  if (!token) return res.status(404).json({ code: 'not_found' });
  res.json({ link: inviteLink(req, token) });
}));
app.delete('/api/invites/:id', ownerOnly, wrap(async (req, res) => {
  await db.revokeInvite(pool, req.params.id);
  inviteCache.delete(req.params.id);
  emit({ revoked: req.params.id });
  res.json({ ok: true });
}));

/* ---------- Backup-Import ---------- */
app.post('/api/import', ownerOnly, express.json({ limit: '100mb' }), wrap(async (req, res) => {
  res.json({ ok: true, ...(await importBackup(pool, req.body)) });
}));

app.use('/api', (req, res) => res.status(404).json({ code: 'not_found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ code: 'too_large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ code: 'invalid_argument' });
  if (err.status && err.status < 500) return res.status(err.status).json({ code: err.code || 'invalid_argument', message: err.message });
  console.error(err);
  res.status(500).json({ code: 'internal' });
});

const server = app.listen(PORT, () => console.log(`Bench läuft auf Port ${PORT}`));
const stop = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
