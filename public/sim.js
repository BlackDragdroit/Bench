/* Bench sim: vereinfachte Gleichstrom-Simulation für Skizzen.
   Knotenanalyse mit Newton-Iteration. Simuliert Batterie, Versorgung, Widerstand,
   Poti, Diode, LED, Schalter, Taster, Motor, Spule, NPN/PNP, N-MOSFET und Op-Amp
   (ideal, zwischen 0 V und der höchsten Versorgung). Kondensatoren sind im
   Gleichstromfall offen. IC-/Modul-Blöcke werden nicht simuliert (Pins offen). */
(function (root) {
  'use strict';

  // Pin-Reihenfolge wie in SYM in bench.html
  const PINS = {
    resistor: ['1', '2'], capacitor: ['1', '2'], cap_pol: ['+', '−'], inductor: ['1', '2'],
    diode: ['A', 'K'], led: ['A', 'K'], npn: ['B', 'C', 'E'], pnp: ['B', 'E', 'C'], nmos: ['G', 'D', 'S'],
    opamp: ['−', '+', 'out'], switch: ['1', '2'], button: ['1', '2'], pot: ['1', '2', 'W'],
    battery: ['+', '−'], motor: ['1', '2'], vcc: [''], gnd: [''], node: ['']
  };
  const pinNames = c => c.t === 'block' ? (c.pins && c.pins.length ? c.pins.map(String) : ['1', '2', '3', '4', '5', '6', '7', '8']) : (PINS[c.t] || []);

  const VT = 0.02585, GMIN = 1e-9, R_CLOSED = 0.02;

  /* ---------- Werte lesen ---------- */
  const MULT = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, r: 1, 'Ω': 1, V: 1, v: 1, '': 1 };
  function parseEng(s) {
    s = String(s == null ? '' : s).trim().replace(',', '.');
    // Poti-Kennbuchstabe vorne (A = log, B = linear, C = antilog), z. B. B10K, A1M
    s = s.replace(/^[ABC]\s*(?=\d)/i, '');
    let m = /^(\d+)([pnuµmkKMGRrΩVv])(\d+)/.exec(s);           // 4k7, 3V3, 0R1
    if (m) return parseFloat(m[1] + '.' + m[3]) * MULT[m[2]];
    m = /^(-?\d*\.?\d+)\s*([pnuµmkKMG]?)/.exec(s);
    return m ? parseFloat(m[1]) * MULT[m[2]] : null;
  }
  function parseVolt(s) {
    s = String(s == null ? '' : s);
    let m = /(-?\d+)[vV](\d+)/.exec(s); if (m) return parseFloat(m[1] + '.' + m[2]);
    m = /([+-]?\d+(?:[.,]\d+)?)\s*[vV]/.exec(s); if (m) return parseFloat(m[1].replace(',', '.'));
    const k = +((/(\d+)\s*[x×]/.exec(s) || [])[1] || 1);
    if (/(?:^|[\s\d×x*-])AAA?(?![a-z])/i.test(s)) return 1.5 * k;
    if (/CR\d{4}/i.test(s)) return 3 * k;
    if (/18650|lipo|li-?ion/i.test(s)) return 3.7 * k;
    if (/usb/i.test(s)) return 5;
    return null;
  }
  const LED_COLORS = [
    [/\b(ir|infra)/i, 'ir', 1.3, null], [/uv|violet|purple|lila/i, 'uv', 3.2, '#A45BFF'],
    [/blue|blau/i, 'blue', 3.0, '#3B82FF'], [/white|wei(ß|ss)|warm/i, 'white', 3.0, '#FFF6D8'],
    [/pink|rosa/i, 'pink', 3.0, '#FF5BB5'], [/green|grün|gruen/i, 'green', 2.2, '#36E36B'],
    [/yellow|gelb|amber/i, 'yellow', 2.0, '#FFD21F'], [/orange/i, 'orange', 2.0, '#FF8A1F'],
    [/./, 'red', 1.9, '#FF3B2F']
  ];
  function ledColor(v) { const s = String(v || 'red'); for (const [re, name, vf, hex] of LED_COLORS) if (re.test(s)) return { name, vf, hex }; return { name: 'red', vf: 1.9, hex: '#FF3B2F' }; }
  const fmtV = v => (Math.abs(v) < 0.01 ? '0' : Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)) + ' V';
  function fmtI(i) { const a = Math.abs(i); return a >= 1 ? i.toFixed(2) + ' A' : a >= 1e-3 ? (i * 1e3).toFixed(a >= 0.1 ? 0 : 1) + ' mA' : a >= 1e-6 ? (i * 1e6).toFixed(0) + ' µA' : '0 mA'; }
  function fmtR(r) { return r >= 1e6 ? +(r / 1e6).toFixed(2) + ' MΩ' : r >= 1e3 ? +(r / 1e3).toFixed(2) + ' kΩ' : +r.toFixed(r < 10 ? 1 : 0) + ' Ω'; }
  const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  function e12Up(r) { if (!(r > 0)) return 0; const d = Math.pow(10, Math.floor(Math.log10(r))); for (const e of E12) if (e * d >= r * 0.999) return e * d; return 10 * d; }

  const limexp = x => x <= 40 ? Math.exp(x) : Math.exp(40) * (1 + (x - 40));

  /* ---------- Bauteil-Modelle: Ströme in jedes Terminal hinein ---------- */
  const mk = {
    res: R => V => { const i = (V[0] - V[1]) / R; return [i, -i]; },
    src: (U, Rint) => (V, s) => { const i = (V[0] - V[1] - U * s) / Rint; return [i, -i]; },
    diode: (Is, nvt) => V => { const d = V[0] - V[1]; const i = Is * (limexp(d / nvt) - 1) + GMIN * d; return [i, -i]; },
    bjt: (pnp, Is, bf, br, nvt) => V => {
      if (!pnp) {
        const ef = limexp((V[0] - V[2]) / nvt) - 1, er = limexp((V[0] - V[1]) / nvt) - 1;   // B,C,E
        const ib = Is * (ef / bf + er / br), ic = Is * (ef - er) - Is * er / br;
        return [ib + GMIN * (V[0] - V[2]), ic, -(ib + ic) - GMIN * (V[0] - V[2])];
      }
      // PNP, Reihenfolge B,E,C
      const ef = limexp((V[1] - V[0]) / nvt) - 1, er = limexp((V[2] - V[0]) / nvt) - 1;
      const ib = Is * (ef / bf + er / br), ic = Is * (ef - er) - Is * er / br;            // aus B bzw. C heraus
      return [-ib - GMIN * (V[1] - V[0]), ib + ic + GMIN * (V[1] - V[0]), -ic];
    },
    nmos: (vth, K) => V => {           // G,D,S
      let d = V[1], s = V[2], sw = false;
      if (d < s) { [d, s] = [s, d]; sw = true; }
      const vov = 0.04 * Math.log1p(Math.exp(Math.min(60, (V[0] - s - vth) / 0.04)));    // weicher Einsatz hilft Newton
      const vds = d - s;
      let id = vds < vov ? K * (vov * vds - vds * vds / 2) : K / 2 * vov * vov;
      id *= (1 + 0.01 * vds); id += GMIN * vds;
      const ig = GMIN * (V[0] - V[2]);
      return sw ? [ig, -id, id - ig] : [ig, id, -id - ig];
    },
    opamp: (lo, hi) => (V, s) => {     // −, +, out
      const mid = (lo + hi) / 2 * s, half = Math.max(0.05, (hi - lo) / 2 * s);
      const vt = mid + half * Math.tanh(2e4 * (V[1] - V[0]) / half);
      const io = (V[2] - vt) / 50;
      return [GMIN * V[0], GMIN * V[1], io];
    }
  };

  /* ---------- Netze bilden ---------- */
  function buildNets(comps, wires) {
    const parent = new Map();
    const find = k => { let r = k; while (parent.get(r) !== r) r = parent.get(r); let x = k; while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; } return r; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const key = (c, i) => c + ':' + i;
    for (const c of comps) pinNames(c).forEach((_, i) => parent.set(key(c.id, i), key(c.id, i)));
    for (const w of wires) { const a = key(w.a.c, w.a.p), b = key(w.b.c, w.b.p); if (parent.has(a) && parent.has(b)) union(a, b); }
    // Gleichnamige Versorgungs-Symbole und alle Masse-Symbole sind verbunden
    const byName = new Map(); let gndKey = null;
    for (const c of comps) {
      if (c.t === 'gnd') { const k = key(c.id, 0); if (gndKey) union(k, gndKey); else gndKey = k; }
      if (c.t === 'vcc') { const n = String(c.v || 'VCC').trim().toUpperCase().replace(/\s+/g, '').replace(/^\+/, ''); const k = key(c.id, 0); if (byName.has(n)) union(k, byName.get(n)); else byName.set(n, k); }
    }
    const roots = new Map(); const netOf = new Map();
    for (const k of parent.keys()) { const r = find(k); if (!roots.has(r)) roots.set(r, roots.size); netOf.set(k, roots.get(r)); }
    return { netOf, count: roots.size, gndNet: gndKey ? netOf.get(gndKey) : null };
  }

  /* ---------- Gauß mit Pivotsuche ---------- */
  function solve(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c, mx = Math.abs(A[c][c]);
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > mx) { mx = Math.abs(A[r][c]); p = r; }
      if (mx < 1e-30) return null;
      if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
      for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; if (!f) continue; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
    return x;
  }

  /* ---------- Simulation ---------- */
  function simulate(sketch, state) {
    state = state || {};
    const comps = (sketch.comps || []).filter(c => c.t !== 'text');
    const wires = (sketch.wires || []).filter(w => w && w.a && w.b);
    const cm = new Map(comps.map(c => [c.id, c]));
    const findings = [];
    const add = (sev, ids, text) => findings.push({ sev, ids: [].concat(ids || []), text });
    const nameOf = c => c.l || (c.t === 'block' ? (c.v || 'IC') : c.t);

    const { netOf, count, gndNet } = buildNets(comps, wires);
    const pinNet = (c, i) => netOf.get(c.id + ':' + i);

    // Masse: Masse-Symbol, sonst Minuspol der ersten Batterie
    let ground = gndNet;
    const batteries = comps.filter(c => c.t === 'battery');
    if (ground == null && batteries.length) ground = pinNet(batteries[0], 1);
    const idx = new Map(); let N = 0;
    for (let n = 0; n < count; n++) if (n !== ground) idx.set(n, N++);
    const nodeOf = n => n === ground ? -1 : idx.get(n);

    // Versorgungen
    const supplies = [];
    for (const c of comps) {
      if (c.t === 'battery') { let U = parseVolt(c.v); if (U == null) { U = 9; add('warn', c.id, `${nameOf(c)}: no voltage in its value, so it’s simulated as 9 V. Write e.g. “9V” or “2xAA”.`); } supplies.push({ c, U }); }
      if (c.t === 'vcc') { const U = parseVolt(c.v); if (U == null) add('warn', c.id, `Supply “${c.v || 'VCC'}” has no voltage, so it isn’t simulated. Write e.g. “5V”.`); else supplies.push({ c, U }); }
    }
    const maxU = Math.max(0, ...supplies.map(s => s.U));
    if (!supplies.length) add('info', [], 'There’s no battery or supply in this sketch, so nothing can flow. Add one to simulate.');
    if (comps.some(c => c.t === 'vcc') && gndNet == null && !batteries.length) add('warn', comps.filter(c => c.t === 'vcc').map(c => c.id), 'There’s a supply symbol but no Ground symbol, so current has no way back.');

    // Elemente
    const els = [];
    const el = (c, terms, fn, extra) => els.push({ c, terms: terms.map(nodeOf), nets: terms, fn, ...extra });
    for (const c of comps) {
      const p = i => pinNet(c, i);
      switch (c.t) {
        case 'resistor': { let R = parseEng(c.v); if (!(R > 0)) { R = 1000; add('warn', c.id, `${nameOf(c)} has no value, so it’s simulated as 1 kΩ.`); } el(c, [p(0), p(1)], mk.res(Math.max(R, 1e-3)), { R }); break; }
        case 'pot': {
          let R = parseEng(c.v); if (!(R > 0)) R = 10000;
          const pos = Math.min(1, Math.max(0, state.pots && state.pots[c.id] != null ? state.pots[c.id] : 0.5));
          el(c, [p(0), p(2)], mk.res(Math.max(R * pos, 1)), { part: 'a' }); el(c, [p(2), p(1)], mk.res(Math.max(R * (1 - pos), 1)), { part: 'b' }); break;
        }
        case 'inductor': el(c, [p(0), p(1)], mk.res(0.05)); break;
        case 'motor': { const R = /Ω|ohm/i.test(c.v || '') && parseEng(c.v) > 0 ? parseEng(c.v) : 8; el(c, [p(0), p(1)], mk.res(R), { R }); break; }
        case 'switch': if (state.switches && state.switches[c.id]) el(c, [p(0), p(1)], mk.res(R_CLOSED)); break;
        case 'button': if (state.pressed && state.pressed[c.id]) el(c, [p(0), p(1)], mk.res(R_CLOSED)); break;
        case 'diode': { const schottky = /schottky|1n58|bat4|ss\d/i.test(c.v || ''); el(c, [p(0), p(1)], mk.diode(schottky ? 1e-6 : 2.5e-9, (schottky ? 1.1 : 1.75) * VT)); break; }
        case 'led': { const col = ledColor(c.v); const nvt = 2 * VT; el(c, [p(0), p(1)], mk.diode(0.02 / Math.exp(col.vf / nvt), nvt), { color: col }); break; }
        case 'npn': case 'pnp': { const darl = /tip1[24]|darl|uln|bd6[78]/i.test(c.v || ''); el(c, [p(0), p(1), p(2)], mk.bjt(c.t === 'pnp', 1e-14, darl ? 1000 : 200, 2, (darl ? 2 : 1) * VT)); break; }
        case 'nmos': { const v = c.v || ''; const vth = /irlz|irl|logic|ao3400|si2302/i.test(v) ? 1.5 : /2n7000|bs170/i.test(v) ? 2.1 : 2.5; el(c, [p(0), p(1), p(2)], mk.nmos(vth, /2n7000|bs170/i.test(v) ? 0.1 : 2)); break; }
        case 'opamp': el(c, [p(0), p(1), p(2)], mk.opamp(0, maxU || 5)); break;
        case 'battery': { const s = supplies.find(x => x.c === c); el(c, [p(0), p(1)], mk.src(s.U, 0.4), { src: true }); break; }
        case 'vcc': { const s = supplies.find(x => x.c === c); if (s) el(c, [p(0), ground], mk.src(s.U, 0.05), { src: true }); break; }
      }
    }

    // Newton mit Quellen-Hochlauf
    let v = new Array(N).fill(0), converged = N === 0, iters = 0;
    const evalAll = (vv, s, withJ) => {
      const f = new Array(N).fill(0), J = withJ ? Array.from({ length: N }, () => new Array(N).fill(0)) : null;
      for (let n = 0; n < N; n++) { f[n] += GMIN * vv[n]; if (J) J[n][n] += GMIN; }
      for (const e of els) {
        const V = e.terms.map(t => t < 0 ? 0 : vv[t]);
        const I = e.fn(V, s);
        e.terms.forEach((t, k) => { if (t >= 0) f[t] += I[k]; });
        if (!J) continue;
        e.terms.forEach((tj, j) => {
          if (tj < 0) return;
          const Vp = V.slice(); const hstep = 1e-6 * Math.max(1, Math.abs(V[j])); Vp[j] += hstep;
          const Ip = e.fn(Vp, s);
          e.terms.forEach((tk, k) => { if (tk >= 0) J[tk][tj] += (Ip[k] - I[k]) / hstep; });
        });
      }
      return { f, J };
    };
    if (N) {
      const steps = [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1];
      for (const s of steps) {
        let ok = false;
        for (let it = 0; it < 150; it++) {
          iters++;
          const { f, J } = evalAll(v, s, true);
          const dx = solve(J, f.map(x => -x)); if (!dx) break;
          let mx = 0; for (const d of dx) mx = Math.max(mx, Math.abs(d));
          const sc = mx > 0.5 ? 0.5 / mx : 1;
          for (let n = 0; n < N; n++) v[n] += dx[n] * sc;
          if (mx < 1e-7) { ok = true; break; }
        }
        if (s === 1) converged = ok;
      }
    }

    // Ergebnisse
    const netV = n => { const t = nodeOf(n); return t == null || t < 0 ? 0 : v[t]; };
    const pinI = new Map();            // Strom ins Bauteil an jedem Pin
    const readings = new Map();
    for (const e of els) {
      const V = e.terms.map(t => t < 0 ? 0 : v[t]);
      const I = e.fn(V, 1);
      const c = e.c, rd = readings.get(c.id) || { id: c.id, t: c.t, l: c.l, v: c.v };
      if (e.part === 'a') { rd.Ia = I[0]; } else if (e.part === 'b') { rd.Ib = I[0]; }
      else { rd.V = V[0] - V[1]; rd.I = I[0]; rd.Is = I; rd.Vs = V; }
      readings.set(c.id, rd);
      e.nets.forEach((n, k) => {
        if (c.t === 'vcc' && k === 1) return;     // Rückweg der Versorgung läuft über Masse, nicht über einen Pin
        const pinIdx = c.t === 'pot' ? (e.part === 'a' ? [0, 2][k] : [2, 1][k]) : k;
        const pk = c.id + ':' + pinIdx; pinI.set(pk, (pinI.get(pk) || 0) + I[k]);
      });
    }

    // Leitungsströme: je Netz einen kleinen Widerstandsgraphen lösen
    const wireI = new Map();
    const netPins = new Map();
    for (const [k, n] of netOf) { if (!netPins.has(n)) netPins.set(n, []); netPins.get(n).push(k); }
    const wiresByNet = new Map();
    for (const w of wires) { const n = netOf.get(w.a.c + ':' + w.a.p); if (n == null) continue; if (!wiresByNet.has(n)) wiresByNet.set(n, []); wiresByNet.get(n).push(w); }
    for (const [n, ws] of wiresByNet) {
      const keys = netPins.get(n), ix = new Map(keys.map((k, i) => [k, i])); const H = keys.length; const M = H + 1;   // +1 Knoten für Label-Verbindungen
      const L = Array.from({ length: M }, () => new Array(M).fill(0)); const inj = new Array(M).fill(0);
      const edge = (a, b) => { L[a][a] += 1; L[b][b] += 1; L[a][b] -= 1; L[b][a] -= 1; };
      for (const w of ws) { const a = ix.get(w.a.c + ':' + w.a.p), b = ix.get(w.b.c + ':' + w.b.p); if (a != null && b != null && a !== b) edge(a, b); }
      keys.forEach((k, i) => { const c = cm.get(k.split(':')[0]); if (c && (c.t === 'vcc' || c.t === 'gnd')) edge(i, H); inj[i] = -(pinI.get(k) || 0); });
      // Versorgungs-Rückweg und Masse: was nicht über Pins ausgeglichen wird, fließt über den Label-Knoten
      let sum = inj.reduce((a, b) => a + b, 0); inj[H] = -sum;
      for (let i = 0; i < M; i++) L[i][i] += 1e-9;
      const phi = solve(L, inj); if (!phi) continue;
      for (const w of ws) { const a = ix.get(w.a.c + ':' + w.a.p), b = ix.get(w.b.c + ':' + w.b.p); if (a != null && b != null) wireI.set(w.id, phi[a] - phi[b]); }
    }

    // Auswertung und Hinweise
    const leds = {}, motors = {};
    let supplyI = 0;
    const conn = new Map();
    for (const w of wires) for (const e of [w.a, w.b]) { const k = e.c + ':' + e.p; conn.set(k, (conn.get(k) || 0) + 1); }
    for (const c of comps) {
      const rd = readings.get(c.id);
      if (c.t !== 'block' && c.t !== 'node') {
        const names = pinNames(c), open = names.map((nm, i) => conn.get(c.id + ':' + i) ? null : (nm || String(i + 1))).filter(x => x != null);
        if (open.length && !(c.t === 'vcc' || c.t === 'gnd')) add('warn', c.id, `${nameOf(c)}: ${open.length === names.length ? 'not connected at all' : `pin ${open.join(', ')} isn’t connected`}.`);
        if (open.length && (c.t === 'vcc' || c.t === 'gnd') && comps.filter(x => x.t === c.t).length === 1) add('warn', c.id, `The ${c.t === 'gnd' ? 'Ground' : `“${c.v || 'VCC'}” supply`} symbol isn’t connected to anything.`);
      }
      if (c.t === 'block') {
        const names = pinNames(c);
        const pw = names.map((nm, i) => /^(vcc|vdd|v\+|vin|5v|3v3|3\.3v|vbat|vs|gnd|vss|v-|0v)$/i.test(nm.trim()) && !conn.get(c.id + ':' + i) ? nm : null).filter(Boolean);
        if (pw.length) add('warn', c.id, `${nameOf(c)}${c.v ? ` (${c.v})` : ''}: power pin${pw.length > 1 ? 's' : ''} ${pw.join(', ')} ${pw.length > 1 ? 'aren’t' : 'isn’t'} connected.`);
        add('info', c.id, `${nameOf(c)}${c.v ? ` (${c.v})` : ''} isn’t simulated, its pins count as open. “Check with Claude” covers it.`);
      }
      if (!rd) continue;
      if (c.t === 'battery' || c.t === 'vcc') {
        const out = -rd.I; supplyI += Math.max(0, out);
        if (out > 2) add('error', c.id, `Short circuit: ${nameOf(c) || 'the supply'} delivers ${fmtI(out)}. Look for a path straight from + to − without a load.`);
        else if (out > 0.5) add('warn', c.id, `${nameOf(c) || 'The supply'} delivers ${fmtI(out)}, which is a lot for a hobby supply or battery.`);
      }
      if (c.t === 'led') {
        const I = rd.I, b = Math.max(0, Math.min(1, I / 0.015));
        leds[c.id] = { brightness: I > 2e-4 ? Math.max(0.15, b) : 0, color: rd && ledColorOf(c), over: I > 0.03 };
        if (I > 0.03) { const R = e12Up(Math.max(10, (maxU - ledColor(c.v).vf) / 0.015)); add('error', c.id, `${nameOf(c)} gets ${fmtI(I)}, a normal LED takes about 20 mA. Put a resistor in series, around ${fmtR(R)}.`); }
        else if (I > 0.022) add('warn', c.id, `${nameOf(c)} gets ${fmtI(I)}, a bit more than the usual 20 mA.`);
        if (-rd.V > 5) add('warn', c.id, `${nameOf(c)} sits backwards across ${fmtV(-rd.V)}; LEDs only take about 5 V in reverse.`);
      }
      if (c.t === 'resistor' && rd.R) { const P = rd.I * rd.I * rd.R; if (P > 0.5) add('error', c.id, `${nameOf(c)} burns ${P.toFixed(2)} W, a ¼ W resistor won’t survive that.`); else if (P > 0.25) add('warn', c.id, `${nameOf(c)} dissipates ${P.toFixed(2)} W, more than a standard ¼ W resistor likes.`); }
      if (c.t === 'motor') { const I = rd.I; motors[c.id] = Math.abs(I) > 0.03 ? Math.sign(I) * Math.min(1, Math.abs(I) / 0.5) : 0; }
      if ((c.t === 'npn' || c.t === 'pnp') && rd.Is) { const ib = Math.abs(rd.Is[0]); if (ib > 0.02) add('warn', c.id, `${nameOf(c)}: the base draws ${fmtI(ib)}. It probably needs a base resistor.`); }
    }
    for (const c of comps.filter(x => x.t === 'cap_pol')) { const d = netV(pinNet(c, 0)) - netV(pinNet(c, 1)); if (d < -0.5) add('error', c.id, `${nameOf(c)} (electrolytic) is in backwards: − is ${fmtV(-d)} higher than +.`); }
    for (const c of comps.filter(x => x.t === 'nmos')) {
      const g = pinNet(c, 0), others = [...netOf].filter(([k, n]) => n === g && !k.startsWith(c.id + ':')).map(([k]) => cm.get(k.split(':')[0])).filter(x => x && !['node', 'capacitor', 'cap_pol', 'block'].includes(x.t));
      if (!others.length) add('warn', c.id, `${nameOf(c)}: the gate is floating. Add a pull-down resistor to ground so it switches off reliably.`);
    }
    if (comps.some(c => c.t === 'opamp')) add('info', comps.filter(c => c.t === 'opamp').map(c => c.id), `Op-amps are simulated as ideal amplifiers powered from 0 V to ${fmtV(maxU || 5)}.`);
    if (N && !converged) add('warn', [], 'The simulation didn’t settle, so some readings may be off.');
    if (supplies.length && supplyI < 1e-6 && els.some(e => !e.src)) add('info', [], 'Nothing flows right now. Close a switch, press a button, or check that the circuit forms a loop.');

    const order = { error: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.sev] - order[b.sev]);
    return { converged, iters, supplyI, maxU, readings, netV, netOf, wireI, leds, motors, findings,
      nets: count, ground };
  }
  function ledColorOf(c) { return ledColor(c.v); }

  const api = { simulate, parseEng, parseVolt, ledColor, fmtV, fmtI, fmtR, pinNames, buildNets };
  root.BenchSim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
