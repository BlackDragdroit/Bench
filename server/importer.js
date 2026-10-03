import { setDoc } from './db.js';

const fail = msg => Object.assign(new Error(msg), { status: 400, code: 'invalid_backup' });

// Liest eine Datei aus "Export backup" (bench-backup-YYYY-MM-DD.json) ein.
// Vorhandene IDs werden überschrieben. Hochgeladene Dateien sind im Backup nicht
// enthalten; Einträge ohne passende Datei auf dem Server werden als "missing" markiert.
export async function importBackup(pool, backup) {
  if (!backup || typeof backup !== 'object') throw fail('Keine gültige Backup-Datei');
  if (backup.app && backup.app !== 'Bench') throw fail('Die Datei stammt nicht aus Bench');
  const lists = { projects: backup.projects, parts: backup.parts, sketches: backup.sketches };
  for (const [k, v] of Object.entries(lists)) {
    if (v != null && !Array.isArray(v)) throw fail(`"${k}" ist keine Liste`);
  }

  const known = new Set((await pool.query('SELECT id FROM assets')).rows.map(r => r.id));
  const counts = { projects: 0, parts: 0, sketches: 0, missingFiles: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [coll, list] of Object.entries(lists)) {
      for (const item of list || []) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) continue;
        const { id, ...data } = item;
        if (coll === 'projects' && Array.isArray(data.files)) {
          data.files = data.files.map(f => {
            if (f && f.assetId && known.has(f.assetId)) { const { missing, ...rest } = f; return rest; }
            counts.missingFiles++;
            return { ...f, missing: true };
          });
        }
        await setDoc(client, coll, id, data);
        counts[coll]++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return counts;
}
