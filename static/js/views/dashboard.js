import { iapi, wsapi } from '../api.js';
import { t, tn } from '../i18n.js';
import { can, canControl, current, restartOxidized, setCount, state, WS_TYPES } from '../app.js';
import { donut, esc, fmtDate, icon, parseTime, statusBadge, timeAgo, toast, toastError } from '../ui.js';
import { destStatusBadge, PROVIDERS } from './destinations.js';

const COLORS = { success: 'var(--success)', fail: 'var(--danger)', never: 'var(--border-strong)' };

function healthCard(title, ico, hc, okText, detail) {
  if (!hc) {
    return `<div class="card kpi"><div class="label">${icon(ico)}${esc(title)}</div><div class="row"><span class="badge outline">${esc(t('Not applicable'))}</span></div><div class="foot">&nbsp;</div></div>`;
  }
  return `<div class="card kpi"><div class="label">${icon(ico)}${esc(title)}</div>
    <div class="row">${hc.ok ? `<span class="badge success"><span class="dot"></span>${esc(okText)}</span>` : `<span class="badge danger"><span class="dot"></span>${esc(t('Problem'))}</span>`}</div>
    <div class="foot ellipsis" title="${esc(hc.error || detail || '')}">${esc(hc.error || detail || '')}</div></div>`;
}

export async function render(view) {
  const inst = current();
  const api = iapi(state.iid);
  const load = async () => {
    const [o, dests] = await Promise.all([api.overview(), wsapi(state.iid).destinations().catch(() => [])]);
    const nodes = o.nodes;
    setCount('devices', o.source_count ?? nodes.length);
    const by = { success: 0, fail: 0, never: 0 };
    nodes.forEach((n) => {
      const s = n.status || 'never';
      if (s === 'success') by.success++; else if (s === 'never') by.never++; else by.fail++;
    });
    const total = nodes.length;
    const dayAgo = Date.now() - 86400000;
    const changed = nodes.filter((n) => { const d = parseTime(n.mtime); return d && d.getTime() > dayAgo; });
    const failing = nodes.filter((n) => n.status && n.status !== 'success' && n.status !== 'never')
      .sort((a, b) => (parseTime(b.time)?.getTime() || 0) - (parseTime(a.time)?.getTime() || 0));
    const recent = [...nodes].filter((n) => parseTime(n.mtime))
      .sort((a, b) => parseTime(b.mtime) - parseTime(a.mtime)).slice(0, 8);

    const groups = {};
    nodes.forEach((n) => {
      const g = n.group || t('(no group)');
      groups[g] = groups[g] || { total: 0, ok: 0, fail: 0 };
      groups[g].total++;
      if (n.status === 'success') groups[g].ok++;
      else if (n.status && n.status !== 'never') groups[g].fail++;
    });
    const models = {};
    nodes.forEach((n) => { const m = n.model || '?'; models[m] = (models[m] || 0) + 1; });

    const hc = o.health;
    const issues = (o.config?.source?.issues || []).filter((i) => i.level !== 'info');
    const lastRun = nodes.map((n) => parseTime(n.time)).filter(Boolean).sort((a, b) => b - a)[0];
    const pct = total ? Math.round((by.success / total) * 100) : 0;
    const destErr = dests.filter((d) => d.last_status === 'error').length;

    view.innerHTML = `
      <div class="page-head">
        <div><h1>${esc(t('Overview'))}</h1><div class="sub">${esc(inst.name)} · ${esc(t(WS_TYPES[inst.type]?.long || ''))}${inst.config?.url ? ` · ${esc(inst.config.url)}` : ''}</div></div>
        <div class="actions">
          <button class="btn" id="d-refresh">${icon('refresh')} ${esc(t('Refresh'))}</button>
          ${canControl(inst) && can('manager') ? `<button class="btn" id="d-restart">${icon('power')} ${esc(t('Restart Oxidized'))}</button>` : ''}
          ${inst.type !== 'oxidized' && can('operator') ? `<a class="btn primary" href="#/devices?new=1" id="d-add">${icon('plus')} ${esc(t('Add device'))}</a>` : ''}
        </div>
      </div>
      ${o.crash ? `<div class="alert danger" style="margin-bottom:16px">${icon('alert')}<div class="alert-body"><div class="row between"><b>${esc(t('Oxidized crash file found'))}</b>${can('manager') ? `<button class="btn sm" id="d-crash-clear">${icon('check')} ${esc(t('Reviewed, clear it'))}</button>` : ''}</div><pre class="mono" style="white-space:pre-wrap;max-height:180px;overflow:auto;margin:8px 0 0">${esc(o.crash)}</pre></div></div>` : ''}
      ${hc.api && !hc.api.ok ? `<div class="alert danger" style="margin-bottom:16px">${icon('alert')}<div class="alert-body"><b>${esc(t('The Oxidized API is not reachable.'))}</b> ${esc(hc.api.error)}<br><span class="small muted">${t('Oxidized may not be running (it does not start while the device list is empty). See <a href="#/logs">Live logs</a> for details.')}</span></div></div>` : ''}
      ${issues.length ? `<div class="alert warning" style="margin-bottom:16px">${icon('alert')}<div class="alert-body"><b>${esc(tn('router.db schema has {n} issue.', 'router.db schema has {n} issues.', issues.length))}</b> ${esc(issues[0].message)} ${can('manager') ? `<a href="#/settings/schema">${esc(t('Fix the schema →'))}</a>` : ''}</div></div>` : ''}
      ${destErr ? `<div class="alert warning" style="margin-bottom:16px">${icon('cloudUp')}<div class="alert-body"><b>${esc(tn('{n} backup destination failed on its last run.', '{n} backup destinations failed on their last run.', destErr))}</b> <a href="#/destinations">${esc(t('Show details →'))}</a></div></div>` : ''}
      <div class="grid c4" style="margin-bottom:16px">
        ${healthCard(t('Oxidized API'), 'activity', hc.api, hc.api?.ok ? t('Online · {ms} ms', { ms: hc.api.ms }) : '', '')}
        ${healthCard(t('Data directory'), 'database', hc.files, t('Ready'), hc.files?.path)}
        ${healthCard(t('Oxidized process'), 'box', hc.process, hc.process?.state === 'running' ? t('Running') : '', hc.process ? (hc.process.message || t('started {ago} · restarts: {n}', { ago: timeAgo(hc.process.started_at), n: hc.process.restarts ?? 0 })) : '')}
        <div class="card kpi"><div class="label">${icon('clock')}${esc(t('Last backup attempt'))}</div><div class="value" style="font-size:20px">${lastRun ? timeAgo(lastRun) : '—'}</div><div class="foot">${lastRun ? fmtDate(lastRun) : esc(t('No runs yet'))}</div></div>
      </div>
      <div class="grid c4" style="margin-bottom:16px">
        <div class="card kpi"><div class="label"><span class="kpi-icon" style="background:var(--primary-soft);color:var(--primary)">${icon('server')}</span>${esc(t('Devices'))}</div><div class="value">${o.source_count ?? total}</div><div class="foot">${o.source_count != null && o.source_count !== total ? esc(t('Loaded in Oxidized: {n}', { n: total })) : esc(t('in sync with router.db'))}</div></div>
        <div class="card kpi"><div class="label"><span class="kpi-icon" style="background:var(--success-soft);color:var(--success)">${icon('checkCircle')}</span>${esc(t('Successful'))}</div><div class="value" style="color:var(--success)">${by.success}</div><div class="foot">${esc(t('{pct}% success rate', { pct }))}</div></div>
        <div class="card kpi"><div class="label"><span class="kpi-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('xCircle')}</span>${esc(t('Failing'))}</div><div class="value" style="color:var(--danger)">${by.fail}</div><div class="foot">${esc(tn('{n} device never backed up', '{n} devices never backed up', by.never))}</div></div>
        <div class="card kpi"><div class="label"><span class="kpi-icon" style="background:var(--info-soft);color:var(--info)">${icon('git')}</span>${esc(t('Changed in 24 h'))}</div><div class="value">${changed.length}</div><div class="foot">${esc(t('config changes'))}</div></div>
      </div>
      <div class="grid c3" style="margin-bottom:16px">
        <div class="card"><div class="card-head"><h3>${esc(t('Status'))}</h3></div><div class="card-body row" style="gap:24px;justify-content:center">
          ${donut([{ label: t('Successful'), value: by.success, color: COLORS.success }, { label: t('Failing'), value: by.fail, color: COLORS.fail }, { label: t('Never backed up'), value: by.never, color: COLORS.never }], { center: `<div><b>${pct}%</b><span class="small muted">${esc(t('successful'))}</span></div>` })}
          <div class="stack small">
            <div><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COLORS.success};margin-right:8px"></i>${esc(t('Successful'))} <b>${by.success}</b></div>
            <div><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COLORS.fail};margin-right:8px"></i>${esc(t('Failing'))} <b>${by.fail}</b></div>
            <div><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COLORS.never};margin-right:8px"></i>${esc(t('Never backed up'))} <b>${by.never}</b></div>
          </div></div></div>
        <div class="card"><div class="card-head"><h3>${esc(t('Groups'))}</h3>${can('manager') && inst.type !== 'oxidized' ? `<div class="actions"><a class="btn ghost sm" href="#/groups">${esc(t('All'))} ${icon('chevronRight')}</a></div>` : ''}</div><div class="card-body">
          ${Object.entries(groups).sort((a, b) => b[1].total - a[1].total).slice(0, 8).map(([g, v]) => `
            <div class="hbar-row"><a class="ellipsis" href="#/devices" data-group="${esc(g)}">${esc(g)}</a>
              <div class="bar"><span style="width:${(v.ok / v.total) * 100}%;background:var(--success)"></span><span style="width:${(v.fail / v.total) * 100}%;background:var(--danger)"></span></div>
              <span class="small muted" style="text-align:right">${v.ok}/${v.total}</span></div>`).join('') || `<div class="muted">${esc(t('No data'))}</div>`}
        </div></div>
        <div class="card"><div class="card-head"><h3>${icon('cloudUp')} ${esc(t('Backup destinations'))}</h3><div class="actions"><a class="btn ghost sm" href="#/destinations">${esc(t('All'))} ${icon('chevronRight')}</a></div></div><div class="card-body">
          ${dests.length ? dests.slice(0, 6).map((d) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)">
              <span class="row ellipsis" style="gap:6px">${icon(PROVIDERS[d.type]?.icon || 'git')}<b class="ellipsis">${esc(d.name)}</b></span>
              <span class="row" style="gap:6px">${destStatusBadge(d)}<span class="small muted">${d.last_run ? timeAgo(d.last_run) : ''}</span></span></div>`).join('')
            : `<div class="muted small">${esc(t('Configs are only stored inside Oxidized. Add a destination to also push them to GitHub, GitLab or another git server.'))}</div>
               ${can('manager') ? `<a class="btn sm primary" href="#/destinations" style="margin-top:10px">${icon('plus')} ${esc(t('Add destination'))}</a>` : ''}`}
        </div></div>
      </div>
      <div class="grid c2">
        <div class="card"><div class="card-head"><h3>${icon('alert')} ${esc(t('Failing devices'))}</h3><div class="actions">${failing.length && can('operator') ? `<button class="btn sm" id="d-retry">${icon('refresh')} ${esc(t('Retry all'))}</button>` : ''}</div></div>
          <div class="card-body flush table-wrap" style="max-height:420px">
            ${failing.length ? `<table class="table"><thead><tr><th>${esc(t('Device'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Last attempt'))}</th><th></th></tr></thead><tbody>
              ${failing.slice(0, 50).map((n) => `<tr><td><a class="name-cell" href="#/devices/${encodeURIComponent(n.name)}">${esc(n.name)}</a><div class="sub-cell">${esc(n.ip)} · ${esc(n.group || '')}</div></td>
                <td>${statusBadge(n.status)}</td><td class="nowrap" title="${esc(fmtDate(n.time))}">${timeAgo(n.time)}</td>
                <td class="actions"><a class="btn sm" href="#/devices/${encodeURIComponent(n.name)}/debug">${icon('bug')} ${esc(t('Debug'))}</a></td></tr>`).join('')}
              </tbody></table>` : `<div class="empty">${icon('checkCircle')}<h3>${esc(t('No failing devices'))}</h3><div>${esc(t('All devices are being backed up successfully.'))}</div></div>`}
          </div></div>
        <div class="card"><div class="card-head"><h3>${icon('git')} ${esc(t('Recent config changes'))}</h3></div>
          <div class="card-body flush table-wrap" style="max-height:420px">
            ${recent.length ? `<table class="table"><thead><tr><th>${esc(t('Device'))}</th><th>${esc(t('Model'))}</th><th>${esc(t('Changed'))}</th><th></th></tr></thead><tbody>
              ${recent.map((n) => `<tr><td><a class="name-cell" href="#/devices/${encodeURIComponent(n.name)}">${esc(n.name)}</a><div class="sub-cell">${esc(n.group || '')}</div></td>
                <td><span class="badge mono outline">${esc(n.model)}</span></td><td class="nowrap" title="${esc(fmtDate(n.mtime))}">${timeAgo(n.mtime)}</td>
                <td class="actions"><a class="btn sm" href="#/devices/${encodeURIComponent(n.name)}/versions">${icon('columns')} ${esc(t('Diff'))}</a></td></tr>`).join('')}
              </tbody></table>` : `<div class="empty">${icon('git')}<h3>${esc(t('No changes recorded'))}</h3></div>`}
          </div></div>
      </div>`;

    view.querySelector('#d-crash-clear')?.addEventListener('click', async () => {
      try { await api.clearCrash(); load(); } catch (e) { toastError(e); }
    });
    view.querySelector('#d-refresh').onclick = () => load().catch(toastError);
    view.querySelector('#d-restart')?.addEventListener('click', restartOxidized);
    view.querySelector('#d-retry')?.addEventListener('click', async () => {
      try {
        const r = await api.bulk({ action: 'fetch', names: failing.map((n) => n.name) });
        toast(tn('{n} device moved to the front of the backup queue', '{n} devices moved to the front of the backup queue', r.ok), 'success');
      } catch (e) { toastError(e); }
    });
    view.querySelectorAll('[data-group]').forEach((a) => {
      a.onclick = () => { try { sessionStorage.setItem('oxmgr-devfilter', JSON.stringify({ group: a.dataset.group })); } catch (e) { /* storage blocked */ } };
    });
  };
  await load();
  const onRefresh = () => load().catch(toastError);
  window.addEventListener('oxmgr:refresh', onRefresh);
  const timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30000);
  return () => { clearInterval(timer); window.removeEventListener('oxmgr:refresh', onRefresh); };
}
