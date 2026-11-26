import { h, fmt, clear } from './dom.js';
import { FIELDS, SECTIONS, checkSheet, solveSheet, workedLine, schedule } from '../core/killsheet.js';
import { capacity, annCapacity } from '../core/geometry.js';

/**
 * Kill sheet editor.
 * state: { entries:{}, kick:{sidpp,sicp,gain}, scrIndex, prefill:boolean, check:null }
 */
export function killSheetView(scen, state, { mode = 'sim', onAccept = null, onClose = null, onNewWell = null } = {}) {
  state.entries ??= {};
  state.kick ??= { sidpp: '', sicp: '', gain: '' };
  state.scrIndex ??= 0;
  const w = scen.well;
  const rows = {};
  const root = h('div', { class: 'col', style: { gap: '14px' } });

  const kickNum = () => ({ sidpp: Number(state.kick.sidpp) || 0, sicp: Number(state.kick.sicp) || 0, gain: Number(state.kick.gain) || 0 });

  const buildGiven = () => h('div', { class: 'card given col', style: { gap: '2px' } },
    h('div', { class: 'lbl', style: { marginBottom: '4px' } }, 'Pre-recorded data'),
    kv('Hole TD / TVD', `${fmt(w.td)} ft`),
    kv('Casing shoe TVD', `${fmt(w.shoe.depth)} ft`),
    kv('Casing ID', `${w.shoe.id}"`),
    kv('Hole size', `${w.hole}"`),
    kv('Drill pipe', `${w.dp.od}" · ID ${w.dp.id}" · ${capacity(w.dp.id).toFixed(5)} bbl/ft`),
    kv('DP length', `${fmt(w.td - w.hw.len - w.dc.len)} ft`),
    kv('HWDP', `${w.hw.od}" · ID ${w.hw.id}" · ${capacity(w.hw.id).toFixed(5)} bbl/ft`),
    kv('HWDP length', `${fmt(w.hw.len)} ft`),
    kv('Drill collars', `${w.dc.od}" · ID ${w.dc.id}" · ${capacity(w.dc.id).toFixed(5)} bbl/ft`),
    kv('DC length', `${fmt(w.dc.len)} ft`),
    kv('Ann. cap. OH × DC', `${annCapacity(w.hole, w.dc.od).toFixed(5)} bbl/ft`),
    kv('Ann. cap. OH × DP/HWDP', `${annCapacity(w.hole, w.dp.od).toFixed(5)} bbl/ft`),
    kv('Ann. cap. Casing × DP', `${annCapacity(w.shoe.id, w.dp.od).toFixed(5)} bbl/ft`),
    kv('Surface line volume', `${w.surfLine} bbl`),
    kv('Pump output', `${scen.pumpOutput} bbl/stk`),
    kv('Current mud density', `${scen.mud.rho.toFixed(1)} ppg`),
    kv('LOT surface pressure', `${fmt(scen.lot.psi)} psi`),
    kv('LOT mud density', `${scen.lot.testMw.toFixed(1)} ppg`),
    h('div', { class: 'lbl', style: { margin: '10px 0 4px' } }, 'Slow circulating rate (kill rate)'),
    h('div', { class: 'seg' }, scen.scr.map((s, i) => h('button', {
      type: 'button', class: 'btn sm' + (state.scrIndex === i ? ' sel' : ''),
      onClick: () => { state.scrIndex = i; rerender(); },
    }, `${s.spm} spm · ${s.psi} psi`))),
    h('div', { class: 'lbl', style: { margin: '10px 0 4px' } }, 'Kick data'),
    kickInput('SIDPP', 'sidpp', 'psi'), kickInput('SICP', 'sicp', 'psi'), kickInput('Pit gain', 'gain', 'bbl'),
    mode === 'sim' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.prefill ? true : null, onChange: (e) => { state.prefill = e.target.checked; if (state.prefill) prefill(); rerender(); } }), h('span', { class: 'small' }, 'Fill volumes & strokes for me (practise kick calcs only)')) : null,
  );

  function kickInput(lbl, key, unit) {
    return h('div', { class: 'row', style: { margin: '3px 0' } },
      h('label', { class: 'small grow', for: 'k-' + key }, lbl),
      h('input', { id: 'k-' + key, type: 'number', inputmode: 'decimal', value: state.kick[key], style: { width: '110px' }, onInput: (e) => { state.kick[key] = e.target.value; state.check = null; renderResults(); } }),
      h('span', { class: 'small muted', style: { width: '28px' } }, unit));
  }

  function prefill() {
    const v = solveSheet(scen, kickNum(), state.scrIndex).values;
    for (const f of FIELDS) if (f.sec !== 'kick' && f.sec !== 'formation') state.entries[f.key] = String(v[f.key]);
  }

  const right = h('div', { class: 'col', style: { gap: '14px' } });
  const sched = h('div', { class: 'card col' });
  const rerender = () => { clear(root); build(); };

  function build() {
    clear(right);
    let lastSec = null, sec = null;
    for (const f of FIELDS) {
      if (f.sec !== lastSec) {
        sec = h('div', { class: 'card ks-sec' }, h('h3', { style: { marginBottom: '4px' } }, SECTIONS[f.sec]));
        right.append(sec); lastSec = f.sec;
      }
      const inp = h('input', { type: 'number', inputmode: 'decimal', step: 'any', value: state.entries[f.key] ?? '', 'aria-label': f.label,
        onInput: (e) => { state.entries[f.key] = e.target.value; state.check = null; renderResults(); } });
      const res = h('span', { class: 'res', 'aria-live': 'polite' });
      const fb = h('div', { class: 'fb hidden' });
      const help = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': `Show working for ${f.label}`, title: 'Show working',
        onClick: () => { fb.classList.toggle('hidden'); fb.textContent = `${f.f}\n${workedLine(f.key, scen, kickNum(), state.scrIndex)}`; fb.style.whiteSpace = 'pre-line'; } }, '?');
      const row = h('div', { class: 'ks-row' },
        h('div', { class: 'nm' }, f.label, h('div', { class: 'f' }, f.f)),
        inp, h('span', { class: 'u' }, f.unit), res, fb);
      rows[f.key] = { row, res, fb, help };
      row.insertBefore(help, res);
      row.style.gridTemplateColumns = 'minmax(0,1fr) 120px 40px 40px 24px';
      sec.append(row);
    }
    right.append(sched);
    root.append(h('div', { class: 'ks' }, buildGiven(), right));
    root.append(actions());
    renderResults();
  }

  function actions() {
    const bar = h('div', { class: 'actions row', style: { justifyContent: 'flex-end', flexWrap: 'wrap', position: 'sticky', bottom: '0', background: 'var(--panel)', padding: '10px 0' } });
    if (onClose) bar.append(h('button', { type: 'button', class: 'btn', onClick: onClose }, 'Close'));
    if (onNewWell) bar.append(h('button', { type: 'button', class: 'btn', onClick: onNewWell }, 'New well'));
    bar.append(h('button', { type: 'button', class: 'btn', onClick: () => { const v = solveSheet(scen, kickNum(), state.scrIndex).values; for (const f of FIELDS) state.entries[f.key] = String(v[f.key]); state.check = checkSheet(scen, kickNum(), state.entries, state.scrIndex); state.revealed = true; rerender(); } }, 'Show answers'));
    bar.append(h('button', { type: 'button', class: 'btn', onClick: () => { state.check = checkSheet(scen, kickNum(), state.entries, state.scrIndex); renderResults(); } }, 'Check'));
    if (onAccept) bar.append(h('button', { type: 'button', class: 'btn primary', onClick: () => {
      state.check = checkSheet(scen, kickNum(), state.entries, state.scrIndex);
      const need = ['kmw', 'icp', 'fcp', 'stkBit', 'stkTotal'];
      const missing = need.filter((k) => !Number.isFinite(parseFloat(state.entries[k])));
      if (missing.length) { renderResults(); alertBox(`Fill in: ${missing.map((k) => FIELDS.find((f) => f.key === k).label).join(', ')}`); return; }
      onAccept(state);
    } }, 'Use this kill sheet'));
    return bar;
  }

  function alertBox(msg) {
    const n = h('div', { class: 'card', style: { borderColor: 'var(--red)' } }, msg);
    root.append(n); setTimeout(() => n.remove(), 4000);
  }

  function renderResults() {
    const c = state.check;
    for (const f of FIELDS) {
      const r = rows[f.key]; if (!r) continue;
      r.row.classList.remove('ok', 'bad', 'own');
      r.res.textContent = '';
      if (c && c[f.key]) {
        const x = c[f.key];
        if (x.ok) { r.row.classList.add('ok'); r.res.textContent = '✓'; }
        else if (x.followsOwn) { r.row.classList.add('own'); r.res.textContent = '≈'; r.res.title = 'Follows from your earlier value'; }
        else if (x.entered !== null) { r.row.classList.add('bad'); r.res.textContent = '✗'; }
        else { r.res.textContent = '·'; }
      }
    }
    // schedule from the user's own numbers
    clear(sched);
    const icp = parseFloat(state.entries.icp), fcp = parseFloat(state.entries.fcp), stk = parseFloat(state.entries.stkBit);
    sched.append(h('h3', {}, 'Drill pipe pressure schedule'));
    if ([icp, fcp, stk].every(Number.isFinite) && stk > 0) {
      const sch = schedule(icp, fcp, stk);
      sched.append(h('table', { class: 'sched' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Strokes'), sch.map((p) => h('th', {}, fmt(p.stk))))),
        h('tbody', {}, h('tr', {}, h('td', { class: 'muted' }, 'DP psi'), sch.map((p) => h('td', {}, fmt(p.psi)))))));
      sched.append(h('p', { class: 'small' }, 'Built from your own ICP, FCP and surface-to-bit strokes.'));
    } else sched.append(h('p', { class: 'small' }, 'Enter ICP, FCP and surface-to-bit strokes to build the schedule.'));
    if (c) {
      const n = FIELDS.filter((f) => c[f.key]?.ok).length;
      sched.append(h('p', { class: 'small', style: { marginTop: '6px' } }, `${n} of ${FIELDS.length} lines correct. Tap ? on a line to see the working. ≈ means the line is right for your earlier (wrong) value.`));
    }
  }

  if (state.prefill) prefill();
  build();
  return root;
}

function kv(k, v) { return h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v)); }
