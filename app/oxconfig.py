"""Oxidized config (YAML) — edited while preserving comments and !ruby/regexp tags."""
import io

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

from .i18n import _
from .routerdb import NODE_ATTRS, Schema

DEFAULT_HOME = "/home/oxidized/.config/oxidized"

# Global settings editable from the UI (path → type)
SETTINGS = {
    "username": str, "password": str, "model": str, "interval": int, "timeout": int, "retries": int,
    "threads": int, "use_max_threads": bool, "resolve_dns": bool, "debug": bool, "use_syslog": bool,
    "next_adds_job": bool,
    "input.default": str, "input.debug": bool, "input.ssh.secure": bool,
    "input.utf8_encoded": bool,
    "output.default": str, "output.git.user": str, "output.git.email": str,
    "output.git.single_repo": bool, "output.git.repo": str,
}
SECRET_SETTINGS = {"password"}


class ConfigError(ValueError):
    pass


def _yaml():
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 4096
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def load(text):
    try:
        doc = _yaml().load(text)
    except Exception as exc:  # noqa: BLE001
        raise ConfigError(_("YAML error: {err}", err=exc)) from exc
    if doc is None:
        doc = CommentedMap()
    if not isinstance(doc, dict):
        raise ConfigError(_("The config must be a YAML mapping"))
    return doc


def dump(doc):
    buf = io.StringIO()
    _yaml().dump(doc, buf)
    return buf.getvalue()


def validate_text(text):
    doc = load(text)
    warnings = []
    src = doc.get("source") or {}
    if (src.get("default") or "csv") == "csv":
        csv = src.get("csv") or {}
        if not csv.get("file"):
            warnings.append(_("source.csv.file is not set"))
        if "name" not in (csv.get("map") or {}):
            raise ConfigError(_("source.csv.map.name is required"))
    if not doc.get("rest") and not ((doc.get("extensions") or {}).get("oxidized-web")):
        warnings.append(_("The REST API (extensions.oxidized-web) is not enabled; the panel cannot read device status"))
    return doc, warnings


def _scalar(v):
    return getattr(v, "value", v)


def get_path(doc, path, default=None):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return _scalar(cur)


def set_path(doc, path, value):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        if part not in cur or not isinstance(cur[part], dict):
            cur[part] = CommentedMap()
        cur = cur[part]
    if value is None or value == "":
        cur.pop(parts[-1], None)
    else:
        cur[parts[-1]] = value


def coerce(path, value):
    typ = SETTINGS[path]
    if value is None or value == "":
        return None
    if typ is bool:
        return value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes", "on")
    if typ is int:
        return int(value)
    return str(value)


# ------------------------------------------------------------------ source
def rest_port(doc, default=8888):
    """oxidized-web port: extensions.oxidized-web.port or the legacy 'rest: host:port'."""
    port = get_path(doc, "extensions.oxidized-web.port")
    if port:
        return int(port)
    rest = str(doc.get("rest") or "")
    if ":" in rest:
        try:
            return int(rest.rsplit(":", 1)[1])
        except ValueError:
            pass
    return default


def schema_of(doc):
    csv = ((doc.get("source") or {}).get("csv")) or {}
    return Schema(csv.get("map"), csv.get("vars_map"), csv.get("delimiter"), _scalar(csv.get("file")))


def routerdb_rel(doc, container_home=DEFAULT_HOME):
    """Turns the router.db path from the config (container path) into a path relative to the Oxidized home."""
    f = str(schema_of(doc).file or "router.db")
    homes = [container_home.rstrip("/"), "~/.config/oxidized", DEFAULT_HOME]
    for h in homes:
        if h and f.startswith(h + "/"):
            return f[len(h) + 1:]
    if not f.startswith("/") and not f.startswith("~"):
        return f
    return f.rsplit("/", 1)[-1]


def fix_schema(doc, action):
    """Automatic fixes for schema issues."""
    csv = doc["source"]["csv"]
    csv.setdefault("vars_map", CommentedMap())
    if csv["vars_map"] is None:
        csv["vars_map"] = CommentedMap()
    m, vm = csv["map"], csv["vars_map"]
    if action.startswith("var_"):
        key = action[4:]
        if key in vm:
            m[key] = vm.pop(key)
        return
    if action.startswith("missing_"):
        key = action[8:]
        width = schema_of(doc).width
        if key in NODE_ATTRS:
            m[key] = width
        else:
            vm[key] = width
        return
    raise ConfigError(_("Unknown schema fix: {action}", action=action))


# ------------------------------------------------------------------ summary
def _groups_view(doc):
    out = {}
    for name, g in (doc.get("groups") or {}).items():
        g = g or {}
        vars_ = dict(g.get("vars") or {})
        view_vars = {}
        for k, v in vars_.items():
            if k == "enable":
                continue
            view_vars[k] = list(v) if isinstance(v, list) else _scalar(v)
        out[str(name)] = {
            "username": _scalar(g.get("username")),
            "has_password": bool(g.get("password")),
            "has_enable": bool(vars_.get("enable")),
            "model": _scalar(g.get("model")),
            "input": _scalar(g.get("input")),
            "vars": view_vars,
            "models": {str(k): {kk: ("***" if kk == "password" else _scalar(vv)) for kk, vv in (v or {}).items()}
                       for k, v in (g.get("models") or {}).items()},
        }
    return out


def summary(doc):
    schema = schema_of(doc)
    settings = {}
    for path in SETTINGS:
        if path in SECRET_SETTINGS:
            settings["has_" + path] = bool(get_path(doc, path))
        else:
            settings[path] = get_path(doc, path)
    hooks = []
    for name, h in (doc.get("hooks") or {}).items():
        h = h or {}
        hooks.append({"name": str(name), "type": _scalar(h.get("type")),
                      "events": list(h.get("events") or []), "remote_repo": _scalar(h.get("remote_repo"))})
    return {
        "settings": settings,
        "prompt": str(_scalar(doc.get("prompt")) or ""),
        "source": {
            "default": get_path(doc, "source.default"),
            "file": schema.file,
            "delimiter": schema.regex.pattern,
            "map": schema.map,
            "vars_map": schema.vars_map,
            "issues": schema.issues(),
        },
        "model_map": {str(k): str(_scalar(v)) for k, v in (doc.get("model_map") or {}).items()},
        "group_map": {str(k): str(_scalar(v)) for k, v in (doc.get("group_map") or {}).items()},
        "groups": _groups_view(doc),
        "hooks": hooks,
    }


# ------------------------------------------------------------------ groups
def upsert_group(doc, name, data, rename_from=None):
    if not name or any(c in name for c in " :/"):
        raise ConfigError(_("Group names cannot contain spaces, ':' or '/'"))
    groups = doc.get("groups")
    if groups is None:
        groups = doc["groups"] = CommentedMap()
    if rename_from and rename_from != name:
        if name in groups:
            raise ConfigError(_("Group '{name}' already exists", name=name))
        if rename_from in groups:
            groups[name] = groups.pop(rename_from)
    g = groups.get(name)
    if g is None:
        g = groups[name] = CommentedMap()
    for key in ("username", "model", "input"):
        if key in data:
            set_path(g, key, data[key] or None)
    if data.get("password"):
        g["password"] = data["password"]
    if data.get("clear_password"):
        g.pop("password", None)
    vars_ = g.get("vars")
    if vars_ is None:
        vars_ = CommentedMap()
    if data.get("enable"):
        vars_["enable"] = data["enable"]
    if data.get("clear_enable"):
        vars_.pop("enable", None)
    if "vars" in data:
        keep_enable = vars_.get("enable")
        for k in [k for k in vars_ if k != "enable"]:
            if k not in data["vars"]:
                vars_.pop(k)
        for k, v in (data["vars"] or {}).items():
            if k == "enable":
                continue
            if v in (None, "", []):
                vars_.pop(k, None)
            elif isinstance(v, list):
                seq = CommentedSeq(v)
                vars_[k] = seq
            else:
                vars_[k] = _typed(v)
        if keep_enable:
            vars_["enable"] = keep_enable
    if len(vars_):
        g["vars"] = vars_
    else:
        g.pop("vars", None)
    return g


def _typed(v):
    if isinstance(v, (int, bool)):
        return v
    s = str(v)
    if s.isdigit():
        return int(s)
    if s.lower() in ("true", "false"):
        return s.lower() == "true"
    return s


def delete_group(doc, name):
    groups = doc.get("groups") or {}
    if name not in groups:
        raise ConfigError(_("Group '{name}' does not exist", name=name))
    groups.pop(name)


def set_model_map(doc, mapping):
    mm = doc.get("model_map")
    if mm is None:
        mm = doc["model_map"] = CommentedMap()
    for k in list(mm):
        if k not in mapping:
            mm.pop(k)
    for k, v in mapping.items():
        if k and v:
            mm[k] = v
    if not len(mm):
        doc.pop("model_map", None)


# ------------------------------------------------------------------ new workspace setup
TEMPLATE = r"""---
# Generated by Oxidized Manager
username: admin
password: changeme
model: ios
resolve_dns: false
interval: 3600
use_syslog: false
debug: false
threads: 30
use_max_threads: true
timeout: 20
retries: 2
prompt: !ruby/regexp /^([\w.@:\/-]+[#>]\s?)$/
next_adds_job: false

extensions:
  oxidized-web:
    load: true
    listen: 127.0.0.1
    port: 8888

input:
  default: ssh, telnet
  debug: false
  ssh:
    secure: false
  utf8_encoded: true

output:
  default: git
  git:
    user: Oxidized
    email: oxidized@example.com
    single_repo: true
    repo: "HOME/configs.git"

source:
  default: csv
  csv:
    file: "HOME/router.db"
    delimiter: !ruby/regexp /\|/
    map:
      name: 0
      ip: 1
      model: 2
      group: 3
      input: 4
      username: 7
      password: 8
    vars_map:
      ssh_port: 5
      telnet_port: 6
      enable: 9

model_map:
  cisco: ios
  juniper: junos
  fortinet: fortigate
  mikrotik: routeros
  ruijie: rgos
"""

ROUTERDB_HEADER = """# Oxidized Manager — router.db
# Columns: name|ip|model|group|input|ssh_port|telnet_port|username|password|enable
"""


def build_config(opts, home, port):
    """Builds a new Oxidized config from the setup wizard options."""
    doc = load(TEMPLATE.replace("HOME", home))
    doc["extensions"]["oxidized-web"]["port"] = int(port)
    for key in ("username", "password", "model"):
        if opts.get(key):
            doc[key] = str(opts[key])
    for key in ("interval", "threads", "timeout", "retries"):
        if opts.get(key) not in (None, ""):
            doc[key] = int(opts[key])
    if opts.get("input"):
        doc["input"]["default"] = str(opts["input"])
    if opts.get("git_user"):
        doc["output"]["git"]["user"] = str(opts["git_user"])
    if opts.get("git_email"):
        doc["output"]["git"]["email"] = str(opts["git_email"])
    if opts.get("enable"):
        doc["vars"] = CommentedMap(enable=str(opts["enable"]))
    return dump(doc)
