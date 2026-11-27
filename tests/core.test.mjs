import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScenario } from '../js/core/scenario.js';
import { Sim } from '../js/core/engine.js';
import { solveSheet, checkSheet, FIELDS } from '../js/core/killsheet.js';
import { capacity, annCapacity } from '../js/core/geometry.js';
import { runKill } from './autopilot.mjs';

const run = (sim, sec) => { for (let i = 0; i < sec / sim.dt; i++) sim.step(); };

function shutInWell(sim, gain = 8) {
  sim.cmd('hcr', false); sim.cmd('chokeIso', { id: 'A', open: true }); sim.cmd('choke', { id: 'A', set: 0 });
  for (let i = 0; i < 3600 / sim.dt && sim.last.pitGain < gain; i++) sim.step();
  sim.cmd('rotary', false); sim.cmd('pickUp'); sim.cmd('pump', { on: false });
  run(15);
  sim.cmd('bop', { el: 'upr', close: true }); run(10);
  sim.cmd('hcr', true);
}

test('capacity formulas', () => {
  assert.equal(capacity(4.276).toFixed(5), '0.01776');
  assert.equal(annCapacity(8.5, 5).toFixed(4), '0.0459');
});

test('kill sheet matches hand calculation', () => {
  const sc = makeScenario({ seed: 42 });
  const kick = { sidpp: 520, sicp: 780, gain: 15 };
  const { values: v } = solveSheet(sc, kick);
  const tvd = sc.well.td, omw = sc.mud.rho;
  assert.equal(v.kmw, Math.ceil((omw + 520 / (0.052 * tvd)) * 10 - 1e-9) / 10);
  assert.equal(v.icp, sc.scr[0].psi + 520);
  assert.equal(v.fcp, Math.round(sc.scr[0].psi * v.kmw / omw));
  const strVol = 0.01776 * 0; // placeholder to keep linter quiet
  assert.ok(v.stkBit > 1000 && v.stkBit < 2500, 'surface to bit strokes plausible');
  assert.ok(v.newMaasp < v.maasp, 'MAASP drops with kill mud');
  void strVol;
});

test('checker flags wrong entries and follow-through', () => {
  const sc = makeScenario({ seed: 42 });
  const kick = { sidpp: 520, sicp: 780, gain: 15 };
  const { values: v } = solveSheet(sc, kick);
  const entries = { ...v, strVol: v.strVol + 10 };
  entries.stkBit = Math.round(entries.strVol / sc.pumpOutput);
  const res = checkSheet(sc, kick, entries);
  assert.equal(res.dpVol.ok, true);
  assert.equal(res.strVol.ok, false);
  assert.equal(res.stkBit.ok, false);
  assert.equal(res.stkBit.followsOwn, true);
  assert.equal(Object.keys(res).length, FIELDS.length);
});

test('WBM shut-in stabilises at the true SIDPP, then rises with migration', () => {
  const sc = makeScenario({ seed: 1234, lineupCheck: false });
  const sim = new Sim(sc);
  shutInWell(sim);
  run(sim, 420);
  const expected = sc.pform - Math.round(0.052 * sc.mud.rho * sc.well.td);
  assert.ok(Math.abs(sim.last.spp - expected) < 12, `SIDPP ${sim.last.spp} vs ${expected}`);
  assert.ok(sim.last.cp > sim.last.spp, 'SICP above SIDPP for gas kick');
  const before = sim.last.cp;
  run(sim, 900);
  assert.ok(sim.last.cp > before + 5, 'pressure rises as gas migrates');
});

test('OBM: smaller pit gain and no migration rise', () => {
  const mk = (mud) => { const s = new Sim(makeScenario({ seed: 1234, lineupCheck: false, mudType: mud })); return s; };
  const w = mk('WBM'), o = mk('OBM');
  const tKick = w.s.kickStart + 240;
  run(w, tKick); run(o, tKick);
  assert.ok(o.last.pitGain < w.last.pitGain * 0.8, `OBM gain ${o.last.pitGain} vs WBM ${w.last.pitGain}`);
  shutInWell(o, 0); run(o, 600);
  const cp1 = o.last.cp; run(o, 900);
  assert.ok(Math.abs(o.last.cp - cp1) < 8, 'dissolved gas does not migrate');
});

test('float valve: SIDPP reads zero until float is bumped', () => {
  const sc = makeScenario({ seed: 1234, lineupCheck: false, floatValve: true });
  const sim = new Sim(sc);
  shutInWell(sim);
  run(sim, 420);
  assert.equal(Math.round(sim.last.spp), 0);
  const cpBefore = sim.last.cp;
  sim.cmd('pump', { on: true }); sim.cmd('pumpRate', { set: 3 });
  let opened = false;
  for (let i = 0; i < 120 / sim.dt; i++) { sim.step(); if (!sim.float.closed) { opened = true; break; } }
  assert.ok(opened, 'float opens');
  run(sim, 4);
  sim.cmd('pump', { on: false }); run(sim, 10);
  const over = sim.last.cp - cpBefore;
  const sidpp = sim.last.spp - over;
  const expected = sc.pform - Math.round(0.052 * sc.mud.rho * sc.well.td);
  assert.ok(Math.abs(sidpp - expected) < 25, `bumped SIDPP ${sidpp.toFixed(0)} vs ${expected}`);
});

test("Wait & Weight kill keeps BHP near formation pressure and kills the well", () => {
  const sc = makeScenario({ seed: 1234, lineupCheck: false, weightUpMin: 30 });
  const r = runKill(sc, { method: 'ww' });
  assert.ok(r.status.killed, 'well killed');
  assert.ok(r.stats.minMargin > -60, `min margin ${r.stats.minMargin}`);
  assert.ok(r.sim.last.spp < 40 && r.sim.last.cp < 50, 'pressures bled to near zero');
});

test("Driller's Method kills the well", () => {
  const sc = makeScenario({ seed: 1234, lineupCheck: false, weightUpMin: 20 });
  const r = runKill(sc, { method: 'drillers' });
  assert.ok(r.status.killed, 'well killed');
  assert.ok(r.stats.minMargin > -100, `min margin ${r.stats.minMargin}`);
});

test('tripping: hole takes less than calculated fill when swabbing', () => {
  const sc = makeScenario({ seed: 555, mode: 'tripping', lineupCheck: false });
  const sim = new Sim(sc);
  run(sim, 900);
  const actualFill = -sim.last.tripTankDelta;
  assert.ok(sim.trip.expectedFill - actualFill > 3, `expected ${sim.trip.expectedFill} actual ${actualFill}`);
});

test('MAASP coaching triggers only with gas below the shoe', async () => {
  const { maaspCheck } = await import('../js/core/procedure.js');
  const base = { maasp: 1000, shoe: 5000, sealed: true };
  assert.equal(maaspCheck({ ...base, cp: 850, gasTop: 8000 }).show, false);          // 85 %: fine
  assert.deepEqual(maaspCheck({ ...base, cp: 920, gasTop: 8000 }).level, 1);           // 92 %: warn
  assert.equal(maaspCheck({ ...base, cp: 920, gasTop: 8000, shown: 1 }).show, false);  // already shown
  assert.equal(maaspCheck({ ...base, cp: 1010, gasTop: 8000, shown: 1 }).show, true);  // now above MAASP
  assert.equal(maaspCheck({ ...base, cp: 1200, gasTop: 4000 }).show, false);           // gas above shoe: no warning
  assert.equal(maaspCheck({ ...base, cp: 1200, gasTop: null }).show, false);           // no free gas
  assert.equal(maaspCheck({ ...base, cp: 950, gasTop: 8000, sealed: false }).show, false);
  assert.equal(maaspCheck({ ...base, cp: 700, gasTop: 8000 }).reset, true);            // below 80 %: re-arm
});
