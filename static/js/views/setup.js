// First-run wizard and the workspace forms (embedded / remote)
import { api } from '../api.js';
import { N_, t } from '../i18n.js';
import { enterApp, langButtons, state, themeButtons } from '../app.js';
import { $, $$, esc, h, icon, pwField, setBusy, toast, toastError } from '../ui.js';

const INTERVALS = [[900, N_('15 minutes')], [1800, N_('30 minutes')], [3600, N_('1 hour')], [21600, N_('6 hours')], [43200, N_('12 hours')], [86400, N_('24 hours')]];

function frame(step, total, title, sub) {
  const el = h(`<div class="login-wrap"><div class="card" style="width:100%;max-width:820px">
    <div class="card-head"><div class="brand" style="padding:0"><div class="brand-logo">Ox</div><div><div class="brand-name">Oxidized Manager</div><div class="brand-sub">${esc(t('Setup'))}</div></div></div>
      <div class="actions"><div class="btn-group" data-lang-btns></div><div class="btn-group" data-theme-btns></div></div></div>
    <div class="card-body">
      ${total ? `<div class="steps">${Array.from({ length: total }, (_, i) => `<span class="${i + 1 < step ? 'done' : i + 1 === step ? 'active' : ''}"></span>`).join('')}</div>` : ''}
      <h1 style="margin-top:6px">${esc(title)}</h1><div class="muted" style="margin:6px 0 20px">${sub}</div>
      <div data-body></div>
    </div></div></div>`);
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.appendChild(el);
  themeButtons(el.querySelector('[data-theme-btns]'));
  langButtons(el.querySelector('[data-lang-btns]'));
  return el.querySelector('[data-body]');
}

// ------------------------------------------------------------------ step 1: administrator
export function renderSetup() {
  const body = frame(1, 3, t('Welcome'), esc(t('First, create the administrator account. You can add more users and share workspaces with them later.')));
  body.innerHTML = `<form class="stack" style="max-width:420px">
    <div class="field"><label>${esc(t('Administrator username'))}</label><input class="input" name="u" value="admin" autocomplete="username" required></div>
    <div class="field"><label>${esc(t('Password'))} <span class="muted small">(${esc(t('at least 8 characters'))})</span></label><input class="input" type="password" name="p" autocomplete="new-password" required minlength="8"></div>
    <div class="field"><label>${esc(t('Password (again)'))}</label><input class="input" type="password" name="p2" autocomplete="new-password" required></div>
    <button class="btn primary" type="submit">${esc(t('Continue'))} ${icon('chevronRight')}</button></form>`;
  const f = body.querySelector('form');
  f.p.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.p.value !== f.p2.value) { toast(t('The passwords do not match'), 'warning'); return; }
    const btn = f.querySelector('button');
    setBusy(btn, true);
    try {
      const r = await api.post('/api/setup', { username: f.u.value.trim(), password: f.p.value }, { noAuthRedirect: true });
      state.user = r.user;
      state.role = 'admin';
      state.models = await api.get('/api/models').catch(() => []);
      renderWorkspaceChooser(2);
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
}

// ------------------------------------------------------------------ step 2: what to manage
export function renderWorkspaceChooser(step = 0) {
  const hasLocal = !!state.me.has_local;
  const body = frame(step || 0, step ? 3 : 0, t('What will this installation manage?'),
    esc(t('A workspace is one Oxidized installation. This container can run one embedded Oxidized and manage up to {n} remote ones — you can add more workspaces at any time.', { n: state.me.max_remote || 10 })));
  body.innerHTML = `<div class="grid c3">
    <button class="choice ${hasLocal ? 'disabled' : ''}" data-c="local" ${hasLocal ? 'disabled' : ''}>
      <div class="choice-icon">${icon('box', 'lg')}</div><h3>${esc(t('Run Oxidized here'))}</h3>
      <p>${esc(t('Oxidized runs inside this container, managed by the panel. Starts from a fresh configuration.'))}</p>
      ${hasLocal ? `<span class="badge warning">${esc(t('Already set up'))}</span>` : `<span class="badge primary">${esc(t('Recommended'))}</span>`}</button>
    <button class="choice" data-c="remote">
      <div class="choice-icon">${icon('cloud', 'lg')}</div><h3>${esc(t('Manage a remote Oxidized'))}</h3>
      <p>${esc(t('Connect to another Oxidized Manager with an API key (full management) or to a plain Oxidized REST API. No SSH needed.'))}</p>
      <span class="badge outline">${esc(t('HTTPS + API key'))}</span></button>
    <button class="choice" data-c="skip">
      <div class="choice-icon">${icon('chevronRight', 'lg')}</div><h3>${esc(t('Skip for now'))}</h3>
      <p>${esc(t('Open the panel without a workspace. Add workspaces and users later from Administration.'))}</p>
      <span class="badge outline">${esc(t('Manager only'))}</span></button>
  </div>`;
  $$('[data-c]', body).forEach((b) => {
    b.onclick = () => {
      if (b.dataset.c === 'skip') { enterApp(null); return; }
      if (b.dataset.c === 'local') {
        const f = frame(step ? 3 : 0, step ? 3 : 0, t('Embedded Oxidized'), esc(t('Basic settings. Everything can be changed later under "Oxidized settings".')));
        localWizard(f, { onDone: (ws) => enterApp(ws.id), onBack: () => renderWorkspaceChooser(step) });
      } else {
        const f = frame(step ? 3 : 0, step ? 3 : 0, t('Remote workspace'), esc(t('Connect to an Oxidized running on another server.')));
        remoteForm(f, { onDone: (ws) => enterApp(ws.id), onBack: () => renderWorkspaceChooser(step) });
      }
    };
  });
}

// ------------------------------------------------------------------ embedded workspace form
export function localWizard(container, { onDone, onBack } = {}) {
  container.innerHTML = `<form class="stack" autocomplete="off">
    <div class="grid c2">
      <div class="field span2"><label>${esc(t('Workspace name'))} *</label><input class="input" id="lw-name" value="${esc(t('Headquarters'))}" required></div>
    </div>
    <div class="section-title">${icon('shield')} ${esc(t('Default device credentials'))}</div>
    <div class="muted small" style="margin-top:-6px">${esc(t('Used by every device that has no device- or group-level credentials.'))}</div>
    <div class="grid c3">
      <div class="field"><label>${esc(t('Username'))}</label><input class="input" id="lw-username" placeholder="admin"></div>
      <div class="field"><label>${esc(t('Password'))}</label>${pwField('lw-password')}</div>
      <div class="field"><label>${esc(t('Enable password'))}</label>${pwField('lw-enable', { placeholder: t('leave empty if not needed') })}</div>
    </div>
    <div class="section-title">${icon('clock')} ${esc(t('Backups'))}</div>
    <div class="grid c3">
      <div class="field"><label>${esc(t('Backup interval'))}</label><select class="select" id="lw-interval">${INTERVALS.map(([v, l]) => `<option value="${v}" ${v === 3600 ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('Default model'))}</label><input class="input" id="lw-model" list="lw-models" value="ios"><datalist id="lw-models">${state.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>
      <div class="field"><label>${esc(t('Default protocol'))}</label><select class="select" id="lw-input">
        <option value="ssh, telnet">${esc(t('SSH, fall back to Telnet'))}</option><option value="ssh">${esc(t('SSH only'))}</option><option value="telnet">${esc(t('Telnet only'))}</option><option value="telnet, ssh">${esc(t('Telnet, fall back to SSH'))}</option></select></div>
      <div class="field"><label>${esc(t('Parallel connections (threads)'))}</label><input class="input" type="number" id="lw-threads" value="30" min="1" max="500"></div>
      <div class="field"><label>${esc(t('Timeout (s)'))}</label><input class="input" type="number" id="lw-timeout" value="20" min="5" max="600"></div>
      <div class="field"><label>${esc(t('Retries'))}</label><input class="input" type="number" id="lw-retries" value="2" min="0" max="10"></div>
    </div>
    <div class="section-title">${icon('git')} ${esc(t('Git history'))}</div>
    <div class="grid c2">
      <div class="field"><label>${esc(t('Commit author'))}</label><input class="input" id="lw-git_user" value="Oxidized"></div>
      <div class="field"><label>${esc(t('Commit e-mail'))}</label><input class="input" id="lw-git_email" value="oxidized@example.com"></div>
    </div>
    <div class="muted small">${icon('cloudUp')} ${esc(t('To also push backups to GitHub, GitLab or another git server, add a backup destination after setup.'))}</div>
    <details><summary class="section-title" style="cursor:pointer">${icon('plus')} ${esc(t('Add the first device now (optional)'))}</summary>
      <div class="grid c3" style="margin-top:10px">
        <div class="field"><label>${esc(t('Device name'))}</label><input class="input" id="lw-d-name" placeholder="CORE-SW01"></div>
        <div class="field"><label>${esc(t('IP / host'))}</label><input class="input mono" id="lw-d-ip" placeholder="10.0.0.1"></div>
        <div class="field"><label>${esc(t('Model'))}</label><input class="input" id="lw-d-model" list="lw-models" placeholder="ios"></div>
      </div>
      <div class="muted small">${esc(t('Oxidized does not start until there is at least one device; it starts automatically when the first device is added.'))}</div>
    </details>
    <div class="row" style="justify-content:space-between;margin-top:6px">
      ${onBack ? `<button type="button" class="btn" data-back>${icon('arrowLeft')} ${esc(t('Back'))}</button>` : '<span></span>'}
      <button class="btn primary" type="submit">${icon('check')} ${esc(t('Finish setup'))}</button></div>
  </form>`;
  const f = container.querySelector('form');
  f.querySelector('[data-back]')?.addEventListener('click', onBack);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => $(`#lw-${id}`, f).value.trim();
    const setup = {
      username: v('username'), password: v('password'), enable: v('enable'), model: v('model'),
      interval: +v('interval'), input: v('input'), threads: +v('threads'), timeout: +v('timeout'), retries: +v('retries'),
      git_user: v('git_user'), git_email: v('git_email'),
    };
    if (v('d-name') || v('d-ip')) {
      if (!v('d-name') || !v('d-ip')) { toast(t('Enter both a name and an IP for the first device'), 'warning'); return; }
      setup.first_device = { name: v('d-name'), ip: v('d-ip'), model: v('d-model') || v('model') };
    }
    const btn = e.submitter;
    setBusy(btn, true, t('Setting up'));
    try {
      const ws = await api.post('/api/workspaces', { type: 'local', name: v('name'), setup });
      const st = ws.process?.state;
      toast(t("'{name}' created — Oxidized: {state}", { name: ws.name, state: st === 'running' ? t('running') : st === 'waiting_nodes' ? t('waiting for the first device') : st }), 'success');
      onDone && onDone(ws);
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
}

// ------------------------------------------------------------------ remote workspace form
export function remoteForm(container, { onDone, onBack, existing } = {}) {
  const w = existing || { type: 'agent', name: '', config: { url: 'https://', verify_tls: true } };
  const c = w.config || {};
  container.innerHTML = `<form class="stack" autocomplete="off">
    ${existing ? '' : `<div class="grid c2">
      <label class="choice mini ${w.type === 'agent' ? 'active' : ''}"><input type="radio" name="rt" value="agent" ${w.type === 'agent' ? 'checked' : ''} hidden>
        ${icon('cloud')}<div><b>${esc(t('Oxidized Manager (recommended)'))}</b><div class="small muted">${esc(t('Full management: devices, debugging, logs, settings'))}</div></div></label>
      <label class="choice mini ${w.type === 'oxidized' ? 'active' : ''}"><input type="radio" name="rt" value="oxidized" ${w.type === 'oxidized' ? 'checked' : ''} hidden>
        ${icon('eye')}<div><b>${esc(t('Plain Oxidized REST API'))}</b><div class="small muted">${esc(t('Read-only: status, configs, versions, diffs, search, backup destinations'))}</div></div></label></div>`}
    <div class="field"><label>${esc(t('Workspace name'))} *</label><input class="input" id="rf-name" value="${esc(w.name)}" placeholder="${esc(t('Branch office'))}"></div>
    <div data-agent>
      <div class="alert info small" style="margin-bottom:14px">${icon('info')}<div class="alert-body">
        ${t('On the remote server, run Oxidized Manager with an embedded Oxidized, then create a key under <b>Administration → Remote access</b>. The connection only uses the panel\'s HTTPS port — no SSH and no Oxidized port needs to be opened.')}</div></div>
      <div class="grid c2">
        <div class="field span2"><label>${esc(t('Remote panel address'))} *</label><input class="input mono" id="rf-url" value="${esc(c.url || '')}" placeholder="https://oxidized.branch.example.com"></div>
        <div class="field span2"><label>${esc(t('API key'))} *</label>${pwField('rf-token', { placeholder: 'oxm_…', has: c.has_token })}</div>
      </div>
    </div>
    <div data-ox style="display:none">
      <div class="grid c2">
        <div class="field span2"><label>${esc(t('Oxidized REST address'))} *</label><input class="input mono" id="rf-oxurl" value="${esc(c.url || '')}" placeholder="http://10.0.0.5:8888"></div>
        <div class="field"><label>${esc(t('Basic auth user (if behind a proxy)'))}</label><input class="input" id="rf-user" value="${esc(c.username || '')}"></div>
        <div class="field"><label>${esc(t('Basic auth password'))}</label>${pwField('rf-pass', { has: c.has_password })}</div>
      </div>
    </div>
    <label class="chk"><input type="checkbox" id="rf-verify" ${c.verify_tls !== false ? 'checked' : ''}> ${esc(t('Verify the TLS certificate'))}</label>
    <div id="rf-result"></div>
    <div class="row" style="justify-content:space-between">
      ${onBack ? `<button type="button" class="btn" data-back>${icon('arrowLeft')} ${esc(t('Back'))}</button>` : '<span></span>'}
      <div class="row"><button type="button" class="btn" data-test>${icon('zap')} ${esc(t('Test connection'))}</button>
      <button class="btn primary" type="submit">${icon('check')} ${esc(existing ? t('Save') : t('Add workspace'))}</button></div></div>
  </form>`;
  const f = container.querySelector('form');
  const type = () => (existing ? w.type : f.querySelector('[name=rt]:checked').value);
  const sync = () => {
    $('[data-agent]', f).style.display = type() === 'agent' ? '' : 'none';
    $('[data-ox]', f).style.display = type() === 'oxidized' ? '' : 'none';
    $$('.choice.mini', f).forEach((l) => l.classList.toggle('active', l.querySelector('input').checked));
  };
  $$('[name=rt]', f).forEach((r) => { r.onchange = sync; });
  sync();
  f.querySelector('[data-back]')?.addEventListener('click', onBack);
  const payload = () => {
    const v = (id) => $(`#rf-${id}`, f).value.trim();
    const verify = $('#rf-verify', f).checked;
    if (type() === 'agent') return { type: 'agent', name: v('name'), config: { url: v('url'), token: v('token'), verify_tls: verify } };
    return { type: 'oxidized', name: v('name'), config: { url: v('oxurl'), username: v('user'), password: v('pass'), verify_tls: verify } };
  };
  const showResult = (r) => {
    $('#rf-result', f).innerHTML = r.ok
      ? `<div class="alert success">${icon('checkCircle')}<div class="alert-body"><b>${esc(t('Connected.'))}</b> ${esc(t('Remote workspace: {name} · version {version} · Oxidized: {state}', { name: r.name || '', version: r.version || '?', state: r.process?.state || '?' }))}</div></div>`
      : `<div class="alert danger">${icon('alert')}<div class="alert-body"><b>${esc(t('Could not connect.'))}</b> ${esc(r.error || '')}</div></div>`;
  };
  f.querySelector('[data-test]').onclick = async (e) => {
    const p = payload();
    if (p.type !== 'agent') { toast(t('Plain Oxidized APIs can be tested from the Workspaces page after saving'), 'info'); return; }
    setBusy(e.currentTarget, true);
    try { showResult(await api.post('/api/workspaces/test-agent', { ...p.config, id: existing?.id })); } catch (err) { toastError(err); }
    setBusy(e.currentTarget, false);
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const p = payload();
    if (!p.name) { toast(t('Workspace name is required'), 'warning'); return; }
    const btn = e.submitter;
    setBusy(btn, true);
    try {
      const ws = existing ? await api.put(`/api/workspaces/${existing.id}`, p) : await api.post('/api/workspaces', p);
      toast(t("'{name}' saved", { name: ws.name }), 'success');
      onDone && onDone(ws);
    } catch (err) { toastError(err); setBusy(btn, false); }
  };
}
