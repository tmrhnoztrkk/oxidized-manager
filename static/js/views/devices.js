import { iapi } from '../api.js';
import { N_, t, tn } from '../i18n.js';
import { can, navigate, reloadToast, setCount, state } from '../app.js';
import { $, $$, confirmDialog, debounce, dropdown, empty, esc, fmtDate, icon, modal, setBusy, statusBadge, statusKey, STATUS, timeAgo, toast, toastError } from '../ui.js';
import { invalidateConfig, openBulkEdit, openDeviceForm } from './components.js';

const PREF_KEY = 'oxmgr-devprefs';

function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (e) { /* storage blocked */ }
  try {
    const once = JSON.parse(sessionStorage.getItem('oxmgr-devfilter') || 'null');
    if (once) { Object.assign(p, once); sessionStorage.removeItem('oxmgr-devfilter'); }
  } catch (e) { /* storage blocked */ }
  return { q: '', group: '', model: '', status: '', sort: 'name', dir: 1, pageSize: 50, ...p };
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ sort: p.sort, dir: p.dir, pageSize: p.pageSize, group: p.group, model: p.model, status: p.status })); } catch (e) { /* storage blocked */ }
}

function portsCell(n) {
  const inp = (n.input || '').split(',').map((s) => s.trim()).filter(Boolean);
  const parts = [];
  if (!inp.length || inp.includes('ssh')) parts.push(`<span class="badge outline mono" title="SSH">SSH${n.ssh_port ? `:${esc(n.ssh_port)}` : ''}</span>`);
  if (inp.includes('telnet') || n.telnet_port) parts.push(`<span class="badge outline mono" title="Telnet">TEL${n.telnet_port ? `:${esc(n.telnet_port)}` : ''}</span>`);
  inp.filter((x) => !['ssh', 'telnet'].includes(x)).forEach((x) => parts.push(`<span class="badge outline mono">${esc(x.toUpperCase())}</span>`));
  return `<div class="row" style="gap:4px">${parts.join('')}${!n.input ? `<span class="small muted" title="${esc(t('Protocol comes from the group / global setting'))}">•</span>` : ''}</div>`;
}

function credCell(n) {
  const bits = [];
  if (n.username) bits.push(`<span class="mono small">${esc(n.username)}</span>`);
  if (n.has_password) bits.push(`<span title="${esc(t('Device-specific password'))}">${icon('key')}</span>`);
  if (n.has_enable) bits.push(`<span title="${esc(t('Enable password'))}">${icon('lock')}</span>`);
  return bits.length ? `<div class="row" style="gap:6px;color:var(--text-2)">${bits.join('')}</div>` : `<span class="small muted">${esc(t('group/global'))}</span>`;
}

export async function render(view, params) {
  const api = iapi(state.iid);
  const prefs = loadPrefs();
  const canOp = can('operator');
  let data = { nodes: [] };
  let selected = new Set();
  let page = 0;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(t('Devices'))}</h1><div class="sub" id="dv-sub">${esc(t('Loading…'))}</div></div>
      <div class="actions">
        <button class="btn" id="dv-tools">${icon('more')} ${esc(t('Tools'))}</button>
        <button class="btn" id="dv-refresh" title="${esc(t('Refresh'))}">${icon('refresh')}</button>
        ${canOp ? `<button class="btn primary" id="dv-add">${icon('plus')} ${esc(t('Add device'))}</button>` : ''}
      </div>
    </div>
    <div id="dv-alerts"></div>
    <div class="card">
      <div class="toolbar">
        <div class="input-wrap">${icon('search')}<input class="input" id="dv-q" placeholder="${esc(t('Search name, IP, model, group or user…  ( / )'))}" value="${esc(prefs.q)}"></div>
        <select class="select" id="dv-group"><option value="">${esc(t('All groups'))}</option></select>
        <select class="select" id="dv-model"><option value="">${esc(t('All models'))}</option></select>
        <div class="chips" id="dv-status"></div>
      </div>
      <div id="dv-bulk"></div>
      <div class="table-wrap" id="dv-table"></div>
      <div class="table-foot" id="dv-foot"></div>
    </div>`;

  const load = async () => {
    data = await api.nodes();
    setCount('devices', data.nodes.length);
    selected = new Set([...selected].filter((n) => data.nodes.find((x) => x.name === n)));
    const groups = [...new Set(data.nodes.map((n) => n.group).filter(Boolean))].sort();
    const models = [...new Set(data.nodes.map((n) => n.model).filter(Boolean))].sort();
    $('#dv-group', view).innerHTML = `<option value="">${esc(t('All groups'))}</option>${groups.map((g) => `<option ${g === prefs.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}`;
    $('#dv-model', view).innerHTML = `<option value="">${esc(t('All models'))}</option>${models.map((g) => `<option ${g === prefs.model ? 'selected' : ''}>${esc(g)}</option>`).join('')}`;
    const alerts = [];
    if (data.api_error) alerts.push(`<div class="alert warning" style="margin-bottom:14px">${icon('alert')}<div class="alert-body"><b>${esc(t('The Oxidized API could not be read'))}</b> — ${esc(t('backup status is not available.'))} ${esc(data.api_error)}</div></div>`);
    if (!data.editable) alerts.push(`<div class="alert info" style="margin-bottom:14px">${icon('info')}<div class="alert-body">${esc(t('This workspace is a plain Oxidized REST API: devices can only be viewed.'))}</div></div>`);
    const errs = (data.issues || []).filter((i) => i.level === 'error');
    if (errs.length) alerts.push(`<div class="alert warning" style="margin-bottom:14px">${icon('alert')}<div class="alert-body"><b>${esc(t('Schema warning:'))}</b> ${esc(errs[0].message)} ${can('manager') ? `<a href="#/settings/schema">${esc(t('Fix →'))}</a>` : ''}</div></div>`);
    $('#dv-alerts', view).innerHTML = alerts.join('');
    if ($('#dv-add', view)) $('#dv-add', view).disabled = !data.editable;
    draw();
  };

  const filtered = () => {
    const q = prefs.q.toLowerCase();
    let rows = data.nodes.filter((n) => {
      if (prefs.group && n.group !== prefs.group) return false;
      if (prefs.model && n.model !== prefs.model) return false;
      if (prefs.status) {
        const s = statusKey(n);
        if (prefs.status === 'fail') { if (['success', 'never', 'unknown'].includes(s)) return false; } else if (s !== prefs.status) return false;
      }
      if (q) {
        const hay = [n.name, n.ip, n.model, n.group, n.username, n.input].join(' ').toLowerCase();
        return q.split(/\s+/).every((x) => hay.includes(x));
      }
      return true;
    });
    const key = prefs.sort;
    const val = (n) => {
      if (key === 'status') return statusKey(n);
      if (key === 'time' || key === 'mtime') return new Date(n[key] && n[key] !== 'never' && n[key] !== 'unknown' ? String(n[key]).replace(' UTC', 'Z') : 0).getTime() || 0;
      if (key === 'ip') return (n.ip || '').split(/[./]/).map((x) => x.padStart(3, '0')).join('.');
      return String(n[key] ?? '').toLowerCase();
    };
    rows = rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * prefs.dir);
    return rows;
  };

  const drawChips = () => {
    const counts = { '': data.nodes.length, success: 0, fail: 0, never: 0, unknown: 0 };
    data.nodes.forEach((n) => {
      const s = statusKey(n);
      if (s === 'success' || s === 'never' || s === 'unknown') counts[s]++; else counts.fail++;
    });
    const chips = [['', N_('All')], ['success', N_('Success')], ['fail', N_('Failed')], ['never', N_('Never backed up')], ['unknown', N_('Not loaded')]]
      .filter(([k]) => k === '' || counts[k] > 0);
    $('#dv-status', view).innerHTML = chips.map(([k, l]) => `<button class="chip ${prefs.status === k ? 'active' : ''}" data-st="${k}">${esc(t(l))} <span class="n">${counts[k]}</span></button>`).join('');
    $$('[data-st]', view).forEach((b) => { b.onclick = () => { prefs.status = b.dataset.st; page = 0; savePrefs(prefs); draw(); }; });
  };

  const drawBulk = () => {
    const el = $('#dv-bulk', view);
    if (!selected.size || !canOp) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="bulkbar"><b>${esc(tn('{n} device selected', '{n} devices selected', selected.size))}</b>
      <button class="btn sm" data-b="fetch">${icon('refresh')} ${esc(t('Back up now'))}</button>
      ${data.editable ? `<button class="btn sm" data-b="edit">${icon('edit')} ${esc(t('Bulk edit'))}</button>
      <button class="btn sm danger" data-b="delete">${icon('trash')} ${esc(t('Delete'))}</button>` : ''}
      <button class="btn sm ghost" data-b="clear">${esc(t('Clear selection'))}</button></div>`;
    el.querySelector('[data-b=clear]').onclick = () => { selected.clear(); draw(); };
    el.querySelector('[data-b=fetch]').onclick = async (e) => {
      setBusy(e.currentTarget, true);
      try {
        const r = await api.bulk({ action: 'fetch', names: [...selected] });
        toast(tn('{n} device moved to the front of the backup queue', '{n} devices moved to the front of the backup queue', r.ok) + (r.errors.length ? ` · ${tn('{n} error', '{n} errors', r.errors.length)}` : ''), r.errors.length ? 'warning' : 'success');
      } catch (err) { toastError(err); }
      setBusy(e.currentTarget, false);
    };
    el.querySelector('[data-b=edit]')?.addEventListener('click', () => openBulkEdit([...selected], () => { invalidateConfig(); load(); }));
    el.querySelector('[data-b=delete]')?.addEventListener('click', async () => {
      const names = [...selected];
      if (!await confirmDialog({ title: tn('Delete {n} device?', 'Delete {n} devices?', names.length), message: `${esc(t('The devices are removed from router.db. Old backups in the Oxidized git history are kept.'))}<br><br><span class="small muted">${names.slice(0, 10).map(esc).join(', ')}${names.length > 10 ? '…' : ''}</span>`, confirm: t('Delete'), danger: true, requireText: names.length > 3 ? 'DELETE' : undefined })) return;
      try {
        const r = await api.bulk({ action: 'delete', names });
        selected.clear();
        reloadToast(r.reload, tn('{n} device deleted', '{n} devices deleted', r.ok));
        load();
      } catch (err) { toastError(err); }
    });
  };

  N_('Device'); N_('Model'); N_('Group'); N_('Status'); N_('Last attempt'); N_('Last change');
  const th = (key, label, extra = '') => `<th class="sortable" data-sort="${key}" ${extra}>${esc(t(label))}${prefs.sort === key ? `<span class="arrow">${prefs.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;

  const draw = () => {
    drawChips();
    drawBulk();
    const rows = filtered();
    const size = prefs.pageSize || 1e9;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    page = Math.min(page, pages - 1);
    const slice = rows.slice(page * size, page * size + size);
    $('#dv-sub', view).textContent = `${tn('{n} device', '{n} devices', data.nodes.length)} · ${t('{n} shown', { n: rows.length })}`;
    const tbl = $('#dv-table', view);
    if (!data.nodes.length) {
      tbl.innerHTML = empty('server', t('No devices yet'), esc(t('Add the first device or import a CSV / router.db.')),
        data.editable && canOp ? `<button class="btn primary" id="dv-empty-add">${icon('plus')} ${esc(t('Add device'))}</button>` : '');
      $('#dv-empty-add', tbl)?.addEventListener('click', addDevice);
      $('#dv-foot', view).innerHTML = '';
      return;
    }
    if (!rows.length) {
      tbl.innerHTML = empty('filter', t('No matching devices'), esc(t('Change the filters.')));
      $('#dv-foot', view).innerHTML = '';
      return;
    }
    const allSel = slice.every((n) => selected.has(n.name));
    tbl.innerHTML = `<table class="table"><thead><tr>
      ${canOp ? `<th class="w-check"><input type="checkbox" id="dv-all" ${allSel ? 'checked' : ''}></th>` : ''}
      ${th('name', 'Device')}${th('model', 'Model')}${th('group', 'Group')}<th>${esc(t('Protocol / port'))}</th><th>${esc(t('Credentials'))}</th>
      ${th('status', 'Status')}${th('time', 'Last attempt')}${th('mtime', 'Last change')}<th></th></tr></thead><tbody>
      ${slice.map((n) => {
        const warn = n.ip && n.ip.includes('/') ? `<span class="badge warning" title="${esc(t('The IP has a /prefix. Oxidized ignores everything after the /.'))}">/${esc(n.ip.split('/')[1])}</span>` : '';
        return `<tr class="clickable ${selected.has(n.name) ? 'selected' : ''}" data-name="${esc(n.name)}">
        ${canOp ? `<td class="w-check" data-stop><input type="checkbox" data-sel="${esc(n.name)}" ${selected.has(n.name) ? 'checked' : ''}></td>` : ''}
        <td><div class="name-cell">${esc(n.name)}</div><div class="sub-cell mono row" style="gap:6px">${esc((n.ip || '').split('/')[0])} ${warn}</div></td>
        <td><span class="badge mono outline">${esc(n.model || '—')}</span></td>
        <td>${n.group ? `<span class="badge primary">${esc(n.group)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${portsCell(n)}</td>
        <td>${credCell(n)}</td>
        <td>${statusBadge(statusKey(n))}</td>
        <td class="nowrap small" title="${esc(fmtDate(n.time))}">${timeAgo(n.time)}</td>
        <td class="nowrap small" title="${esc(fmtDate(n.mtime))}">${n.mtime && n.mtime !== 'unknown' ? timeAgo(n.mtime) : '<span class="muted">—</span>'}</td>
        <td class="actions" data-stop>
          ${canOp ? `<button class="btn sm ghost icon" data-act="fetch" title="${esc(t('Back up now'))}">${icon('refresh')}</button>
          <button class="btn sm ghost icon" data-act="debug" title="${esc(t('Debug'))}">${icon('bug')}</button>` : ''}
          ${data.editable && !n.readonly && canOp ? `<button class="btn sm ghost icon" data-act="edit" title="${esc(t('Edit'))}">${icon('edit')}</button>` : ''}
          <button class="btn sm ghost icon" data-act="more" title="${esc(t('More'))}">${icon('more')}</button>
        </td></tr>`;
      }).join('')}</tbody></table>`;

    $('#dv-foot', view).innerHTML = `<span>${page * size + 1}–${Math.min((page + 1) * size, rows.length)} / ${rows.length}</span>
      <div style="flex:1"></div>
      <select class="select" id="dv-ps" style="width:auto;height:30px">${[25, 50, 100, 0].map((s) => `<option value="${s}" ${prefs.pageSize === s ? 'selected' : ''}>${s ? esc(t('{n} / page', { n: s })) : esc(t('All'))}</option>`).join('')}</select>
      <button class="btn sm" id="dv-prev" ${page === 0 ? 'disabled' : ''}>‹</button><span>${page + 1} / ${pages}</span>
      <button class="btn sm" id="dv-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>`;
    $('#dv-ps', view).onchange = (e) => { prefs.pageSize = +e.target.value; page = 0; savePrefs(prefs); draw(); };
    $('#dv-prev', view).onclick = () => { page--; draw(); };
    $('#dv-next', view).onclick = () => { page++; draw(); };

    $('#dv-all', tbl)?.addEventListener('change', (e) => { slice.forEach((n) => (e.target.checked ? selected.add(n.name) : selected.delete(n.name))); draw(); });
    $$('[data-sort]', tbl).forEach((el) => {
      el.onclick = () => {
        if (prefs.sort === el.dataset.sort) prefs.dir *= -1; else { prefs.sort = el.dataset.sort; prefs.dir = 1; }
        savePrefs(prefs); draw();
      };
    });
    $$('tbody tr', tbl).forEach((tr) => {
      const name = tr.dataset.name;
      const node = data.nodes.find((n) => n.name === name);
      tr.onclick = (e) => { if (!e.target.closest('[data-stop]')) navigate(`#/devices/${encodeURIComponent(name)}`); };
      tr.querySelector('[data-sel]')?.addEventListener('change', (e) => { if (e.target.checked) selected.add(name); else selected.delete(name); draw(); });
      tr.querySelector('[data-act=fetch]')?.addEventListener('click', async (e) => {
        const b = e.currentTarget;
        setBusy(b, true);
        try { await api.fetchNow(name); toast(t('{name} moved to the front of the backup queue', { name }), 'success'); } catch (err) { toastError(err); }
        setBusy(b, false);
      });
      tr.querySelector('[data-act=debug]')?.addEventListener('click', () => navigate(`#/devices/${encodeURIComponent(name)}/debug`));
      tr.querySelector('[data-act=edit]')?.addEventListener('click', () => openDeviceForm(node, { onSaved: load }));
      tr.querySelector('[data-act=more]').onclick = (e) => dropdown(e.currentTarget, [
        { label: t('View configuration'), icon: 'fileCode', onClick: () => navigate(`#/devices/${encodeURIComponent(name)}/config`) },
        { label: t('Versions & diff'), icon: 'git', onClick: () => navigate(`#/devices/${encodeURIComponent(name)}/versions`) },
        ...(canOp ? [{ label: t('Connection test / debug'), icon: 'terminal', onClick: () => navigate(`#/devices/${encodeURIComponent(name)}/debug`) }] : []),
        ...(data.editable && !node.readonly && canOp ? [
          { label: t('Duplicate (new device)'), icon: 'copy', onClick: () => openDeviceForm(null, { onSaved: load }).then(() => prefill(node)) },
          '-',
          { label: t('Delete'), icon: 'trash', danger: true, onClick: () => removeNode(name) },
        ] : []),
      ]);
    });
  };

  // Duplicate: open the form as a new device and prefill the fields
  const prefill = (node) => {
    setTimeout(() => {
      ['ip', 'model', 'group', 'input', 'username', 'ssh_port', 'telnet_port'].forEach((k) => {
        const el = document.getElementById(`df-${k}`);
        if (el && node[k]) { el.value = node[k]; el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      const n = document.getElementById('df-name');
      if (n) { n.value = `${node.name}-copy`; n.select(); }
    }, 50);
  };

  const removeNode = async (name) => {
    if (!await confirmDialog({ title: t('Delete {name}?', { name }), message: esc(t('The device is removed from router.db and Oxidized is reloaded. Backups in the git history are kept.')), confirm: t('Delete'), danger: true })) return;
    try {
      const r = await api.deleteNode(name);
      selected.delete(name);
      reloadToast(r.reload, t('{name} deleted', { name }));
      load();
    } catch (e) { toastError(e); }
  };

  const addDevice = () => openDeviceForm(null, { onSaved: load });

  $('#dv-add', view)?.addEventListener('click', addDevice);
  $('#dv-refresh', view).onclick = () => load().catch(toastError);
  $('#dv-q', view).oninput = debounce((e) => { prefs.q = e.target.value; page = 0; draw(); }, 150);
  $('#dv-group', view).onchange = (e) => { prefs.group = e.target.value; page = 0; savePrefs(prefs); draw(); };
  $('#dv-model', view).onchange = (e) => { prefs.model = e.target.value; page = 0; savePrefs(prefs); draw(); };
  $('#dv-tools', view).onclick = (e) => dropdown(e.currentTarget, [
    ...(canOp && data.editable ? [{ label: t('Import CSV / paste router.db'), icon: 'upload', onClick: () => importDialog(load) }] : []),
    ...(data.editable ? [{ label: t('Export CSV (without passwords)'), icon: 'download', onClick: () => { location.href = api.exportUrl(false); } }] : []),
    ...(canOp && data.editable ? [{ label: t('Export CSV (with passwords)'), icon: 'download', onClick: async () => { if (await confirmDialog({ title: t('Include passwords?'), message: esc(t('The file will contain passwords in plain text. This is recorded in the audit log.')), confirm: t('Download') })) location.href = api.exportUrl(true); } }] : []),
    ...(can('manager') && data.editable ? ['-', { label: t('Edit router.db directly'), icon: 'fileCode', onClick: () => navigate('#/settings/routerdb') }] : []),
    ...(canOp && data.editable ? [{ label: t('Oxidized reload'), icon: 'refresh', onClick: async () => { try { reloadToast(await api.reload()); } catch (err) { toastError(err); } } }] : []),
  ]);

  const onKey = (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); $('#dv-q', view)?.focus(); }
  };
  document.addEventListener('keydown', onKey);
  const onRefresh = () => load().catch(toastError);
  window.addEventListener('oxmgr:refresh', onRefresh);

  await load();
  if (params.query?.new && data.editable && canOp) addDevice();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) load().catch(() => {}); }, 30000);
  return () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('oxmgr:refresh', onRefresh);
  };
}

function importDialog(onDone) {
  const api = iapi(state.iid);
  const m = modal({
    title: `${icon('upload')} ${esc(t('Import devices'))}`, size: 'lg',
    body: `<div class="stack">
      <div class="muted small">${esc(t('Two formats are supported:'))}<br>
        • ${esc(t('CSV with a header:'))} <code>name,ip,model,group,input,username,password,enable,ssh_port,telnet_port</code><br>
        • ${esc(t('Raw router.db lines (with the delimiter and column order of the current config)'))}</div>
      <div class="row"><input type="file" id="im-file" accept=".csv,.db,.txt"></div>
      <textarea class="input code" id="im-text" rows="12" placeholder="name,ip,model,group&#10;SW01,10.0.0.1,ios,core"></textarea>
      <div class="row"><label class="chk"><input type="radio" name="im-mode" value="add" checked> ${esc(t('Only add new devices'))}</label>
        <label class="chk"><input type="radio" name="im-mode" value="upsert"> ${esc(t('Update existing devices'))}</label></div>
      <div id="im-result"></div></div>`,
    footer: `<button class="btn" data-a="dry">${esc(t('Preview (dry run)'))}</button><button class="btn primary" data-a="go">${esc(t('Import'))}</button>`,
  });
  m.body.querySelector('#im-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) m.body.querySelector('#im-text').value = await f.text();
  };
  const run = async (dry, btn) => {
    const text = m.body.querySelector('#im-text').value;
    if (!text.trim()) { toast(t('Nothing to import'), 'warning'); return; }
    setBusy(btn, true);
    try {
      const r = await api.importNodes({ text, mode: m.body.querySelector('[name=im-mode]:checked').value, dry_run: dry });
      m.body.querySelector('#im-result').innerHTML = `<div class="alert ${r.errors.length ? 'warning' : 'success'}">${icon(r.errors.length ? 'alert' : 'checkCircle')}<div class="alert-body">
        ${dry ? `<b>${esc(t('Preview:'))}</b> ` : ''}${esc(t('{total} rows · {added} to add · {updated} to update · {skipped} skipped', { total: r.total, added: r.added, updated: r.updated, skipped: r.skipped }))}
        ${r.errors.length ? `<ul class="list-plain small">${r.errors.slice(0, 20).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div></div>`;
      if (!dry) { reloadToast(r.reload, t('{added} added, {updated} updated', { added: r.added, updated: r.updated })); onDone(); }
    } catch (e) { toastError(e); }
    setBusy(btn, false);
  };
  m.foot.querySelector('[data-a=dry]').onclick = (e) => run(true, e.currentTarget);
  m.foot.querySelector('[data-a=go]').onclick = (e) => run(false, e.currentTarget);
}

export { STATUS };
