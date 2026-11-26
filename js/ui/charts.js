// Canvas drawing: wellbore schematic and pressure trend.

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hgt };
}

const C = { omw: '#3a4250', kmw: '#f2a93b', gas: '#5ab0f0', water: '#4fd1c5', obm: '#a99cff', steel: '#9aa3ae', bg: '#1b1f25', text: '#9aa3ae', casing: '#c3c9d1' };

function mudColor(rho, omw, kmw) {
  if (!kmw || kmw <= omw) return Math.abs(rho - omw) < 0.05 ? C.omw : (rho > omw ? C.kmw : '#566070');
  const f = Math.max(0, Math.min(1, (rho - omw) / (kmw - omw)));
  const a = [0x3a, 0x42, 0x50], b = [0xf2, 0xa9, 0x3b];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * f)).join(',')})`;
}

export function drawWell(canvas, sim, { kmw = null } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const g = sim.geo, td = g.td;
  const top = 8, bot = h - 18;
  const y = (d) => top + (d / td) * (bot - top);
  const holeW = Math.min(64, w * 0.4), pipeW = holeW * 0.32;
  const cx = holeW / 2 + 10;
  const xL = cx - holeW / 2, xR = cx + holeW / 2;
  const omw = sim.omw;
  // hole background
  ctx.fillStyle = C.bg; ctx.fillRect(xL, top, holeW, bot - top);
  // annulus content
  for (const it of sim.ann) {
    if (it.dTop === undefined) continue;
    const y0 = y(it.dTop), y1 = Math.max(y(it.dBot), y0 + (it.k === 'G' ? 2 : 0.5));
    ctx.fillStyle = it.k === 'G' ? C.gas : it.w ? C.water : it.nd > 1e-4 ? C.obm : mudColor(it.rho, omw, kmw);
    ctx.fillRect(xL, y0, holeW, y1 - y0);
  }
  // pipe
  const bit = y(g.bit);
  ctx.fillStyle = '#0f1114';
  ctx.fillRect(cx - pipeW / 2 - 2, top, pipeW + 4, bit - top);
  let u = 0, d = 0;
  for (const s of sim.str) {
    const d2 = g.strDepthFromTop(u + s.v);
    ctx.fillStyle = mudColor(s.rho, omw, kmw);
    ctx.fillRect(cx - pipeW / 2, y(d), pipeW, Math.max(0.5, y(d2) - y(d)));
    u += s.v; d = d2;
  }
  ctx.fillStyle = C.steel; ctx.fillRect(cx - pipeW / 2 - 3, bit - 2, pipeW + 6, 5);
  // casing
  const ys = y(g.shoe);
  ctx.strokeStyle = C.casing; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xL - 2, top); ctx.lineTo(xL - 2, ys); ctx.lineTo(xL - 8, ys); ctx.moveTo(xR + 2, top); ctx.lineTo(xR + 2, ys); ctx.lineTo(xR + 8, ys); ctx.stroke();
  // labels
  ctx.fillStyle = C.text; ctx.font = '11px Inter, system-ui, sans-serif'; ctx.textAlign = 'left';
  const lx = xR + 10;
  ctx.fillText('0', lx, top + 8);
  ctx.fillText(`Shoe ${g.shoe.toLocaleString()}`, lx, ys + 4);
  ctx.fillText(`Bit ${Math.round(sim.bitDepth).toLocaleString()}`, lx, Math.min(bit + 4, bot - 10));
  ctx.fillText(`TD ${Math.round(Math.max(td, sim.bitDepth)).toLocaleString()}`, lx, bot + 12);
  if (sim.last.gasTopDepth !== null && sim.last.gasTopDepth !== undefined) {
    const yg = y(sim.last.gasTopDepth);
    ctx.fillStyle = C.gas;
    ctx.fillText(`Gas ${Math.round(sim.last.gasTopDepth).toLocaleString()}`, lx, Math.max(top + 22, Math.min(yg + 4, bot - 26)));
  }
}

/**
 * Trend chart. series: [{key, color, dash}] reading from samples; window in seconds (0 = all).
 */
export function drawTrend(canvas, samples, { window = 1800, now = 0, target = [], extraLines = [] } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 44, padR = 8, padT = 6, padB = 18;
  const t1 = Math.max(now, samples.length ? samples[samples.length - 1].t : 0);
  const t0 = window ? Math.max(0, t1 - window) : (samples[0]?.t ?? 0);
  const vis = samples.filter((s) => s.t >= t0);
  let max = 200;
  for (const s of vis) { max = Math.max(max, s.spp ?? 0, s.cp ?? 0); }
  for (const p of target) max = Math.max(max, p.psi);
  for (const l of extraLines) max = Math.max(max, l.psi * 1.02);
  max = Math.ceil((max * 1.1) / 250) * 250;
  const X = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const Y = (p) => padT + (1 - p / max) * (h - padT - padB);
  // grid
  ctx.strokeStyle = '#262b33'; ctx.lineWidth = 1; ctx.fillStyle = '#9aa3ae'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'right';
  const step = max <= 1000 ? 250 : max <= 3000 ? 500 : 1000;
  for (let p = 0; p <= max; p += step) { ctx.beginPath(); ctx.moveTo(padL, Y(p)); ctx.lineTo(w - padR, Y(p)); ctx.stroke(); ctx.fillText(String(p), padL - 4, Y(p) + 3); }
  ctx.textAlign = 'center';
  const span = t1 - t0;
  const tStep = span > 7200 ? 1800 : span > 3600 ? 900 : span > 1200 ? 300 : 120;
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) ctx.fillText(`${Math.round(t / 60)}m`, X(t), h - 4);
  for (const l of extraLines) {
    ctx.strokeStyle = l.color; ctx.setLineDash([2, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, Y(l.psi)); ctx.lineTo(w - padR, Y(l.psi)); ctx.stroke(); ctx.setLineDash([]);
  }
  const line = (pts, color, width = 2.5, dash = null) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let started = false;
    for (const [t, p] of pts) { if (p === null || p === undefined) { started = false; continue; } const x = X(t), yy = Y(p); if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy); }
    ctx.stroke(); ctx.setLineDash([]);
  };
  line(target.map((p) => [p.t, p.psi]), '#c3c9d1', 1.5, [6, 5]);
  line(vis.map((s) => [s.t, s.cp]), '#5ab0f0');
  line(vis.map((s) => [s.t, s.spp]), '#f2a93b');
}

/** Debrief chart: BHP margin vs time with event markers. */
export function drawMargin(canvas, samples, markers = []) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!samples.length) return;
  const padL = 48, padR = 10, padT = 10, padB = 20;
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  const ms = samples.map((s) => s.bhp - s.pform);
  let lo = Math.min(-100, ...ms), hi = Math.max(300, ...ms);
  lo = Math.floor(lo / 100) * 100; hi = Math.ceil(hi / 100) * 100;
  const X = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  ctx.fillStyle = 'rgba(240,112,90,0.10)'; ctx.fillRect(padL, Y(0), w - padL - padR, Y(lo) - Y(0));
  ctx.strokeStyle = '#262b33'; ctx.fillStyle = '#9aa3ae'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'right';
  const step = hi - lo > 1500 ? 500 : hi - lo > 600 ? 200 : 100;
  for (let v = lo; v <= hi; v += step) { ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke(); ctx.fillText(String(v), padL - 4, Y(v) + 3); }
  ctx.strokeStyle = '#9aa3ae'; ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(w - padR, Y(0)); ctx.stroke();
  ctx.textAlign = 'center';
  const span = t1 - t0, tStep = span > 14400 ? 3600 : span > 7200 ? 1800 : span > 3600 ? 900 : 300;
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) ctx.fillText(`${Math.round(t / 60)}m`, X(t), h - 5);
  for (const m of markers) {
    ctx.strokeStyle = m.color || '#566070'; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(X(m.t), padT); ctx.lineTo(X(m.t), h - padB); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#7ee0a8'; ctx.lineWidth = 2; ctx.beginPath();
  samples.forEach((s, i) => { const x = X(s.t), yy = Y(s.bhp - s.pform); if (i) ctx.lineTo(x, yy); else ctx.moveTo(x, yy); });
  ctx.stroke();
}
