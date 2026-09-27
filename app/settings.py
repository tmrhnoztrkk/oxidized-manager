"""Application settings read from environment variables."""
import os
import secrets
import shutil
from pathlib import Path

VERSION = "3.0.1"

DATA_DIR = Path(os.getenv("DATA_DIR", "/data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

SESSION_HOURS = int(os.getenv("SESSION_HOURS", "12"))
# Send the session cookie over HTTPS only (enable when running behind a TLS reverse proxy)
SECURE_COOKIES = os.getenv("SECURE_COOKIES", "false").lower() in ("1", "true", "yes")

# One installation can run at most one embedded Oxidized and manage this many remote ones
MAX_REMOTE_WORKSPACES = int(os.getenv("MAX_REMOTE_WORKSPACES", "10"))

# Default UI / API language when the browser does not say otherwise (en | tr)
DEFAULT_LANG = os.getenv("DEFAULT_LANG", "en")


def _secret_key():
    env = os.getenv("SECRET_KEY")
    if env:
        return env
    path = DATA_DIR / ".secret_key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    path.write_text(key)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return key


SECRET_KEY = _secret_key()

# Embedded Oxidized
OXIDIZED_BIN = os.getenv("OXIDIZED_BIN") or shutil.which("oxidized") or "oxidized"
OXIDIZED_REST_PORT = int(os.getenv("OXIDIZED_REST_PORT", "8888"))
OXIDIZED_AUTOSTART = os.getenv("OXIDIZED_AUTOSTART", "true").lower() in ("1", "true", "yes")

# Backup destinations (git push targets)
GIT_BIN = os.getenv("GIT_BIN") or shutil.which("git") or "git"
BACKUP_SCHEDULER = os.getenv("BACKUP_SCHEDULER", "true").lower() in ("1", "true", "yes")

LOCAL_ID = "local"
WORKSPACES_DIR = DATA_DIR / "workspaces"
DESTINATIONS_DIR = DATA_DIR / "destinations"


def local_home():
    return WORKSPACES_DIR / LOCAL_ID / "oxidized"
