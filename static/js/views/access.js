// Administration › Remote access: API keys that let another Oxidized Manager manage this one
import { api } from '../api.js';
import { t } from '../i18n.js';
import { state } from '../app.js';
import { $, $$, confirmDialog, copyText, empty, esc, fmtDate, icon, modal, setBusy, timeAgo, toastError } from '../ui.js';

export async function render(view) {
  const load = async () => {
    const tokens = await api.get('/api/tokens');
    const hasLocal = state.workspaces.some((w) => w.type === 'local');
    view.innerHTML = `
      <div class="page-head"><div><h1>${esc(t('Remote access (API keys)'))}</h1>
        <div class="sub">${esc(t('Another Oxidized Manager can manage the embedded Oxidized of this installation with an API key.'))}</div></div>
        <div class="actions"><button class="btn primary" id="tk-add" ${hasLocal ? '' : 'disabled'}>${icon('plus')} ${esc(t('Create key'))}</button></div></div>
      <div class="alert info" style="margin-bottom:16px">${icon('info')}<div class="alert-body">
        ${t('On the managing installation choose <b>Workspaces → Add remote workspace</b> and enter this address (<code>{origin}</code>) and the key.', { origin: esc(location.origin) })}
        ${esc(t('Keys can only access this installation\'s embedded workspace; they cannot manage users or keys. Publish the panel behind HTTPS when connecting over the internet.'))}
        ${hasLocal ? '' : `<br><b>${esc(t('This installation has no embedded Oxidized, so there is nothing to share yet.'))}</b>`}</div></div>
      <div class="card">
        ${tokens.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${esc(t('Name'))}</th><th>${esc(t('Key'))}</th><th>${esc(t('Scope'))}</th><th>${esc(t('Created by'))}</th><th>${esc(t('Last used'))}</th><th></th></tr></thead><tbody>
          ${tokens.map((k) => `<tr><td><b>${esc(k.name)}</b><div class="sub-cell">${fmtDate(k.created_at)}</div></td>
            <td class="mono small">${esc(k.prefix)}…</td>
            <td>${k.scope === 'read' ? `<span class="badge info">${esc(t('read-only'))}</span>` : `<span class="badge primary">${esc(t('full'))}</span>`}</td>
            <td class="small">${esc(k.created_by || '')}</td>
            <td class="small">${k.last_used ? `${timeAgo(k.last_used)} <span class="muted">${esc(k.last_ip || '')}</span>` : `<span class="muted">${esc(t('never'))}</span>`}</td>
            <td class="actions"><button class="btn sm danger" data-rm-token="${k.id}" data-name="${esc(k.name)}">${icon('trash')} ${esc(t('Revoke'))}</button></td></tr>`).join('')}
          </tbody></table></div>` : empty('key', t('No keys'), esc(t('Create a key so that another panel can manage this installation.')))}
      </div>`;

    $('#tk-add', view).onclick = () => {
      const m = modal({ title: `${icon('key')} ${esc(t('Create API key'))}`, size: 'sm',
        body: `<div class="stack"><div class="field"><label>${esc(t('Name'))}</label><input class="input" id="tk-name" placeholder="hq-panel"></div>
          <div class="field"><label>${esc(t('Scope'))}</label><select class="select" id="tk-scope"><option value="full">${esc(t('Full management'))}</option><option value="read">${esc(t('Read-only (monitoring)'))}</option></select></div></div>`,
        footer: `<button class="btn" data-a="no">${esc(t('Cancel'))}</button><button class="btn primary" data-a="yes">${esc(t('Create'))}</button>` });
      m.foot.querySelector('[data-a=no]').onclick = m.close;
      m.foot.querySelector('[data-a=yes]').onclick = async (e) => {
        setBusy(e.currentTarget, true);
        try {
          const r = await api.post('/api/tokens', { name: $('#tk-name', m.body).value.trim(), scope: $('#tk-scope', m.body).value });
          m.close();
          const s = modal({ title: `${icon('checkCircle')} ${esc(t('Key created'))}`, size: 'sm', footer: null,
            body: `<div class="stack"><div class="alert warning small">${icon('alert')}<div class="alert-body">${esc(t('This key is shown only once. Copy it into the managing panel now.'))}</div></div>
              <div class="codeview" style="padding:12px;white-space:normal;word-break:break-all">${esc(r.token)}</div>
              <div class="row"><button class="btn primary" data-copy>${icon('copy')} ${esc(t('Copy'))}</button></div>
              <div class="small muted">${esc(t('Address'))}: <code>${esc(location.origin)}</code></div></div>` });
          s.body.querySelector('[data-copy]').onclick = () => copyText(r.token);
          load();
        } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
      };
    };
    $$('[data-rm-token]', view).forEach((b) => {
      b.onclick = async () => {
        if (!await confirmDialog({ title: t("Revoke '{name}'?", { name: b.dataset.name }), message: esc(t('Panels using this key lose access immediately.')), confirm: t('Revoke'), danger: true })) return;
        try { await api.del(`/api/tokens/${b.dataset.rmToken}`); load(); } catch (e) { toastError(e); }
      };
    });
  };
  await load();
  return null;
}
