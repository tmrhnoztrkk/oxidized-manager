import { iapi } from '../api.js';
import { t, tn } from '../i18n.js';
import { state } from '../app.js';
import { $, $$, codeView, empty, esc, icon, loader } from '../ui.js';

export async function render(view) {
  const api = iapi(state.iid);
  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(t('Config search'))}</h1><div class="sub">${esc(t('Search the latest backed-up configuration of every device (Oxidized conf_search — regular expressions allowed)'))}</div></div></div>
    <div class="card" style="margin-bottom:16px"><form class="toolbar" id="s-form">
      <div class="input-wrap" style="max-width:none">${icon('search')}<input class="input" id="s-q" placeholder="${esc(t('e.g. snmp-server community, ip route 0.0.0.0, set admintimeout'))}" autofocus></div>
      <button class="btn primary" type="submit">${esc(t('Search'))}</button></form></div>
    <div class="split-pane"><div class="card" id="s-results"><div class="empty">${icon('search')}<h3>${esc(t('Start a search'))}</h3><div>${esc(t('Results are listed here.'))}</div></div></div>
      <div class="card" id="s-preview" style="min-height:200px"><div class="empty">${icon('fileCode')}<div>${esc(t('Select a device on the left to preview'))}</div></div></div></div>`;
  let q = '';
  $('#s-form', view).onsubmit = async (e) => {
    e.preventDefault();
    q = $('#s-q', view).value.trim();
    if (q.length < 2) return;
    const box = $('#s-results', view);
    box.innerHTML = loader(t('Searching…'));
    try {
      const res = await api.search(q);
      if (!res.length) { box.innerHTML = empty('search', t('No results'), esc(t('"{q}" was not found in any config.', { q }))); return; }
      box.innerHTML = `<div class="card-head"><h3>${esc(tn('{n} device', '{n} devices', res.length))}</h3></div><div class="version-list">${res.map((r) => `
        <div class="version-item" data-n="${esc(r.node || r.name)}"><div style="flex:1"><b>${esc(r.node || r.name)}</b><div class="small muted">${esc(r.full_name || '')}</div></div>${icon('chevronRight')}</div>`).join('')}</div>`;
      $$('[data-n]', box).forEach((it) => {
        it.onclick = async () => {
          $$('[data-n]', box).forEach((x) => x.classList.toggle('sel-b', x === it));
          const pv = $('#s-preview', view);
          pv.innerHTML = loader();
          try {
            const txt = await api.config(it.dataset.n);
            pv.innerHTML = `<div class="card-head"><h3>${esc(it.dataset.n)}</h3><div class="actions"><a class="btn sm" href="#/devices/${encodeURIComponent(it.dataset.n)}">${esc(t('Go to device'))} ${icon('chevronRight')}</a></div></div><div class="card-body">${codeView(txt, { needle: q })}</div>`;
            pv.querySelector('tr.hl')?.scrollIntoView({ block: 'center' });
          } catch (err) { pv.innerHTML = `<div class="card-body muted">${esc(err.message)}</div>`; }
        };
      });
    } catch (err) {
      box.innerHTML = `<div class="card-body"><div class="alert danger">${icon('alert')}<div class="alert-body">${esc(err.message)}</div></div></div>`;
    }
  };
  return null;
}
