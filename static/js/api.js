// REST / WebSocket client
import { getLang } from './i18n.js';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, url, body, opts = {}) {
  const init = { method, headers: { 'X-Lang': getLang() }, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 401 && !opts.noAuthRedirect) {
    window.dispatchEvent(new CustomEvent('oxmgr:unauthorized'));
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    let msg = typeof data === 'string' ? data : data.detail;
    if (Array.isArray(msg)) msg = msg.map((m) => m.msg).join(', ');
    throw new ApiError(msg || `HTTP ${res.status}`, res.status);
  }
  return data;
}

export const api = {
  get: (u, o) => request('GET', u, undefined, o),
  post: (u, b = {}, o) => request('POST', u, b, o),
  put: (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

export const enc = encodeURIComponent;

// Workspace-scoped helpers (/api/w/<id>/...)
export const iapi = (iid) => {
  const base = `/api/w/${enc(iid)}`;
  return {
    base,
    overview: () => api.get(`${base}/overview`),
    nodes: () => api.get(`${base}/nodes`),
    node: (n) => api.get(`${base}/nodes/${enc(n)}`),
    secrets: (n) => api.get(`${base}/nodes/${enc(n)}/secrets`),
    createNode: (b) => api.post(`${base}/nodes`, b),
    updateNode: (n, b) => api.put(`${base}/nodes/${enc(n)}`, b),
    deleteNode: (n) => api.del(`${base}/nodes/${enc(n)}`),
    bulk: (b) => api.post(`${base}/bulk`, b),
    fetchNow: (n) => api.post(`${base}/nodes/${enc(n)}/fetch`),
    config: (n) => api.get(`${base}/nodes/${enc(n)}/config`),
    versions: (n) => api.get(`${base}/nodes/${enc(n)}/versions`),
    version: (n, oid, epoch, num) => api.get(`${base}/nodes/${enc(n)}/version?oid=${enc(oid)}${epoch != null ? `&epoch=${enc(epoch)}` : ''}${num != null ? `&num=${enc(num)}` : ''}`),
    diff: (n, oid, oid2 = 'current') => api.get(`${base}/nodes/${enc(n)}/diff?oid=${enc(oid)}&oid2=${enc(oid2)}`),
    debugFiles: (n) => api.get(`${base}/nodes/${enc(n)}/debug-files`),
    file: (p) => api.get(`${base}/file?path=${enc(p)}`),
    search: (q) => api.get(`${base}/search?q=${enc(q)}`),
    reload: () => api.post(`${base}/reload`),
    clearCrash: () => api.del(`${base}/crash`),
    process: () => api.get(`${base}/process`),
    processAction: (a) => api.post(`${base}/process/${a}`),
    processLogs: (tail) => api.get(`${base}/process/logs?tail=${tail}`),
    cfg: () => api.get(`${base}/config`),
    cfgRaw: () => api.get(`${base}/config/raw`),
    cfgValidate: (text) => api.post(`${base}/config/validate`, { text }),
    cfgPutRaw: (text) => api.put(`${base}/config/raw`, { text }),
    cfgSettings: (values, prompt) => api.patch(`${base}/config/settings`, { values, prompt }),
    modelMap: (m) => api.put(`${base}/config/model-map`, { model_map: m }),
    schemaFix: (codes) => api.post(`${base}/config/schema-fix`, { codes }),
    createGroup: (b) => api.post(`${base}/groups`, b),
    updateGroup: (n, b) => api.put(`${base}/groups/${enc(n)}`, b),
    deleteGroup: (n) => api.del(`${base}/groups/${enc(n)}`),
    groupSecrets: (n) => api.get(`${base}/groups/${enc(n)}/secrets`),
    routerdbRaw: () => api.get(`${base}/routerdb/raw`),
    routerdbPut: (text) => api.put(`${base}/routerdb/raw`, { text }),
    importNodes: (b) => api.post(`${base}/import`, b),
    backups: () => api.get(`${base}/backups`),
    backup: (n) => api.get(`${base}/backups/${enc(n)}`),
    restore: (n) => api.post(`${base}/backups/${enc(n)}/restore`),
    exportUrl: (reveal) => `${base}/export.csv${reveal ? '?reveal=true' : ''}`,
  };
};

// Workspace management helpers (/api/workspaces/<id>/...) — never proxied to remote managers
export const wsapi = (wid) => {
  const base = `/api/workspaces/${enc(wid)}`;
  return {
    members: () => api.get(`${base}/members`),
    setMember: (userId, role) => api.put(`${base}/members`, { user_id: userId, role }),
    destinations: () => api.get(`${base}/destinations`),
    createDest: (b) => api.post(`${base}/destinations`, b),
    updateDest: (id, b) => api.put(`${base}/destinations/${enc(id)}`, b),
    deleteDest: (id) => api.del(`${base}/destinations/${enc(id)}`),
    testDest: (b) => api.post(`${base}/destinations/test`, b),
    runDest: (id) => api.post(`${base}/destinations/${enc(id)}/run`),
    runs: (id) => api.get(`${base}/destinations/${enc(id)}/runs`),
    test: () => api.post(`${base}/test`),
  };
};

// WebSocket stream: onItems(items[]) / onEnd()
export function openStream(path, { onItems, onEnd, onOpen, initial } = {}) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}${path}`);
  let ended = false;
  const finish = () => { if (!ended) { ended = true; onEnd && onEnd(); } };
  ws.onopen = () => {
    if (initial !== undefined) ws.send(JSON.stringify(initial));
    onOpen && onOpen();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.items) onItems && onItems(msg.items);
    if (msg.end) finish();
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) window.dispatchEvent(new CustomEvent('oxmgr:unauthorized'));
    finish();
  };
  ws.onerror = () => finish();
  return {
    stop() { try { ws.send('stop'); } catch (e) { /* closed */ } },
    close() { try { ws.close(); } catch (e) { /* closed */ } finish(); },
  };
}
