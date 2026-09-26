// Shared UI helpers: icons, toasts, modals, formatters, code / diff / terminal views
import { locale, N_, t } from './i18n.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-2.93 1.41-1.41M17.66 6.34l1.41-1.41M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  git: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9M12 12v3"/>',
  bug: '<path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  fileCode: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 12l-2 2 2 2M14 16l2-2-2-2"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2M3 18h7"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  wifi: '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0M12 20h.01"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  cloudUp: '<path d="M12 13v8M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="m8 17 4-4 4 4"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  gitlab: '<path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z"/>',
  tea: '<path d="M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
};

export const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ------------------------------------------------------------------ DOM
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(t('Copied to clipboard'), 'success');
}

export function download(filename, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ toast
export function toast(message, type = 'info', { actions = [], timeout } = {}) {
  const ico = { success: 'checkCircle', error: 'xCircle', warning: 'alert', info: 'info' }[type] || 'info';
  const el = h(`<div class="toast ${type}">${icon(ico)}<div class="t-body">${esc(message)}
    ${actions.length ? '<div class="t-actions"></div>' : ''}</div>
    <button class="btn ghost sm icon" aria-label="${esc(t('Close'))}">${icon('x')}</button></div>`);
  const close = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 150); };
  el.querySelector('button.icon').onclick = close;
  actions.forEach((a) => {
    const b = h(`<button class="btn sm ${a.primary ? 'primary' : ''}">${esc(a.label)}</button>`);
    b.onclick = () => { close(); a.onClick(); };
    el.querySelector('.t-actions').appendChild(b);
  });
  document.getElementById('toasts').appendChild(el);
  const ms = timeout ?? (type === 'error' ? 9000 : actions.length ? 15000 : 4000);
  if (ms) setTimeout(close, ms);
  return close;
}

export const toastError = (e) => toast(e?.message || String(e), 'error');

// ------------------------------------------------------------------ modal
export function modal({ title, body = '', footer = '', size = '', onClose } = {}) {
  const el = h(`<div class="overlay"><div class="modal ${size}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${title}</h2><button class="btn ghost icon close" aria-label="${esc(t('Close'))}">${icon('x')}</button></div>
    <div class="modal-body"></div>${footer !== null ? '<div class="modal-foot"></div>' : ''}</div></div>`);
  const bodyEl = el.querySelector('.modal-body');
  const footEl = el.querySelector('.modal-foot');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  if (footEl) { if (typeof footer === 'string') footEl.innerHTML = footer; else footEl.appendChild(footer); }
  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && document.querySelector('.overlay:last-of-type') === el) close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  el.querySelector('.close').onclick = close;
  document.body.appendChild(el);
  const first = el.querySelector('.modal-body input:not([type=checkbox]), .modal-body textarea, .modal-body select');
  if (first) setTimeout(() => first.focus(), 30);
  return { el, body: bodyEl, foot: footEl, close };
}

export function confirmDialog({ title = t('Are you sure?'), message = '', confirm = t('Confirm'), danger = false, requireText } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: esc(title), size: 'sm',
      body: `<div class="stack"><div>${message}</div>${requireText ? `<div class="field"><label>${t('Type {text} to confirm', { text: `<code>${esc(requireText)}</code>` })}</label><input class="input" id="cf-text"></div>` : ''}</div>`,
      footer: `<button class="btn" data-a="no">${t('Cancel')}</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-a="yes">${esc(confirm)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    const yes = m.foot.querySelector('[data-a=yes]');
    if (requireText) {
      yes.disabled = true;
      m.body.querySelector('#cf-text').oninput = (e) => { yes.disabled = e.target.value !== requireText; };
    }
    m.foot.querySelector('[data-a=no]').onclick = () => m.close();
    yes.onclick = () => { done = true; m.close(); resolve(true); };
  });
}

export function dropdown(anchor, items, { left = false } = {}) {
  document.querySelectorAll('.dropdown-menu.floating').forEach((d) => d.remove());
  const menu = h(`<div class="dropdown-menu floating ${left ? 'left' : ''}"></div>`);
  items.forEach((it) => {
    if (it === '-') { menu.appendChild(h('<div class="sep"></div>')); return; }
    const b = h(`<button class="${it.danger ? 'danger' : ''} ${it.active ? 'active' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); menu.remove(); it.onClick(); };
    menu.appendChild(b);
  });
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  if (left) menu.style.left = `${r.left}px`; else menu.style.right = `${window.innerWidth - r.right}px`;
  document.body.appendChild(menu);
  // open upwards when there is no room below (e.g. the user menu at the bottom of the sidebar)
  if (r.bottom + 6 + menu.offsetHeight > window.innerHeight && r.top > menu.offsetHeight + 6) {
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  } else {
    menu.style.top = `${r.bottom + 6}px`;
  }
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${icon('loader', 'spin')}${label ? `<span>${esc(label)}</span>` : ''}`;
  } else if (btn.dataset.html) {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.html;
  }
}

export const loader = (text = t('Loading…')) => `<div class="loader">${icon('loader')}<span>${esc(text)}</span></div>`;
export const empty = (ico, title, text = '', action = '') => `<div class="empty">${icon(ico)}<h3>${esc(title)}</h3><div>${text}</div>${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`;

// ------------------------------------------------------------------ formatting
export function parseTime(v) {
  if (v == null || v === '' || v === 'never') return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  const d = new Date(String(v).trim()
    .replace(' UTC', 'Z')
    .replace(/ ([+-]\d\d):?(\d\d)$/, '$1:$2')
    .replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  return isNaN(d) ? null : d;
}

const AGO = [N_('{n} min ago'), N_('{n} h ago'), N_('{n} d ago')];
const IN = [N_('in {n} min'), N_('in {n} h'), N_('in {n} d')];

export function timeAgo(v) {
  const d = parseTime(v);
  if (!d) return '—';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return s >= 0 ? t('just now') : t('in a moment');
  let n; let unit;
  if (abs < 3600) { n = Math.round(abs / 60); unit = 0; } else if (abs < 86400) { n = Math.round(abs / 3600); unit = 1; } else if (abs < 86400 * 30) { n = Math.round(abs / 86400); unit = 2; } else return d.toLocaleDateString(locale());
  return t((s >= 0 ? AGO : IN)[unit], { n });
}

export function fmtDate(v) {
  const d = parseTime(v);
  return d ? d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
}

export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '—';
  sec = Number(sec);
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
}

export const STATUS = {
  success: { label: N_('Success'), cls: 'success' },
  never: { label: N_('Never backed up'), cls: '' },
  no_connection: { label: N_('No connection'), cls: 'danger' },
  fail: { label: N_('Failed'), cls: 'danger' },
  timeout: { label: N_('Timeout'), cls: 'danger' },
  unknown: { label: N_('Not in Oxidized'), cls: 'warning' },
};

export function statusKey(n) {
  if (!n.in_oxidized && n.in_source) return 'unknown';
  const s = n.status || n.last?.status;
  if (!s) return 'never';
  return String(s);
}

export function statusBadge(key) {
  const s = STATUS[key] || { label: key, cls: 'danger' };
  return `<span class="badge ${s.cls}"><span class="dot"></span>${esc(t(s.label))}</span>`;
}

// ------------------------------------------------------------------ code view
const KW = /^(\s*)(interface|hostname|router|vlan|ip route|config|edit|set|next|end|line|username|snmp-server|access-list|ntp|logging|aaa|crypto|policy-map|class-map|route-map|system|firewall|feature)\b/;
function hlLine(line, needle) {
  let s = esc(line);
  if (/^\s*(!|#)/.test(line)) return `<span class="c-comment">${s}</span>`;
  s = s.replace(KW, (m, sp, kw) => `${sp}<span class="c-kw">${kw}</span>`);
  s = s.replace(/\b(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)\b/g, '<span class="c-ip">$1</span>');
  s = s.replace(/(&quot;[^&]*?&quot;)/g, '<span class="c-str">$1</span>');
  if (needle) {
    const re = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi');
    s = s.replace(re, '<mark>$1</mark>');
  }
  return s;
}

export function codeView(text, { needle = '', highlight = true } = {}) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const rows = lines.map((l, i) => {
    const hit = needle && l.toLowerCase().includes(needle.toLowerCase());
    return `<tr class="${hit ? 'hl' : ''}" data-ln="${i + 1}"><td class="ln">${i + 1}</td><td>${highlight ? hlLine(l, needle) : esc(l)}</td></tr>`;
  }).join('');
  return `<div class="codeview"><table>${rows}</table></div>`;
}

// ------------------------------------------------------------------ diff view
export function diffView(patch, mode = 'unified') {
  const lines = String(patch || '').split('\n');
  if (!patch) return empty('checkCircle', t('No differences'), t('The two versions are identical.'));
  if (mode === 'unified') {
    let a = 0; let b = 0;
    const rows = lines.map((l) => {
      if (l.startsWith('+++') || l.startsWith('---')) return '';
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { a = +m[1]; b = +m[2]; return `<tr class="hunk"><td class="ln"></td><td class="ln"></td><td>${esc(l)}</td></tr>`; }
      if (l.startsWith('+')) return `<tr class="add"><td class="ln"></td><td class="ln">${b++}</td><td>${esc(l)}</td></tr>`;
      if (l.startsWith('-')) return `<tr class="del"><td class="ln">${a++}</td><td class="ln"></td><td>${esc(l)}</td></tr>`;
      return `<tr><td class="ln">${a++}</td><td class="ln">${b++}</td><td>${esc(l)}</td></tr>`;
    }).join('');
    return `<div class="codeview diff"><table>${rows}</table></div>`;
  }
  // side by side
  const rows = [];
  let a = 0; let b = 0; let dels = []; let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i]; const ad = adds[i];
      rows.push(`<tr><td class="ln ${d ? '' : 'empty'}">${d ? d[0] : ''}</td><td class="${d ? 'del-c' : 'empty'}" style="${d ? 'background:var(--diff-del);color:var(--diff-del-text)' : ''}">${d ? esc(d[1]) : ''}</td>
        <td class="ln ${ad ? '' : 'empty'}">${ad ? ad[0] : ''}</td><td class="${ad ? 'add-c' : 'empty'}" style="${ad ? 'background:var(--diff-add);color:var(--diff-add-text)' : ''}">${ad ? esc(ad[1]) : ''}</td></tr>`);
    }
    dels = []; adds = [];
  };
  lines.forEach((l) => {
    if (l.startsWith('+++') || l.startsWith('---')) return;
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (m) { flush(); a = +m[1]; b = +m[2]; rows.push(`<tr class="hunk"><td class="ln"></td><td colspan="3">${esc(l)}</td></tr>`); return; }
    if (l.startsWith('-')) { dels.push([a++, l.slice(1)]); return; }
    if (l.startsWith('+')) { adds.push([b++, l.slice(1)]); return; }
    flush();
    rows.push(`<tr><td class="ln">${a++}</td><td>${esc(l.slice(1))}</td><td class="ln">${b++}</td><td>${esc(l.slice(1))}</td></tr>`);
  });
  flush();
  return `<div class="codeview diff split"><table>${rows.join('')}</table></div>`;
}

// ------------------------------------------------------------------ terminal
export function terminal(el, { max = 20000 } = {}) {
  let paused = false;
  let filter = '';
  let count = 0;
  const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const levelOf = (line) => {
    const m = line.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/);
    return m ? m[1].toLowerCase().replace('warning', 'warn') : '';
  };
  const matches = (text) => !filter || filter.split('|').some((f) => f && text.toLowerCase().includes(f.toLowerCase()));
  return {
    clear() { el.innerHTML = ''; count = 0; },
    setPaused(p) { paused = p; if (!p) el.scrollTop = el.scrollHeight; },
    setFilter(f) {
      filter = f.trim();
      el.querySelectorAll('.l[data-kind="log"]').forEach((n) => { n.style.display = matches(n.dataset.raw || '') ? '' : 'none'; });
    },
    get count() { return count; },
    add(items) {
      const stick = atBottom();
      const frag = document.createDocumentFragment();
      items.forEach((it) => {
        const kind = it.t || 'log';
        const text = it.d ?? '';
        const span = document.createElement('span');
        span.className = kind === 'recv' ? 'l recv' : 'l';
        span.dataset.raw = text;
        span.dataset.kind = kind;
        if (kind === 'log') {
          const m = text.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s(.*)$/);
          const lv = levelOf(text);
          span.innerHTML = m
            ? `<span class="ts">${esc(m[1].slice(11, 19))}</span><span class="lv-${lv}">${esc(m[2])}</span>`
            : `<span class="lv-${lv}">${esc(text)}</span>`;
        } else {
          const ts = it.ts ? new Date(it.ts * 1000).toLocaleTimeString(locale()) : '';
          const pre = { send: '>> ', recv: '', info: '• ', ok: '✓ ', success: '✓ ', warn: '! ', error: '✗ ', done: '■ ' }[kind] ?? '';
          span.innerHTML = `${kind !== 'recv' && ts ? `<span class="ts">${ts}</span>` : ''}<span class="t-${kind}">${esc(pre + text)}</span>`;
        }
        if (kind === 'log' && !matches(text)) span.style.display = 'none';
        frag.appendChild(span);
        count++;
      });
      el.appendChild(frag);
      while (el.childNodes.length > max) el.removeChild(el.firstChild);
      if (!paused && stick) el.scrollTop = el.scrollHeight;
    },
    text() { return Array.from(el.querySelectorAll('.l')).map((n) => n.dataset.raw).join('\n'); },
  };
}

// ------------------------------------------------------------------ charts
export function donut(segments, { size = 150, stroke = 18, center = '' } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  const arcs = segments.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * c;
    const gap = segments.filter((x) => x.value > 0).length > 1 ? 2 : 0;
    const a = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${s.color}" stroke-width="${stroke}" stroke-dasharray="${Math.max(len - gap, 0)} ${c}" stroke-dashoffset="${-off}"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    off += len;
    return a;
  }).join('');
  return `<div class="donut" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}">
    <circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--surface-3)" stroke-width="${stroke}"/>${arcs}</svg>
    <div class="center">${center}</div></div>`;
}

// ------------------------------------------------------------------ theme
export function getThemePref() {
  try { return localStorage.getItem('oxmgr-theme') || 'system'; } catch (e) { return 'system'; }
}
export function applyTheme(pref) {
  try { localStorage.setItem('oxmgr-theme', pref); } catch (e) { /* storage blocked */ }
  const t = pref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', t);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getThemePref() === 'system') applyTheme('system');
});

export function pwField(id, { placeholder = '', value = '', has = false } = {}) {
  return `<div class="input-wrap"><input class="input" type="password" id="${id}" autocomplete="new-password" style="padding-left:11px;padding-right:40px"
    placeholder="${esc(has && !value ? t('•••••••• (type to change)') : placeholder)}" value="${esc(value)}">
    <button type="button" class="btn ghost sm icon suffix" data-toggle-pw="${id}" title="${esc(t('Show / hide'))}">${icon('eye')}</button></div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-toggle-pw]');
  if (!b) return;
  const inp = document.getElementById(b.dataset.togglePw);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  b.innerHTML = icon(inp.type === 'password' ? 'eye' : 'eyeOff');
});
