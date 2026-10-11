/* Bench patch: Änderungen an Listen in einem Dokument (Schritte, Teileliste, Dateien)
   als kleine Operationen statt als ganze Liste. So überschreiben sich zwei Personen, die
   gleichzeitig am selben Projekt arbeiten, nicht gegenseitig.
   Ein Patch ist { feld: wert, …, $ops: [ … ] }:
     { o: 'add',   f, v, after }   Eintrag v einfügen, nach Eintrag `after` ('' = an den Anfang, fehlt = ans Ende)
     { o: 'set',   f, id, v }      Felder von Eintrag id ändern
     { o: 'del',   f, id }         Eintrag id entfernen
     { o: 'order', f, ids }        Reihenfolge dieser Einträge setzen; andere bleiben auf ihren Plätzen
   Läuft im Browser (window.BenchPatch) und auf dem Server (über vm geladen). */
(function (root) {
  'use strict';
  const LISTS = ['steps', 'bom', 'files', 'phases'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const byId = (arr, id) => arr.findIndex(x => x && x.id === id);

  function applyOps(data, ops) {
    const out = { ...(data || {}) };
    for (const op of ops || []) {
      if (!op || typeof op.f !== 'string' || !LISTS.includes(op.f)) continue;
      const arr = Array.isArray(out[op.f]) ? out[op.f].slice() : [];
      if (op.o === 'add' && op.v && typeof op.v === 'object' && op.v.id != null) {
        if (byId(arr, op.v.id) < 0) {
          let i = arr.length;
          if (op.after === '') i = 0; else if (op.after != null) { const j = byId(arr, op.after); i = j < 0 ? arr.length : j + 1; }
          arr.splice(i, 0, op.v);
        }
      } else if (op.o === 'set' && op.v && typeof op.v === 'object') {
        const i = byId(arr, op.id); if (i >= 0) arr[i] = { ...arr[i], ...op.v, id: arr[i].id };
      } else if (op.o === 'del') {
        const i = byId(arr, op.id); if (i >= 0) arr.splice(i, 1);
      } else if (op.o === 'order' && Array.isArray(op.ids)) {
        const pos = new Map(op.ids.map((id, i) => [id, i]));
        const slots = [], items = [];
        arr.forEach((x, i) => { if (x && pos.has(x.id)) { slots.push(i); items.push(x); } });
        items.sort((a, b) => pos.get(a.id) - pos.get(b.id));
        slots.forEach((s, k) => { arr[s] = items[k]; });
      }
      out[op.f] = arr;
    }
    return out;
  }

  function applyPatch(data, patch) {
    if (!patch) return { ...(data || {}) };
    const out = { ...(data || {}) };
    for (const [k, v] of Object.entries(patch)) if (k !== '$ops') out[k] = v;
    return patch.$ops ? applyOps(out, patch.$ops) : out;
  }

  // Unterschied zwischen alter und neuer Liste als Operationen
  function diffList(f, a, b) {
    a = Array.isArray(a) ? a.filter(x => x && x.id != null) : [];
    b = Array.isArray(b) ? b.filter(x => x && x.id != null) : [];
    // Reihenfolge: löschen, umsortieren, ändern, hinzufügen. Neue Einträge werden zuletzt
    // eingefügt, jeweils hinter ihrem Vorgänger in der neuen Liste.
    const ops = [], am = new Map(a.map(x => [x.id, x])), bm = new Map(b.map(x => [x.id, x]));
    for (const x of a) if (!bm.has(x.id)) ops.push({ o: 'del', f, id: x.id });
    const keep = a.filter(x => bm.has(x.id)).map(x => x.id), next = b.filter(x => am.has(x.id)).map(x => x.id);
    if (!same(keep, next)) ops.push({ o: 'order', f, ids: next });
    for (const x of b) {
      const old = am.get(x.id); if (!old || same(old, x)) continue;
      const v = {};
      for (const k of new Set([...Object.keys(old), ...Object.keys(x)])) if (k !== 'id' && !same(old[k], x[k])) v[k] = x[k] === undefined ? null : x[k];
      if (Object.keys(v).length) ops.push({ o: 'set', f, id: x.id, v });
    }
    b.forEach((x, i) => { if (!am.has(x.id)) ops.push({ o: 'add', f, v: x, after: i === 0 ? '' : b[i - 1].id }); });
    return ops;
  }

  // Patch für ein Dokument: Listenfelder werden zu Operationen, alles andere bleibt ein normaler Wert
  function toOps(cur, patch) {
    const out = {}, ops = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === '$ops') { ops.push(...v); continue; }
      if (LISTS.includes(k) && Array.isArray(v)) ops.push(...diffList(k, cur && cur[k], v));
      else out[k] = v;
    }
    if (ops.length) out.$ops = ops;
    return out;
  }

  // Zwei aufeinanderfolgende Patches zusammenfassen (Warteschlange beim Speichern)
  function mergePatch(a, b) {
    if (!a) return b ? { ...b } : null;
    const out = { ...a, ...b };
    if (a.$ops || b.$ops) out.$ops = [...(a.$ops || []), ...(b.$ops || [])];
    return out;
  }

  const api = { applyPatch, applyOps, diffList, toOps, mergePatch, LISTS };
  root.BenchPatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
