// Copyright (c) 2026 Fido-labs —kcw—
// Utilitaires DOM : tout texte dynamique passe par textContent (aucun innerHTML → pas de XSS).
import { t, lang } from './i18n.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') deferredValue = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  if (deferredValue !== undefined) el.value = deferredValue; // après les <option>
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  flame: ['M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z'],
  dashboard: ['M3 13h8V3H3z', 'M13 21h8V11h-8z', 'M3 21h8v-6H3z', 'M13 9h8V3h-8z'],
  cpu: ['M6 6h12v12H6z', 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4', 'M10 10h4v4h-4z'],
  plug: ['M9 2v6M15 2v6', 'M6 8h12v4a6 6 0 0 1-12 0z', 'M12 18v4'],
  shuffle: ['M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5'],
  key: ['M15.5 8.5a4 4 0 1 1-4 4', 'M11.5 12.5 3 21M7 17l2 2M10 14l2 2'],
  terminal: ['M3 4h18v16H3z', 'M7 9l3 3-3 3M12 15h5'],
  list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  check: ['M4 12l5 5L20 6'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
  play: ['M6 4l14 8-14 8z'],
  trash: ['M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14'],
  plus: ['M12 5v14M5 12h14'],
  external: ['M14 3h7v7M10 14 21 3M19 14v7H3V5h7'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z'],
  moon: ['M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z'],
  logout: ['M9 21H4V3h5M16 17l5-5-5-5M21 12H9'],
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export function logoSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', 'lg'); grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  for (const [o, c] of [['0', '#ffb347'], ['1', '#ff4d1a']]) {
    const s = document.createElementNS(SVG_NS, 'stop');
    s.setAttribute('offset', o); s.setAttribute('stop-color', c); grad.append(s);
  }
  defs.append(grad);
  const p1 = document.createElementNS(SVG_NS, 'path');
  p1.setAttribute('d', 'M33 8c2 10 14 15 14 29a15 15 0 0 1-30 0c0-6 3-10 6-13 0 6 3 9 6 9-1-9-2-16 4-25z');
  p1.setAttribute('fill', 'url(#lg)');
  const p2 = document.createElementNS(SVG_NS, 'path');
  p2.setAttribute('d', 'M32 30c1 5 6 7 6 13a6 6 0 0 1-12 0c0-3 1-5 3-6 0 3 1 4 3 4z');
  p2.setAttribute('fill', '#fff3d6'); p2.setAttribute('opacity', '.9');
  svg.append(defs, p1, p2);
  return svg;
}

/* ── Notifications ── */
let toastBox;
export function toast(message, kind = '') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

export async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(label ?? t('copied'), 'ok');
}

export function copyButton(text, { label, small = true } = {}) {
  return h('button', {
    class: `btn ${small ? 'sm' : ''} ghost`, type: 'button', title: t('copy'), 'aria-label': t('copy'),
    onclick: (e) => { e.stopPropagation(); copyText(text, label); },
  }, icon('copy'));
}

export function copyBox(text) {
  return h('div', { class: 'copybox' }, h('code', { title: text }, text), copyButton(text));
}

/* ── Modale ── */
export function modal(title, body, { wide = false, actions = [] } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', null, title),
      body,
      h('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' },
        actions.map((a) => h('button', {
          class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, type: 'button',
          onclick: async () => {
            if (a.onClick) { const r = await a.onClick(close); if (r === false) return; }
            if (a.value !== undefined) close(a.value);
          },
        }, a.label))));
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } }, box);
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    box.querySelector('input,select,textarea,button')?.focus();
  });
}

export function confirmDialog(message, { danger = false, ok = t('confirm') } = {}) {
  return modal(t('confirmTitle'), h('p', null, message), {
    actions: [{ label: t('cancel'), value: false }, { label: ok, value: true, primary: !danger, danger }],
  });
}

/* ── Formatage ── */
const nf = () => new Intl.NumberFormat(lang());
export const fmtInt = (n) => nf().format(Math.round(n ?? 0));
export function fmtCompact(n) {
  const v = Number(n ?? 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
export const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString(lang(), { hour12: false }) : '—');
export function fmtDuration(sec) {
  const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}j ${hh}h` : hh ? `${hh}h ${m}min` : `${m}min`;
}
export function ago(ts) {
  if (!ts) return t('never');
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t('justNow');
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} j`;
}

export function statusBadge(status) {
  const map = { ready: ['ok', 'statusReady'], connect: ['info', 'statusConnect'], cooldown: ['warn', 'statusCooldown'], offline: ['', 'statusOffline'] };
  const [kind, key] = map[status] ?? ['', status];
  return h('span', { class: `badge ${kind}` }, h('i', { class: 'dot' }), t(key));
}

export const debounce = (fn, ms = 200) => {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
};
