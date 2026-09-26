"""Workspace-scoped API: /api/w/<wid>/...

Permissions are enforced by perms.AccessMiddleware before these handlers run; remote (agent)
workspaces never reach these handlers because workspace.AgentProxyMiddleware forwards them.
"""
import asyncio
import contextlib
import contextvars
import difflib
import json
import threading
import time

from fastapi import APIRouter, Body, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, Response

from . import db, devicetest, files, oxconfig
from .backup import collect_local, BackupError
from .deps import ctx_of, user_of
from .files import FilesError
from .i18n import _
from .oxapi import OxidizedAPIError, node_group
from .oxconfig import ConfigError
from .routerdb import RouterDB, RouterDBError, SECRET_KEYS, export_csv, parse_import
from .supervisor import local_supervisor

router = APIRouter()


# ====================================================================== health / overview
async def health(ctx):
    res = {"api": None, "files": None, "process": None}
    t0 = time.time()
    try:
        nodes = await ctx.api.nodes()
        res["api"] = {"ok": True, "nodes": len(nodes), "ms": int((time.time() - t0) * 1000)}
    except OxidizedAPIError as exc:
        res["api"] = {"ok": False, "error": str(exc)}
    if ctx.files:
        ok = await asyncio.to_thread(ctx.files.exists, ctx.config_name)
        res["files"] = {"ok": ok, "path": ctx.home, "error": None if ok else _("config file is missing")}
    if ctx.proc:
        st = ctx.proc.status()
        res["process"] = {"ok": st["state"] == "running", **st}
        if st["state"] != "running" and res["api"] and not res["api"]["ok"]:
            res["api"]["error"] = st["message"] or _("Oxidized is not running ({state})", state=st["state"])
    return res


def clean_runtime(n):
    n = dict(n)
    n.pop("vars", None)
    return n


@router.get("/api/w/{wid}/overview")
async def overview(wid: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    h = await health(ctx)
    runtime, stats = [], {}
    if h["api"] and h["api"]["ok"]:
        runtime = await ctx.api.nodes()
        with contextlib.suppress(OxidizedAPIError):
            stats = await ctx.api.stats()
    summary, crash, src_count = None, None, None
    if ctx.files:
        with contextlib.suppress(Exception):
            db_, _r, doc = await ctx.routerdb()
            summary = oxconfig.summary(doc)
            src_count = len(db_.nodes())
        with contextlib.suppress(Exception):
            if await asyncio.to_thread(ctx.files.exists, "crash"):
                crash = (await ctx.read("crash"))[-4000:]
    ws = db.get_workspace(wid, reveal=False)
    return {"health": h, "nodes": [clean_runtime(n) for n in runtime],
            "stats": stats if isinstance(stats, dict) else {}, "source_count": src_count,
            "config": summary, "crash": crash, "workspace": {"id": ws["id"], "name": ws["name"], "type": ws["type"]}}


@router.delete("/api/w/{wid}/crash")
async def clear_crash(wid: str, user=Depends(user_of)):
    """Removes Oxidized's crash file after it has been reviewed."""
    ctx = ctx_of(wid)
    if not ctx.files:
        raise HTTPException(409, _("This workspace is read-only"))
    await asyncio.to_thread(ctx.files.remove, "crash")
    db.audit(user, "crash:clear", wid)
    return {"ok": True}


# ====================================================================== devices
@router.get("/api/w/{wid}/nodes")
async def list_nodes(wid: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    runtime, api_error, src, schema, issues = [], None, None, None, []
    try:
        runtime = await ctx.api.nodes() if ctx.api.configured else []
    except OxidizedAPIError as exc:
        api_error = str(exc)
    if ctx.files:
        rdb, _r, doc = await ctx.routerdb()
        src = rdb.as_list()
        schema = {"map": rdb.schema.map, "vars_map": rdb.schema.vars_map, "columns": list(rdb.schema.columns)}
        issues = rdb.schema.issues()
    by_name = {n.get("name"): n for n in runtime}
    rows = []
    seen = set()
    for s in src or []:
        r = dict(s)
        rt = by_name.get(s.get("name"))
        r["in_source"] = True
        r["in_oxidized"] = rt is not None
        if rt:
            seen.add(rt.get("name"))
            r.update({"status": rt.get("status"), "time": rt.get("time"), "last": rt.get("last"),
                      "mtime": rt.get("mtime"), "full_name": rt.get("full_name"),
                      "runtime_model": rt.get("model"), "runtime_ip": rt.get("ip")})
        rows.append(r)
    for rt in runtime:
        if rt.get("name") in seen:
            continue
        rows.append({"name": rt.get("name"), "ip": rt.get("ip"), "model": rt.get("model"),
                     "group": rt.get("group"), "status": rt.get("status"), "time": rt.get("time"),
                     "last": rt.get("last"), "mtime": rt.get("mtime"), "full_name": rt.get("full_name"),
                     "in_source": src is None, "in_oxidized": True, "readonly": src is None})
    return {"nodes": rows, "api_error": api_error, "editable": ctx.files is not None,
            "schema": schema, "issues": issues}


def _node_values(body, schema_cols, is_update):
    """Converts a request body to router.db values; errors for filled fields that have no column."""
    values = {}
    missing = []
    for key in ("name", "ip", "model", "group", "input", "username", "password", "enable",
                "ssh_port", "telnet_port"):
        if key not in body:
            continue
        val = body.get(key)
        val = None if val is None else str(val).strip()
        if key in SECRET_KEYS:
            if body.get("clear_" + key):
                val = ""
            elif not val:
                if is_update:
                    continue  # empty → keep the current value
        if key not in schema_cols:
            if val:
                missing.append(key)
            continue
        values[key] = val
    if missing:
        raise HTTPException(400, _("router.db has no column for: {cols}. Add columns under Settings › Schema.",
                                   cols=", ".join(missing)))
    return values


def _resolve(doc, entry_d):
    """Effective settings with Oxidized's precedence node > group > global (and where each came from)."""
    group = entry_d.get("group")
    g = ((doc.get("groups") or {}).get(group) or {}) if group else {}
    gvars = g.get("vars") or {}
    gvars_global = doc.get("vars") or {}
    model = entry_d.get("model") or g.get("model") or doc.get("model")
    mm = doc.get("model_map") or {}
    model = str(mm.get(model, model)) if model else None
    gm = ((g.get("models") or {}).get((model or "").lower()) or {})

    def pick(key, var=False):
        if entry_d.get(key) not in (None, ""):
            return entry_d.get(key), "device"
        if not var:
            if gm.get(key) not in (None, ""):
                return gm.get(key), f"group '{group}' model '{model}'"
            if g.get(key) not in (None, ""):
                return g.get(key), f"group '{group}'"
            if doc.get(key) not in (None, ""):
                return doc.get(key), "global"
        else:
            gmv = gm.get("vars") or {}
            if gmv.get(key) not in (None, ""):
                return gmv.get(key), f"group '{group}' model '{model}'"
            if gvars.get(key) not in (None, ""):
                return gvars.get(key), f"group '{group}' vars"
            if gvars_global.get(key) not in (None, ""):
                return gvars_global.get(key), "global vars"
        return None, "undefined"

    username, u_src = pick("username")
    password, p_src = pick("password")
    enable, e_src = pick("enable", var=True)
    ssh_port, sp_src = pick("ssh_port", var=True)
    telnet_port, tp_src = pick("telnet_port", var=True)
    inp = entry_d.get("input") or g.get("input") or (doc.get("input") or {}).get("default") or "ssh"
    auth_methods = gvars.get("auth_methods") or gvars_global.get("auth_methods")
    prompt = g.get("prompt") or doc.get("prompt")
    return {
        "model": model, "username": username, "username_from": u_src,
        "password": password, "password_from": p_src, "enable": enable, "enable_from": e_src,
        "ssh_port": int(ssh_port or 22), "ssh_port_from": sp_src if ssh_port else "default",
        "telnet_port": int(telnet_port or 23), "telnet_port_from": tp_src if telnet_port else "default",
        "input": str(inp), "auth_methods": list(auth_methods) if auth_methods else None,
        "prompt": str(getattr(prompt, "value", prompt) or devicetest.DEFAULT_PROMPT),
        "timeout": int(g.get("timeout") or doc.get("timeout") or 20),
    }


def _public_resolved(r):
    out = dict(r)
    for k in ("password", "enable"):
        out["has_" + k] = bool(out.pop(k))
    return out


@router.get("/api/w/{wid}/nodes/{name}")
async def node_detail(wid: str, name: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    src, resolved, runtime, stats = None, None, None, None
    if ctx.files:
        rdb, _r, doc = await ctx.routerdb()
        e = rdb.find(name)
        if e:
            src = rdb.to_dict(e)
            resolved = _public_resolved(_resolve(doc, rdb.to_dict(e, reveal=True)))
    if ctx.api.configured:
        with contextlib.suppress(OxidizedAPIError):
            runtime = clean_runtime(await ctx.api.node_show(name))
        with contextlib.suppress(OxidizedAPIError):
            all_stats = await ctx.api.stats()
            stats = (all_stats or {}).get(name) if isinstance(all_stats, dict) else None
    if src is None and runtime is None:
        raise HTTPException(404, _("'{name}' not found", name=name))
    return {"source": src, "resolved": resolved, "runtime": runtime, "stats": stats}


@router.get("/api/w/{wid}/nodes/{name}/secrets")
async def node_secrets(wid: str, name: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    rdb, _r, doc = await ctx.routerdb()
    e = rdb.find(name)
    if not e:
        raise HTTPException(404, _("Device not found"))
    d = rdb.to_dict(e, reveal=True)
    r = _resolve(doc, d)
    db.audit(user, "node:reveal", wid, name)
    return {"password": d.get("password"), "enable": d.get("enable"),
            "effective_password": r["password"], "effective_enable": r["enable"]}


@router.post("/api/w/{wid}/nodes")
async def create_node(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    rdb, rel, _d = await ctx.routerdb()
    values = _node_values(body, rdb.schema.columns, False)
    rdb.add(values)
    reload = await ctx.save_routerdb(rdb, rel, user)
    db.audit(user, "node:create", wid, values.get("name"))
    if body.get("fetch_now") and reload.get("ok"):
        with contextlib.suppress(OxidizedAPIError):
            await ctx.api.next(values["name"], values.get("group"))
    return {"ok": True, "reload": reload}


@router.put("/api/w/{wid}/nodes/{name}")
async def update_node(wid: str, name: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    rdb, rel, _d = await ctx.routerdb()
    values = _node_values(body, rdb.schema.columns, True)
    rdb.update(name, values)
    reload = await ctx.save_routerdb(rdb, rel, user)
    db.audit(user, "node:update", wid, name, {k: ("***" if k in SECRET_KEYS else v) for k, v in values.items()})
    return {"ok": True, "reload": reload}


@router.delete("/api/w/{wid}/nodes/{name}")
async def delete_node(wid: str, name: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    rdb, rel, _d = await ctx.routerdb()
    rdb.delete(name)
    reload = await ctx.save_routerdb(rdb, rel, user)
    db.audit(user, "node:delete", wid, name)
    return {"ok": True, "reload": reload}


@router.post("/api/w/{wid}/bulk")
async def bulk(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    action, names = body.get("action"), list(body.get("names") or [])
    if not names:
        raise HTTPException(400, _("No devices selected"))
    if action == "fetch":
        ok, errors = 0, []
        groups = {}
        with contextlib.suppress(OxidizedAPIError):
            groups = {n.get("name"): node_group(n) for n in await ctx.api.nodes()}
        for n in names:
            try:
                await ctx.api.next(n, groups.get(n))
                ok += 1
            except OxidizedAPIError as exc:
                errors.append(f"{n}: {exc}")
        db.audit(user, "bulk:fetch", wid, f"{ok}")
        return {"ok": ok, "errors": errors}
    rdb, rel, _d = await ctx.routerdb()
    errors = []
    if action == "delete":
        for n in names:
            try:
                rdb.delete(n)
            except RouterDBError as exc:
                errors.append(str(exc))
    elif action == "set":
        values = _node_values(body.get("fields") or {}, rdb.schema.columns, True)
        values.pop("name", None)
        values.pop("ip", None)
        if not values:
            raise HTTPException(400, _("Nothing to change"))
        for n in names:
            try:
                rdb.update(n, dict(values))
            except RouterDBError as exc:
                errors.append(str(exc))
    else:
        raise HTTPException(400, _("Unknown action"))
    reload = await ctx.save_routerdb(rdb, rel, user)
    db.audit(user, f"bulk:{action}", wid, f"{len(names)}")
    return {"ok": len(names) - len(errors), "errors": errors, "reload": reload}


async def _group_of(ctx, name):
    with contextlib.suppress(OxidizedAPIError):
        return (await ctx.api.node_show(name) or {}).get("group")
    return None


@router.post("/api/w/{wid}/nodes/{name}/fetch")
async def fetch_now(wid: str, name: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    await ctx.api.next(name, await _group_of(ctx, name))
    db.audit(user, "node:fetch", wid, name)
    return {"ok": True}


@router.get("/api/w/{wid}/nodes/{name}/config", response_class=PlainTextResponse)
async def node_config(wid: str, name: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    return await ctx.api.fetch(name, await _group_of(ctx, name))


@router.get("/api/w/{wid}/nodes/{name}/versions")
async def node_versions(wid: str, name: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    return await ctx.api.versions(name, await _group_of(ctx, name))


@router.get("/api/w/{wid}/nodes/{name}/version", response_class=PlainTextResponse)
async def node_version(wid: str, name: str, oid: str, epoch: str = None, num: str = None, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    return await ctx.api.version_view(name, await _group_of(ctx, name), oid, epoch, num)


@router.get("/api/w/{wid}/nodes/{name}/diff")
async def node_diff(wid: str, name: str, oid: str, oid2: str = "current", _u=Depends(user_of)):
    """Diff from oid (older) to oid2 (newer; 'current' = latest collected config)."""
    ctx = ctx_of(wid)
    group = await _group_of(ctx, name)
    old = await ctx.api.version_view(name, group, oid)
    new = await ctx.api.fetch(name, group) if oid2 == "current" else await ctx.api.version_view(name, group, oid2)
    a, b = old.splitlines(), new.splitlines()
    patch = "\n".join(difflib.unified_diff(a, b, fromfile=oid[:10], tofile=oid2[:10], lineterm="", n=4))
    add = sum(1 for ln in patch.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    rem = sum(1 for ln in patch.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    return {"patch": patch, "added": add, "removed": rem, "old": old, "new": new}


def _log_dirs():
    return ["logs", "log", "."]


@router.get("/api/w/{wid}/nodes/{name}/debug-files")
async def debug_files(wid: str, name: str, _u=Depends(user_of)):
    """Oxidized input debug files (input.debug: true): logs/<ip>-<input>-<time>.txt/.yaml"""
    ctx = ctx_of(wid)
    rdb, _r, doc = await ctx.routerdb()
    e = rdb.find(name)
    ip = ((rdb.to_dict(e).get("ip") or "") if e else "").split("/")[0]
    keys = [k for k in (ip, name) if k]
    out = []
    for d in _log_dirs():
        for f in await asyncio.to_thread(ctx.files.listdir, d if d != "." else ""):
            if f["dir"]:
                continue
            if any(f["name"].startswith(k + "-") or f["name"] == k for k in keys):
                out.append({**f, "path": f["name"] if d == "." else f"{d}/{f['name']}"})
    out.sort(key=lambda f: f["mtime"], reverse=True)
    return {"files": out[:100], "input_debug": oxconfig.get_path(doc, "input.debug")}


@router.get("/api/w/{wid}/file", response_class=PlainTextResponse)
async def read_debug_file(wid: str, path: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    if ".." in path:
        raise HTTPException(400, _("Invalid path"))
    text = await ctx.read(path)
    return text[-400_000:]


@router.get("/api/w/{wid}/search")
async def search(wid: str, q: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    if len(q) < 2:
        raise HTTPException(400, _("Enter at least 2 characters"))
    return await ctx.api.conf_search(q)


@router.post("/api/w/{wid}/reload")
async def reload_nodes(wid: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    db.audit(user, "reload", wid)
    return await ctx.reload()


@router.get("/api/w/{wid}/backup/bundle")
async def backup_bundle(wid: str, _u=Depends(user_of)):
    """Latest config of every device — used by another manager's backup destinations."""
    try:
        return await collect_local(ctx_of(wid))
    except BackupError as exc:
        raise HTTPException(502, str(exc)) from exc


# ====================================================================== embedded Oxidized process
@router.get("/api/w/{wid}/process")
async def process_status(wid: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    if not ctx.proc:
        raise HTTPException(409, _("This workspace's Oxidized process is not managed by this panel"))
    return ctx.proc.status()


@router.post("/api/w/{wid}/process/{action}")
async def process_action(wid: str, action: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    if not ctx.proc:
        raise HTTPException(409, _("This workspace's Oxidized process is not managed by this panel"))
    fn = {"start": ctx.proc.start, "stop": ctx.proc.stop, "restart": ctx.proc.restart}.get(action)
    if not fn:
        raise HTTPException(400, _("Unknown action"))
    ctx.proc.note(f"{action} requested by {user}")
    st = await asyncio.to_thread(fn)
    db.audit(user, f"process:{action}", wid)
    return st


@router.get("/api/w/{wid}/process/logs", response_class=PlainTextResponse)
async def process_logs(wid: str, tail: int = 1000, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    if not ctx.proc:
        raise HTTPException(409, _("No logs for this workspace"))
    return "\n".join(i["d"] for i in list(ctx.proc.lines)[-min(tail, 5000):])


# ====================================================================== Oxidized config
@router.get("/api/w/{wid}/config")
async def get_config(wid: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    rdb, rel, _d = await ctx.routerdb(doc)
    s = oxconfig.summary(doc)
    s["routerdb_path"] = rel
    s["node_count"] = len(rdb.nodes())
    s["group_usage"] = {}
    for n in rdb.as_list():
        g = n.get("group") or ""
        s["group_usage"][g] = s["group_usage"].get(g, 0) + 1
    return s


@router.get("/api/w/{wid}/config/raw", response_class=PlainTextResponse)
async def get_config_raw(wid: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    return await ctx.read(ctx.config_name)


@router.post("/api/w/{wid}/config/validate")
async def validate_config(wid: str, body: dict = Body(...), _u=Depends(user_of)):
    try:
        _d, warnings = oxconfig.validate_text(body.get("text", ""))
        return {"ok": True, "warnings": warnings}
    except ConfigError as exc:
        return {"ok": False, "error": str(exc)}


@router.put("/api/w/{wid}/config/raw")
async def put_config_raw(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    text = body.get("text", "")
    _d, warnings = oxconfig.validate_text(text)
    await ctx.write(ctx.config_name, text, "config", user)
    return {"ok": True, "warnings": warnings, "restart_required": True}


@router.patch("/api/w/{wid}/config/settings")
async def patch_settings(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    for path, val in (body.get("values") or {}).items():
        if path not in oxconfig.SETTINGS:
            raise HTTPException(400, _("Setting cannot be edited: {path}", path=path))
        if path in oxconfig.SECRET_SETTINGS and not val:
            continue
        oxconfig.set_path(doc, path, oxconfig.coerce(path, val))
    if body.get("prompt"):
        cur = doc.get("prompt")
        if hasattr(cur, "value"):  # keep the !ruby/regexp tag
            cur.value = body["prompt"]
        else:
            doc["prompt"] = body["prompt"]
    await ctx.save_config(doc, user)
    return {"ok": True, "restart_required": True}


@router.put("/api/w/{wid}/config/model-map")
async def put_model_map(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    oxconfig.set_model_map(doc, body.get("model_map") or {})
    await ctx.save_config(doc, user)
    return {"ok": True, "restart_required": True}


@router.post("/api/w/{wid}/config/schema-fix")
async def schema_fix(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    for code in body.get("codes") or []:
        oxconfig.fix_schema(doc, code)
    await ctx.save_config(doc, user)
    return {"ok": True, "restart_required": True}


@router.post("/api/w/{wid}/groups")
async def create_group(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    name = (body.get("name") or "").strip()
    if name in (doc.get("groups") or {}):
        raise HTTPException(400, _("Group '{name}' already exists", name=name))
    oxconfig.upsert_group(doc, name, body)
    await ctx.save_config(doc, user)
    db.audit(user, "group:create", wid, name)
    return {"ok": True, "restart_required": True}


@router.put("/api/w/{wid}/groups/{name}")
async def update_group(wid: str, name: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    new_name = (body.get("name") or name).strip()
    oxconfig.upsert_group(doc, new_name, body, rename_from=name)
    await ctx.save_config(doc, user)
    reload = None
    if new_name != name and body.get("rename_nodes"):
        rdb, rel, _d = await ctx.routerdb(doc)
        for e in rdb.nodes():
            if e.get(rdb.schema, "group") == name:
                rdb.update(e.get(rdb.schema, "name"), {"group": new_name})
        reload = await ctx.save_routerdb(rdb, rel, user)
    db.audit(user, "group:update", wid, name)
    return {"ok": True, "restart_required": True, "reload": reload}


@router.delete("/api/w/{wid}/groups/{name}")
async def remove_group(wid: str, name: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    rdb, _r, _d = await ctx.routerdb(doc)
    used = [n["name"] for n in rdb.as_list() if n.get("group") == name]
    if used:
        raise HTTPException(400, _("The group is used by {n} device(s) ({names}…)", n=len(used), names=", ".join(used[:5])))
    oxconfig.delete_group(doc, name)
    await ctx.save_config(doc, user)
    db.audit(user, "group:delete", wid, name)
    return {"ok": True, "restart_required": True}


@router.get("/api/w/{wid}/groups/{name}/secrets")
async def group_secrets(wid: str, name: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    _t, doc = await ctx.config()
    g = (doc.get("groups") or {}).get(name) or {}
    db.audit(user, "group:reveal", wid, name)
    return {"password": g.get("password"), "enable": (g.get("vars") or {}).get("enable")}


# ====================================================================== router.db raw / import / export / file backups
@router.get("/api/w/{wid}/routerdb/raw", response_class=PlainTextResponse)
async def routerdb_raw(wid: str, _u=Depends(user_of)):
    ctx = ctx_of(wid)
    _r, rel, _d = await ctx.routerdb()
    try:
        return await ctx.read(rel)
    except FilesError:
        return ""


@router.put("/api/w/{wid}/routerdb/raw")
async def put_routerdb_raw(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    _r, rel, doc = await ctx.routerdb()
    text = body.get("text", "")
    rdb = RouterDB(text, oxconfig.schema_of(doc))
    names = [n.get("name") for n in rdb.as_list()]
    dups = sorted({n for n in names if names.count(n) > 1})
    if dups:
        raise HTTPException(400, _("Duplicate device names: {names}", names=", ".join(dups)))
    await ctx.write(rel, text, "routerdb", user)
    return {"ok": True, "nodes": len(names), "reload": await ctx.reload()}


@router.get("/api/w/{wid}/export.csv")
async def export(wid: str, reveal: bool = False, user=Depends(user_of)):
    ctx = ctx_of(wid)
    rdb, _r, _d = await ctx.routerdb()
    if reveal:
        db.audit(user, "export:reveal", wid)
    return Response(export_csv(rdb, reveal), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="oxidized-{wid}.csv"'})


@router.post("/api/w/{wid}/import")
async def import_nodes(wid: str, body: dict = Body(...), user=Depends(user_of)):
    ctx = ctx_of(wid)
    rdb, rel, _d = await ctx.routerdb()
    rows = parse_import(body.get("text", ""), rdb.schema)
    mode = body.get("mode", "add")  # add | upsert
    added, updated, skipped, errors = 0, 0, 0, []
    for r in rows:
        name = (r.get("name") or "").strip()
        vals = {k: v for k, v in r.items() if k in rdb.schema.columns and v not in (None, "")}
        try:
            if rdb.find(name):
                if mode == "upsert":
                    rdb.update(name, vals)
                    updated += 1
                else:
                    skipped += 1
            else:
                rdb.add(vals)
                added += 1
        except RouterDBError as exc:
            errors.append(f"{name or '?'}: {exc}")
    result = {"added": added, "updated": updated, "skipped": skipped, "errors": errors, "total": len(rows)}
    if body.get("dry_run"):
        return {**result, "dry_run": True}
    if added or updated:
        result["reload"] = await ctx.save_routerdb(rdb, rel, user)
    db.audit(user, "import", wid, f"+{added} ~{updated}")
    return result


@router.get("/api/w/{wid}/backups")
async def backups(wid: str, _u=Depends(user_of)):
    return files.list_backups(wid)


@router.get("/api/w/{wid}/backups/{name}", response_class=PlainTextResponse)
async def backup_content(wid: str, name: str, _u=Depends(user_of)):
    return files.read_backup(wid, name)


@router.post("/api/w/{wid}/backups/{name}/restore")
async def backup_restore(wid: str, name: str, user=Depends(user_of)):
    ctx = ctx_of(wid)
    text = files.read_backup(wid, name)
    label = name.rsplit(".", 1)[0]
    if label == "config":
        oxconfig.validate_text(text)
        await ctx.write(ctx.config_name, text, "config", user)
        return {"ok": True, "restart_required": True}
    if label == "routerdb":
        _r, rel, _d = await ctx.routerdb()
        await ctx.write(rel, text, "routerdb", user)
        return {"ok": True, "reload": await ctx.reload()}
    raise HTTPException(400, _("Unknown backup type"))


# ====================================================================== websockets
def _ws_user(ws: WebSocket):
    ident = getattr(ws.state, "identity", None)
    return ident.name if ident else None


async def _pump_thread(ws, target, *args):
    """Runs a blocking producer in a thread and streams its items to the WebSocket."""
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=20000)
    stop = threading.Event()

    def put(item):
        if not q.full():
            q.put_nowait(item)

    def emit(item):
        loop.call_soon_threadsafe(put, item)

    def runner():
        try:
            target(*args, emit, stop)
        except Exception as exc:  # noqa: BLE001
            emit({"t": "error", "d": f"{exc.__class__.__name__}: {exc}"})
        finally:
            emit(None)

    # copy the context so the request language reaches the worker thread
    fut = loop.run_in_executor(None, contextvars.copy_context().run, runner)

    async def sender():
        while True:
            item = await q.get()
            batch = []
            finished = item is None
            if item is not None:
                batch.append(item)
            while not finished and not q.empty() and len(batch) < 500:
                nxt = q.get_nowait()
                if nxt is None:
                    finished = True
                else:
                    batch.append(nxt)
            if batch:
                await ws.send_text(json.dumps({"items": batch}))
            if finished:
                await ws.send_text(json.dumps({"end": True}))
                return

    async def receiver():
        while True:
            msg = await ws.receive_text()
            if msg == "stop":
                stop.set()

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        stop.set()
        for t in tasks:
            t.cancel()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(fut, timeout=5)
        with contextlib.suppress(Exception):
            await ws.close()


@router.websocket("/api/w/{wid}/ws/logs")
async def ws_logs(ws: WebSocket, wid: str, tail: int = 300):
    await ws.accept()
    w = db.get_workspace(wid)
    if not w or w["type"] != "local":
        await ws.send_text(json.dumps({"items": [{"t": "error", "d": _("No live log for this workspace (plain Oxidized API)")}]}))
        await ws.send_text(json.dumps({"end": True}))
        await ws.close()
        return
    sup = local_supervisor()

    def stream(emit, stop):
        for item in sup.subscribe(emit, tail=min(max(tail, 0), 5000)):
            emit(item)
        try:
            stop.wait()
        finally:
            sup.unsubscribe(emit)

    await _pump_thread(ws, stream)


@router.websocket("/api/w/{wid}/ws/test")
async def ws_test(ws: WebSocket, wid: str):
    await ws.accept()
    user = _ws_user(ws)
    params = json.loads(await ws.receive_text())
    ctx = ctx_of(wid)
    events = []
    node = params.get("node")
    draft = {k: v for k, v in (params.get("draft") or {}).items() if v not in (None, "")}
    if (node or draft) and ctx.files:
        rdb, _r, doc = await ctx.routerdb()
        e = rdb.find(node) if node else None
        entry = rdb.to_dict(e, reveal=True) if e else {}
        entry.update(draft)
        if entry.get("ip") or node:
            r = _resolve(doc, entry)
            inputs = [x.strip() for x in r["input"].split(",") if x.strip()]
            proto = params.get("protocol") or (inputs[0] if inputs else "ssh")
            if proto not in ("ssh", "telnet"):
                events.append({"t": "warn", "d": _("Input '{proto}' cannot be tested; trying ssh", proto=proto)})
                proto = "ssh"
            base = {
                "host": entry.get("ip") or node, "model": r["model"], "protocol": proto,
                "port": r["telnet_port"] if proto == "telnet" else r["ssh_port"],
                "username": r["username"], "password": r["password"], "enable": r["enable"],
                "prompt": r["prompt"], "timeout": r["timeout"],
            }
            events += [
                {"t": "info", "d": _("Oxidized resolution: model={model} input={input}", model=r["model"], input=r["input"])},
                {"t": "info", "d": f"username ← {r['username_from']}, password ← {r['password_from']}, enable ← {r['enable_from']}"},
                {"t": "info", "d": f"ssh_port={r['ssh_port']} ({r['ssh_port_from']}), "
                                   f"telnet_port={r['telnet_port']} ({r['telnet_port_from']})"},
            ]
            if r["auth_methods"]:
                events.append({"t": "info", "d": f"auth_methods (group vars): {', '.join(map(str, r['auth_methods']))}"})
            for k, v in params.items():
                if v not in (None, "", []) and k in ("host", "port", "username", "password", "enable",
                                                      "commands", "timeout", "prompt"):
                    base[k] = v
            params = base
    db.audit(user, "node:test", wid, node or params.get("host"))
    if events:
        await ws.send_text(json.dumps({"items": events}))

    def run(emit, stop):
        devicetest.run_test(params, lambda t, d: emit({"t": t, "d": d, "ts": time.time()}), stop)

    await _pump_thread(ws, run)
