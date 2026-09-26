"""SQLite persistence: users, workspaces, memberships, API tokens, backup destinations, audit log."""
import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time

from cryptography.fernet import Fernet, InvalidToken

from . import settings

_lock = threading.RLock()
_conn = sqlite3.connect(settings.DATA_DIR / "manager.db", check_same_thread=False, isolation_level=None)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")
_conn.execute("PRAGMA foreign_keys=ON")
_conn.executescript("""
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',      -- admin | user
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,          -- local | agent | oxidized
  config TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,          -- viewer | operator | manager
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'full',   -- full | read
  created_by TEXT,
  created_at REAL NOT NULL,
  last_used REAL,
  last_ip TEXT
);
CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,          -- github | gitlab | gitea | git | git_ssh
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_min INTEGER NOT NULL DEFAULT 60,
  created_at REAL NOT NULL,
  last_run REAL,
  last_status TEXT,            -- ok | unchanged | error | running
  last_message TEXT,
  last_commit TEXT
);
CREATE TABLE IF NOT EXISTS destination_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id TEXT NOT NULL,
  started REAL NOT NULL,
  finished REAL,
  status TEXT NOT NULL,
  message TEXT,
  commit_sha TEXT,
  changed INTEGER NOT NULL DEFAULT 0,
  devices INTEGER NOT NULL DEFAULT 0,
  trigger TEXT
);
CREATE INDEX IF NOT EXISTS destination_runs_dest ON destination_runs(destination_id, id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  user TEXT,
  workspace TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
""")


def _migrate():
    """Adds columns introduced after v2 to existing databases."""
    cols = {r["name"] for r in _conn.execute("PRAGMA table_info(users)")}
    if "disabled" not in cols:
        _conn.execute("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")
    if "last_login" not in cols:
        _conn.execute("ALTER TABLE users ADD COLUMN last_login REAL")


_migrate()


def q(sql, args=(), one=False):
    with _lock:
        cur = _conn.execute(sql, args)
        rows = cur.fetchall()
    rows = [dict(r) for r in rows]
    return (rows[0] if rows else None) if one else rows


def x(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        return cur.lastrowid


# ------------------------------------------------------------------ encryption
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest()))


def encrypt(value):
    return "enc:" + _fernet.encrypt(value.encode()).decode() if value else ""


def decrypt(value):
    if not value or not str(value).startswith("enc:"):
        return value or ""
    try:
        return _fernet.decrypt(value[4:].encode()).decode()
    except InvalidToken:
        return ""


def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def check_password(pw, stored):
    try:
        _, salt, dk = stored.split("$")
        calc = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


# ------------------------------------------------------------------ users
USER_COLS = "id, username, role, disabled, created_at, last_login"


def user_count():
    return q("SELECT COUNT(*) AS n FROM users", one=True)["n"]


def create_user(username, password, role="user"):
    return x("INSERT INTO users(username, pw_hash, role, created_at) VALUES (?,?,?,?)",
             (username, hash_password(password), role, time.time()))


def authenticate(username, password):
    u = q("SELECT * FROM users WHERE username=?", (username,), one=True)
    if u and not u["disabled"] and check_password(password, u["pw_hash"]):
        x("UPDATE users SET last_login=? WHERE id=?", (time.time(), u["id"]))
        return u
    return None


def get_user(username=None, uid=None):
    if uid is not None:
        return q(f"SELECT {USER_COLS} FROM users WHERE id=?", (uid,), one=True)
    return q(f"SELECT {USER_COLS} FROM users WHERE username=?", (username,), one=True)


def list_users():
    return q(f"SELECT {USER_COLS} FROM users ORDER BY username COLLATE NOCASE")


def update_user(uid, role=None, disabled=None):
    if role is not None:
        x("UPDATE users SET role=? WHERE id=?", (role, uid))
    if disabled is not None:
        x("UPDATE users SET disabled=? WHERE id=?", (1 if disabled else 0, uid))


def set_password(uid, password):
    x("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(password), uid))


def delete_user(uid):
    with _lock:
        x("DELETE FROM members WHERE user_id=?", (uid,))
        x("DELETE FROM users WHERE id=?", (uid,))


def admin_count(active_only=True):
    sql = "SELECT COUNT(*) AS n FROM users WHERE role='admin'" + (" AND disabled=0" if active_only else "")
    return q(sql, one=True)["n"]


# ------------------------------------------------------------------ memberships
ROLES = ("viewer", "operator", "manager")


def member_role(wid, uid):
    r = q("SELECT role FROM members WHERE workspace_id=? AND user_id=?", (wid, uid), one=True)
    return r["role"] if r else None


def members_of(wid):
    return q("""SELECT m.user_id, m.role, u.username, u.role AS user_role, u.disabled
                FROM members m JOIN users u ON u.id = m.user_id
                WHERE m.workspace_id=? ORDER BY u.username COLLATE NOCASE""", (wid,))


def memberships_of(uid):
    return {r["workspace_id"]: r["role"] for r in q("SELECT workspace_id, role FROM members WHERE user_id=?", (uid,))}


def all_memberships():
    out = {}
    for r in q("SELECT workspace_id, user_id, role FROM members"):
        out.setdefault(r["user_id"], {})[r["workspace_id"]] = r["role"]
    return out


def member_counts():
    return {r["workspace_id"]: r["n"] for r in q("SELECT workspace_id, COUNT(*) AS n FROM members GROUP BY workspace_id")}


def set_member(wid, uid, role):
    if role:
        x("INSERT INTO members(workspace_id, user_id, role) VALUES (?,?,?) "
          "ON CONFLICT(workspace_id, user_id) DO UPDATE SET role=excluded.role", (wid, uid, role))
    else:
        x("DELETE FROM members WHERE workspace_id=? AND user_id=?", (wid, uid))


# ------------------------------------------------------------------ workspaces
SECRET_CFG = ("token", "password")


def _ws_row(r, reveal=False):
    cfg = json.loads(r["config"] or "{}")
    for k in SECRET_CFG:
        if k in cfg:
            if reveal:
                cfg[k] = decrypt(cfg[k])
            else:
                cfg["has_" + k] = bool(cfg[k])
                cfg[k] = ""
    return {"id": r["id"], "name": r["name"], "type": r["type"], "config": cfg,
            "sort": r["sort"], "created_at": r["created_at"]}


def list_workspaces(reveal=False):
    return [_ws_row(r, reveal) for r in q("SELECT * FROM workspaces ORDER BY sort, created_at")]


def get_workspace(wid, reveal=True):
    r = q("SELECT * FROM workspaces WHERE id=?", (wid,), one=True)
    return _ws_row(r, reveal) if r else None


def remote_count():
    return q("SELECT COUNT(*) AS n FROM workspaces WHERE type != 'local'", one=True)["n"]


def _merge_secrets(cfg, old, keys):
    cfg = dict(cfg or {})
    for k in keys:
        if k in cfg:
            if cfg[k]:
                cfg[k] = encrypt(cfg[k])
            else:
                cfg[k] = old.get(k, "")  # empty → keep the stored value
        elif k in old:
            cfg[k] = old[k]
        cfg.pop("has_" + k, None)
    return cfg


def save_workspace(wid, name, type_, config, existing=None):
    old = json.loads(existing["config_raw"]) if existing else {}
    cfg = _merge_secrets(config, old, SECRET_CFG)
    if existing:
        x("UPDATE workspaces SET name=?, config=? WHERE id=?", (name, json.dumps(cfg), wid))
    else:
        n = q("SELECT COUNT(*) AS n FROM workspaces", one=True)["n"]
        x("INSERT INTO workspaces(id, name, type, config, sort, created_at) VALUES (?,?,?,?,?,?)",
          (wid, name, type_, json.dumps(cfg), n, time.time()))


def raw_workspace(wid):
    r = q("SELECT * FROM workspaces WHERE id=?", (wid,), one=True)
    if r:
        r["config_raw"] = r["config"]
    return r


def delete_workspace(wid):
    with _lock:
        for d in q("SELECT id FROM destinations WHERE workspace_id=?", (wid,)):
            delete_destination(d["id"])
        x("DELETE FROM members WHERE workspace_id=?", (wid,))
        x("DELETE FROM workspaces WHERE id=?", (wid,))


# ------------------------------------------------------------------ API tokens
TOKEN_PREFIX = "oxm_"


def _token_hash(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


def create_token(name, scope, user):
    tok = TOKEN_PREFIX + secrets.token_urlsafe(32)
    x("INSERT INTO tokens(name, prefix, hash, scope, created_by, created_at) VALUES (?,?,?,?,?,?)",
      (name, tok[:10], _token_hash(tok), scope, user, time.time()))
    return tok


def check_token(tok, ip=None):
    if not tok or not tok.startswith(TOKEN_PREFIX):
        return None
    r = q("SELECT * FROM tokens WHERE hash=?", (_token_hash(tok),), one=True)
    if r:
        x("UPDATE tokens SET last_used=?, last_ip=? WHERE id=?", (time.time(), ip, r["id"]))
    return r


def list_tokens():
    return q("SELECT id, name, prefix, scope, created_by, created_at, last_used, last_ip FROM tokens ORDER BY id DESC")


def delete_token(tid):
    x("DELETE FROM tokens WHERE id=?", (tid,))


# ------------------------------------------------------------------ backup destinations
DEST_SECRETS = ("token", "password", "ssh_key")
DEST_COLS = ("id, workspace_id, name, type, config, enabled, interval_min, created_at, "
             "last_run, last_status, last_message, last_commit")


def _dest_row(r, reveal=False):
    cfg = json.loads(r["config"] or "{}")
    for k in DEST_SECRETS:
        if k in cfg:
            if reveal:
                cfg[k] = decrypt(cfg[k])
            else:
                cfg["has_" + k] = bool(cfg[k])
                cfg.pop(k)
    out = dict(r)
    out["config"] = cfg
    out["enabled"] = bool(r["enabled"])
    return out


def list_destinations(wid=None, reveal=False):
    if wid:
        rows = q(f"SELECT {DEST_COLS} FROM destinations WHERE workspace_id=? ORDER BY created_at", (wid,))
    else:
        rows = q(f"SELECT {DEST_COLS} FROM destinations ORDER BY created_at")
    return [_dest_row(r, reveal) for r in rows]


def get_destination(did, reveal=True):
    r = q(f"SELECT {DEST_COLS} FROM destinations WHERE id=?", (did,), one=True)
    return _dest_row(r, reveal) if r else None


def save_destination(did, wid, name, type_, config, enabled, interval_min, existing=False):
    old = {}
    if existing:
        row = q("SELECT config FROM destinations WHERE id=?", (did,), one=True)
        old = json.loads(row["config"]) if row else {}
    cfg = _merge_secrets(config, old, DEST_SECRETS)
    if existing:
        x("UPDATE destinations SET name=?, type=?, config=?, enabled=?, interval_min=? WHERE id=?",
          (name, type_, json.dumps(cfg), 1 if enabled else 0, interval_min, did))
    else:
        x("INSERT INTO destinations(id, workspace_id, name, type, config, enabled, interval_min, created_at) "
          "VALUES (?,?,?,?,?,?,?,?)", (did, wid, name, type_, json.dumps(cfg), 1 if enabled else 0,
                                       interval_min, time.time()))


def delete_destination(did):
    with _lock:
        x("DELETE FROM destination_runs WHERE destination_id=?", (did,))
        x("DELETE FROM destinations WHERE id=?", (did,))


def start_run(did, trigger):
    now = time.time()
    x("UPDATE destinations SET last_status='running' WHERE id=?", (did,))
    return x("INSERT INTO destination_runs(destination_id, started, status, trigger) VALUES (?,?,?,?)",
             (did, now, "running", trigger))


def finish_run(run_id, did, status, message, commit=None, changed=0, devices=0):
    now = time.time()
    x("UPDATE destination_runs SET finished=?, status=?, message=?, commit_sha=?, changed=?, devices=? WHERE id=?",
      (now, status, message, commit, changed, devices, run_id))
    if commit:
        x("UPDATE destinations SET last_run=?, last_status=?, last_message=?, last_commit=? WHERE id=?",
          (now, status, message, commit, did))
    else:
        x("UPDATE destinations SET last_run=?, last_status=?, last_message=? WHERE id=?",
          (now, status, message, did))
    # keep the last 200 runs per destination
    x("DELETE FROM destination_runs WHERE destination_id=? AND id NOT IN "
      "(SELECT id FROM destination_runs WHERE destination_id=? ORDER BY id DESC LIMIT 200)", (did, did))


def list_runs(did, limit=50):
    return q("SELECT * FROM destination_runs WHERE destination_id=? ORDER BY id DESC LIMIT ?", (did, limit))


def reset_running():
    """Marks runs interrupted by a restart as failed."""
    x("UPDATE destination_runs SET status='error', message='interrupted', finished=? WHERE status='running'",
      (time.time(),))
    x("UPDATE destinations SET last_status='error' WHERE last_status='running'")


# ------------------------------------------------------------------ audit log
def audit(user, action, workspace=None, target=None, detail=None):
    x("INSERT INTO audit(ts, user, workspace, action, target, detail) VALUES (?,?,?,?,?,?)",
      (time.time(), user, workspace, action, target,
       json.dumps(detail, ensure_ascii=False) if detail is not None else None))


def read_audit(limit=500, workspace=None, workspaces=None):
    if workspace:
        rows = q("SELECT * FROM audit WHERE workspace=? ORDER BY id DESC LIMIT ?", (workspace, limit))
    elif workspaces is not None:
        if not workspaces:
            return []
        marks = ",".join("?" * len(workspaces))
        rows = q(f"SELECT * FROM audit WHERE workspace IN ({marks}) ORDER BY id DESC LIMIT ?", (*workspaces, limit))
    else:
        rows = q("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        if r["detail"]:
            try:
                r["detail"] = json.loads(r["detail"])
            except ValueError:
                pass
    return rows
