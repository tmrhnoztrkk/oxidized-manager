import { openStream } from '../api.js';
import { t, tn } from '../i18n.js';
import { can, canControl, current, restartOxidized, state } from '../app.js';
import { $, debounce, download, esc, icon, terminal } from '../ui.js';

export async function render(view) {
  const inst = current();
  const hasLogs = canControl(inst);
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(t('Live logs'))}</h1><div class="sub">${esc(t('Oxidized process and panel events'))} · ${esc(inst.name)}</div></div>
      <div class="actions">${hasLogs && can('manager') ? `<button class="btn" id="lg-restart">${icon('power')} ${esc(t('Restart Oxidized'))}</button>` : ''}</div>
    </div>
    ${hasLogs ? '' : `<div class="alert info">${icon('info')}<div class="alert-body">${esc(t('This workspace is a plain Oxidized REST API; live logs are only available for Oxidized Manager workspaces.'))}</div></div>`}
    <div class="card" ${hasLogs ? '' : 'style="display:none"'}>
      <div class="toolbar">
        <span class="live-dot" id="lg-dot"></span><span id="lg-state" class="small">${esc(t('Not connected'))}</span>
        <div class="input-wrap">${icon('filter')}<input class="input" id="lg-filter" placeholder="${esc(t('Filter (several with |: CORE-SW01|10.0.0.1|ERROR)'))}"></div>
        <select class="select" id="lg-tail" style="width:auto">${[100, 300, 1000, 5000].map((n) => `<option value="${n}" ${n === 300 ? 'selected' : ''}>${esc(t('Last {n} lines', { n }))}</option>`).join('')}</select>
        <div style="flex:1"></div>
        <span class="small muted" id="lg-count"></span>
        <button class="btn sm" id="lg-pause">${icon('pause')} ${esc(t('Pause'))}</button>
        <button class="btn sm" id="lg-clear">${icon('trash')} ${esc(t('Clear'))}</button>
        <button class="btn sm" id="lg-dl">${icon('download')} ${esc(t('Download'))}</button>
        <button class="btn sm primary" id="lg-conn">${icon('play')} ${esc(t('Connect'))}</button>
      </div>
      <div class="card-body"><div class="terminal tall" id="lg-term"></div></div>
    </div>`;
  if (!hasLogs) return null;
  const term = terminal($('#lg-term', view));
  let stream = null;
  let paused = false;
  const setState = (on, txt) => {
    $('#lg-dot', view).classList.toggle('on', on);
    $('#lg-state', view).textContent = txt;
    $('#lg-conn', view).innerHTML = on ? `${icon('stop')} ${esc(t('Disconnect'))}` : `${icon('play')} ${esc(t('Connect'))}`;
  };
  const connect = () => {
    if (stream) { stream.close(); stream = null; setState(false, t('Disconnected')); return; }
    term.clear();
    setState(true, t('Connecting…'));
    stream = openStream(`/api/w/${state.iid}/ws/logs?tail=${$('#lg-tail', view).value}`, {
      onOpen: () => setState(true, t('Live')),
      onItems: (items) => { term.add(items); $('#lg-count', view).textContent = tn('{n} line', '{n} lines', term.count); },
      onEnd: () => { stream = null; setState(false, t('Stream ended')); },
    });
  };
  $('#lg-conn', view).onclick = connect;
  $('#lg-filter', view).oninput = debounce((e) => term.setFilter(e.target.value), 200);
  $('#lg-pause', view).onclick = (e) => {
    paused = !paused;
    term.setPaused(paused);
    e.currentTarget.innerHTML = paused ? `${icon('play')} ${esc(t('Resume'))}` : `${icon('pause')} ${esc(t('Pause'))}`;
  };
  $('#lg-clear', view).onclick = () => term.clear();
  $('#lg-dl', view).onclick = () => download(`oxidized-${Date.now()}.log`, term.text());
  $('#lg-tail', view).onchange = () => { if (stream) { stream.close(); stream = null; } connect(); };
  $('#lg-restart', view)?.addEventListener('click', async () => {
    await restartOxidized();
    setTimeout(() => { if (stream) { stream.close(); stream = null; } connect(); }, 3000);
  });
  connect();
  return () => stream && stream.close();
}
