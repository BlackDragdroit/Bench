// Importiert eine Backup-Datei aus "Export backup" direkt in die Datenbank.
// Aufruf: npm run import -- bench-backup-2026-10-03.json
import fs from 'node:fs/promises';
import { createPool, migrate } from '../server/db.js';
import { importBackup } from '../server/importer.js';

const file = process.argv[2];
if (!file) {
  console.error('Aufruf: npm run import -- <bench-backup-YYYY-MM-DD.json>');
  process.exit(1);
}

const pool = createPool();
try {
  const backup = JSON.parse(await fs.readFile(file, 'utf8'));
  await migrate(pool);
  const r = await importBackup(pool, backup);
  console.log(`Importiert: ${r.projects} Projekte, ${r.parts} Teile, ${r.sketches} Skizzen.`);
  if (r.missingFiles) console.log(`${r.missingFiles} Datei(en) waren nicht im Backup und sind als fehlend markiert.`);
} catch (e) {
  console.error('Import fehlgeschlagen:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
