import pg from 'pg';
import crypto from 'node:crypto';
import { loadPublic } from './load-public.js';

const { applyPatch } = loadPublic('patch.js');

// Die drei Sammlungen der App. Der Name ist zugleich der Tabellenname.
export const COLLECTIONS = ['projects', 'parts', 'sketches', 'drops'];

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL fehlt');
  return new pg.Pool({ connectionString: url, max: 5 });
}

export async function migrate(pool) {
  for (const t of COLLECTIONS) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${t} (
      id text PRIMARY KEY,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS sketches_project_idx ON sketches ((data->>'projectId'))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS assets (
    id text PRIMARY KEY,
    type text NOT NULL,
    size bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Wer eine Datei hochgeladen hat (Gäste dürfen nur ihre eigenen und die ihres Projekts sehen)
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS invite_id text`);
  // Einladungen zu einem Projekt. Vom Link wird nur der Hash gespeichert.
  await pool.query(`CREATE TABLE IF NOT EXISTS invites (
    id text PRIMARY KEY,
    project_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    allow_ai boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    last_seen timestamptz
  )`);
}

// Stand einer Tabelle für das Polling (ETag): Anzahl der Einträge plus letzte
// Änderung. Kommt aus der Datenbank, damit auch Änderungen aus anderen Prozessen
// (z. B. npm run import) bei geöffneten Clients ankommen.
export async function tableVersion(pool, coll) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, COALESCE((extract(epoch FROM max(updated_at)) * 1000000)::bigint, 0) AS t FROM ${coll}`);
  return `"${rows[0].n}-${rows[0].t}"`;
}

const FIELD = /^[A-Za-z0-9_]{1,64}$/;

export async function listDocs(pool, coll, where) {
  if (where) {
    if (!FIELD.test(where.field)) throw Object.assign(new Error('bad field'), { status: 400, code: 'invalid_argument' });
    const r = await pool.query(`SELECT id, data FROM ${coll} WHERE data->>$1 = $2`, [where.field, String(where.value)]);
    return r.rows;
  }
  return (await pool.query(`SELECT id, data FROM ${coll}`)).rows;
}

export async function getDoc(pool, coll, id) {
  const r = await pool.query(`SELECT id, data FROM ${coll} WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function setDoc(pool, coll, id, data) {
  await pool.query(
    `INSERT INTO ${coll} (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [id, data]);
}

// Wie Firestore-update: Felder der obersten Ebene werden überschrieben, der Rest bleibt.
// Mit $ops (Listenänderungen, siehe public/patch.js) wird der Eintrag gesperrt, die
// Operationen auf den aktuellen Stand angewendet und zurückgeschrieben. So gehen
// gleichzeitige Änderungen zweier Personen an derselben Liste nicht verloren.
export async function updateDoc(pool, coll, id, patch) {
  if (patch && patch.$ops) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT data FROM ${coll} WHERE id = $1 FOR UPDATE`, [id]);
      const next = applyPatch(r.rows[0] ? r.rows[0].data : {}, patch);
      await client.query(
        `INSERT INTO ${coll} (id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [id, next]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    return;
  }
  await pool.query(
    `INSERT INTO ${coll} (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = ${coll}.data || EXCLUDED.data, updated_at = now()`, [id, patch]);
}

export async function deleteDoc(pool, coll, id) {
  await pool.query(`DELETE FROM ${coll} WHERE id = $1`, [id]);
}

/* ---------- Einladungen ---------- */
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const inviteRow = r => r && ({ id: r.id, projectId: r.project_id, name: r.name, allowAi: r.allow_ai, created: r.created_at, lastSeen: r.last_seen, revoked: !!r.revoked_at });

export async function createInvite(pool, projectId, name, allowAi) {
  const id = crypto.randomBytes(8).toString('hex'), token = crypto.randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO invites (id, project_id, name, token_hash, allow_ai) VALUES ($1, $2, $3, $4, $5)', [id, projectId, name, hash(token), !!allowAi]);
  return { invite: inviteRow((await pool.query('SELECT * FROM invites WHERE id = $1', [id])).rows[0]), token };
}
export async function renewInviteToken(pool, id) {
  const token = crypto.randomBytes(24).toString('base64url');
  const r = await pool.query('UPDATE invites SET token_hash = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id, hash(token)]);
  return r.rowCount ? token : null;
}
export async function listInvites(pool, projectId) {
  const r = projectId
    ? await pool.query('SELECT * FROM invites WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at', [projectId])
    : await pool.query('SELECT * FROM invites WHERE revoked_at IS NULL ORDER BY created_at');
  return r.rows.map(inviteRow);
}
export async function getInvite(pool, id) { return inviteRow((await pool.query('SELECT * FROM invites WHERE id = $1', [id])).rows[0]); }
export async function findInviteByToken(pool, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return inviteRow((await pool.query('SELECT * FROM invites WHERE token_hash = $1 AND revoked_at IS NULL', [hash(token)])).rows[0]);
}
export async function updateInvite(pool, id, { name, allowAi }) {
  if (typeof name === 'string') await pool.query('UPDATE invites SET name = $2 WHERE id = $1', [id, name]);
  if (typeof allowAi === 'boolean') await pool.query('UPDATE invites SET allow_ai = $2 WHERE id = $1', [id, allowAi]);
  return getInvite(pool, id);
}
export async function revokeInvite(pool, id) { await pool.query('UPDATE invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]); }
export async function touchInvite(pool, id) { await pool.query("UPDATE invites SET last_seen = now() WHERE id = $1 AND (last_seen IS NULL OR last_seen < now() - interval '1 minute')", [id]); }
