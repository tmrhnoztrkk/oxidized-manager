// Audit log (administrators: everything; workspace managers: their workspaces)
import { api } from '../api.js';
import { N_, t } from '../i18n.js';
import { isAdmin, state } from '../app.js';
import { $, debounce, empty, esc, fmtDate, icon, timeAgo } from '../ui.js';

const LABELS = {
  login: N_('Sign-in'), setup: N_('Initial setup'),
  'node:create': N_('Device added'), 'node:update': N_('Device updated'), 'node:delete': N_('Device deleted'),
  'node:fetch': N_('Backup triggered'), 'node:test': N_('Connection test'), 'node:reveal': N_('Device password revealed'),
  'group:create': N_('Group added'), 'group:update': N_('Group updated'), 'group:delete': N_('Group deleted'), 'group:reveal': N_('Group password revealed'),
  'write:config': N_('Config written'), 'write:routerdb': N_('router.db written'),
  'process:restart': N_('Oxidized restarted'), 'process:start': N_('Oxidized started'), 'process:stop': N_('Oxidized stopped'),
  'workspace:create': N_('Workspace created'), 'workspace:update': N_('Workspace updated'), 'workspace:delete': N_('Workspace deleted'),
  'member:set': N_('Workspace access changed'),
  'token:create': N_('API key created'), 'token:delete': N_('API key revoked'),
  'user:create': N_('User added'), 'user:update': N_('User updated'), 'user:delete': N_('User deleted'),
  'user:password': N_('Password changed'), 'user:password-reset': N_('Password reset'),
  'destination:create': N_('Backup destination added'), 'destination:update': N_('Backup destination updated'),
  'destination:delete': N_('Backup destination deleted'), 'destination:run': N_('Backup push started'),
  'bulk:fetch': N_('Bulk backup'), 'bulk:set': N_('Bulk edit'), 'bulk:delete': N_('Bulk delete'),
  'crash:clear': N_('Crash file cleared'), reload: N_('Oxidized reload'), import: N_('Import'), 'export:reveal': N_('Export with passwords'),
};

export async function render(view) {
  const items = await api.get('/api/audit');
  const names = Object.fromEntries(state.workspaces.map((i) => [i.id, i.name]));
  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(t('Audit log'))}</h1><div class="sub">${esc(isAdmin() ? t('Every change made through the panel (latest 500)') : t('Changes in the workspaces you manage (latest 500)'))}</div></div></div>
    <div class="card"><div class="toolbar"><div class="input-wrap">${icon('search')}<input class="input" id="au-q" placeholder="${esc(t('Filter by user, action, workspace or target…'))}"></div></div>
    <div id="au-body"></div></div>`;
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    const rows = items.filter((a) => !ql || [a.user, a.action, t(LABELS[a.action] || a.action), names[a.workspace], a.workspace, a.target].join(' ').toLowerCase().includes(ql));
    $('#au-body', view).innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${esc(t('Time'))}</th><th>${esc(t('User'))}</th><th>${esc(t('Action'))}</th><th>${esc(t('Workspace'))}</th><th>${esc(t('Target'))}</th><th>${esc(t('Details'))}</th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td class="nowrap small" title="${esc(fmtDate(a.ts))}">${timeAgo(a.ts)}</td><td>${esc(a.user)}</td>
        <td><span class="badge ${/delete|reveal|revoke/.test(a.action) ? 'warning' : /create/.test(a.action) ? 'success' : 'outline'}">${esc(t(LABELS[a.action] || a.action))}</span></td>
        <td class="small">${esc(names[a.workspace] || a.workspace || '')}</td><td class="mono small">${esc(a.target || '')}</td>
        <td class="mono small muted">${a.detail ? esc(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail)) : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty('history', t('No entries'));
  };
  $('#au-q', view).oninput = debounce((e) => draw(e.target.value.trim()), 150);
  draw();
  return null;
}
