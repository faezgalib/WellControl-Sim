import { h, svg, clear, fmt, fmtTime, modal, toast } from './ui/dom.js';
import { makeScenario, FAILURES, BASE_OILS } from './core/scenario.js';
import { simScreen } from './ui/sim.js';
import { killSheetView } from './ui/killsheet-form.js';
import { drawMargin } from './ui/charts.js';
import { listSessions, getSession, deleteSession, requestPersist, getAllSessions, importSessions, clearSessions, storageEstimate } from './store.js';
import { APP_VERSION, RELEASE_DATE, RELEASE_NOTES } from './version.js';
import { DISCLAIMER_TITLE, DISCLAIMER } from './disclaimer.js';

const appEl = document.getElementById('app');
let cleanup = null;
const SETTINGS_KEY = 'wcsim.setup';
const PREFS_KEY = 'wcsim.prefs';

const app = {
  go(screen, ...args) {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    window.scrollTo(0, 0);
    const fn = SCREENS[screen] ?? SCREENS.home;
    cleanup = fn(...args) || null;
    if (screen !== 'sim' && screen !== 'debrief') history.replaceState(null, '', '#' + screen);
  },
  replaceChildren(...n) { appEl.replaceChildren(...n); },
};

// ---------------- preferences (this device only) ----------------
function loadJSON(key, def) { try { return Object.assign(def, JSON.parse(localStorage.getItem(key) || '{}')); } catch { return def; } }
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }
const prefs = () => loadJSON(PREFS_KEY, { units: 'field', courseDate: '', lastBackup: null, lastCheck: null });
const setPrefs = (p) => saveJSON(PREFS_KEY, { ...prefs(), ...p });

// ---------------- shared chrome ----------------
const ICONS = {
  home: 'M3 11l9-7 9 7v9H3z',
  setup: 'M4 18A9 9 0 1 1 20 18M12 13l4-5',
  trainer: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h3',
  history: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  play: 'M7 4l12 8-12 8z',
  units: 'M3 7h18M3 12h12M3 17h7',
  backup: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  update: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5',
  drill: 'M12 2v14M8 16h8l-4 6z',
  trip: 'M12 22V6M8 10l4-4 4 4M6 2h12',
  drop: 'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z',
  dropOil: 'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11zM10 14h.01M14 16h.01',
};
function icon(name, size = 22, color = 'currentColor', width = 2) {
  return svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, 'stroke-width': name === 'more' ? 3.2 : width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d: ICONS[name] }));
}
export function logo(size = 40) {
  return svg('svg', { width: size, height: size, viewBox: '0 0 40 40', 'aria-hidden': 'true' },
    svg('rect', { x: 0.5, y: 0.5, width: 39, height: 39, rx: 10, fill: '#1d2127', stroke: '#333944' }),
    svg('path', { d: 'M10 29 A12 12 0 1 1 30 29', fill: 'none', stroke: '#2a3038', 'stroke-width': 3.5, 'stroke-linecap': 'round' }),
    svg('path', { d: 'M10 29 A12 12 0 0 1 27 12', fill: 'none', stroke: '#f2a93b', 'stroke-width': 3.5, 'stroke-linecap': 'round' }),
    svg('path', { d: 'M20 10 L15.5 30 M20 10 L24.5 30 M16.8 24 H23.2 M17.9 18 H22.1', stroke: '#e8eaed', 'stroke-width': 1.6, fill: 'none' }));
}
const TABS = [['home', 'Home'], ['setup', 'Simulate'], ['trainer', 'Kill sheet'], ['history', 'History'], ['more', 'More']];
function tabbar(active) {
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' }, TABS.map(([k, l]) =>
    h('button', { type: 'button', class: 'tab' + (k === active ? ' sel' : ''), 'aria-current': k === active ? 'page' : null, onClick: () => app.go(k) }, icon(k), l)));
}
function brandHeader(right = null) {
  return h('header', { class: 'brandbar' }, logo(40),
    h('div', { class: 'brand' }, 'WELL CONTROL SIM'),
    h('div', { class: 'grow' }), right,
    h('div', { class: 'netchip' + (navigator.onLine ? ' on' : ''), title: navigator.onLine ? 'Online · offline ready' : 'Offline' }, h('span', { class: 'dotc' }), h('span', { class: 'netlbl' }, navigator.onLine ? 'Online · offline ready' : 'Offline')),
    h('div', { class: 'mono small muted' }, `v${APP_VERSION}`));
}
/** Standard screen: brand header, scrolling content, tab bar. */
function shell(active, ...content) {
  const main = h('main', { class: 'shell-main' }, ...content);
  appEl.replaceChildren(h('div', { class: 'shell' }, brandHeader(), main, tabbar(active)));
  return main;
}

// ---------------- Home ----------------
function rigSilhouette() {
  const g = (attrs, ...c) => svg('g', attrs, ...c);
  return svg('svg', { class: 'rig', viewBox: '0 0 520 560', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMax meet' },
    svg('line', { x1: 0, y1: 470, x2: 520, y2: 470, stroke: '#1f242b', 'stroke-width': 2 }),
    svg('line', { x1: 0, y1: 490, x2: 520, y2: 490, stroke: '#181c21', 'stroke-width': 2 }),
    svg('line', { x1: 0, y1: 510, x2: 520, y2: 510, stroke: '#15181c', 'stroke-width': 2 }),
    g({ fill: 'none', stroke: '#252a32', 'stroke-width': 2 },
      svg('rect', { x: 58, y: 40, width: 16, height: 500 }), svg('rect', { x: 438, y: 40, width: 16, height: 500 }), svg('rect', { x: 248, y: 60, width: 16, height: 480 }),
      svg('path', { d: 'M58 80 L74 110 M58 140 L74 170 M58 200 L74 230 M58 260 L74 290 M58 400 L74 430 M58 460 L74 490 M438 80 L454 110 M438 140 L454 170 M438 200 L454 230 M438 260 L454 290 M438 400 L454 430 M438 460 L454 490' })),
    svg('polygon', { points: '30,330 490,330 470,384 50,384', fill: '#171b20', stroke: '#262b33', 'stroke-width': 2 }),
    svg('rect', { x: 70, y: 300, width: 120, height: 10, fill: '#1c2026', stroke: '#262b33' }),
    svg('rect', { x: 320, y: 300, width: 130, height: 30, fill: '#1a1e24', stroke: '#262b33' }),
    g({ fill: 'none', stroke: '#2c323b', 'stroke-width': 2 },
      svg('path', { d: 'M340 300 L372 96 L404 300 M346 262 H398 M352 222 H392 M358 182 H386 M364 142 H380 M346 262 L392 222 M398 262 L352 222 M352 222 L386 182 M392 222 L358 182 M358 182 L380 142 M386 182 L364 142' })),
    svg('circle', { class: 'crown', cx: 372, cy: 92, r: 4, fill: '#f2a93b' }),
    svg('circle', { class: 'crown-halo', cx: 372, cy: 92, r: 11, fill: 'none', stroke: '#f2a93b', 'stroke-opacity': 0.25 }),
    svg('rect', { x: 96, y: 352, width: 10, height: 6, fill: '#f2a93b', 'fill-opacity': 0.5 }),
    svg('rect', { x: 118, y: 352, width: 10, height: 6, fill: '#f2a93b', 'fill-opacity': 0.35 }),
    svg('rect', { x: 230, y: 352, width: 10, height: 6, fill: '#f2a93b', 'fill-opacity': 0.45 }));
}
function daysTo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}
function recurring(all) {
  const counts = {};
  for (const s of all) for (const f of s.findings || []) if (f.sev === 'critical' || f.sev === 'warning') {
    const k = String(f.title).replace(/[0-9.,]+/g, 'n');
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
function home() {
  const p = prefs();
  const days = daysTo(p.courseDate);
  const stats = h('div', { class: 'home-stats' });
  const last = h('div', {});
  const main = shell('home', h('div', { class: 'home' },
    h('div', { class: 'home-left' },
      days !== null && days >= 0 ? h('div', { class: 'countchip' }, `Course · ${new Date(p.courseDate + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })} · `, h('span', { class: 'mono' }, days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`), days === 0 ? '' : ' to go') : null,
      h('h1', { class: 'hero' }, 'Take the shift.', h('br'), 'Read the gauges.', h('br'), h('span', { class: 'amber' }, 'Kill the well.')),
      h('p', { class: 'lead' }, 'Surface BOP, vertical well. Detect the kick, hard shut-in, complete the kill sheet and circulate it out — then see exactly where it went right or wrong.'),
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'btn primary xl', onClick: () => app.go('setup') }, icon('play', 18, '#111', 2.4), 'New simulation'),
        h('button', { type: 'button', class: 'btn xl', onClick: () => app.go('trainer') }, 'Kill sheet trainer')),
      stats, last),
    h('div', { class: 'home-right' }, rigSilhouette())));
  void main;
  listSessions().then(async (all) => {
    const gains = all.map((s) => s.stats?.gainAtSeal).filter((x) => Number.isFinite(x));
    const rec = recurring(all);
    const card = (k, v, extra = {}) => h('div', { class: 'card stat' }, h('div', { class: 'lbl' }, k), h('div', { class: 'v', ...extra }, v));
    stats.append(
      card('Sessions', fmt(all.length)),
      card('Wells killed', fmt(all.filter((s) => s.outcome?.t === 'Well killed').length), { style: { color: 'var(--green)' } }),
      card('Avg gain at shut-in', gains.length ? h('span', {}, fmt(gains.reduce((a, b) => a + b, 0) / gains.length, 1), h('small', {}, ' bbl')) : '—'),
      h('div', { class: 'card stat' }, h('div', { class: 'lbl' }, 'Work on'), h('div', { class: 'workon' }, rec.length ? rec[0][0] : all.length ? 'Nothing recurring' : 'Start a session')));
    if (!all.length) return;
    const s0 = all[0];
    const full = await getSession(s0.id).catch(() => null);
    const spark = sparkline(full);
    const b = { ok: 'ok', bad: 'bad', mid: 'mid' }[s0.outcome?.k] ?? 'mid';
    last.append(h('div', { class: 'card lastsess' },
      h('div', { class: 'col', style: { gap: '4px', width: '250px', flex: '0 0 250px' } },
        h('div', { class: 'lbl' }, 'Last session'),
        h('div', { style: { fontWeight: 600 } }, `${s0.method ? (s0.method === 'ww' ? 'Wait & Weight' : "Driller's") : s0.scen.mode === 'tripping' ? 'Tripping' : 'No kill'} · ${s0.scen.mud.type} · ${s0.scen.influx === 'gas' ? 'Gas' : 'Water'}`),
        h('div', { class: 'row' }, h('span', { class: 'badge ' + b }, s0.outcome?.t ?? '—'), h('span', { class: 'mono small muted' }, fmtTime(s0.stats?.duration ?? 0)))),
      spark,
      h('button', { type: 'button', class: 'btn', onClick: () => app.go('debrief', s0.id) }, 'Debrief')));
  }).catch(() => stats.append(h('p', { class: 'small muted' }, 'History is not available in this browser.')));
}
function sparkline(rec) {
  const box = svg('svg', { viewBox: '0 0 400 60', class: 'spark', role: 'img', 'aria-label': 'BHP margin over the last session' });
  const S = rec?.samples || [];
  if (S.length < 2) return box;
  const kick = (rec.events || []).find((e) => e.type === 'kick');
  const vis = S.filter((x) => x.t >= (kick ? kick.t : 0));
  if (vis.length < 2) return box;
  const m = vis.map((x) => x.bhp - x.pform);
  const lo = Math.min(-100, ...m), hi = Math.max(200, ...m);
  const t0 = vis[0].t, t1 = vis[vis.length - 1].t;
  const step = Math.max(1, Math.floor(vis.length / 200));
  const pts = vis.filter((_, i) => i % step === 0).map((x) => `${(((x.t - t0) / Math.max(1, t1 - t0)) * 400).toFixed(1)},${(56 - ((x.bhp - x.pform - lo) / (hi - lo)) * 52).toFixed(1)}`).join(' ');
  const y0 = 56 - ((0 - lo) / (hi - lo)) * 52;
  box.append(svg('line', { x1: 0, y1: y0, x2: 400, y2: y0, stroke: '#333944', 'stroke-dasharray': '3 4' }),
    svg('polyline', { points: pts, fill: 'none', stroke: '#7ee0a8', 'stroke-width': 2.5 }));
  return box;
}

// ---------------- New simulation ----------------
const PRESETS = {
  guided: { label: 'Guided', d: 'Coach on, line-up check on, no equipment problems.', set: { coach: true, lineupCheck: true, failMode: 'none' } },
  exam: { label: 'Exam-like', d: 'Coach off. One hidden equipment problem during the kill.', set: { coach: false, lineupCheck: true, failMode: 'random' } },
  hard: { label: 'Hard', d: 'OBM, float valve, line-up check, hidden problem, coach off.', set: { coach: false, lineupCheck: true, failMode: 'random', mudType: 'OBM', floatValve: true } },
  custom: { label: 'Custom', d: 'Your own combination. Any change below switches to Custom.', set: {} },
};
function setup() {
  const o = loadJSON(SETTINGS_KEY, { preset: 'guided', mode: 'drilling', mudType: 'WBM', owr: 80, baseOil: 'mineral', influx: 'gas', floatValve: false, failMode: 'none', failures: [], weightUpMin: 40, lineupCheck: true, coach: true });
  const body = h('div', { class: 'setup' });
  shell('setup', body);
  const change = (patch) => { Object.assign(o, patch, { preset: 'custom' }); render(); };
  const applyPreset = (k) => { Object.assign(o, PRESETS[k].set, { preset: k }); render(); };
  const opt = (sel, ic, t, d, on) => h('button', { type: 'button', class: 'opt' + (sel ? ' sel' : ''), 'aria-pressed': sel ? 'true' : 'false', onClick: on },
    h('span', { class: 'ic' }, icon(ic, 22, sel ? '#f2a93b' : '#9aa3ae')), h('span', {}, h('div', { class: 't' }, t), h('div', { class: 'd' }, d)));
  const pills = (key, items, onPick = null) => h('div', { class: 'pills', role: 'group' }, items.map(([v, l]) =>
    h('button', { type: 'button', class: 'pill' + (o[key] === v ? ' sel' : ''), 'aria-pressed': o[key] === v ? 'true' : 'false', onClick: () => (onPick ? onPick(v) : change({ [key]: v })) }, l)));
  const step = (n, t, ...c) => h('section', { class: 'col', style: { gap: '10px' } }, h('div', { class: 'row' }, h('span', { class: 'mono stepn' }, n), h('div', { class: 'lbl', style: { color: 'var(--text)' } }, t)), ...c);

  function render() {
    clear(body);
    const left = h('div', { class: 'setup-left' },
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
        h('h1', { class: 'grow' }, 'New simulation'),
        h('div', { class: 'pills', role: 'group', 'aria-label': 'Preset' }, Object.entries(PRESETS).map(([k, p]) =>
          h('button', { type: 'button', class: 'pill' + (o.preset === k ? ' sel' : ''), 'aria-pressed': o.preset === k ? 'true' : 'false', onClick: () => applyPreset(k) }, p.label)))),
      step('01', 'Operation', h('div', { class: 'grid2' },
        opt(o.mode === 'drilling', 'drill', 'Drilling — kick on bottom', 'Detection, hard shut-in, kill sheet, full kill.', () => change({ mode: 'drilling' })),
        opt(o.mode === 'tripping', 'trip', 'Tripping out — swab kick', 'Trip tank vs trip sheet, FOSV, shut-in.', () => change({ mode: 'tripping' })))),
      step('02', 'Mud system', h('div', { class: 'grid2' },
        opt(o.mudType === 'WBM', 'drop', 'Water-based (WBM)', 'Free gas: migration when shut in, steady expansion.', () => change({ mudType: 'WBM' })),
        opt(o.mudType === 'OBM', 'dropOil', 'Oil-based (OBM/SBM)', 'Gas in solution: small gain, breakout near surface.', () => change({ mudType: 'OBM' }))),
        o.mudType === 'OBM' ? h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } },
          h('label', { class: 'small', for: 'owr' }, 'OWR'),
          h('input', { id: 'owr', type: 'range', min: 60, max: 95, step: 5, value: o.owr, style: { width: '220px', accentColor: '#f2a93b' }, onInput: (e) => { o.owr = +e.target.value; o.preset = 'custom'; owrOut.textContent = `${o.owr}/${100 - o.owr}`; } }),
          h('span', { class: 'mono small', ref: (el) => { owrOut = el; } }, `${o.owr}/${100 - o.owr}`),
          pills('baseOil', Object.entries(BASE_OILS).map(([k, v]) => [k, v.label.replace(' (olefin)', '')]))) : null),
      h('div', { class: 'grid2', style: { gap: '18px' } },
        step('03', 'Influx', pills('influx', [['gas', 'Gas'], ['water', 'Salt water']]),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.floatValve || null, onChange: (e) => change({ floatValve: e.target.checked }) }), 'Float valve in the string')),
        step('04', 'Equipment problems', pills('failMode', [['none', 'None'], ['pick', 'Choose'], ['random', 'Random (hidden)']]),
          o.failMode === 'pick' ? h('div', { class: 'col', style: { gap: '0' } }, Object.entries(FAILURES).filter(([k]) => o.mode === 'drilling' || k === 'annularLeak').map(([k, v]) =>
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.failures.includes(k) || null, onChange: (e) => change({ failures: e.target.checked ? [...new Set([...o.failures, k])] : o.failures.filter((x) => x !== k) }) }), v.label)))
            : h('div', { class: 'small muted' }, o.failMode === 'random' ? 'Starts at a random point during the kill. You are not told when.' : 'No equipment problems.'))),
      step('05', 'Options', h('div', { class: 'row', style: { gap: '18px', flexWrap: 'wrap' } },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.coach || null, onChange: (e) => change({ coach: e.target.checked }) }), 'Coach on'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.lineupCheck || null, onChange: (e) => change({ lineupCheck: e.target.checked }) }), 'Line-up check'),
        h('span', { class: 'small' }, 'Kill mud mixing'),
        pills('weightUpMin', [[20, '20 min'], [40, '40 min'], [60, '60 min']]))));
    const failTxt = o.failMode === 'none' ? 'None' : o.failMode === 'random' ? 'Hidden' : `${o.failures.length} chosen`;
    const kv = (k, v, color) => h('div', { class: 'kv' }, h('span', {}, k), h('b', { style: color ? { color } : null }, v));
    const right = h('aside', { class: 'card handover' },
      h('div', { class: 'lbl' }, 'Handover'),
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '16px' } },
        wellPreview(o),
        h('div', { class: 'col grow', style: { gap: '2px' } },
          kv('Operation', o.mode === 'drilling' ? 'Drilling' : 'Tripping'), kv('Mud', o.mudType), kv('Kick', o.influx === 'gas' ? 'Gas' : 'Salt water'),
          kv('Float valve', o.floatValve ? 'Yes' : 'No'), kv('Problems', failTxt), kv('Coach', o.coach ? 'On' : 'Off', o.coach ? 'var(--teal)' : null),
          kv('Line-up check', o.lineupCheck ? 'On' : 'Off'), kv('Mixing time', `${o.weightUpMin} min`))),
      h('div', { class: 'note' }, PRESETS[o.preset]?.d ?? ''),
      h('div', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn primary xl', style: { width: '100%' }, onClick: start }, 'Take over the shift →'));
    body.append(left, right);
  }
  let owrOut = null;
  function start() {
    saveJSON(SETTINGS_KEY, o);
    const failures = o.failMode === 'pick' ? o.failures.filter((f) => o.mode === 'drilling' || f === 'annularLeak') : [];
    const scen = makeScenario({ mode: o.mode, mudType: o.mudType, owr: o.owr, baseOil: o.baseOil, influx: o.influx, floatValve: o.floatValve,
      failures, randomFailure: o.failMode === 'random', weightUpMin: o.weightUpMin, lineupCheck: o.lineupCheck });
    briefing(scen, o);
  }
  render();
}
function wellPreview(o) {
  const mud = o.mudType === 'OBM' ? '#2c2a40' : '#252a32';
  return svg('svg', { width: 70, height: 230, viewBox: '0 0 70 230', role: 'img', 'aria-label': `Well preview: ${o.mudType}, ${o.influx} kick zone at the bottom${o.floatValve ? ', float valve near the bit' : ''}` },
    svg('rect', { x: 15, y: 0, width: 40, height: 228, rx: 4, fill: '#1d2127' }),
    svg('rect', { x: 15, y: 0, width: 40, height: 214, fill: mud }),
    svg('path', { d: 'M13 0 V136 H7 M57 0 V136 H63', stroke: '#c3c9d1', 'stroke-width': 2, fill: 'none' }),
    svg('rect', { x: 30, y: 0, width: 10, height: o.mode === 'tripping' ? 170 : 210, fill: '#3a4250' }),
    o.floatValve ? svg('rect', { x: 31, y: o.mode === 'tripping' ? 158 : 198, width: 8, height: 6, fill: '#f2a93b' }) : null,
    svg('rect', { x: 15, y: 214, width: 40, height: 14, fill: o.influx === 'gas' ? (o.mudType === 'OBM' ? '#a99cff' : '#5ab0f0') : '#4fd1c5', 'fill-opacity': 0.65 }));
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

// ---------------- More ----------------
function more() {
  const p = prefs();
  const sec = (ic, title, ...c) => h('section', { class: 'card more-sec' }, h('div', { class: 'row' }, icon(ic, 20, '#f2a93b'), h('h2', {}, title)), ...c);
  const row = (...c) => h('div', { class: 'mrow' }, ...c);

  // units
  const unitPills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Unit system' },
    h('button', { type: 'button', class: 'pill sel', 'aria-pressed': 'true' }, 'Field (API)'),
    h('button', { type: 'button', class: 'pill', 'aria-pressed': 'false', onClick: () => { unitNote.textContent = 'Metric units are coming soon. The app stays on field units for now.'; unitNote.classList.add('warnnote'); toast('Metric units: coming soon'); } }, 'Metric'));
  const unitNote = h('div', { class: 'small muted' }, 'Metric (bar · SG or kg/m³ · m³ · m) is coming soon.');
  const units = sec('units', 'Units',
    row(h('span', { class: 'grow' }, 'Unit system'), unitPills),
    row(h('span', { class: 'grow muted' }, 'Pressure'), h('span', { class: 'mono' }, 'psi')),
    row(h('span', { class: 'grow muted' }, 'Mud density'), h('span', { class: 'mono' }, 'ppg')),
    row(h('span', { class: 'grow muted' }, 'Volume'), h('span', { class: 'mono' }, 'bbl')),
    row(h('span', { class: 'grow muted' }, 'Depth'), h('span', { class: 'mono' }, 'ft')),
    unitNote);

  // course date
  const course = sec('history', 'Course date',
    row(h('label', { class: 'grow', for: 'cdate' }, 'Show a countdown on Home (optional)'),
      h('input', { id: 'cdate', type: 'date', value: p.courseDate || '', style: { width: '180px' }, onChange: (e) => { setPrefs({ courseDate: e.target.value }); toast(e.target.value ? 'Countdown set' : 'Countdown removed'); } })),
    h('div', { class: 'small muted' }, 'Stored on this tablet only.'));

  // backup
  const histInfo = h('div', { class: 'small muted' }, '…');
  const lastBk = h('span', { class: 'small muted' }, `Last backup: ${p.lastBackup ? new Date(p.lastBackup).toLocaleString() : 'never'}`);
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', onChange: (e) => doImport(e.target.files?.[0], refreshInfo) });
  const refreshInfo = async () => {
    const all = await listSessions().catch(() => []);
    const est = await storageEstimate();
    histInfo.textContent = `${all.length} session${all.length === 1 ? '' : 's'} on this tablet${est?.usage ? ` · ${(est.usage / 1048576).toFixed(1)} MB used` : ''}`;
  };
  const backup = sec('backup', 'Data & backup',
    row(h('div', { class: 'grow' }, h('div', {}, 'Practice history'), histInfo)),
    h('div', { class: 'grid2', style: { paddingTop: '12px' } },
      h('button', { type: 'button', class: 'btn', onClick: async () => { if (await doExport()) { setPrefs({ lastBackup: Date.now() }); lastBk.textContent = `Last backup: ${new Date().toLocaleString()}`; } } }, 'Export backup (.json)'),
      h('button', { type: 'button', class: 'btn', onClick: () => fileIn.click() }, 'Import backup')),
    h('div', { class: 'row', style: { justifyContent: 'space-between', paddingTop: '12px' } }, lastBk,
      h('button', { type: 'button', class: 'btn ghost danger', onClick: () => confirmClear(refreshInfo) }, 'Clear history…')),
    fileIn);

  // version
  const status = h('div', { class: 'small muted' }, p.lastCheck ? `Last checked ${new Date(p.lastCheck).toLocaleString()}` : 'Not checked yet');
  const actionBox = h('div', { class: 'row' });
  const checkBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => checkForUpdate(status, actionBox, checkBtn) }, 'Check for update');
  const version = sec('update', 'Version & updates',
    row(h('div', { class: 'grow' }, h('div', {}, 'Installed'), h('div', { class: 'small muted' }, new Date(RELEASE_DATE + 'T00:00:00').toLocaleDateString([], { dateStyle: 'medium' }))), h('span', { class: 'mono', style: { fontSize: '18px', fontWeight: 700 } }, `v${APP_VERSION}`)),
    row(h('div', { class: 'grow' }, h('div', {}, 'Update status'), status), checkBtn),
    actionBox,
    h('div', { class: 'lbl', style: { marginTop: '14px' } }, "What's new"),
    h('div', { class: 'col', style: { gap: '8px', marginTop: '8px' } }, RELEASE_NOTES.map((r, i) =>
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px' } }, h('span', { class: 'mono small', style: { width: '52px', flex: '0 0 52px', color: i ? 'var(--muted)' : 'var(--amber)' } }, `v${r.v}`), h('span', { class: 'small', style: { color: i ? 'var(--muted)' : 'var(--text2)' } }, r.notes)))),
    h('div', { class: 'small muted', style: { marginTop: '10px' } }, 'Needs internet. Offline, the app keeps running the installed version.'));

  const notice = h('section', { class: 'card more-sec notice', role: 'note', 'aria-label': 'Disclaimer' },
    h('div', { class: 'row' }, icon('info', 20, '#f2a93b'), h('h2', {}, DISCLAIMER_TITLE)),
    ...DISCLAIMER.map((t) => h('p', { class: 'small' }, t)));
  const about = sec('info', 'About',
    h('p', { class: 'small' }, 'Personal tool for practising kick detection, shut-in, kill sheets and well kills, online or offline.'),
    h('div', { class: 'mrow' }, h('span', { class: 'grow' }, 'Optimised for'), h('b', {}, 'Laptop and tablet (landscape)')),
    h('div', { class: 'mrow' }, h('span', { class: 'grow' }, 'Phone'), h('span', { class: 'small', style: { textAlign: 'right' } }, 'Home, Kill sheet, History and More work. Simulator: phone layout coming later — use landscape for now.')),
    h('div', { class: 'mrow', style: { borderBottom: '0' } }, h('span', { class: 'grow' }, 'Install'), h('span', { class: 'small', style: { textAlign: 'right' } }, 'Chrome or Edge → Install app. Works offline after the first visit.')),
    h('button', { type: 'button', class: 'btn', style: { alignSelf: 'flex-start' }, onClick: () => app.go('help') }, 'Quick reference'));

  shell('more', h('div', { class: 'page' }, h('h1', {}, 'More'),
    h('div', { class: 'more-grid' }, h('div', { class: 'col', style: { gap: '16px' } }, units, course, backup), h('div', { class: 'col', style: { gap: '16px' } }, notice, version, about))));
  refreshInfo();
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
async function checkForUpdate(status, actionBox, btn) {
  clear(actionBox);
  if (!navigator.onLine) { status.textContent = 'Offline — connect to the internet to check.'; return; }
  btn.disabled = true; status.textContent = 'Checking…';
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (typeof j.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(j.version)) throw new Error('bad version file');
    setPrefs({ lastCheck: Date.now() });
    if (cmpVer(j.version, APP_VERSION) > 0) {
      status.textContent = `Version ${j.version} is available.`;
      status.style.color = 'var(--amber)';
      actionBox.append(h('div', { class: 'card updatebox' },
        h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 } }, `Version ${j.version}`), h('div', { class: 'small' }, typeof j.notes === 'string' ? j.notes : ''), h('div', { class: 'small muted' }, 'Your history stays on this tablet.')),
        h('button', { type: 'button', class: 'btn primary', onClick: (e) => installUpdate(e.target) }, 'Install & reload')));
    } else {
      status.textContent = `Up to date · checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      status.style.color = 'var(--green)';
    }
  } catch {
    status.textContent = 'Could not check for updates. Try again later.';
    status.style.color = 'var(--red)';
  } finally { btn.disabled = false; }
}
async function installUpdate(btn) {
  btn.disabled = true; btn.textContent = 'Installing…';
  let done = false;
  const reload = () => { if (!done) { done = true; location.reload(); } };
  try {
    navigator.serviceWorker?.addEventListener('controllerchange', reload);
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch { /* fall back to a plain reload */ }
  setTimeout(reload, 8000);
}

async function doExport() {
  try {
    const sessions = await getAllSessions();
    const data = { app: 'wcsim', format: 1, exportedAt: new Date().toISOString(), version: APP_VERSION, sessions, settings: { setup: loadJSON(SETTINGS_KEY, {}) } };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `wcsim-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Backup saved: ${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
    return true;
  } catch { toast('Could not create the backup', 'warn'); return false; }
}
const SEV = new Set(['critical', 'warning', 'good', 'info']);
const OUT = new Set(['ok', 'bad', 'mid']);
function cleanSession(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id.length > 64 || !Number.isFinite(s.date)) return null;
  if (!s.scen || typeof s.scen !== 'object' || !s.scen.mud) return null;
  const findings = Array.isArray(s.findings) ? s.findings.filter((f) => f && typeof f.title === 'string').map((f) => ({
    sev: SEV.has(f.sev) ? f.sev : 'info', t: Number.isFinite(f.t) ? f.t : null, title: String(f.title), what: String(f.what ?? ''), action: String(f.action ?? ''),
  })) : [];
  const outcome = s.outcome && typeof s.outcome === 'object' ? { k: OUT.has(s.outcome.k) ? s.outcome.k : 'mid', t: String(s.outcome.t ?? ''), d: String(s.outcome.d ?? '') } : { k: 'mid', t: '—', d: '' };
  return { ...s, findings, outcome, samples: Array.isArray(s.samples) ? s.samples : [], events: Array.isArray(s.events) ? s.events : [] };
}
async function doImport(file, after) {
  if (!file) return;
  if (file.size > 60 * 1048576) { toast('File too large for a backup', 'warn'); return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Not a valid backup file', 'warn'); return; }
  if (!data || data.app !== 'wcsim' || !Array.isArray(data.sessions)) { toast('Not a Well Control Sim backup', 'warn'); return; }
  const list = data.sessions.map(cleanSession).filter(Boolean);
  const skipped = data.sessions.length - list.length;
  const m = modal([h('h2', {}, 'Import backup?'),
    h('p', {}, `${list.length} session${list.length === 1 ? '' : 's'} found${skipped ? ` (${skipped} unreadable, skipped)` : ''}. Sessions with the same ID on this tablet are replaced; others are kept.`),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onClick: async () => {
        m.close();
        try { await importSessions(list); toast(`Imported ${list.length} session${list.length === 1 ? '' : 's'}`); after?.(); } catch { toast('Import failed', 'warn'); }
      } }, 'Import'))]);
}
function confirmClear(after) {
  const m = modal([h('h2', {}, 'Clear all practice history?'), h('p', {}, 'Every session and debrief on this tablet will be deleted. This cannot be undone. Export a backup first if you want to keep them.'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn danger', onClick: async () => { m.close(); try { await clearSessions(); toast('History cleared'); after?.(); } catch { toast('Could not clear history', 'warn'); } } }, 'Delete everything'))]);
}

// ---------------- Debrief ----------------
function debrief(id, rec = null) {
  const body = h('div', { class: 'page' });
  shell('history', body);
  const show = (r) => {
    if (!r) { body.append(h('p', {}, 'Session not found.')); return; }
    const oc = r.outcome;
    const canvas = h('canvas', { style: { width: '100%', height: '220px' }, role: 'img', 'aria-label': 'BHP minus formation pressure over time' });
    body.append(
      h('div', { class: 'outcome ' + oc.k }, h('div', { class: 'grow' }, h('h1', {}, oc.t), h('p', {}, oc.d)),
        h('div', { class: 'col', style: { alignItems: 'flex-end' } }, h('div', { class: 'small muted' }, new Date(r.date).toLocaleString()), h('div', { class: 'small muted' }, `${r.scen.mode} · ${r.scen.mud.type} · ${r.method ? (r.method === 'ww' ? 'Wait & Weight' : "Driller's") : 'no method'}`))),
      h('div', { class: 'stats' },
        stat('Session time', fmtTime(r.stats?.duration ?? 0)), stat('Total influx', `${fmt(r.stats?.influx, 1)} bbl`),
        stat('Secondary influx', `${fmt(r.stats?.secondary, 1)} bbl`), stat('Losses', `${fmt(r.stats?.losses, 1)} bbl`),
        stat('Max casing pressure', `${fmt(r.stats?.maxCp)} psi`), stat('Initial MAASP (true)', `${fmt(r.stats?.maasp)} psi`)),
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
  shell('history', h('div', { class: 'page' }, h('h1', {}, 'Practice history'),
    h('p', { class: 'small' }, 'Stored on this tablet only. Use More → Export backup to keep a copy.'), list));
  const load = () => listSessions().then((all) => {
    clear(list);
    if (!all.length) { list.append(h('p', { class: 'muted' }, 'No sessions yet.')); return; }
    const top = recurring(all).slice(0, 4);
    if (top.length) list.append(h('section', { class: 'card col' }, h('h3', {}, 'Recurring issues'), top.map(([t, n]) => h('div', { class: 'kv' }, h('span', {}, t), h('b', {}, `${n}×`)))));
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
  const body = h('div', { class: 'page', style: { maxWidth: '1280px' } });
  shell('trainer', body);
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
  shell('more', h('div', { class: 'page' },
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn sm', onClick: () => app.go('more') }, '← More'), h('h1', {}, 'Quick reference')),
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
        h('p', { class: 'small' }, 'Single-phase liquid with ideal-gas influx (Z = 1), gas migration, OBM gas solubility with breakout, choke and pump dynamics, and a pressure delay to the standpipe. It is a training aid — numbers follow field rules of thumb, not a specific rig. Rounding: KMW up, max. mud density down, MAASP down. Confirm conventions with your course material.')))));
}

const SCREENS = {
  home, setup, history: historyScreen, trainer, help, more,
  debrief: (id, rec) => debrief(id, rec),
  sim: (scen, o) => simScreen(app, scen, { coach: o?.coach ?? true }),
};

const ROUTES = ['home', 'setup', 'history', 'trainer', 'help', 'more'];
const route = () => { const r = (location.hash || '#home').slice(1); return ROUTES.includes(r) ? r : 'home'; };
app.go(route());
window.addEventListener('hashchange', () => { if (!document.querySelector('.sim')) app.go(route()); });
const netChip = () => { const c = document.querySelector('.netchip'); if (!c) return; c.classList.toggle('on', navigator.onLine); c.title = navigator.onLine ? 'Online · offline ready' : 'Offline'; c.querySelector('.netlbl').textContent = c.title; };
window.addEventListener('online', netChip);
window.addEventListener('offline', netChip);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache unavailable */ }));
}
