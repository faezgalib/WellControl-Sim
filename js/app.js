import { h, clear, fmt, fmtTime, modal } from './ui/dom.js';
import { makeScenario, FAILURES, BASE_OILS } from './core/scenario.js';
import { simScreen } from './ui/sim.js';
import { killSheetView } from './ui/killsheet-form.js';
import { drawMargin } from './ui/charts.js';
import { listSessions, getSession, deleteSession, requestPersist } from './store.js';

const appEl = document.getElementById('app');
let cleanup = null;
const SETTINGS_KEY = 'wcsim.setup';

const app = {
  go(screen, ...args) {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    window.scrollTo(0, 0);
    const fn = SCREENS[screen] ?? SCREENS.home;
    cleanup = fn(...args) || null;
    if (screen !== 'sim') history.replaceState(null, '', '#' + screen);
  },
  replaceChildren(...n) { appEl.replaceChildren(...n); },
};

function topbar(title, back = true) {
  return h('header', { class: 'topbar' },
    back ? h('button', { type: 'button', class: 'btn sm', onClick: () => app.go('home') }, '← Home') : null,
    h('div', { class: 'brand' }, 'WELL CONTROL SIM'),
    title ? h('div', { class: 'chip' }, title) : null,
    h('div', { class: 'grow' }),
    h('div', { class: 'small muted' }, navigator.onLine ? '' : 'Offline'));
}

// ---------------- Home ----------------
function home() {
  const recent = h('div', { class: 'col' });
  const page = h('div', { class: 'screen' }, topbar(null, false),
    h('main', { class: 'page' },
      h('div', { class: 'col', style: { gap: '6px' } }, h('h1', {}, 'Well control practice'), h('p', {}, 'Surface BOP · vertical well · field units. Practice detection, hard shut-in, kill sheet and the kill — then review what happened.')),
      h('div', { class: 'home-grid' },
        tile('New simulation', 'Set up a well, mud system, kick type and equipment problems. Choose the kill method after shut-in.', () => app.go('setup')),
        tile('Kill sheet trainer', 'Random well data. Fill the IWCF-style kill sheet line by line and check each answer.', () => app.go('trainer')),
        tile('Practice history', 'Review past sessions, debriefs and what to improve.', () => app.go('history')),
        tile('Quick reference', 'Formulas, hard shut-in sequences and what each equipment problem looks like on the gauges.', () => app.go('help'))),
      h('h2', { style: { marginTop: '8px' } }, 'Recent sessions'), recent));
  app.replaceChildren(page);
  listSessions().then((all) => {
    if (!all.length) { recent.append(h('p', { class: 'small muted' }, 'No sessions yet.')); return; }
    for (const s of all.slice(0, 4)) recent.append(histRow(s));
  }).catch(() => recent.append(h('p', { class: 'small muted' }, 'History not available in this browser.')));
}
function tile(t, d, on) { return h('button', { type: 'button', class: 'tile', onClick: on }, h('div', { class: 't-title' }, t), h('p', { class: 'small' }, d)); }

// ---------------- Setup ----------------
function setup() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* ignore */ }
  const o = Object.assign({ mode: 'drilling', mudType: 'WBM', owr: 80, baseOil: 'mineral', influx: 'gas', floatValve: false, failMode: 'none', failures: [], weightUpMin: 40, lineupCheck: true, coach: true }, saved);
  const page = h('div', { class: 'screen' }, topbar('New simulation'));
  const body = h('main', { class: 'page' });
  page.append(body);
  const render = () => {
    clear(body);
    const seg = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { type: 'button', class: 'btn' + (o[key] === v ? ' sel' : ''), onClick: () => { o[key] = v; render(); } }, l)));
    const card = (title, ...c) => h('section', { class: 'card col', style: { gap: '10px' } }, h('h3', {}, title), ...c);
    body.append(
      h('h1', {}, 'Set up the well'),
      h('div', { class: 'form-grid' },
        card('Operation', seg('mode', [['drilling', 'Drilling (kick on bottom)'], ['tripping', 'Tripping out (swab kick)']]),
          h('p', { class: 'small' }, o.mode === 'drilling' ? 'Full exercise: detection, hard shut-in, kill sheet, kill by the method you choose.' : 'Shut-in drill on a trip: trip tank vs trip sheet, FOSV, BOP, record pressures. Off-bottom kill comes in Phase 3.')),
        card('Mud system', seg('mudType', [['WBM', 'Water-based (WBM)'], ['OBM', 'Oil-based (OBM/SBM)']]),
          o.mudType === 'OBM' ? h('div', { class: 'col' },
            h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'owr' }, `Oil/water ratio: ${o.owr}/${100 - o.owr}`), h('input', { id: 'owr', type: 'range', min: 60, max: 95, step: 5, value: o.owr, onInput: (e) => { o.owr = +e.target.value; e.target.previousSibling.textContent = `Oil/water ratio: ${o.owr}/${100 - o.owr}`; } })),
            seg('baseOil', Object.entries(BASE_OILS).map(([k, v]) => [k, v.label])),
            h('p', { class: 'small' }, 'Gas dissolves in the base oil: small pit gain, no migration while shut in, sudden breakout near surface.')) : h('p', { class: 'small' }, 'Free gas: pit gain shows the full influx, gas migrates when shut in and expands steadily when circulated.')),
        card('Influx', seg('influx', [['gas', 'Gas'], ['water', 'Salt water']]),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.floatValve || null, onChange: (e) => o.floatValve = e.target.checked }), 'Float valve in the string (SIDPP reads zero until bumped)')),
        card('Equipment problems during the kill',
          seg('failMode', [['none', 'None'], ['pick', 'Choose'], ['random', 'Random (hidden)']]),
          o.failMode === 'pick' ? h('div', { class: 'col' }, Object.entries(FAILURES).filter(([k]) => o.mode === 'drilling' || k === 'annularLeak').map(([k, v]) =>
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.failures.includes(k) || null, onChange: (e) => { o.failures = e.target.checked ? [...new Set([...o.failures, k])] : o.failures.filter((x) => x !== k); } }), v.label))) : null,
          h('p', { class: 'small' }, 'Problems start at a random point during the kill. You are not told when — read the gauges.')),
        card('Options',
          h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'wu' }, 'Kill mud mixing time (min)'), h('input', { id: 'wu', type: 'number', min: 5, max: 180, value: o.weightUpMin, onInput: (e) => o.weightUpMin = +e.target.value })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.lineupCheck || null, onChange: (e) => o.lineupCheck = e.target.checked }), 'Line-up check (choke manifold may start wrongly lined up)'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.coach || null, onChange: (e) => o.coach = e.target.checked }), 'Start with coach on (steps, targets, BHP indicator)'))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', class: 'btn primary', style: { minWidth: '220px' }, onClick: start }, 'Start simulation')));
  };
  function start() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch { /* ignore */ }
    const failures = o.failMode === 'pick' ? o.failures.filter((f) => o.mode === 'drilling' || f === 'annularLeak') : [];
    const scen = makeScenario({ mode: o.mode, mudType: o.mudType, owr: o.owr, baseOil: o.baseOil, influx: o.influx, floatValve: o.floatValve,
      failures, randomFailure: o.failMode === 'random', weightUpMin: o.weightUpMin, lineupCheck: o.lineupCheck });
    briefing(scen, o);
  }
  render();
  app.replaceChildren(page);
}

function briefing(scen, o) {
  const w = scen.well;
  const m = modal([
    h('h2', {}, scen.mode === 'drilling' ? 'Handover: drilling ahead' : 'Handover: pulling out of hole'),
    h('div', { class: 'grid2' },
      kvb('Well TD (TVD)', `${fmt(w.td)} ft`), kvb('Casing shoe', `${fmt(w.shoe.depth)} ft`),
      kvb('Hole', `${w.hole}"`), kvb('Mud', `${scen.mud.type} ${scen.mud.rho.toFixed(1)} ppg`),
      kvb('Pump output', `${scen.pumpOutput} bbl/stk`), kvb('SCR', scen.scr.map((s) => `${s.psi} psi @ ${s.spm}`).join(' · ')),
      kvb('LOT', `${fmt(scen.lot.psi)} psi with ${scen.lot.testMw.toFixed(1)} ppg`), kvb('Active pit', `${fmt(scen.activePit)} bbl`)),
    h('p', { class: 'small' }, scen.mode === 'drilling'
      ? `Drilling at ${scen.drillSpm} spm. Hard shut-in policy. ${scen.lineupCheck ? 'Check the choke manifold line-up before anything happens.' : ''}`
      : `Pulling out. ${scen.standLen} ft stands. Pipe displacement 0.0075 bbl/ft. Trip tank lined up to the hole. ${scen.lineupCheck ? 'Check the choke manifold line-up.' : ''}`),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Back'),
      h('button', { type: 'button', class: 'btn primary', onClick: () => { m.close(); requestPersist(); app.go('sim', scen, o); } }, 'Take over the shift')),
  ]);
}
function kvb(k, v) { return h('div', { class: 'card', style: { padding: '8px 12px' } }, h('div', { class: 'lbl' }, k), h('div', { class: 'mono', style: { marginTop: '4px' } }, v)); }

// ---------------- Debrief ----------------
function debrief(id, rec = null) {
  const page = h('div', { class: 'screen' }, topbar('Debrief'));
  const body = h('main', { class: 'page' });
  page.append(body);
  app.replaceChildren(page);
  const show = (r) => {
    if (!r) { body.append(h('p', {}, 'Session not found.')); return; }
    const oc = r.outcome;
    const canvas = h('canvas', { style: { width: '100%', height: '220px' }, role: 'img', 'aria-label': 'BHP minus formation pressure over time' });
    body.append(
      h('div', { class: 'outcome ' + oc.k }, h('div', { class: 'grow' }, h('h1', {}, oc.t), h('p', {}, oc.d)),
        h('div', { class: 'col', style: { alignItems: 'flex-end' } }, h('div', { class: 'small muted' }, new Date(r.date).toLocaleString()), h('div', { class: 'small muted' }, `${r.scen.mode} · ${r.scen.mud.type} · ${r.method ? (r.method === 'ww' ? 'Wait & Weight' : "Driller's") : 'no method'}`))),
      h('div', { class: 'stats' },
        stat('Session time', fmtTime(r.stats.duration)), stat('Total influx', `${fmt(r.stats.influx, 1)} bbl`),
        stat('Secondary influx', `${fmt(r.stats.secondary, 1)} bbl`), stat('Losses', `${fmt(r.stats.losses, 1)} bbl`),
        stat('Max casing pressure', `${fmt(r.stats.maxCp)} psi`), stat('Initial MAASP (true)', `${fmt(r.stats.maasp)} psi`)),
      h('section', { class: 'card col' }, h('h3', {}, 'BHP minus formation pressure'), h('p', { class: 'small' }, 'Above zero = overbalanced. Red zone = underbalanced (influx). Dashed lines = equipment problems and key events.'), canvas),
      h('h2', {}, 'What happened'),
      ...r.findings.map((f) => h('div', { class: 'finding ' + f.sev },
        h('div', { class: 'tm' }, f.t === null || f.t === undefined ? '' : fmtTime(f.t).slice(0, 5)),
        h('div', {}, h('div', { class: 'sev' }, { critical: 'Critical', warning: 'Watch', good: 'Good', info: 'Note' }[f.sev]), h('div', { class: 't' }, f.title),
          h('div', { class: 'd' }, f.what), f.action ? h('div', { class: 'd', style: { marginTop: '6px' } }, h('b', {}, 'Correct action: '), f.action) : null))),
      h('details', { class: 'card' }, h('summary', { style: { cursor: 'pointer', minHeight: '32px' } }, 'Full event log'),
        h('div', { class: 'col', style: { gap: '2px', marginTop: '8px' } }, (r.events || []).map((e) => h('div', { class: 'small mono' }, `${fmtTime(e.t)}  ${e.msg}`)))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', class: 'btn', onClick: () => app.go('history') }, 'History'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => app.go('setup') }, 'New simulation')));
    const markers = (r.events || []).filter((e) => ['failure', 'killstart', 'gas', 'record'].includes(e.type)).map((e) => ({ t: e.t, color: e.type === 'failure' ? '#f0705a' : '#566070' }));
    const kick = (r.events || []).find((e) => e.type === 'kick');
    const from = r.scen.mode === 'drilling' && kick ? kick.t : 0;
    requestAnimationFrame(() => drawMargin(canvas, (r.samples || []).filter((x) => x.t >= from), markers));
  };
  if (rec) show(rec); else getSession(id).then(show).catch(() => show(null));
}
function stat(k, v) { return h('div', { class: 'card stat' }, h('div', { class: 'lbl' }, k), h('div', { class: 'v' }, v)); }

// ---------------- History ----------------
function historyScreen() {
  const list = h('div', { class: 'col' });
  const page = h('div', { class: 'screen' }, topbar('History'), h('main', { class: 'page' }, h('h1', {}, 'Practice history'),
    h('p', { class: 'small' }, 'Stored on this tablet only. Clearing browser data removes it.'), list));
  app.replaceChildren(page);
  const load = () => listSessions().then((all) => {
    clear(list);
    if (!all.length) { list.append(h('p', { class: 'muted' }, 'No sessions yet.')); return; }
    // pattern summary across sessions
    const counts = {};
    for (const s of all) for (const f of s.findings || []) if (f.sev === 'critical' || f.sev === 'warning') counts[f.title.replace(/[0-9.,]+/g, '#')] = (counts[f.title.replace(/[0-9.,]+/g, '#')] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length) list.append(h('section', { class: 'card col' }, h('h3', {}, 'Recurring issues'), top.map(([t, n]) => h('div', { class: 'kv' }, h('span', {}, t.replace(/#/g, 'n')), h('b', {}, `${n}×`)))));
    for (const s of all) list.append(histRow(s, async () => { await deleteSession(s.id); load(); }));
  });
  load();
}
function histRow(s, onDelete = null) {
  const b = { ok: 'ok', bad: 'bad', mid: 'mid' }[s.outcome?.k] ?? 'mid';
  return h('div', { class: 'row' },
    h('button', { type: 'button', class: 'histrow', onClick: () => app.go('debrief', s.id) },
      h('div', { class: 'small muted' }, new Date(s.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
      h('div', {}, h('div', { style: { fontWeight: 600 } }, `${s.scen.mode === 'drilling' ? 'Drilling' : 'Tripping'} · ${s.scen.mud.type} · ${s.scen.influx} kick`),
        h('div', { class: 'small muted' }, `${s.method ? (s.method === 'ww' ? 'Wait & Weight' : "Driller's") : 'No method'} · ${(s.findings || []).filter((f) => f.sev === 'critical').length} critical · ${(s.findings || []).filter((f) => f.sev === 'warning').length} to watch`)),
      h('span', { class: 'badge ' + b }, s.outcome?.t ?? '—'),
      h('div', { class: 'small mono muted' }, fmtTime(s.stats?.duration ?? 0))),
    onDelete ? h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Delete session', onClick: () => { if (confirm('Delete this session?')) onDelete(); } }, '✕') : null);
}

// ---------------- Kill sheet trainer ----------------
function trainer() {
  const page = h('div', { class: 'screen' }, topbar('Kill sheet trainer'));
  const body = h('main', { class: 'page', style: { maxWidth: '1280px' } });
  page.append(body);
  app.replaceChildren(page);
  const newWell = () => {
    const scen = makeScenario({ lineupCheck: false });
    const r = Math.random;
    const sidpp = Math.round((250 + r() * 500) / 10) * 10;
    const gain = Math.round((6 + r() * 18) * 10) / 10;
    const sicp = Math.round(sidpp + 80 + gain * (8 + r() * 6));
    const state = { entries: {}, kick: { sidpp: String(sidpp), sicp: String(sicp), gain: String(gain) }, scrIndex: 0 };
    clear(body).append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Kill sheet trainer'), h('span', { class: 'small muted' }, 'Surface BOP · vertical well')),
      killSheetView(scen, state, { mode: 'trainer', onNewWell: newWell }));
  };
  newWell();
}

// ---------------- Reference ----------------
function help() {
  const sec = (t, ...rows) => h('section', { class: 'card col' }, h('h3', {}, t), ...rows);
  const li = (t) => h('div', { class: 'kv', style: { justifyContent: 'flex-start', gap: '10px' } }, h('span', {}, '•'), h('span', {}, t));
  const page = h('div', { class: 'screen' }, topbar('Quick reference'), h('main', { class: 'page' },
    h('h1', {}, 'Quick reference'),
    h('div', { class: 'form-grid' },
      sec('Kill sheet formulas',
        li('Hydrostatic (psi) = ppg × 0.052 × TVD'), li('Formation pressure = SIDPP + OMW × 0.052 × TVD'),
        li('KMW = OMW + SIDPP ÷ (0.052 × TVD), round up to 0.1'), li('ICP = SCR + SIDPP'), li('FCP = SCR × KMW ÷ OMW'),
        li('Max. allowable mud = LOT mud + LOT pressure ÷ (0.052 × shoe TVD), round down'),
        li('MAASP = (Max. allowable mud − current mud) × 0.052 × shoe TVD'), li('Strokes = volume ÷ pump output'),
        li('Capacity bbl/ft = ID² ÷ 1029.4 · Annular = (OD_hole² − OD_pipe²) ÷ 1029.4')),
      sec('Hard shut-in while drilling',
        li('Stop rotation'), li('Pick up off bottom — space out (no tool joint across the rams)'), li('Stop the pumps, flow check'),
        li('Close the annular or upper pipe ram (choke already closed)'), li('Open the HCR'), li('Confirm shut-in: flowline, pits, panel'),
        li('Record SIDPP, SICP, pit gain when stabilised')),
      sec('Hard shut-in while tripping',
        li('Stop tripping, set slips at working height'), li('Stab the FOSV in the OPEN position'), li('Close the FOSV'),
        li('Close the annular or upper pipe ram'), li('Open the HCR'), li('Confirm shut-in, record SICP and gain'), li('Make up top drive, open FOSV, read SIDPP')),
      sec('Reading the gauges during a kill',
        li('DP ↑ sharply, CP steady → nozzle plugged. Do not open the choke.'), li('DP ↓ slowly, CP steady → string washout. Do not close the choke.'),
        li('DP ↑ and CP ↑ together → choke plugging. Switch chokes.'), li('DP ↓ and CP ↓ together, choke keeps closing → choke washout.'),
        li('DP ↓ and CP ↓, strokes dropping → pump failure. Hold CP, switch pump.'), li('Pit gain rising fast near bottoms-up in OBM → gas breakout.')),
      sec('Pump start-up and shut-down',
        li('Hold CASING pressure constant while changing pump speed'), li('Open the choke as the pump speeds up, close it as the pump slows'),
        li('Read drill pipe pressure only once at kill rate'), li('Allow for the pressure delay: about 1 second per 1,000 ft each way')),
      sec('About this simulator',
        h('p', { class: 'small' }, 'Single-phase liquid with ideal-gas influx (Z = 1), gas migration, OBM gas solubility with breakout, choke and pump dynamics, and a pressure delay to the standpipe. It is a training aid — numbers follow field rules of thumb, not a specific rig. Rounding: KMW up, max. mud density down, MAASP down. Confirm conventions with your course.')))));
  app.replaceChildren(page);
}

const SCREENS = {
  home, setup, history: historyScreen, trainer, help,
  debrief: (id, rec) => debrief(id, rec),
  sim: (scen, o) => simScreen(app, scen, { coach: o?.coach ?? true }),
};

const ROUTES = ['home', 'setup', 'history', 'trainer', 'help'];
const route = () => { const r = (location.hash || '#home').slice(1); return ROUTES.includes(r) ? r : 'home'; };
app.go(route());
window.addEventListener('hashchange', () => { if (!document.querySelector('.sim')) app.go(route()); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache unavailable */ }));
}
