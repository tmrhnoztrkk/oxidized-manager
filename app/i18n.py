"""Minimal i18n: English source strings, translated per request.

The request language comes from the ``X-Lang`` header (sent by the web UI), the ``oxmgr_lang``
cookie or ``Accept-Language``. Messages are written in English in the code and looked up in
``locales/<lang>.py`` (``MESSAGES`` dict); unknown strings fall back to English.
"""
import importlib
from contextvars import ContextVar

from . import settings

LANGS = ("en", "tr")
_lang: ContextVar[str] = ContextVar("lang", default=settings.DEFAULT_LANG)
_catalogs = {}


def _catalog(lang):
    if lang not in _catalogs:
        try:
            _catalogs[lang] = importlib.import_module(f".locales.{lang}", __package__).MESSAGES
        except (ImportError, AttributeError):
            _catalogs[lang] = {}
    return _catalogs[lang]


def current():
    return _lang.get()


def set_lang(lang):
    return _lang.set(lang if lang in LANGS else settings.DEFAULT_LANG)


def pick(headers):
    """Picks the language from request headers (dict with lower-case keys)."""
    lang = (headers.get("x-lang") or "").lower()[:2]
    if lang in LANGS:
        return lang
    for part in (headers.get("cookie") or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == "oxmgr_lang" and v[:2] in LANGS:
            return v[:2]
    for part in (headers.get("accept-language") or "").split(","):
        code = part.strip()[:2].lower()
        if code in LANGS:
            return code
    return settings.DEFAULT_LANG


def _(msg, **kw):
    lang = _lang.get()
    text = msg if lang == "en" else _catalog(lang).get(msg, msg)
    return text.format(**kw) if kw else text


class LangMiddleware:
    """Sets the language context variable for every HTTP / WebSocket request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            token = set_lang(pick(headers))
            try:
                return await self.app(scope, receive, send)
            finally:
                _lang.reset(token)
        return await self.app(scope, receive, send)
