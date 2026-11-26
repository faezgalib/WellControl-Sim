// Well control simulation engine.
// Field units: psi (gauge unless noted), ppg, bbl, ft, s.
//
// Model summary
// - Annulus content is an ordered list (bottom -> top) of liquid slugs and free-gas bubbles.
// - Drill string content is a list of liquid slugs (top -> bottom).
// - Each step solves (implicitly, by bisection) for wellhead pressure so that the
//   annulus volume balance holds: liquid in/out, gas expansion (ideal gas, Z = 1),
//   and a small system compliance (mud + wellbore elasticity).
// - Free gas migrates upward (slip velocity). In OBM, gas dissolves into the mud above it
//   and breaks out again once local pressure falls below the slug's bubble point.
// - Drill pipe pressure is derived from bottom pressure with a transmission delay.

import { buildGeometry } from './geometry.js';
import { BASE_OILS } from './scenario.js';

const R = 10.73;          // psi ft3 / (lbmol R)
const MW_GAS = 18.85;     // lb/lbmol (SG 0.65)
const FT3_BBL = 5.615;
const SCF_LBMOL = 379.4;
const DISS_VOL = 0.143;   // bbl added to liquid per lbmol of dissolved gas
const COMPRESS = 3.0e-6;  // 1/psi, effective (mud + wellbore)
const UNDERSAT = 3;       // OBM: gas is spread so slug is 1/UNDERSAT saturated
const SOUND = 4500;       // ft/s pressure wave speed in mud
const POPOFF = 5000;      // pump relief valve, psi
const WATER_RHO = 8.6;
const CHOKE_GMAX = 1.66;  // bbl/min per sqrt(psi/ppg) at 100% open
const FLOWLINE_G = 15;
const SPLIT = { ann: 0.05, str: 0.45, bit: 0.5 };

const BOP_TIME = { annular: 25, upr: 8, lpr: 8, bsr: 10 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Sim {
  constructor(scen) {
    this.s = scen;
    this.geo = buildGeometry(scen.well);
    const g = this.geo;
    this.omw = scen.mud.rho;
    this.obm = scen.mud.type === 'OBM';
    const oil = BASE_OILS[scen.mud.baseOil] ?? BASE_OILS.mineral;
    this.solub = oil.solub;                                  // scf/bbl oil per psi
    this.oilFrac = (scen.mud.owr / 100) * 0.82;              // oil fraction of whole mud
    this.t = 0;
    this.dt = 0.25;
    this.ann = [{ k: 'L', v: g.annVol, rho: this.omw, nd: 0 }];   // bottom -> top
    this.str = [{ v: g.strVol, rho: this.omw }];                   // top -> bottom
    this.Pc = 0;
    this.compliance = COMPRESS * (g.annVol + g.strVol);
    this.extraVol = 0;

    const qref = scen.scr[0].spm * scen.pumpOutput;               // bbl/min
    this.fric = { scr: scen.scr[0].psi, qref };

    const drilling = scen.mode === 'drilling';
    this.mode = scen.mode;
    this.pumps = [0, 1].map(() => ({ spm: 0, target: 0, on: false, failed: false }));
    this.activePump = 0;
    if (drilling) { this.pumps[0].on = true; this.pumps[0].spm = scen.drillSpm; this.pumps[0].target = scen.drillSpm; }
    this.chokes = {
      A: { pos: scen.lineup.chokeA, target: scen.lineup.chokeA, iso: scen.lineup.isoA, factor: 1 },
      B: { pos: 0, target: 0, iso: !!scen.lineup.isoB, factor: 1 },
    };
    this.hcr = { open: scen.lineup.hcr };
    this.bop = {};
    for (const k of Object.keys(BOP_TIME)) this.bop[k] = { state: 'open', timer: 0 };
    this.rotary = drilling;
    this.rpm = drilling ? 120 : 0;
    this.spacedOut = !drilling;
    this.onBottom = drilling;
    this.bitDepth = scen.well.bitDepth ?? scen.well.td;
    this.rop = drilling ? scen.normalRop : 0;

    // Drill string top
    this.stringTop = drilling ? 'connected' : 'open';  // open | fosv-open | closed | connected
    this.fosvInstalled = drilling;
    this.trip = { pulling: !drilling, pulled: 0, expectedFill: 0 };

    this.float = { closed: true, trapped: 0 };
    this.pits = {
      active: scen.activePit, killPit: { vol: scen.killPitVol, rho: null, target: null, readyAt: null },
      suction: 'active', tripTank: scen.tripTank,
    };
    this.pitRef = scen.activePit + scen.killPitVol;
    this.ttRef = scen.tripTank;
    this.counters = { strokes: 0, strokesTotal: 0, returns: 0, gasVented: 0, influx: 0, influxAfterSeal: 0, losses: 0, pipeFlow: 0 };
    this.failure = { nozzle: 1, washout: 0, active: [], pending: [] };
    for (const f of scen.failures) {
      if (f === 'annularLeak') this.failure.active.push({ type: f, t0: 0 });
      else this.failure.pending.push(f);
    }
    this.killStart = null; // strokes reference when kill circulation started
    this.events = [];
    this.samples = [];
    this.bufPbit = [];
    this.flags = { sealedAt: null, kickAt: null, gasAtSurfaceAt: null, popoff: false, sheared: false };
    this.last = {};
    this._walkCache = null;
    this.ended = false;
    this.log('start', `${drilling ? 'Drilling ahead' : 'Pulling out of hole'} · ${scen.mud.type} ${this.omw.toFixed(1)} ppg`);
    this._updateReadings(this.walk(0));
  }

  // ---------- helpers ----------
  log(type, msg, data = {}) { this.events.push({ t: this.t, type, msg, ...data }); }
  tempR(d) { return 460 + this.s.tempSurfF + this.s.tempGradF * d / 100; }
  gasRho(pg, d) { return ((pg + 14.7) * MW_GAS / (R * this.tempR(d))) / 7.48; }
  gasVol(n, pg, d) { return n * R * this.tempR(d) / (pg + 14.7) / FT3_BBL; }
  pumpRate() { const p = this.pumps[this.activePump]; return (p.spm * this.s.pumpOutput) / 60; } // bbl/s
  get kickActive() { return this.mode === 'tripping' || this.t >= this.s.kickStart; }

  sealed() {
    const b = this.bop;
    const anyClosed = (k) => b[k].state === 'closed';
    let seal = false, leak = 0;
    if (anyClosed('lpr') || anyClosed('bsr')) seal = true;
    if (anyClosed('upr')) { if (this.spacedOut) seal = true; else leak = Math.max(leak, 3); }
    if (anyClosed('annular')) {
      if (this.failure.active.some((f) => f.type === 'annularLeak')) leak = Math.max(leak, 0.8);
      else seal = true;
    }
    return seal ? { sealed: true, leak: 0 } : { sealed: false, leak };
  }

  chokeG(c) { return CHOKE_GMAX * Math.pow(clamp(c.pos, 0, 100) / 100, 1.5) * c.factor; }

  outletG() {
    const s = this.sealed();
    let gFlow = s.sealed ? 0 : (s.leak > 0 ? s.leak : FLOWLINE_G);
    let gChoke = 0;
    if (this.hcr.open) {
      if (this.chokes.A.iso) gChoke += this.chokeG(this.chokes.A);
      if (this.chokes.B.iso) gChoke += this.chokeG(this.chokes.B);
    }
    return { gFlow, gChoke, flowOpen: !s.sealed && s.leak === 0 };
  }

  // ---------- pressure profile ----------
  /** Walk the annulus from the top at wellhead pressure P. */
  walk(P, store = false) {
    const g = this.geo, ann = this.ann;
    const q = this._qAnn ?? 0;
    const fGrad = this.annFriction(q * 60) / g.td;
    let u = 0, d = 0, p = P, total = 0;
    let pShoe = null, pBit = null, gasTopDepth = null;
    // composition of the top MIX_VOL bbl (what reaches the choke next)
    const MIX_VOL = 2;
    let mixV = 0, mixGas = 0, mixMass = 0;
    const mix = (vol, rho, isGas) => {
      const take = Math.min(vol, MIX_VOL - mixV);
      if (take <= 0) return;
      mixV += take; mixMass += take * rho; if (isGas) mixGas += take;
    };
    const hit = (d0, d1, p0, p1) => {
      if (pShoe === null && g.shoe >= d0 && g.shoe <= d1) pShoe = p0 + (p1 - p0) * ((g.shoe - d0) / Math.max(d1 - d0, 1e-9));
      if (pBit === null && this.geo.bit >= d0 && this.geo.bit <= d1) pBit = p0 + (p1 - p0) * ((this.geo.bit - d0) / Math.max(d1 - d0, 1e-9));
    };
    for (let i = ann.length - 1; i >= 0; i--) {
      const it = ann[i];
      let vol, rho;
      if (it.k === 'L') { vol = it.v; rho = it.rho; }
      else {
        vol = this.gasVol(it.n, p, d);
        const dEst = g.annDepthFromTop(u + vol);
        rho = this.gasRho(p, d);
        const pMid = p + 0.5 * 0.052 * rho * (dEst - d);
        vol = this.gasVol(it.n, pMid, (d + dEst) / 2);
        if (gasTopDepth === null) gasTopDepth = d;
      }
      mix(vol, rho, it.k === 'G');
      const d2 = g.annDepthFromTop(u + vol);
      const p2 = p + (0.052 * rho + fGrad) * (d2 - d);
      if (store) { it.dTop = d; it.dBot = d2; it.pTop = p; it.pBot = p2; it.vol = vol; }
      hit(d, d2, p, p2);
      u += vol; total += vol; d = d2; p = p2;
    }
    if (d < g.td) { // deficit: extend with bottom fluid
      const rho = ann[0]?.k === 'L' ? ann[0].rho : this.omw;
      const p2 = p + (0.052 * rho + fGrad) * (g.td - d);
      hit(d, g.td, p, p2);
      p = p2; d = g.td;
    }
    if (pShoe === null) pShoe = p;
    if (pBit === null) pBit = p;
    const alpha = mixV > 0 ? mixGas / mixV : 0;
    const rhoMix = mixV > 0 ? mixMass / mixV : this.omw;
    const top = ann[ann.length - 1];
    return { bhp: p, pShoe, pBit, total, topGas: top.k === 'G', alpha, rhoTop: Math.max(rhoMix, 0.02), gasTopDepth };
  }

  annFriction(qbpm, rho = this.omw) {
    if (qbpm <= 0) return 0;
    return SPLIT.ann * this.fric.scr * Math.pow(qbpm / this.fric.qref, 1.85) * (rho / this.omw);
  }
  stringFriction(qbpm) {
    if (qbpm <= 0) return 0;
    const f = this.fric, w = this.failure.washout, fw = 0.55;
    const rhoStr = this.str.reduce((a, s) => a + s.rho * s.v, 0) / this.geo.strVol;
    const rhoBit = this.str[this.str.length - 1].rho;
    const qr = qbpm / f.qref;
    const strF = SPLIT.str * f.scr * (fw * Math.pow(qr, 1.85) + (1 - fw) * Math.pow(qr * (1 - w), 1.85)) * (rhoStr / this.omw);
    const bitF = SPLIT.bit * f.scr * Math.pow(qr * (1 - w), 2) * (rhoBit / this.omw) * this.failure.nozzle;
    return strF + bitF;
  }
  hydString() {
    let u = 0, d = 0, h = 0;
    for (const s of this.str) {
      const d2 = this.geo.strDepthFromTop(u + s.v);
      h += 0.052 * s.rho * (d2 - d);
      u += s.v; d = d2;
    }
    return h;
  }

  // ---------- flows ----------
  inflowRate(bhp) { // bbl/s at bottom-hole conditions
    if (!this.kickActive) return 0;
    const pi = this.s.pi / 60;
    const dp = this.s.pform - bhp;
    return dp > 0 ? pi * dp : 0;
  }
  lossRate(pShoe) {
    const ex = pShoe - this.s.fracShoePsi;
    return ex > 0 ? (0.02 / 60) * ex : 0;
  }
  outflow(P, w, G) {
    const g = G.gChoke + G.gFlow;
    if (P >= 0) {
      if (g <= 0) return 0;
      // homogeneous mixture through the choke; gas fraction limits the effective dP (choked flow)
      const dpEff = w.alpha * Math.min(P, 0.53 * (P + 14.7)) + (1 - w.alpha) * P;
      return (g / 60) * Math.sqrt(dpEff / w.rhoTop);
    }
    // reverse flow (hole fill from trip tank / flowline) only when open to atmosphere
    if (G.flowOpen) return -(FLOWLINE_G / 60) * Math.sqrt(-P / this.omw);
    return 0;
  }
  pipeOutflow(w) {
    if (this.stringTop !== 'open' && this.stringTop !== 'fosv-open') return 0;
    const dp = w.pBit - this.hydString();
    return dp > 0 ? (8 / 60) * Math.sqrt(dp / this.omw) : 0;
  }

  residual(P, ctx) {
    const w = this.walk(P);
    const bhpEff = w.bhp - ctx.swab;
    const qinf = this.inflowRate(bhpEff);
    const qloss = this.lossRate(w.pShoe);
    const qout = this.outflow(P, w, ctx.G);
    const qpipe = this.pipeOutflow(w);
    const vol = w.total + (ctx.qin + qinf - qloss - qout - qpipe) * this.dt;
    return { r: vol - this.geo.annVol - this.compliance * P - this.extraVol, w, qinf, qloss, qout, qpipe };
  }

  solve(ctx) {
    let lo = ctx.G.flowOpen ? -80 : 0;
    let rLo = this.residual(lo, ctx);
    if (rLo.r <= 0) return { P: lo, ...rLo };
    let hi = Math.max(this.Pc * 1.5 + 500, 1000);
    let rHi = this.residual(hi, ctx);
    let guard = 0;
    while (rHi.r > 0 && guard++ < 12) { lo = hi; rLo = rHi; hi *= 2; rHi = this.residual(hi, ctx); }
    for (let i = 0; i < 48 && hi - lo > 0.005; i++) {
      const mid = 0.5 * (lo + hi);
      const rm = this.residual(mid, ctx);
      if (rm.r > 0) { lo = mid; rLo = rm; } else { hi = mid; rHi = rm; }
    }
    const P = 0.5 * (lo + hi);
    return { P, ...this.residual(P, ctx) };
  }

  // ---------- content manipulation ----------
  /** coordinate (bbl from bottom) -> index & offset; uses stored item volumes */
  _locate(vFromBottom) {
    let acc = 0;
    for (let i = 0; i < this.ann.length; i++) {
      const it = this.ann[i];
      const vol = it.k === 'L' ? it.v : (it.vol ?? 0);
      if (vFromBottom <= acc + vol + 1e-9) return { i, off: vFromBottom - acc };
      acc += vol;
    }
    return { i: this.ann.length - 1, off: 0 };
  }
  _insertLiquidAt(vFromBottom, v, rho, extra = {}) {
    if (v <= 0) return;
    const item = { k: 'L', v, rho, nd: 0, ...extra };
    if (vFromBottom <= 1e-6) { this.ann.unshift(item); return; }
    const { i, off } = this._locate(vFromBottom);
    const it = this.ann[i];
    if (it.k === 'G') { this.ann.splice(i, 0, item); return; }
    if (off <= 1e-6) { this.ann.splice(i, 0, item); return; }
    if (off >= it.v - 1e-6) { this.ann.splice(i + 1, 0, item); return; }
    const frac = off / it.v;
    const lower = { ...it, v: off, nd: it.nd * frac };
    const upper = { ...it, v: it.v - off, nd: it.nd * (1 - frac) };
    this.ann.splice(i, 1, lower, item, upper);
  }
  _removeLiquidAt(vFromBottom, v) {
    let need = v;
    let { i } = this._locate(vFromBottom);
    let guard = 0;
    while (need > 1e-9 && guard++ < 200) {
      // search nearest liquid item at/above i, then below
      let j = i;
      while (j < this.ann.length && this.ann[j].k !== 'L') j++;
      if (j >= this.ann.length) { j = i; while (j >= 0 && this.ann[j].k !== 'L') j--; }
      if (j < 0) return v - need;
      const it = this.ann[j];
      const take = Math.min(need, it.v);
      const frac = take / it.v;
      it.nd -= it.nd * frac;
      it.v -= take;
      need -= take;
      if (it.v <= 1e-9) this.ann.splice(j, 1);
    }
    return v - need;
  }
  _removeFromTop(v) {
    // returns { liquid, gasN, liquidByRho }
    let need = v, liquid = 0, gasN = 0;
    let guard = 0;
    while (need > 1e-9 && this.ann.length && guard++ < 200) {
      const it = this.ann[this.ann.length - 1];
      if (it.k === 'G') {
        const vol = Math.max(it.vol ?? this.gasVol(it.n, this.Pc, 0), 1e-9);
        const take = Math.min(need, vol);
        const dn = it.n * (take / vol);
        it.n -= dn; gasN += dn; need -= take;
        it.vol = vol - take;
        if (it.n <= 1e-9 || it.vol <= 1e-9) { gasN += Math.max(it.n, 0); this.ann.pop(); }
      } else {
        const take = Math.min(need, it.v);
        const frac = take / it.v;
        // dissolved gas leaving with returns flashes at surface
        const dn = it.nd * frac;
        gasN += dn;
        it.nd -= dn;
        it.v -= take; liquid += take; need -= take;
        if (it.v <= 1e-9) this.ann.pop();
      }
    }
    if (!this.ann.length) this.ann.push({ k: 'L', v: 0.001, rho: this.omw, nd: 0 });
    return { liquid, gasN };
  }
  _addGasBottom(n) {
    if (n <= 0) return;
    if (this.ann[0]?.k === 'G') this.ann[0].n += n;
    else this.ann.unshift({ k: 'G', n, vol: 0 });
  }
  _pumpString(vol, rhoIn) {
    // push vol at top with rhoIn, return chunks leaving the bit (bottom first)
    const top = this.str[0];
    if (Math.abs(top.rho - rhoIn) < 1e-4) top.v += vol;
    else this.str.unshift({ v: vol, rho: rhoIn });
    let need = vol;
    const out = [];
    while (need > 1e-12 && this.str.length) {
      const b = this.str[this.str.length - 1];
      const take = Math.min(need, b.v);
      out.push({ v: take, rho: b.rho });
      b.v -= take; need -= take;
      if (b.v <= 1e-12) this.str.pop();
    }
    return out;
  }
  _cleanup() {
    const a = this.ann;
    for (let i = a.length - 1; i >= 0; i--) {
      if (a[i].k === 'L' && a[i].v <= 1e-7) a.splice(i, 1);
      else if (a[i].k === 'G' && a[i].n <= 1e-9) a.splice(i, 1);
    }
    // gas bubbles separated by a small liquid slug behave as one swarm: merge them
    for (let i = 0; i < a.length - 2; i++) {
      if (a[i].k !== 'G') continue;
      while (i + 2 < a.length && a[i + 1].k === 'L' && a[i + 1].v < 3 && a[i + 2].k === 'G') {
        a[i].n += a[i + 2].n;
        const liq = a[i + 1];
        a.splice(i + 1, 2);
        a.splice(i, 0, liq);
        i++;
      }
    }
    for (let i = a.length - 2; i >= 0; i--) {
      const x = a[i], y = a[i + 1];
      if (x.k === 'G' && y.k === 'G') { x.n += y.n; a.splice(i + 1, 1); continue; }
      if (x.k === 'L' && y.k === 'L' && !!x.w === !!y.w && Math.abs(x.rho - y.rho) < 0.004) {
        const charged = x.nd > 1e-6 || y.nd > 1e-6;
        const bothCharged = x.nd > 1e-6 && y.nd > 1e-6;
        if (!charged || bothCharged) {
          const v = x.v + y.v;
          x.rho = (x.rho * x.v + y.rho * y.v) / v;
          x.v = v; x.nd += y.nd;
          a.splice(i + 1, 1);
        }
      }
    }
    // keep list bounded
    while (a.length > 90) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < a.length - 1; i++) {
        if (a[i].k === 'L' && a[i + 1].k === 'L' && !!a[i].w === !!a[i + 1].w) {
          const d = Math.abs(a[i].rho - a[i + 1].rho);
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best < 0) break;
      const x = a[best], y = a[best + 1];
      const v = x.v + y.v;
      x.rho = (x.rho * x.v + y.rho * y.v) / v; x.v = v; x.nd += y.nd;
      a.splice(best + 1, 1);
    }
    if (!a.length) a.push({ k: 'L', v: 0.001, rho: this.omw, nd: 0 });
    // string
    for (let i = this.str.length - 2; i >= 0; i--) {
      const x = this.str[i], y = this.str[i + 1];
      if (Math.abs(x.rho - y.rho) < 0.004) { x.v += y.v; this.str.splice(i + 1, 1); }
    }
  }

  _migrate() {
    const vmig = this.s.migration / 3600; // ft/s
    for (let i = 0; i < this.ann.length - 1; i++) {
      const gI = this.ann[i];
      if (gI.k !== 'G') continue;
      const depth = gI.dTop ?? this.geo.td;
      let need = this.geo.annCapAt(depth) * vmig * this.dt;
      let guard = 0;
      while (need > 1e-9 && i + 1 < this.ann.length && guard++ < 20) {
        const up = this.ann[i + 1];
        if (up.k === 'G') { gI.n += up.n; this.ann.splice(i + 1, 1); continue; }
        const take = Math.min(need, up.v);
        const frac = take / up.v;
        const moved = { k: 'L', v: take, rho: up.rho, nd: up.nd * frac, w: up.w };
        up.v -= take; up.nd -= moved.nd; need -= take;
        if (up.v <= 1e-9) this.ann.splice(i + 1, 1);
        const below = this.ann[i - 1];
        if (below && below.k === 'L' && !!below.w === !!moved.w && Math.abs(below.rho - moved.rho) < 0.004 && (below.nd > 0) === (moved.nd > 0)) {
          below.v += moved.v; below.nd += moved.nd;
        } else { this.ann.splice(i, 0, moved); i++; }
      }
    }
  }

  _obm() {
    if (!this.obm) return;
    const a = this.ann;
    // dissolve free gas into mud directly above it
    for (let i = 0; i < a.length - 1; i++) {
      const gI = a[i];
      if (gI.k !== 'G') continue;
      const up = a[i + 1];
      if (up.k !== 'L') continue;
      const pAbs = (gI.pTop ?? this.s.pform) + 14.7;
      const perBbl = this.oilFrac * this.solub * pAbs / SCF_LBMOL / UNDERSAT; // lbmol per bbl mud
      const need = gI.n / perBbl;
      const take = Math.min(need, up.v);
      const n = take * perBbl;
      const frac = take / up.v;
      const ndMoved = up.nd * frac;
      up.v -= take; up.nd -= ndMoved;
      const vol = take + n * DISS_VOL;
      const rho = (up.rho * take * 42 + n * MW_GAS) / (vol * 42);
      const slice = { k: 'L', v: vol, rho, nd: n + ndMoved };
      gI.n -= n;
      a.splice(i + 1, 0, slice);
      if (up.v <= 1e-9) a.splice(i + 2, 1);
      if (gI.n <= 1e-9) { a.splice(i, 1); i--; }
    }
    // break out where pressure has dropped below bubble point
    for (let i = a.length - 1; i >= 0; i--) {
      const it = a[i];
      if (it.k !== 'L' || it.nd <= 1e-7) continue;
      const pMid = ((it.pTop ?? 0) + (it.pBot ?? 0)) / 2;
      const oilVol = Math.max(it.v - it.nd * DISS_VOL, 0) * this.oilFrac;
      const cap = oilVol * this.solub * (pMid + 14.7) / SCF_LBMOL;
      if (it.nd > cap) {
        const rel = Math.min(it.nd - cap, it.nd * 0.04 + 1e-6); // breakout takes a few seconds
        it.nd -= rel;
        it.v -= rel * DISS_VOL;
        it.rho = Math.min(this.omw * 1.5, (it.rho * (it.v + rel * DISS_VOL) * 42 - rel * MW_GAS) / (it.v * 42));
        const above = a[i + 1];
        if (above && above.k === 'G') above.n += rel;
        else a.splice(i + 1, 0, { k: 'G', n: rel, vol: 0 });
      }
    }
  }

  // ---------- control dynamics ----------
  _controls() {
    const dt = this.dt, s = this.s;
    // pumps
    this.pumps.forEach((p, idx) => {
      const tgt = p.on && !p.failed ? p.target : 0;
      const rate = p.failed ? 20 : (tgt < p.spm ? 8 : 4);
      if (p.spm < tgt) p.spm = Math.min(tgt, p.spm + rate * dt);
      else p.spm = Math.max(tgt, p.spm - rate * dt);
      if (idx !== this.activePump && p.spm > 0) p.spm = Math.max(0, p.spm - 10 * dt);
    });
    const canPump = this.stringTop === 'connected';
    if (!canPump) for (const p of this.pumps) { p.spm = 0; }
    const pump = this.pumps[this.activePump];
    const dStk = (pump.spm / 60) * dt;
    this.counters.strokes += dStk;
    this.counters.strokesTotal += dStk;
    // chokes (actuator speed 4 %/s)
    for (const c of Object.values(this.chokes)) {
      const d = c.target - c.pos;
      const step = 4 * dt;
      c.pos = Math.abs(d) <= step ? c.target : c.pos + Math.sign(d) * step;
    }
    // BOP timers
    for (const [k, b] of Object.entries(this.bop)) {
      if (b.state === 'closing') { b.timer -= dt; if (b.timer <= 0) { b.state = 'closed'; this.log('bop', `${BOP_LABEL[k]} closed`, { el: k, action: 'closed' }); } }
      if (b.state === 'opening') { b.timer -= dt; if (b.timer <= 0) { b.state = 'open'; this.log('bop', `${BOP_LABEL[k]} open`, { el: k, action: 'opened' }); } }
    }
    // drilling
    if (this.mode === 'drilling') {
      if (this.rotary && this.onBottom && pump.spm > 10) {
        this.rop = this.kickActive ? s.drillingBreakRop : s.normalRop;
        this.bitDepth += (this.rop / 3600) * dt;
      } else this.rop = 0;
    }
    // tripping
    if (this.mode === 'tripping' && this.trip.pulling) {
      const speed = s.standLen / s.standTime; // ft/s
      const dl = speed * dt;
      this.trip.pulled += dl;
      this.bitDepth -= dl;
      const disp = 0.0075 * dl;
      this.extraVol += disp;
      this.trip.expectedFill += disp;
    }
    // kill mud
    const kp = this.pits.killPit;
    if (kp.readyAt !== null && kp.rho === null && this.t >= kp.readyAt) {
      kp.rho = kp.target;
      this.log('killmud', `Kill mud ${kp.rho.toFixed(1)} ppg ready in kill pit`);
    }
    // failures
    this._failures();
  }

  _failures() {
    const f = this.failure;
    // trigger pending kill-time failures
    if (f.pending.length && this.killStart !== null) {
      const g = this.geo;
      const circ = (g.strVol + g.annVol) / this.s.pumpOutput;
      const done = this.counters.strokesTotal - this.killStart;
      const idx = f.active.filter((x) => x.type !== 'annularLeak').length;
      const at = (this.s.failureAt + 0.2 * idx) * circ * 0.6;
      if (done >= at && this.pumpRate() > 0) {
        const type = f.pending.shift();
        f.active.push({ type, t0: this.t });
        this.log('failure', FAIL_MSG[type], { failure: type, hidden: !!this.s.hiddenFailure });
        if (type === 'pumpFailure') this.pumps[this.activePump].failed = true;
      }
    }
    for (const a of f.active) {
      const age = this.t - a.t0;
      if (a.type === 'chokePlug') this.chokes.A.factor = Math.max(0.22, 1 - 0.78 * Math.min(1, age / 40));
      if (a.type === 'chokeWashout') this.chokes.A.factor = 1 + 2.6 * Math.min(1, age / 480);
      if (a.type === 'nozzlePlug') f.nozzle = 1 + 0.75 * Math.min(1, age / 6);
      if (a.type === 'stringWashout') f.washout = 0.55 * Math.min(1, age / 600);
    }
  }

  // ---------- main step ----------
  step() {
    if (this.ended) return;
    const dt = this.dt;
    this.t += dt;
    this._controls();

    // pump flow and float valve
    const q = this.pumpRate();
    let qin = q;
    const pBelow = (this.last.pBitTrue ?? 0) - this.hydString();
    if (this.s.floatValve && this.stringTop === 'connected') {
      const cStr = COMPRESS * this.geo.strVol;
      if (q > 0) {
        if (this.float.closed) {
          this.float.trapped += (q * dt) / cStr;
          if (this.float.trapped >= pBelow) { this.float.closed = false; this.float.trapped = pBelow; }
          else qin = 0;
        } else this.float.trapped = pBelow;
      } else {
        this.float.closed = true;
        this.float.trapped = Math.max(0, Math.min(this.float.trapped, Math.max(pBelow, 0)));
      }
    }
    this._qAnn = qin;

    const G = this.outletG();
    const swab = this.mode === 'tripping' && this.trip.pulling ? this.s.swabPsi : 0;
    const ctx = { qin, G, swab };
    const sol = this.solve(ctx);
    const P = sol.P;
    this.Pc = P;
    // store geometry of items at solved pressure
    this.walk(P, true);

    // --- apply flows ---
    // pump: string -> annulus at bit
    if (qin > 0) {
      const suct = this.pits.suction === 'kill' ? this.pits.killPit : null;
      const rhoIn = suct ? (suct.rho ?? this.omw) : this.omw;
      const vol = qin * dt;
      if (suct) suct.vol -= q * dt; else this.pits.active -= q * dt;
      const chunks = this._pumpString(vol, rhoIn);
      const vb = this.geo.volBelowBit;
      for (const c of chunks) this._insertLiquidAt(vb, c.v, c.rho);
    } else if (q > 0) {
      // pumping against closed float: compressing string content
      if (this.pits.suction === 'kill') this.pits.killPit.vol -= q * dt; else this.pits.active -= q * dt;
    }
    // pipe outflow (string open, well flowing up the pipe)
    if (sol.qpipe > 0) {
      const v = sol.qpipe * dt;
      this._removeLiquidAt(this.geo.volBelowBit, v);
      this.counters.pipeFlow += v;
      this.pits.tripTank += 0; // spills on rig floor (not measured)
    }
    // influx
    if (sol.qinf > 0) {
      const v = sol.qinf * dt;
      this.counters.influx += v;
      if (this.killStart !== null) this.counters.influxAfterSeal += v;
      if (this.flags.kickAt === null) { this.flags.kickAt = this.t; this.log('kick', 'Influx entering the well (hidden from crew)', { hidden: true }); }
      if (this.s.influx === 'water') this._insertLiquidAt(0, v, WATER_RHO, { w: true });
      else {
        const bhpAbs = sol.w.bhp + 14.7;
        this._addGasBottom((v * FT3_BBL * bhpAbs) / (R * this.tempR(this.geo.td)));
      }
    }
    // losses at shoe
    if (sol.qloss > 0) {
      const v = sol.qloss * dt;
      const vFromBottom = this.geo.annVol - this.geo.annVolFromTop(this.geo.shoe);
      this._removeLiquidAt(Math.max(0, vFromBottom), v);
      this.counters.losses += v;
      if (!this.flags.lossesAt) { this.flags.lossesAt = this.t; this.log('losses', 'Shoe pressure above fracture pressure: losses to formation', { hidden: true }); }
    }
    // outflow at top
    if (sol.qout > 0) {
      const r = this._removeFromTop(sol.qout * dt);
      this.counters.gasVented += r.gasN;
      const toTrip = this.mode === 'tripping' && G.gFlow > 0 && G.gChoke === 0;
      if (toTrip) this.pits.tripTank += r.liquid; else this.pits.active += r.liquid;
      if (G.gChoke > 0 && this.sealed().sealed) this.counters.returns += r.liquid;
      this.last.outLiquid = r.liquid / dt;
      this.last.outGas = r.gasN;
    } else if (sol.qout < 0) {
      const v = -sol.qout * dt;
      const top = this.ann[this.ann.length - 1];
      if (top.k === 'L' && Math.abs(top.rho - this.omw) < 0.004 && !top.nd) top.v += v;
      else this.ann.push({ k: 'L', v, rho: this.omw, nd: 0 });
      if (this.mode === 'tripping') this.pits.tripTank -= v; else this.pits.active -= v;
      this.last.outLiquid = -v / dt;
    } else this.last.outLiquid = 0;

    this._migrate();
    this._cleanup();
    this.walk(P, true);
    this._obm();
    this._cleanup();

    const w = this.walk(P, true);
    this._updateReadings(w, sol);
    if (this.flags.gasAtSurfaceAt === null && this.ann[this.ann.length - 1].k === 'G') {
      this.flags.gasAtSurfaceAt = this.t;
      this.log('gas', 'Gas at surface (at the choke)');
    }
    if (Math.floor(this.t / 5) !== Math.floor((this.t - dt) / 5)) this._sample();
  }

  _updateReadings(w, sol = null) {
    const g = this.geo;
    const q = this.pumpRate();
    const qin = this._qAnn ?? 0;
    // delayed bottom pressure for drill pipe
    this.bufPbit.push([this.t, w.pBit]);
    const tau = (2 * g.bit) / SOUND;
    while (this.bufPbit.length > 2 && this.bufPbit[1][0] <= this.t - tau) this.bufPbit.shift();
    const pBitLag = this.bufPbit[0][1];
    const hyd = this.hydString();
    let spp = null;
    if (this.stringTop === 'connected') {
      if (this.s.floatValve && this.float.closed) spp = this.float.trapped;
      else spp = pBitLag - hyd + this.stringFriction(qin * 60);
      if (spp > POPOFF && q > 0) {
        for (const p of this.pumps) { p.on = false; p.target = 0; p.spm = 0; }
        this.flags.popoff = true;
        this.log('popoff', `Pump pop-off valve opened at ${Math.round(spp)} psi — pump stopped`);
      }
    }
    const sealedNow = this.sealed().sealed;
    if (sealedNow && this.flags.sealedAt === null) this.flags.sealedAt = this.t;
    const omwGrad = 0.052 * this.omw;
    const fAnn = this.annFriction(qin * 60);
    this.last = {
      ...this.last,
      spp: spp === null ? null : Math.max(0, spp),
      sppRaw: spp,
      cp: this.hcr.open ? Math.max(0, this.Pc) : 0,
      pc: this.Pc,
      bhp: w.bhp,
      pBitTrue: w.pBit,
      pShoe: w.pShoe,
      fracShoe: this.s.fracShoePsi,
      maaspTrue: this.s.fracShoePsi - (w.pShoe - this.Pc),
      pform: this.s.pform,
      targetBhp: this.s.pform + fAnn,
      margin: w.bhp - this.s.pform,
      hydStr: hyd,
      spm: this.pumps[this.activePump].spm,
      pumpQ: q * 60,
      flowOut: (this.last.outLiquid ?? 0) * 60,
      gasTopDepth: w.gasTopDepth,
      pitGain: this.pits.active + this.pits.killPit.vol - this.pitRef,
      tripTankDelta: this.pits.tripTank - this.ttRef,
      sealed: sealedNow,
      qinf: sol ? sol.qinf * 60 : 0,
      ecdNote: omwGrad,
    };
  }

  _sample() {
    const L = this.last;
    const ch = this.activeChoke();
    this.samples.push({
      t: Math.round(this.t), spp: L.spp === null ? null : Math.round(L.spp), cp: Math.round(L.cp), bhp: Math.round(L.bhp),
      tgt: Math.round(L.targetBhp), pform: this.s.pform, pShoe: Math.round(L.pShoe), frac: this.s.fracShoePsi,
      pit: +L.pitGain.toFixed(1), choke: +ch.pos.toFixed(1), spm: +L.spm.toFixed(1), stk: Math.round(this.counters.strokes),
      gas: L.gasTopDepth === null ? null : Math.round(L.gasTopDepth), sealed: L.sealed ? 1 : 0,
      kstk: this.killStart === null ? null : Math.round(this.counters.strokesTotal - this.killStart),
    });
  }

  activeChoke() {
    const A = this.chokes.A, B = this.chokes.B;
    if (B.iso && !A.iso) return B;
    return A;
  }

  // ---------- commands (called by UI) ----------
  cmd(name, arg) {
    const fn = this['_c_' + name];
    if (!fn) throw new Error('unknown command ' + name);
    return fn.call(this, arg);
  }
  _c_choke({ id = null, delta = 0, set = null }) {
    const c = id ? this.chokes[id] : this.activeChoke();
    const before = c.target;
    c.target = clamp(set !== null ? set : c.target + delta, 0, 100);
    if (Math.abs(c.target - before) >= 0.01) this.log('choke', `Choke ${id ?? (c === this.chokes.A ? 'A' : 'B')} → ${c.target.toFixed(0)}%`, { from: before, to: c.target, quiet: true });
  }
  _c_chokeIso({ id, open }) {
    this.chokes[id].iso = open;
    this.log('manifold', `Choke ${id} line ${open ? 'opened' : 'isolated'}`, { el: 'iso' + id, open });
  }
  _c_hcr(open) {
    this.hcr.open = open;
    this.log('hcr', `HCR ${open ? 'opened' : 'closed'}`, { open });
  }
  _c_pump({ on }) {
    const p = this.pumps[this.activePump];
    if (on && this.stringTop !== 'connected') { this.log('info', 'Cannot start pump: string not connected to top drive'); return false; }
    if (on && p.failed) { this.log('info', `Pump #${this.activePump + 1} will not start (failed)`); return false; }
    if (on && this.pits.suction === 'kill' && this.pits.killPit.rho === null) { this.log('info', 'Kill pit not ready — suction still on kill pit'); return false; }
    p.on = on;
    if (on && p.target === 0) p.target = 5;
    if (!on) p.target = 0;
    this.log('pump', `Pump #${this.activePump + 1} ${on ? 'started' : 'stopped'}`, { on });
    if (on) this._maybeKillStart();
    return true;
  }
  _c_pumpRate({ delta = 0, set = null }) {
    const p = this.pumps[this.activePump];
    if (!p.on) return;
    p.target = clamp(set !== null ? set : p.target + delta, 0, 120);
    this.log('pumprate', `Pump target ${p.target.toFixed(0)} spm`, { quiet: true, to: p.target });
  }
  _c_selectPump(i) {
    if (i === this.activePump) return;
    const old = this.pumps[this.activePump];
    old.on = false; old.target = 0;
    this.activePump = i;
    this.log('pump', `Switched to pump #${i + 1}`);
  }
  _c_resetStrokes() { this.counters.strokes = 0; this.log('stk', 'Stroke counter reset'); }
  _c_resetReturns() { this.counters.returns = 0; this.log('info', 'Choke returns counter reset', { quiet: true }); }
  _c_resetPit() { this.pitRef = this.pits.active + this.pits.killPit.vol; this.ttRef = this.pits.tripTank; this.log('info', 'Pit gain reference reset', { quiet: true }); }
  _c_bop({ el, close }) {
    const b = this.bop[el];
    if (close && (b.state === 'closed' || b.state === 'closing')) return;
    if (!close && (b.state === 'open' || b.state === 'opening')) return;
    const ctx = {
      el, close, rotating: this.rotary, pumping: this.pumpRate() > 0, spacedOut: this.spacedOut,
      pc: this.Pc, stringTop: this.stringTop, hcr: this.hcr.open, chokePos: this.activeChoke().pos,
      chokeIsoA: this.chokes.A.iso,
    };
    if (close && el === 'bsr') { this.flags.sheared = true; this.log('bop', 'Blind/shear rams closed on pipe — pipe sheared', { el, action: 'close', ...ctx }); }
    b.state = close ? 'closing' : 'opening';
    b.timer = BOP_TIME[el];
    this.log('bop', `${BOP_LABEL[el]} ${close ? 'closing' : 'opening'}`, { action: close ? 'close' : 'open', ...ctx });
  }
  _c_rotary(on) { this.rotary = on; this.rpm = on ? 120 : 0; this.log('rotary', on ? 'Rotary started' : 'Rotary stopped', { on }); }
  _c_pickUp() {
    if (this.mode !== 'drilling') return;
    if (!this.onBottom) return;
    this.onBottom = false; this.spacedOut = true; this.bitDepth -= 25;
    this.log('pickup', 'Picked up off bottom, tool joint spaced out clear of rams', { rotating: this.rotary, pumping: this.pumpRate() > 0 });
  }
  _c_trip(pull) {
    if (this.mode !== 'tripping') return;
    this.trip.pulling = pull;
    this.log('trip', pull ? 'Pulling out of hole' : 'Stopped tripping — slips set', { pull });
  }
  _c_stabFosv() {
    if (this.fosvInstalled) return;
    if (this.trip.pulling) { this.log('info', 'Stop tripping and set slips before stabbing the FOSV'); return false; }
    this.fosvInstalled = true; this.stringTop = 'fosv-open';
    this.log('fosv', 'FOSV stabbed (open) in drill string', { action: 'stab' });
  }
  _c_fosv(close) {
    if (!this.fosvInstalled) return;
    if (close) { this.stringTop = 'closed'; this.log('fosv', 'FOSV closed', { action: 'close' }); }
    else { this.stringTop = this.topDrive ? 'connected' : 'fosv-open'; this.log('fosv', 'FOSV opened', { action: 'open' }); }
  }
  _c_connectTopDrive() {
    if (this.mode !== 'tripping' || !this.fosvInstalled || this.topDrive) return;
    this.topDrive = true;
    this.log('topdrive', 'Top drive made up to FOSV');
  }
  _c_suction(which) {
    if (which === 'kill' && this.pits.killPit.rho === null) { this.log('info', 'Kill mud not ready yet'); return false; }
    this.pits.suction = which;
    this.log('suction', `Pump suction lined up to ${which === 'kill' ? 'kill pit' : 'active pit'}`);
  }
  _c_weightUp(kmw) {
    const kp = this.pits.killPit;
    kp.target = kmw; kp.rho = null; kp.readyAt = this.t + this.s.weightUpMin * 60;
    this.log('weightup', `Weighting up kill pit to ${kmw.toFixed(1)} ppg (ready in ${this.s.weightUpMin} min)`, { kmw });
  }
  _c_record(data) { this.log('record', `Recorded SIDPP ${data.sidpp} psi, SICP ${data.sicp} psi, pit gain ${data.gain} bbl`, { ...data, truth: this.truthShutIn() }); }
  _c_method(m) { this.method = m; this.log('method', `Kill method: ${m === 'drillers' ? "Driller's Method" : 'Wait & Weight'}`, { method: m }); }
  _c_end(reason) { this.ended = true; this.log('end', reason ?? 'Session ended'); }

  _maybeKillStart() {
    if (this.killStart === null && this.sealed().sealed && this.hcr.open) {
      this.killStart = this.counters.strokesTotal;
      this.log('killstart', 'Kill circulation started');
    }
  }

  // ---------- truth helpers ----------
  truthShutIn() {
    // what an ideal stabilised reading would be right now
    return {
      sidpp: Math.round(this.s.pform - this.hydString()),
      sicp: Math.round(this.Pc),
      gain: +(this.pits.active + this.pits.killPit.vol - this.pitRef).toFixed(1),
      buildup: this.last.qinf > 0.02,
    };
  }
  wellStatus() {
    const kmw = this.pits.killPit.rho ?? this.pits.killPit.target ?? this.omw;
    const minAnn = Math.min(...this.ann.filter((x) => x.k === 'L').map((x) => x.rho));
    const gasFree = this.ann.filter((x) => x.k === 'G').reduce((a, x) => a + (x.vol ?? 0), 0); // bbl downhole
    const gasDiss = this.ann.reduce((a, x) => a + (x.nd || 0), 0);
    const water = this.ann.filter((x) => x.w).reduce((a, x) => a + x.v, 0);
    const hydAnn = this.ann.filter((x) => x.k === 'L').length ? this.walk(0).bhp : 0;
    return {
      kmw, minAnnRho: minAnn, gasFree, gasDiss, water,
      staticOverbalance: hydAnn - this.s.pform,
      killed: gasFree < 0.3 && gasDiss < 0.2 && water < 0.3 && hydAnn >= this.s.pform - 5,
    };
  }
}

export const BOP_LABEL = { annular: 'Annular', upr: 'Upper pipe ram', lpr: 'Lower pipe ram', bsr: 'Blind/shear ram' };
const FAIL_MSG = {
  chokePlug: 'Failure: choke A plugging',
  chokeWashout: 'Failure: choke A washing out',
  nozzlePlug: 'Failure: bit nozzle plugged',
  stringWashout: 'Failure: drill string washout',
  pumpFailure: 'Failure: active pump failed',
};
