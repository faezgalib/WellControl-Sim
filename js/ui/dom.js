// Minimal DOM helpers.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === 'svg' || attrs._svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false || k === '_svg') continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'ref') v(el);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function svg(tag, attrs = {}, ...children) { return h(tag, { ...attrs, _svg: true }, ...children); }

export function fmt(n, d = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h_).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let toastWrap = null;
export function toast(msg, kind = '') {
  if (!toastWrap) { toastWrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }); document.body.append(toastWrap); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastWrap.append(t);
  setTimeout(() => t.remove(), 3800);
}

export function modal(content, { wide = false, onClose = null } = {}) {
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'modal-back' }, box);
  const close = () => { back.remove(); onClose && onClose(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, box };
}

/** Button that repeats while held. */
export function holdButton(label, onTick, attrs = {}) {
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const b = h('button', { class: 'btn', type: 'button', ...attrs }, label);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); onTick(); stop(); timer = setInterval(onTick, 150); b.setPointerCapture?.(e.pointerId); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) b.addEventListener(ev, stop);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  return b;
}
