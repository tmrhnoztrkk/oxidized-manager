"""Backup destinations API: /api/workspaces/<wid>/destinations/...

Destinations belong to *this* installation even for remote workspaces: the manager pulls the
configs (through the remote API) and pushes them itself, so these routes are never proxied.
"""
import asyncio

from fastapi import APIRouter, Body, Depends, HTTPException

from . import backup, db, files, settings
from .backup import BackupError
from .deps import need_role, session_user
from .i18n import _
from .perms import Identity

router = APIRouter()


def _public(d):
    cfg = d["config"]
    out = {k: d[k] for k in ("id", "workspace_id", "name", "type", "enabled", "interval_min", "created_at",
                             "last_run", "last_status", "last_message", "last_commit")}
    out["config"] = {k: v for k, v in cfg.items() if k not in ("known_hosts",)}
    out["target"] = backup.describe(d["type"], cfg)
    out["web_url"] = backup.web_url(d["type"], cfg)
    out["commit_url"] = backup.web_url(d["type"], cfg, d["last_commit"]) if d["last_commit"] else None
    out["running"] = backup.is_running(d["id"]) or d["last_status"] == "running"
    return out


def _prepare(body, wid, existing=None):
    """Validates the form and merges stored secrets for fields left empty."""
    ws = db.get_workspace(wid, reveal=False)
    type_ = body.get("type") or (existing or {}).get("type")
    cfg = dict(body.get("config") or {})
    if existing:
        stored = db.get_destination(existing["id"], reveal=True)["config"]
        for k in db.DEST_SECRETS:  # empty field in the form → keep the stored secret
            if not cfg.get(k) and not cfg.get(k + "_sealed") and stored.get(k):
                cfg[k] = stored[k]
        if stored.get("known_hosts") and cfg.get("url") == stored.get("url"):
            cfg["known_hosts"] = stored["known_hosts"]
    try:
        norm = backup.normalize(type_, cfg, ws["name"] if ws else "")
    except BackupError as exc:
        raise HTTPException(400, str(exc)) from exc
    if cfg.get("known_hosts"):
        norm["known_hosts"] = cfg["known_hosts"]
    name = (body.get("name") or "").strip() or backup.describe(type_, norm) or type_
    try:
        interval = max(0, int(body.get("interval_min", 60)))
    except (TypeError, ValueError):
        interval = 60
    return type_, name, norm, bool(body.get("enabled", True)), interval


@router.get("/api/workspaces/{wid}/destinations")
async def list_destinations(wid: str, ident: Identity = Depends(session_user)):
    need_role(ident, wid, "viewer")
    return [_public(d) for d in db.list_destinations(wid, reveal=False)]


@router.post("/api/workspaces/{wid}/destinations")
async def create_destination(wid: str, body: dict = Body(...), ident: Identity = Depends(session_user)):
    need_role(ident, wid, "manager")
    type_, name, cfg, enabled, interval = _prepare(body, wid)
    if type_ == "git_ssh" and not cfg.get("ssh_key"):
        raise HTTPException(400, _("Generate or paste an SSH private key"))
    if type_ in ("github", "gitlab", "gitea") and not cfg.get("token"):
        raise HTTPException(400, _("An access token is required"))
    did = backup.new_id()
    db.save_destination(did, wid, name, type_, cfg, enabled, interval)
    db.audit(ident.name, "destination:create", wid, name, {"type": type_, "target": backup.describe(type_, cfg)})
    if body.get("run_now") and enabled:
        backup.start(did, "manual")
    return _public(db.get_destination(did, reveal=False))


@router.put("/api/workspaces/{wid}/destinations/{did}")
async def update_destination(wid: str, did: str, body: dict = Body(...), ident: Identity = Depends(session_user)):
    need_role(ident, wid, "manager")
    d = db.get_destination(did, reveal=False)
    if not d or d["workspace_id"] != wid:
        raise HTTPException(404, _("Destination not found"))
    if "config" not in body:  # quick toggle (enabled / interval) without re-validating credentials
        db.save_destination(did, wid, body.get("name", d["name"]), d["type"],
                            {k: v for k, v in d["config"].items() if not k.startswith("has_")},
                            body.get("enabled", d["enabled"]), int(body.get("interval_min", d["interval_min"])),
                            existing=True)
    else:
        type_, name, cfg, enabled, interval = _prepare(body, wid, existing=d)
        db.save_destination(did, wid, name, type_, cfg, enabled, interval, existing=True)
    db.audit(ident.name, "destination:update", wid, body.get("name", d["name"]))
    return _public(db.get_destination(did, reveal=False))


@router.delete("/api/workspaces/{wid}/destinations/{did}")
async def delete_destination(wid: str, did: str, ident: Identity = Depends(session_user)):
    need_role(ident, wid, "manager")
    d = db.get_destination(did, reveal=False)
    if not d or d["workspace_id"] != wid:
        raise HTTPException(404, _("Destination not found"))
    db.delete_destination(did)
    files.remove_tree(settings.DESTINATIONS_DIR / did)
    db.audit(ident.name, "destination:delete", wid, d["name"])
    return {"ok": True}


@router.post("/api/workspaces/{wid}/destinations/test")
async def test_destination(wid: str, body: dict = Body(...), ident: Identity = Depends(session_user)):
    """Checks reachability and write access of a (possibly unsaved) destination."""
    need_role(ident, wid, "manager")
    existing = None
    if body.get("id"):
        existing = db.get_destination(body["id"], reveal=False)
        if not existing or existing["workspace_id"] != wid:
            raise HTTPException(404, _("Destination not found"))
    type_, _n, cfg, _e, _i = _prepare(body, wid, existing)
    try:
        res = await asyncio.to_thread(backup.check_access, type_, cfg)
    except BackupError as exc:
        return {"ok": False, "error": str(exc)}
    res.pop("known_hosts", None)
    return res


@router.post("/api/workspaces/{wid}/destinations/{did}/run")
async def run_destination(wid: str, did: str, ident: Identity = Depends(session_user)):
    need_role(ident, wid, "operator")
    d = db.get_destination(did, reveal=False)
    if not d or d["workspace_id"] != wid:
        raise HTTPException(404, _("Destination not found"))
    started = backup.start(did, f"manual:{ident.name}")
    db.audit(ident.name, "destination:run", wid, d["name"])
    return {"started": started, "running": True}


@router.get("/api/workspaces/{wid}/destinations/{did}/runs")
async def destination_runs(wid: str, did: str, ident: Identity = Depends(session_user)):
    need_role(ident, wid, "viewer")
    d = db.get_destination(did, reveal=False)
    if not d or d["workspace_id"] != wid:
        raise HTTPException(404, _("Destination not found"))
    runs = db.list_runs(did)
    for r in runs:
        r["commit_url"] = backup.web_url(d["type"], d["config"], r["commit_sha"]) if r["commit_sha"] else None
    return runs


@router.post("/api/keygen")
async def keygen(ident: Identity = Depends(session_user)):
    """New Ed25519 deploy key. The private half is returned sealed (encrypted with the server key)
    so it never reaches the browser in clear text; the form sends it back when saving."""
    priv, pub = backup.generate_key(f"oxidized-manager@{settings.VERSION}")
    return {"public_key": pub, "sealed": db.encrypt(priv)}
