// Shared components: device form, live connection test console, bulk edit
import { iapi, openStream } from '../api.js';
import { N_, t, tn } from '../i18n.js';
import { can, reloadToast, state } from '../app.js';
import { $, copyText, download, esc, icon, modal, pwField, setBusy, terminal, toast, toastError } from '../ui.js';

export const INPUT_OPTIONS = [
  ['', N_('Default (group / global)')],
  ['ssh', N_('SSH')],
  ['telnet', N_('Telnet')],
  ['ssh,telnet', N_('SSH, fall back to Telnet')],
  ['telnet,ssh', N_('Telnet, fall back to SSH')],
  ['scp', N_('SCP')],
  ['http', N_('HTTP')],
];

let cfgCache = { iid: null, at: 0, data: null };
export async function getConfigSummary(force = false) {
  if (!force && cfgCache.iid === state.iid && Date.now() - cfgCache.at < 15000) return cfgCache.data;
  const data = await iapi(state.iid).cfg();
  cfgCache = { iid: state.iid, at: Date.now(), data };
  return data;
}
export const invalidateConfig = () => { cfgCache.at = 0; };

// ------------------------------------------------------------------ live test console
// getParams() → parameters sent to ws/test
export function testConsole(container, getParams, { tall = false } = {}) {
  container.innerHTML = `
    <div class="term-bar">
      <span class="live-dot" id="tc-dot"></span><b id="tc-state">${esc(t('Ready'))}</b>
      <div style="flex:1"></div>
      <select class="select" id="tc-proto" style="width:auto;height:30px" title="${esc(t('Protocol'))}">
        <option value="">${esc(t('Protocol: device setting'))}</option><option value="ssh">SSH</option><option value="telnet">Telnet</option></select>
      <input class="input" id="tc-cmds" style="width:260px;height:30px" placeholder="${esc(t('Commands (separate with ;) — empty: model default'))}">
      <button class="btn sm primary" id="tc-run">${icon('play')} ${esc(t('Connect & test'))}</button>
      <button class="btn sm" id="tc-stop" disabled>${icon('stop')} ${esc(t('Stop'))}</button>
      <button class="btn sm ghost icon" id="tc-copy" title="${esc(t('Copy'))}">${icon('copy')}</button>
      <button class="btn sm ghost icon" id="tc-dl" title="${esc(t('Download'))}">${icon('download')}</button>
    </div>
    <div class="terminal ${tall ? 'tall' : ''}" id="tc-term"><span class="l t-info">• ${esc(t('"Connect & test" makes the panel connect to the device with the settings Oxidized would use (device → group → global) and shows all traffic here.'))}</span></div>`;
  const term = terminal($('#tc-term', container));
  let stream = null;
  const setRunning = (on) => {
    $('#tc-dot', container).classList.toggle('on', on);
    $('#tc-state', container).textContent = on ? t('Connected — running') : t('Ready');
    $('#tc-run', container).disabled = on;
    $('#tc-stop', container).disabled = !on;
  };
  $('#tc-run', container).onclick = () => {
    const p = getParams();
    if (!p) return;
    const cmds = $('#tc-cmds', container).value.split(';').map((s) => s.trim()).filter(Boolean);
    if (cmds.length) p.commands = cmds;
    const proto = $('#tc-proto', container).value;
    if (proto) p.protocol = proto;
    term.clear();
    setRunning(true);
    let result = null;
    stream = openStream(`/api/w/${state.iid}/ws/test`, {
      initial: p,
      onItems: (items) => {
        term.add(items);
        items.forEach((it) => { if (it.t === 'error') result = 'error'; else if (it.t === 'success') result = result || 'ok'; });
      },
      onEnd: () => {
        setRunning(false);
        stream = null;
        if (result === 'ok') $('#tc-state', container).innerHTML = `<span style="color:var(--success)">${esc(t('Successful'))}</span>`;
        else if (result === 'error') $('#tc-state', container).innerHTML = `<span style="color:var(--danger)">${esc(t('Failed'))}</span>`;
      },
    });
  };
  $('#tc-stop', container).onclick = () => stream && stream.stop();
  $('#tc-copy', container).onclick = () => copyText(term.text());
  $('#tc-dl', container).onclick = () => download(`test-${Date.now()}.log`, term.text());
  return () => stream && stream.close();
}

// ------------------------------------------------------------------ device form
export async function openDeviceForm(node = null, { onSaved } = {}) {
  const isEdit = !!node;
  const api = iapi(state.iid);
  let cfg = null;
  try { cfg = await getConfigSummary(); } catch (e) { toastError(e); return; }
  const cols = new Set([...Object.keys(cfg.source.map), ...Object.keys(cfg.source.vars_map)]);
  const groups = Object.keys(cfg.groups);
  const src = node || {};
  const glob = cfg.settings;
  let m = null;
  const inheritHint = (key) => {
    const gname = () => $('#df-group', m.body)?.value;
    const g = cfg.groups[gname()] || {};
    if (key === 'username') return g.username ? t("Empty → group '{g}': {v}", { g: gname(), v: g.username }) : glob.username ? t('Empty → global: {v}', { v: glob.username }) : '';
    if (key === 'password') return g.has_password ? t("Empty → password of group '{g}'", { g: gname() }) : glob.has_password ? t('Empty → global password') : t('No password defined anywhere!');
    if (key === 'enable') return g.has_enable ? t("Empty → enable password of group '{g}'", { g: gname() }) : t('Leave empty if enable is not needed');
    if (key === 'ssh_port') return g.vars?.ssh_port ? t('Group: {v}', { v: g.vars.ssh_port }) : t('Default 22');
    if (key === 'telnet_port') return g.vars?.telnet_port ? t('Group: {v}', { v: g.vars.telnet_port }) : t('Default 23');
    if (key === 'input') return t('Default: {v}', { v: g.input || glob['input.default'] || 'ssh' });
    return '';
  };
  const dis = (key) => (cols.has(key) ? '' : 'disabled');
  const noCol = (key) => (cols.has(key) ? '' : `<span class="hint warn">${esc(t("router.db has no '{key}' column", { key }))}${can('manager') ? ` — <a href="#/settings/schema">${esc(t('add it to the schema'))}</a>` : ''}</span>`);

  const body = document.createElement('div');
  body.innerHTML = `
    <form id="df" class="stack" autocomplete="off">
      <div class="section-title">${esc(t('Identity & network'))}</div>
      <div class="grid c2">
        <div class="field"><label>${esc(t('Device name'))} *</label><input class="input" id="df-name" required value="${esc(src.name || '')}" placeholder="CORE-SW01">
          ${isEdit ? `<span class="hint">${esc(t('Renaming creates a new file in the Oxidized git history.'))}</span>` : ''}</div>
        <div class="field"><label>${esc(t('IP / hostname'))} *</label><input class="input mono" id="df-ip" ${dis('ip')} value="${esc(src.ip || '')}" placeholder="10.0.0.1">${noCol('ip')}</div>
        <div class="field"><label>${esc(t('Model'))} *</label><input class="input" id="df-model" list="df-models" value="${esc(src.model || '')}" placeholder="ios, fortigate, junos…">
          <datalist id="df-models">${state.models.map((x) => `<option value="${esc(x)}">`).join('')}${Object.keys(cfg.model_map).map((x) => `<option value="${esc(x)}">→ ${esc(cfg.model_map[x])}</option>`).join('')}</datalist>
          <span class="hint">model_map: ${Object.entries(cfg.model_map).map(([a, b]) => `${esc(a)}→${esc(b)}`).join(', ') || '—'}</span></div>
        <div class="field"><label>${esc(t('Group'))}</label><input class="input" id="df-group" list="df-groups" ${dis('group')} value="${esc(src.group || '')}" placeholder="${esc(t('pick or type a group'))}">
          <datalist id="df-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
          <span class="hint" id="df-group-hint"></span>${noCol('group')}</div>
      </div>
      <div class="section-title" style="margin-top:8px">${esc(t('Connection'))}</div>
      <div class="grid c3">
        <div class="field"><label>${esc(t('Protocol (input)'))}</label><select class="select" id="df-input" ${dis('input')}>
          ${INPUT_OPTIONS.map(([v, l]) => `<option value="${v}" ${(src.input || '') === v ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}
          ${src.input && !INPUT_OPTIONS.find(([v]) => v === src.input) ? `<option value="${esc(src.input)}" selected>${esc(src.input)}</option>` : ''}
          </select><span class="hint" data-hint="input"></span>${noCol('input')}</div>
        <div class="field"><label>${esc(t('SSH port'))}</label><input class="input" type="number" min="1" max="65535" id="df-ssh_port" ${dis('ssh_port')} value="${esc(src.ssh_port || '')}" placeholder="22"><span class="hint" data-hint="ssh_port"></span>${noCol('ssh_port')}</div>
        <div class="field"><label>${esc(t('Telnet port'))}</label><input class="input" type="number" min="1" max="65535" id="df-telnet_port" ${dis('telnet_port')} value="${esc(src.telnet_port || '')}" placeholder="23"><span class="hint" data-hint="telnet_port"></span>${noCol('telnet_port')}</div>
      </div>
      <div class="section-title" style="margin-top:8px">${esc(t('Device-specific credentials'))}</div>
      <div class="grid c3">
        <div class="field"><label>${icon('user')} ${esc(t('Username'))}</label><input class="input" id="df-username" ${dis('username')} value="${esc(src.username || '')}" autocomplete="off"><span class="hint" data-hint="username"></span>${noCol('username')}</div>
        <div class="field"><label>${icon('key')} ${esc(t('Password'))}</label>${pwField('df-password', { has: src.has_password })}
          ${src.has_password ? `<label class="chk small"><input type="checkbox" id="df-clear-password"> ${esc(t('Remove the device password (use the group one)'))}</label>` : ''}<span class="hint" data-hint="password"></span>${noCol('password')}</div>
        <div class="field"><label>${icon('lock')} ${esc(t('Enable password'))}</label>${pwField('df-enable', { has: src.has_enable })}
          ${src.has_enable ? `<label class="chk small"><input type="checkbox" id="df-clear-enable"> ${esc(t('Remove the enable password'))}</label>` : ''}<span class="hint" data-hint="enable"></span>${noCol('enable')}</div>
      </div>
      <div class="alert info small" id="df-delim" style="display:none">${icon('info')}<div class="alert-body"></div></div>
      ${!isEdit ? `<label class="chk"><input type="checkbox" id="df-fetch" checked> ${esc(t('Back up right after saving (front of the queue)'))}</label>` : ''}
      <details id="df-test-wrap"><summary class="btn sm" style="list-style:none;display:inline-flex">${icon('terminal')} ${esc(t('Test the connection before saving'))}</summary>
        <div id="df-test" style="margin-top:12px"></div></details>
    </form>`;
  m = modal({
    title: isEdit ? `${icon('edit')} ${esc(t('Edit {name}', { name: src.name }))}` : `${icon('plus')} ${esc(t('New device'))}`,
    size: 'lg', body,
    footer: `<span class="muted small" style="margin-right:auto">${esc(t('router.db changes → Oxidized is reloaded'))}</span>
      <button class="btn" data-a="cancel">${esc(t('Cancel'))}</button><button class="btn primary" data-a="save">${icon('save')} ${esc(t('Save'))}</button>`,
  });
  ['password', 'enable'].forEach((k) => { if (!cols.has(k)) { const i = $(`#df-${k}`, body); if (i) i.disabled = true; } });

  const refreshHints = () => {
    body.querySelectorAll('[data-hint]').forEach((el) => { el.textContent = inheritHint(el.dataset.hint); });
    const g = $('#df-group', body).value;
    $('#df-group-hint', body).textContent = g && !cfg.groups[g] ? t("'{g}' is not a group defined in the config — no group credentials apply.", { g }) : '';
    $('#df-group-hint', body).className = `hint ${g && !cfg.groups[g] ? 'warn' : ''}`;
  };
  refreshHints();
  $('#df-group', body).addEventListener('input', refreshHints);
  const delimCheck = () => {
    const bad = ['df-password', 'df-enable', 'df-username'].filter((id) => ($(`#${id}`, body)?.value || '').includes(':'));
    const box = $('#df-delim', body);
    box.style.display = bad.length && cfg.source.delimiter === ':' ? '' : 'none';
    box.querySelector('.alert-body').innerHTML = t('The value contains <code>:</code>, which is the router.db delimiter, so it cannot be written to the device line. Define this credential on a <a href="#/groups">group</a> instead.');
  };
  body.addEventListener('input', delimCheck);

  const values = () => {
    const v = {};
    ['name', 'ip', 'model', 'group', 'input', 'username', 'password', 'enable', 'ssh_port', 'telnet_port'].forEach((k) => {
      const el = $(`#df-${k}`, body);
      if (el && !el.disabled) v[k] = el.value.trim();
    });
    if ($('#df-clear-password', body)?.checked) v.clear_password = true;
    if ($('#df-clear-enable', body)?.checked) v.clear_enable = true;
    return v;
  };

  let stopTest = null;
  $('#df-test-wrap', body).addEventListener('toggle', (e) => {
    if (e.target.open && !stopTest) {
      stopTest = testConsole($('#df-test', body), () => {
        const v = values();
        if (!v.ip && !isEdit) { toast(t('Enter an IP first'), 'warning'); return null; }
        return { node: isEdit ? src.name : undefined, draft: { ...v, name: undefined, clear_password: undefined, clear_enable: undefined } };
      });
    }
  });

  m.foot.querySelector('[data-a=cancel]').onclick = () => { stopTest && stopTest(); m.close(); };
  m.foot.querySelector('[data-a=save]').onclick = async (e) => {
    const v = values();
    if (!v.name) { toast(t('Device name is required'), 'warning'); return; }
    if (cols.has('ip') && !v.ip) { toast(t('IP / hostname is required'), 'warning'); return; }
    const btn = e.currentTarget;
    setBusy(btn, true, t('Saving'));
    try {
      let r;
      const fetchNow = $('#df-fetch', body)?.checked;
      if (isEdit) r = await api.updateNode(src.name, v);
      else r = await api.createNode({ ...v, fetch_now: fetchNow });
      stopTest && stopTest();
      m.close();
      reloadToast(r.reload, isEdit ? t('{name} updated and Oxidized reloaded', { name: v.name }) : fetchNow ? t('{name} added and queued for backup', { name: v.name }) : t('{name} added', { name: v.name }));
      onSaved && onSaved(v);
    } catch (err) {
      toastError(err);
      setBusy(btn, false);
    }
  };
}

// ------------------------------------------------------------------ bulk edit
export async function openBulkEdit(names, onDone) {
  const cfg = await getConfigSummary();
  const cols = new Set([...Object.keys(cfg.source.map), ...Object.keys(cfg.source.vars_map)]);
  const fields = [
    ['group', N_('Group'), 'text'], ['model', N_('Model'), 'text'], ['input', N_('Protocol'), 'input'],
    ['ssh_port', N_('SSH port'), 'number'], ['telnet_port', N_('Telnet port'), 'number'],
    ['username', N_('Username'), 'text'], ['password', N_('Password'), 'password'], ['enable', N_('Enable password'), 'password'],
  ].filter(([k]) => cols.has(k));
  const body = document.createElement('div');
  body.innerHTML = `<div class="stack">
    <div class="muted">${esc(tn('{n} device selected.', '{n} devices selected.', names.length))} ${esc(t('Only the ticked fields change. An empty value clears the field (the group / global value is used).'))}</div>
    ${fields.map(([k, l, ty]) => `<div class="row" style="align-items:flex-start;gap:12px">
      <label class="chk" style="width:170px;padding-top:8px"><input type="checkbox" data-apply="${k}"> ${esc(t(l))}</label>
      <div style="flex:1">${ty === 'input'
        ? `<select class="select" data-f="${k}" disabled>${INPUT_OPTIONS.map(([v, lb]) => `<option value="${v}">${esc(t(lb))}</option>`).join('')}</select>`
        : `<input class="input" data-f="${k}" type="${ty === 'password' ? 'password' : ty}" ${k === 'group' ? 'list="bk-groups"' : ''} disabled>`}</div></div>`).join('')}
    <datalist id="bk-groups">${Object.keys(cfg.groups).map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
  </div>`;
  body.querySelectorAll('[data-apply]').forEach((c) => {
    c.onchange = () => { body.querySelector(`[data-f="${c.dataset.apply}"]`).disabled = !c.checked; };
  });
  const m = modal({ title: `${icon('edit')} ${esc(t('Bulk edit'))}`, body, footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${esc(t('Apply'))}</button>` });
  m.foot.querySelector('[data-a=no]').onclick = m.close;
  m.foot.querySelector('[data-a=yes]').onclick = async (e) => {
    const f = {};
    body.querySelectorAll('[data-apply]:checked').forEach((c) => {
      const k = c.dataset.apply;
      const v = body.querySelector(`[data-f="${k}"]`).value.trim();
      f[k] = v;
      if ((k === 'password' || k === 'enable') && !v) f[`clear_${k}`] = true;
    });
    if (!Object.keys(f).length) { toast(t('No field selected'), 'warning'); return; }
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      const r = await iapi(state.iid).bulk({ action: 'set', names, fields: f });
      m.close();
      if (r.errors.length) toast(t('{ok} updated, {n} errors: {first}', { ok: r.ok, n: r.errors.length, first: r.errors[0] }), 'warning');
      else reloadToast(r.reload, tn('{n} device updated', '{n} devices updated', r.ok));
      onDone && onDone();
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
}
