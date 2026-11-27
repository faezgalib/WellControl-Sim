// Debrief: turn a finished session into findings (what happened, why it matters, correct action).
import { FAILURES } from './scenario.js';
import { FIELDS } from './killsheet.js';

const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function analyse(ses) {
  const sim = ses.sim, s = sim.s, ev = sim.events, S = sim.samples;
  const F = [];
  const add = (sev, t, title, what, action = '') => F.push({ sev, t, title, what, action });
  const at = (t) => S.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), S[0] || { pit: 0 });
  const first = (type, pred = () => true, after = -1) => ev.find((e) => e.type === type && e.t > after && pred(e));

  const kickAt = sim.flags.kickAt;
  const sealedAt = sim.flags.sealedAt;

  // ---------- line-up ----------
  if (s.lineupCheck) {
    const L0 = s.lineup;
    const wrong = [];
    if (L0.hcr) wrong.push('HCR was open');
    if (!L0.isoA) wrong.push('choke A line valve was closed');
    if (L0.chokeA > 0) wrong.push(`choke A was ${L0.chokeA}% open`);
    const bopClose = first('bop', (e) => e.action === 'close');
    if (wrong.length && bopClose) {
      const fixed = !bopClose.hcr && bopClose.chokePos < 1 && bopClose.chokeIsoA;
      if (fixed) add('good', 0, 'Choke manifold line-up corrected', `At the start ${wrong.join(', ')}. You corrected it before shutting in.`);
      else add('warning', bopClose.t, 'Choke manifold not lined up for a hard shut-in',
        `When the BOP was closed: HCR ${bopClose.hcr ? 'open' : 'closed'}, choke ${bopClose.chokePos.toFixed(0)}% open, choke A line ${bopClose.chokeIsoA ? 'open' : 'closed'}. Initial errors: ${wrong.join(', ')}.`,
        'Before drilling or tripping, line up for a hard shut-in: HCR closed, remote choke closed, flow path through choke A open to the MGS.');
    }
  }

  // ---------- detection ----------
  if (kickAt !== null) {
    const resp = ev.find((e) => e.t >= kickAt && ((e.type === 'rotary' && !e.on) || e.type === 'pickup' || (e.type === 'pump' && !e.on) || (e.type === 'trip' && !e.pull) || e.type === 'bop'));
    const gainAtSeal = sealedAt !== null ? (sim.mode === 'tripping' ? -(at(sealedAt).pit) : at(sealedAt).pit) : null;
    if (resp) {
      const dt = resp.t - kickAt;
      const sev = dt > 600 ? 'warning' : 'good';
      add(sev, resp.t, `First response ${Math.round(dt / 60)} min after the influx started`,
        sim.mode === 'drilling'
          ? `The influx started at ${mmss(kickAt)} (drilling break: ROP ${s.normalRop} → ${s.drillingBreakRop} ft/hr, then flow out and pit gain). You first reacted at ${mmss(resp.t)}.`
          : `The swab influx started at ${mmss(kickAt)}. You stopped at ${mmss(resp.t)}.`,
        dt > 600 ? 'React to the first sign — drilling break, flow increase or wrong hole fill. Flow check early; every minute adds pit gain and raises SICP.' : '');
    }
    if (sealedAt !== null) {
      const gain = Math.max(0, sim.mode === 'tripping' ? sim.counters.influx : at(sealedAt).pit);
      add(gain > 20 ? 'warning' : 'info', sealedAt, `Well sealed with about ${gain.toFixed(1)} bbl influx`,
        gain > 20 ? 'A large influx means higher SICP and less margin to MAASP during the kill.' : 'A small influx keeps casing pressure and shoe pressure low during the kill.');
    } else add('critical', sim.t, 'The well was never shut in', 'The BOP was not sealed at the end of the session.', 'Follow the hard shut-in sequence as soon as a kick is confirmed.');
  }

  // ---------- shut-in sequence ----------
  for (const e of ev.filter((x) => x.type === 'bop' && x.action === 'close')) {
    if (e.el === 'bsr') add('critical', e.t, 'Blind/shear ram closed on pipe', 'Closing the shear ram cuts the drill string. This is a last resort only.', 'Use the annular or pipe rams to shut in on pipe.');
    if (e.pumping) add('warning', e.t, `${label(e.el)} closed with the pump running`, 'Closing the BOP while pumping traps pump pressure and can surge the shoe.', 'Stop the pump first, then close the BOP.');
    if (e.rotating) add('warning', e.t, `${label(e.el)} closed while rotating`, 'Closing on a rotating string damages the packer/ram rubbers.', 'Stop rotation and pick up before closing the BOP.');
    if (e.el === 'upr' && !e.spacedOut) add('critical', e.t, 'Upper pipe ram closed on a tool joint', 'The string was not spaced out, so the upper pipe ram closed on a tool joint and could not seal.', 'Pick up off bottom to space out before closing pipe rams. Close the annular or another ram if a ram does not seal.');
    if (sim.mode === 'tripping' && e.stringTop !== 'closed' && e.stringTop !== 'connected') add('critical', e.t, 'BOP closed before the FOSV was installed and closed',
      `With the drill pipe open, the well can flow up the string. Flow up the pipe this session: ${sim.counters.pipeFlow.toFixed(1)} bbl.`, 'Tripping shut-in: stop, set slips, stab the FOSV open, close it, then close the BOP and open the HCR.');
  }
  const leak = sim.failure.active.find((f) => f.type === 'annularLeak');
  if (leak) {
    const annClose = first('bop', (e) => e.el === 'annular' && e.action === 'closed');
    if (annClose) {
      const ram = first('bop', (e) => (e.el === 'upr' || e.el === 'lpr') && e.action === 'close', annClose.t);
      if (ram) add(ram.t - annClose.t > 120 ? 'warning' : 'good', ram.t, 'Annular failed to seal — second barrier closed',
        `The annular did not seal. You closed the ${label(ram.el)} ${Math.round(ram.t - annClose.t)} s after the annular closed.`,
        'Confirm shut-in by checking flow, trip tank and panel feedback. If it still flows, close another BOP element at once.');
      else add('critical', annClose.t, 'Annular failed to seal and the well kept flowing', 'Flow continued after the annular closed and no other element was closed.', 'Confirm shut-in (flowline, trip tank). If flowing, close a pipe ram.');
    }
  }
  const hcrOpen = first('hcr', (e) => e.open, sealedAt ?? -1);
  const rec = first('record');
  if (sealedAt !== null && rec && !(hcrOpen && hcrOpen.t < rec.t)) add('warning', rec.t, 'Pressures recorded with the HCR closed', 'With the HCR closed the choke panel casing gauge reads zero.', 'Open the HCR after closing the BOP to read SICP.');

  // ---------- recorded pressures ----------
  if (rec) {
    const tr = rec.truth;
    const recDp = Number(rec.sidpp), recCp = Number(rec.sicp);
    if (s.floatValve && recDp < 30 && tr.sidpp > 60) add('critical', rec.t, 'SIDPP recorded as zero with a float valve in the string',
      `The float stops pressure reaching the standpipe. True SIDPP was about ${tr.sidpp} psi.`, 'Bump the float: pump slowly with the well shut in until drill pipe pressure stops rising sharply and casing starts to rise, stop, and subtract the casing pressure increase.');
    else if (rec.t - (sealedAt ?? rec.t) < 120 && tr.buildup) add('warning', rec.t, 'Pressures recorded before they stabilised',
      `You recorded SIDPP ${recDp} psi while the formation was still feeding (true stabilised SIDPP ≈ ${tr.sidpp} psi). KMW would be underestimated.`, 'Wait for the build-up to level off (typically several minutes), then record.');
    else if (recDp - tr.sidpp > 40) add('warning', rec.t, 'Recorded SIDPP includes gas migration',
      `Recorded ${recDp} psi vs ${tr.sidpp} psi from formation pressure. The extra ${recDp - tr.sidpp} psi comes from gas migrating in the closed well — it raises KMW and the kill pressures.`,
      'Record when the build-up curve flattens. If pressures keep rising steadily afterwards, that rise is migration, not formation pressure.');
    else if (Math.abs(recDp - tr.sidpp) <= 40) add('good', rec.t, 'Stabilised pressures recorded correctly', `SIDPP ${recDp} psi (true ≈ ${tr.sidpp}), SICP ${recCp} psi, gain ${rec.gain} bbl.`);
  }

  // ---------- kill sheet ----------
  if (ses.sheet?.check) {
    const wrong = FIELDS.filter((f) => ses.sheet.check[f.key] && !ses.sheet.check[f.key].ok);
    if (wrong.length) add('warning', ses.sheet.acceptedAt ?? 0, `Kill sheet: ${wrong.length} line${wrong.length > 1 ? 's' : ''} not correct`,
      wrong.slice(0, 6).map((f) => `${f.label}: entered ${ses.sheet.check[f.key].entered ?? '—'}, correct ${ses.sheet.check[f.key].expected}${ses.sheet.check[f.key].followsOwn ? ' (follows your earlier value)' : ''}`).join(' · '),
      'Fix the first wrong line first — later lines often follow from it.');
    else add('good', ses.sheet.acceptedAt ?? 0, 'Kill sheet correct', 'All calculated lines matched.');
  }
  const wu = first('weightup');
  if (wu && rec) {
    const trueKmw = Math.ceil((s.mud.rho + (s.pform - 0.052 * s.mud.rho * s.well.td) / (0.052 * s.well.td)) * 10 - 1e-9) / 10;
    if (wu.kmw + 1e-6 < trueKmw) add('critical', wu.t, `Kill mud too light (${wu.kmw.toFixed(1)} ppg)`, `Required kill mud density is ${trueKmw.toFixed(1)} ppg. The well will not be dead with ${wu.kmw.toFixed(1)} ppg.`, 'KMW = OMW + SIDPP ÷ (0.052 × TVD), rounded up.');
    else if (wu.kmw - trueKmw > 0.25) add('warning', wu.t, `Kill mud heavier than needed (${wu.kmw.toFixed(1)} ppg)`, `Required ${trueKmw.toFixed(1)} ppg. Extra weight reduces MAASP and raises shoe pressure.`, 'Use the stabilised SIDPP, not a value inflated by migration.');
  }

  // ---------- kill phase: BHP control ----------
  const ks = first('killstart');
  if (ks) {
    const killS = S.filter((x) => x.t >= ks.t);
    const episodes = (pred) => {
      const out = []; let cur = null;
      for (const x of killS) {
        if (pred(x)) { if (!cur) cur = { t0: x.t, t1: x.t, worst: x }; cur.t1 = x.t; if (Math.abs(x.bhp - x.pform) > Math.abs(cur.worst.bhp - cur.worst.pform)) cur.worst = x; }
        else if (cur) { out.push(cur); cur = null; }
      }
      if (cur) out.push(cur);
      return out.filter((e) => e.t1 - e.t0 >= 10);
    };
    const under = episodes((x) => x.bhp < x.pform - 15);
    for (const e of under.slice(0, 5)) {
      const ctx = context(sim, e.t0);
      add('critical', e.t0, `BHP below formation pressure for ${Math.round((e.t1 - e.t0) / 60 * 10) / 10} min`,
        `Worst ${Math.round(e.worst.pform - e.worst.bhp)} psi under formation pressure at ${mmss(e.worst.t)} (${ctx.what}). DP ${e.worst.spp ?? '—'} psi, CP ${e.worst.cp} psi, choke ${e.worst.choke}%.`,
        ctx.action || 'Hold the right gauge: casing pressure during start-up/shut-down, drill pipe pressure (schedule) during circulation. Small choke moves, then wait for the response.');
    }
    if (sim.counters.influxAfterSeal > 0.3) add('critical', null, `Secondary influx: ${sim.counters.influxAfterSeal.toFixed(1)} bbl entered during the kill`, 'Every period of BHP below formation pressure lets more formation fluid in.', '');
    const over = episodes((x) => x.bhp - x.tgt > 250);
    for (const e of over.slice(0, 3)) {
      const ctx = context(sim, e.t0);
      add('warning', e.t0, `Excess overbalance for ${Math.round((e.t1 - e.t0) / 60 * 10) / 10} min`,
        `BHP up to ${Math.round(e.worst.bhp - e.worst.pform)} psi over formation pressure at ${mmss(e.worst.t)} (${ctx.what}). Shoe pressure ${e.worst.pShoe} psi vs fracture ${e.worst.frac} psi.`,
        ctx.action || 'Too much back-pressure risks losses at the shoe. Open the choke in small steps to bring drill pipe pressure back to target.');
    }
    if (sim.counters.losses > 0.2) add('critical', sim.flags.lossesAt, `Losses at the shoe: ${sim.counters.losses.toFixed(1)} bbl`, 'Shoe pressure exceeded the fracture pressure.', 'Keep casing pressure below MAASP. If losses start: reduce pump rate, hold BHP, consider volumetric.');
    if (!under.length && !over.length && sim.counters.influxAfterSeal <= 0.3) add('good', ks.t, 'BHP held within limits during the kill', 'No underbalance and no excessive overbalance were recorded.');
  }

  // ---------- failures ----------
  for (const fe of ev.filter((e) => e.type === 'failure')) {
    const type = fe.failure;
    const after = (sec) => ev.filter((e) => e.t >= fe.t && e.t <= fe.t + sec);
    const w = S.filter((x) => x.t >= fe.t && x.t <= fe.t + 600);
    const minM = w.length ? Math.min(...w.map((x) => x.bhp - x.pform)) : 0;
    const maxM = w.length ? Math.max(...w.map((x) => x.bhp - x.pform)) : 0;
    const chokeMoves = after(300).filter((e) => e.type === 'choke').reduce((a, e) => a + (e.to - e.from), 0);
    let sev = 'info', what = FAILURES[type].hint, act = '';
    if (type === 'nozzlePlug') {
      act = 'Drill pipe pressure jumped but casing did not: nozzle plugged. Do NOT open the choke to bring DP down. Hold casing pressure, slow down/stop, and establish a new circulating pressure (new ICP/FCP schedule).';
      if (chokeMoves > 5 && minM < -15) { sev = 'critical'; what += ` You opened the choke ${chokeMoves.toFixed(0)}% chasing drill pipe pressure; BHP fell to ${Math.round(minM)} psi under formation pressure.`; }
      else sev = 'good';
    } else if (type === 'stringWashout') {
      act = 'Drill pipe pressure falling slowly with casing steady: washout. Do NOT close the choke to restore DP. Stop, hold casing, and plan to locate the washout.';
      if (chokeMoves < -5 && maxM > 150) { sev = 'warning'; what += ` You closed the choke ${(-chokeMoves).toFixed(0)}% to keep DP up; BHP rose to +${Math.round(maxM)} psi.`; } else sev = 'good';
    } else if (type === 'chokePlug') {
      const sw = after(300).find((e) => e.type === 'manifold' && e.el === 'isoB' && e.open) || after(300).find((e) => e.type === 'pump' && !e.on);
      act = 'Both pressures rising together = choke plugging. Stop the pump (or open the choke), isolate the plugged choke and switch to choke B.';
      sev = sw ? 'good' : 'warning';
      what += sw ? ` You responded at ${mmss(sw.t)}.` : ' No switch to choke B / pump stop within 5 min.';
      if (maxM > 300) what += ` BHP reached +${Math.round(maxM)} psi.`;
    } else if (type === 'chokeWashout') {
      const sw = after(900).find((e) => e.type === 'manifold' && e.el === 'isoB' && e.open);
      act = 'Both pressures falling and the choke keeps closing to hold them = choke washout. Isolate it and switch to choke B.';
      sev = sw ? 'good' : (minM < -15 ? 'critical' : 'warning');
      what += sw ? ` You switched to choke B at ${mmss(sw.t)}.` : ' Choke B was not lined up.';
      if (minM < -15) what += ` BHP dropped to ${Math.round(minM)} psi under formation pressure.`;
    } else if (type === 'pumpFailure') {
      const sw = after(600).find((e) => e.type === 'pump' && /Switched/.test(e.msg));
      act = 'Both pressures falling with pump strokes dropping = pump failure. Close the choke to hold casing pressure as the rate drops, switch to the standby pump and repeat the start-up procedure.';
      sev = minM < -30 ? 'critical' : (sw ? 'good' : 'warning');
      what += sw ? ` Switched pump at ${mmss(sw.t)}.` : '';
      if (minM < -30) what += ` BHP fell to ${Math.round(minM)} psi under formation pressure.`;
    }
    add(sev, fe.t, `Equipment problem: ${FAILURES[type].label}`, what, act);
  }

  // ---------- outcome ----------
  const st = sim.wellStatus();
  const L = sim.last;
  let outcome;
  if (sim.mode === 'tripping') {
    const sealed = sim.sealed().sealed;
    outcome = sealed && rec ? { k: 'ok', t: 'Well secured', d: 'Kick detected and the well shut in on a trip. Off-bottom kill and stripping come in Phase 3.' }
      : { k: 'bad', t: 'Well not secured', d: 'The session ended before the well was shut in and pressures recorded.' };
  } else if (st.killed && L.cp < 30 && (L.spp ?? 0) < 30) outcome = { k: 'ok', t: 'Well killed', d: `Kill mud ${st.kmw.toFixed(1)} ppg all round, pressures at zero.` };
  else if (sim.flags.sheared) outcome = { k: 'bad', t: 'Pipe sheared', d: 'Session ended after the shear ram cut the pipe.' };
  else {
    const left = [];
    if (st.gasFree >= 0.3 || st.gasDiss >= 0.2) left.push('influx still in the well');
    if (st.minAnnRho < st.kmw - 0.05) left.push(`annulus not full of kill mud (lightest ${st.minAnnRho.toFixed(1)} ppg)`);
    if (st.staticOverbalance < 0) left.push(`static underbalance ${Math.round(-st.staticOverbalance)} psi`);
    outcome = { k: left.length ? 'mid' : 'ok', t: left.length ? 'Kill not completed' : 'Well dead — pressures not yet bled off', d: left.join(' · ') || 'Bleed off and flow check.' };
  }
  F.sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
  return {
    outcome, findings: F,
    stats: {
      duration: sim.t, influx: sim.counters.influx, secondary: sim.counters.influxAfterSeal, losses: sim.counters.losses,
      maxCp: Math.max(0, ...S.map((x) => x.cp)), maasp: s.fracShoePsi - 0.052 * s.mud.rho * s.well.shoe.depth,
      gasVented: sim.counters.gasVented * 379.4 / 1000,
      gainAtSeal: sealedAt === null ? null : +(sim.mode === 'tripping' ? sim.counters.influx : Math.max(0, at(sealedAt).pit)).toFixed(1),
    },
  };
}

function label(el) { return { annular: 'Annular', upr: 'Upper pipe ram', lpr: 'Lower pipe ram', bsr: 'Blind/shear ram' }[el] ?? el; }

function context(sim, t) {
  const ev = sim.events;
  const recent = (type, win, pred = () => true) => ev.filter((e) => e.type === type && e.t <= t && e.t >= t - win && pred(e)).pop();
  const fail = ev.filter((e) => e.type === 'failure' && e.t <= t).pop();
  const pumpOn = recent('pump', 240, (e) => e.on);
  const pumpOff = recent('pump', 180, (e) => !e.on);
  const gas = sim.flags.gasAtSurfaceAt !== null && Math.abs(sim.flags.gasAtSurfaceAt - t) < 900;
  if (pumpOn) return { what: 'during pump start-up', action: 'During start-up, hold CASING pressure constant: open the choke gradually as the pump speeds up. Do not watch drill pipe pressure until at kill rate.' };
  if (pumpOff) return { what: 'during pump shut-down', action: 'When slowing the pump, close the choke gradually to hold CASING pressure constant.' };
  if (fail && t - fail.t < 900) return { what: `after ${FAILURES[fail.failure].label.toLowerCase()}`, action: '' };
  if (gas) return { what: 'while gas was at or near the choke', action: 'As gas reaches the choke, casing pressure falls fast — close the choke to hold drill pipe pressure. When mud follows the gas, open again. Small steps, watch DP.' };
  return { what: 'during circulation', action: '' };
}
