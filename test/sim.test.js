import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

// sim.js ist ein klassisches Browser-Skript; hier in einer eigenen Umgebung laden
const ctx = { module: { exports: {} } }; ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(new URL('../public/sim.js', import.meta.url), 'utf8'), ctx);
const Sim = ctx.module.exports;
void createRequire;

let n = 0;
const C = (t, v = '', extra = {}) => ({ id: t + (++n), t, l: '', v, x: 0, y: 0, r: 0, ...extra });
const W = (a, ap, b, bp) => ({ id: 'w' + (++n), a: { c: a.id, p: ap }, b: { c: b.id, p: bp } });
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('Werte lesen', () => {
  assert.equal(Sim.parseEng('10k'), 10000);
  assert.equal(Sim.parseEng('4k7'), 4700);
  near(Sim.parseEng('100n'), 1e-7, 1e-12);
  assert.equal(Sim.parseEng('220'), 220);
  assert.equal(Sim.parseEng('1M'), 1e6);
  assert.equal(Sim.parseEng('B1K'), 1000);
  assert.equal(Sim.parseEng('A10k'), 10000);
  assert.equal(Sim.parseEng('B 2K2'), 2200);
  assert.equal(Sim.parseEng('10K lin'), 10000);
  assert.equal(Sim.parseEng('B500'), 500);
  assert.equal(Sim.parseVolt('9V'), 9);
  assert.equal(Sim.parseVolt('3V3'), 3.3);
  assert.equal(Sim.parseVolt('2xAA'), 3);
  assert.equal(Sim.parseVolt('VCC'), null);
});

test('Batterie, Vorwiderstand, LED: Strom und Leuchten', () => {
  const bt = C('battery', '9V'), r = C('resistor', '470'), d = C('led', 'red');
  const s = Sim.simulate({ comps: [bt, r, d], wires: [W(bt, 0, r, 0), W(r, 1, d, 0), W(d, 1, bt, 1)] });
  assert.ok(s.converged);
  const I = s.readings.get(d.id).I;
  near(I, (9 - 1.9) / 470, 0.002);
  assert.ok(s.leds[d.id].brightness > 0.5);
  assert.ok(!s.findings.some(f => f.sev === 'error'));
  // Strom fließt durch alle Leitungen gleich stark
  for (const v of s.wireI.values()) near(Math.abs(v), I, 1e-4);
});

test('LED direkt an 9 V meldet Überstrom mit Vorschlag', () => {
  const bt = C('battery', '9V'), d = C('led', 'red');
  const s = Sim.simulate({ comps: [bt, d], wires: [W(bt, 0, d, 0), W(d, 1, bt, 1)] });
  const f = s.findings.find(x => x.sev === 'error' && x.ids.includes(d.id));
  assert.ok(f, JSON.stringify(s.findings));
  assert.match(f.text, /resistor/);
});

test('Schalter offen: nichts fließt, geschlossen: LED leuchtet', () => {
  const bt = C('battery', '9V'), sw = C('switch'), r = C('resistor', '1k'), d = C('led', 'green');
  const sk = { comps: [bt, sw, r, d], wires: [W(bt, 0, sw, 0), W(sw, 1, r, 0), W(r, 1, d, 0), W(d, 1, bt, 1)] };
  const off = Sim.simulate(sk, {});
  assert.equal(off.leds[d.id].brightness, 0);
  assert.ok(off.findings.some(f => /Nothing flows/.test(f.text)));
  const on = Sim.simulate(sk, { switches: { [sw.id]: true } });
  assert.ok(on.leds[d.id].brightness > 0.3);
});

test('NPN schaltet LED über Taster, mit Masse- und Versorgungssymbol', () => {
  const v1 = C('vcc', '5V'), v2 = C('vcc', '5V'), g1 = C('gnd'), g2 = C('gnd');
  const btn = C('button'), rb = C('resistor', '10k'), q = C('npn', 'BC547'), rc = C('resistor', '330'), d = C('led', 'red');
  const sk = { comps: [v1, v2, g1, g2, btn, rb, q, rc, d], wires: [
    W(v1, 0, btn, 0), W(btn, 1, rb, 0), W(rb, 1, q, 0),
    W(v2, 0, rc, 0), W(rc, 1, d, 0), W(d, 1, q, 1), W(q, 2, g1, 0), W(g2, 0, g2, 0)] };
  const off = Sim.simulate(sk, {});
  assert.ok(off.leds[d.id].brightness === 0);
  const on = Sim.simulate(sk, { pressed: { [btn.id]: true } });
  assert.ok(on.converged);
  near(on.readings.get(d.id).I, (5 - 1.9 - 0.1) / 330, 0.002);
});

test('Kurzschluss über die Batterie', () => {
  const bt = C('battery', '9V'), sw = C('switch');
  const s = Sim.simulate({ comps: [bt, sw], wires: [W(bt, 0, sw, 0), W(sw, 1, bt, 1)] }, { switches: { [sw.id]: true } });
  assert.ok(s.findings.some(f => f.sev === 'error' && /Short circuit/.test(f.text)));
});

test('MOSFET mit offenem Gate und offene Pins werden gemeldet', () => {
  const bt = C('battery', '12V'), m = C('motor'), q = C('nmos', 'IRLZ44N');
  const s = Sim.simulate({ comps: [bt, m, q], wires: [W(bt, 0, m, 0), W(m, 1, q, 1), W(q, 2, bt, 1)] });
  assert.ok(s.findings.some(f => /gate is floating/.test(f.text)));
  assert.ok(s.findings.some(f => /pin G isn’t connected/.test(f.text)));
});

test('Poti als Spannungsteiler', () => {
  const v = C('vcc', '10V'), g = C('gnd'), g2 = C('gnd'), p = C('pot', '10k'), r = C('resistor', '1M');
  const sk = { comps: [v, g, g2, p, r], wires: [W(v, 0, p, 0), W(p, 1, g, 0), W(p, 2, r, 0), W(r, 1, g2, 0)] };
  const s = Sim.simulate(sk, { pots: { [p.id]: 0.25 } });
  near(s.readings.get(r.id).V, 7.5, 0.1);
});

test('Elko falsch herum', () => {
  const bt = C('battery', '9V'), c = C('cap_pol', '10µ'), r = C('resistor', '1k');
  const s = Sim.simulate({ comps: [bt, c, r], wires: [W(bt, 1, c, 0), W(c, 1, bt, 0), W(bt, 0, r, 0), W(r, 1, bt, 1)] });
  assert.ok(s.findings.some(f => /backwards/.test(f.text)), JSON.stringify(s.findings));
});

test('IC-Block wird nicht simuliert, offene Versorgungspins fallen auf', () => {
  const bt = C('battery', '9V'), u = C('block', 'NE555', { pins: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC'] });
  const s = Sim.simulate({ comps: [bt, u], wires: [W(bt, 1, u, 0)] });
  assert.ok(s.findings.some(f => /power pin VCC/.test(f.text)));
  assert.ok(s.findings.some(f => /isn’t simulated/.test(f.text)));
});
