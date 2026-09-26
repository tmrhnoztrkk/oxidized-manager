import { iapi } from '../api.js';
import { t, tn } from '../i18n.js';
import { reloadToast, restartRequiredToast, state } from '../app.js';
import { $, $$, confirmDialog, copyText, empty, esc, icon, modal, pwField, setBusy, toast, toastError } from '../ui.js';
import { getConfigSummary, INPUT_OPTIONS, invalidateConfig } from './components.js';

const AUTH_METHODS = ['none', 'publickey', 'password', 'keyboard-interactive'];

export async function render(view) {
  const api = iapi(state.iid);
  const load = async () => {
    invalidateConfig();
    const cfg = await getConfigSummary(true);
    const groups = Object.entries(cfg.groups);
    const usage = cfg.group_usage || {};
    const s = cfg.settings;
    const undefinedGroups = Object.keys(usage).filter((g) => g && !cfg.groups[g]);
    view.innerHTML = `
      <div class="page-head">
        <div><h1>${esc(t('Groups & credentials'))}</h1><div class="sub">${t('Oxidized precedence: <b>device</b> → <b>group + model</b> → <b>group</b> → <b>model</b> → <b>global</b>')}</div></div>
        <div class="actions"><button class="btn primary" id="g-add">${icon('plus')} ${esc(t('Add group'))}</button></div>
      </div>
      ${undefinedGroups.length ? `<div class="alert warning" style="margin-bottom:16px">${icon('alert')}<div class="alert-body">${esc(t('Groups used in router.db but not defined in the config:'))} ${undefinedGroups.map((g) => `<b>${esc(g)}</b> (${esc(tn('{n} device', '{n} devices', usage[g]))})`).join(', ')}. ${esc(t('These devices use the global credentials.'))}
        <div style="margin-top:8px">${undefinedGroups.map((g) => `<button class="btn sm" data-define="${esc(g)}">${icon('plus')} ${esc(t("Define group '{g}'", { g }))}</button>`).join(' ')}</div></div></div>` : ''}
      <div class="card" style="margin-bottom:16px"><div class="card-head"><h3>${icon('shield')} ${esc(t('Global defaults'))}</h3>
        <div class="actions"><a class="btn sm" href="#/settings/general">${icon('edit')} ${esc(t('Edit'))}</a></div></div>
        <div class="card-body"><div class="grid c4">
          <div><div class="small muted">${esc(t('Username'))}</div><div class="mono">${esc(s.username || '—')}</div></div>
          <div><div class="small muted">${esc(t('Password'))}</div><div>${s.has_password ? `<span class="badge success">${esc(t('set'))}</span>` : `<span class="badge danger">${esc(t('none'))}</span>`}</div></div>
          <div><div class="small muted">${esc(t('Default model'))}</div><div class="mono">${esc(s.model || '—')}</div></div>
          <div><div class="small muted">${esc(t('Default protocol'))}</div><div class="mono">${esc(s['input.default'] || 'ssh')}</div></div>
        </div></div></div>
      ${groups.length ? `<div class="card"><div class="table-wrap"><table class="table"><thead><tr>
        <th>${esc(t('Group'))}</th><th>${esc(t('Devices'))}</th><th>${esc(t('Username'))}</th><th>${esc(t('Password / enable'))}</th><th>${esc(t('Protocol'))}</th><th>${esc(t('Ports'))}</th><th>auth_methods</th><th>${esc(t('Other vars'))}</th><th></th></tr></thead><tbody>
        ${groups.map(([name, g]) => {
          const v = g.vars || {};
          const other = Object.entries(v).filter(([k]) => !['ssh_port', 'telnet_port', 'auth_methods'].includes(k));
          return `<tr><td><b>${esc(name)}</b>${g.model ? `<div class="sub-cell">model: ${esc(g.model)}</div>` : ''}</td>
            <td><a href="#/devices" data-filter-group="${esc(name)}">${usage[name] || 0}</a></td>
            <td class="mono">${esc(g.username || '—')}</td>
            <td>${g.has_password ? `<span class="badge success">${esc(t('password'))}</span>` : '<span class="badge">—</span>'} ${g.has_enable ? '<span class="badge success">enable</span>' : ''}</td>
            <td class="mono small">${esc(g.input || '—')}</td>
            <td class="mono small">${v.ssh_port ? `SSH:${esc(v.ssh_port)}` : ''} ${v.telnet_port ? `TEL:${esc(v.telnet_port)}` : ''}${!v.ssh_port && !v.telnet_port ? '—' : ''}</td>
            <td class="small">${Array.isArray(v.auth_methods) ? v.auth_methods.map((a) => `<span class="badge outline">${esc(a)}</span>`).join(' ') : '—'}</td>
            <td class="small mono">${other.length ? other.map(([k, x]) => `${esc(k)}=${esc(Array.isArray(x) ? x.join(',') : x)}`).join('<br>') : '—'}</td>
            <td class="actions">
              <button class="btn sm ghost icon" data-reveal="${esc(name)}" title="${esc(t('Show passwords'))}">${icon('eye')}</button>
              <button class="btn sm ghost icon" data-edit="${esc(name)}" title="${esc(t('Edit'))}">${icon('edit')}</button>
              <button class="btn sm ghost icon danger" data-del="${esc(name)}" title="${esc(t('Delete'))}">${icon('trash')}</button></td></tr>`;
        }).join('')}</tbody></table></div></div>`
        : `<div class="card">${empty('layers', t('No groups defined'), esc(t('Group devices that share the same credentials.')), `<button class="btn primary" id="g-add2">${icon('plus')} ${esc(t('Add group'))}</button>`)}</div>`}
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>${icon('link')} ${esc(t('Model mapping (model_map)'))}</h3>
        <span class="small muted">${esc(t('Translates the model name in router.db to an Oxidized model (e.g. cisco → ios)'))}</span>
        <div class="actions"><button class="btn sm" id="mm-edit">${icon('edit')} ${esc(t('Edit'))}</button></div></div>
        <div class="card-body chips">${Object.entries(cfg.model_map).map(([a, b]) => `<span class="badge outline mono">${esc(a)} → ${esc(b)}</span>`).join('') || `<span class="muted">${esc(t('No mappings'))}</span>`}</div></div>`;

    const add = () => groupForm(null, cfg, load);
    $('#g-add', view).onclick = add;
    $('#g-add2', view)?.addEventListener('click', add);
    $$('[data-define]', view).forEach((b) => { b.onclick = () => groupForm(null, cfg, load, b.dataset.define); });
    $$('[data-edit]', view).forEach((b) => { b.onclick = () => groupForm(b.dataset.edit, cfg, load); });
    $$('[data-filter-group]', view).forEach((a) => { a.onclick = () => { try { sessionStorage.setItem('oxmgr-devfilter', JSON.stringify({ group: a.dataset.filterGroup })); } catch (e) { /* storage blocked */ } }; });
    $$('[data-reveal]', view).forEach((b) => {
      b.onclick = async () => {
        try {
          const sec = await api.groupSecrets(b.dataset.reveal);
          const row = (l, v) => `<div class="row between"><span class="muted">${esc(l)}</span><span class="row">${v ? `<span class="pw-reveal">${esc(v)}</span><button class="btn ghost sm icon" data-c="${esc(v)}">${icon('copy')}</button>` : '—'}</span></div>`;
          const m = modal({ title: `${icon('key')} ${esc(b.dataset.reveal)}`, size: 'sm', body: `<div class="stack">${row(t('Password'), sec.password)}${row(t('Enable'), sec.enable)}</div>`, footer: null });
          $$('[data-c]', m.body).forEach((c) => { c.onclick = () => copyText(c.dataset.c); });
        } catch (e) { toastError(e); }
      };
    });
    $$('[data-del]', view).forEach((b) => {
      b.onclick = async () => {
        const n = b.dataset.del;
        if (!await confirmDialog({ title: t("Delete group '{g}'?", { g: n }), message: esc(t('The group is removed from the config file.')), confirm: t('Delete'), danger: true })) return;
        try { await api.deleteGroup(n); restartRequiredToast(); load(); } catch (e) { toastError(e); }
      };
    });
    $('#mm-edit', view).onclick = () => modelMapForm(cfg, load);
  };
  await load();
  return null;
}

function groupForm(name, cfg, onDone, presetName) {
  const api = iapi(state.iid);
  const g = name ? cfg.groups[name] : { vars: {} };
  const v = g.vars || {};
  const extra = Object.entries(v).filter(([k]) => !['ssh_port', 'telnet_port', 'auth_methods'].includes(k));
  const am = Array.isArray(v.auth_methods) ? v.auth_methods : [];
  const body = document.createElement('div');
  body.innerHTML = `<form class="stack" autocomplete="off">
    <div class="grid c2">
      <div class="field"><label>${esc(t('Group name'))} *</label><input class="input" id="gf-name" value="${esc(name || presetName || '')}"></div>
      <div class="field"><label>${esc(t('Model'))} (${esc(t('optional'))})</label><input class="input" id="gf-model" list="gf-models" value="${esc(g.model || '')}" placeholder="${esc(t('default model of the group devices'))}">
        <datalist id="gf-models">${state.models.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
      <div class="field"><label>${icon('user')} ${esc(t('Username'))}</label><input class="input" id="gf-username" value="${esc(g.username || '')}"></div>
      <div class="field"><label>${icon('key')} ${esc(t('Password'))}</label>${pwField('gf-password', { has: g.has_password })}
        ${g.has_password ? `<label class="chk small"><input type="checkbox" id="gf-clear-password"> ${esc(t('Remove the password'))}</label>` : ''}</div>
      <div class="field"><label>${icon('lock')} ${esc(t('Enable password'))} <span class="muted small">(vars.enable)</span></label>${pwField('gf-enable', { has: g.has_enable })}
        ${g.has_enable ? `<label class="chk small"><input type="checkbox" id="gf-clear-enable"> ${esc(t('Remove the enable password'))}</label>` : ''}</div>
      <div class="field"><label>${esc(t('Protocol (input)'))}</label><select class="select" id="gf-input">${INPUT_OPTIONS.map(([val, l]) => `<option value="${val}" ${(g.input || '') === val ? 'selected' : ''}>${esc(val ? t(l) : t('Default (global)'))}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('SSH port'))} <span class="muted small">(vars.ssh_port)</span></label><input class="input" type="number" id="gf-ssh_port" value="${esc(v.ssh_port || '')}" placeholder="22"></div>
      <div class="field"><label>${esc(t('Telnet port'))} <span class="muted small">(vars.telnet_port)</span></label><input class="input" type="number" id="gf-telnet_port" value="${esc(v.telnet_port || '')}" placeholder="23"></div>
    </div>
    <div class="field"><label>SSH auth_methods <span class="muted small">(${esc(t('empty = Oxidized default: none, publickey, password'))})</span></label>
      <div class="row">${AUTH_METHODS.map((a) => `<label class="chk"><input type="checkbox" data-am="${a}" ${am.includes(a) ? 'checked' : ''}> ${a}</label>`).join('')}</div></div>
    <div class="field"><label>${esc(t('Other variables (vars)'))}</label>
      <div class="small muted">${esc(t('e.g. ssh_kex, ssh_host_key, ssh_encryption, ssh_no_exec, remove_secret, ssh_proxy…'))}</div>
      <div id="gf-vars" class="stack" style="gap:6px"></div>
      <div><button type="button" class="btn sm" id="gf-addvar">${icon('plus')} ${esc(t('Add variable'))}</button></div></div>
    ${name ? `<label class="chk" id="gf-rn-wrap" style="display:none"><input type="checkbox" id="gf-rename-nodes" checked> ${esc(t('Also rename the group of the devices in router.db'))}</label>` : ''}
    <div class="alert info small">${icon('info')}<div class="alert-body">${esc(t('Group settings are written to the Oxidized config file and need an Oxidized restart. Comments and other settings are kept, and a backup of the previous file is taken.'))}</div></div>
  </form>`;
  const varRow = (k = '', val = '') => {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<input class="input mono" style="flex:1" placeholder="${esc(t('key'))}" value="${esc(k)}" data-vk><input class="input mono" style="flex:2" placeholder="${esc(t('value (comma-separated for a list)'))}" value="${esc(Array.isArray(val) ? val.join(',') : val)}" data-vv data-list="${Array.isArray(val) ? 1 : ''}"><button type="button" class="btn ghost icon sm">${icon('x')}</button>`;
    r.querySelector('button').onclick = () => r.remove();
    $('#gf-vars', body).appendChild(r);
  };
  extra.forEach(([k, val]) => varRow(k, val));
  $('#gf-addvar', body).onclick = () => varRow();

  const m = modal({ title: name ? `${icon('edit')} ${esc(t('Group: {g}', { g: name }))}` : `${icon('plus')} ${esc(t('New group'))}`, size: 'lg', body,
    footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${esc(t('Save'))}</button>` });
  if (name) {
    $('#gf-name', body).oninput = (e) => { $('#gf-rn-wrap', body).style.display = e.target.value.trim() !== name ? '' : 'none'; };
  }
  m.foot.querySelector('[data-a=no]').onclick = m.close;
  m.foot.querySelector('[data-a=yes]').onclick = async (e) => {
    const val = (id) => $(`#${id}`, body).value.trim();
    const newName = val('gf-name');
    if (!newName) { toast(t('Group name is required'), 'warning'); return; }
    const vars = {};
    if (val('gf-ssh_port')) vars.ssh_port = val('gf-ssh_port');
    if (val('gf-telnet_port')) vars.telnet_port = val('gf-telnet_port');
    const ams = $$('[data-am]:checked', body).map((c) => c.dataset.am);
    if (ams.length) vars.auth_methods = ams;
    $$('#gf-vars .row', body).forEach((r) => {
      const k = r.querySelector('[data-vk]').value.trim();
      const vv = r.querySelector('[data-vv]');
      if (!k) return;
      vars[k] = vv.dataset.list || vv.value.includes(',') ? vv.value.split(',').map((x) => x.trim()).filter(Boolean) : vv.value.trim();
    });
    const payload = {
      name: newName, username: val('gf-username'), model: val('gf-model'), input: val('gf-input'), vars,
      password: val('gf-password') || undefined, enable: val('gf-enable') || undefined,
      clear_password: $('#gf-clear-password', body)?.checked, clear_enable: $('#gf-clear-enable', body)?.checked,
      rename_nodes: $('#gf-rename-nodes', body)?.checked,
    };
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      const r = name ? await api.updateGroup(name, payload) : await api.createGroup(payload);
      m.close();
      if (r.reload) reloadToast(r.reload);
      restartRequiredToast(t("Group '{g}' saved. Restart Oxidized to apply.", { g: newName }));
      invalidateConfig();
      onDone();
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
}

function modelMapForm(cfg, onDone) {
  const api = iapi(state.iid);
  const body = document.createElement('div');
  body.innerHTML = `<div class="stack" id="mm-rows" style="gap:6px"></div><div style="margin-top:10px"><button class="btn sm" id="mm-add">${icon('plus')} ${esc(t('Add row'))}</button></div>`;
  const row = (a = '', b = '') => {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<input class="input mono" style="flex:1" placeholder="${esc(t('name in router.db (e.g. cisco)'))}" value="${esc(a)}" data-a>
      <span>→</span><input class="input mono" style="flex:1" list="mm-models" placeholder="${esc(t('Oxidized model (e.g. ios)'))}" value="${esc(b)}" data-b>
      <button class="btn ghost icon sm">${icon('x')}</button>`;
    r.querySelector('button').onclick = () => r.remove();
    $('#mm-rows', body).appendChild(r);
  };
  body.insertAdjacentHTML('beforeend', `<datalist id="mm-models">${state.models.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`);
  Object.entries(cfg.model_map).forEach(([a, b]) => row(a, b));
  if (!Object.keys(cfg.model_map).length) row();
  $('#mm-add', body).onclick = () => row();
  const m = modal({ title: 'model_map', body, footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${esc(t('Save'))}</button>` });
  m.foot.querySelector('[data-a=no]').onclick = m.close;
  m.foot.querySelector('[data-a=yes]').onclick = async () => {
    const map = {};
    $$('#mm-rows .row', body).forEach((r) => {
      const a = r.querySelector('[data-a]').value.trim();
      const b = r.querySelector('[data-b]').value.trim();
      if (a && b) map[a] = b;
    });
    try { await api.modelMap(map); m.close(); restartRequiredToast(); onDone(); } catch (e) { toastError(e); }
  };
}
