// Coach: procedure steps, current step, live targets and hints.
import { scheduleAt } from './killsheet.js';

const DRILL_SHUTIN = [
  { id: 'detect', t: 'Drill ahead — watch for kick signs', h: 'Watch flow out, pit volume and drill rate. Any sign of a kick: stop drilling and flow check.' },
  { id: 'space', t: 'Stop rotation, pick up and space out', h: 'Stop the rotary, then pick up off bottom so no tool joint is across the pipe rams.' },
  { id: 'pumps', t: 'Stop the pumps', h: 'Stop the mud pump. With the pump off, check flow at the flowline.' },
  { id: 'bop', t: 'Close the BOP (annular or upper pipe ram)', h: 'Hard shut-in: choke already closed. Close the annular or the upper pipe ram.' },
  { id: 'hcr', t: 'Open the HCR', h: 'Open the HCR to put casing pressure on the choke panel gauge.' },
  { id: 'confirm', t: 'Confirm the well is shut in', h: 'No flow at the flowline, pit level steady, BOP closed on the panel. If it still flows, close another BOP element.' },
  { id: 'record', t: 'Record stabilised SIDPP, SICP and pit gain', h: 'Wait for pressures to stop building. Record when stable — not too early (still building) and not too late (gas migration adds pressure).' },
  { id: 'sheet', t: 'Complete the kill sheet', h: 'Open the kill sheet. Check your KMW, ICP, FCP and DP schedule.' },
  { id: 'method', t: 'Choose the kill method', h: "Driller's: circulate the influx out with original mud first. Wait & Weight: weight up first, one circulation." },
];
const WW = [
  { id: 'weight', t: 'Weight up kill mud — monitor while waiting', h: 'Start weighting up the kill pit. While waiting, watch for gas migration: hold SIDPP constant by bleeding small volumes through the choke.' },
  { id: 'suction', t: 'Line up pump suction to the kill pit', h: 'Manifold tab: suction to kill pit once the kill mud is ready.' },
  { id: 'startup', t: 'Pump start-up: hold casing pressure constant', h: 'Reset the stroke counter. Bring the pump up slowly to kill rate while opening the choke to hold casing pressure.' },
  { id: 'tobit', t: 'Follow the DP schedule until kill mud is at the bit', h: 'Adjust the choke so drill pipe pressure follows the schedule. Wait for the pressure to respond before the next adjustment.' },
  { id: 'tosurf', t: 'Hold FCP until kill mud returns to surface', h: 'Keep drill pipe pressure at FCP. As gas reaches the choke, adjust smoothly — then close in as mud follows the gas.' },
  { id: 'stop', t: 'Stop the pump holding casing pressure; check pressures', h: 'Slow the pump holding casing pressure, close the choke, then check SIDPP and SICP are zero.' },
  { id: 'open', t: 'Flow check and open the well', h: 'With zero pressures: open the choke, flow check, then open the BOP.' },
];
const DRILLERS = [
  { id: 'startup1', t: 'Pump start-up: hold casing pressure constant', h: 'Reset the stroke counter. Bring the pump up to kill rate while opening the choke to hold casing pressure.' },
  { id: 'circ1', t: '1st circulation: hold DP constant at ICP', h: 'Hold drill pipe pressure at the ICP you observed after start-up until the influx is out (total circulation strokes).' },
  { id: 'stop1', t: 'Stop pump holding CP; check SIDPP = SICP', h: 'Shut down holding casing pressure. SIDPP and SICP should both equal the original SIDPP if the influx is out.' },
  { id: 'weight', t: 'Weight up kill mud', h: 'Start weighting up (can be done during the 1st circulation).' },
  { id: 'suction', t: 'Line up pump suction to the kill pit', h: 'Manifold tab: suction to kill pit.' },
  { id: 'startup2', t: 'Pump start-up: hold casing pressure constant', h: 'Reset the stroke counter. Bring the pump to kill rate holding casing pressure.' },
  { id: 'tobit2', t: 'Kill mud to bit: hold casing pressure constant', h: 'With original mud in the annulus, hold casing pressure constant until kill mud reaches the bit.' },
  { id: 'tosurf2', t: 'Hold DP at FCP until kill mud at surface', h: 'Once kill mud is at the bit, hold drill pipe pressure at FCP.' },
  { id: 'stop', t: 'Stop the pump; check pressures are zero', h: 'Shut down holding casing pressure, close the choke, check SIDPP and SICP are zero.' },
  { id: 'open', t: 'Flow check and open the well', h: 'Open the choke, flow check, open the BOP.' },
];
const TRIP = [
  { id: 'detect', t: 'Pull out of hole — compare trip tank with trip sheet', h: 'Each stand should take its calculated fill from the trip tank. Less fill than calculated = swabbing / kick.' },
  { id: 'stoptrip', t: 'Stop tripping and set the slips', h: 'Stop pulling and set the slips with a tool joint at working height.' },
  { id: 'stab', t: 'Stab the FOSV (open)', h: 'Install the full-opening safety valve in the OPEN position.' },
  { id: 'closefosv', t: 'Close the FOSV', h: 'Close the FOSV so the well cannot flow up the drill pipe.' },
  { id: 'bop', t: 'Close the BOP', h: 'Close the annular or upper pipe ram (choke already closed).' },
  { id: 'hcr', t: 'Open the HCR', h: 'Open the HCR to read casing pressure.' },
  { id: 'confirm', t: 'Confirm the well is shut in', h: 'Trip tank steady, no flow. If not, close another BOP element.' },
  { id: 'topdrive', t: 'Make up top drive, open FOSV, read SIDPP', h: 'Make up the top drive to the FOSV and open it to read drill pipe pressure.' },
  { id: 'record', t: 'Record SIDPP, SICP and pit gain', h: 'Record stabilised pressures. Bit is off bottom: next steps (stripping / volumetric) come in Phase 3.' },
];

export class Coach {
  constructor(session) {
    this.ses = session;
    const sim = session.sim;
    this.mode = sim.mode;
    this.latch = {};
    this.circ = null;   // { n, startTotal, cp0, dp0, ready }
    this.circDone = {};
    this.method = null;
  }
  get steps() {
    if (this.mode === 'tripping') return TRIP;
    const tail = this.method === 'drillers' ? DRILLERS : this.method === 'ww' ? WW : [];
    return [...DRILL_SHUTIN, ...tail];
  }

  update() {
    const ses = this.ses, sim = ses.sim, L = sim.last;
    this.method = sim.method ?? null;
    const sealed = L.sealed;
    const pumpOn = sim.pumpRate() > 0;
    const sheet = ses.sheet?.accepted ? ses.sheet.values : null;
    const ev = (type, pred = () => true) => sim.events.some((e) => e.type === type && pred(e));

    // circulation tracking (kill phase)
    if (this.method && sealed && pumpOn && !this.circ) {
      const n = (this.circDone[1] ? 2 : 1);
      this.circ = { n, startTotal: sim.counters.strokesTotal, cp0: L.cp, dp0: null, atBitDp: null, ready: false, t0: sim.t };
    }
    if (this.circ) {
      const c = this.circ;
      const p = sim.pumps[sim.activePump];
      const killSpm = this.killSpm();
      if (!c.ready && p.spm >= killSpm - 0.5 && sim.t - c.t0 > 20) { c.ready = true; c.dp0 = L.spp; }
      c.done = sim.counters.strokesTotal - c.startTotal;
      if (sheet && c.atBitDp === null && c.done >= sheet.stkBit && c.ready) c.atBitDp = L.spp;
      if (!pumpOn && p.spm < 1) {
        if (sheet && c.done >= sheet.stkTotal * 0.9) this.circDone[c.n] = true;
        this.circ = null;
      }
    }
    const circ = this.circ;
    const C = {
      detect: () => !sim.rotary || !sim.onBottom || sim.pumps[sim.activePump].spm < 1 || sealed,
      space: () => !sim.rotary && sim.spacedOut,
      pumps: () => sim.pumps[sim.activePump].spm < 1 || sealed,
      bop: () => sealed || ['annular', 'upr', 'lpr'].some((k) => sim.bop[k].state !== 'open'),
      hcr: () => sim.hcr.open && sealed,
      confirm: () => sealed && sim.hcr.open && Math.abs(L.flowOut) < 0.05,
      record: () => ev('record'),
      sheet: () => !!ses.sheet?.accepted,
      method: () => !!this.method,
      weight: () => sim.pits.killPit.readyAt !== null,
      suction: () => sim.pits.suction === 'kill',
      startup: () => circ?.ready || this.circDone[1],
      tobit: () => this.circDone[1] || (circ && sheet && circ.done >= sheet.stkBit),
      tosurf: () => this.circDone[1] || (circ && sheet && circ.done >= sheet.stkTotal),
      stop: () => (this.circDone[1] || this.circDone[2]) && !pumpOn && L.spp !== null && L.spp < 25 && L.cp < 25,
      open: () => sim.ended,
      startup1: () => (circ?.n === 1 && circ.ready) || this.circDone[1],
      circ1: () => this.circDone[1] || (circ?.n === 1 && sheet && circ.done >= sheet.stkTotal),
      stop1: () => this.circDone[1] && !pumpOn,
      startup2: () => (circ?.n === 2 && circ.ready) || this.circDone[2],
      tobit2: () => this.circDone[2] || (circ?.n === 2 && sheet && circ.done >= sheet.stkBit),
      tosurf2: () => this.circDone[2] || (circ?.n === 2 && sheet && circ.done >= sheet.stkTotal),
      stoptrip: () => !sim.trip.pulling,
      stab: () => sim.fosvInstalled,
      closefosv: () => sim.stringTop === 'closed' || !!sim.topDrive,
      topdrive: () => !!sim.topDrive && sim.stringTop === 'connected',
    };
    const steps = this.steps;
    for (const s of steps) if (!this.latch[s.id] && C[s.id]?.()) this.latch[s.id] = true;
    // in drillers 'stop' should only latch after 2nd circulation
    if (this.method === 'drillers' && this.latch.stop && !this.circDone[2]) this.latch.stop = false;
    const idx = steps.findIndex((s) => !this.latch[s.id]);
    this.idx = idx < 0 ? steps.length - 1 : idx;
    return this.view();
  }

  killSpm() { return this.ses.sheet?.scrSpm ?? this.ses.sim.s.scr[0].spm; }

  /** live target for the gauges */
  target() {
    const ses = this.ses, sim = ses.sim, L = sim.last;
    const steps = this.steps;
    const cur = steps[this.idx]?.id;
    const sheet = ses.sheet?.accepted ? ses.sheet.values : null;
    const c = this.circ;
    if (!c) return null;
    if (['startup', 'startup1', 'startup2'].includes(cur) || !c.ready) return { kind: 'cp', psi: c.cp0, label: 'Hold CP' };
    if (this.method === 'ww' && sheet) {
      const stk = sim.counters.strokes;
      return { kind: 'dp', psi: scheduleAt(sheet.icp, sheet.fcp, sheet.stkBit, stk), label: stk >= sheet.stkBit ? 'FCP' : `Schedule @ ${Math.round(stk)} stk` };
    }
    if (this.method === 'drillers') {
      if (c.n === 1) return { kind: 'dp', psi: c.dp0, label: 'Hold ICP' };
      if (sheet && c.done < sheet.stkBit) return { kind: 'cp', psi: c.cp0, label: 'Hold CP (KMW to bit)' };
      return { kind: 'dp', psi: c.atBitDp ?? L.spp, label: 'Hold FCP' };
    }
    return null;
  }

  view() {
    const sim = this.ses.sim, L = sim.last;
    const steps = this.steps;
    const cur = steps[this.idx];
    let hint = cur?.h ?? '';
    const tgt = this.target();
    if (cur?.id === 'detect' && sim.flags.kickAt !== null && (L.pitGain > 1 || L.tripTankDelta > -sim.trip.expectedFill + 1.5)) {
      hint = this.mode === 'tripping'
        ? `Trip tank shows ${(-L.tripTankDelta).toFixed(1)} bbl fill vs ${sim.trip.expectedFill.toFixed(1)} bbl calculated. The hole is not taking the right fill.`
        : `Pit gain +${L.pitGain.toFixed(1)} bbl and flow out above pump rate. These are kick signs.`;
    }
    if (tgt) {
      const meas = tgt.kind === 'dp' ? L.spp : L.cp;
      const d = Math.round(meas - tgt.psi);
      const act = Math.abs(d) < 15 ? 'on target — hold' : d < 0 ? 'below target → close the choke a little, then wait' : 'above target → open the choke a little, then wait';
      hint = `${tgt.label}: ${Math.round(tgt.psi)} psi on ${tgt.kind === 'dp' ? 'drill pipe' : 'casing'} (now ${Math.round(meas)}, ${d >= 0 ? '+' : ''}${d}) — ${act}.`;
    }
    if (cur?.id === 'record' && L.qinf > 0.05) hint = 'Pressures are still building — the formation is still feeding. Wait before recording.';
    return {
      steps: steps.map((s, i) => ({ ...s, state: this.latch[s.id] ? 'done' : i === this.idx ? 'cur' : 'todo' })),
      idx: this.idx, cur, hint, target: tgt,
    };
  }
}

/**
 * MAASP coaching while the influx is still below the casing shoe.
 * Returns { level, show } where level 0 = fine, 1 = within 10 % of MAASP, 2 = above MAASP.
 * `shown` is the highest level already shown since casing pressure last fell below 80 % of MAASP.
 */
export function maaspCheck({ cp, maasp, gasTop, shoe, sealed, shown = 0 }) {
  if (!sealed || !(maasp > 0) || gasTop === null || gasTop === undefined || !(gasTop > shoe)) return { level: 0, show: false, reset: true };
  const r = cp / maasp;
  if (r < 0.8) return { level: 0, show: false, reset: true };
  const level = r >= 1 ? 2 : r >= 0.9 ? 1 : 0;
  return { level, show: level > shown, reset: false };
}
