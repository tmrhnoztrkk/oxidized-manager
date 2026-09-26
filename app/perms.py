"""Access control.

Global roles
  admin — manages users, workspaces, API keys; implicitly *manager* of every workspace.
  user  — sees only the workspaces shared with them, with a per-workspace role.

Workspace roles (ordered)
  viewer   — read devices, configs, versions/diffs, logs, backup destinations
  operator — viewer + add/edit/delete devices, import, trigger backups, connection tests, reveal device secrets
  manager  — operator + Oxidized settings, groups, process control, backup destinations, sharing

Every ``/api/w/<wid>/...`` request (local, proxied remote or plain Oxidized) is checked here by
:class:`AccessMiddleware` using one rule table, before it reaches an endpoint or the remote proxy.
API tokens (remote access from another Oxidized Manager) only reach the local workspace:
scope ``read`` acts as viewer, ``full`` as manager.
"""
import json
import re

from . import db, settings
from .i18n import _

def N_(s):
    """Marks a string for translation extraction (translated later with _(variable))."""
    return s


LEVELS = {N_("viewer"): 1, N_("operator"): 2, N_("manager"): 3}
WRITE = ("POST", "PUT", "PATCH", "DELETE")

# (methods, path regex relative to /api/w/<wid>, required role) — first match wins
RULES = [
    (("GET",), r"^/nodes/[^/]+/secrets$", "operator"),
    (("GET",), r"^/groups/[^/]+/secrets$", "manager"),
    (("GET",), r"^/config/raw$", "manager"),
    (("GET",), r"^/(routerdb/raw|backups(/.*)?)$", "manager"),
    (("GET",), r"^/(file|nodes/[^/]+/debug-files)$", "operator"),
    (("GET",), r".*", "viewer"),
    (("WS",), r"^/ws/logs$", "viewer"),
    (("WS",), r"^/ws/test$", "operator"),
    (("WS",), r".*", "manager"),
    (WRITE, r"^/(nodes(/.*)?|bulk|import|reload)$", "operator"),
    (WRITE, r".*", "manager"),
]
_RULES = [(m, re.compile(p), lvl) for m, p, lvl in RULES]

_PATH_RE = re.compile(r"^/api/w/([^/]+)(/.*)?$")


def required(method, rest, query=""):
    rest = rest or "/"
    for methods, rx, lvl in _RULES:
        if method in methods and rx.match(rest):
            if lvl == "viewer" and rest == "/export.csv" and "reveal=true" in query:
                return "operator"
            return lvl
    return "manager"


def allows(role, need):
    return LEVELS.get(role or "", 0) >= LEVELS[need]


# ------------------------------------------------------------------ identities
class Identity:
    """Who is calling: a panel user (session) or an API token (remote Oxidized Manager)."""

    def __init__(self, name, user=None, token=None, via=None):
        self.name = name          # shown in the audit log
        self.user = user          # users row (session)
        self.token = token        # tokens row (remote access)
        self.via = via

    @property
    def is_admin(self):
        return bool(self.user and self.user["role"] == "admin")

    def role_in(self, wid):
        if self.token:
            if wid != settings.LOCAL_ID:
                return None
            return "viewer" if self.token["scope"] == "read" else "manager"
        if not self.user:
            return None
        if self.is_admin:
            return "manager"
        return db.member_role(wid, self.user["id"])

    def can(self, wid, need):
        return allows(self.role_in(wid), need)


def session_identity(session):
    name = (session or {}).get("user")
    if not name:
        return None
    u = db.get_user(name)
    if not u or u["disabled"]:
        return None
    return Identity(u["username"], user=u)


def _bearer(headers):
    auth = headers.get("authorization") or ""
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None


def token_identity(headers, client_ip=None):
    tok = _bearer(headers)
    if not tok:
        return None, False
    row = db.check_token(tok, client_ip)
    if not row:
        return None, True
    via = headers.get("x-forwarded-user")
    return Identity(f"api:{row['name']}" + (f" ({via})" if via else ""), token=row, via=via), True


def identify(scope):
    """Resolves the caller of an ASGI request; returns (identity, bad_token)."""
    ident = session_identity(scope.get("session"))
    if ident:
        return ident, False
    headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
    client = scope.get("client")
    return token_identity(headers, client[0] if client else None)


# ------------------------------------------------------------------ middleware
class AccessMiddleware:
    """Checks workspace permissions for every /api/w/<wid>/... request and stores the identity
    in ``scope["state"]["identity"]`` for the endpoints (and the remote-workspace proxy)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        ident, bad_token = identify(scope)
        scope.setdefault("state", {})["identity"] = ident
        m = _PATH_RE.match(scope["path"])
        if not m:
            return await self.app(scope, receive, send)
        wid, rest = m.group(1), m.group(2) or "/"
        method = "WS" if scope["type"] == "websocket" else scope["method"]
        query = scope.get("query_string", b"").decode()
        if ident is None:
            msg = _("Invalid API key") if bad_token else _("Not signed in")
            return await _deny(scope, receive, send, 401, msg)
        if ident.token and wid != settings.LOCAL_ID:
            return await _deny(scope, receive, send, 403, _("API keys can only access the local workspace"))
        need = required(method, rest, query)
        role = ident.role_in(wid)
        if role is None:
            if not ident.token and db.get_workspace(wid, reveal=False) is None:
                return await _deny(scope, receive, send, 404, _("Workspace not found"))
            return await _deny(scope, receive, send, 403, _("You do not have access to this workspace"))
        if not allows(role, need):
            if ident.token:
                return await _deny(scope, receive, send, 403, _("This API key is read-only"))
            return await _deny(scope, receive, send, 403,
                               _("This action requires the '{need}' role in this workspace (yours: '{role}')",
                                 need=_(need), role=_(role)))
        return await self.app(scope, receive, send)


async def _deny(scope, receive, send, status, detail):
    if scope["type"] == "websocket":
        # Accept, report the reason in the stream format the UI understands, then close
        msg = await receive()
        if msg["type"] != "websocket.connect":
            return
        await send({"type": "websocket.accept"})
        await send({"type": "websocket.send", "text": json.dumps({"items": [{"t": "error", "d": detail}]})})
        await send({"type": "websocket.send", "text": json.dumps({"end": True})})
        await send({"type": "websocket.close", "code": 4401 if status == 401 else 4403})
        return
    body = json.dumps({"detail": detail}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
