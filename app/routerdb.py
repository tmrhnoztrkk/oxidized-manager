"""Reading/writing router.db (the Oxidized CSV source).

- Comments, blank lines and line order are preserved; only changed lines are rewritten.
- The column mapping comes from source.csv.map / vars_map in the config.
- Empty fields in the middle are written as "nil": Oxidized turns that into nil and the value
  falls back to group/global settings. An empty string ("") is truthy in Ruby and would
  e.g. override the username with an empty one.
"""
import ipaddress
import re

from .i18n import _

# keys that are node attributes (map); everything else belongs in vars_map
NODE_ATTRS = {"name", "ip", "model", "group", "input", "output", "username", "password", "prompt", "timeout"}
EDITABLE = ["name", "ip", "model", "group", "input", "username", "password", "enable", "ssh_port", "telnet_port"]
SECRET_KEYS = {"password", "enable"}
VALID_INPUTS = {"ssh", "telnet", "scp", "http", "ftp", "tftp", "exec"}


class RouterDBError(ValueError):
    pass


def ruby_regex_to_py(value):
    s = str(getattr(value, "value", value) if value is not None else ":").strip()
    m = re.match(r"^/(.*)/([imxo]*)$", s, re.S)
    if m:
        pat, flags = m.group(1), m.group(2)
    else:
        pat, flags = re.escape(s), ""
    pat = pat.replace("\\/", "/")
    f = 0
    if "i" in flags:
        f |= re.I
    if "m" in flags:
        f |= re.S
    if "x" in flags:
        f |= re.X
    return re.compile(pat, f)


def _interp(v):
    if v is None:
        return None
    if v == "nil":
        return None
    return v


class Schema:
    def __init__(self, map_=None, vars_map=None, delimiter=None, file=None):
        self.map = {str(k): int(v) for k, v in (map_ or {"name": 0, "model": 1}).items()}
        self.vars_map = {str(k): int(v) for k, v in (vars_map or {}).items()}
        self.regex = ruby_regex_to_py(delimiter)
        unesc = re.sub(r"\\(.)", r"\1", self.regex.pattern)
        self.join = unesc if len(unesc) == 1 else None
        self.file = file

    @property
    def columns(self):
        cols = {}
        for k, i in self.map.items():
            cols[k] = ("map", i)
        for k, i in self.vars_map.items():
            cols.setdefault(k, ("var", i))
        return cols

    @property
    def width(self):
        idx = list(self.map.values()) + list(self.vars_map.values())
        return max(idx) + 1 if idx else 1

    def column_of(self, key):
        c = self.columns.get(key)
        return c[1] if c else None

    def split(self, line):
        # Ruby: line.split(regex, -1) → trailing empty fields are kept
        return self.regex.split(line)

    def issues(self):
        """Schema issues and suggestions (shown on the Schema tab)."""
        out = []
        for key in ("username", "password", "input"):
            if key in self.vars_map and key not in self.map:
                out.append({
                    "code": f"var_{key}",
                    "level": "error",
                    "message": _("'{key}' is defined in vars_map. Oxidized only reads {key} from source.csv.map, "
                                 "so this column currently has no effect (the group/global value is used).", key=key),
                    "fix": _("Move '{key}' from vars_map to map (column {col} stays the same)", key=key, col=self.vars_map[key]),
                })
        for key, kind in (("ssh_port", "var"), ("telnet_port", "var"), ("enable", "var"),
                          ("username", "map"), ("password", "map"), ("input", "map")):
            if key not in self.map and key not in self.vars_map:
                out.append({
                    "code": f"missing_{key}",
                    "level": "info",
                    "message": _("router.db has no column for '{key}'; it cannot be set per device.", key=key),
                    "fix": _("Add a new column ({section}: {key}: {col})", section="map" if kind == "map" else "vars_map",
                             key=key, col=self.width),
                })
        if self.join is None:
            out.append({"code": "complex_delimiter", "level": "error",
                        "message": _("The delimiter regex ({rx}) cannot be reduced to a single character; "
                                     "the panel cannot write rows.", rx=self.regex.pattern), "fix": None})
        dup = {}
        for k, i in list(self.map.items()) + list(self.vars_map.items()):
            dup.setdefault(i, []).append(k)
        for i, keys in dup.items():
            if len(set(keys)) > 1:
                out.append({"code": f"dup_col_{i}", "level": "warning",
                            "message": _("Column {col} is mapped to more than one key: {keys}", col=i, keys=", ".join(keys)), "fix": None})
        return out


class Entry:
    __slots__ = ("kind", "raw", "data", "lineno")

    def __init__(self, kind, raw, data=None, lineno=0):
        self.kind = kind
        self.raw = raw
        self.data = data
        self.lineno = lineno

    def get(self, schema, key):
        idx = schema.column_of(key)
        if idx is None or self.data is None or idx >= len(self.data):
            return None
        return _interp(self.data[idx])


class RouterDB:
    def __init__(self, text, schema):
        self.schema = schema
        self.trailing_newline = text.endswith("\n")
        self.crlf = "\r\n" in text
        body = text[:-1] if self.trailing_newline else text
        self.entries = []
        if body == "" and not self.trailing_newline:
            return
        for n, raw in enumerate(body.split("\n")):
            line = raw.rstrip("\r")
            if re.match(r"^\s*#", line):
                self.entries.append(Entry("comment", line, lineno=n + 1))
            elif line.strip() == "":
                self.entries.append(Entry("blank", line, lineno=n + 1))
            else:
                self.entries.append(Entry("node", line, schema.split(line), lineno=n + 1))

    # -------------------------------------------------------------- reading
    def nodes(self):
        return [e for e in self.entries if e.kind == "node"]

    def find(self, name):
        for e in self.nodes():
            if e.get(self.schema, "name") == name:
                return e
        return None

    def to_dict(self, entry, reveal=False):
        s = self.schema
        d = {"line": entry.lineno}
        for key in s.columns:
            val = entry.get(s, key)
            if key in SECRET_KEYS and not reveal:
                d["has_" + key] = bool(val)
                d[key] = None
            else:
                d[key] = val
        for key in ("password", "enable"):
            if key not in s.columns:
                d.setdefault("has_" + key, False)
        used = set(s.map.values()) | set(s.vars_map.values())
        extra = {i: v for i, v in enumerate(entry.data or []) if i not in used and v != ""}
        if extra:
            d["extra_columns"] = extra
        return d

    def as_list(self, reveal=False):
        return [self.to_dict(e, reveal) for e in self.nodes()]

    # -------------------------------------------------------------- writing
    def _validate(self, values, exclude=None):
        name = (values.get("name") or "").strip()
        if not name:
            raise RouterDBError(_("Device name is required"))
        other = self.find(name)
        if other is not None and other is not exclude:
            raise RouterDBError(_("A device named '{name}' already exists", name=name))
        ip = (values.get("ip") or "").strip()
        if "ip" in self.schema.columns and ip:
            host = ip.split("/")[0]
            try:
                ipaddress.ip_address(host)
            except ValueError:
                if not re.match(r"^[A-Za-z0-9]([A-Za-z0-9.\-_]*[A-Za-z0-9])?$", host):
                    raise RouterDBError(_("Invalid IP / hostname: {ip}", ip=ip))
        for p in ("ssh_port", "telnet_port"):
            v = values.get(p)
            if v not in (None, ""):
                try:
                    iv = int(v)
                except (TypeError, ValueError):
                    raise RouterDBError(_("{field} must be a number", field=p)) from None
                if not 1 <= iv <= 65535:
                    raise RouterDBError(_("{field} must be between 1 and 65535", field=p))
        inp = values.get("input")
        if inp:
            parts = [x.strip() for x in str(inp).split(",") if x.strip()]
            bad = [x for x in parts if x not in VALID_INPUTS]
            if bad or not parts:
                raise RouterDBError(_("Invalid input: {input}", input=inp))
            values["input"] = ",".join(parts)

    def _build(self, values, original=None):
        s = self.schema
        if s.join is None:
            raise RouterDBError(_("The delimiter is a complex regex; the panel cannot build router.db rows"))
        data = list(original or [])
        width = max(s.width, len(data))
        data += [""] * (width - len(data))
        for key, (_kind, idx) in s.columns.items():
            if key not in values:
                continue  # fields not being changed (e.g. password) stay as they are
            v = values[key]
            v = "" if v is None else str(v).strip()
            if v and (s.regex.search(v) or "\n" in v or "\r" in v):
                raise RouterDBError(
                    _("The value of '{key}' contains the delimiter ('{sep}') and cannot be written to router.db. "
                      "Set this value on the group instead, or change the delimiter in the config.", key=key, sep=s.join))
            data[idx] = v
        while data and data[-1] in ("", "nil"):
            data.pop()
        managed = {i for _kind, i in s.columns.values()}
        data = ["nil" if (d == "" and i in managed) else d for i, d in enumerate(data)]
        return s.join.join(data)

    def add(self, values):
        self._validate(values)
        line = self._build(values)
        entry = Entry("node", line, self.schema.split(line))
        group = values.get("group")
        pos = None
        if group:
            for i, e in enumerate(self.entries):
                if e.kind == "node" and e.get(self.schema, "group") == group:
                    pos = i + 1
        if pos is None:
            pos = len(self.entries)
            while pos > 0 and self.entries[pos - 1].kind == "blank":
                pos -= 1
        self.entries.insert(pos, entry)
        return entry

    def update(self, name, values):
        e = self.find(name)
        if e is None:
            raise RouterDBError(_("'{name}' was not found in router.db", name=name))
        merged = {k: e.get(self.schema, k) for k in self.schema.columns}
        merged.update(values)
        self._validate(merged, exclude=e)
        e.raw = self._build(values, e.data)
        e.data = self.schema.split(e.raw)
        return e

    def delete(self, name):
        e = self.find(name)
        if e is None:
            raise RouterDBError(_("'{name}' was not found in router.db", name=name))
        self.entries.remove(e)

    def render(self):
        nl = "\r\n" if self.crlf else "\n"
        text = nl.join(e.raw for e in self.entries)
        if self.trailing_newline or self.entries:
            text += nl
        return text


def export_csv(db, reveal=False):
    """Standard comma-separated CSV export (for spreadsheets)."""
    import csv
    import io
    cols = ["name", "ip", "model", "group", "input", "username", "password", "enable", "ssh_port", "telnet_port"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for d in db.as_list(reveal=reveal):
        w.writerow(["" if d.get(c) is None else d.get(c) for c in cols])
    return buf.getvalue()


def parse_import(text, schema):
    """Import: CSV with a header (name,ip,...) or raw router.db lines."""
    import csv
    import io
    text = text.strip("﻿")
    first = text.splitlines()[0] if text.strip() else ""
    rows = []
    if first.lower().replace(" ", "").startswith("name,"):
        for rec in csv.DictReader(io.StringIO(text)):
            rows.append({k.strip(): (v or "").strip() for k, v in rec.items() if k})
    else:
        tmp = RouterDB(text if text.endswith("\n") else text + "\n", schema)
        for e in tmp.nodes():
            rows.append({k: (e.get(schema, k) or "") for k in schema.columns})
    return rows
