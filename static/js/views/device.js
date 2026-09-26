import { iapi, openStream } from '../api.js';
import { N_, t, tn } from '../i18n.js';
import { can, navigate, reloadToast, restartRequiredToast, state } from '../app.js';
import {
  $, $$, codeView, confirmDialog, copyText, diffView, download, empty, esc, fmtBytes, fmtDate, fmtDuration,
  icon, loader, modal, parseTime, setBusy, statusBadge, statusKey, terminal, timeAgo, toast, toastError,
} from '../ui.js';
import { getConfigSummary, invalidateConfig, openDeviceForm, testConsole } from './components.js';

const TABS = [
  ['overview', N_('Overview'), 'info'],
  ['config', N_('Configuration'), 'fileCode'],
  ['versions', N_('Versions & diff'), 'git'],
  ['debug', N_('Debug & test'), 'bug', 'operator'],
];

export async function render(view, params) {
  const name = params.name;
  const tab = params.tab || 'overview';
  const api = iapi(state.iid);
  const canOp = can('operator');
  let detail;
  try {
    detail = await api.node(name);
  } catch (e) {
    view.innerHTML = empty('server', t('Device not found'), esc(e.message), `<a class="btn" href="#/devices">${esc(t('Back to devices'))}</a>`);
    return null;
  }
  const src = detail.source || {};
  const rt = detail.runtime || {};
  const node = { ...rt, ...src };
  const skey = statusKey({ in_oxidized: !!rt.name, in_source: !!detail.source, status: rt.last?.status });

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="small"><a href="#/devices">${icon('arrowLeft')} ${esc(t('Devices'))}</a></div>
        <h1 class="row" style="margin-top:6px">${esc(name)} ${statusBadge(skey)}</h1>
        <div class="sub mono">${esc(node.ip || '')} · ${esc(node.model || '')}${node.group ? ` · ${esc(node.group)}` : ''}</div>
      </div>
      <div class="actions">
        ${canOp ? `<button class="btn" id="nd-fetch">${icon('refresh')} ${esc(t('Back up now'))}</button>` : ''}
        ${detail.source && canOp ? `<button class="btn" id="nd-edit">${icon('edit')} ${esc(t('Edit'))}</button>
        <button class="btn danger" id="nd-del" title="${esc(t('Delete'))}">${icon('trash')}</button>` : ''}
      </div>
    </div>
    <nav class="tabs">${TABS.filter((x) => !x[3] || can(x[3])).map(([k, l, ic]) => `<a href="#/devices/${encodeURIComponent(name)}/${k}" class="${tab === k ? 'active' : ''}">${icon(ic)}${esc(t(l))}</a>`).join('')}</nav>
    <div id="nd-tab"></div>`;

  $('#nd-fetch', view)?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    setBusy(b, true);
    try { await api.fetchNow(name); toast(t('Moved to the front of the backup queue. Watch it live on the Debug tab.'), 'success'); } catch (err) { toastError(err); }
    setBusy(b, false);
  });
  $('#nd-edit', view)?.addEventListener('click', () => openDeviceForm(src, {
    onSaved: (v) => {
      if (v.name && v.name !== name) navigate(`#/devices/${encodeURIComponent(v.name)}/${tab}`);
      else window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
  }));
  $('#nd-del', view)?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: t('Delete {name}?', { name }), message: esc(t('The device is removed from router.db. The git history is kept.')), confirm: t('Delete'), danger: true })) return;
    try { const r = await api.deleteNode(name); reloadToast(r.reload, t('{name} deleted', { name })); navigate('#/devices'); } catch (e) { toastError(e); }
  });

  const tabEl = $('#nd-tab', view);
  if (tab === 'config') return renderConfig(tabEl, api, name);
  if (tab === 'versions') return renderVersions(tabEl, api, name);
  if (tab === 'debug' && canOp) return renderDebug(tabEl, api, name, detail);
  return renderOverview(tabEl, api, name, detail);
}

// ------------------------------------------------------------------ overview
function historyFromStats(stats) {
  const items = [];
  if (!stats || typeof stats !== 'object') return items;
  Object.entries(stats).forEach(([status, arr]) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((x) => items.push({ status, ...x }));
  });
  return items.sort((a, b) => (parseTime(b.end)?.getTime() || 0) - (parseTime(a.end)?.getTime() || 0));
}

function diagnostics(detail) {
  const out = [];
  const s = detail.source || {};
  const r = detail.resolved;
  if (!detail.runtime) out.push(['warning', t('The device is in router.db but not loaded in Oxidized. Oxidized may need a reload/restart, or the line is invalid.')]);
  if (!detail.source && detail.runtime) out.push(['info', t('The device is in Oxidized but not in router.db (other source or no file access).')]);
  if (s.ip && s.ip.includes('/')) out.push(['info', t('IP "{ip}" contains a prefix; Oxidized ignores everything after "/" and connects to {host}.', { ip: s.ip, host: s.ip.split('/')[0] })]);
  if (r) {
    if (!r.has_password) out.push(['danger', t('No effective password (device, group and global are all empty).')]);
    if (!r.username) out.push(['danger', t('No effective username.')]);
    if (s.group && r.username_from === 'global' && r.password_from === 'global') out.push(['info', t("Group '{group}' has no credentials; the global user is used.", { group: s.group })]);
  }
  if (s.model && state.models.length && !state.models.includes(String(s.model).toLowerCase()) && !(r && state.models.includes(String(r.model).toLowerCase()))) {
    out.push(['warning', t("'{model}' is not a known Oxidized model (unless mapped with model_map the device cannot be loaded).", { model: s.model })]);
  }
  const last = detail.runtime?.last;
  if (last && last.status && last.status !== 'success') {
    const hint = {
      no_connection: t('The TCP connection or the authentication failed. Check port / firewall / password on the "Debug & test" tab.'),
      timeout: t('The device did not answer in time; the prompt regex may not match or the timeout is too low.'),
    }[last.status];
    out.push(['danger', `${t('Last attempt: {status}.', { status: last.status })} ${hint || t('See the debug logs for details.')}`]);
  }
  return out;
}

async function renderOverview(el, api, name, detail) {
  const s = detail.source || {};
  const r = detail.resolved;
  const rt = detail.runtime || {};
  const last = rt.last || {};
  const hist = historyFromStats(detail.stats);
  const diag = diagnostics(detail);
  const src = (x) => ({ device: t('device'), global: t('global'), default: t('default'), undefined: t('undefined'), 'global vars': t('global vars') }[x] || x);
  const tag = (x) => (x ? `<span class="source-tag">← ${esc(src(x))}</span>` : '');
  el.innerHTML = `
    ${diag.map(([lv, msg]) => `<div class="alert ${lv}" style="margin-bottom:10px">${icon(lv === 'danger' ? 'alert' : 'info')}<div class="alert-body">${esc(msg)}</div></div>`).join('')}
    <div class="grid c2" style="margin-top:6px">
      <div class="card"><div class="card-head"><h3>${icon('server')} ${esc(t('Device definition (router.db)'))}</h3></div><div class="card-body">
        ${detail.source ? `<div class="kv">
          <div>${esc(t('Name'))}</div><div><b>${esc(s.name)}</b> <span class="small muted">${esc(t('line {n}', { n: s.line }))}</span></div>
          <div>${esc(t('IP / host'))}</div><div class="mono">${esc(s.ip || '—')}</div>
          <div>${esc(t('Model'))}</div><div><span class="badge mono outline">${esc(s.model || '—')}</span>${r && r.model !== s.model ? ` → <span class="badge mono">${esc(r.model)}</span>` : ''}</div>
          <div>${esc(t('Group'))}</div><div>${s.group ? (can('manager') ? `<a href="#/groups">${esc(s.group)}</a>` : esc(s.group)) : '—'}</div>
          <div>${esc(t('Protocol'))}</div><div>${esc(s.input || '—')}</div>
          <div>${esc(t('SSH / Telnet port'))}</div><div class="mono">${esc(s.ssh_port || '—')} / ${esc(s.telnet_port || '—')}</div>
          <div>${esc(t('Username'))}</div><div class="mono">${esc(s.username || '—')}</div>
          <div>${esc(t('Password / enable'))}</div><div>${s.has_password ? `<span class="badge success">${esc(t('device-specific'))}</span>` : '<span class="muted">—</span>'} ${s.has_enable ? `<span class="badge success">${esc(t('enable set'))}</span>` : ''}</div>
          ${s.extra_columns ? `<div>${esc(t('Extra columns'))}</div><div class="mono small">${esc(JSON.stringify(s.extra_columns))}</div>` : ''}
        </div>` : `<div class="muted">${esc(t('No router.db entry'))}</div>`}
      </div></div>
      <div class="card"><div class="card-head"><h3>${icon('zap')} ${esc(t('Effective settings (what Oxidized uses)'))}</h3>
        <div class="actions">${r && can('operator') ? `<button class="btn sm" id="nd-reveal">${icon('eye')} ${esc(t('Show passwords'))}</button>` : ''}</div></div><div class="card-body">
        ${r ? `<div class="kv">
          <div>${esc(t('Model'))}</div><div class="mono">${esc(r.model)}</div>
          <div>${esc(t('Protocol order'))}</div><div>${esc(r.input)}</div>
          <div>${esc(t('SSH port'))}</div><div class="mono">${r.ssh_port}${tag(r.ssh_port_from)}</div>
          <div>${esc(t('Telnet port'))}</div><div class="mono">${r.telnet_port}${tag(r.telnet_port_from)}</div>
          <div>${esc(t('Username'))}</div><div class="mono">${esc(r.username || '—')}${tag(r.username_from)}</div>
          <div>${esc(t('Password'))}</div><div><span id="rv-pw">${r.has_password ? '••••••••' : `<span class="badge danger">${esc(t('none'))}</span>`}</span>${tag(r.password_from)}</div>
          <div>${esc(t('Enable'))}</div><div><span id="rv-en">${r.has_enable ? '••••••••' : '—'}</span>${tag(r.enable_from)}</div>
          <div>auth_methods</div><div class="mono small">${esc(r.auth_methods ? r.auth_methods.join(', ') : t('default (none, publickey, password)'))}</div>
          <div>${esc(t('Prompt regex'))}</div><div class="mono small">${esc(r.prompt)}</div>
          <div>${esc(t('Timeout'))}</div><div>${r.timeout} s</div>
        </div>` : `<div class="muted">${esc(t('Cannot be calculated without file access'))}</div>`}
      </div></div>
      <div class="card"><div class="card-head"><h3>${icon('activity')} ${esc(t('Oxidized runtime state'))}</h3></div><div class="card-body">
        ${rt.name ? `<div class="kv">
          <div>${esc(t('Full name'))}</div><div class="mono">${esc(rt.full_name || rt.name)}</div>
          <div>${esc(t('Oxidized IP'))}</div><div class="mono">${esc(rt.ip)}</div>
          <div>${esc(t('Oxidized model'))}</div><div class="mono">${esc(rt.model)}</div>
          <div>${esc(t('Last status'))}</div><div>${statusBadge(last.status || 'never')}</div>
          <div>${esc(t('Last start'))}</div><div>${fmtDate(last.start)}</div>
          <div>${esc(t('Last end'))}</div><div>${fmtDate(last.end)} <span class="muted small">(${timeAgo(last.end)})</span></div>
          <div>${esc(t('Duration'))}</div><div>${fmtDuration(last.time)}</div>
          <div>${esc(t('Last config change'))}</div><div>${rt.mtime && rt.mtime !== 'unknown' ? `${fmtDate(rt.mtime)} <span class="muted small">(${timeAgo(rt.mtime)})</span>` : '—'}</div>
        </div>` : `<div class="muted">${esc(t('This device is not in the Oxidized API, or the API is not reachable.'))}</div>`}
      </div></div>
      <div class="card"><div class="card-head"><h3>${icon('history')} ${esc(t('Run history'))}</h3><span class="muted small">(${esc(t('latest entries kept in Oxidized memory'))})</span></div>
        <div class="card-body" style="max-height:360px;overflow:auto">
        ${hist.length ? `<ul class="timeline">${hist.slice(0, 40).map((x) => `<li>
          <span class="tl-dot" style="background:${x.status === 'success' ? 'var(--success)' : 'var(--danger)'}"></span>
          <div style="flex:1">${statusBadge(x.status)} <span class="small muted">${fmtDuration(x.time)}</span></div>
          <span class="small muted" title="${esc(fmtDate(x.end))}">${timeAgo(x.end)}</span></li>`).join('')}</ul>`
          : `<div class="muted">${esc(t('No history (it is reset when Oxidized restarts).'))}</div>`}
      </div></div>
    </div>`;
  $('#nd-reveal', el)?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try {
      const sec = await api.secrets(name);
      const show = (v) => (v ? `<span class="pw-reveal">${esc(v)}</span> <button class="btn ghost sm icon" data-copy="${esc(v)}">${icon('copy')}</button>` : '—');
      $('#rv-pw', el).innerHTML = show(sec.effective_password);
      $('#rv-en', el).innerHTML = show(sec.effective_enable);
      $$('[data-copy]', el).forEach((c) => { c.onclick = () => copyText(c.dataset.copy); });
      b.remove();
    } catch (err) { toastError(err); }
  });
  return null;
}

// ------------------------------------------------------------------ config
async function renderConfig(el, api, name) {
  el.innerHTML = loader(t('Fetching the config from Oxidized…'));
  let text;
  try { text = await api.config(name); } catch (e) {
    el.innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body"><b>${esc(t('The config could not be loaded.'))}</b> ${esc(e.message)}<br><span class="small">${esc(t('The device may not have been backed up yet.'))}</span></div></div>`;
    return null;
  }
  const lines = text.split('\n').length;
  el.innerHTML = `<div class="card">
    <div class="toolbar">
      <div class="input-wrap">${icon('search')}<input class="input" id="cf-q" placeholder="${esc(t('Search in the config…'))}"></div>
      <span class="small muted" id="cf-hits"></span>
      <button class="btn sm" id="cf-next" title="${esc(t('Next match (Enter)'))}">${icon('chevronDown')}</button>
      <div style="flex:1"></div>
      <span class="small muted">${esc(tn('{n} line', '{n} lines', lines))} · ${fmtBytes(new Blob([text]).size)}</span>
      <button class="btn sm" id="cf-copy">${icon('copy')} ${esc(t('Copy'))}</button>
      <button class="btn sm" id="cf-dl">${icon('download')} ${esc(t('Download'))}</button>
    </div>
    <div class="card-body" id="cf-view">${codeView(text)}</div></div>`;
  let hitIdx = -1;
  const drawView = (q) => {
    $('#cf-view', el).innerHTML = codeView(text, { needle: q });
    const hits = $$('tr.hl', el);
    $('#cf-hits', el).textContent = q ? tn('{n} match', '{n} matches', hits.length) : '';
    hitIdx = -1;
  };
  const next = () => {
    const hits = $$('tr.hl', el);
    if (!hits.length) return;
    hitIdx = (hitIdx + 1) % hits.length;
    hits[hitIdx].scrollIntoView({ block: 'center' });
  };
  let tm;
  $('#cf-q', el).oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => drawView(e.target.value.trim()), 200); };
  $('#cf-q', el).onkeydown = (e) => { if (e.key === 'Enter') next(); };
  $('#cf-next', el).onclick = next;
  $('#cf-copy', el).onclick = () => copyText(text);
  $('#cf-dl', el).onclick = () => download(`${name}.cfg`, text);
  return null;
}

// ------------------------------------------------------------------ versions
async function renderVersions(el, api, name) {
  el.innerHTML = loader(t('Loading the version history…'));
  let versions;
  try { versions = await api.versions(name); } catch (e) {
    el.innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body">${esc(e.message)}<br><span class="small">${esc(t('Version history only works with the git output (output: git).'))}</span></div></div>`;
    return null;
  }
  if (!versions.length) { el.innerHTML = `<div class="card">${empty('git', t('No versions'), esc(t('No git history was found for this device.')))}</div>`; return null; }
  const vdate = (v) => v.date || v.time || v.author?.time;
  let selA = versions.length > 1 ? 1 : 0; // older
  let selB = -1; // -1 = current config
  let mode = 'unified';
  el.innerHTML = `<div class="split-pane">
    <div class="card"><div class="card-head"><h3>${esc(tn('{n} version', '{n} versions', versions.length))}</h3></div>
      <div class="small muted" style="padding:10px 14px;border-bottom:1px solid var(--border)">${t('Click: select the <b style="color:var(--danger)">older</b> version · Shift+click: select the <b style="color:var(--success)">newer</b> one')}</div>
      <div class="version-list" id="vl"></div></div>
    <div class="card"><div class="card-head"><h3 id="vd-title">${esc(t('Diff'))}</h3>
      <div class="actions"><div class="btn-group"><button class="btn sm active" data-mode="unified">${icon('list')} ${esc(t('Unified'))}</button><button class="btn sm" data-mode="split">${icon('columns')} ${esc(t('Side by side'))}</button></div>
      <button class="btn sm" id="vd-view">${icon('fileCode')} ${esc(t('View older version'))}</button></div></div>
      <div class="card-body" id="vd"></div></div></div>`;
  const drawList = () => {
    $('#vl', el).innerHTML = `<div class="version-item ${selB === -1 ? 'sel-b' : ''}" data-i="-1"><div style="flex:1"><b>${esc(t('Current config'))}</b><div class="small muted">${esc(t('latest collected by Oxidized'))}</div></div>${selB === -1 ? `<span class="badge success">${esc(t('newer'))}</span>` : ''}</div>`
      + versions.map((v, i) => `<div class="version-item ${i === selA ? 'sel-a' : ''} ${i === selB ? 'sel-b' : ''}" data-i="${i}">
        <div style="flex:1;min-width:0"><div><b>${timeAgo(vdate(v))}</b> <span class="small muted">${esc(fmtDate(vdate(v)))}</span></div>
        <div class="small muted ellipsis">${esc(v.author?.name || '')} ${v.message ? `· ${esc(String(v.message).trim())}` : ''}</div>
        <div class="oid">${esc(String(v.oid).slice(0, 12))}</div></div>
        ${i === selA ? `<span class="badge danger">${esc(t('older'))}</span>` : ''}${i === selB ? `<span class="badge success">${esc(t('newer'))}</span>` : ''}</div>`).join('');
    $$('.version-item', el).forEach((it) => {
      it.onclick = (e) => {
        const i = +it.dataset.i;
        if (e.shiftKey || i === -1) selB = i; else selA = i;
        drawList(); drawDiff();
      };
    });
  };
  let lastPatch = null;
  const drawDiff = async () => {
    const a = versions[selA];
    const b = selB === -1 ? 'current' : versions[selB].oid;
    $('#vd-title', el).textContent = `${String(a.oid).slice(0, 8)} → ${b === 'current' ? t('current') : String(b).slice(0, 8)}`;
    $('#vd', el).innerHTML = loader(t('Calculating the diff…'));
    try {
      const d = await api.diff(name, a.oid, b);
      lastPatch = d.patch;
      $('#vd', el).innerHTML = `<div class="row small" style="margin-bottom:10px"><span class="badge success">+${d.added}</span><span class="badge danger">−${d.removed}</span></div>${diffView(d.patch, mode)}`;
    } catch (e) { $('#vd', el).innerHTML = `<div class="alert danger">${icon('alert')}<div class="alert-body">${esc(e.message)}</div></div>`; }
  };
  $$('[data-mode]', el).forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode;
      $$('[data-mode]', el).forEach((x) => x.classList.toggle('active', x === b));
      if (lastPatch != null) $('#vd', el).querySelector('.codeview, .empty')?.replaceWith(document.createRange().createContextualFragment(diffView(lastPatch, mode)));
    };
  });
  $('#vd-view', el).onclick = async () => {
    const v = versions[selA];
    try {
      const txt = await api.version(name, v.oid, vdate(v), versions.length - selA);
      const m = modal({ title: `${esc(name)} @ ${esc(String(v.oid).slice(0, 10))} — ${esc(fmtDate(vdate(v)))}`, size: 'xl', body: codeView(txt), footer: `<button class="btn" data-a="dl">${esc(t('Download'))}</button>` });
      m.foot.querySelector('[data-a=dl]').onclick = () => download(`${name}-${String(v.oid).slice(0, 8)}.cfg`, txt);
    } catch (e) { toastError(e); }
  };
  drawList();
  drawDiff();
  return null;
}

// ------------------------------------------------------------------ debug
async function renderDebug(el, api, name, detail) {
  const ip = (detail.source?.ip || detail.runtime?.ip || '').split('/')[0];
  const hasLogs = state.workspaces.find((w) => w.id === state.iid)?.type !== 'oxidized';
  el.innerHTML = `
    <div class="stack">
      ${hasLogs ? `<div class="card"><div class="card-head"><h3>${icon('activity')} ${esc(t('Watch Oxidized live'))}</h3>
        <span class="small muted">${esc(t('Oxidized log lines filtered for this device'))}</span>
        <div class="actions"><label class="chk small"><input type="checkbox" id="lw-all"> ${esc(t('Show all logs'))}</label>
          <button class="btn sm" id="lw-watch">${icon('eye')} ${esc(t('Watch only'))}</button>
          <button class="btn sm primary" id="lw-run">${icon('play')} ${esc(t('Back up now & watch'))}</button></div></div>
        <div class="card-body"><div class="term-bar"><span class="live-dot" id="lw-dot"></span><span id="lw-state" class="small">${esc(t('Not connected'))}</span></div>
          <div class="terminal" id="lw-term"><span class="l t-info">• ${esc(t('"Back up now & watch" moves the device to the front of the Oxidized queue and shows the log lines Oxidized writes for it, live.'))}
• ${esc(t('For the full device conversation, enable Oxidized input debug below.'))}</span></div></div></div>` : ''}
      <div class="card"><div class="card-head"><h3>${icon('terminal')} ${esc(t('Connection test (from the panel)'))}</h3>
        <span class="small muted">${esc(t('Same credential / port resolution as Oxidized · everything sent and received is shown'))}</span></div>
        <div class="card-body" id="tc"></div></div>
      ${hasLogs ? `<div class="card"><div class="card-head"><h3>${icon('bug')} ${esc(t('Oxidized input debug files'))}</h3>
        <div class="actions"><button class="btn sm" id="df-refresh">${icon('refresh')}</button></div></div>
        <div class="card-body" id="df-body">${loader()}</div></div>` : ''}
    </div>`;

  // --- live log
  let stream = null;
  if (hasLogs) {
    const term = terminal($('#lw-term', el));
    const filterStr = [name, ip].filter(Boolean).join('|');
    term.setFilter(filterStr);
    const setLive = (on, txt) => { $('#lw-dot', el).classList.toggle('on', on); $('#lw-state', el).textContent = txt; };
    const watch = () => new Promise((resolve) => {
      if (stream) { resolve(); return; }
      setLive(true, t('Connecting…'));
      stream = openStream(`/api/w/${state.iid}/ws/logs?tail=30`, {
        onOpen: () => { setLive(true, t('Live — filter: {f}', { f: filterStr })); resolve(); },
        onItems: (items) => term.add(items),
        onEnd: () => { stream = null; setLive(false, t('Connection closed')); resolve(); },
      });
    });
    $('#lw-all', el).onchange = (e) => term.setFilter(e.target.checked ? '' : filterStr);
    $('#lw-watch', el).onclick = () => watch();
    $('#lw-run', el).onclick = async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, true);
      await watch();
      try {
        await api.fetchNow(name);
        term.add([{ t: 'ok', d: t('{name} is at the front of the queue — Oxidized connects with the next free thread', { name }), ts: Date.now() / 1000 }]);
      } catch (err) { term.add([{ t: 'error', d: err.message, ts: Date.now() / 1000 }]); }
      setBusy(btn, false);
    };
  }

  // --- connection test
  const stopTest = testConsole($('#tc', el), () => ({ node: name }));

  // --- input debug files
  const loadFiles = async () => {
    const box = $('#df-body', el);
    try {
      const r = await api.debugFiles(name);
      const on = r.input_debug === true || (typeof r.input_debug === 'string' && r.input_debug !== 'false');
      box.innerHTML = `
        <div class="row between" style="margin-bottom:12px">
          <div>Oxidized <code>input.debug</code>: ${on ? `<span class="badge success">${esc(t('on'))}</span>` : `<span class="badge">${esc(t('off'))}</span>`}
            <div class="small muted">${t('When on, Oxidized writes the whole device conversation of every connection to <code>logs/&lt;ip&gt;-&lt;input&gt;-&lt;time&gt;.txt</code>. Changing it requires an Oxidized restart.')}</div></div>
          ${can('manager') ? `<button class="btn sm ${on ? '' : 'primary'}" id="df-toggle">${esc(on ? t('Turn off') : t('Turn input debug on'))}</button>` : ''}
        </div>
        ${r.files.length ? `<table class="table"><thead><tr><th>${esc(t('File'))}</th><th>${esc(t('Size'))}</th><th>${esc(t('Time'))}</th><th></th></tr></thead><tbody>
          ${r.files.map((f) => `<tr><td class="mono small">${esc(f.path)}</td><td class="small">${fmtBytes(f.size)}</td><td class="small" title="${esc(fmtDate(f.mtime))}">${timeAgo(f.mtime)}</td>
            <td class="actions"><button class="btn sm" data-open="${esc(f.path)}">${icon('eye')} ${esc(t('Open'))}</button></td></tr>`).join('')}</tbody></table>`
          : `<div class="muted small">${esc(t('No debug files for this device ({host}).', { host: ip || name }))}${on ? ` ${esc(t('Trigger a backup.'))}` : ''}</div>`}`;
      $('#df-toggle', box)?.addEventListener('click', async (e) => {
        const b = e.currentTarget;
        setBusy(b, true);
        try {
          await api.cfgSettings({ 'input.debug': !on });
          invalidateConfig();
          restartRequiredToast(!on ? t('input.debug turned on. Restart Oxidized to apply.') : t('input.debug turned off. Restart Oxidized to apply.'));
          loadFiles();
        } catch (err) { toastError(err); setBusy(b, false); }
      });
      $$('[data-open]', box).forEach((b) => {
        b.onclick = async () => {
          try {
            const txt = await api.file(b.dataset.open);
            const m = modal({ title: esc(b.dataset.open), size: 'xl', body: `<div class="terminal tall">${esc(txt)}</div>`, footer: `<button class="btn" data-a="dl">${esc(t('Download'))}</button>` });
            m.foot.querySelector('[data-a=dl]').onclick = () => download(b.dataset.open.split('/').pop(), txt);
          } catch (err) { toastError(err); }
        };
      });
    } catch (e) {
      box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
    }
  };
  if (hasLogs) {
    $('#df-refresh', el).onclick = loadFiles;
    loadFiles();
  }
  getConfigSummary().catch(() => {});

  return () => { stream && stream.close(); stopTest && stopTest(); };
}
