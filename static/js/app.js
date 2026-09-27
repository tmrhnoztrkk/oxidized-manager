// App shell: first-run setup, session, layout, workspace switching and the hash router
import { api } from './api.js';
import { getLang, LANGS, N_, setLang, t } from './i18n.js';
import { $, applyTheme, avatar, displayName, dropdown, esc, getThemePref, h, icon, loader, modal, pwField, setBusy, toast, toastError } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as devices from './views/devices.js';
import * as device from './views/device.js';
import * as groups from './views/groups.js';
import * as logs from './views/logs.js';
import * as search from './views/search.js';
import * as settingsView from './views/settings.js';
import * as destinations from './views/destinations.js';
import * as workspaces from './views/workspaces.js';
import * as users from './views/users.js';
import * as access from './views/access.js';
import * as audit from './views/audit.js';
import * as mail from './views/mail.js';
import { renderSetup, renderWorkspaceChooser } from './views/setup.js';

export const state = {
  user: null,
  role: null, // global role: admin | user
  me: {},
  workspaces: [],
  iid: null, // selected workspace id
  models: [],
  counts: {},
};

export const current = () => state.workspaces.find((w) => w.id === state.iid);
export const navigate = (hash) => { location.hash = hash; };
export const isAdmin = () => state.role === 'admin';

export const WS_TYPES = {
  local: { label: N_('Embedded'), long: N_('Oxidized running in this container'), icon: 'box' },
  agent: { label: N_('Remote'), long: N_('Remote Oxidized Manager (API key)'), icon: 'cloud' },
  oxidized: { label: N_('Oxidized API'), long: N_('Plain Oxidized REST API (read-only)'), icon: 'eye' },
};

export const ROLES = {
  viewer: { label: N_('Viewer'), desc: N_('Read devices, configs, diffs, logs and backup status') },
  operator: { label: N_('Operator'), desc: N_('Viewer + add/edit/delete devices, trigger backups, connection tests') },
  manager: { label: N_('Manager'), desc: N_('Operator + Oxidized settings, groups, backup destinations, sharing') },
};
const LEVEL = { viewer: 1, operator: 2, manager: 3 };

// Current user's permission in a workspace (admins are managers everywhere)
export const can = (level, w = current()) => !!w && (LEVEL[w.role] || 0) >= LEVEL[level];
// Can the Oxidized process be controlled (embedded here or embedded in a remote manager)
export const canControl = (w = current()) => !!w && (w.type === 'local' || w.type === 'agent');
// Are router.db / config editable (not a plain Oxidized REST API)
export const canEdit = (w = current()) => !!w && w.type !== 'oxidized';
export const roleBadge = (role) => (role ? `<span class="badge ${role === 'manager' ? 'primary' : role === 'operator' ? 'info' : ''}">${esc(t(ROLES[role]?.label || role))}</span>` : '');

const NAV = [
  { section: N_('Workspace'), ws: true },
  { id: 'dashboard', href: '#/', label: N_('Overview'), icon: 'dashboard', ws: true },
  { id: 'devices', href: '#/devices', label: N_('Devices'), icon: 'server', count: 'devices', ws: true },
  { id: 'groups', href: '#/groups', label: N_('Groups & credentials'), icon: 'layers', ws: true, edit: true, need: 'manager' },
  { id: 'search', href: '#/search', label: N_('Config search'), icon: 'search', ws: true },
  { id: 'logs', href: '#/logs', label: N_('Live logs'), icon: 'terminal', ws: true, control: true },
  { id: 'destinations', href: '#/destinations', label: N_('Backup destinations'), icon: 'cloudUp', ws: true },
  { id: 'settings', href: '#/settings', label: N_('Oxidized settings'), icon: 'settings', ws: true, edit: true, need: 'manager' },
  { section: N_('Administration'), admin: true },
  { id: 'workspaces', href: '#/workspaces', label: N_('Workspaces'), icon: 'layers', admin: true },
  { id: 'users', href: '#/users', label: N_('Users & access'), icon: 'users', admin: true },
  { id: 'access', href: '#/access', label: N_('Remote access (API keys)'), icon: 'key', admin: true },
  { id: 'mail', href: '#/mail', label: N_('E-mail (SMTP)'), icon: 'mail', admin: true },
  { id: 'audit', href: '#/audit', label: N_('Audit log'), icon: 'history', audit: true },
];

const ROUTES = [
  { re: /^#?\/?$/, view: dashboard, nav: 'dashboard', needsWs: true },
  { re: /^#\/devices\/?$/, view: devices, nav: 'devices', needsWs: true },
  { re: /^#\/devices\/([^/]+)(?:\/([a-z]+))?$/, view: device, nav: 'devices', needsWs: true, params: ['name', 'tab'] },
  { re: /^#\/groups\/?$/, view: groups, nav: 'groups', needsWs: true, need: 'manager' },
  { re: /^#\/logs\/?$/, view: logs, nav: 'logs', needsWs: true },
  { re: /^#\/search\/?$/, view: search, nav: 'search', needsWs: true },
  { re: /^#\/destinations\/?$/, view: destinations, nav: 'destinations', needsWs: true },
  { re: /^#\/settings(?:\/([a-z]+))?\/?$/, view: settingsView, nav: 'settings', needsWs: true, need: 'manager', params: ['tab'] },
  { re: /^#\/workspaces\/?$/, view: workspaces, nav: 'workspaces', admin: true },
  { re: /^#\/users\/?$/, view: users, nav: 'users', admin: true },
  { re: /^#\/access\/?$/, view: access, nav: 'access', admin: true },
  { re: /^#\/mail\/?$/, view: mail, nav: 'mail', admin: true },
  { re: /^#\/audit\/?$/, view: audit, nav: 'audit' },
];

let cleanup = null;
let routeSeq = 0;

// ------------------------------------------------------------------ session
function renderLogin({ username = '', notice = '' } = {}) {
  document.getElementById('root').innerHTML = '';
  const el = h(`<div class="login-wrap"><form class="card login-card stack" autocomplete="on">
    <div class="brand"><div class="brand-logo">Ox</div><div><div class="brand-name">Oxidized Manager</div><div class="brand-sub">${esc(t('Network configuration backup management'))}</div></div></div>
    <div class="field"><label>${esc(t('Username'))}</label><input class="input" name="username" autocomplete="username" required></div>
    <div class="field"><div class="row between"><label>${esc(t('Password'))}</label><a href="#" class="small" id="forgot-link">${esc(t('Forgot your password?'))}</a></div><input class="input" type="password" name="password" autocomplete="current-password" required></div>
    ${notice ? `<div class="alert success">${icon('checkCircle')}<div class="alert-body">${esc(notice)}</div></div>` : ''}
    <div class="alert danger" id="login-err" style="display:none">${icon('alert')}<div class="alert-body"></div></div>
    <button class="btn primary" type="submit" style="height:38px">${esc(t('Sign in'))}</button>
    <div class="row between small muted"><div class="btn-group" data-lang-btns></div><div class="btn-group" data-theme-btns></div></div>
  </form></div>`);
  document.getElementById('root').appendChild(el);
  themeButtons(el.querySelector('[data-theme-btns]'));
  langButtons(el.querySelector('[data-lang-btns]'));
  const form = el.querySelector('form');
  form.username.value = username;
  (username ? form.password : form.username).focus();
  $('#forgot-link', el).onclick = (e) => { e.preventDefault(); renderForgot(form.username.value.trim()); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    setBusy(btn, true, t('Signing in'));
    try {
      await api.post('/api/auth/login', { username: form.username.value, password: form.password.value }, { noAuthRedirect: true });
      await boot();
    } catch (err) {
      const box = $('#login-err', el);
      box.style.display = '';
      box.querySelector('.alert-body').textContent = err.message;
      setBusy(btn, false);
    }
  };
}

// Small card on the login background (forgot / reset password)
function authCard(inner) {
  const root = document.getElementById('root');
  root.innerHTML = '';
  const el = h(`<div class="login-wrap"><form class="card login-card stack" autocomplete="on">
    <div class="brand"><div class="brand-logo">Ox</div><div><div class="brand-name">Oxidized Manager</div><div class="brand-sub">${esc(t('Network configuration backup management'))}</div></div></div>
    ${inner}</form></div>`);
  root.appendChild(el);
  return el.querySelector('form');
}

function renderForgot(login = '') {
  if (!state.me.reset_enabled) {
    const f = authCard(`<h2>${esc(t('Forgot your password?'))}</h2>
      <div class="alert info">${icon('info')}<div class="alert-body">${esc(t('Password reset by e-mail is not set up on this installation. Ask an administrator to set a new password for you.'))}</div></div>
      <a href="#" class="btn" data-back>${icon('arrowLeft')} ${esc(t('Back to sign in'))}</a>`);
    f.querySelector('[data-back]').onclick = (e) => { e.preventDefault(); renderLogin(); };
    return;
  }
  const f = authCard(`<h2>${esc(t('Forgot your password?'))}</h2>
    <div class="muted">${esc(t('Enter your username or e-mail address. If your account has an e-mail address, we send you a link to choose a new password.'))}</div>
    <div class="field"><label>${esc(t('Username or e-mail'))}</label><input class="input" name="login" autocomplete="username" required></div>
    <div id="fg-result"></div>
    <button class="btn primary" type="submit" style="height:38px">${icon('send')} ${esc(t('Send reset link'))}</button>
    <a href="#" class="btn ghost" data-back>${icon('arrowLeft')} ${esc(t('Back to sign in'))}</a>`);
  f.login.value = login;
  f.login.focus();
  f.querySelector('[data-back]').onclick = (e) => { e.preventDefault(); renderLogin({ username: f.login.value.includes('@') ? '' : f.login.value.trim() }); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true, t('Sending'));
    const box = $('#fg-result', f);
    try {
      await api.post('/api/auth/forgot', { login: f.login.value.trim() }, { noAuthRedirect: true });
      box.innerHTML = `<div class="alert success">${icon('checkCircle')}<div class="alert-body">${esc(t('If an account with an e-mail address matches, a reset link is on its way. It is valid for one hour. Check your spam folder too.'))}</div></div>`;
    } catch (err) {
      box.innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body">${esc(err.message)}</div></div>`;
    }
    setBusy(btn, false);
  };
}

async function renderReset(token) {
  const leave = (opts) => { history.replaceState(null, '', location.pathname); renderLogin(opts); };
  let user;
  try {
    ({ user } = await api.get(`/api/auth/reset/${encodeURIComponent(token)}`, { noAuthRedirect: true }));
  } catch (err) {
    const f = authCard(`<h2>${esc(t('Choose a new password'))}</h2>
      <div class="alert danger">${icon('alert')}<div class="alert-body">${esc(err.message)}</div></div>
      <a href="#" class="btn" data-back>${icon('arrowLeft')} ${esc(t('Back to sign in'))}</a>`);
    f.querySelector('[data-back]').onclick = (e) => { e.preventDefault(); leave(); };
    return;
  }
  const f = authCard(`<h2>${esc(t('Choose a new password'))}</h2>
    <div class="muted">${esc(t('Account'))}: <b>${esc(user)}</b></div>
    <input type="text" name="username" value="${esc(user)}" autocomplete="username" hidden>
    <div class="field"><label>${esc(t('New password'))} <span class="muted small">(${esc(t('at least 8 characters'))})</span></label>${pwField('rs-p1')}</div>
    <div class="field"><label>${esc(t('New password (again)'))}</label>${pwField('rs-p2')}</div>
    <div id="rs-err"></div>
    <button class="btn primary" type="submit" style="height:38px">${icon('save')} ${esc(t('Save password'))}</button>`);
  $('#rs-p1', f).focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = (m) => { $('#rs-err', f).innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body">${esc(m)}</div></div>`; };
    if ($('#rs-p1', f).value !== $('#rs-p2', f).value) { err(t('The new passwords do not match')); return; }
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true);
    try {
      await api.post('/api/auth/reset', { token, password: $('#rs-p1', f).value }, { noAuthRedirect: true });
      leave({ username: user, notice: t('Your password was changed. Sign in with the new password.') });
    } catch (ex) { err(ex.message); setBusy(btn, false); }
  };
}

export function themeButtons(container) {
  const pref = getThemePref();
  container.innerHTML = [['light', 'sun', N_('Light')], ['dark', 'moon', N_('Dark')], ['system', 'monitor', N_('System')]]
    .map(([k, ic, l]) => `<button type="button" class="btn sm ${pref === k ? 'active' : ''}" data-theme-set="${k}" title="${esc(t(l))}">${icon(ic)}</button>`).join('');
  container.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.onclick = () => { applyTheme(b.dataset.themeSet); themeButtons(container); };
  });
}

export function langButtons(container) {
  container.innerHTML = LANGS.map(([k, l]) => `<button type="button" class="btn sm ${getLang() === k ? 'active' : ''}" data-lang="${k}" title="${esc(l)}">${k.toUpperCase()}</button>`).join('');
  container.querySelectorAll('[data-lang]').forEach((b) => {
    b.onclick = () => { if (b.dataset.lang !== getLang()) setLang(b.dataset.lang); };
  });
}

// ------------------------------------------------------------------ layout
function renderShell() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  const el = h(`<div class="app" id="app">
    <aside class="sidebar">
      <div class="brand"><div class="brand-logo">Ox</div><div><div class="brand-name">Oxidized Manager</div><div class="brand-sub">v${esc(state.me.version || '')}</div></div></div>
      <nav class="nav" id="nav"></nav>
      <div class="sidebar-foot stack">
        <div class="row between small muted"><div class="btn-group" id="lang-btns"></div><div class="btn-group" id="theme-btns"></div></div>
        <div class="row" style="gap:6px"><button class="user-chip" id="user-menu" title="${esc(t('Account'))}"></button>
          <button class="btn icon" id="sign-out" style="height:44px;width:44px" title="${esc(t('Sign out'))}" aria-label="${esc(t('Sign out'))}">${icon('logout')}</button></div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn ghost icon menu-toggle" id="menu-toggle" aria-label="${esc(t('Menu'))}">${icon('menu')}</button>
        <button class="instance-switch" id="inst-switch"></button>
        <div class="spacer"></div>
        <button class="btn sm" id="top-reload" title="${esc(t('Make Oxidized reload its node list (re-reads router.db)'))}">${icon('refresh')}<span>${esc(t('Reload'))}</span></button>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`);
  root.appendChild(el);
  themeButtons($('#theme-btns', el));
  langButtons($('#lang-btns', el));
  renderUserChip();
  $('#user-menu', el).onclick = (e) => dropdown(e.currentTarget, [
    { label: t('My profile'), icon: 'user', onClick: profileDialog },
    { label: t('Change password'), icon: 'lock', onClick: () => profileDialog({ password: true }) },
    '-',
    { label: t('Sign out'), icon: 'logout', danger: true, onClick: signOut },
  ], { left: true });
  $('#sign-out', el).onclick = signOut;
  // narrow screens: slide the sidebar in/out; wide screens: collapse it (remembered)
  try { if (localStorage.getItem('oxmgr-nav-collapsed') === '1') el.classList.add('nav-collapsed'); } catch (e) { /* ignore */ }
  $('#menu-toggle', el).onclick = (e) => {
    e.stopPropagation();
    if (matchMedia('(max-width: 900px)').matches) { el.classList.toggle('nav-open'); return; }
    const collapsed = el.classList.toggle('nav-collapsed');
    try { localStorage.setItem('oxmgr-nav-collapsed', collapsed ? '1' : '0'); } catch (err) { /* ignore */ }
  };
  $('.main', el).addEventListener('click', () => el.classList.remove('nav-open'));
  $('#inst-switch', el).onclick = (e) => workspaceMenu(e.currentTarget);
  $('#top-reload', el).onclick = async (e) => {
    if (!state.iid) return;
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      reloadToast(await api.post(`/api/w/${state.iid}/reload`));
      window.dispatchEvent(new CustomEvent('oxmgr:refresh'));
    } catch (err) { toastError(err); }
    setBusy(btn, false);
  };
  renderNav();
  renderWorkspaceSwitch();
}

async function signOut() {
  try { await api.post('/api/auth/logout'); } catch (e) { /* the session is gone anyway */ }
  state.user = null;
  renderLogin();
}

export function renderUserChip() {
  const chip = $('#user-menu');
  if (!chip) return;
  const p = state.me.profile || {};
  const name = displayName(p, state.user);
  const sub = [name !== state.user ? state.user : '', isAdmin() ? t('Admin') : ''].filter(Boolean).join(' · ');
  chip.innerHTML = `${avatar(p, state.user, 28)}<span class="ellipsis"><b>${esc(name)}</b>${sub ? `<span class="chip-sub">${esc(sub)}</span>` : ''}</span>${icon('chevronDown')}`;
}

// My profile: name, e-mail (Gravatar) and password
function profileDialog({ password = false } = {}) {
  const p = state.me.profile || {};
  const m = modal({
    title: `${icon('user')} ${esc(t('My profile'))}`,
    body: `<form class="stack" autocomplete="off">
      <div class="row" style="gap:14px;flex-wrap:nowrap;align-items:center"><span id="pf-avatar">${avatar(p, state.user, 56)}</span>
        <div><b>${esc(state.user)}</b>${isAdmin() ? ` <span class="badge primary">${esc(t('Admin'))}</span>` : ''}
          <div class="small muted">${t('The photo comes from <a href="https://gravatar.com" target="_blank" rel="noopener">Gravatar</a> when your e-mail address has one; otherwise your initials are shown.')}</div></div></div>
      <div class="grid c2">
        <div class="field"><label>${esc(t('First name'))}</label><input class="input" name="first_name" value="${esc(p.first_name || '')}" maxlength="64" autocomplete="given-name"></div>
        <div class="field"><label>${esc(t('Last name'))}</label><input class="input" name="last_name" value="${esc(p.last_name || '')}" maxlength="64" autocomplete="family-name"></div>
      </div>
      <div class="field"><label>${esc(t('E-mail'))}</label><input class="input" type="email" name="email" value="${esc(p.email || '')}" autocomplete="email" placeholder="name@example.com">
        <div class="small muted">${esc(t('Used for password reset links.'))}</div></div>
      <details id="pf-pw" ${password ? 'open' : ''}><summary class="section-title" style="cursor:pointer">${icon('lock')} ${esc(t('Change password'))}</summary>
        <div class="stack" style="margin-top:10px">
          <div class="field"><label>${esc(t('Current password'))}</label><input class="input" type="password" name="cur" autocomplete="current-password"></div>
          <div class="grid c2">
            <div class="field"><label>${esc(t('New password'))} <span class="muted small">(${esc(t('at least 8 characters'))})</span></label><input class="input" type="password" name="n1" autocomplete="new-password"></div>
            <div class="field"><label>${esc(t('New password (again)'))}</label><input class="input" type="password" name="n2" autocomplete="new-password"></div>
          </div></div></details></form>`,
    footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${icon('save')} ${esc(t('Save'))}</button>`,
  });
  const f = m.body.querySelector('form');
  if (password) setTimeout(() => f.cur.focus(), 40);
  m.foot.querySelector('[data-a=no]').onclick = m.close;
  m.foot.querySelector('[data-a=yes]').onclick = async (e) => {
    const changePw = f.cur.value || f.n1.value || f.n2.value;
    if (changePw && f.n1.value !== f.n2.value) { toast(t('The new passwords do not match'), 'warning'); return; }
    setBusy(e.currentTarget, true);
    try {
      if (changePw) {
        await api.put('/api/users/me/password', { current: f.cur.value, new: f.n1.value });
        f.cur.value = ''; f.n1.value = ''; f.n2.value = '';
      }
      state.me.profile = await api.put('/api/profile', { first_name: f.first_name.value, last_name: f.last_name.value, email: f.email.value });
      renderUserChip();
      m.close();
      toast(changePw ? t('Profile and password saved') : t('Profile saved'), 'success');
    } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
  };
}

export function reloadToast(r, okText) {
  if (!r) return;
  if (r.ok) { toast(okText || r.message, 'success'); return; }
  const actions = r.can_restart && can('manager') ? [{ label: t('Restart Oxidized'), primary: true, onClick: () => restartOxidized() }] : [];
  toast(t('Saved, but Oxidized could not be updated: {msg}', { msg: r.message }), 'warning', { actions });
}

export async function restartOxidized() {
  try {
    toast(t('Restarting Oxidized…'), 'info');
    const st = await api.post(`/api/w/${state.iid}/process/restart`);
    if (st.state === 'running') toast(t('Oxidized restarted. The API is ready in a few seconds.'), 'success');
    else toast(t('Oxidized state: {state}', { state: `${st.state}${st.message ? ` — ${st.message}` : ''}` }), 'warning');
    setTimeout(() => window.dispatchEvent(new CustomEvent('oxmgr:refresh')), 4000);
  } catch (e) { toastError(e); }
}

// After a config change: Oxidized has to be restarted
export function restartRequiredToast(msg = t('Config saved. Restart Oxidized to apply the changes.')) {
  toast(msg, 'success', { actions: canControl() && can('manager') ? [{ label: t('Restart now'), primary: true, onClick: restartOxidized }] : [], timeout: 20000 });
}

export function setCount(key, n) {
  state.counts[key] = n;
  const el = document.querySelector(`[data-count="${key}"]`);
  if (el) { el.textContent = n; el.style.display = n == null ? 'none' : ''; }
}

function navVisible(n, w) {
  if (n.admin) return isAdmin();
  if (n.audit) return isAdmin() || state.workspaces.some((x) => x.role === 'manager');
  if (n.ws) {
    if (!w) return !!n.section;
    if (n.edit && !canEdit(w)) return false;
    if (n.control && !canControl(w)) return false;
    if (n.need && !can(n.need, w)) return false;
  }
  return true;
}

function renderNav(active) {
  const nav = $('#nav');
  if (!nav) return;
  const w = current();
  const items = NAV.filter((n) => navVisible(n, w));
  // drop a section title that has no visible items after it
  const cleaned = items.filter((n, i) => !n.section || (items[i + 1] && !items[i + 1].section));
  nav.innerHTML = cleaned.map((n) => (n.section
    ? `<div class="nav-section">${esc(t(n.section))}</div>`
    : `<a href="${n.href}" class="${active === n.id ? 'active' : ''}">${icon(n.icon)}<span>${esc(t(n.label))}</span>${n.count ? `<span class="count" data-count="${n.count}" style="${state.counts[n.count] == null ? 'display:none' : ''}">${state.counts[n.count] ?? ''}</span>` : ''}</a>`)).join('');
  nav.querySelectorAll('a').forEach((a) => { a.onclick = () => $('#app')?.classList.remove('nav-open'); });
}

function renderWorkspaceSwitch() {
  const btn = $('#inst-switch');
  if (!btn) return;
  const w = current();
  btn.innerHTML = w
    ? `${icon(WS_TYPES[w.type]?.icon || 'box')}<span class="ellipsis"><b>${esc(w.name)}</b></span><span class="mode">${esc(t(WS_TYPES[w.type]?.label || ''))}${isAdmin() ? '' : ` · ${esc(t(ROLES[w.role]?.label || ''))}`}</span>${icon('chevronDown')}`
    : `${icon(isAdmin() ? 'plus' : 'layers')}<span>${esc(isAdmin() ? t('Create a workspace') : t('No workspace'))}</span>`;
  const reload = $('#top-reload');
  if (reload) reload.style.display = w && can('operator', w) && w.type !== 'oxidized' ? '' : 'none';
}

function workspaceMenu(anchor) {
  const items = state.workspaces.map((w) => ({
    label: `${w.name}  ·  ${t(WS_TYPES[w.type]?.label || w.type)}${isAdmin() ? '' : `  ·  ${t(ROLES[w.role]?.label || '')}`}`,
    icon: WS_TYPES[w.type]?.icon || 'box',
    active: w.id === state.iid,
    onClick: () => selectWorkspace(w.id),
  }));
  if (isAdmin()) items.push('-', { label: t('Add / manage workspaces…'), icon: 'settings', onClick: () => navigate('#/workspaces') });
  if (!items.length) return;
  dropdown(anchor, items, { left: true });
}

export function selectWorkspace(id) {
  state.iid = id;
  state.counts = {};
  try { localStorage.setItem('oxmgr-ws', id); } catch (e) { /* storage blocked */ }
  renderWorkspaceSwitch();
  route();
}

export async function loadWorkspaces() {
  state.workspaces = await api.get('/api/workspaces');
  let saved = null;
  try { saved = localStorage.getItem('oxmgr-ws'); } catch (e) { /* storage blocked */ }
  if (!state.workspaces.find((w) => w.id === state.iid)) {
    state.iid = (state.workspaces.find((w) => w.id === saved) || state.workspaces[0])?.id || null;
  }
  state.me.has_local = state.workspaces.some((w) => w.type === 'local') || state.me.has_local;
  renderWorkspaceSwitch();
}

// ------------------------------------------------------------------ router
export async function route() {
  if (!state.user) return;
  const [hash, qs] = (location.hash || '#/').split('?');
  let match = null; let r = null;
  for (const rt of ROUTES) {
    match = hash.match(rt.re);
    if (match) { r = rt; break; }
  }
  if (!r) { navigate('#/'); return; }
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  document.querySelectorAll('.overlay, .dropdown-menu.floating').forEach((o) => o.remove());
  renderNav(r.nav);
  const view = $('#view');
  if (r.admin && !isAdmin()) { navigate('#/'); return; }
  if (r.needsWs && !current()) {
    view.innerHTML = '';
    view.appendChild(h(isAdmin()
      ? `<div class="card"><div class="empty">${icon('layers')}<h3>${esc(t('No workspace yet'))}</h3>
        <div>${esc(t('Run Oxidized in this container or connect to a remote Oxidized.'))}</div>
        <div style="margin-top:14px"><a class="btn primary" href="#/workspaces">${icon('plus')} ${esc(t('Create a workspace'))}</a></div></div></div>`
      : `<div class="card"><div class="empty">${icon('lock')}<h3>${esc(t('No workspace has been shared with you yet'))}</h3>
        <div>${esc(t('Ask an administrator to give you access to a workspace.'))}</div></div></div>`));
    return;
  }
  if (r.need && !can(r.need)) {
    view.innerHTML = `<div class="card"><div class="empty">${icon('lock')}<h3>${esc(t('No permission'))}</h3><div>${esc(t('This page requires the {role} role in this workspace.', { role: t(ROLES[r.need].label) }))}</div></div></div>`;
    return;
  }
  const params = { query: Object.fromEntries(new URLSearchParams(qs || '')) };
  (r.params || []).forEach((p, i) => { params[p] = match[i + 1] ? decodeURIComponent(match[i + 1]) : undefined; });
  // A fresh container per navigation: a late response of the old page cannot overwrite the new one
  const seq = ++routeSeq;
  const pageEl = document.createElement('div');
  pageEl.innerHTML = loader();
  view.replaceChildren(pageEl);
  window.scrollTo(0, 0);
  try {
    const done = await r.view.render(pageEl, params) || null;
    if (seq === routeSeq) cleanup = done;
    else if (done) done(); // navigated away in the meantime
  } catch (e) {
    if (seq !== routeSeq) return;
    console.error(e);
    pageEl.innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body"><b>${esc(t('The page could not be loaded'))}</b><br>${esc(e.message || e)}</div></div>`;
  }
}

// A password reset link (#/reset/<token>) opens the reset form, whether or not someone is signed in
function resetLink() {
  const m = location.hash.match(/^#\/reset\/([\w-]+)$/);
  if (m) renderReset(m[1]);
  return !!m;
}

export async function boot() {
  const me = await api.get('/api/auth/me', { noAuthRedirect: true });
  state.me = me;
  if (me.needs_setup) { renderSetup(); return; }
  if (resetLink()) return;
  if (!me.user) { renderLogin(); return; }
  state.user = me.user;
  state.role = me.role;
  await loadWorkspaces();
  state.models = await api.get('/api/models').catch(() => []);
  // Offer the workspace chooser only on a fresh start: not after "Skip for now" and not on a reload of a page
  // (e.g. after switching the language), so the admin stays where they were
  let skipped = false;
  try { skipped = localStorage.getItem('oxmgr-skip-chooser') === '1'; } catch (e) { /* storage blocked */ }
  const onPage = !['', '#', '#/'].includes(location.hash);
  if (!state.workspaces.length && isAdmin() && !skipped && !onPage) { renderWorkspaceChooser(); return; }
  renderShell();
  route();
}

// Enter the main shell after a workspace was created (from the wizard)
export async function enterApp(wid) {
  if (wid) {
    state.iid = wid;
    try { localStorage.setItem('oxmgr-ws', wid); } catch (e) { /* storage blocked */ }
  }
  state.me = await api.get('/api/auth/me', { noAuthRedirect: true });
  state.role = state.me.role;
  await loadWorkspaces();
  renderShell();
  navigate(wid ? '#/' : '#/workspaces');
  route();
}

window.addEventListener('hashchange', () => { if (!resetLink()) route(); });
window.addEventListener('oxmgr:unauthorized', () => { if (state.user) { state.user = null; renderLogin(); toast(t('Your session has expired'), 'warning'); } });
boot().catch((e) => {
  document.getElementById('root').innerHTML = `<div class="content"><div class="alert danger">${icon('alert')}<div class="alert-body">${esc(e.message)}</div></div></div>`;
});
