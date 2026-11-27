import { h, svg, clear, fmt, fmtTime, toast, modal, holdButton } from './dom.js';
import { Sim, BOP_LABEL } from '../core/engine.js';
import { Coach } from '../core/procedure.js';
import { analyse } from '../core/analysis.js';
import { schedule, scheduleAt } from '../core/killsheet.js';
import { drawWell, drawTrend } from './charts.js';
import { killSheetView } from './killsheet-form.js';
import { saveSession } from '../store.js';

const SPEEDS = [1, 2, 5, 10, 20];
const ARC = 320, CIRC = 427;

export function simScreen(app, scen, opts = {}) {
  const sim = new Sim(scen);
  const ses = {
    id: 's' + Date.now(), date: Date.now(), scen, sim,
    sheet: { entries: {}, kick: { sidpp: '', sicp: '', gain: '' }, scrIndex: 0, accepted: false },
    coachOn: opts.coach ?? true,
  };
  ses.coach = new Coach(ses);
  let speed = 1, paused = false, tab = 'kill', showSteps = false, trendWin = 1800, ctrlChoke = null;
  let raf = 0, lastFrame = performance.now(), acc = 0, lastUi = 0, seenEvents = 0, wakeLock = null, ended = false;
  const R = {};

  // ---------- layout ----------
  const scenChip = `${scen.mode === 'drilling' ? 'Drilling' : 'Tripping'} · ${scen.mud.type} ${scen.mud.rho.toFixed(1)} ppg · ${scen.influx === 'gas' ? 'Gas' : 'Salt water'} kick${scen.floatValve ? ' · Float' : ''}`;
  const speedBtns = SPEEDS.map((s) => h('button', { type: 'button', class: 'btn sm' + (s === 1 ? ' sel' : ''), onClick: () => { speed = s; speedBtns.forEach((b, i) => b.classList.toggle('sel', SPEEDS[i] === s)); } }, `${s}×`));
  R.pause = h('button', { type: 'button', class: 'btn sm', onClick: () => { paused = !paused; R.pause.textContent = paused ? 'Resume' : 'Pause'; R.pause.classList.toggle('sel', paused); } }, 'Pause');
  R.coachBtn = h('button', { type: 'button', class: 'btn sm on', onClick: () => { ses.coachOn = !ses.coachOn; refreshCoachVis(); } }, 'Coach ON');

  const top = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, 'WELL CONTROL SIM'),
    h('div', { class: 'chip' }, scenChip),
    R.phase = h('div', { class: 'chip amber' }, '—'),
    h('div', { class: 'grow' }),
    R.clock = h('div', { class: 'mono', style: { fontSize: '18px' } }, '00:00:00'),
    h('div', { class: 'row', style: { gap: '3px' } }, speedBtns),
    R.pause, R.coachBtn,
    h('button', { type: 'button', class: 'btn sm', onClick: openRecord }, 'Record'),
    h('button', { type: 'button', class: 'btn sm', onClick: openSheet }, 'Kill sheet'),
    h('button', { type: 'button', class: 'btn sm danger', onClick: confirmEnd }, 'End'),
  );

  // well column
  R.wellCanvas = h('canvas', { role: 'img', 'aria-label': 'Wellbore schematic' });
  R.steps = h('div', { class: 'steps hidden', 'aria-label': 'Procedure steps' });
  const wellCol = h('section', { class: 'col-well card', 'aria-label': 'Wellbore' },
    h('div', { class: 'row' }, h('div', { class: 'lbl grow' }, 'Wellbore'),
      R.stepsBtn = h('button', { type: 'button', class: 'btn sm', onClick: () => { showSteps = !showSteps; R.steps.classList.toggle('hidden', !showSteps); R.stepsBtn.classList.toggle('sel', showSteps); } }, 'Steps')),
    R.wellCanvas,
    h('div', { class: 'legend' },
      h('div', {}, h('i', { style: { background: '#3a4250' } }), 'Original mud'),
      h('div', {}, h('i', { style: { background: '#f2a93b' } }), 'Kill mud'),
      h('div', {}, h('i', { style: { background: '#5ab0f0' } }), 'Free gas'),
      scen.mud.type === 'OBM' ? h('div', {}, h('i', { style: { background: '#a99cff' } }), 'Gas in solution') : null,
      scen.influx === 'water' ? h('div', {}, h('i', { style: { background: '#4fd1c5' } }), 'Salt water') : null),
    R.steps);

  // gauges
  const arc = (color) => {
    const fg = svg('circle', { cx: 80, cy: 80, r: 68, fill: 'none', stroke: color, 'stroke-width': 12, 'stroke-dasharray': `0 ${CIRC}`, transform: 'rotate(135 80 80)', 'stroke-linecap': 'round' });
    const tg = svg('circle', { cx: 80, cy: 80, r: 68, fill: 'none', stroke: '#e8eaed', 'stroke-width': 16, 'stroke-dasharray': `0 ${CIRC}`, transform: 'rotate(135 80 80)', opacity: 0 });
    const el = svg('svg', { width: 120, height: 120, viewBox: '0 0 160 160', 'aria-hidden': 'true' },
      svg('circle', { cx: 80, cy: 80, r: 68, fill: 'none', stroke: '#2a3038', 'stroke-width': 12, 'stroke-dasharray': `${ARC} ${CIRC}`, transform: 'rotate(135 80 80)', 'stroke-linecap': 'round' }), fg, tg,
      R._scale = svg('text', { x: 80, y: 140, 'text-anchor': 'middle', fill: '#9aa3ae', 'font-size': 13, 'font-family': 'JetBrains Mono, monospace' }, ''));
    return { el, fg, tg, scale: R._scale };
  };
  R.dpArc = arc('#f2a93b'); R.cpArc = arc('#5ab0f0');
  const gauges = h('div', { class: 'gauges' },
    h('div', { class: 'card gauge dp' }, R.dpArc.el, h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'lbl' }, 'Drill pipe pressure'), R.dpVal = h('div', { class: 'val' }, '0'), R.dpSub = h('div', { class: 'sub' }, ''))),
    h('div', { class: 'card gauge cp' }, R.cpArc.el, h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'lbl' }, 'Casing pressure'), R.cpVal = h('div', { class: 'val' }, '0'), R.cpSub = h('div', { class: 'sub' }, ''))));

  const readout = (lbl, key, reset) => h('div', { class: 'card readout' }, h('div', { class: 'lbl' }, lbl), R[key] = h('div', { class: 'v' }, '—'),
    reset ? h('button', { type: 'button', class: 'btn sm reset', onClick: reset, 'aria-label': `Reset ${lbl}` }, '0') : null);
  R.stkMiles = h('div', { class: 'miles' });
  R.stkBar = h('div', { class: 'stkbar' });
  const strokesCard = h('div', { class: 'card readout wide' },
    h('div', { class: 'stkhead' },
      h('div', { class: 'stkcount' }, h('div', { class: 'row', style: { gap: '6px' } }, h('div', { class: 'lbl' }, 'Strokes'),
        h('button', { type: 'button', class: 'btn sm reset', onClick: () => sim.cmd('resetStrokes'), 'aria-label': 'Reset stroke counter' }, '0')),
        R.roStk = h('div', { class: 'v' }, '—')),
      R.stkMiles),
    R.stkBar);
  const readouts = h('div', { class: 'readouts' },
    readout('Pump rate', 'roSpm'),
    strokesCard,
    scen.mode === 'tripping' ? readout('Trip tank Δ', 'roPit', () => sim.cmd('resetPit')) : readout('Pit gain', 'roPit', () => sim.cmd('resetPit')),
    readout('Flow out', 'roFlow'));

  R.coachStep = h('div', { class: 'step' }, '');
  R.coachTitle = h('div', { class: 'title' }, '');
  R.coachHint = h('div', { class: 'hint' }, '');
  R.mDot = h('div', { class: 'dot' });
  R.mText = h('div', { class: 'small mono' }, '');
  const coachbar = R.coachbar = h('div', { class: 'card coachbar' },
    h('div', { class: 'grow' }, R.coachStep, R.coachTitle, R.coachHint),
    h('div', { class: 'marginbox' }, h('div', { class: 'lbl' }, 'BHP vs formation'),
      h('div', { class: 'mbar' }, h('div', { class: 'zone', style: { left: '50%', width: '25%' } }), h('div', { class: 'mid', style: { left: '50%' } }), R.mDot), R.mText));

  R.trendCanvas = h('canvas', { role: 'img', 'aria-label': 'Pressure trend' });
  const winBtns = [[600, '10m'], [1800, '30m'], [7200, '2h'], [0, 'All']].map(([v, l]) => h('button', { type: 'button', class: 'btn sm' + (v === trendWin ? ' sel' : ''), style: { minHeight: '30px' }, onClick: (e) => { trendWin = v; winBtns.forEach((b) => b.classList.remove('sel')); e.target.classList.add('sel'); } }, l));
  const trend = h('div', { class: 'card trend' },
    h('div', { class: 'row' },
      h('div', { class: 'lg grow' },
        h('span', {}, h('i', { style: { background: '#f2a93b' } }), 'Drill pipe'),
        h('span', {}, h('i', { style: { background: '#5ab0f0' } }), 'Casing'),
        R.lgTarget = h('span', {}, h('i', { style: { background: 'repeating-linear-gradient(90deg,#c3c9d1 0 5px,transparent 5px 9px)' } }), 'Target'),
        R.lgMaasp = h('span', {}, h('i', { style: { background: 'repeating-linear-gradient(90deg,#f0705a 0 2px,transparent 2px 6px)' } }), 'MAASP (kill sheet)')),
      winBtns),
    R.trendCanvas,
    R.lastLog = h('div', { class: 'lastlog' }, ''));

  const main = h('section', { class: 'col-main' }, gauges, readouts, coachbar, trend);

  // controls
  R.tabs = {};
  const tabsDef = [['kill', 'Choke & pump'], ['bop', 'BOP'], ['rig', scen.mode === 'tripping' ? 'Rig floor' : 'Drilling'], ['man', 'Manifold']];
  const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabsDef.map(([k, l]) => R.tabs[k] = h('button', { type: 'button', role: 'tab', class: k === tab ? 'sel' : '', onClick: () => setTab(k) }, l)));
  R.panel = h('div', { class: 'tabpanel' });
  const ctrl = h('section', { class: 'col-ctrl', 'aria-label': 'Controls' }, tabBar, R.panel);

  const root = h('div', { class: 'sim' }, top, h('div', { class: 'simbody' }, wellCol, main, ctrl), h('div', { class: 'rotate-hint toast' }, 'Turn the screen to landscape — the simulator needs a wide screen'));
  app.replaceChildren(root);

  // ---------- control panels ----------
  const panels = {};
  function setTab(k) { tab = k; for (const [key, b] of Object.entries(R.tabs)) b.classList.toggle('sel', key === k); clear(R.panel).append(panels[k]()); updateControls(); }

  panels.kill = () => {
    const ch = () => ctrlChoke ?? (sim.activeChoke() === sim.chokes.B ? 'B' : 'A');
    const nudge = (d) => sim.cmd('choke', { id: ch(), delta: d });
    R.chokeSel = ['A', 'B'].map((id) => h('button', { type: 'button', class: 'btn sm', onClick: () => { ctrlChoke = id; updateControls(); } }, `Choke ${id}`));
    R.chokePos = h('div', { class: 'big' }, '0');
    R.chokeBar = h('div', {});
    R.chokeNote = h('div', { class: 'small muted' }, '');
    R.returns = h('b', {}, '0');
    const chokeCard = h('div', { class: 'card ctl' },
      h('div', { class: 'row' }, h('div', { class: 'lbl grow' }, 'Remote choke'), R.chokeSel),
      h('div', { class: 'row' }, R.chokePos, h('div', { class: 'grow' }), R.chokeNote),
      h('div', { class: 'pbar' }, R.chokeBar),
      h('div', { class: 'grid4' }, [-5, -1, 1, 5].map((d) => h('button', { type: 'button', class: 'btn', onClick: () => nudge(d), 'aria-label': `Choke ${d > 0 ? 'open' : 'close'} ${Math.abs(d)} percent` }, (d > 0 ? '+' : '−') + Math.abs(d)))),
      h('div', { class: 'grid2' }, holdButton('Hold · Close', () => nudge(-0.6)), holdButton('Hold · Open', () => nudge(0.6))),
      h('div', { class: 'kv' }, h('span', {}, 'Choke returns since reset'), h('span', { class: 'row', style: { gap: '6px' } }, R.returns, h('button', { type: 'button', class: 'btn sm', style: { minHeight: '30px' }, onClick: () => sim.cmd('resetReturns') }, 'Reset'))));

    R.pumpSel = [0, 1].map((i) => h('button', { type: 'button', class: 'btn sm', onClick: () => { sim.cmd('selectPump', i); updateControls(); } }, `Pump #${i + 1}`));
    R.pumpStatus = h('div', { class: 'small', style: { fontWeight: 700 } }, '');
    R.pumpSpm = h('div', { class: 'big' }, '0');
    R.pumpTgt = h('div', { class: 'small muted' }, '');
    const togglePump = () => { const p = sim.pumps[sim.activePump]; if (!sim.cmd('pump', { on: !p.on }) && !p.on) toastLastInfo(); updateControls(); };
    R.pumpOnBtn = h('button', { type: 'button', class: 'btn', onClick: () => {
      const p = sim.pumps[sim.activePump];
      if (!p.on && ses.coachOn && sim.last.sealed && sim.method && sim.counters.strokes > 20) {
        coaching([{ title: 'Stroke counter not reset', why: `The counter shows ${fmt(sim.counters.strokes)} strokes. The DP schedule and the bit / bottoms-up / cycle milestones count from zero at the start of each circulation.`, fix: 'Reset the stroke counter, then start the pump slowly while holding casing pressure.' }],
          togglePump, { proceedLabel: 'Start without reset', fixLabel: 'Reset & start', onFix: () => { sim.cmd('resetStrokes'); togglePump(); } });
        return;
      }
      togglePump();
    } }, 'Start pump');
    const pumpCard = h('div', { class: 'card ctl' },
      h('div', { class: 'row' }, h('div', { class: 'lbl grow' }, 'Mud pump'), R.pumpSel),
      h('div', { class: 'row' }, R.pumpSpm, h('div', { class: 'grow' }), h('div', { class: 'col', style: { gap: '2px', alignItems: 'flex-end' } }, R.pumpStatus, R.pumpTgt)),
      h('div', { class: 'grid4' }, [-5, -1, 1, 5].map((d) => h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('pumpRate', { delta: d }), 'aria-label': `Pump rate ${d > 0 ? 'up' : 'down'} ${Math.abs(d)} spm` }, (d > 0 ? '+' : '−') + Math.abs(d)))),
      h('div', { class: 'grid2' }, R.pumpOnBtn, h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('resetStrokes') }, 'Reset strokes')));
    return h('div', { class: 'col' }, chokeCard, pumpCard);
  };

  panels.bop = () => {
    R.bopBtns = {};
    const el = (k) => R.bopBtns[k] = h('button', { type: 'button', class: 'btn state', onClick: () => bopToggle(k) }, h('span', {}, BOP_LABEL[k]), h('span', { class: 'st' }, 'OPEN'));
    R.hcrBtn = h('button', { type: 'button', class: 'btn state', onClick: () => sim.cmd('hcr', !sim.hcr.open) }, h('span', {}, 'HCR valve'), h('span', { class: 'st' }, ''));
    R.bopNote = h('div', { class: 'small muted' }, '');
    return h('div', { class: 'col' },
      h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'BOP stack (top → bottom)'), el('annular'), el('upr'), el('bsr'), el('lpr')),
      h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Choke line'), R.hcrBtn),
      h('div', { class: 'card ctl' },
        h('div', { class: 'kv' }, h('span', {}, 'Accumulator'), h('b', {}, '3,000 psi')),
        h('div', { class: 'kv' }, h('span', {}, 'Manifold'), h('b', {}, '1,500 psi')),
        h('div', { class: 'kv' }, h('span', {}, 'Annular regulator'), h('b', {}, '900 psi')), R.bopNote));
  };

  panels.rig = () => {
    if (scen.mode === 'drilling') {
      R.rotBtn = h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('rotary', !sim.rotary) }, 'Rotary');
      R.pickBtn = h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('pickUp') }, 'Pick up off bottom');
      R.rigInfo = h('div', { class: 'col', style: { gap: '0' } });
      return h('div', { class: 'col' }, h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Drill floor'), R.rotBtn, R.pickBtn), h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Drilling data'), R.rigInfo));
    }
    R.tripBtn = h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('trip', !sim.trip.pulling) }, 'Stop tripping');
    R.stabBtn = h('button', { type: 'button', class: 'btn', onClick: () => { if (sim.cmd('stabFosv') === false) toastLastInfo(); } }, 'Stab FOSV (open)');
    R.fosvBtn = h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('fosv', sim.stringTop !== 'closed') }, 'Close FOSV');
    R.tdBtn = h('button', { type: 'button', class: 'btn', onClick: () => sim.cmd('connectTopDrive') }, 'Make up top drive');
    R.rigInfo = h('div', { class: 'col', style: { gap: '0' } });
    return h('div', { class: 'col' }, h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Drill floor'), R.tripBtn, R.stabBtn, R.fosvBtn, R.tdBtn), h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Trip sheet'), R.rigInfo));
  };

  panels.man = () => {
    R.isoBtns = ['A', 'B'].map((id) => h('button', { type: 'button', class: 'btn state', onClick: () => sim.cmd('chokeIso', { id, open: !sim.chokes[id].iso }) }, h('span', {}, `Choke ${id} line valve`), h('span', { class: 'st' }, '')));
    R.hcrBtn2 = h('button', { type: 'button', class: 'btn state', onClick: () => sim.cmd('hcr', !sim.hcr.open) }, h('span', {}, 'HCR valve'), h('span', { class: 'st' }, ''));
    R.sucBtns = [['active', 'Active pit'], ['kill', 'Kill pit']].map(([k, l]) => h('button', { type: 'button', class: 'btn sm', onClick: () => { if (sim.cmd('suction', k) === false) toastLastInfo(); } }, l));
    R.killPit = h('div', { class: 'col', style: { gap: '0' } });
    return h('div', { class: 'col' },
      h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Choke manifold'), R.hcrBtn2, R.isoBtns[0], R.isoBtns[1],
        h('div', { class: 'small muted' }, 'Hard shut-in line-up: HCR closed, choke closed, choke A line open to the MGS.')),
      h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Pump suction'), h('div', { class: 'grid2' }, R.sucBtns)),
      h('div', { class: 'card ctl' }, h('div', { class: 'lbl' }, 'Kill pit'), R.killPit, h('button', { type: 'button', class: 'btn', onClick: openWeightUp }, 'Weight up kill pit…')));
  };

  // ---------- stroke milestones (from the user's own kill sheet) ----------
  let milesKey = '';
  function updateMiles() {
    const v = ses.sheet.accepted ? ses.sheet.values : null;
    const stk = sim.counters.strokes;
    const ok = (x) => Number.isFinite(x) && x > 0;
    const marks = v ? [['To bit', v.stkBit], ['Bottoms-up', ok(v.stkBit) && ok(v.stkBu) ? v.stkBit + v.stkBu : NaN, v.stkBu], ['1 cycle', v.stkTotal]] : [];
    const key = v ? marks.map((m) => m[1]).join('|') : 'none';
    if (key !== milesKey) {
      milesKey = key;
      clear(R.stkMiles); clear(R.stkBar);
      if (!v) { R.stkMiles.append(h('div', { class: 'small muted' }, 'Complete the kill sheet to see bit, bottoms-up and cycle strokes here.')); return; }
      R.mileRows = marks.map(([lbl, at, own]) => {
        const rem = h('span', { class: 'rem' });
        R.stkMiles.append(h('div', { class: 'mile' }, h('span', { class: 'ml' }, lbl), h('b', { class: 'mono' }, ok(own ?? at) ? fmt(own ?? at) : '—'), rem));
        return { at, rem };
      });
      const total = Math.max(...marks.map((m) => (ok(m[1]) ? m[1] : 0)), 1);
      R.stkFill = h('div', { class: 'fill' });
      R.stkBar.append(R.stkFill, ...marks.filter((m) => ok(m[1])).map(([lbl, at]) => h('div', { class: 'tick', style: { left: `${(at / total) * 100}%` }, title: lbl })));
      R.stkTotal = total;
    }
    if (!R.mileRows) return;
    for (const r of R.mileRows) {
      if (!ok(r.at)) { r.rem.textContent = ''; continue; }
      const left = Math.round(r.at - stk);
      r.rem.textContent = left > 0 ? `${fmt(left)} left` : 'passed';
      r.rem.classList.toggle('done', left <= 0);
    }
    R.stkFill.style.width = `${Math.min(100, (stk / R.stkTotal) * 100)}%`;
  }

  // ---------- coaching mode: stop and explain before a procedural mistake ----------
  function coaching(issues, onProceed, { proceedLabel = 'Do it anyway', backLabel = 'Go back', fixLabel = null, onFix = null } = {}) {
    const wasPaused = paused; paused = true;
    let m = null;
    const done = (fn) => { m.close(); paused = wasPaused; fn?.(); };
    m = modal([
      h('div', { class: 'coachtag' }, svgIcon(), 'COACHING MODE'),
      h('h2', {}, issues.length > 1 ? 'Wait — check these first' : issues[0].title),
      ...issues.map((it) => h('div', { class: 'coachitem' },
        issues.length > 1 ? h('div', { class: 't' }, it.title) : null,
        h('p', {}, it.why),
        h('p', { class: 'do' }, h('b', {}, 'Correct action: '), it.fix))),
      h('p', { class: 'small muted' }, 'Simulation paused. Coaching warnings only appear with Coach ON — the debrief records this either way.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => done(null) }, backLabel),
        fixLabel ? h('button', { type: 'button', class: 'btn primary', onClick: () => done(onFix) }, fixLabel) : null,
        h('button', { type: 'button', class: 'btn ghost danger', onClick: () => done(onProceed) }, proceedLabel)),
    ]);
    m.box.classList.add('coachmodal');
  }
  function svgIcon() {
    return svg('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
      svg('path', { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5' }));
  }
  function shutInIssues(k) {
    if (!['annular', 'upr', 'lpr'].includes(k) || sim.last.sealed) return [];
    const out = [];
    const pump = sim.pumps[sim.activePump];
    if (sim.pumpRate() > 0 && !pump.on) out.push({ title: `The pump is still slowing down (${Math.round(pump.spm)} spm)`, why: 'Mud is still going into the well until the pump has fully stopped. Closing now traps that pressure in a closed well.', fix: 'Wait until the pump rate reads 0, flow check, then close the BOP.' });
    else if (sim.pumpRate() > 0) out.push({ title: 'The pump is still running', why: 'Closing the BOP with the pump on traps pump pressure in a closed well. Pressure climbs hundreds of psi per minute and can break down the shoe or lift the pop-off.', fix: 'Stop the pump and flow check, then close the BOP.' });
    if (sim.rotary) out.push({ title: 'The string is still rotating', why: 'Closing on a rotating string damages the annular element or ram rubbers.', fix: 'Stop the rotary and pick up before closing the BOP.' });
    if (k === 'upr' && !sim.spacedOut) out.push({ title: 'Not spaced out', why: 'A tool joint may be across the upper pipe ram, so the ram cannot seal.', fix: 'Pick up off bottom to space out, then close the ram — or use the annular.' });
    if (sim.activeChoke().pos > 2) out.push({ title: `Choke is ${Math.round(sim.activeChoke().pos)}% open`, why: 'Hard shut-in needs the choke closed before the BOP. With the choke open the well keeps flowing through the choke line when the HCR opens (a soft shut-in).', fix: 'Close the choke first (Choke & pump tab), then close the BOP.' });
    if (sim.mode === 'tripping' && sim.stringTop !== 'closed' && sim.stringTop !== 'connected') out.push({ title: sim.fosvInstalled ? 'FOSV still open' : 'No FOSV in the string', why: 'With the drill pipe open, the well can flow up the string once the annulus is closed.', fix: 'Set slips, stab the FOSV open, close it — then close the BOP.' });
    return out;
  }

  function bopToggle(k) {
    const b = sim.bop[k];
    const closing = b.state === 'open' || b.state === 'opening';
    if (closing && ses.coachOn) {
      const issues = shutInIssues(k);
      if (issues.length) {
        const fixPump = issues.some((i) => i.title.startsWith('The pump'));
        coaching(issues, () => sim.cmd('bop', { el: k, close: true }), {
          proceedLabel: `Close ${BOP_LABEL[k]} anyway`,
          fixLabel: fixPump ? 'Stop the pump for me' : null,
          onFix: () => { sim.cmd('pump', { on: false }); toast('Pump stopped — now flow check, then close the BOP'); },
        });
        return;
      }
    }
    if (k === 'bsr' && closing) {
      const m = modal([h('h2', {}, 'Close blind/shear rams?'), h('p', {}, 'There is pipe across the BOP. Closing the shear rams will cut the drill string. Last resort only.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn danger', onClick: () => { sim.cmd('bop', { el: k, close: true }); m.close(); } }, 'Shear pipe'))]);
      return;
    }
    if (!closing && sim.Pc > 30) {
      const m = modal([h('h2', {}, `Open ${BOP_LABEL[k]}?`), h('p', {}, `There is ${Math.round(sim.Pc)} psi under the BOP. Opening will release it.`),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn danger', onClick: () => { sim.cmd('bop', { el: k, close: false }); m.close(); } }, 'Open'))]);
      return;
    }
    sim.cmd('bop', { el: k, close: closing });
  }

  // ---------- dialogs ----------
  function openRecord() {
    const sealedAt = sim.flags.sealedAt;
    const rows = sealedAt === null ? [] : sim.samples.filter((s) => s.t >= sealedAt).filter((s, i, a) => i % 6 === 0 || i === a.length - 1).slice(-20);
    const f = { sidpp: '', sicp: '', gain: '' };
    const inp = (k, l, u) => h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'r-' + k }, `${l} (${u})`), h('input', { id: 'r-' + k, type: 'number', inputmode: 'decimal', onInput: (e) => f[k] = e.target.value }));
    const m = modal([
      h('h2', {}, 'Record shut-in data'),
      h('p', { class: 'small' }, 'Pick the stabilised values from the pressure log below — not too early (still building), not too late (migration).'),
      rows.length ? h('table', { class: 'sched' }, h('thead', {}, h('tr', {}, h('th', {}, 'Since shut-in'), h('th', {}, 'DP psi'), h('th', {}, 'CP psi'), h('th', {}, scen.mode === 'tripping' ? 'TT Δ bbl' : 'Pit gain bbl'))),
        h('tbody', {}, rows.map((s) => h('tr', {}, h('td', {}, fmtTime(s.t - sealedAt).slice(3)), h('td', {}, s.spp ?? '—'), h('td', {}, s.cp), h('td', {}, s.pit))))) : h('p', { class: 'small muted' }, 'Well not shut in yet — no log.'),
      h('div', { class: 'grid3' }, inp('sidpp', 'SIDPP', 'psi'), inp('sicp', 'SICP', 'psi'), inp('gain', 'Pit gain', 'bbl')),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => {
          if (f.sidpp === '' || f.sicp === '' || f.gain === '') return;
          sim.cmd('record', { sidpp: +f.sidpp, sicp: +f.sicp, gain: +f.gain });
          ses.sheet.kick = { sidpp: f.sidpp, sicp: f.sicp, gain: f.gain };
          ses.sheet.check = null;
          m.close(); toast('Shut-in data recorded — complete the kill sheet');
        } }, 'Record'))]);
  }

  function openSheet() {
    const wasPaused = paused; paused = true;
    let m = null;
    const view = killSheetView(scen, ses.sheet, {
      mode: 'sim',
      onClose: () => m.close(),
      onAccept: (st) => {
        const n = (k) => parseFloat(st.entries[k]);
        st.values = { kmw: n('kmw'), icp: n('icp'), fcp: n('fcp'), stkBit: n('stkBit'), stkBu: n('stkBu'), stkTotal: n('stkTotal'), maasp: n('maasp'), newMaasp: n('newMaasp') };
        st.scrSpm = scen.scr[st.scrIndex].spm;
        st.accepted = true; st.acceptedAt = sim.t;
        m.close();
        if (!sim.method && scen.mode === 'drilling') chooseMethod();
      },
    });
    m = modal([h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Kill sheet · Surface BOP · Vertical well'), h('span', { class: 'small muted' }, 'Simulation paused')), view], { wide: true, onClose: () => { paused = wasPaused; } });
  }

  function chooseMethod() {
    const pick = (mth) => { sim.cmd('method', mth); m.close(); if (mth === 'ww') openWeightUp(); };
    const m = modal([
      h('h2', {}, 'Choose the kill method'),
      h('div', { class: 'grid2' },
        h('button', { type: 'button', class: 'tile', onClick: () => pick('drillers') }, h('div', { class: 't-title' }, "Driller's Method"), h('p', { class: 'small' }, 'Two circulations. 1st: remove the influx with original mud holding DP at ICP. 2nd: kill mud, hold CP to bit, then DP at FCP.')),
        h('button', { type: 'button', class: 'tile', onClick: () => pick('ww') }, h('div', { class: 't-title' }, 'Wait & Weight'), h('p', { class: 'small' }, 'Weight up first, then one circulation following the DP schedule from ICP to FCP. Lower shoe pressure; waiting time with gas migration.'))),
    ]);
  }

  function openWeightUp() {
    let kmw = ses.sheet.values?.kmw ?? '';
    const m = modal([
      h('h2', {}, 'Weight up the kill pit'),
      h('p', { class: 'small' }, `Mixing takes about ${scen.weightUpMin} minutes (simulation time). The pump can take suction from the kill pit once it is ready.`),
      h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'kmw' }, 'Kill mud density (ppg)'), h('input', { id: 'kmw', type: 'number', step: '0.1', value: kmw, onInput: (e) => kmw = e.target.value })),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => { const v = parseFloat(kmw); if (!(v > scen.mud.rho && v < 22)) return; sim.cmd('weightUp', v); m.close(); } }, 'Start mixing'))]);
  }

  function confirmEnd() {
    const m = modal([h('h2', {}, 'End this session?'), h('p', {}, 'The session is saved to your history and the debrief opens.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Keep going'), h('button', { type: 'button', class: 'btn primary', onClick: () => { m.close(); finish('Ended by user'); } }, 'End & debrief'))]);
  }

  async function finish(reason) {
    if (ended) return; ended = true;
    sim.cmd('end', reason);
    cancelAnimationFrame(raf);
    try { wakeLock?.release(); } catch { /* ignore */ }
    const result = analyse(ses);
    const record = {
      id: ses.id, date: ses.date, reason,
      scen: { seed: scen.seed, mode: scen.mode, mud: scen.mud, influx: scen.influx, floatValve: scen.floatValve, failures: scen.failures, name: scen.name, td: scen.well.td },
      method: sim.method ?? null, outcome: result.outcome, findings: result.findings, stats: result.stats,
      samples: sim.samples, events: sim.events.filter((e) => !e.quiet).map(({ type, t, msg }) => ({ type, t, msg })),
      sheet: { entries: ses.sheet.entries, kick: ses.sheet.kick, check: ses.sheet.check ?? null },
    };
    try { await saveSession(record); } catch (e) { console.warn('save failed', e); toast('Could not save to history on this device', 'warn'); }
    app.go('debrief', record.id, record);
  }

  function toastLastInfo() { const e = [...sim.events].reverse().find((x) => x.type === 'info'); if (e) toast(e.msg, 'warn'); }

  function refreshCoachVis() {
    R.coachBtn.textContent = ses.coachOn ? 'Coach ON' : 'Coach OFF';
    R.coachBtn.classList.toggle('on', ses.coachOn);
    R.coachbar.querySelector('.marginbox').classList.toggle('hidden', !ses.coachOn);
    R.stepsBtn.classList.toggle('hidden', !ses.coachOn);
    if (!ses.coachOn) { showSteps = false; R.steps.classList.add('hidden'); R.stepsBtn.classList.remove('sel'); }
  }

  // ---------- updates ----------
  function setArc(a, v, max, tgt = null) {
    a.fg.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, v / max)) * ARC} ${CIRC}`);
    if (tgt !== null) { const p = Math.max(0, Math.min(1, tgt / max)) * ARC; a.tg.setAttribute('stroke-dasharray', `0 ${p - 1.5} 3 ${CIRC}`); a.tg.setAttribute('opacity', 1); }
    else a.tg.setAttribute('opacity', 0);
    a.scale.textContent = `0–${fmt(max)}`;
  }
  const scaleFor = (v) => (v < 1400 ? 2000 : v < 2800 ? 3000 : v < 4500 ? 5000 : 10000);
  const noise = () => (sim.pumpRate() > 0 ? Math.round((Math.random() - 0.5) * 3) : 0);

  function updateUI() {
    const L = sim.last;
    const view = ses.coach.update();
    R.clock.textContent = fmtTime(sim.t);
    R.phase.textContent = view.cur ? shortPhase(view.cur.id) : '—';
    const tgt = ses.coachOn ? view.target : null;
    const dp = L.spp === null ? null : Math.max(0, Math.round(L.spp + noise()));
    const cp = Math.max(0, Math.round(L.cp + noise()));
    R.dpVal.replaceChildren(dp === null ? '—' : fmt(dp), h('small', {}, ' psi'));
    R.cpVal.replaceChildren(fmt(cp), h('small', {}, ' psi'));
    setArc(R.dpArc, dp ?? 0, scaleFor(Math.max(dp ?? 0, tgt?.kind === 'dp' ? tgt.psi : 0)), tgt?.kind === 'dp' ? tgt.psi : null);
    setArc(R.cpArc, cp, scaleFor(Math.max(cp, tgt?.kind === 'cp' ? tgt.psi : 0)), tgt?.kind === 'cp' ? tgt.psi : null);
    const sv = ses.sheet.accepted ? ses.sheet.values : null;
    R.dpSub.textContent = dp === null ? (sim.stringTop === 'closed' ? 'FOSV closed — no reading' : 'String open — no gauge') : tgt?.kind === 'dp' ? `Target ${fmt(tgt.psi)} psi` : sv ? `ICP ${fmt(sv.icp)} · FCP ${fmt(sv.fcp)}` : (sim.s.floatValve ? 'Float valve in string' : '');
    R.cpSub.textContent = tgt?.kind === 'cp' ? `Hold ${fmt(tgt.psi)} psi` : sv ? `MAASP ${fmt(sim.pits.suction === 'kill' && sim.killStart ? sv.newMaasp : sv.maasp)} psi (kill sheet)` : (sim.hcr.open ? '' : 'HCR closed');

    const p = sim.pumps[sim.activePump];
    R.roSpm.replaceChildren(fmt(p.spm, 0), h('small', {}, ' spm'));
    R.roStk.replaceChildren(fmt(sim.counters.strokes), h('small', {}, ' stk'));
    updateMiles();
    if (scen.mode === 'tripping') R.roPit.replaceChildren(fmt(L.tripTankDelta, 1), h('small', {}, ' bbl'));
    else R.roPit.replaceChildren((L.pitGain >= 0 ? '+' : '') + fmt(L.pitGain, 1), h('small', {}, ' bbl'));
    const qin = L.pumpQ;
    R.roFlow.replaceChildren(qin > 0.3 ? fmt((L.flowOut / qin) * 100, 0) : fmt(Math.max(0, L.flowOut), 2), h('small', {}, qin > 0.3 ? ' %' : ' bbl/min'));

    // coach
    R.coachStep.textContent = ses.coachOn ? `Step ${view.idx + 1} of ${view.steps.length}` : 'Coach off';
    R.coachTitle.textContent = ses.coachOn ? view.cur?.t ?? '' : 'No hints — read your gauges';
    R.coachHint.textContent = ses.coachOn ? view.hint : '';
    if (ses.coachOn) {
      const live = sim.kickActive;
      const m = live ? L.bhp - L.pform : 0;
      const pos = 50 + Math.max(-50, Math.min(50, (m / 400) * 50));
      R.mDot.style.left = pos + '%';
      R.mDot.style.background = m < 0 ? 'var(--red)' : m > 250 ? 'var(--amber)' : 'var(--green)';
      R.mText.textContent = live ? `${m >= 0 ? '+' : ''}${Math.round(m)} psi` : 'No permeable zone exposed';
      if (showSteps) renderSteps(view);
    }
    // log
    const newEv = sim.events.slice(seenEvents);
    seenEvents = sim.events.length;
    for (const e of newEv) {
      if (['info', 'killmud', 'popoff', 'gas'].includes(e.type)) toast(e.msg, e.type === 'popoff' ? 'warn' : '');
    }
    const lastVisible = [...sim.events].reverse().find((e) => !e.hidden && !e.quiet && e.type !== 'failure');
    R.lastLog.textContent = lastVisible ? `${fmtTime(lastVisible.t)}  ${lastVisible.msg}` : '';

    updateControls();
    drawWell(R.wellCanvas, sim, { kmw: sim.pits.killPit.rho ?? sim.pits.killPit.target });
    // trend target
    let target = [], extra = [];
    if (ses.coachOn && sv && sim.method === 'ww' && sim.killStart !== null) {
      const tNow = sim.t, stkNow = sim.counters.strokes, rate = (p.spm / 60) || 0.5;
      const pts = []; for (let k = -20; k <= 20; k++) { const st = stkNow + k * 30; if (st < 0) continue; pts.push({ t: tNow + (k * 30) / rate, psi: scheduleAt(sv.icp, sv.fcp, sv.stkBit, st) }); }
      target = pts.filter((x) => x.t <= tNow);
    }
    R.lgTarget.classList.toggle('hidden', !target.length);
    if (sv) extra.push({ psi: sim.pits.suction === 'kill' && sim.killStart ? sv.newMaasp : sv.maasp, color: '#f0705a' });
    R.lgMaasp.classList.toggle('hidden', !sv);
    drawTrend(R.trendCanvas, sim.samples, { window: trendWin, now: sim.t, target, extraLines: extra });

    // automatic end: well out of control
    if ((scen.mode === 'drilling' && L.pitGain > 150) || sim.flags.sheared) finish(sim.flags.sheared ? 'Pipe sheared' : 'Well control lost: pit gain over 150 bbl');
  }

  function renderSteps(view) {
    clear(R.steps).append(h('div', { class: 'lbl', style: { marginBottom: '6px' } }, 'Procedure'),
      ...view.steps.map((s, i) => h('div', { class: 's ' + (s.state === 'done' ? 'done' : s.state === 'cur' ? 'cur' : '') }, h('span', { class: 'n' }, s.state === 'done' ? '✓' : String(i + 1)), h('span', {}, s.t))));
  }

  function setState(btn, txt, cls) {
    if (!btn) return;
    btn.classList.remove('closed', 'moving', 'warn');
    if (cls) btn.classList.add(cls);
    btn.querySelector('.st').textContent = txt;
  }

  function updateControls() {
    if (tab === 'kill' && R.chokePos) {
      const id = ctrlChoke ?? (sim.activeChoke() === sim.chokes.B ? 'B' : 'A');
      const c = sim.chokes[id];
      R.chokeSel.forEach((b, i) => b.classList.toggle('sel', ['A', 'B'][i] === id));
      R.chokePos.replaceChildren(fmt(c.pos, c.pos < 10 ? 1 : 0), h('small', {}, '% open'));
      R.chokeBar.style.width = `${c.pos}%`;
      R.chokeNote.textContent = !c.iso ? `Line isolated` : (Math.abs(c.target - c.pos) > 0.3 ? `→ ${fmt(c.target, 0)}%` : (sim.hcr.open ? '' : 'HCR closed'));
      R.returns.textContent = `${fmt(sim.counters.returns, 1)} bbl`;
      const p = sim.pumps[sim.activePump];
      R.pumpSel.forEach((b, i) => b.classList.toggle('sel', i === sim.activePump));
      R.pumpSpm.replaceChildren(fmt(p.spm, 1), h('small', {}, ' spm'));
      R.pumpTgt.textContent = p.on ? `Set ${fmt(p.target)} spm` : '';
      R.pumpStatus.textContent = p.failed ? 'TRIPPED' : p.on ? 'RUNNING' : 'STOPPED';
      R.pumpStatus.style.color = p.failed ? 'var(--red)' : p.on ? 'var(--green)' : 'var(--muted)';
      R.pumpOnBtn.textContent = p.on ? 'Stop pump' : 'Start pump';
      R.pumpOnBtn.classList.toggle('danger', p.on);
    }
    if (tab === 'bop' && R.bopBtns) {
      for (const [k, b] of Object.entries(R.bopBtns)) {
        const st = sim.bop[k].state;
        setState(b, st.toUpperCase(), st === 'closed' ? 'closed' : st === 'open' ? '' : 'moving');
      }
      setState(R.hcrBtn, sim.hcr.open ? 'OPEN' : 'CLOSED', sim.hcr.open ? 'closed' : '');
      R.bopNote.textContent = sim.last.sealed ? 'Well sealed at BOP' : 'Well open to flowline';
    }
    if (tab === 'man' && R.isoBtns) {
      ['A', 'B'].forEach((id, i) => setState(R.isoBtns[i], sim.chokes[id].iso ? 'OPEN' : 'CLOSED', sim.chokes[id].iso ? 'closed' : ''));
      setState(R.hcrBtn2, sim.hcr.open ? 'OPEN' : 'CLOSED', sim.hcr.open ? 'closed' : '');
      R.sucBtns.forEach((b, i) => b.classList.toggle('sel', ['active', 'kill'][i] === sim.pits.suction));
      const kp = sim.pits.killPit;
      clear(R.killPit).append(
        kvRow('Status', kp.rho !== null ? `Ready · ${kp.rho.toFixed(1)} ppg` : kp.readyAt !== null ? `Mixing ${kp.target.toFixed(1)} ppg · ${fmtTime(kp.readyAt - sim.t).slice(3)} left` : 'Not mixed'),
        kvRow('Volume', `${fmt(kp.vol, 0)} bbl`), kvRow('Active pit', `${fmt(sim.pits.active, 1)} bbl`));
    }
    if (tab === 'rig' && R.rigInfo) {
      if (scen.mode === 'drilling') {
        R.rotBtn.textContent = sim.rotary ? 'Stop rotary' : 'Start rotary';
        R.rotBtn.classList.toggle('on', sim.rotary);
        R.pickBtn.disabled = !sim.onBottom;
        clear(R.rigInfo).append(kvRow('Bit depth', `${fmt(sim.bitDepth)} ft`), kvRow('ROP', `${fmt(sim.rop)} ft/hr`), kvRow('Rotary', `${sim.rpm} rpm`),
          kvRow('Position', sim.onBottom ? 'On bottom' : 'Off bottom · spaced out'));
      } else {
        R.tripBtn.textContent = sim.trip.pulling ? 'Stop tripping (set slips)' : 'Resume pulling';
        R.stabBtn.disabled = sim.fosvInstalled;
        R.fosvBtn.disabled = !sim.fosvInstalled;
        R.fosvBtn.textContent = sim.stringTop === 'closed' ? 'Open FOSV' : 'Close FOSV';
        R.tdBtn.disabled = !sim.fosvInstalled || !!sim.topDrive;
        const actual = -sim.last.tripTankDelta;
        clear(R.rigInfo).append(kvRow('Bit depth', `${fmt(sim.bitDepth)} ft`), kvRow('Stands pulled', fmt(sim.trip.pulled / scen.standLen, 1)),
          kvRow('Calculated fill', `${fmt(sim.trip.expectedFill, 2)} bbl`), kvRow('Actual fill (trip tank)', `${fmt(actual, 2)} bbl`),
          kvRow('Difference', `${fmt(actual - sim.trip.expectedFill, 2)} bbl`),
          kvRow('String top', { open: 'Open', 'fosv-open': 'FOSV open', closed: 'FOSV closed', connected: 'Top drive connected' }[sim.stringTop]));
      }
    }
  }
  function kvRow(k, v) { return h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v)); }

  // ---------- loop ----------
  function frame(now) {
    const dtReal = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!paused && !ended) {
      acc += dtReal * speed;
      let n = 0;
      while (acc >= sim.dt && n < 600) { sim.step(); acc -= sim.dt; n++; }
      if (n >= 600) acc = 0;
    }
    if (now - lastUi > 125) { lastUi = now; updateUI(); }
    if (!ended) raf = requestAnimationFrame(frame);
  }
  setTab('kill');
  refreshCoachVis();
  updateUI();
  raf = requestAnimationFrame(frame);
  (async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } })();
  const onVis = async () => { if (document.visibilityState === 'visible' && !ended) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ } } };
  document.addEventListener('visibilitychange', onVis);
  return () => { ended = true; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); try { wakeLock?.release(); } catch { /* ignore */ } };
}

function shortPhase(id) {
  const m = { detect: 'MONITORING', space: 'SHUT-IN', pumps: 'SHUT-IN', bop: 'SHUT-IN', hcr: 'SHUT-IN', confirm: 'SHUT-IN', record: 'SHUT-IN · RECORD', sheet: 'KILL SHEET', method: 'KILL SHEET',
    weight: 'WEIGHT UP', suction: 'LINE UP', startup: 'PUMP START-UP', tobit: 'KILL · W&W', tosurf: 'KILL · W&W', stop: 'SHUT DOWN', open: 'VERIFY',
    startup1: "DRILLER'S · START-UP", circ1: "DRILLER'S · 1ST CIRC", stop1: "DRILLER'S · CHECK", startup2: "DRILLER'S · START-UP", tobit2: "DRILLER'S · 2ND CIRC", tosurf2: "DRILLER'S · 2ND CIRC",
    stoptrip: 'SHUT-IN', stab: 'SHUT-IN', closefosv: 'SHUT-IN', topdrive: 'READ SIDPP' };
  return m[id] ?? id.toUpperCase();
}
