import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as auth from './auth.js';
import { identify, identifyAvailable, dropGenerate, reviewCircuit } from './identify.js';
import { importBackup } from './importer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const APP_PASSWORD = process.env.APP_PASSWORD;
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

// ---------- ohne Login ----------
app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

const loginPage = fs.readFileSync(path.join(here, 'login.html'), 'utf8');
const sendLogin = (res, error, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-store')
  .send(loginPage.replace('<!--ERROR-->', error ? `<p class="err" role="alert">${error}</p>` : ''));

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
app.post('/logout', (req, res) => { auth.clearSessionCookie(req, res); res.redirect(303, '/login'); });

// Manifest, Icons und Service Worker braucht der Browser auch ohne Session.
const pub = f => (req, res) => res.sendFile(path.join(PUBLIC, f), { headers: { 'Cache-Control': 'no-cache' } });
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(PUBLIC, 'manifest.webmanifest'), { headers: { 'Cache-Control': 'no-cache' } }));
app.get('/sw.js', pub('sw.js'));
app.use('/icons', express.static(path.join(PUBLIC, 'icons'), { maxAge: '7d' }));

// ---------- ab hier nur mit Login ----------
app.use((req, res, next) => {
  if (auth.tokenValid(SESSION_SECRET, auth.readCookie(req))) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/_blob/')) return res.status(401).json({ code: 'unauthenticated' });
  res.redirect(302, '/login');
});

app.get(['/', '/index.html'], pub('bench.html'));
app.get('/runtime.js', pub('runtime.js'));
app.get('/sim.js', pub('sim.js'));
app.get('/config.js', (req, res) => {
  res.type('js').set('Cache-Control', 'no-store').send(
    `window.BENCH_CONFIG=${JSON.stringify({ maxUploadMB: MAX_UPLOAD_MB, identify: identifyAvailable() })};`);
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Datenbank ----------
const collParam = (req, res, next) => {
  if (!db.COLLECTIONS.includes(req.params.coll)) return res.status(404).json({ code: 'not_found' });
  next();
};
const idOk = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const json = express.json({ limit: '20mb' });

app.get('/api/db/:coll', collParam, wrap(async (req, res) => {
  const etag = await db.tableVersion(pool, req.params.coll);
  res.set({ 'ETag': etag, 'Cache-Control': 'no-cache' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const where = req.query.field ? { field: String(req.query.field), value: String(req.query.value ?? '') } : null;
  res.json({ docs: await db.listDocs(pool, req.params.coll, where) });
}));
app.get('/api/db/:coll/:id', collParam, wrap(async (req, res) => {
  const d = await db.getDoc(pool, req.params.coll, req.params.id);
  res.set('Cache-Control', 'no-store').json(d ? { exists: true, ...d } : { exists: false, id: req.params.id });
}));
const writeRoute = fn => [collParam, json, wrap(async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ code: 'invalid_argument' });
  if (fn !== db.deleteDoc && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ code: 'invalid_argument' });
  await fn(pool, req.params.coll, req.params.id, req.body);
  res.json({ ok: true });
})];
app.put('/api/db/:coll/:id', ...writeRoute(db.setDoc));
app.patch('/api/db/:coll/:id', ...writeRoute(db.updateDoc));
app.delete('/api/db/:coll/:id', ...writeRoute(db.deleteDoc));

// ---------- Dateien ----------
const assetPath = id => path.join(UPLOAD_DIR, id);
const assetIdOk = id => /^[a-f0-9]{32}$/.test(id);
const cleanType = t => (/^[\w.+-]+\/[\w.+-]+$/.test(String(t || '').split(';')[0].trim()) ? String(t).split(';')[0].trim().toLowerCase() : 'application/octet-stream');

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
  await pool.query('INSERT INTO assets (id, type, size) VALUES ($1, $2, $3)', [id, type, size]);
  res.json({ id, url: '/_blob/' + id });
}));
app.get('/api/assets/usage', wrap(async (req, res) => res.set('Cache-Control', 'no-store').json({ usage: await usage() })));
app.delete('/api/assets/:id', wrap(async (req, res) => {
  if (!assetIdOk(req.params.id)) return res.status(400).json({ code: 'invalid_argument' });
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
  const { rows } = await pool.query('SELECT type FROM assets WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).end();
  const type = rows[0].type;
  const headers = { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' };
  if (!INLINE_SAFE.test(type)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  res.sendFile(assetPath(req.params.id), { headers }, err => { if (err && !res.headersSent) res.status(404).end(); });
}));

// ---------- Teilesuche ----------
app.post('/api/identify', express.json({ limit: '30mb' }), wrap(async (req, res) => {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try { res.json(await identify(req.body, ctl.signal)); }
  catch (e) {
    if (e.code === 'cancelled') return;
    res.status(e.status || 500).json({ code: e.code || 'upstream' });
  }
}));

// ---------- Drop (Projektideen) ----------
// Grobe Bremse wie in Random Drop: höchstens 20 Würfe pro Minute.
const dropHits = [];
app.post('/api/drop', express.json({ limit: '256kb' }), wrap(async (req, res) => {
  const now = Date.now();
  while (dropHits.length && now - dropHits[0] > 60000) dropHits.shift();
  if (dropHits.length >= 20) return res.status(429).json({ code: 'rate_limited' });
  dropHits.push(now);
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try { res.json(await dropGenerate(req.body, ctl.signal)); }
  catch (e) {
    if (e.code === 'cancelled') return;
    res.status(e.status || 500).json({ code: e.code || 'upstream' });
  }
}));

// ---------- Schaltungsprüfung (Skizzen) ----------
app.post('/api/review', express.json({ limit: '512kb' }), wrap(async (req, res) => {
  const now = Date.now();
  while (dropHits.length && now - dropHits[0] > 60000) dropHits.shift();
  if (dropHits.length >= 20) return res.status(429).json({ code: 'rate_limited' });
  dropHits.push(now);
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try { res.json(await reviewCircuit(req.body, ctl.signal)); }
  catch (e) {
    if (e.code === 'cancelled') return;
    res.status(e.status || 500).json({ code: e.code || 'upstream' });
  }
}));

// ---------- Backup-Import ----------
app.post('/api/import', express.json({ limit: '100mb' }), wrap(async (req, res) => {
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
