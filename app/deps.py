"""Shared FastAPI dependencies: caller identity and role checks."""
from fastapi import HTTPException, Request

from . import db
from .i18n import _
from .perms import Identity, allows
from .workspace import Ctx


def identity(request: Request) -> Identity:
    ident = getattr(request.state, "identity", None)
    if not ident:
        raise HTTPException(401, _("Not signed in"))
    return ident


def user_of(request: Request) -> str:
    """Name for the audit log. Workspace permissions were already checked by AccessMiddleware."""
    return identity(request).name


def session_user(request: Request) -> Identity:
    """A signed-in panel user (API keys are not accepted)."""
    ident = identity(request)
    if not ident.user:
        raise HTTPException(401, _("Not signed in"))
    return ident


def admin(request: Request) -> Identity:
    ident = session_user(request)
    if not ident.is_admin:
        raise HTTPException(403, _("Only administrators can do this"))
    return ident


def need_role(ident: Identity, wid: str, level: str):
    ws = db.get_workspace(wid, reveal=False)
    if not ws:
        raise HTTPException(404, _("Workspace not found"))
    role = ident.role_in(wid)
    if role is None:
        raise HTTPException(403, _("You do not have access to this workspace"))
    if not allows(role, level):
        raise HTTPException(403, _("This action requires the '{need}' role in this workspace (yours: '{role}')",
                                   need=_(level), role=_(role)))
    return ws


def ctx_of(wid: str) -> Ctx:
    ws = db.get_workspace(wid)
    if not ws:
        raise HTTPException(404, _("Workspace not found"))
    if ws["type"] == "agent":
        raise HTTPException(500, _("Remote workspace requests must go through the proxy"))
    return Ctx(ws)
