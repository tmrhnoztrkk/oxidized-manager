"""Setup, authentication (incl. password reset by e-mail), users, profile & sharing, API keys, SMTP settings,
workspaces and the audit log."""
import asyncio
import hashlib
import json
import re
import time
import uuid

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request

from . import db, files, mailer, oxconfig, settings
from .deps import admin, identity, need_role, session_user
from .i18n import _, current as current_lang, set_lang
from .perms import Identity
from .routerdb import RouterDB
from .supervisor import local_supervisor
from .workspace import Ctx, agent_info

router = APIRouter()
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{3,64}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
RESET_TTL = 3600          # a reset link is valid for one hour
RESET_INTERVAL = 60       # at most one reset e-mail per user per minute


def _check_username(u):
    if not USERNAME_RE.match(u or ""):
        raise HTTPException(400, _("Username must be 3-64 characters (letters, digits, _ . @ -)"))


def _check_password(p):
    if len(p or "") < 8:
        raise HTTPException(400, _("Password must be at least 8 characters"))


def _profile_fields(body, user=None):
    """Validated first name, last name and e-mail from a request body; fields left out keep ``user``'s values."""
    def field(k):
        return str(body[k] if k in body else (user or {}).get(k) or "").strip()
    uid = user["id"] if user else None
    first, last, email = field("first_name"), field("last_name"), field("email")
    if len(first) > 64 or len(last) > 64:
        raise HTTPException(400, _("Names can be at most 64 characters"))
    if email:
        if len(email) > 254 or not EMAIL_RE.match(email):
            raise HTTPException(400, _("Enter a valid e-mail address"))
        other = db.user_by_email(email)
        if other and other["id"] != uid:
            raise HTTPException(400, _("This e-mail address is already used by another user"))
    return first, last, email


def gravatar_hash(email):
    return hashlib.sha256(email.strip().lower().encode()).hexdigest() if email else None


# ====================================================================== setup & auth
@router.get("/api/setup/status")
async def setup_status():
    return {"needs_setup": db.user_count() == 0, "version": settings.VERSION}


@router.post("/api/setup")
async def setup(request: Request, body: dict = Body(...)):
    """First run: creates the administrator account (only while there are no users)."""
    if db.user_count() > 0:
        raise HTTPException(409, _("Setup has already been completed"))
    u, p = (body.get("username") or "").strip(), body.get("password") or ""
    _check_username(u)
    _check_password(p)
    db.create_user(u, p, role="admin")
    request.session.update(user=u, gen=0)
    db.audit(u, "setup")
    return {"user": u}


@router.post("/api/auth/login")
async def login(request: Request, body: dict = Body(...)):
    u = db.authenticate(str(body.get("username", "")), str(body.get("password", "")))
    if u:
        request.session.update(user=u["username"], gen=u["session_gen"])
        db.audit(u["username"], "login")
        return {"user": u["username"]}
    await asyncio.sleep(1.0)
    raise HTTPException(401, _("Wrong username or password"))


@router.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/api/auth/me")
async def me(request: Request):
    ident = getattr(request.state, "identity", None)
    user = ident.user if ident and ident.user else None
    profile = {k: user[k] for k in ("first_name", "last_name", "email")} if user else {}
    if user:
        profile["avatar"] = gravatar_hash(user["email"])
    return {"user": user["username"] if user else None, "role": user["role"] if user else None,
            "profile": profile, "reset_enabled": mailer.enabled(),
            "needs_setup": db.user_count() == 0, "version": settings.VERSION,
            "has_local": db.get_workspace(settings.LOCAL_ID, reveal=False) is not None,
            "max_remote": settings.MAX_REMOTE_WORKSPACES, "remote_count": db.remote_count()}


def _reset_mail(user, link, lang):
    set_lang(lang)
    name = " ".join(x for x in (user["first_name"], user["last_name"]) if x) or user["username"]
    text = _("Hello {name},\n\nA password reset was requested for your Oxidized Manager account '{user}'.\n"
             "Open this link within one hour to choose a new password:\n\n{link}\n\n"
             "If you did not request this, you can ignore this e-mail; your password stays unchanged.",
             name=name, user=user["username"], link=link)
    try:
        mailer.send(user["email"], _("Oxidized Manager password reset"), text)
        db.audit(user["username"], "password:reset-mail")
    except mailer.MailError as e:
        db.audit(user["username"], "password:reset-mail-failed", detail={"error": str(e)})


@router.post("/api/auth/forgot")
async def forgot_password(tasks: BackgroundTasks, body: dict = Body(...)):
    """Sends a reset link to the e-mail of the account. The answer never tells whether the account exists."""
    if not mailer.enabled():
        raise HTTPException(400, _("Password reset by e-mail is not available — ask an administrator"))
    login_ = str(body.get("login") or "").strip()
    u = db.user_by_email(login_) if "@" in login_ else None
    u = u or (db.get_user(login_) if login_ else None)
    if u and u["email"] and not u["disabled"] and time.time() - (db.last_reset(u["id"]) or 0) > RESET_INTERVAL:
        base = mailer.load()["public_url"].rstrip("/")
        link = f"{base}/#/reset/{db.create_reset(u['id'], RESET_TTL)}"
        tasks.add_task(_reset_mail, u, link, current_lang())
    await asyncio.sleep(0.5)
    return {"ok": True}


@router.get("/api/auth/reset/{token}")
async def reset_check(token: str):
    u = db.reset_user(token)
    if not u or u["disabled"]:
        raise HTTPException(400, _("This reset link is invalid or has expired — request a new one"))
    return {"user": u["username"]}


@router.post("/api/auth/reset")
async def reset_password(body: dict = Body(...)):
    token = str(body.get("token") or "")
    u = db.reset_user(token)
    if not u or u["disabled"]:
        raise HTTPException(400, _("This reset link is invalid or has expired — request a new one"))
    _check_password(body.get("password"))
    db.set_password(u["id"], body["password"])
    db.use_reset(token, u["id"])
    db.audit(u["username"], "password:reset")
    return {"ok": True, "user": u["username"]}


# ====================================================================== users
def _public_user(u, memberships=None):
    out = {k: u[k] for k in ("id", "username", "role", "created_at", "last_login", "first_name", "last_name", "email")}
    out["disabled"] = bool(u["disabled"])
    out["avatar"] = gravatar_hash(u["email"])
    if memberships is not None:
        out["access"] = memberships.get(u["id"], {})
    return out


def _apply_access(uid, access, actor):
    """Replaces the workspace roles of a user with ``access`` ({workspace_id: role})."""
    valid = {w["id"] for w in db.list_workspaces()}
    current = db.memberships_of(uid)
    for wid, role in (access or {}).items():
        if wid not in valid:
            continue
        if role and role not in db.ROLES:
            raise HTTPException(400, _("Invalid role: {role}", role=role))
        if current.get(wid) != (role or None):
            db.set_member(wid, uid, role or None)
            db.audit(actor, "member:set", wid, str(uid), {"role": role or None})
    for wid in current:
        if wid not in (access or {}):
            db.set_member(wid, uid, None)
            db.audit(actor, "member:set", wid, str(uid), {"role": None})


@router.get("/api/users")
async def users(_a: Identity = Depends(admin)):
    mem = db.all_memberships()
    return [_public_user(u, mem) for u in db.list_users()]


@router.get("/api/users/brief")
async def users_brief(ident: Identity = Depends(session_user)):
    """User list for the share dialog (admins and workspace managers)."""
    if not ident.is_admin and "manager" not in db.memberships_of(ident.user["id"]).values():
        raise HTTPException(403, _("Only administrators can do this"))
    return [{"id": u["id"], "username": u["username"], "role": u["role"], "disabled": bool(u["disabled"])}
            for u in db.list_users()]


@router.post("/api/users")
async def add_user(body: dict = Body(...), ident: Identity = Depends(admin)):
    u, p = (body.get("username") or "").strip(), body.get("password") or ""
    _check_username(u)
    _check_password(p)
    role = "admin" if body.get("role") == "admin" else "user"
    if db.get_user(u):
        raise HTTPException(400, _("This user already exists"))
    profile = _profile_fields(body)
    uid = db.create_user(u, p, role)
    db.update_profile(uid, *profile)
    if body.get("access"):
        _apply_access(uid, body["access"], ident.name)
    db.audit(ident.name, "user:create", target=u, detail={"role": role})
    return _public_user(db.get_user(uid=uid), db.all_memberships())


@router.put("/api/users/{uid}")
async def update_user(uid: int, request: Request, body: dict = Body(...), ident: Identity = Depends(admin)):
    target = db.get_user(uid=uid)
    if not target:
        raise HTTPException(404, _("User not found"))
    role = body.get("role")
    disabled = body.get("disabled")
    if role is not None and role not in ("admin", "user"):
        raise HTTPException(400, _("Invalid role: {role}", role=role))
    losing_admin = target["role"] == "admin" and not target["disabled"] and (role == "user" or disabled)
    if losing_admin and db.admin_count() <= 1:
        raise HTTPException(400, _("At least one active administrator is required"))
    if target["id"] == ident.user["id"] and (disabled or role == "user"):
        raise HTTPException(400, _("You cannot disable or demote your own account"))
    profile = _profile_fields(body, target) if any(k in body for k in ("first_name", "last_name", "email")) else None
    if body.get("password"):
        _check_password(body["password"])  # before any change is written
    db.update_user(uid, role=role, disabled=disabled)
    if profile:
        db.update_profile(uid, *profile)
    if body.get("password"):
        # signs the user out everywhere — except the administrator's own current session
        gen = db.set_password(uid, body["password"])
        if target["id"] == ident.user["id"]:
            request.session["gen"] = gen
        db.audit(ident.name, "user:password-reset", target=target["username"])
    if "access" in body:
        _apply_access(uid, body["access"] or {}, ident.name)
    db.audit(ident.name, "user:update", target=target["username"],
             detail={k: body[k] for k in ("role", "disabled", "email") if k in body})
    return _public_user(db.get_user(uid=uid), db.all_memberships())


@router.delete("/api/users/{uid}")
async def remove_user(uid: int, ident: Identity = Depends(admin)):
    target = db.get_user(uid=uid)
    if not target:
        raise HTTPException(404, _("User not found"))
    if target["id"] == ident.user["id"]:
        raise HTTPException(400, _("You cannot delete your own account"))
    if target["role"] == "admin" and not target["disabled"] and db.admin_count() <= 1:
        raise HTTPException(400, _("At least one active administrator is required"))
    db.delete_user(uid)
    db.audit(ident.name, "user:delete", target=target["username"])
    return {"ok": True}


@router.put("/api/users/me/password")
async def change_password(request: Request, body: dict = Body(...), ident: Identity = Depends(session_user)):
    if not db.authenticate(ident.user["username"], body.get("current", "")):
        raise HTTPException(400, _("The current password is wrong"))
    _check_password(body.get("new", ""))
    # other browsers are signed out; this one stays signed in
    request.session["gen"] = db.set_password(ident.user["id"], body["new"])
    db.audit(ident.name, "user:password")
    return {"ok": True}


@router.put("/api/profile")
async def update_profile(body: dict = Body(...), ident: Identity = Depends(session_user)):
    """The signed-in user edits their own name and e-mail."""
    first, last, email = _profile_fields(body, ident.user)
    db.update_profile(ident.user["id"], first, last, email)
    db.audit(ident.name, "user:profile", detail={"email": email})
    return {"first_name": first, "last_name": last, "email": email, "avatar": gravatar_hash(email)}


# ====================================================================== e-mail (SMTP)
def _smtp_fields(body):
    cfg = {k: body.get(k, v) for k, v in mailer.DEFAULTS.items()}
    cfg["host"] = str(cfg["host"] or "").strip()
    cfg["from_email"] = str(cfg["from_email"] or "").strip()
    cfg["public_url"] = str(cfg["public_url"] or "").strip().rstrip("/")
    cfg["verify_tls"] = bool(cfg["verify_tls"])
    try:
        cfg["port"] = int(cfg["port"] or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, _("Invalid port")) from None
    if not 0 < cfg["port"] < 65536:
        raise HTTPException(400, _("Invalid port"))
    if cfg["security"] not in mailer.SECURITY:
        raise HTTPException(400, _("Invalid encryption setting"))
    if cfg["host"]:
        if not EMAIL_RE.match(cfg["from_email"]):
            raise HTTPException(400, _("Enter a valid sender e-mail address"))
        if not re.match(r"^https?://[^\s/]+", cfg["public_url"]):
            raise HTTPException(400, _("Enter the panel address, e.g. https://oxidized.example.com"))
    cfg["password"] = body.get("password") or ""
    cfg["clear_password"] = bool(body.get("clear_password"))
    return cfg


@router.get("/api/settings/smtp")
async def smtp_settings(_a: Identity = Depends(admin)):
    return mailer.load()


@router.put("/api/settings/smtp")
async def save_smtp(body: dict = Body(...), ident: Identity = Depends(admin)):
    mailer.save(_smtp_fields(body))
    db.audit(ident.name, "smtp:update", detail={"host": body.get("host") or ""})
    return mailer.load()


@router.post("/api/settings/smtp/test")
async def test_smtp(body: dict = Body(...), ident: Identity = Depends(admin)):
    """Sends a test message with the settings in the form (unsaved changes included)."""
    to = str(body.get("to") or "").strip()
    if not EMAIL_RE.match(to):
        raise HTTPException(400, _("Enter a valid e-mail address"))
    cfg = _smtp_fields(body)
    if not cfg["password"] and not cfg["clear_password"]:
        cfg["password"] = mailer.load(reveal=True)["password"]
    text = _("This is a test message from Oxidized Manager. The e-mail settings work.")
    try:
        await asyncio.to_thread(mailer.send, to, _("Oxidized Manager test e-mail"), text, cfg)
    except mailer.MailError as e:
        raise HTTPException(400, str(e)) from None
    db.audit(ident.name, "smtp:test", detail={"to": to})
    return {"ok": True}


# ====================================================================== API keys (remote access)
@router.get("/api/tokens")
async def tokens(_a: Identity = Depends(admin)):
    return db.list_tokens()


@router.post("/api/tokens")
async def add_token(body: dict = Body(...), ident: Identity = Depends(admin)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, _("Name is required"))
    scope = "read" if body.get("scope") == "read" else "full"
    tok = db.create_token(name, scope, ident.name)
    db.audit(ident.name, "token:create", target=name, detail={"scope": scope})
    return {"token": tok}


@router.delete("/api/tokens/{tid}")
async def remove_token(tid: int, ident: Identity = Depends(admin)):
    db.delete_token(tid)
    db.audit(ident.name, "token:delete", target=str(tid))
    return {"ok": True}


@router.get("/api/agent/info")
async def agent_info_ep(ident: Identity = Depends(identity)):
    """Used by other managers to test the connection: summary of this installation's local workspace."""
    ws = db.get_workspace(settings.LOCAL_ID, reveal=False)
    out = {"version": settings.VERSION, "local": ws is not None}
    if ws:
        out["name"] = ws["name"]
        out["process"] = local_supervisor().status()
    return out


# ====================================================================== workspaces
def public_ws(ws, ident=None, counts=None):
    out = db.get_workspace(ws["id"], reveal=False)
    if out["type"] == "local":
        out["process"] = local_supervisor().status()
        out["config"]["home"] = settings.local_home().as_posix()
    if ident is not None:
        out["role"] = ident.role_in(ws["id"])
    if counts is not None:
        out["members"] = counts.get(ws["id"], 0)
    return out


@router.get("/api/workspaces")
async def workspaces(ident: Identity = Depends(session_user)):
    counts = db.member_counts() if ident.is_admin else None
    return [public_ws(w, ident, counts) for w in db.list_workspaces() if ident.role_in(w["id"])]


@router.post("/api/workspaces/test-agent")
async def test_agent(body: dict = Body(...), _a: Identity = Depends(admin)):
    token = body.get("token")
    if not token and body.get("id"):
        ws = db.get_workspace(body["id"])
        token = (ws or {}).get("config", {}).get("token")
    return await agent_info(body.get("url"), token or "", bool(body.get("verify_tls", True)))


@router.post("/api/workspaces")
async def create_workspace(body: dict = Body(...), ident: Identity = Depends(admin)):
    type_ = body.get("type")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, _("Workspace name is required"))
    cfg = body.get("config") or {}
    if type_ == "local":
        if db.get_workspace(settings.LOCAL_ID):
            raise HTTPException(409, _("This installation already runs an embedded Oxidized workspace. "
                                       "Only remote workspaces can be added."))
        home = settings.local_home()
        home.mkdir(parents=True, exist_ok=True)
        (home / "logs").mkdir(exist_ok=True)
        setup = body.get("setup") or {}
        cfg_text = oxconfig.build_config(setup, home.as_posix(), settings.OXIDIZED_REST_PORT)
        (home / "config").write_text(cfg_text, encoding="utf-8")
        rdb = RouterDB(oxconfig.ROUTERDB_HEADER, oxconfig.schema_of(oxconfig.load(cfg_text)))
        first = setup.get("first_device") or {}
        if first.get("name") and first.get("ip"):
            rdb.add({k: v for k, v in first.items() if v not in (None, "")})
        (home / "router.db").write_text(rdb.render(), encoding="utf-8")
        db.save_workspace(settings.LOCAL_ID, name, "local", {})
        db.audit(ident.name, "workspace:create", settings.LOCAL_ID, name)
        await asyncio.to_thread(local_supervisor().start)
        return public_ws(db.get_workspace(settings.LOCAL_ID), ident)
    if type_ not in ("agent", "oxidized"):
        raise HTTPException(400, _("Invalid workspace type"))
    if db.remote_count() >= settings.MAX_REMOTE_WORKSPACES:
        raise HTTPException(409, _("At most {n} remote workspaces can be managed from one installation",
                                   n=settings.MAX_REMOTE_WORKSPACES))
    if type_ == "agent":
        if not cfg.get("url") or not cfg.get("token"):
            raise HTTPException(400, _("Remote manager address and API key are required"))
        info = await agent_info(cfg["url"], cfg["token"], bool(cfg.get("verify_tls", True)))
        if not info["ok"] and not body.get("force"):
            raise HTTPException(400, _("Could not verify the remote workspace: {err}", err=info["error"]))
    elif not cfg.get("url"):
        raise HTTPException(400, _("Oxidized REST address is required"))
    wid = uuid.uuid4().hex[:10]
    keep = {k: cfg.get(k) for k in ("url", "token", "username", "password", "verify_tls", "timeout") if k in cfg}
    keep["url"] = keep["url"].rstrip("/")
    db.save_workspace(wid, name, type_, keep)
    db.audit(ident.name, "workspace:create", wid, name)
    return public_ws(db.get_workspace(wid), ident)


@router.put("/api/workspaces/{wid}")
async def update_workspace(wid: str, body: dict = Body(...), ident: Identity = Depends(admin)):
    raw = db.raw_workspace(wid)
    if not raw:
        raise HTTPException(404, _("Workspace not found"))
    name = (body.get("name") or raw["name"]).strip()
    cfg = body.get("config") or {}
    keep = {k: cfg.get(k) for k in ("url", "token", "username", "password", "verify_tls", "timeout") if k in cfg}
    if keep.get("url"):
        keep["url"] = keep["url"].rstrip("/")
    merged = {k: v for k, v in json.loads(raw["config"] or "{}").items() if k not in db.SECRET_CFG}
    merged.update({k: v for k, v in keep.items() if k not in db.SECRET_CFG})
    for k in db.SECRET_CFG:
        if keep.get(k):
            merged[k] = keep[k]  # new value; empty → save_workspace keeps the old one
    db.save_workspace(wid, name, raw["type"], merged, existing=raw)
    db.audit(ident.name, "workspace:update", wid, name)
    return public_ws(db.get_workspace(wid), ident)


@router.delete("/api/workspaces/{wid}")
async def delete_workspace(wid: str, purge: bool = False, ident: Identity = Depends(admin)):
    ws = db.get_workspace(wid)
    if not ws:
        raise HTTPException(404, _("Workspace not found"))
    if ws["type"] == "local":
        await asyncio.to_thread(local_supervisor().stop)
        if purge:
            files.remove_tree(settings.WORKSPACES_DIR / settings.LOCAL_ID)
    for d in db.list_destinations(wid):
        files.remove_tree(settings.DESTINATIONS_DIR / d["id"])
    db.delete_workspace(wid)
    db.audit(ident.name, "workspace:delete", wid, ws["name"], {"purge": purge})
    return {"ok": True}


@router.post("/api/workspaces/{wid}/test")
async def test_workspace(wid: str, ident: Identity = Depends(session_user)):
    ws = need_role(ident, wid, "viewer")
    ws = db.get_workspace(wid)
    if ws["type"] == "agent":
        info = await agent_info(ws["config"].get("url"), ws["config"].get("token"), ws["config"].get("verify_tls", True))
        return {"agent": info}
    from .routes_ws import health
    return await health(Ctx(ws))


# ------------------------------------------------------------------ sharing
@router.get("/api/workspaces/{wid}/members")
async def members(wid: str, ident: Identity = Depends(session_user)):
    need_role(ident, wid, "manager")
    admins = [{"user_id": u["id"], "username": u["username"], "role": "manager", "admin": True,
               "disabled": bool(u["disabled"])} for u in db.list_users() if u["role"] == "admin"]
    rows = [{"user_id": m["user_id"], "username": m["username"], "role": m["role"], "admin": m["user_role"] == "admin",
             "disabled": bool(m["disabled"])} for m in db.members_of(wid) if m["user_role"] != "admin"]
    return {"members": rows, "admins": admins}


@router.put("/api/workspaces/{wid}/members")
async def set_member(wid: str, body: dict = Body(...), ident: Identity = Depends(session_user)):
    ws = need_role(ident, wid, "manager")
    uid = body.get("user_id")
    role = body.get("role") or None
    target = db.get_user(uid=int(uid)) if uid is not None else None
    if not target:
        raise HTTPException(404, _("User not found"))
    if role and role not in db.ROLES:
        raise HTTPException(400, _("Invalid role: {role}", role=role))
    if target["role"] == "admin":
        raise HTTPException(400, _("Administrators already have full access to every workspace"))
    if target["id"] == ident.user["id"] and not ident.is_admin:
        raise HTTPException(400, _("You cannot change your own access"))
    db.set_member(wid, target["id"], role)
    db.audit(ident.name, "member:set", wid, target["username"], {"role": role})
    return {"ok": True, "workspace": ws["name"]}


# ====================================================================== audit log
@router.get("/api/audit")
async def audit(workspace: str = None, limit: int = 500, ident: Identity = Depends(session_user)):
    limit = max(1, min(limit, 5000))
    if ident.is_admin:
        return db.read_audit(limit=limit, workspace=workspace)
    if workspace:
        need_role(ident, workspace, "manager")
        return db.read_audit(limit=limit, workspace=workspace)
    managed = [w for w, r in db.memberships_of(ident.user["id"]).items() if r == "manager"]
    return db.read_audit(limit=limit, workspaces=managed)


@router.get("/api/models")
async def models(_i: Identity = Depends(identity)):
    from .models import MODELS
    return MODELS


@router.get("/healthz")
async def healthz():
    return {"ok": True, "version": settings.VERSION, "time": time.time()}
