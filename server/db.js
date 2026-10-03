import pg from 'pg';

// Die drei Sammlungen der App. Der Name ist zugleich der Tabellenname.
export const COLLECTIONS = ['projects', 'parts', 'sketches'];

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
export async function updateDoc(pool, coll, id, patch) {
  await pool.query(
    `INSERT INTO ${coll} (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = ${coll}.data || EXCLUDED.data, updated_at = now()`, [id, patch]);
}

export async function deleteDoc(pool, coll, id) {
  await pool.query(`DELETE FROM ${coll} WHERE id = $1`, [id]);
}
