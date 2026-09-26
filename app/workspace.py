"""Workspace context and the transparent API proxy for remote (agent) workspaces.

Workspace types:
  local    — the Oxidized embedded in this container (at most one, id = "local")
  agent    — the local workspace of another Oxidized Manager, reached over HTTPS with an API key
  oxidized — a plain Oxidized REST API (oxidized-web); devices and configs are read-only
"""
import asyncio
import json
import re
import ssl

import httpx
from fastapi import HTTPException
from starlette.websockets import WebSocket, WebSocketDisconnect

from . import db, files, oxconfig, settings
from .files import FilesError, LocalFiles
from .i18n import _, current as current_lang
from .oxapi import OxidizedAPI, OxidizedAPIError
from .routerdb import RouterDB
from .supervisor import local_supervisor

_PATH_RE = re.compile(r"^/api/w/([^/]+)(/.*)?$")


class Ctx:
    def __init__(self, ws):
        self.ws = ws
        self.id = ws["id"]
        self.type = ws["type"]
        self.files = None
        self.proc = None
        self.config_name = "config"
        self.home = oxconfig.DEFAULT_HOME
        cfg = ws.get("config") or {}
        if self.type == "local":
            home = settings.local_home()
            self.home = home.as_posix()
            self.files = LocalFiles(home)
            self.proc = local_supervisor()
            self.api = OxidizedAPI({"url": f"http://127.0.0.1:{self._rest_port()}", "timeout": 20})
        else:
            self.api = OxidizedAPI({"url": cfg.get("url"), "username": cfg.get("username"),
                                    "password": cfg.get("password"), "verify_tls": cfg.get("verify_tls", True),
                                    "timeout": cfg.get("timeout", 20)})

    def _rest_port(self):
        try:
            doc = oxconfig.load((settings.local_home() / "config").read_text(encoding="utf-8"))
            return oxconfig.rest_port(doc, settings.OXIDIZED_REST_PORT)
        except (OSError, ValueError):
            return settings.OXIDIZED_REST_PORT

    # -------------------------------------------------------------- files
    async def read(self, rel):
        if not self.files:
            raise HTTPException(409, _("This workspace is read-only (plain Oxidized API); devices and config cannot be edited."))
        return await asyncio.to_thread(self.files.read, rel)

    async def write(self, rel, text, label, user):
        if not self.files:
            raise HTTPException(409, _("This workspace is read-only"))
        if await asyncio.to_thread(self.files.exists, rel):
            old = await asyncio.to_thread(self.files.read, rel)
            if old == text:
                return None
            files.make_backup(self.id, label, old)
        await asyncio.to_thread(self.files.write, rel, text)
        db.audit(user, f"write:{label}", self.id, rel)
        return True

    async def config(self):
        text = await self.read(self.config_name)
        return text, oxconfig.load(text)

    async def routerdb(self, doc=None):
        if doc is None:
            _t, doc = await self.config()
        rel = oxconfig.routerdb_rel(doc, self.home)
        try:
            text = await self.read(rel)
        except FilesError:
            text = ""
        return RouterDB(text, oxconfig.schema_of(doc)), rel, doc

    async def save_config(self, doc, user):
        text = oxconfig.dump(doc)
        oxconfig.validate_text(text)
        await self.write(self.config_name, text, "config", user)

    async def save_routerdb(self, rdb, rel, user):
        await self.write(rel, rdb.render(), "routerdb", user)
        return await self.reload()

    async def reload(self):
        """Makes Oxidized re-read its node list after router.db changed (starts Oxidized if it is
        not running yet — e.g. when the first device is added)."""
        if self.proc and self.proc.status()["state"] != "running":
            st = await asyncio.to_thread(self.proc.start)
            if st["state"] == "running":
                return {"ok": True, "message": _("Oxidized started")}
            return {"ok": False, "message": st["message"] or st["state"]}
        try:
            await self.api.reload()
            return {"ok": True, "message": _("Oxidized reloaded the node list")}
        except OxidizedAPIError as exc:
            return {"ok": False, "message": str(exc), "can_restart": bool(self.proc)}


# ====================================================================== agent proxy
def _agent_target(ws, rest, query):
    base = (ws["config"].get("url") or "").rstrip("/")
    url = f"{base}/api/w/{settings.LOCAL_ID}{rest or ''}"
    return url + (f"?{query}" if query else "")


def _verify(ws):
    return bool(ws["config"].get("verify_tls", True))


def _agent_headers(ws, user=None):
    hdr = {"Authorization": f"Bearer {ws['config'].get('token', '')}", "Accept": "application/json",
           "X-Lang": current_lang()}
    if user:
        hdr["X-Forwarded-User"] = user
    return hdr


async def agent_request(ws, method, rest, query="", body=None, headers=None, user=None, timeout=60):
    hdr = _agent_headers(ws, user)
    hdr.update(headers or {})
    async with httpx.AsyncClient(verify=_verify(ws), timeout=timeout) as cli:
        return await cli.request(method, _agent_target(ws, rest, query), content=body, headers=hdr)


async def agent_info(url, token, verify=True):
    """Identity and status of a remote Oxidized Manager (connection test)."""
    url = (url or "").rstrip("/")
    try:
        async with httpx.AsyncClient(verify=verify, timeout=15) as cli:
            r = await cli.get(f"{url}/api/agent/info",
                              headers={"Authorization": f"Bearer {token}", "X-Lang": current_lang()})
    except httpx.HTTPError as exc:
        return {"ok": False, "error": _("Could not connect: {err}", err=f"{exc.__class__.__name__} {exc}")}
    if r.status_code == 401:
        return {"ok": False, "error": _("The API key is invalid or has been revoked")}
    if r.status_code != 200:
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    try:
        data = r.json()
    except ValueError:
        return {"ok": False, "error": _("The response is not from an Oxidized Manager")}
    if not data.get("local"):
        return {"ok": False, "error": _("The remote server has no local (embedded) Oxidized workspace"), **data}
    return {"ok": True, **data}


class AgentProxyMiddleware:
    """Forwards /api/w/<agent-id>/... to the remote Oxidized Manager.

    Runs after :class:`perms.AccessMiddleware`, so the caller is already authorised for the
    workspace here; the remote side checks the API key again."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            m = _PATH_RE.match(scope["path"])
            if m and m.group(1) != settings.LOCAL_ID:
                ws = db.get_workspace(m.group(1))
                if ws and ws["type"] == "agent":
                    ident = (scope.get("state") or {}).get("identity")
                    user = ident.name if ident else None
                    rest, query = m.group(2) or "", scope.get("query_string", b"").decode()
                    if scope["type"] == "http":
                        return await self._http(ws, rest, query, user, scope, receive, send)
                    return await self._ws(ws, rest, query, user, scope, receive, send)
        return await self.app(scope, receive, send)

    async def _respond(self, send, status, body, ctype="application/json", extra=None):
        headers = [(b"content-type", ctype.encode()), (b"content-length", str(len(body)).encode())]
        headers += extra or []
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def _http(self, ws, rest, query, user, scope, receive, send):
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        in_headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        fwd = {k: in_headers[k] for k in ("content-type",) if k in in_headers}
        try:
            r = await agent_request(ws, scope["method"], rest, query, body or None, fwd, user)
        except httpx.HTTPError as exc:
            detail = _("Could not reach the remote workspace ({url}): {err}",
                       url=ws["config"].get("url"), err=f"{exc.__class__.__name__} {exc}")
            return await self._respond(send, 502, json.dumps({"detail": detail}).encode())
        if r.status_code == 401:
            detail = _("The remote workspace rejected the API key (it may have been revoked). "
                       "Enter a new key in the workspace settings.")
            return await self._respond(send, 502, json.dumps({"detail": detail}).encode())
        extra = []
        if "content-disposition" in r.headers:
            extra.append((b"content-disposition", r.headers["content-disposition"].encode()))
        await self._respond(send, r.status_code, r.content, r.headers.get("content-type", "application/octet-stream"), extra)

    async def _ws(self, ws, rest, query, user, scope, receive, send):
        client = WebSocket(scope, receive, send)
        await client.accept()
        from websockets.asyncio.client import connect  # websockets >= 14

        base = (ws["config"].get("url") or "").rstrip("/")
        url = re.sub(r"^http", "ws", base) + f"/api/w/{settings.LOCAL_ID}{rest}" + (f"?{query}" if query else "")
        ssl_ctx = None
        if url.startswith("wss://"):
            ssl_ctx = ssl.create_default_context()
            if not _verify(ws):
                ssl_ctx.check_hostname = False
                ssl_ctx.verify_mode = ssl.CERT_NONE
        headers = _agent_headers(ws, user)
        headers.pop("Accept", None)
        try:
            async with connect(url, additional_headers=headers, ssl=ssl_ctx, max_size=None) as remote:
                async def up():
                    while True:
                        msg = await client.receive_text()
                        await remote.send(msg)

                async def down():
                    async for msg in remote:
                        await client.send_text(msg if isinstance(msg, str) else msg.decode())

                tasks = [asyncio.create_task(up()), asyncio.create_task(down())]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in tasks:
                    t.cancel()
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                await client.send_text(json.dumps({"items": [{"t": "error", "d": _("Could not open the remote workspace stream: {err}", err=exc)}]}))
                await client.send_text(json.dumps({"end": True}))
            except Exception:  # noqa: BLE001
                pass
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
