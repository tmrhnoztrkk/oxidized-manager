import { iapi } from '../api.js';
import { N_, t, tn } from '../i18n.js';
import { canControl, canEdit, current, reloadToast, restartOxidized, restartRequiredToast, state } from '../app.js';
import { $, $$, codeView, confirmDialog, download, empty, esc, fmtBytes, fmtDate, icon, loader, modal, pwField, setBusy, timeAgo, toast, toastError } from '../ui.js';
import { getConfigSummary, invalidateConfig } from './components.js';

const TABS = [
  ['general', N_('General'), 'settings'],
  ['schema', N_('router.db schema'), 'columns'],
  ['raw', N_('Config (YAML)'), 'fileCode'],
  ['routerdb', N_('router.db'), 'database'],
  ['backups', N_('File backups'), 'history'],
];

const SECTIONS = [
  [N_('Default credentials'), [
    ['username', N_('Global username'), 'text'], ['password', N_('Global password'), 'password'], ['model', N_('Default model'), 'model'],
  ]],
  [N_('Schedule & performance'), [
    ['interval', N_('Backup interval (s)'), 'number', N_('Every device is backed up at this interval (3600 = hourly)')],
    ['timeout', N_('Timeout (s)'), 'number'], ['retries', N_('Retries'), 'number'],
    ['threads', N_('Threads'), 'number'], ['use_max_threads', N_('Use the maximum number of threads'), 'bool'],
    ['next_adds_job', N_('"next" adds a new job'), 'bool'],
  ]],
  [N_('Connection'), [
    ['input.default', N_('Default protocol'), 'text', N_('e.g. ssh, telnet')],
    ['input.ssh.secure', N_('Verify SSH host keys'), 'bool'],
    ['input.debug', N_('Input debug (write device traffic to logs/)'), 'bool'],
    ['input.utf8_encoded', N_('UTF-8 output'), 'bool'],
    ['resolve_dns', N_('Resolve DNS'), 'bool'],
  ]],
  [N_('Logging'), [
    ['debug', N_('Oxidized debug logging'), 'bool', N_('Verbose output in the live log')],
    ['use_syslog', N_('Use syslog'), 'bool'],
  ]],
  [N_('Output (git)'), [
    ['output.default', N_('Output type'), 'text', N_('git, file, gitcrypt, http')],
    ['output.git.user', N_('Git user name'), 'text'], ['output.git.email', N_('Git e-mail'), 'text'],
    ['output.git.repo', N_('Git repository path'), 'text'], ['output.git.single_repo', N_('Single repository'), 'bool'],
  ]],
];

export async function render(view, params) {
  const tab = params.tab || 'general';
  const inst = current();
  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(t('Oxidized settings'))}</h1><div class="sub">${esc(inst.name)} · ${esc(t('every change is backed up first; comments are preserved'))}</div></div>
      <div class="actions">${canControl(inst) ? `<button class="btn" id="st-restart">${icon('power')} ${esc(t('Restart Oxidized'))}</button>` : ''}</div></div>
    <nav class="tabs">${TABS.map(([k, l, ic]) => `<a href="#/settings/${k}" class="${tab === k ? 'active' : ''}">${icon(ic)}${esc(t(l))}</a>`).join('')}</nav>
    <div id="st-body">${loader()}</div>`;
  $('#st-restart', view)?.addEventListener('click', async () => {
    if (await confirmDialog({ title: t('Restart Oxidized?'), message: esc(t('Running backups are interrupted and the in-memory run history is reset.')), confirm: t('Restart') })) restartOxidized();
  });
  const body = $('#st-body', view);
  if (!canEdit(inst)) {
    body.innerHTML = `<div class="alert info">${icon('info')}<div class="alert-body">${esc(t('This workspace is a plain Oxidized REST API (read-only); the config cannot be edited.'))}</div></div>`;
    return null;
  }
  const api = iapi(state.iid);
  try {
    if (tab === 'schema') return await schemaTab(body, api);
    if (tab === 'raw') return await rawTab(body, api);
    if (tab === 'routerdb') return await routerdbTab(body, api);
    if (tab === 'backups') return await backupsTab(body, api);
    return await generalTab(body, api);
  } catch (e) {
    body.innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body">${esc(e.message)}</div></div>`;
    return null;
  }
}

// ------------------------------------------------------------------ general
async function generalTab(el, api) {
  invalidateConfig();
  const cfg = await getConfigSummary(true);
  const s = cfg.settings;
  const field = ([key, label, type, hint]) => {
    const id = `set-${key.replace(/\./g, '_')}`;
    const lb = esc(t(label));
    const hn = hint ? `<span class="hint">${esc(t(hint))}</span>` : '';
    if (type === 'bool') {
      return `<div class="field"><label class="switch"><input type="checkbox" id="${id}" data-key="${key}" data-type="bool" ${s[key] ? 'checked' : ''}><span class="track"></span><span>${lb}</span></label>${hn}</div>`;
    }
    if (type === 'password') return `<div class="field"><label>${lb}</label>${pwField(id, { has: s.has_password })}<span class="hint">${esc(t('Unchanged when left empty'))}</span></div>`.replace(`id="${id}"`, `id="${id}" data-key="${key}" data-type="password"`);
    const list = type === 'model' ? 'list="set-models"' : '';
    return `<div class="field"><label>${lb}</label><input class="input" id="${id}" data-key="${key}" data-type="${type === 'number' ? 'number' : 'text'}" ${list} type="${type === 'number' ? 'number' : 'text'}" value="${esc(s[key] ?? '')}">${hn}</div>`;
  };
  el.innerHTML = `<form id="st-form" class="stack" autocomplete="off">
    ${SECTIONS.map(([title, fields]) => `<div class="card"><div class="card-head"><h3>${esc(t(title))}</h3></div><div class="card-body"><div class="grid c3">${fields.map(field).join('')}</div></div></div>`).join('')}
    <div class="card"><div class="card-head"><h3>${esc(t('Prompt regex'))}</h3></div><div class="card-body">
      <div class="field"><input class="input mono" id="set-prompt" value="${esc(cfg.prompt)}"><span class="hint">${esc(t('The !ruby/regexp tag is kept. Example:'))} /^([\\w.@:\\/-]+[#>]\\s?)$/</span></div></div></div>
    <div class="card"><div class="card-head"><h3>${esc(t('Hooks'))}</h3><span class="small muted">(${esc(t('edit them on the Config (YAML) tab'))})</span></div><div class="card-body">
      ${cfg.hooks.length ? cfg.hooks.map((hk) => `<div class="row" style="margin-bottom:6px"><span class="badge primary">${esc(hk.name)}</span><span class="mono small">${esc(hk.type)}</span><span class="small muted">${esc((hk.events || []).join(', '))}</span><span class="small mono">${esc(hk.remote_repo || '')}</span></div>`).join('') : `<span class="muted">${esc(t('No hooks'))}</span>`}
      <div class="small muted" style="margin-top:8px">${icon('cloudUp')} ${t('Tip: to push backups to GitHub / GitLab you do not need a hook — use <a href="#/destinations">Backup destinations</a>.')}</div>
    </div></div>
    <datalist id="set-models">${state.models.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    <div class="row" style="justify-content:flex-end;position:sticky;bottom:12px"><button class="btn primary" type="submit" style="box-shadow:var(--shadow-lg)">${icon('save')} ${esc(t('Save'))}</button></div>
  </form>`;
  const initial = {};
  $$('[data-key]', el).forEach((i) => { initial[i.dataset.key] = i.dataset.type === 'bool' ? i.checked : i.value; });
  $('#st-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const values = {};
    $$('[data-key]', el).forEach((i) => {
      const v = i.dataset.type === 'bool' ? i.checked : i.value.trim();
      if (i.dataset.type === 'password') { if (v) values[i.dataset.key] = v; return; }
      if (v !== initial[i.dataset.key]) values[i.dataset.key] = v;
    });
    const prompt = $('#set-prompt', el).value.trim();
    const promptChanged = prompt !== cfg.prompt;
    if (!Object.keys(values).length && !promptChanged) { toast(t('Nothing changed'), 'info'); return; }
    const btn = e.submitter;
    setBusy(btn, true, t('Saving'));
    try {
      await api.cfgSettings(values, promptChanged ? prompt : undefined);
      invalidateConfig();
      restartRequiredToast();
      generalTab(el, api);
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
  return null;
}

// ------------------------------------------------------------------ schema
async function schemaTab(el, api) {
  invalidateConfig();
  const cfg = await getConfigSummary(true);
  const src = cfg.source;
  const cols = [];
  Object.entries(src.map).forEach(([k, i]) => cols.push({ i, k, kind: 'map' }));
  Object.entries(src.vars_map).forEach(([k, i]) => cols.push({ i, k, kind: 'vars_map' }));
  cols.sort((a, b) => a.i - b.i);
  const max = cols.length ? Math.max(...cols.map((c) => c.i)) : 0;
  const sample = Array.from({ length: max + 1 }, (_, i) => cols.filter((c) => c.i === i).map((c) => c.k).join('/') || '·');
  const fixable = src.issues.filter((x) => x.fix);
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h3>${icon('columns')} ${esc(t('Column mapping'))}</h3>
      <span class="small muted">${esc(t('file'))}: <code>${esc(src.file)}</code> · ${esc(t('delimiter'))}: <code>${esc(src.delimiter)}</code></span></div>
      <div class="card-body">
        <div class="codeview" style="padding:12px;margin-bottom:14px;white-space:pre">${esc(sample.join(src.delimiter.length === 1 ? src.delimiter : ':'))}</div>
        <table class="table"><thead><tr><th>${esc(t('Column'))}</th><th>${esc(t('Key'))}</th><th>${esc(t('Section'))}</th><th>${esc(t('Meaning'))}</th></tr></thead><tbody>
        ${cols.map((c) => `<tr><td class="mono">${c.i}</td><td class="mono"><b>${esc(c.k)}</b></td><td><span class="badge ${c.kind === 'map' ? 'primary' : 'info'}">${c.kind}</span></td>
          <td class="small muted">${esc(c.kind === 'map' ? t('Node attribute (read directly by Oxidized)') : t('Node variable (vars) — used by model / input code'))}</td></tr>`).join('')}
        </tbody></table></div></div>
    <div class="card"><div class="card-head"><h3>${icon('shield')} ${esc(t('Checks'))}</h3>
      <div class="actions">${fixable.length ? `<button class="btn sm primary" id="sc-fixall">${icon('zap')} ${esc(t('Fix all ({n})', { n: fixable.length }))}</button>` : ''}</div></div>
      <div class="card-body stack">
        ${src.issues.length ? src.issues.map((x) => `<div class="alert ${x.level === 'error' ? 'danger' : x.level === 'warning' ? 'warning' : 'info'}">${icon(x.level === 'info' ? 'info' : 'alert')}
          <div class="alert-body">${esc(x.message)}${x.fix ? `<div class="row" style="margin-top:8px"><span class="small muted">${esc(x.fix)}</span><button class="btn sm" data-fix="${esc(x.code)}">${esc(t('Fix'))}</button></div>` : ''}</div></div>`).join('')
          : `<div class="alert success">${icon('checkCircle')}<div class="alert-body">${esc(t('The schema is fine: every field can be set per device.'))}</div></div>`}
        <div class="small muted">${esc(t('New columns are appended after the existing ones; existing lines stay valid (a missing column means the group / global value). The change is written to the config file and needs an Oxidized restart.'))}</div>
      </div></div>`;
  const fix = async (codes, btn) => {
    setBusy(btn, true);
    try { await api.schemaFix(codes); invalidateConfig(); restartRequiredToast(t('Schema updated. Restart Oxidized to apply.')); schemaTab(el, api); } catch (e) { toastError(e); setBusy(btn, false); }
  };
  $$('[data-fix]', el).forEach((b) => { b.onclick = () => fix([b.dataset.fix], b); });
  $('#sc-fixall', el)?.addEventListener('click', (e) => fix(fixable.map((x) => x.code), e.currentTarget));
  return null;
}

// ------------------------------------------------------------------ editor helpers
function editor(el, text, { rows = 30 } = {}) {
  el.innerHTML = `<textarea class="input code" spellcheck="false" rows="${rows}" style="min-height:60vh">${esc(text)}</textarea>`;
  const ta = el.querySelector('textarea');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('  ', s, ta.selectionEnd, 'end');
    }
  });
  return ta;
}

async function rawTab(el, api) {
  const text = await api.cfgRaw();
  el.innerHTML = `<div class="card"><div class="toolbar">
      <span class="small muted">${icon('lock')} ${esc(t('The file contains passwords in plain text'))}</span><div style="flex:1"></div>
      <span id="rv-status" class="small"></span>
      <button class="btn sm" id="rv-validate">${icon('check')} ${esc(t('Validate'))}</button>
      <button class="btn sm" id="rv-dl">${icon('download')} ${esc(t('Download'))}</button>
      <button class="btn sm" id="rv-reset">${icon('undo')} ${esc(t('Revert'))}</button>
      <button class="btn sm primary" id="rv-save">${icon('save')} ${esc(t('Save'))}</button></div>
    <div class="card-body" id="rv-ed"></div></div>`;
  const ta = editor($('#rv-ed', el), text);
  const status = (ok, msg) => { $('#rv-status', el).innerHTML = `<span style="color:var(--${ok ? 'success' : 'danger'})">${esc(msg)}</span>`; };
  const validate = async () => {
    const r = await api.cfgValidate(ta.value);
    if (r.ok) status(true, r.warnings.length ? `${t('Valid')} · ${r.warnings.join('; ')}` : t('Valid YAML'));
    else status(false, r.error);
    return r.ok;
  };
  $('#rv-validate', el).onclick = () => validate().catch(toastError);
  $('#rv-dl', el).onclick = () => download('config', ta.value);
  $('#rv-reset', el).onclick = () => { ta.value = text; $('#rv-status', el).textContent = ''; };
  $('#rv-save', el).onclick = async (e) => {
    const btn = e.currentTarget;
    if (!await validate()) return;
    if (!await confirmDialog({ title: t('Save the config?'), message: esc(t('A backup of the current file is taken first.')), confirm: t('Save') })) return;
    setBusy(btn, true);
    try { await api.cfgPutRaw(ta.value); invalidateConfig(); restartRequiredToast(); rawTab(el, api); } catch (err) { toastError(err); setBusy(btn, false); }
  };
  return null;
}

async function routerdbTab(el, api) {
  const text = await api.routerdbRaw();
  el.innerHTML = `<div class="card"><div class="toolbar">
      <span class="small muted">${esc(t('Lines must follow the schema of the config. Lines starting with # are comments.'))}</span><div style="flex:1"></div>
      <span class="small muted" id="rd-count"></span>
      <button class="btn sm" id="rd-dl">${icon('download')} ${esc(t('Download'))}</button>
      <button class="btn sm" id="rd-reset">${icon('undo')} ${esc(t('Revert'))}</button>
      <button class="btn sm primary" id="rd-save">${icon('save')} ${esc(t('Save & reload'))}</button></div>
    <div class="card-body" id="rd-ed"></div></div>`;
  const ta = editor($('#rd-ed', el), text);
  const count = () => { $('#rd-count', el).textContent = tn('{n} device line', '{n} device lines', ta.value.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l)).length); };
  ta.addEventListener('input', count); count();
  $('#rd-dl', el).onclick = () => download('router.db', ta.value);
  $('#rd-reset', el).onclick = () => { ta.value = text; count(); };
  $('#rd-save', el).onclick = async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    try { const r = await api.routerdbPut(ta.value); reloadToast(r.reload, t('router.db saved ({n} devices) and Oxidized reloaded', { n: r.nodes })); routerdbTab(el, api); } catch (err) { toastError(err); setBusy(btn, false); }
  };
  return null;
}

async function backupsTab(el, api) {
  const items = await api.backups();
  el.innerHTML = `<div class="card">${items.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${esc(t('File'))}</th><th>${esc(t('Backup'))}</th><th>${esc(t('Size'))}</th><th>${esc(t('Time'))}</th><th></th></tr></thead><tbody>
    ${items.map((b) => `<tr><td><span class="badge ${b.file === 'config' ? 'primary' : 'info'}">${b.file === 'config' ? 'config' : 'router.db'}</span></td>
      <td class="mono small">${esc(b.name)}</td><td class="small">${fmtBytes(b.size)}</td><td class="small" title="${esc(fmtDate(b.mtime))}">${timeAgo(b.mtime)}</td>
      <td class="actions"><button class="btn sm" data-view="${esc(b.name)}">${icon('eye')} ${esc(t('View'))}</button>
        <button class="btn sm" data-restore="${esc(b.name)}">${icon('undo')} ${esc(t('Restore'))}</button></td></tr>`).join('')}
    </tbody></table></div>` : empty('history', t('No backups'), esc(t('A copy of the file is kept here before every change made through the panel (latest 50).')))}</div>`;
  $$('[data-view]', el).forEach((b) => {
    b.onclick = async () => {
      try { const tx = await api.backup(b.dataset.view); modal({ title: esc(b.dataset.view), size: 'xl', body: codeView(tx, { highlight: false }), footer: null }); } catch (e) { toastError(e); }
    };
  });
  $$('[data-restore]', el).forEach((b) => {
    b.onclick = async () => {
      if (!await confirmDialog({ title: t('Restore this backup?'), message: t('<code>{name}</code> replaces the current file (the current version is backed up too).', { name: esc(b.dataset.restore) }), confirm: t('Restore'), danger: true })) return;
      try {
        const r = await api.restore(b.dataset.restore);
        invalidateConfig();
        if (r.restart_required) restartRequiredToast(t('Config restored.')); else reloadToast(r.reload, t('router.db restored'));
        backupsTab(el, api);
      } catch (e) { toastError(e); }
    };
  });
  return null;
}
