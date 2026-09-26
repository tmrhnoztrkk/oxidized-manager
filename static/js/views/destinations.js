// Backup destinations: push the collected configs to GitHub / GitLab / Gitea / any git server
import { api, wsapi } from '../api.js';
import { N_, t } from '../i18n.js';
import { can, current, state } from '../app.js';
import { $, $$, confirmDialog, copyText, empty, esc, fmtDate, icon, modal, pwField, setBusy, timeAgo, toast, toastError } from '../ui.js';

export const PROVIDERS = {
  github: { label: 'GitHub', icon: 'github', desc: N_('github.com or GitHub Enterprise — fine-grained access token') },
  gitlab: { label: 'GitLab', icon: 'gitlab', desc: N_('gitlab.com or self-managed — project access token') },
  gitea: { label: 'Gitea / Forgejo', icon: 'tea', desc: N_('Self-hosted Gitea, Forgejo or Codeberg — access token') },
  git: { label: 'Git over HTTPS', icon: 'git', desc: N_('Bitbucket, Azure DevOps, any server — username + password/token') },
  git_ssh: { label: 'Git over SSH', icon: 'key', desc: N_('Any server — deploy key generated here') },
};

const INTERVALS = [[0, N_('Manual only')], [15, N_('Every 15 minutes')], [30, N_('Every 30 minutes')], [60, N_('Every hour')], [360, N_('Every 6 hours')], [720, N_('Every 12 hours')], [1440, N_('Once a day')]];

const STATUS = {
  ok: ['success', N_('Pushed')], unchanged: ['info', N_('No changes')], error: ['danger', N_('Failed')], running: ['warning', N_('Running')],
};

export function destStatusBadge(d) {
  if (d.running) return `<span class="badge warning">${icon('loader', 'spin')} ${esc(t('Running'))}</span>`;
  if (!d.last_status) return `<span class="badge">${esc(t('Never run'))}</span>`;
  const [cls, label] = STATUS[d.last_status] || ['', d.last_status];
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(t(label))}</span>`;
}

const intervalLabel = (m) => {
  const hit = INTERVALS.find(([v]) => v === m);
  return hit ? t(hit[1]) : t('Every {n} minutes', { n: m });
};

export async function render(view) {
  const inst = current();
  const wa = wsapi(state.iid);
  let timer = null;
  let dests = [];
  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(t('Backup destinations'))}</h1>
      <div class="sub">${esc(inst.name)} · ${esc(t('Push every device config to an external git repository'))}</div></div>
      <div class="actions">${can('manager') ? `<button class="btn primary" id="ds-add">${icon('plus')} ${esc(t('Add destination'))}</button>` : ''}</div></div>
    <div class="alert info" style="margin-bottom:16px">${icon('info')}<div class="alert-body">
      ${esc(t('Oxidized already keeps a git history inside the workspace. A destination additionally pushes a copy of the latest config of every device to a repository you choose — on a schedule and on demand. Each run creates one commit that contains only the devices whose config changed.'))}
      ${inst.type !== 'local' ? `<br>${esc(t('For this remote workspace the configs are pulled over its API and pushed from this installation.'))}` : ''}</div></div>
    <div id="ds-list"></div>`;

  const draw = () => {
    const list = $('#ds-list', view);
    if (!dests.length) {
      list.innerHTML = `<div class="card">${empty('cloudUp', t('No backup destination yet'), esc(t('Add GitHub, GitLab, Gitea or any git server. Every destination gets its own step-by-step guide for creating the access token.')),
        can('manager') ? `<button class="btn primary" id="ds-add2">${icon('plus')} ${esc(t('Add destination'))}</button>` : '')}
        <div class="row" style="justify-content:center;gap:10px;padding:0 20px 28px">${Object.entries(PROVIDERS).map(([k, p]) => `<button class="btn sm ghost" data-howto="${k}">${icon(p.icon)} ${esc(t('How to set up {name}', { name: p.label }))}</button>`).join('')}</div></div>`;
      $('#ds-add2', list)?.addEventListener('click', () => destForm(null, reload));
      $$('[data-howto]', list).forEach((b) => { b.onclick = () => howto(b.dataset.howto); });
      return;
    }
    list.innerHTML = `<div class="stack">${dests.map((d) => {
      const p = PROVIDERS[d.type] || {};
      const c = d.config || {};
      return `<div class="card" data-id="${esc(d.id)}"><div class="card-head">
        <span class="choice-icon" style="width:36px;height:36px;border-radius:10px">${icon(p.icon || 'git')}</span>
        <div style="min-width:0"><h3>${esc(d.name)} ${d.enabled ? '' : `<span class="badge">${esc(t('paused'))}</span>`}</h3>
          <div class="small muted ellipsis">${esc(p.label || d.type)} · <span class="mono">${esc(d.target)}</span> · ${icon('git')} ${esc(c.branch || 'main')}${c.path ? ` · /${esc(c.path)}` : ''}</div></div>
        <div class="actions">
          ${d.web_url ? `<a class="btn sm ghost" href="${esc(d.web_url)}" target="_blank" rel="noopener">${icon('external')} ${esc(t('Open repository'))}</a>` : ''}
          ${can('operator') ? `<button class="btn sm primary" data-run ${d.running ? 'disabled' : ''}>${icon('cloudUp')} ${esc(t('Push now'))}</button>` : ''}
          <button class="btn sm" data-hist>${icon('history')} ${esc(t('History'))}</button>
          ${can('manager') ? `<button class="btn sm ghost icon" data-edit title="${esc(t('Edit'))}">${icon('edit')}</button>
          <button class="btn sm ghost icon danger" data-del title="${esc(t('Delete'))}">${icon('trash')}</button>` : ''}
        </div></div>
        <div class="card-body"><div class="grid c4">
          <div><div class="small muted">${esc(t('Last run'))}</div><div class="row" style="gap:6px;margin-top:4px">${destStatusBadge(d)}
            ${d.last_run ? `<span class="small" title="${esc(fmtDate(d.last_run))}">${timeAgo(d.last_run)}</span>` : ''}</div></div>
          <div><div class="small muted">${esc(t('Schedule'))}</div><div style="margin-top:4px">${can('manager')
            ? `<select class="select" data-interval style="width:auto;height:30px">${INTERVALS.map(([v, l]) => `<option value="${v}" ${d.interval_min === v ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}${INTERVALS.some(([v]) => v === d.interval_min) ? '' : `<option selected value="${d.interval_min}">${esc(intervalLabel(d.interval_min))}</option>`}</select>`
            : esc(intervalLabel(d.interval_min))}</div></div>
          <div><div class="small muted">${esc(t('Last commit'))}</div><div class="mono small" style="margin-top:6px">${d.last_commit
            ? (d.commit_url ? `<a href="${esc(d.commit_url)}" target="_blank" rel="noopener">${esc(d.last_commit.slice(0, 10))} ${icon('external')}</a>` : esc(d.last_commit.slice(0, 10))) : '—'}</div></div>
          <div><div class="small muted">${esc(t('Enabled'))}</div><div style="margin-top:6px">${can('manager')
            ? `<label class="switch"><input type="checkbox" data-enabled ${d.enabled ? 'checked' : ''}><span class="track"></span></label>` : esc(d.enabled ? t('yes') : t('no'))}</div></div>
        </div>
        ${d.last_message ? `<div class="small ${d.last_status === 'error' ? '' : 'muted'}" style="margin-top:12px;${d.last_status === 'error' ? 'color:var(--danger)' : ''}">${d.last_status === 'error' ? icon('alert') : icon('info')} ${esc(d.last_message)}</div>` : ''}
        ${d.last_status === 'error' ? `<div class="small" style="margin-top:6px"><a href="#" data-howto="${esc(d.type)}">${icon('help')} ${esc(t('Check the setup guide for {name}', { name: p.label || d.type }))}</a></div>` : ''}
        </div></div>`;
    }).join('')}</div>`;
    $$('[data-id]', list).forEach((card) => {
      const d = dests.find((x) => x.id === card.dataset.id);
      card.querySelector('[data-run]')?.addEventListener('click', async (e) => {
        setBusy(e.currentTarget, true, t('Starting'));
        try { await wa.runDest(d.id); toast(t('Push started — configs are being collected'), 'info'); await reload(); } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
      });
      card.querySelector('[data-hist]').onclick = () => history(d);
      card.querySelector('[data-edit]')?.addEventListener('click', () => destForm(d, reload));
      card.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!await confirmDialog({ title: t("Delete '{name}'?", { name: d.name }), message: esc(t('Only the destination settings are deleted. Nothing is removed from the remote repository.')), confirm: t('Delete'), danger: true })) return;
        try { await wa.deleteDest(d.id); reload(); } catch (err) { toastError(err); }
      });
      card.querySelector('[data-enabled]')?.addEventListener('change', async (e) => {
        try { await wa.updateDest(d.id, { enabled: e.target.checked }); reload(); } catch (err) { toastError(err); }
      });
      card.querySelector('[data-interval]')?.addEventListener('change', async (e) => {
        try { await wa.updateDest(d.id, { interval_min: +e.target.value }); toast(t('Schedule updated'), 'success'); } catch (err) { toastError(err); }
      });
      card.querySelector('[data-howto]')?.addEventListener('click', (e) => { e.preventDefault(); howto(d.type); });
    });
  };

  const reload = async () => {
    dests = await wa.destinations();
    draw();
    clearTimeout(timer);
    timer = setTimeout(() => { if (!document.hidden && !document.querySelector('.overlay')) reload().catch(() => {}); else timer = setTimeout(reload, 5000); },
      dests.some((d) => d.running) ? 2500 : 30000);
  };
  $('#ds-add', view)?.addEventListener('click', () => destForm(null, reload));
  await reload();
  return () => clearTimeout(timer);
}

// ------------------------------------------------------------------ run history
async function history(d) {
  const m = modal({ title: `${icon('history')} ${esc(d.name)}`, size: 'lg', body: '<div class="loader"></div>', footer: null });
  try {
    const runs = await wsapi(state.iid).runs(d.id);
    m.body.innerHTML = runs.length ? `<table class="table"><thead><tr><th>${esc(t('Started'))}</th><th>${esc(t('Result'))}</th><th>${esc(t('Devices'))}</th><th>${esc(t('Commit'))}</th><th>${esc(t('Trigger'))}</th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td class="nowrap small" title="${esc(fmtDate(r.started))}">${timeAgo(r.started)}${r.finished ? `<div class="sub-cell">${Math.max(0, r.finished - r.started).toFixed(1)} s</div>` : ''}</td>
        <td>${destStatusBadge({ last_status: r.status, running: r.status === 'running' })}<div class="small ${r.status === 'error' ? '' : 'muted'}" style="margin-top:4px;max-width:420px;${r.status === 'error' ? 'color:var(--danger)' : ''}">${esc(r.message || '')}</div></td>
        <td class="small">${r.changed ? `<b>${r.changed}</b> ${esc(t('changed'))} / ` : ''}${r.devices}</td>
        <td class="mono small">${r.commit_sha ? (r.commit_url ? `<a href="${esc(r.commit_url)}" target="_blank" rel="noopener">${esc(r.commit_sha.slice(0, 10))}</a>` : esc(r.commit_sha.slice(0, 10))) : '—'}</td>
        <td class="small muted">${esc((r.trigger || '').replace('manual:', `${t('manual')}: `).replace('schedule', t('schedule')))}</td></tr>`).join('')}
      </tbody></table>` : empty('history', t('No runs yet'));
  } catch (e) { m.body.innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body">${esc(e.message)}</div></div>`; }
}

// ------------------------------------------------------------------ add / edit form
function providerFields(type, c, d) {
  const tokenField = (label = t('Access token')) => `<div class="field span2"><label>${esc(label)} *
      <a href="#" class="small" data-howto="${type}" style="margin-left:auto">${icon('help')} ${esc(t('How do I get a token?'))}</a></label>
      ${pwField('df-token', { placeholder: type === 'github' ? 'github_pat_…' : type === 'gitlab' ? 'glpat-…' : '', has: c.has_token })}</div>`;
  const branch = `<div class="field"><label>${esc(t('Branch'))}</label><input class="input mono" id="df-branch" value="${esc(c.branch || 'main')}"><span class="hint">${esc(t('Created on the first push if it does not exist'))}</span></div>`;
  if (type === 'github') {
    return `<div class="grid c2">
      <div class="field"><label>${esc(t('Repository'))} *</label><input class="input mono" id="df-repo" value="${esc(c.repo || '')}" placeholder="my-org/network-backups"><span class="hint">${esc(t('owner/name — or paste the repository URL'))}</span></div>
      ${branch}${tokenField()}
      <div class="field span2"><label>${esc(t('Server'))}</label><input class="input mono" id="df-server" value="${esc(c.server || 'https://github.com')}"><span class="hint">${esc(t('Change only for GitHub Enterprise Server, e.g. https://github.example.com'))}</span></div></div>`;
  }
  if (type === 'gitlab') {
    return `<div class="grid c2">
      <div class="field"><label>${esc(t('Server'))}</label><input class="input mono" id="df-server" value="${esc(c.server || 'https://gitlab.com')}"></div>
      <div class="field"><label>${esc(t('Project path'))} *</label><input class="input mono" id="df-repo" value="${esc(c.repo || '')}" placeholder="network/backups"><span class="hint">${esc(t('group/project — subgroups are fine: group/sub/project'))}</span></div>
      ${tokenField()}${branch}</div>`;
  }
  if (type === 'gitea') {
    return `<div class="grid c2">
      <div class="field"><label>${esc(t('Server'))} *</label><input class="input mono" id="df-server" value="${esc(c.server || '')}" placeholder="https://git.example.com"></div>
      <div class="field"><label>${esc(t('Repository'))} *</label><input class="input mono" id="df-repo" value="${esc(c.repo || '')}" placeholder="netops/backups"></div>
      ${tokenField()}
      <div class="field"><label>${esc(t('Username'))} <span class="muted small">(${esc(t('optional'))})</span></label><input class="input" id="df-username" value="${esc(c.username || '')}"></div>
      ${branch}</div>`;
  }
  if (type === 'git') {
    return `<div class="grid c2">
      <div class="field span2"><label>${esc(t('Repository URL (HTTPS)'))} *</label><input class="input mono" id="df-url" value="${esc(c.url || '')}" placeholder="https://bitbucket.org/team/network-backups.git"></div>
      <div class="field"><label>${esc(t('Username'))}</label><input class="input" id="df-username" value="${esc(c.username || '')}"></div>
      <div class="field"><label>${esc(t('Password / token'))} * <a href="#" class="small" data-howto="git" style="margin-left:auto">${icon('help')} ${esc(t('Help'))}</a></label>${pwField('df-password', { has: c.has_password })}</div>
      ${branch}</div>`;
  }
  // git_ssh
  return `<div class="grid c2">
    <div class="field span2"><label>${esc(t('Repository URL (SSH)'))} *</label><input class="input mono" id="df-url" value="${esc(c.url || '')}" placeholder="git@github.com:my-org/network-backups.git"></div>
    ${branch}<div></div>
    <div class="field span2"><label>${esc(t('Deploy key'))} * <a href="#" class="small" data-howto="git_ssh" style="margin-left:auto">${icon('help')} ${esc(t('How do I add a deploy key?'))}</a></label>
      <div class="row"><button type="button" class="btn sm primary" id="df-keygen">${icon('key')} ${esc(t('Generate a new key'))}</button>
        <button type="button" class="btn sm" id="df-keypaste">${icon('edit')} ${esc(t('Paste my own private key'))}</button></div>
      <div id="df-pub" style="${c.ssh_public_key ? '' : 'display:none'}">
        <div class="small muted" style="margin:10px 0 6px">${esc(t('Public key — add it to the repository as a deploy key with write access:'))}</div>
        <div class="row" style="align-items:stretch"><textarea class="input code" id="df-pubkey" rows="2" readonly style="flex:1">${esc(c.ssh_public_key || '')}</textarea>
          <button type="button" class="btn" id="df-copypub">${icon('copy')}</button></div></div>
      <textarea class="input code" id="df-ssh_key" rows="6" style="display:none;margin-top:10px" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
      ${d && c.has_ssh_key ? `<span class="hint">${esc(t('A private key is stored. Generate or paste a new one only to replace it.'))}</span>` : ''}
    </div></div>`;
}

export async function destForm(existing, onDone) {
  const inst = current();
  const wa = wsapi(state.iid);
  let type = existing?.type || 'github';
  let sealed = null;
  const c0 = existing?.config || {};
  const defaultPath = (inst.name || 'workspace').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const body = document.createElement('div');
  body.innerHTML = `<form class="stack" autocomplete="off">
    ${existing ? '' : `<div class="section-title">${esc(t('1. Where should the backups go?'))}</div>
    <div class="grid c3" id="df-types">${Object.entries(PROVIDERS).map(([k, p]) => `<label class="choice mini ${k === type ? 'active' : ''}"><input type="radio" name="df-type" value="${k}" ${k === type ? 'checked' : ''} hidden>
      ${icon(p.icon)}<div><b>${esc(p.label)}</b><div class="small muted">${esc(t(p.desc))}</div></div></label>`).join('')}</div>`}
    <div class="section-title row between">${esc(existing ? t('Connection') : t('2. Connection'))}<button type="button" class="btn sm ghost" data-howto-current>${icon('help')} ${esc(t('Setup guide'))}</button></div>
    <div id="df-fields"></div>
    <div class="section-title">${esc(existing ? t('Content & schedule') : t('3. Content & schedule'))}</div>
    <div class="grid c3">
      <div class="field"><label>${esc(t('Destination name'))}</label><input class="input" id="df-name" value="${esc(existing?.name || '')}" placeholder="${esc(t('e.g. GitHub offsite'))}"></div>
      <div class="field"><label>${esc(t('Folder in the repository'))}</label><input class="input mono" id="df-path" value="${esc(existing ? (c0.path ?? '') : defaultPath)}" placeholder="${esc(t('(repository root)'))}"><span class="hint">${esc(t('Lets several workspaces share one repository'))}</span></div>
      <div class="field"><label>${esc(t('Push schedule'))}</label><select class="select" id="df-interval">${INTERVALS.map(([v, l]) => `<option value="${v}" ${(existing ? existing.interval_min : 60) === v ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('File layout'))}</label><select class="select" id="df-layout">
        <option value="group" ${c0.layout !== 'flat' ? 'selected' : ''}>${esc(t('One folder per group (group/device)'))}</option>
        <option value="flat" ${c0.layout === 'flat' ? 'selected' : ''}>${esc(t('All devices in one folder'))}</option></select></div>
      <div class="field"><label>${esc(t('Commit author'))}</label><input class="input" id="df-author_name" value="${esc(c0.author_name || 'Oxidized Manager')}"></div>
      <div class="field"><label>${esc(t('Commit e-mail'))}</label><input class="input" id="df-author_email" value="${esc(c0.author_email || 'oxidized-manager@localhost')}"></div>
    </div>
    <div class="row" style="gap:18px">
      <label class="chk"><input type="checkbox" id="df-inventory" ${c0.inventory === false ? '' : 'checked'}> ${esc(t('Write devices.csv (inventory without passwords)'))}</label>
      <label class="chk"><input type="checkbox" id="df-prune" ${c0.prune === false ? '' : 'checked'}> ${esc(t('Remove configs of deleted devices'))}</label>
      <label class="chk" data-tls><input type="checkbox" id="df-verify_tls" ${c0.verify_tls === false ? '' : 'checked'}> ${esc(t('Verify TLS certificate'))}</label>
      <label class="chk"><input type="checkbox" id="df-enabled" ${existing && !existing.enabled ? '' : 'checked'}> ${esc(t('Enabled'))}</label>
    </div>
    <div id="df-result"></div>
  </form>`;
  const m = modal({
    title: existing ? `${icon('edit')} ${esc(existing.name)}` : `${icon('cloudUp')} ${esc(t('Add backup destination'))}`, size: 'lg', body,
    footer: `<button class="btn" data-a="test" style="margin-right:auto">${icon('zap')} ${esc(t('Test connection'))}</button>
      <button class="btn" data-a="no">${esc(t('Cancel'))}</button>
      ${existing ? '' : `<button class="btn" data-a="save">${icon('save')} ${esc(t('Save'))}</button>`}
      <button class="btn primary" data-a="saverun">${icon('cloudUp')} ${esc(existing ? t('Save') : t('Save & push now'))}</button>`,
  });

  const drawFields = () => {
    $('#df-fields', body).innerHTML = providerFields(type, existing?.type === type ? c0 : {}, existing);
    $('[data-tls]', body).style.display = type === 'git_ssh' ? 'none' : '';
    $$('#df-fields [data-howto]', body).forEach((a) => { a.onclick = (e) => { e.preventDefault(); howto(a.dataset.howto); }; });
    $('#df-keygen', body)?.addEventListener('click', async (e) => {
      setBusy(e.currentTarget, true);
      try {
        const k = await api.post('/api/keygen');
        sealed = k.sealed;
        $('#df-ssh_key', body).value = '';
        $('#df-ssh_key', body).style.display = 'none';
        $('#df-pubkey', body).value = k.public_key;
        $('#df-pub', body).style.display = '';
        toast(t('Key generated — add the public key to the repository, then test the connection'), 'success');
      } catch (err) { toastError(err); }
      setBusy(e.currentTarget, false);
    });
    $('#df-keypaste', body)?.addEventListener('click', () => {
      sealed = null;
      const ta = $('#df-ssh_key', body);
      ta.style.display = '';
      ta.focus();
      $('#df-pub', body).style.display = 'none';
    });
    $('#df-copypub', body)?.addEventListener('click', () => copyText($('#df-pubkey', body).value));
  };
  drawFields();
  $$('[name=df-type]', body).forEach((r) => {
    r.onchange = () => {
      type = r.value;
      sealed = null;
      $$('#df-types .choice.mini', body).forEach((l) => l.classList.toggle('active', l.querySelector('input').checked));
      drawFields();
      $('#df-result', body).innerHTML = '';
    };
  });
  $('[data-howto-current]', body).onclick = () => howto(type);

  const val = (id) => $(`#df-${id}`, body)?.value?.trim();
  const payload = () => {
    const cfg = {
      branch: val('branch') || 'main', path: val('path') ?? '', layout: val('layout'),
      author_name: val('author_name'), author_email: val('author_email'),
      inventory: $('#df-inventory', body).checked, prune: $('#df-prune', body).checked,
      verify_tls: $('#df-verify_tls', body).checked,
    };
    ['server', 'repo', 'url', 'username'].forEach((k) => { if ($(`#df-${k}`, body)) cfg[k] = val(k); });
    if ($('#df-token', body)) cfg.token = $('#df-token', body).value.trim();
    if ($('#df-password', body)) cfg.password = $('#df-password', body).value;
    if (type === 'git_ssh') {
      if (sealed) cfg.ssh_key_sealed = sealed;
      else if ($('#df-ssh_key', body).value.trim()) cfg.ssh_key = $('#df-ssh_key', body).value.trim();
      else if (existing?.type === 'git_ssh') cfg.ssh_public_key = c0.ssh_public_key;
    }
    return { type, name: val('name'), config: cfg, interval_min: +val('interval'), enabled: $('#df-enabled', body).checked, id: existing?.id };
  };
  const result = (ok, html) => { $('#df-result', body).innerHTML = `<div class="alert ${ok ? 'success' : 'danger'}">${icon(ok ? 'checkCircle' : 'alert')}<div class="alert-body">${html}</div></div>`; };

  m.foot.querySelector('[data-a=no]').onclick = m.close;
  m.foot.querySelector('[data-a=test]').onclick = async (e) => {
    setBusy(e.currentTarget, true, t('Testing'));
    try {
      const r = await wa.testDest(payload());
      if (r.ok) {
        const br = val('branch') || 'main';
        result(true, `<b>${esc(t('Connection works and the credentials can push.'))}</b> ${esc(r.empty ? t('The repository is empty; it will be initialised on the first push.') : r.branch_exists ? t("Branch '{b}' exists.", { b: br }) : t("Branch '{b}' will be created on the first push.", { b: br }))}`);
      } else {
        result(false, `<b>${esc(t('Test failed.'))}</b> ${esc(r.error)}<div style="margin-top:6px"><a href="#" data-howto-err>${icon('help')} ${esc(t('Open the setup guide'))}</a></div>`);
        $('[data-howto-err]', body).onclick = (ev) => { ev.preventDefault(); howto(type); };
      }
    } catch (err) { result(false, esc(err.message)); }
    setBusy(e.currentTarget, false);
  };
  const save = async (btn, runNow) => {
    setBusy(btn, true, t('Saving'));
    try {
      const p = payload();
      if (existing) await wa.updateDest(existing.id, p);
      else await wa.createDest({ ...p, run_now: runNow });
      m.close();
      toast(existing ? t('Destination saved') : runNow ? t('Destination saved — first push started') : t('Destination saved'), 'success');
      onDone && onDone();
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
  m.foot.querySelector('[data-a=save]')?.addEventListener('click', (e) => save(e.currentTarget, false));
  m.foot.querySelector('[data-a=saverun]').onclick = (e) => save(e.currentTarget, !existing);
}

// ------------------------------------------------------------------ setup guides (how-to pop-ups)
const L = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${esc(text || href)} ${icon('external')}</a>`;

const GUIDES = {
  github: () => ({
    title: t('GitHub: create an access token'),
    intro: t('Oxidized Manager needs a token that can write to one repository. A fine-grained personal access token limited to that repository is the safest option.'),
    steps: [
      t('Create a private repository for the backups, e.g. {name}: {link}. It can be empty.', { name: '<code>network-backups</code>', link: L('https://github.com/new') }),
      t('Open {link} (Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token).', { link: L('https://github.com/settings/personal-access-tokens/new', t('the new fine-grained token page')) }),
      t('Token name: e.g. {name}. Choose an expiration date and note it — the push stops working when the token expires.', { name: '<code>oxidized-manager</code>' }),
      t('Resource owner: the account or organisation that owns the repository.'),
      t('Repository access: choose {opt} and select the backup repository.', { opt: `<b>${esc(t('Only select repositories'))}</b>` }),
      t('Permissions → Repository permissions → {perm}: {val}. (Metadata: Read-only is added automatically.)', { perm: '<b>Contents</b>', val: '<b>Read and write</b>' }),
      t('Click {btn} and copy the token (it starts with {prefix}). GitHub shows it only once.', { btn: '<b>Generate token</b>', prefix: '<code>github_pat_</code>' }),
      t('Back here: enter the repository as {ex} and paste the token, then click {btn}.', { ex: '<code>owner/network-backups</code>', btn: `<b>${esc(t('Test connection'))}</b>` }),
    ],
    notes: [
      t('Organisations can require approval for fine-grained tokens — an owner may have to approve it under the organisation settings.'),
      t('A classic token also works: {link} with the {scope} scope.', { link: L('https://github.com/settings/tokens/new', t('new classic token')), scope: '<code>repo</code>' }),
      t('Prefer no personal token at all? Use "Git over SSH" with a deploy key that only has access to this one repository.'),
    ],
  }),
  gitlab: () => ({
    title: t('GitLab: create a project access token'),
    intro: t('A project access token is bound to a single project and does not use a personal account.'),
    steps: [
      t('Create a private project for the backups, e.g. {name}: {link}.', { name: '<code>network-backups</code>', link: L('https://gitlab.com/projects/new') }),
      t('In the project open {path}.', { path: '<b>Settings → Access tokens → Add new token</b>' }),
      t('Token name: e.g. {name}; choose an expiration date.', { name: '<code>oxidized-manager</code>' }),
      t('Role: {role}. Scopes: tick {scope}.', { role: '<b>Maintainer</b>', scope: '<code>write_repository</code>' }),
      t('Click {btn} and copy the token (it starts with {prefix}).', { btn: '<b>Create project access token</b>', prefix: '<code>glpat-</code>' }),
      t('Back here: enter the project path as {ex} and paste the token.', { ex: '<code>group/network-backups</code>' }),
    ],
    notes: [
      t('The default branch is usually protected. With the Developer role pushes to it are rejected — use Maintainer, or push to another branch.'),
      t('Self-managed GitLab: set Server to your GitLab address, e.g. {ex}.', { ex: '<code>https://gitlab.example.com</code>' }),
      t('Project access tokens need a paid tier on gitlab.com for some namespaces; a personal access token with the {scope} scope works the same way.', { scope: '<code>write_repository</code>' }),
    ],
  }),
  gitea: () => ({
    title: t('Gitea / Forgejo: create an access token'),
    intro: t('Works with Gitea, Forgejo and Codeberg.'),
    steps: [
      t('Create a repository for the backups (it can be empty).'),
      t('Open your user menu → {path}.', { path: '<b>Settings → Applications</b>' }),
      t('Under {section} enter a name, e.g. {name}.', { section: '<b>Generate new token</b>', name: '<code>oxidized-manager</code>' }),
      t('Select permissions: {perm} → {val}.', { perm: '<b>repository</b>', val: '<b>Read and write</b>' }),
      t('Click {btn} and copy the token — it is shown only once.', { btn: '<b>Generate token</b>' }),
      t('Back here: Server = your Gitea address (e.g. {ex}), Repository = {repo}, paste the token.', { ex: '<code>https://git.example.com</code>', repo: '<code>owner/network-backups</code>' }),
    ],
    notes: [t('The username is optional; the token identifies the account.')],
  }),
  git: () => ({
    title: t('Git over HTTPS: credentials for other servers'),
    intro: t('Use the HTTPS clone URL of the repository and a username with a password, app password or token that can push.'),
    steps: [
      t('Bitbucket Cloud: repository → {path}, create a token with {perm}. Username: {user}.', { path: '<b>Repository settings → Access tokens</b>', perm: '<b>Repositories: Write</b>', user: '<code>x-token-auth</code>' }),
      t('Azure DevOps: create a Personal Access Token with {perm}; any username works.', { perm: '<b>Code: Read &amp; write</b>' }),
      t('AWS CodeCommit: IAM → Users → Security credentials → {path}.', { path: '<b>HTTPS Git credentials for AWS CodeCommit</b>' }),
      t('Any other server: the same username and password/token you would use for {cmd}.', { cmd: '<code>git push</code>' }),
    ],
    notes: [t('Self-signed certificate? Untick "Verify TLS certificate" for this destination — or better, install a trusted certificate.')],
  }),
  git_ssh: () => ({
    title: t('Git over SSH: add a deploy key'),
    intro: t('A deploy key gives access to exactly one repository and is not tied to a personal account.'),
    steps: [
      t('Click {btn}. A new Ed25519 key pair is created; the private key is stored encrypted on this server and never shown.', { btn: `<b>${esc(t('Generate a new key'))}</b>` }),
      t('Copy the public key.'),
      t('GitHub: repository → {path} → paste the key and tick {opt}.', { path: '<b>Settings → Deploy keys → Add deploy key</b>', opt: '<b>Allow write access</b>' }),
      t('GitLab: project → {path} → paste the key and tick {opt}.', { path: '<b>Settings → Repository → Deploy keys</b>', opt: '<b>Grant write permissions to this key</b>' }),
      t('Gitea / Forgejo: repository → {path} → paste the key and untick {opt}.', { path: '<b>Settings → Deploy keys → Add deploy key</b>', opt: '<b>Read-only</b>' }),
      t('Enter the SSH clone URL, e.g. {ex}, and click {btn}.', { ex: '<code>git@github.com:owner/network-backups.git</code>', btn: `<b>${esc(t('Test connection'))}</b>` }),
    ],
    notes: [
      t('The server\'s SSH host key is trusted on the first connection and pinned afterwards.'),
      t('Outbound TCP port 22 (or the port in an ssh:// URL) must be allowed from this server.'),
    ],
  }),
};

export function howto(type) {
  const g = (GUIDES[type] || GUIDES.git)();
  modal({
    title: `${icon(PROVIDERS[type]?.icon || 'help')} ${esc(g.title)}`, size: 'lg', footer: null,
    body: `<div class="stack howto">
      <div class="muted">${esc(g.intro)}</div>
      <ol class="steps-list">${g.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      ${g.notes?.length ? `<div class="alert info small">${icon('info')}<div class="alert-body"><ul class="list-plain">${g.notes.map((n) => `<li>${n}</li>`).join('')}</ul></div></div>` : ''}
      <div class="small muted">${esc(t('The token or key is stored encrypted with this installation\'s secret key and is never shown again.'))}</div>
    </div>`,
  });
}

