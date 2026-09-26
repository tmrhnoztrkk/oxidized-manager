// Administration › Users & access: accounts, global role and per-workspace access
import { api } from '../api.js';
import { t } from '../i18n.js';
import { roleBadge, ROLES, state, WS_TYPES } from '../app.js';
import { $, $$, confirmDialog, empty, esc, fmtDate, icon, modal, pwField, setBusy, timeAgo, toast, toastError } from '../ui.js';

export async function render(view) {
  const load = async () => {
    const users = await api.get('/api/users');
    const wss = state.workspaces;
    view.innerHTML = `
      <div class="page-head"><div><h1>${esc(t('Users & access'))}</h1>
        <div class="sub">${esc(t('Administrators manage everything. Other users only see the workspaces shared with them, with a role per workspace.'))}</div></div>
        <div class="actions"><button class="btn primary" id="us-add">${icon('userPlus')} ${esc(t('Add user'))}</button></div></div>
      <div class="card">${users.length ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>${esc(t('User'))}</th><th>${esc(t('Role'))}</th><th>${esc(t('Workspace access'))}</th><th>${esc(t('Last sign-in'))}</th><th></th></tr></thead><tbody>
        ${users.map((u) => {
          const access = Object.entries(u.access || {}).map(([wid, r]) => {
            const w = wss.find((x) => x.id === wid);
            return w ? `<span class="badge outline" title="${esc(t(WS_TYPES[w.type]?.label || ''))}">${icon(WS_TYPES[w.type]?.icon || 'box')} ${esc(w.name)} · ${esc(t(ROLES[r]?.label || r))}</span>` : '';
          }).join(' ');
          return `<tr>
            <td><b>${esc(u.username)}</b>${u.username === state.user ? ` <span class="badge primary">${esc(t('you'))}</span>` : ''}
              ${u.disabled ? ` <span class="badge danger">${esc(t('disabled'))}</span>` : ''}<div class="sub-cell">${esc(t('created'))} ${fmtDate(u.created_at)}</div></td>
            <td>${u.role === 'admin' ? `<span class="badge primary">${icon('shield')} ${esc(t('Admin'))}</span>` : `<span class="badge">${esc(t('User'))}</span>`}</td>
            <td class="small">${u.role === 'admin' ? `<span class="muted">${esc(t('all workspaces'))}</span>` : (access || `<span class="muted">${esc(t('no access yet'))}</span>`)}</td>
            <td class="small nowrap">${u.last_login ? `<span title="${esc(fmtDate(u.last_login))}">${timeAgo(u.last_login)}</span>` : `<span class="muted">${esc(t('never'))}</span>`}</td>
            <td class="actions"><button class="btn sm" data-edit="${u.id}">${icon('edit')} ${esc(t('Edit'))}</button>
              ${u.username === state.user ? '' : `<button class="btn sm ghost icon danger" data-del="${u.id}" data-name="${esc(u.username)}" title="${esc(t('Delete'))}">${icon('trash')}</button>`}</td></tr>`;
        }).join('')}</tbody></table></div>` : empty('users', t('No users'))}</div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>${icon('info')} ${esc(t('Workspace roles'))}</h3></div>
        <div class="card-body grid c3">${Object.entries(ROLES).map(([k, r]) => `<div>${roleBadge(k)}<div class="small muted" style="margin-top:6px">${esc(t(r.desc))}</div></div>`).join('')}</div></div>`;
    $('#us-add', view).onclick = () => userForm(null, load);
    $$('[data-edit]', view).forEach((b) => { b.onclick = () => userForm(users.find((u) => u.id === +b.dataset.edit), load); });
    $$('[data-del]', view).forEach((b) => {
      b.onclick = async () => {
        if (!await confirmDialog({ title: t("Delete '{name}'?", { name: b.dataset.name }), message: esc(t('The account and its workspace access are removed. Audit log entries are kept.')), confirm: t('Delete'), danger: true })) return;
        try { await api.del(`/api/users/${b.dataset.del}`); toast(t('User deleted'), 'success'); load(); } catch (e) { toastError(e); }
      };
    });
  };
  await load();
  return null;
}

function userForm(u, onDone) {
  const isNew = !u;
  const self = u && u.username === state.user;
  const access = { ...(u?.access || {}) };
  const body = document.createElement('div');
  body.innerHTML = `<form class="stack" autocomplete="off">
    <div class="grid c2">
      <div class="field"><label>${esc(t('Username'))} *</label><input class="input" id="uf-name" value="${esc(u?.username || '')}" ${isNew ? '' : 'disabled'}></div>
      <div class="field"><label>${esc(isNew ? t('Password') : t('New password'))} ${isNew ? '*' : `<span class="muted small">(${esc(t('leave empty to keep'))})</span>`}</label>${pwField('uf-pass', { placeholder: t('at least 8 characters') })}</div>
      <div class="field"><label>${esc(t('Role'))}</label><select class="select" id="uf-role" ${self ? 'disabled' : ''}>
        <option value="user" ${u?.role !== 'admin' ? 'selected' : ''}>${esc(t('User — only shared workspaces'))}</option>
        <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>${esc(t('Administrator — full access'))}</option></select></div>
      ${isNew ? '<div></div>' : `<div class="field"><label>${esc(t('Status'))}</label><label class="switch" style="margin-top:6px"><input type="checkbox" id="uf-active" ${u.disabled ? '' : 'checked'} ${self ? 'disabled' : ''}><span class="track"></span><span>${esc(t('Account active (can sign in)'))}</span></label></div>`}
    </div>
    <div id="uf-access-wrap">
      <div class="section-title">${icon('layers')} ${esc(t('Workspace access'))}</div>
      ${state.workspaces.length ? `<table class="table"><thead><tr><th>${esc(t('Workspace'))}</th><th>${esc(t('Access'))}</th></tr></thead><tbody>
        ${state.workspaces.map((w) => `<tr><td>${icon(WS_TYPES[w.type]?.icon || 'box')} <b>${esc(w.name)}</b> <span class="small muted">${esc(t(WS_TYPES[w.type]?.label || ''))}</span></td>
          <td><select class="select" data-ws="${esc(w.id)}" style="width:auto"><option value="">${esc(t('No access'))}</option>
            ${Object.keys(ROLES).map((k) => `<option value="${k}" ${access[w.id] === k ? 'selected' : ''}>${esc(t(ROLES[k].label))}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table>` : `<div class="muted small">${esc(t('There are no workspaces yet.'))}</div>`}
    </div>
    <div class="alert info small" id="uf-admin-note" style="display:none">${icon('info')}<div class="alert-body">${esc(t('Administrators have full access to every workspace and can manage users, workspaces and API keys.'))}</div></div>
  </form>`;
  const m = modal({ title: isNew ? `${icon('userPlus')} ${esc(t('Add user'))}` : `${icon('edit')} ${esc(u.username)}`, size: 'lg', body,
    footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${icon('save')} ${esc(t('Save'))}</button>` });
  const syncRole = () => {
    const admin = $('#uf-role', body).value === 'admin';
    $('#uf-access-wrap', body).style.display = admin ? 'none' : '';
    $('#uf-admin-note', body).style.display = admin ? '' : 'none';
  };
  $('#uf-role', body).onchange = syncRole;
  syncRole();
  m.foot.querySelector('[data-a=no]').onclick = m.close;
  m.foot.querySelector('[data-a=yes]').onclick = async (e) => {
    const acc = {};
    $$('[data-ws]', body).forEach((s) => { if (s.value) acc[s.dataset.ws] = s.value; });
    const payload = { role: $('#uf-role', body).value, access: acc };
    const pw = $('#uf-pass', body).value;
    setBusy(e.currentTarget, true);
    try {
      if (isNew) {
        await api.post('/api/users', { ...payload, username: $('#uf-name', body).value.trim(), password: pw });
        toast(t('User created'), 'success');
      } else {
        if (!self) payload.disabled = !$('#uf-active', body).checked;
        if (self) delete payload.role;
        if (pw) payload.password = pw;
        await api.put(`/api/users/${u.id}`, payload);
        toast(t('User updated'), 'success');
      }
      m.close();
      onDone();
    } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
  };
}
