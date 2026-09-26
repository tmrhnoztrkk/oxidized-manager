"""Oxidized Manager — FastAPI application.

One container runs the web UI + API, optionally one embedded Oxidized (the "local" workspace)
and manages up to MAX_REMOTE_WORKSPACES remote Oxidized installations. Remote workspaces are
reached over HTTPS with an API key (see workspace.py); backup destinations push the collected
configs to external git repositories (see backup.py).
"""
import asyncio
import contextlib
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import backup, db, settings
from .files import FilesError
from .i18n import LangMiddleware
from .oxapi import OxidizedAPIError
from .oxconfig import ConfigError
from .perms import AccessMiddleware
from .routerdb import RouterDBError
from .routes_admin import router as admin_router
from .routes_backup import router as backup_router
from .routes_ws import router as ws_router
from .supervisor import local_supervisor
from .workspace import AgentProxyMiddleware

STATIC = Path(__file__).resolve().parent.parent / "static"


@contextlib.asynccontextmanager
async def lifespan(_app):
    if db.get_workspace(settings.LOCAL_ID) and settings.OXIDIZED_AUTOSTART:
        await asyncio.to_thread(local_supervisor().start)
    sched = asyncio.create_task(backup.scheduler()) if settings.BACKUP_SCHEDULER else None
    yield
    if sched:
        sched.cancel()
    sup = local_supervisor()
    if sup.proc:
        await asyncio.to_thread(sup.stop)


app = FastAPI(title="Oxidized Manager", version=settings.VERSION, lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None)
# Order matters — the last one added runs first:
#   Session → Lang → Access (identity + workspace permissions) → remote proxy → routes
app.add_middleware(AgentProxyMiddleware)
app.add_middleware(AccessMiddleware)
app.add_middleware(LangMiddleware)
app.add_middleware(SessionMiddleware, secret_key=settings.SECRET_KEY, session_cookie="oxmgr",
                   max_age=settings.SESSION_HOURS * 3600, same_site="lax", https_only=settings.SECURE_COOKIES)


@app.exception_handler(FilesError)
@app.exception_handler(OxidizedAPIError)
@app.exception_handler(ConfigError)
@app.exception_handler(RouterDBError)
async def _known_errors(_req, exc):
    code = 400 if isinstance(exc, (ConfigError, RouterDBError)) else 502
    return JSONResponse({"detail": str(exc)}, status_code=code)


app.include_router(admin_router)
app.include_router(backup_router)
app.include_router(ws_router)

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
