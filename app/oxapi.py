"""Oxidized REST (oxidized-web) client."""
from urllib.parse import quote

import httpx

from .i18n import _


class OxidizedAPIError(Exception):
    pass


def node_group(node):
    """Group to use in /node/... URLs for an entry of /nodes.json.

    Oxidized reports ungrouped nodes with ``group: "default"`` but only finds them without a group
    (``full_name`` is just the name), so the group is taken from ``full_name`` when it is present."""
    full = node.get("full_name")
    if full:
        return full.rsplit("/", 1)[0] if "/" in full else None
    group = node.get("group")
    return None if group in (None, "", "default") else group


class OxidizedAPI:
    def __init__(self, api_cfg):
        self.base = (api_cfg.get("url") or "").rstrip("/")
        self.auth = (api_cfg["username"], api_cfg.get("password") or "") if api_cfg.get("username") else None
        self.verify = bool(api_cfg.get("verify_tls", True))
        self.timeout = float(api_cfg.get("timeout") or 20)

    @property
    def configured(self):
        return bool(self.base)

    async def _req(self, method, path, params=None, data=None, json_body=None, expect="json", timeout=None):
        if not self.base:
            raise OxidizedAPIError(_("Oxidized API address is not set"))
        url = self.base + path
        try:
            async with httpx.AsyncClient(verify=self.verify, auth=self.auth,
                                         timeout=timeout or self.timeout, follow_redirects=False) as cli:
                resp = await cli.request(method, url, params=params, data=data, json=json_body,
                                         headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise OxidizedAPIError(_("Could not reach the Oxidized API ({url}): {err}", url=self.base, err=f"{exc.__class__.__name__} {exc}")) from exc
        if resp.status_code in (301, 302, 303):
            return "ok" if expect == "json" else ""
        if resp.status_code >= 400:
            raise OxidizedAPIError(f"Oxidized API {resp.status_code}: {resp.text[:300]}")
        if expect == "text":
            return resp.text
        try:
            return resp.json()
        except ValueError:
            return resp.text

    @staticmethod
    def _node_path(name, group=None):
        name = quote(name, safe="")
        if group:
            return quote(group, safe="") + "/" + name
        return name

    async def nodes(self):
        data = await self._req("GET", "/nodes.json")
        if not isinstance(data, list):
            raise OxidizedAPIError(_("Unexpected /nodes.json response"))
        return data

    async def node_show(self, name):
        data = await self._req("GET", f"/node/show/{quote(name, safe='')}.json")
        if not isinstance(data, dict):
            raise OxidizedAPIError(_("'{name}' not found in Oxidized", name=name))
        return data

    async def fetch(self, name, group=None):
        text = await self._req("GET", f"/node/fetch/{self._node_path(name, group)}", expect="text")
        if text.strip() in ("node not found", '"node not found"'):
            raise OxidizedAPIError(_("No config has been collected for this device yet (Oxidized: node not found)"))
        return text

    async def next(self, name, group=None):
        return await self._req("GET", f"/node/next/{self._node_path(name, group)}.json")

    async def reload(self):
        return await self._req("GET", "/reload.json")

    async def stats(self):
        return await self._req("GET", "/nodes/stats.json")

    async def versions(self, name, group=None):
        full = f"{group}/{name}" if group else name
        data = await self._req("GET", "/node/version.json", params={"node_full": full})
        if not isinstance(data, list):
            return []
        return [v for v in data if isinstance(v, dict)]  # "node not found" gibi metinleri at

    async def version_view(self, name, group, oid, epoch=None, num=None):
        params = {"node": name, "group": group or "", "oid": oid}
        if epoch is not None:
            params["epoch"] = epoch
            params["date"] = epoch
        if num is not None:
            params["num"] = num
        data = await self._req("GET", "/node/version/view.json", params=params)
        if isinstance(data, str):
            return data
        if isinstance(data, list):
            # oxidized-web returns the lines as a list, each with its own line ending
            return "\n".join(str(x).rstrip("\r\n") for x in data) + "\n"
        if isinstance(data, dict):
            for key in ("config", "text", "content", "data"):
                if isinstance(data.get(key), str):
                    return data[key]
        return str(data)

    async def conf_search(self, text):
        data = await self._req("POST", "/nodes/conf_search.json", data={"search_in_conf_textbox": text})
        return data if isinstance(data, list) else []
