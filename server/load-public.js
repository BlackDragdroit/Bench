// Lädt ein Browser-Skript aus public/ (UMD wie sim.js, patch.js) auch auf dem Server
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function loadPublic(file) {
  const ctx = { module: { exports: {} } }; ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(here, '..', 'public', file), 'utf8'), ctx, { filename: file });
  return ctx.module.exports;
}
