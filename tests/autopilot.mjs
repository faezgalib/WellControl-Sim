// Scripted "perfect crew" used to validate the physics: detect, shut in, kill.
import { Sim } from '../js/core/engine.js';
import { solveSheet, scheduleAt } from '../js/core/killsheet.js';

export function runKill(scen, { method = 'ww', killSpm = null, verbose = false, maxHours = 14 } = {}) {
  const sim = new Sim(scen);
  const dt = sim.dt;
  const run = (sec, fn) => { const n = Math.round(sec / dt); for (let i = 0; i < n; i++) { sim.step(); if (fn && fn() === false) return; } };
  const log = (...a) => verbose && console.log(...a);

  // fix the line-up if wrong
  sim.cmd('hcr', false); sim.cmd('chokeIso', { id: 'A', open: true }); sim.cmd('choke', { id: 'A', set: 0 });
  // drill until pit gain 8 bbl
  run(3600, () => !(sim.last.pitGain >= 8));
  sim.cmd('rotary', false); sim.cmd('pickUp'); sim.cmd('pump', { on: false });
  run(15);
  sim.cmd('bop', { el: 'upr', close: true }); run(10);
  sim.cmd('hcr', true);
  run(600); // stabilise
  const kick = { sidpp: Math.round(sim.last.spp), sicp: Math.round(sim.last.cp), gain: +sim.last.pitGain.toFixed(1) };
  sim.cmd('record', kick);
  const sheet = solveSheet(scen, kick);
  const v = sheet.values;
  log('kick', kick, 'KMW', v.kmw, 'ICP', v.icp, 'FCP', v.fcp, 'stkBit', v.stkBit, 'stkBu', v.stkBu);
  const spm = killSpm ?? scen.scr[0].spm;

  const stats = { minMargin: Infinity, maxMargin: -Infinity, maxCp: 0, maxShoeOver: -Infinity, log: [] };
  const track = (phase) => {
    const L = sim.last;
    const m = L.bhp - L.pform;
    stats.ph = stats.ph || {}; const q = (stats.ph[phase] = stats.ph[phase] || { min: Infinity, max: -Infinity }); q.min = Math.min(q.min, m); q.max = Math.max(q.max, m);
    if (phase !== 'startup' && phase !== 'shutdown') { stats.minMargin = Math.min(stats.minMargin, m); stats.maxMargin = Math.max(stats.maxMargin, m); }
    stats.maxCp = Math.max(stats.maxCp, L.cp);
    stats.maxShoeOver = Math.max(stats.maxShoeOver, L.pShoe - L.fracShoe);
  };
  // choke controller on a measured pressure
  let integ = 0;
  // integrating controller: choke rate (%/s) proportional to error, capped (patient operator)
  const control = (meas, target, gain = 0.006, cap = 1.5) => {
    const err = target - meas;           // positive -> need more pressure -> close choke
    const rate = Math.max(-cap, Math.min(cap, -gain * err));
    sim.cmd('choke', { delta: rate * dt });
  };

  const startUp = (holdCp) => {
    sim.cmd('resetStrokes');
    sim.cmd('pump', { on: true });
    integ = 0;
    for (let s = 0; s < 200 / dt; s++) {
      const p = sim.pumps[sim.activePump];
      p.target = Math.min(spm, 3 + (s * dt) * (spm / 150));
      sim.step();
      control(sim.last.cp, holdCp, 0.05, 5);
      track('startup');
    }
  };
  const circulate = (strokes, targetFn, phase) => {
    sim.cmd('resetStrokes');
    integ = 0;
    while (sim.counters.strokes < strokes && sim.t < maxHours * 3600) {
      sim.step();
      control(sim.last.spp, targetFn(sim.counters.strokes));
      track(phase);
    }
  };
  const shutDown = (holdCp) => {
    for (let s = 0; s < 90 / dt; s++) {
      const p = sim.pumps[sim.activePump];
      p.target = Math.max(0, spm - (s * dt) * (spm / 60));
      sim.step();
      control(sim.last.cp, holdCp, 0.05, 5);
      track('shutdown');
    }
    sim.cmd('pump', { on: false });
    sim.cmd('choke', { set: 0 });
    run(60);
  };

  const sicpNow = () => sim.last.cp;
  if (method === 'ww') {
    sim.cmd('method', 'ww');
    scen.weightUpMin = scen.weightUpMin ?? 40;
    sim.cmd('weightUp', v.kmw);
    // wait for kill mud, bleeding to hold SIDPP + 50 margin (volumetric while waiting)
    const holdSidpp = kick.sidpp + 50;
    while (sim.pits.killPit.rho === null) {
      sim.step();
      if (sim.last.spp > holdSidpp + 50) sim.cmd('choke', { set: 8 }); else if (sim.last.spp < holdSidpp) sim.cmd('choke', { set: 0 });
      track('wait');
    }
    sim.cmd('choke', { set: 0 }); run(30);
    sim.cmd('suction', 'kill');
    const cp0 = sicpNow();
    startUp(cp0);
    const icpActual = sim.last.spp; // observed ICP after start-up
    const offset = icpActual - v.icp;
    log('ICP calc', v.icp, 'observed', icpActual.toFixed(0), 'CP', sim.last.cp.toFixed(0));
    const done0 = sim.counters.strokes;
    circulate(v.stkTotal - done0, (stk) => scheduleAt(v.icp, v.fcp, v.stkBit, stk + done0) + offset, 'kill');
    shutDown(sim.last.cp);
  } else {
    sim.cmd('method', 'drillers');
    const cp0 = sicpNow();
    startUp(cp0);
    const icpActual = sim.last.spp;
    log('1st circ ICP observed', icpActual.toFixed(0));
    const done0 = sim.counters.strokes;
    circulate(v.stkTotal + 200 - done0, () => icpActual, 'circ1');
    sim.cmd('weightUp', v.kmw);
    shutDown(sim.last.cp);
    log('after 1st circ SIDPP', sim.last.spp?.toFixed(0), 'SICP', sim.last.cp.toFixed(0));
    while (sim.pits.killPit.rho === null) { sim.step(); track('wait'); }
    sim.cmd('suction', 'kill');
    const cp1 = sicpNow();
    startUp(cp1);
    const d1 = sim.counters.strokes;
    // hold CP constant until kill mud at bit, then hold DP at FCP observed
    integ = 0;
    sim.cmd('resetStrokes');
    let fcpObs = null;
    while (sim.counters.strokes < v.stkTotal + 200 - d1 && sim.t < maxHours * 3600) {
      sim.step();
      if (sim.counters.strokes + d1 < v.stkBit) control(sim.last.cp, cp1, 0.02, 3);
      else { if (fcpObs === null) { fcpObs = sim.last.spp; integ = 0; } control(sim.last.spp, fcpObs); }
      track('circ2');
    }
    shutDown(sim.last.cp);
  }
  run(120);
  const st = sim.wellStatus();
  log('final SIDPP', sim.last.spp?.toFixed(0), 'SICP', sim.last.cp.toFixed(0), 'status', st, 'hours', (sim.t / 3600).toFixed(2));
  return { sim, kick, sheet, stats, status: st };
}
