// Surface BOP, vertical well kill sheet: calculations and line-by-line checking.
// Rounding conventions used (to be confirmed against course material):
//  - Kill mud density rounded UP to 0.1 ppg
//  - Maximum allowable mud density rounded DOWN to 0.1 ppg
//  - MAASP rounded DOWN to whole psi
//  - Volumes to 0.1 bbl, strokes and pressures to whole numbers, times to whole minutes

import { volumeBreakdown } from './geometry.js';

const up1 = (x) => Math.ceil(x * 10 - 1e-9) / 10;
const down1 = (x) => Math.floor(x * 10 + 1e-9) / 10;
const r1 = (x) => Math.round(x * 10) / 10;

/** Ordered field definitions. calc(v, ctx) uses earlier CORRECT values in v. */
export const FIELDS = [
  { key: 'maxMw', sec: 'formation', label: 'Maximum allowable mud density', unit: 'ppg', tol: { abs: 0.01 },
    f: 'Test mud density + Surface LOT pressure ÷ (0.052 × Shoe TVD)  → round down to 0.1',
    calc: (v, c) => down1(c.lot.testMw + c.lot.psi / (0.052 * c.shoe)) },
  { key: 'maasp', sec: 'formation', label: 'Initial MAASP', unit: 'psi', tol: { abs: 2 },
    f: '(Max. allowable mud density − Current mud density) × 0.052 × Shoe TVD',
    calc: (v, c) => Math.floor((v.maxMw - c.omw) * 0.052 * c.shoe + 1e-9) },
  { key: 'dpVol', sec: 'string', label: 'Drill pipe volume', unit: 'bbl', tol: { abs: 0.3, rel: 0.003 },
    f: 'DP capacity × DP length', calc: (v, c) => r1(c.vb.dpVol) },
  { key: 'hwVol', sec: 'string', label: 'HWDP volume', unit: 'bbl', tol: { abs: 0.2, rel: 0.003 },
    f: 'HWDP capacity × HWDP length', calc: (v, c) => r1(c.vb.hwVol) },
  { key: 'dcVol', sec: 'string', label: 'Drill collar volume', unit: 'bbl', tol: { abs: 0.2, rel: 0.003 },
    f: 'DC capacity × DC length', calc: (v, c) => r1(c.vb.dcVol) },
  { key: 'strVol', sec: 'string', label: 'Drill string volume', unit: 'bbl', tol: { abs: 0.4, rel: 0.003 },
    f: 'DP + HWDP + DC volumes', calc: (v) => r1(v.dpVol + v.hwVol + v.dcVol) },
  { key: 'stkBit', sec: 'string', label: 'Surface to bit strokes', unit: 'stk', tol: { abs: 3, rel: 0.003 },
    f: 'Drill string volume ÷ Pump output', calc: (v, c) => Math.round(v.strVol / c.po) },
  { key: 'timeBit', sec: 'string', label: 'Surface to bit time', unit: 'min', tol: { abs: 1 },
    f: 'Surface to bit strokes ÷ SCR (spm)', calc: (v, c) => Math.round(v.stkBit / c.spm) },
  { key: 'ohDcVol', sec: 'annulus', label: 'DC × open hole volume', unit: 'bbl', tol: { abs: 0.3, rel: 0.003 },
    f: 'Annular capacity (OH × DC) × DC length', calc: (v, c) => r1(c.vb.ohDcVol) },
  { key: 'ohDpVol', sec: 'annulus', label: 'DP/HWDP × open hole volume', unit: 'bbl', tol: { abs: 0.5, rel: 0.003 },
    f: 'Annular capacity (OH × DP) × (Open hole length − DC length)', calc: (v, c) => r1(c.vb.ohDpVol) },
  { key: 'ohVol', sec: 'annulus', label: 'Total open hole volume', unit: 'bbl', tol: { abs: 0.5, rel: 0.003 },
    f: 'DC × OH + DP × OH volumes', calc: (v) => r1(v.ohDcVol + v.ohDpVol) },
  { key: 'stkShoe', sec: 'annulus', label: 'Bit to shoe strokes', unit: 'stk', tol: { abs: 3, rel: 0.003 },
    f: 'Open hole volume ÷ Pump output', calc: (v, c) => Math.round(v.ohVol / c.po) },
  { key: 'timeShoe', sec: 'annulus', label: 'Bit to shoe time', unit: 'min', tol: { abs: 1 },
    f: 'Bit to shoe strokes ÷ SCR (spm)', calc: (v, c) => Math.round(v.stkShoe / c.spm) },
  { key: 'csgVol', sec: 'annulus', label: 'DP × casing volume', unit: 'bbl', tol: { abs: 0.5, rel: 0.003 },
    f: 'Annular capacity (Casing × DP) × Shoe depth', calc: (v, c) => r1(c.vb.csgDpVol) },
  { key: 'annVol', sec: 'annulus', label: 'Total annulus volume', unit: 'bbl', tol: { abs: 0.8, rel: 0.003 },
    f: 'Open hole volume + Cased hole volume', calc: (v) => r1(v.ohVol + v.csgVol) },
  { key: 'stkBu', sec: 'annulus', label: 'Bottoms-up strokes (bit to surface)', unit: 'stk', tol: { abs: 5, rel: 0.003 },
    f: 'Total annulus volume ÷ Pump output', calc: (v, c) => Math.round(v.annVol / c.po) },
  { key: 'timeBu', sec: 'annulus', label: 'Bottoms-up time', unit: 'min', tol: { abs: 1 },
    f: 'Bottoms-up strokes ÷ SCR (spm)', calc: (v, c) => Math.round(v.stkBu / c.spm) },
  { key: 'wellVol', sec: 'totals', label: 'Total well system volume', unit: 'bbl', tol: { abs: 1, rel: 0.003 },
    f: 'Drill string volume + Total annulus volume', calc: (v) => r1(v.strVol + v.annVol) },
  { key: 'stkTotal', sec: 'totals', label: 'Total circulation strokes (incl. surface lines)', unit: 'stk', tol: { abs: 6, rel: 0.003 },
    f: '(Well system volume + Surface line volume) ÷ Pump output', calc: (v, c) => Math.round((v.wellVol + c.surfLine) / c.po) },
  { key: 'timeTotal', sec: 'totals', label: 'Total circulation time', unit: 'min', tol: { abs: 1 },
    f: 'Total circulation strokes ÷ SCR (spm)', calc: (v, c) => Math.round(v.stkTotal / c.spm) },
  // ---- kick calculations ----
  { key: 'pform', sec: 'kick', label: 'Formation pressure', unit: 'psi', tol: { abs: 2 },
    f: 'SIDPP + (Current mud density × 0.052 × TVD)', calc: (v, c) => Math.round(c.kick.sidpp + c.omw * 0.052 * c.tvd) },
  { key: 'kmw', sec: 'kick', label: 'Kill mud density', unit: 'ppg', tol: { abs: 0.01 },
    f: 'Current mud density + SIDPP ÷ (0.052 × TVD)  → round up to 0.1', calc: (v, c) => up1(c.omw + c.kick.sidpp / (0.052 * c.tvd)) },
  { key: 'icp', sec: 'kick', label: 'Initial circulating pressure (ICP)', unit: 'psi', tol: { abs: 2 },
    f: 'SCR pressure + SIDPP', calc: (v, c) => Math.round(c.scrPsi + c.kick.sidpp) },
  { key: 'fcp', sec: 'kick', label: 'Final circulating pressure (FCP)', unit: 'psi', tol: { abs: 3 },
    f: 'SCR pressure × Kill mud density ÷ Current mud density', calc: (v, c) => Math.round(c.scrPsi * v.kmw / c.omw) },
  { key: 'step', sec: 'kick', label: 'Pressure drop per 100 strokes', unit: 'psi', tol: { abs: 0.6 },
    f: '(ICP − FCP) × 100 ÷ Surface to bit strokes', calc: (v) => r1(((v.icp - v.fcp) * 100) / v.stkBit) },
  { key: 'newMaasp', sec: 'kick', label: 'New MAASP (kill mud)', unit: 'psi', tol: { abs: 3 },
    f: '(Max. allowable mud density − Kill mud density) × 0.052 × Shoe TVD', calc: (v, c) => Math.floor((v.maxMw - v.kmw) * 0.052 * c.shoe + 1e-9) },
];

export const SECTIONS = {
  formation: 'Formation strength',
  string: 'Drill string volume',
  annulus: 'Annular volume',
  totals: 'Totals',
  kick: 'Kick data calculations',
};

export function sheetContext(scen, kick = { sidpp: 0, sicp: 0, gain: 0 }, scrIndex = 0) {
  return {
    omw: scen.mud.rho, tvd: scen.well.td, shoe: scen.well.shoe.depth,
    lot: scen.lot, po: scen.pumpOutput, spm: scen.scr[scrIndex].spm, scrPsi: scen.scr[scrIndex].psi,
    surfLine: scen.well.surfLine, vb: volumeBreakdown(scen.well), kick,
  };
}

/** All correct values for a scenario and kick data. */
export function solveSheet(scen, kick, scrIndex = 0) {
  const c = sheetContext(scen, kick, scrIndex);
  const v = {};
  for (const f of FIELDS) v[f.key] = f.calc(v, c);
  return { values: v, ctx: c, schedule: schedule(v.icp, v.fcp, v.stkBit) };
}

export function schedule(icp, fcp, stkBit, steps = 10) {
  const out = [];
  for (let i = 0; i <= steps; i++) out.push({ stk: Math.round((stkBit * i) / steps), psi: Math.round(icp - ((icp - fcp) * i) / steps) });
  return out;
}

/** Interpolated drill pipe target for a stroke count (W&W). */
export function scheduleAt(icp, fcp, stkBit, stk) {
  if (stk >= stkBit) return fcp;
  return icp - ((icp - fcp) * stk) / stkBit;
}

function within(val, ref, tol) {
  const d = Math.abs(val - ref);
  return d <= (tol.abs ?? 0) || (tol.rel && d <= Math.abs(ref) * tol.rel);
}

/**
 * Check user's entries. Returns per-field { ok, expected, entered, followsOwn } where
 * followsOwn means the entry is correct given the user's own earlier (wrong) values.
 */
export function checkSheet(scen, kick, entries, scrIndex = 0) {
  const c = sheetContext(scen, kick, scrIndex);
  const correct = {}, own = {};
  const res = {};
  for (const f of FIELDS) {
    correct[f.key] = f.calc(correct, c);
    let ownExp = null;
    try { ownExp = f.calc(own, c); } catch { ownExp = null; }
    const e = entries[f.key];
    const entered = e === '' || e === null || e === undefined ? null : Number(e);
    const ok = entered !== null && Number.isFinite(entered) && within(entered, correct[f.key], f.tol);
    const followsOwn = !ok && entered !== null && Number.isFinite(ownExp) && within(entered, ownExp, f.tol);
    res[f.key] = { ok, expected: correct[f.key], entered, followsOwn };
    own[f.key] = entered !== null && Number.isFinite(entered) ? entered : correct[f.key];
  }
  return res;
}

/** Worked example text for one field using correct values. */
export function workedLine(key, scen, kick, scrIndex = 0) {
  const c = sheetContext(scen, kick, scrIndex);
  const v = solveSheet(scen, kick, scrIndex).values;
  const vb = c.vb;
  const L = {
    maxMw: `${c.lot.testMw} + ${c.lot.psi} ÷ (0.052 × ${c.shoe}) = ${(c.lot.testMw + c.lot.psi / (0.052 * c.shoe)).toFixed(3)} → ${v.maxMw.toFixed(1)} ppg`,
    maasp: `(${v.maxMw.toFixed(1)} − ${c.omw.toFixed(1)}) × 0.052 × ${c.shoe} = ${v.maasp} psi`,
    dpVol: `${vb.dpCap.toFixed(5)} × ${vb.dpLen} = ${v.dpVol} bbl`,
    hwVol: `${vb.hwCap.toFixed(5)} × ${vb.hwLen} = ${v.hwVol} bbl`,
    dcVol: `${vb.dcCap.toFixed(5)} × ${vb.dcLen} = ${v.dcVol} bbl`,
    strVol: `${v.dpVol} + ${v.hwVol} + ${v.dcVol} = ${v.strVol} bbl`,
    stkBit: `${v.strVol} ÷ ${c.po} = ${v.stkBit} stk`,
    timeBit: `${v.stkBit} ÷ ${c.spm} = ${v.timeBit} min`,
    ohDcVol: `${vb.ohDc.toFixed(5)} × ${vb.dcLen} = ${v.ohDcVol} bbl`,
    ohDpVol: `${vb.ohDp.toFixed(5)} × ${vb.ohDpLen} = ${v.ohDpVol} bbl`,
    ohVol: `${v.ohDcVol} + ${v.ohDpVol} = ${v.ohVol} bbl`,
    stkShoe: `${v.ohVol} ÷ ${c.po} = ${v.stkShoe} stk`,
    timeShoe: `${v.stkShoe} ÷ ${c.spm} = ${v.timeShoe} min`,
    csgVol: `${vb.csgDp.toFixed(5)} × ${vb.csgDpLen} = ${v.csgVol} bbl`,
    annVol: `${v.ohVol} + ${v.csgVol} = ${v.annVol} bbl`,
    stkBu: `${v.annVol} ÷ ${c.po} = ${v.stkBu} stk`,
    timeBu: `${v.stkBu} ÷ ${c.spm} = ${v.timeBu} min`,
    wellVol: `${v.strVol} + ${v.annVol} = ${v.wellVol} bbl`,
    stkTotal: `(${v.wellVol} + ${c.surfLine}) ÷ ${c.po} = ${v.stkTotal} stk`,
    timeTotal: `${v.stkTotal} ÷ ${c.spm} = ${v.timeTotal} min`,
    pform: `${c.kick.sidpp} + ${c.omw.toFixed(1)} × 0.052 × ${c.tvd} = ${v.pform} psi`,
    kmw: `${c.omw.toFixed(1)} + ${c.kick.sidpp} ÷ (0.052 × ${c.tvd}) = ${(c.omw + c.kick.sidpp / (0.052 * c.tvd)).toFixed(3)} → ${v.kmw.toFixed(1)} ppg`,
    icp: `${c.scrPsi} + ${c.kick.sidpp} = ${v.icp} psi`,
    fcp: `${c.scrPsi} × ${v.kmw.toFixed(1)} ÷ ${c.omw.toFixed(1)} = ${v.fcp} psi`,
    step: `(${v.icp} − ${v.fcp}) × 100 ÷ ${v.stkBit} = ${v.step} psi/100 stk`,
    newMaasp: `(${v.maxMw.toFixed(1)} − ${v.kmw.toFixed(1)}) × 0.052 × ${c.shoe} = ${v.newMaasp} psi`,
  };
  return L[key] ?? '';
}
