"""Backup destinations: push the configs Oxidized collected to external git repositories.

Works the same for every workspace type — the manager pulls the latest config of every device
from the workspace (embedded Oxidized, remote Oxidized Manager or plain Oxidized REST API),
writes them into a local clone of the destination repository and pushes one commit per run.

Supported providers: GitHub (incl. Enterprise), GitLab, Gitea/Forgejo, any git server over
HTTPS (username + password/token) and any git server over SSH (deploy key).
Credentials never touch disk in plain text: HTTPS auth is passed through GIT_CONFIG_* env
variables, SSH keys are written to a temporary 0600 file for the duration of a run.
"""
import asyncio
import base64
import contextlib
import csv
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import db, settings
from .i18n import _
from .oxapi import OxidizedAPIError, node_group

PROVIDERS = ("github", "gitlab", "gitea", "git", "git_ssh")
LAYOUTS = ("group", "flat")
MANIFEST = ".oxidized-manager.json"
GIT_TIMEOUT = 300
FETCH_CONCURRENCY = 8

# Basic-auth user names the hosted providers accept together with a token as the password
TOKEN_USERS = {"github": "x-access-token", "gitlab": "oauth2", "gitea": "oauth2"}
DEFAULT_SERVERS = {"github": "https://github.com", "gitlab": "https://gitlab.com"}


class BackupError(Exception):
    pass


# ====================================================================== configuration
def _slug(text):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(text or "")).strip("-.")
    return s or "workspace"


def _clean_path(p):
    parts = [x for x in re.split(r"[\\/]+", str(p or "").strip()) if x not in ("", ".")]
    if any(x == ".." for x in parts):
        raise BackupError(_("The folder must not contain '..'"))
    return "/".join(_slug(x) for x in parts)


def normalize(type_, cfg, workspace_name=""):
    """Validates and normalises destination settings coming from the UI."""
    if type_ not in PROVIDERS:
        raise BackupError(_("Unknown destination type"))
    c = {k: (v.strip() if isinstance(v, str) else v) for k, v in (cfg or {}).items()}
    out = {
        "branch": c.get("branch") or "main",
        "path": _clean_path(c["path"]) if c.get("path") not in (None,) else _slug(workspace_name),
        "layout": c.get("layout") if c.get("layout") in LAYOUTS else "group",
        "author_name": c.get("author_name") or "Oxidized Manager",
        "author_email": c.get("author_email") or "oxidized-manager@localhost",
        "prune": c.get("prune", True) is not False,
        "inventory": c.get("inventory", True) is not False,
        "verify_tls": c.get("verify_tls", True) is not False,
    }
    if not re.match(r"^[A-Za-z0-9._/-]+$", out["branch"]) or ".." in out["branch"]:
        raise BackupError(_("Invalid branch name"))
    if type_ in ("github", "gitlab", "gitea"):
        server = (c.get("server") or DEFAULT_SERVERS.get(type_) or "").rstrip("/")
        if not re.match(r"^https?://[^/\s]+(/[^\s]*)?$", server):
            raise BackupError(_("Enter the server address, e.g. https://git.example.com"))
        repo = re.sub(r"\.git$", "", (c.get("repo") or "").strip("/"))
        m = re.match(r"^https?://[^/]+/(.+)$", repo)
        if m:
            repo = m.group(1)
        if not re.match(r"^[\w.-]+(/[\w.-]+)+$", repo):
            raise BackupError(_("Repository must look like owner/name"))
        out.update(server=server, repo=repo, token=c.get("token", ""))
        if type_ == "gitea":
            out["username"] = c.get("username") or ""
    elif type_ == "git":
        url = c.get("url") or ""
        if not re.match(r"^https?://\S+$", url):
            raise BackupError(_("Enter an HTTPS repository URL, e.g. https://git.example.com/team/backups.git"))
        out.update(url=url, username=c.get("username") or "", password=c.get("password", ""))
    else:  # git_ssh
        url = c.get("url") or ""
        if not (re.match(r"^[\w.-]+@[\w.-]+:\S+$", url) or url.startswith("ssh://")):
            raise BackupError(_("Enter an SSH repository URL, e.g. git@github.com:owner/repo.git"))
        out["url"] = url
        key = c.get("ssh_key", "")
        if c.get("ssh_key_sealed"):
            key = db.decrypt(c["ssh_key_sealed"])
            if not key:
                raise BackupError(_("The generated key could not be read; generate a new one"))
        if key:
            out["ssh_public_key"] = public_key_of(key)
        elif c.get("ssh_public_key"):
            out["ssh_public_key"] = c["ssh_public_key"]
        out["ssh_key"] = key
    return out


def clone_url(type_, cfg):
    if type_ in ("github", "gitlab", "gitea"):
        return f"{cfg['server']}/{cfg['repo']}.git"
    return cfg["url"]


def web_url(type_, cfg, commit=None):
    """Browser link to the repository (or a commit) for the UI."""
    if type_ in ("github", "gitlab", "gitea"):
        base = f"{cfg['server']}/{cfg['repo']}"
        if commit:
            return f"{base}/-/commit/{commit}" if type_ == "gitlab" else f"{base}/commit/{commit}"
        return f"{base}/tree/{cfg.get('branch') or 'main'}" if type_ != "gitlab" else f"{base}/-/tree/{cfg.get('branch') or 'main'}"
    return None


def describe(type_, cfg):
    if type_ in ("github", "gitlab", "gitea"):
        return f"{cfg.get('repo', '')}"
    return cfg.get("url", "")


# ====================================================================== SSH keys
def generate_key(comment="oxidized-manager"):
    k = Ed25519PrivateKey.generate()
    priv = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                           serialization.NoEncryption()).decode()
    pub = k.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    return priv, f"{pub} {comment}"


def public_key_of(private_pem):
    try:
        key = serialization.load_ssh_private_key(private_pem.strip().encode() + b"\n", password=None)
    except (ValueError, TypeError) as exc:
        raise BackupError(_("The SSH private key could not be read (it must be unencrypted OpenSSH/PEM): {err}", err=exc)) from exc
    return key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()


# ====================================================================== git plumbing
class Git:
    """Runs git with the destination's credentials in the environment."""

    def __init__(self, type_, cfg, cwd=None):
        self.type = type_
        self.cfg = cfg
        self.cwd = cwd
        self._tmp = None
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": tempfile.gettempdir(),
            "LANG": "C", "LC_ALL": "C",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_ASKPASS": "/bin/false", "SSH_ASKPASS": "/bin/false",
        }

    def __enter__(self):
        extra = []
        if self.type == "git_ssh":
            key = self.cfg.get("ssh_key") or ""
            if not key:
                raise BackupError(_("No SSH private key configured"))
            self._tmp = tempfile.mkdtemp(prefix="oxm-ssh-")
            kp = Path(self._tmp) / "id"
            fd = os.open(kp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(key.strip() + "\n")
            kh = Path(self._tmp) / "known_hosts"
            stored = self.cfg.get("known_hosts") or ""
            kh.write_text(stored)
            self.known_hosts = kh
            self.env["GIT_SSH_COMMAND"] = (
                f"ssh -i {kp} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 "
                f"-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={kh}")
        else:
            user, secret = self._http_auth()
            if secret:
                basic = base64.b64encode(f"{user}:{secret}".encode()).decode()
                extra.append(("http.extraHeader", f"Authorization: Basic {basic}"))
            if not self.cfg.get("verify_tls", True):
                extra.append(("http.sslVerify", "false"))
        extra += [("user.name", self.cfg.get("author_name") or "Oxidized Manager"),
                  ("user.email", self.cfg.get("author_email") or "oxidized-manager@localhost"),
                  ("init.defaultBranch", self.cfg.get("branch") or "main"),
                  ("core.autocrlf", "false"), ("advice.detachedHead", "false")]
        self.env["GIT_CONFIG_COUNT"] = str(len(extra))
        for i, (k, v) in enumerate(extra):
            self.env[f"GIT_CONFIG_KEY_{i}"] = k
            self.env[f"GIT_CONFIG_VALUE_{i}"] = v
        return self

    def __exit__(self, *exc):
        if self._tmp:
            shutil.rmtree(self._tmp, ignore_errors=True)

    def learned_known_hosts(self):
        with contextlib.suppress(OSError, AttributeError):
            return self.known_hosts.read_text()
        return ""

    def _http_auth(self):
        if self.type == "git":
            return self.cfg.get("username") or "git", self.cfg.get("password") or ""
        user = self.cfg.get("username") or TOKEN_USERS.get(self.type, "git")
        return user, self.cfg.get("token") or ""

    def run(self, *args, check=True, cwd=None, timeout=GIT_TIMEOUT):
        try:
            p = subprocess.run([settings.GIT_BIN, *args], cwd=cwd or self.cwd, env=self.env,
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise BackupError(_("git {cmd} timed out", cmd=args[0])) from exc
        except OSError as exc:
            raise BackupError(_("git could not be run: {err}", err=exc)) from exc
        if check and p.returncode != 0:
            raise BackupError(explain(p.stderr or p.stdout, args[0]))
        return p


def explain(output, cmd=""):
    """Turns common git/HTTP/SSH failures into an actionable message."""
    out = (output or "").strip()
    low = out.lower()
    hint = None
    if any(s in low for s in ("authentication failed", "invalid username or password", "401", "could not read username",
                              "terminal prompts disabled", "bad credentials")):
        hint = _("Authentication failed — check the token / password and that it has not expired.")
    elif any(s in low for s in ("403", "write access to repository not granted", "permission to", "denied to",
                                "you are not allowed to push", "marked as read only", "read-only")):
        hint = _("The credentials can read but not write — give the token 'Contents: Read and write' "
                 "(GitHub) / 'write_repository' (GitLab), or enable 'Allow write access' on the deploy key.")
    elif "permission denied (publickey" in low:
        hint = _("The SSH key was rejected — add the public key to the repository as a deploy key with write access.")
    elif "repository not found" in low or "not found" in low and "404" in low or "does not appear to be a git repository" in low:
        hint = _("Repository not found — check the owner/name, and that the token can access this repository.")
    elif "could not resolve host" in low or "name or service not known" in low:
        hint = _("The server name could not be resolved (DNS).")
    elif "connection refused" in low or "timed out" in low or "couldn't connect" in low:
        hint = _("The git server could not be reached (firewall / proxy / port).")
    elif "ssl certificate" in low or "certificate verify failed" in low or "self-signed" in low:
        hint = _("TLS certificate is not trusted — install a valid certificate or disable TLS verification for this destination.")
    elif "host key verification failed" in low:
        hint = _("The server's SSH host key changed — remove and re-add the destination if this is expected.")
    lines = [ln for ln in out.splitlines() if ln.strip() and "Authorization" not in ln][-6:]
    detail = " | ".join(lines)[:600]
    return f"{hint} ({detail})" if hint and detail else (hint or detail or _("git {cmd} failed", cmd=cmd))


def check_access(type_, cfg):
    """Verifies that the destination is reachable and writable (git push --dry-run of a scratch branch)."""
    url = clone_url(type_, cfg)
    branch = cfg.get("branch") or "main"
    with tempfile.TemporaryDirectory(prefix="oxm-test-") as tmp, Git(type_, cfg, cwd=tmp) as g:
        heads = g.run("ls-remote", "--heads", url, timeout=60).stdout
        exists = f"refs/heads/{branch}" in heads
        g.run("init", "-q")
        g.run("commit", "-q", "--allow-empty", "-m", "oxidized-manager access test")
        p = g.run("push", "--dry-run", "--porcelain", url, "HEAD:refs/heads/oxidized-manager-access-test",
                  check=False, timeout=90)
        if p.returncode != 0:
            raise BackupError(explain(p.stderr or p.stdout, "push"))
        return {"ok": True, "branch_exists": exists, "empty": not heads.strip(),
                "known_hosts": g.learned_known_hosts() if type_ == "git_ssh" else None}


# ====================================================================== collecting configs
def _node_file(node, layout):
    name = _slug(node["name"])
    group = node.get("group")
    if layout == "group" and group:
        return f"{_slug(group)}/{name}"
    return name


async def collect_local(ctx):
    """Latest stored config of every node, read through the Oxidized REST API of ``ctx``."""
    try:
        nodes = await ctx.api.nodes()
    except OxidizedAPIError as exc:
        raise BackupError(_("Oxidized API is not reachable: {err}", err=exc)) from exc
    sem = asyncio.Semaphore(FETCH_CONCURRENCY)
    errors = []

    async def one(n):
        group = node_group(n)
        item = {"name": n.get("name"), "group": group, "model": n.get("model"),
                "ip": n.get("ip"), "status": n.get("status"), "config": None}
        async with sem:
            try:
                item["config"] = await ctx.api.fetch(n.get("name"), group)
            except OxidizedAPIError as exc:
                if "node not found" not in str(exc):
                    errors.append(f"{n.get('name')}: {exc}")
        return item

    items = await asyncio.gather(*(one(n) for n in nodes if n.get("name")))
    return {"nodes": items, "errors": errors, "collected_at": time.time()}


async def collect(ws):
    """Collects the configs of a workspace (proxying to the remote manager for agent workspaces)."""
    from .workspace import Ctx, agent_request  # circular import guard
    if ws["type"] == "agent":
        import httpx
        try:
            r = await agent_request(ws, "GET", "/backup/bundle", timeout=600)
        except httpx.HTTPError as exc:
            raise BackupError(_("Could not reach the remote workspace ({url}): {err}",
                                url=ws["config"].get("url"), err=exc)) from exc
        if r.status_code != 200:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = r.text[:300]
            raise BackupError(f"HTTP {r.status_code}: {detail}")
        return r.json()
    return await collect_local(Ctx(ws))


# ====================================================================== sync
def _write_tree(base: Path, bundle, cfg, ws_name):
    """Writes the configs below ``base``; returns (written_names, pruned_names)."""
    base.mkdir(parents=True, exist_ok=True)
    mpath = base / MANIFEST
    manifest = {}
    with contextlib.suppress(OSError, ValueError):
        manifest = json.loads(mpath.read_text(encoding="utf-8")).get("files", {})
    layout = cfg.get("layout") or "group"
    present = {n["name"] for n in bundle["nodes"]}
    files = {}
    written = []
    for n in bundle["nodes"]:
        rel = _node_file(n, layout)
        if n.get("config") is None:
            if n["name"] in manifest:
                files[n["name"]] = manifest[n["name"]]  # keep the previous copy (fetch failed / not yet backed up)
            continue
        old_rel = manifest.get(n["name"])
        if old_rel and old_rel != rel:
            with contextlib.suppress(OSError):
                (base / old_rel).unlink()
        p = base / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        text = n["config"] if n["config"].endswith("\n") else n["config"] + "\n"
        if not p.exists() or p.read_text(encoding="utf-8", errors="replace") != text:
            p.write_text(text, encoding="utf-8", newline="")
            written.append(n["name"])
        files[n["name"]] = rel
    pruned = []
    if cfg.get("prune", True):
        for name, rel in manifest.items():
            if name not in present:
                with contextlib.suppress(OSError):
                    (base / rel).unlink()
                pruned.append(name)
    else:
        for name, rel in manifest.items():
            files.setdefault(name, rel)
    # drop empty folders left behind
    for d in sorted((p for p in base.rglob("*") if p.is_dir() and ".git" not in p.parts), key=lambda p: -len(p.parts)):
        with contextlib.suppress(OSError):
            d.rmdir()
    if cfg.get("inventory", True):
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["name", "ip", "model", "group", "file"])
        for n in sorted(bundle["nodes"], key=lambda x: x["name"]):
            w.writerow([n["name"], (n.get("ip") or "").split("/")[0], n.get("model") or "", n.get("group") or "",
                        files.get(n["name"], "")])
        (base / "devices.csv").write_text(buf.getvalue(), encoding="utf-8")
    mpath.write_text(json.dumps({"workspace": ws_name, "files": dict(sorted(files.items()))},
                                indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return written, pruned


def sync(dest, bundle, ws_name):
    """Commits ``bundle`` into the destination repository and pushes it. Runs in a worker thread."""
    type_, cfg = dest["type"], dest["config"]
    branch = cfg.get("branch") or "main"
    url = clone_url(type_, cfg)
    if not [n for n in bundle["nodes"] if n.get("config") is not None]:
        raise BackupError(_("No device configs were collected (has Oxidized backed up any device yet?) — "
                            "nothing was pushed."))
    root = settings.DESTINATIONS_DIR / dest["id"]
    repo = root / "repo"
    last_err = None
    for attempt in range(2):
        with Git(type_, cfg, cwd=repo) as g:
            heads = _ls_remote(g, url, root)
            exists = f"refs/heads/{branch}" in heads
            if not (repo / ".git").exists() or not exists:
                shutil.rmtree(repo, ignore_errors=True)
                repo.mkdir(parents=True, exist_ok=True)
                g.run("init", "-q", "-b", branch)
                g.run("remote", "add", "origin", url)
            else:
                g.run("remote", "set-url", "origin", url)
            if exists:
                g.run("fetch", "-q", "--depth", "1", "origin", f"refs/heads/{branch}")
                g.run("checkout", "-q", "-B", branch, "FETCH_HEAD")
                g.run("reset", "-q", "--hard", "FETCH_HEAD")
                g.run("clean", "-qfd")
            base = repo / cfg["path"] if cfg.get("path") else repo
            written, pruned = _write_tree(base, bundle, cfg, ws_name)
            g.run("add", "-A", "--", ".")
            if g.run("diff", "--cached", "--quiet", check=False).returncode == 0:
                return {"status": "unchanged", "commit": None, "changed": 0,
                        "message": _("No config changes since the last push"), "known_hosts": g.learned_known_hosts()}
            changed = [ln[3:] for ln in g.run("status", "--porcelain").stdout.splitlines() if ln.strip()]
            dev = sorted(set(written) | set(pruned))
            title = (f"Update {len(dev)} device config(s): {', '.join(dev[:5])}{' …' if len(dev) > 5 else ''}"
                     if dev else "Update device inventory")
            body = f"Workspace: {ws_name}\nFiles: {len(changed)}\n\n" + "\n".join(f"- {c}" for c in changed[:200])
            if pruned:
                body += "\n\nRemoved devices: " + ", ".join(pruned)
            g.run("commit", "-q", "-m", title, "-m", body + "\n\nPushed by Oxidized Manager")
            sha = g.run("rev-parse", "HEAD").stdout.strip()
            p = g.run("push", "-q", "origin", f"HEAD:refs/heads/{branch}", check=False)
            if p.returncode == 0:
                return {"status": "ok", "commit": sha, "changed": len(dev),
                        "message": title, "known_hosts": g.learned_known_hosts()}
            last_err = explain(p.stderr or p.stdout, "push")
            if "rejected" not in (p.stderr or "") and "fetch first" not in (p.stderr or ""):
                raise BackupError(last_err)
            # someone else pushed in the meantime → start over from the new remote head
    raise BackupError(last_err or _("git push failed"))


def _ls_remote(g, url, root):
    root.mkdir(parents=True, exist_ok=True)
    return g.run("ls-remote", "--heads", url, cwd=str(root), timeout=90).stdout


# ====================================================================== runner / scheduler
_running: dict[str, asyncio.Task] = {}


def is_running(did):
    t = _running.get(did)
    return bool(t and not t.done())


async def run_destination(did, trigger="manual"):
    dest = db.get_destination(did)
    if not dest:
        raise BackupError(_("Destination not found"))
    ws = db.get_workspace(dest["workspace_id"])
    if not ws:
        raise BackupError(_("Workspace not found"))
    run_id = db.start_run(did, trigger)
    devices = 0
    try:
        bundle = await collect(ws)
        devices = sum(1 for n in bundle["nodes"] if n.get("config") is not None)
        res = await asyncio.to_thread(sync, dest, bundle, ws["name"])
        msg = res["message"]
        if bundle.get("errors"):
            msg += " · " + _("{n} device(s) could not be read", n=len(bundle["errors"]))
        db.finish_run(run_id, did, res["status"], msg, res["commit"], res["changed"], devices)
        if dest["type"] == "git_ssh" and res.get("known_hosts") and res["known_hosts"] != dest["config"].get("known_hosts"):
            _store_known_hosts(dest, res["known_hosts"])
        return {**res, "devices": devices}
    except BackupError as exc:
        db.finish_run(run_id, did, "error", str(exc), devices=devices)
        return {"status": "error", "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 - never leave a run in 'running'
        db.finish_run(run_id, did, "error", f"{exc.__class__.__name__}: {exc}", devices=devices)
        return {"status": "error", "message": str(exc)}


def _store_known_hosts(dest, text):
    cfg = dict(dest["config"])
    cfg["known_hosts"] = text
    db.save_destination(dest["id"], dest["workspace_id"], dest["name"], dest["type"],
                        {k: v for k, v in cfg.items() if k not in db.DEST_SECRETS},
                        dest["enabled"], dest["interval_min"], existing=True)


def start(did, trigger="manual"):
    """Starts a run in the background unless one is already running."""
    if is_running(did):
        return False
    _running[did] = asyncio.create_task(run_destination(did, trigger))
    return True


async def scheduler():
    db.reset_running()
    while True:
        try:
            now = time.time()
            for d in db.list_destinations():
                if not d["enabled"] or not d["interval_min"] or is_running(d["id"]):
                    continue
                if d["last_run"] is None or now - d["last_run"] >= d["interval_min"] * 60:
                    start(d["id"], "schedule")
        except Exception as exc:  # noqa: BLE001
            print(f"[backup] scheduler error: {exc}", flush=True)
        await asyncio.sleep(30)


def new_id():
    return uuid.uuid4().hex[:10]
