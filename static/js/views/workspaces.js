// Administration › Workspaces: create / edit / remove workspaces and share them with users
import { api, wsapi } from '../api.js';
import { N_, t, tn } from '../i18n.js';
import { isAdmin, loadWorkspaces, navigate, roleBadge, ROLES, selectWorkspace, state, WS_TYPES } from '../app.js';
import { $, $$, confirmDialog, dropdown, esc, icon, modal, setBusy, timeAgo, toast, toastError } from '../ui.js';
import { localWizard, remoteForm } from './setup.js';

export const STATE_LABEL = {
  running: ['success', N_('Running')], waiting_nodes: ['warning', N_('Waiting for the first device')], stopped: ['', N_('Stopped')],
  crashed: ['danger', N_('Crashed')], error: ['danger', N_('Error')], starting: ['info', N_('Starting')],
};
export const stateBadge = (st) => {
  const [cls, label] = STATE_LABEL[st?.state] || ['', st?.state || '?'];
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(t(label))}</span>`;
};

export async function render(view) {
  const load = async () => {
    await loadWorkspaces();
    state.me = await api.get('/api/auth/me');
    const hasLocal = state.workspaces.some((w) => w.type === 'local');
    const remotes = state.workspaces.filter((w) => w.type !== 'local').length;
    const max = state.me.max_remote || 10;
    view.innerHTML = `
      <div class="page-head"><div><h1>${esc(t('Workspaces'))}</h1><div class="sub">${esc(t('Each workspace is one Oxidized installation: at most one embedded in this container, plus up to {n} remote ones. Share a workspace to give users access.', { n: max }))}</div></div>
        <div class="actions">
          ${hasLocal ? '' : `<button class="btn" id="ws-add-local">${icon('box')} ${esc(t('Run Oxidized here'))}</button>`}
          <button class="btn primary" id="ws-add-remote" ${remotes >= max ? 'disabled' : ''}>${icon('cloud')} ${esc(t('Add remote workspace'))}</button></div></div>
      <div class="row small muted" style="margin:-8px 0 16px">
        <span class="badge outline">${icon('box')} ${esc(t('Embedded'))}: ${hasLocal ? 1 : 0}/1</span>
        <span class="badge ${remotes >= max ? 'warning' : 'outline'}">${icon('cloud')} ${esc(t('Remote'))}: ${remotes}/${max}</span></div>
      <div class="grid c2" id="ws-list"></div>`;
    const list = $('#ws-list', view);
    if (!state.workspaces.length) {
      list.innerHTML = `<div class="card span2"><div class="empty">${icon('layers')}<h3>${esc(t('No workspace yet'))}</h3><div>${esc(t('Run Oxidized in this container or connect to a remote Oxidized.'))}</div></div></div>`;
    }
    state.workspaces.forEach((w) => {
      const ty = WS_TYPES[w.type] || {};
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-head">${icon(ty.icon || 'box', 'lg')}<div style="min-width:0"><h3>${esc(w.name)}</h3>
          <div class="small muted">${esc(t(ty.long || w.type))}${w.id === state.iid ? ` · <b style="color:var(--primary)">${esc(t('selected'))}</b>` : ''}</div></div>
        <div class="actions"><button class="btn sm" data-a="use">${esc(t('Open'))}</button>
          <button class="btn sm" data-a="share">${icon('share')} ${esc(t('Share'))}</button>
          <button class="btn sm ghost icon" data-a="more">${icon('more')}</button></div></div>
        <div class="card-body"><div class="kv">
          ${w.type === 'local' ? `
            <div>Oxidized</div><div>${stateBadge(w.process)} ${w.process?.pid ? `<span class="small muted">pid ${w.process.pid}</span>` : ''}</div>
            <div>${esc(t('Started'))}</div><div class="small">${w.process?.started_at ? timeAgo(w.process.started_at) : '—'} · ${esc(t('restarts'))}: ${w.process?.restarts ?? 0}</div>
            <div>${esc(t('Data directory'))}</div><div class="mono small">${esc(w.config.home || '')}</div>
            ${w.process?.message ? `<div>${esc(t('Message'))}</div><div class="small" style="color:var(--warning)">${esc(w.process.message)}</div>` : ''}`
          : `<div>${esc(t('Address'))}</div><div class="mono small">${esc(w.config.url || '')}</div>
            <div>${esc(t('Credentials'))}</div><div class="small">${w.type === 'agent' ? (w.config.has_token ? `${icon('key')} ${esc(t('API key stored'))}` : `<span class="badge danger">${esc(t('no key'))}</span>`) : (w.config.username ? `basic auth: ${esc(w.config.username)}` : esc(t('none')))}</div>`}
          <div>${esc(t('Shared with'))}</div><div class="small">${w.members ? esc(tn('{n} user', '{n} users', w.members)) : `<span class="muted">${esc(t('administrators only'))}</span>`}</div>
          <div>${esc(t('Status'))}</div><div class="small" data-health><span class="muted">${esc(t('testing…'))}</span></div>
        </div>
        ${w.type === 'local' ? `<div class="row" style="margin-top:14px">
          <button class="btn sm" data-p="start">${icon('play')} ${esc(t('Start'))}</button><button class="btn sm" data-p="restart">${icon('refresh')} ${esc(t('Restart'))}</button>
          <button class="btn sm danger" data-p="stop">${icon('stop')} ${esc(t('Stop'))}</button></div>` : ''}</div>`;
      card.querySelector('[data-a=use]').onclick = () => { selectWorkspace(w.id); navigate('#/'); };
      card.querySelector('[data-a=share]').onclick = () => shareDialog(w, load);
      card.querySelector('[data-a=more]').onclick = (e) => dropdown(e.currentTarget, [
        { label: t('Edit'), icon: 'edit', onClick: () => editWorkspace(w, load) },
        { label: t('Test connection'), icon: 'zap', onClick: () => health(w, card.querySelector('[data-health]'), true) },
        { label: t('Backup destinations'), icon: 'cloudUp', onClick: () => { selectWorkspace(w.id); navigate('#/destinations'); } },
        '-',
        { label: w.type === 'local' ? t('Remove workspace…') : t('Remove connection'), icon: 'trash', danger: true, onClick: () => removeWorkspace(w, load) },
      ]);
      $$('[data-p]', card).forEach((b) => {
        b.onclick = async () => {
          setBusy(b, true);
          try {
            const st = await api.post(`/api/w/${w.id}/process/${b.dataset.p}`);
            toast(`Oxidized: ${t(STATE_LABEL[st.state]?.[1] || st.state)}${st.message ? ` — ${st.message}` : ''}`, st.state === 'running' || b.dataset.p === 'stop' ? 'success' : 'warning');
            load();
          } catch (err) { toastError(err); setBusy(b, false); }
        };
      });
      list.appendChild(card);
      health(w, card.querySelector('[data-health]'));
    });
    $('#ws-add-local', view)?.addEventListener('click', () => {
      const m = modal({ title: `${icon('box')} ${esc(t('Embedded Oxidized'))}`, size: 'lg', body: '<div></div>', footer: null });
      localWizard(m.body.firstElementChild, { onDone: (ws) => { m.close(); selectWorkspace(ws.id); load(); } });
    });
    $('#ws-add-remote', view).onclick = () => {
      const m = modal({ title: `${icon('cloud')} ${esc(t('Add remote workspace'))}`, size: 'lg', body: '<div></div>', footer: null });
      remoteForm(m.body.firstElementChild, { onDone: (ws) => { m.close(); if (!state.iid) selectWorkspace(ws.id); load(); } });
    };
  };
  await load();
  return null;
}

async function health(w, el, verbose = false) {
  try {
    const r = await wsapi(w.id).test();
    if (r.agent) {
      el.innerHTML = r.agent.ok
        ? `<span class="badge success">${icon('check')} ${esc(t('Connected'))}</span> <span class="small muted">${esc(t('remote'))}: ${esc(r.agent.name)} · v${esc(r.agent.version)} · Oxidized: ${esc(t(STATE_LABEL[r.agent.process?.state]?.[1] || r.agent.process?.state || '?'))}</span>`
        : `<span class="badge danger">${icon('x')} ${esc(t('Unreachable'))}</span><div class="small" style="color:var(--danger);margin-top:4px">${esc(r.agent.error)}</div>`;
    } else {
      el.innerHTML = r.api?.ok
        ? `<span class="badge success">${icon('check')} ${esc(t('API online'))}</span> <span class="small muted">${esc(tn('{n} device', '{n} devices', r.api.nodes))} · ${r.api.ms} ms</span>`
        : `<span class="badge danger">${icon('x')} ${esc(t('API not responding'))}</span><div class="small muted" style="margin-top:4px">${esc(r.api?.error || '')}</div>`;
    }
    if (verbose) toast(t('Test finished'), 'info');
  } catch (e) { el.innerHTML = `<span class="badge danger">${esc(e.message)}</span>`; }
}

function editWorkspace(w, onDone) {
  if (w.type === 'local') {
    const m = modal({ title: `${icon('edit')} ${esc(w.name)}`, size: 'sm', body: `<div class="field"><label>${esc(t('Workspace name'))}</label><input class="input" id="we-name" value="${esc(w.name)}"></div>
      <div class="muted small" style="margin-top:10px">${esc(t('Use the "Oxidized settings" page for Oxidized itself.'))}</div>`,
    footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${esc(t('Save'))}</button>` });
    m.foot.querySelector('[data-a=no]').onclick = m.close;
    m.foot.querySelector('[data-a=yes]').onclick = async () => {
      try { await api.put(`/api/workspaces/${w.id}`, { name: $('#we-name', m.body).value }); m.close(); onDone(); } catch (e) { toastError(e); }
    };
    return;
  }
  const m = modal({ title: `${icon('edit')} ${esc(w.name)}`, size: 'lg', body: '<div></div>', footer: null });
  remoteForm(m.body.firstElementChild, { existing: w, onDone: () => { m.close(); onDone(); } });
}

async function removeWorkspace(w, onDone) {
  if (w.type === 'local') {
    const body = `${esc(t('Oxidized is stopped and the workspace is removed from the panel.'))}<br><br>
      <label class="chk"><input type="checkbox" id="rm-purge"> <b>${esc(t('Also delete all data'))}</b> (${esc(t('config, router.db, git history, backups — cannot be undone'))})</label>`;
    const m = modal({ title: esc(t("Remove '{name}'?", { name: w.name })), size: 'sm', body: `<div class="stack">${body}<div class="field"><label>${t('Type {text} to confirm', { text: `<code>${esc(w.name)}</code>` })}</label><input class="input" id="rm-text"></div></div>`,
      footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn danger solid" data-a="yes" disabled>${esc(t('Remove'))}</button>` });
    const yes = m.foot.querySelector('[data-a=yes]');
    m.body.querySelector('#rm-text').oninput = (e) => { yes.disabled = e.target.value !== w.name; };
    m.foot.querySelector('[data-a=no]').onclick = m.close;
    yes.onclick = async () => {
      try {
        await api.del(`/api/workspaces/${w.id}?purge=${m.body.querySelector('#rm-purge').checked}`);
        m.close(); toast(t('Workspace removed'), 'success'); onDone();
      } catch (e) { toastError(e); }
    };
    return;
  }
  if (!await confirmDialog({ title: t("Remove the connection to '{name}'?", { name: w.name }), message: esc(t('Only the connection in this panel is removed; the remote Oxidized is not affected. Its backup destinations and sharing settings are deleted.')), confirm: t('Remove'), danger: true })) return;
  try { await api.del(`/api/workspaces/${w.id}`); onDone(); } catch (e) { toastError(e); }
}

// ------------------------------------------------------------------ sharing
export async function shareDialog(w, onDone) {
  const wa = wsapi(w.id);
  let users = [];
  const m = modal({ title: `${icon('share')} ${esc(t("Share '{name}'", { name: w.name }))}`, size: 'lg', body: '<div class="loader"></div>', footer: `<button class="btn primary" data-a="close">${esc(t('Done'))}</button>` });
  m.foot.querySelector('[data-a=close]').onclick = () => { m.close(); onDone && onDone(); };
  const draw = async () => {
    const [mem] = await Promise.all([wa.members(), users.length ? null : api.get('/api/users/brief').then((u) => { users = u; })]);
    const inWs = new Set(mem.members.map((x) => x.user_id));
    const candidates = users.filter((u) => u.role !== 'admin' && !inWs.has(u.id) && !u.disabled);
    m.body.innerHTML = `<div class="stack">
      <div class="muted small">${esc(t('Users only see the workspaces shared with them. Administrators always have full access.'))}</div>
      <div class="grid c3 small">${Object.entries(ROLES).map(([k, r]) => `<div class="card" style="padding:10px 12px">${roleBadge(k)}<div class="muted" style="margin-top:6px">${esc(t(r.desc))}</div></div>`).join('')}</div>
      <div class="row" style="gap:8px;align-items:flex-end">
        <div class="field" style="flex:2"><label>${esc(t('User'))}</label><select class="select" id="sh-user">${candidates.length ? candidates.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('') : `<option value="">${esc(t('No more users to add'))}</option>`}</select></div>
        <div class="field" style="flex:1"><label>${esc(t('Role'))}</label><select class="select" id="sh-role">${Object.keys(ROLES).map((k) => `<option value="${k}">${esc(t(ROLES[k].label))}</option>`).join('')}</select></div>
        <button class="btn primary" id="sh-add" ${candidates.length ? '' : 'disabled'}>${icon('userPlus')} ${esc(t('Add'))}</button>
      </div>
      ${isAdmin() ? `<div class="small muted">${esc(t('Need a new account?'))} <a href="#/users" data-close>${esc(t('Create users under Users & access'))}</a></div>` : ''}
      <table class="table"><thead><tr><th>${esc(t('User'))}</th><th>${esc(t('Role'))}</th><th></th></tr></thead><tbody>
        ${mem.members.map((x) => `<tr><td><b>${esc(x.username)}</b>${x.disabled ? ` <span class="badge">${esc(t('disabled'))}</span>` : ''}</td>
          <td><select class="select" data-role="${x.user_id}" style="width:auto">${Object.keys(ROLES).map((k) => `<option value="${k}" ${x.role === k ? 'selected' : ''}>${esc(t(ROLES[k].label))}</option>`).join('')}</select></td>
          <td class="actions"><button class="btn sm danger" data-rm="${x.user_id}">${icon('trash')} ${esc(t('Remove'))}</button></td></tr>`).join('')}
        ${mem.admins.map((x) => `<tr><td><b>${esc(x.username)}</b></td><td><span class="badge primary">${esc(t('Admin'))}</span> <span class="small muted">${esc(t('full access'))}</span></td><td></td></tr>`).join('')}
      </tbody></table></div>`;
    m.body.querySelector('[data-close]')?.addEventListener('click', m.close);
    $('#sh-add', m.body).onclick = async (e) => {
      const uid = +$('#sh-user', m.body).value;
      if (!uid) return;
      setBusy(e.currentTarget, true);
      try { await wa.setMember(uid, $('#sh-role', m.body).value); await draw(); } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
    };
    $$('[data-role]', m.body).forEach((s) => {
      s.onchange = async () => { try { await wa.setMember(+s.dataset.role, s.value); toast(t('Role updated'), 'success'); } catch (err) { toastError(err); draw(); } };
    });
    $$('[data-rm]', m.body).forEach((b) => {
      b.onclick = async () => { try { await wa.setMember(+b.dataset.rm, null); await draw(); } catch (err) { toastError(err); } };
    });
  };
  try { await draw(); } catch (e) { m.close(); toastError(e); }
}
