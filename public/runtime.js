/* Bench runtime: baut die Schnittstelle von window.claude.use(name) aus den
   Claude-Artifacts nach und spricht dafür mit dem eigenen Backend.
   Genutzt werden: db, user, assets, downloads, sample. */
(function () {
  'use strict';
  const CONFIG = window.BENCH_CONFIG || {};
  const POLL_MS = 12000;

  const err = (code, extra) => Object.assign(new Error(code), { code }, extra || {});

  async function api(method, url, body, opts = {}) {
    let res;
    const init = { method, credentials: 'same-origin', headers: { ...(opts.headers || {}) }, signal: opts.signal };
    if (body !== undefined) {
      if (opts.raw) init.body = body;
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    try { res = await fetch(url, init); }
    catch (e) { if (e && e.name === 'AbortError') throw err('cancelled'); throw err('unavailable'); }
    if (res.status === 401) { location.href = '/login'; throw err('unauthenticated'); }
    if (res.status === 304) return { notModified: true, res };
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const code = (data && data.code) || (res.status === 413 ? 'too_large' : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'unavailable' : 'invalid_argument');
      throw err(code, { status: res.status });
    }
    return { data, res };
  }

  /* ================= db ================= */
  // Pfade der App → Tabellen auf dem Server
  const COLL_MAP = [
    [/^data\/users\/[^/]+\/projects\/items$/, 'projects'],
    [/^data\/users\/[^/]+\/library\/parts$/, 'parts'],
    [/^data\/users\/[^/]+\/sketches\/items$/, 'sketches'],
    [/^data\/users\/[^/]+\/drop\/items$/, 'drops']
  ];
  function tableOf(path) {
    for (const [re, t] of COLL_MAP) if (re.test(path)) return t;
    throw err('invalid_argument', { message: 'unknown collection ' + path });
  }

  // Schreibzugriffe, die noch unterwegs sind, werden über Abfrage-Ergebnisse gelegt,
  // damit beim Polling kein alter Stand kurz aufblitzt.
  const inflight = new Map();          // table → [{ id, mode, data }]
  const writeGen = new Map();          // table → Zähler abgeschlossener Schreibzugriffe
  const listeners = new Set();

  function overlay(table, docs) {
    const ops = inflight.get(table);
    if (!ops || !ops.length) return docs;
    const map = new Map(docs.map(d => [d.id, d.data]));
    for (const op of ops) {
      if (op.mode === 'delete') map.delete(op.id);
      else if (op.mode === 'set') map.set(op.id, op.data);
      else map.set(op.id, { ...(map.get(op.id) || {}), ...op.data });
    }
    return [...map].map(([id, data]) => ({ id, data }));
  }

  function snapshot(docs) {
    const list = docs.map(d => ({ id: d.id, exists: true, data: () => d.data }));
    return { docs: list, size: list.length, empty: !list.length, forEach: f => list.forEach(f) };
  }

  async function write(table, id, mode, data) {
    const op = { id, mode, data };
    if (!inflight.has(table)) inflight.set(table, []);
    inflight.get(table).push(op);
    const url = `/api/db/${table}/${encodeURIComponent(id)}`;
    try {
      if (mode === 'set') await api('PUT', url, data);
      else if (mode === 'update') await api('PATCH', url, data);
      else await api('DELETE', url);
    } finally {
      const ops = inflight.get(table); const i = ops.indexOf(op); if (i >= 0) ops.splice(i, 1);
      writeGen.set(table, (writeGen.get(table) || 0) + 1);
      refreshSoon(table);
    }
  }

  const refreshTimers = new Map();
  function refreshSoon(table) {
    clearTimeout(refreshTimers.get(table));
    refreshTimers.set(table, setTimeout(() => { for (const l of listeners) if (l.table === table) poll(l, true); }, 120));
  }

  async function fetchDocs(table, where, etag) {
    const qs = where ? `?field=${encodeURIComponent(where.field)}&value=${encodeURIComponent(where.value)}` : '';
    const r = await api('GET', `/api/db/${table}${qs}`, undefined, { headers: etag ? { 'If-None-Match': etag } : {} });
    if (r.notModified) return null;
    return { docs: r.data.docs, etag: r.res.headers.get('ETag') };
  }

  async function poll(l, force) {
    if (l.closed) return;
    if (l.busy) { l.again = l.again || force; return; }
    l.busy = true;
    const gen = writeGen.get(l.table) || 0;
    try {
      const r = await fetchDocs(l.table, l.where, force ? null : l.etag);
      if (l.closed) return;
      // Ist während der Abfrage ein Schreibzugriff fertig geworden, ist das
      // Ergebnis womöglich veraltet; die nächste Abfrage läuft ohnehin gleich.
      if (r && (writeGen.get(l.table) || 0) === gen) {
        l.etag = r.etag;
        const docs = overlay(l.table, r.docs);
        const sig = JSON.stringify(docs);
        if (sig !== l.sig) { l.sig = sig; l.next(snapshot(docs)); }
      } else if (r) l.again = true;
      l.failed = false;
    } catch (e) {
      if (!l.failed && l.error && e.code !== 'unavailable') l.error(e);
      l.failed = true;
    } finally {
      l.busy = false;
      if (l.again && !l.closed) { l.again = false; poll(l, true); }
    }
  }

  setInterval(() => { if (document.visibilityState === 'visible') for (const l of listeners) poll(l); }, POLL_MS);
  const wake = () => { if (document.visibilityState === 'visible') for (const l of listeners) poll(l); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);

  function docRef(path, table, id) {
    return {
      id, path,
      set: data => write(table, id, 'set', data),
      update: patch => write(table, id, 'update', patch),
      delete: () => write(table, id, 'delete'),
      async get() {
        const r = await api('GET', `/api/db/${table}/${encodeURIComponent(id)}`);
        const d = r.data;
        return { id, exists: !!d.exists, data: () => (d.exists ? d.data : undefined) };
      }
    };
  }

  function query(path, table, where) {
    return {
      path,
      doc: id => docRef(`${path}/${id}`, table, id),
      where(field, op, value) {
        if (op !== '==') throw err('invalid_argument', { message: 'only == is supported' });
        return query(path, table, { field, value });
      },
      async get() {
        const r = await fetchDocs(table, where);
        return snapshot(overlay(table, r.docs));
      },
      onSnapshot(next, error) {
        const l = { table, where, next, error, etag: null, sig: null, busy: false, again: false, closed: false };
        listeners.add(l);
        poll(l, true);
        return () => { l.closed = true; listeners.delete(l); };
      }
    };
  }

  const db = { collection: path => query(path, tableOf(path), null) };

  /* ================= assets ================= */
  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type || 'application/octet-stream';
      if (CONFIG.maxUploadMB && blob.size > CONFIG.maxUploadMB * 1048576) throw err('too_large');
      const r = await api('POST', '/api/assets', blob, { raw: true, headers: { 'Content-Type': type } });
      return r.data;
    },
    async list() { return (await api('GET', '/api/assets/usage')).data; },
    async delete(id) { await api('DELETE', '/api/assets/' + encodeURIComponent(id)); }
  };

  /* ================= downloads ================= */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: typeof data === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'download'; a.rel = 'noopener'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  };

  /* ================= sample (Teilesuche) ================= */
  // Fotos vom Handy sind oft riesig. Auf max. 1568 px verkleinern und als JPEG
  // schicken; das reicht zum Lesen von Aufdrucken und bleibt unter der API-Grenze.
  async function prepImage(file) {
    const toB64 = async b => {
      const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    };
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 3.5 * 1048576 && /^image\/(jpeg|png|webp|gif)$/.test(file.type)) { bmp.close && bmp.close(); return { type: file.type, data: await toB64(file) }; }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
      const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      return { type: 'image/jpeg', data: await toB64(out) };
    } catch (e) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw err('image_rejected');
      return { type: file.type, data: await toB64(file) };
    }
  }
  const sample = {
    async limits() { return { images: !!CONFIG.identify }; },
    async json(prompt, opts = {}) {
      const images = opts.images && opts.images.length ? await Promise.all(opts.images.map(prepImage)) : undefined;
      const r = await api('POST', '/api/identify', { prompt, images }, { signal: opts.signal });
      return r.data;
    }
  };

  /* ================= user ================= */
  const user = { async id() { return 'me'; } };

  const caps = { db, user, assets, downloads, sample: CONFIG.identify ? sample : null };
  window.claude = {
    async use(name) {
      if (!(name in caps)) throw err('capability_disabled');
      return caps[name];
    }
  };
})();
