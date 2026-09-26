"""Debug session that connects to a device over SSH/Telnet and shows, live, the steps Oxidized takes.

Like Oxidized's input debug output, it publishes everything sent/received as events:
  emit(kind, text)  kind ∈ info | send | recv | ok | success | warn | error | done
"""
import re
import socket
import time

import paramiko

from .i18n import _
from .routerdb import ruby_regex_to_py

DEFAULT_PROMPT = r"/^([\w.@:\/-]+[#>]\s?)$/"
PAGER_RE = re.compile(rb"(--\s?More\s?--|<--- More --->|---- More ----|Press any key to continue)", re.I)
USER_RE = re.compile(r"(user ?name|login)\s*:\s*$", re.I)
PASS_RE = re.compile(r"pass(word)?\s*:\s*$", re.I)

MODEL_COMMANDS = {
    "ios": ["terminal length 0", "show version"],
    "iosxr": ["terminal length 0", "show version"],
    "nxos": ["terminal length 0", "show version"],
    "asa": ["terminal pager 0", "show version"],
    "eos": ["terminal length 0", "show version"],
    "rgos": ["terminal length 0", "show version"],
    "aireos": ["config paging disable", "show sysinfo"],
    "fortigate": ["get system status"],
    "fortios": ["get system status"],
    "junos": ["show version | no-more"],
    "procurve": ["no page", "show version"],
    "aoscx": ["no page", "show version"],
    "routeros": ["/system resource print"],
    "vrp": ["screen-length 0 temporary", "display version"],
    "comware": ["screen-length disable", "display version"],
    "panos": ["set cli pager off", "show system info"],
    "edgeos": ["terminal length 0", "show version"],
    "vyos": ["terminal length 0", "show version"],
    "powerconnect": ["terminal length 0", "show version"],
    "dnos": ["terminal length 0", "show version"],
    "ironware": ["skip-page-display", "show version"],
}


def default_commands(model):
    return MODEL_COMMANDS.get((model or "").lower(), ["show version"])


class Stopped(Exception):
    pass


class _Conn:
    def __init__(self, emit, stop, prompt_re, timeout):
        self.emit = emit
        self.stop = stop
        self.prompt_re = prompt_re
        self.timeout = timeout
        self.buf = ""

    # subclasses implement _recv(wait) -> bytes | None (EOF) and _send(bytes)
    def send(self, text, secret=False):
        self.emit("send", "********\\n" if secret else text.replace("\r", "\\r").replace("\n", "\\n"))
        self._send(text.encode())

    def expect(self, patterns, timeout=None):
        """Reads until one of the patterns matches at the end of the buffer; returns its index."""
        deadline = time.time() + (timeout or self.timeout)
        while True:
            if self.stop.is_set():
                raise Stopped()
            tail = self.buf[-600:]
            for i, pat in enumerate(patterns):
                if pat.search(tail):
                    return i
            if time.time() > deadline:
                raise TimeoutError(
                    _("Expected output did not arrive within {sec}s. Last received: {tail}", sec=timeout or self.timeout, tail=repr(tail[-200:])))
            data = self._recv(0.3)
            if data is None:
                raise ConnectionError(_("The connection was closed by the remote side"))
            if data:
                if PAGER_RE.search(data):
                    self._send(b" ")
                text = data.decode("utf-8", "replace")
                self.emit("recv", text)
                self.buf += text
                self.buf = self.buf[-20000:]

    def wait_prompt(self, timeout=None):
        self.expect([self.prompt_re], timeout)
        m = None
        for m in self.prompt_re.finditer(self.buf[-600:]):
            pass
        return m.group(0).strip() if m else ""

    def run(self, cmd):
        self.buf = ""
        self.send(cmd + "\n")
        self.wait_prompt()


class _SSHConn(_Conn):
    def __init__(self, chan, *a):
        super().__init__(*a)
        self.chan = chan

    def _recv(self, wait):
        end = time.time() + wait
        while time.time() < end:
            if self.chan.recv_ready():
                return self.chan.recv(65536)
            if self.chan.closed or self.chan.exit_status_ready():
                return None
            time.sleep(0.05)
        return b""

    def _send(self, data):
        self.chan.sendall(data)


IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
ECHO, SGA, TTYPE, NAWS = 1, 3, 24, 31


class _TelnetConn(_Conn):
    def __init__(self, sock, *a):
        super().__init__(*a)
        self.sock = sock
        self.pending = b""

    def _negotiate(self, raw):
        """Strips and answers telnet IAC sequences; returns only the data bytes."""
        data = self.pending + raw
        self.pending = b""
        out = bytearray()
        i = 0
        while i < len(data):
            b = data[i]
            if b != IAC:
                out.append(b)
                i += 1
                continue
            if i + 1 >= len(data):
                self.pending = data[i:]
                break
            cmd = data[i + 1]
            if cmd == IAC:
                out.append(IAC)
                i += 2
            elif cmd in (DO, DONT, WILL, WONT):
                if i + 2 >= len(data):
                    self.pending = data[i:]
                    break
                opt = data[i + 2]
                if cmd == DO:
                    reply = WILL if opt == SGA else WONT
                    self.sock.sendall(bytes([IAC, reply, opt]))
                    self.emit("info", f"telnet: DO {opt} → {'WILL' if reply == WILL else 'WONT'}")
                elif cmd == WILL:
                    reply = DO if opt in (ECHO, SGA) else DONT
                    self.sock.sendall(bytes([IAC, reply, opt]))
                    self.emit("info", f"telnet: WILL {opt} → {'DO' if reply == DO else 'DONT'}")
                i += 3
            elif cmd == SB:
                end = data.find(bytes([IAC, SE]), i)
                if end == -1:
                    self.pending = data[i:]
                    break
                i = end + 2
            else:
                i += 2
        return bytes(out)

    def _recv(self, wait):
        self.sock.settimeout(wait)
        try:
            raw = self.sock.recv(65536)
        except socket.timeout:
            return b""
        if not raw:
            return None
        return self._negotiate(raw)

    def _send(self, data):
        self.sock.sendall(data.replace(b"\n", b"\r\n"))


def _enable(conn, prompt, enable, emit):
    if not enable:
        if prompt.endswith(">"):
            emit("warn", _("The prompt ends with '>' (user mode) and no enable password is set; some models "
                           "cannot read the full config."))
        return prompt
    if not prompt.endswith(">"):
        emit("info", _("Already in privileged mode (prompt '#'), enable skipped"))
        return prompt
    conn.buf = ""
    conn.send("enable\n")
    idx = conn.expect([PASS_RE, conn.prompt_re])
    if idx == 0:
        conn.buf = ""
        conn.send(enable + "\n", secret=True)
        prompt = conn.wait_prompt()
    if prompt.endswith("#"):
        emit("ok", _("Enable succeeded → {prompt}", prompt=prompt))
    else:
        emit("error", _("The prompt is still '{prompt}' after enable. Check the enable password.", prompt=prompt))
    return prompt


def _ssh(p, emit, stop, prompt_re):
    t0 = time.time()
    sock = socket.create_connection((p["host"], p["port"]), timeout=p["timeout"])
    emit("ok", _("TCP connection established {host}:{port} ({ms} ms)", host=p["host"], port=p["port"], ms=f"{(time.time() - t0) * 1000:.0f}"))
    tr = paramiko.Transport(sock)
    tr.banner_timeout = p["timeout"]
    try:
        tr.start_client(timeout=p["timeout"])
        emit("info", _("Remote SSH version: {v}", v=tr.remote_version))
        emit("info", "Negotiated: hostkey={} cipher={} mac={}".format(
            getattr(tr, "host_key_type", "?"), getattr(tr, "remote_cipher", "?"), getattr(tr, "remote_mac", "?")))
        allowed = []
        try:
            tr.auth_none(p["username"])
            emit("warn", _("The server accepted 'none' authentication"))
        except paramiko.BadAuthenticationType as exc:
            allowed = list(exc.allowed_types)
            emit("info", _("Auth methods allowed by the server: {m}", m=", ".join(allowed)))
        except paramiko.SSHException:
            pass
        if not tr.is_authenticated():
            if "password" in allowed or not allowed:
                try:
                    tr.auth_password(p["username"], p["password"] or "")
                except paramiko.AuthenticationException as exc:
                    if "keyboard-interactive" not in allowed:
                        raise
                    emit("warn", _("password method failed ({err}); trying keyboard-interactive", err=exc))
            if not tr.is_authenticated() and "keyboard-interactive" in allowed:
                emit("info", _("Trying keyboard-interactive (add it to auth_methods in Oxidized)"))
                tr.auth_interactive(p["username"], lambda title, instr, prompts: [p["password"] or ""] * len(prompts))
        if not tr.is_authenticated():
            raise paramiko.AuthenticationException(_("Authentication failed"))
        emit("ok", _("Authenticated (user: {user})", user=p["username"]))
        chan = tr.open_session()
        chan.get_pty(term="vt100", width=200, height=1000)
        chan.invoke_shell()
        conn = _SSHConn(chan, emit, stop, prompt_re, p["timeout"])
        _session(conn, p, emit)
    finally:
        tr.close()


def _telnet(p, emit, stop, prompt_re):
    t0 = time.time()
    sock = socket.create_connection((p["host"], p["port"]), timeout=p["timeout"])
    emit("ok", _("TCP connection established {host}:{port} ({ms} ms)", host=p["host"], port=p["port"], ms=f"{(time.time() - t0) * 1000:.0f}"))
    conn = _TelnetConn(sock, emit, stop, prompt_re, p["timeout"])
    try:
        idx = conn.expect([USER_RE, PASS_RE, prompt_re])
        if idx == 0:
            conn.buf = ""
            conn.send((p["username"] or "") + "\n")
            idx = conn.expect([PASS_RE, prompt_re])
            idx = 1 if idx == 0 else 2
        if idx == 1:
            conn.buf = ""
            conn.send((p["password"] or "") + "\n", secret=True)
            idx = conn.expect([prompt_re, USER_RE, re.compile(r"(fail|denied|invalid|incorrect)", re.I)])
            if idx != 0:
                raise PermissionError(_("Telnet login rejected (username/password)"))
        emit("ok", _("Telnet session opened"))
        _session(conn, p, emit)
    finally:
        sock.close()


def _session(conn, p, emit):
    prompt = conn.wait_prompt()
    emit("ok", _("Prompt detected: '{prompt}' (regex: {rx})", prompt=prompt, rx=conn.prompt_re.pattern))
    prompt = _enable(conn, prompt, p.get("enable"), emit)
    for cmd in p["commands"]:
        conn.run(cmd)
    emit("success", _("Commands completed — the device looks ready to be backed up by Oxidized"))
    try:
        conn.send("exit\n")
    except OSError:
        pass


def run_test(params, emit, stop):
    p = {
        "host": (params.get("host") or "").split("/")[0].strip(),
        "port": int(params.get("port") or (22 if params.get("protocol") != "telnet" else 23)),
        "protocol": params.get("protocol") or "ssh",
        "username": params.get("username") or "",
        "password": params.get("password") or "",
        "enable": params.get("enable") or "",
        "timeout": float(params.get("timeout") or 20),
        "commands": [c for c in (params.get("commands") or default_commands(params.get("model"))) if c.strip()],
    }
    try:
        prompt_re = ruby_regex_to_py(params.get("prompt") or DEFAULT_PROMPT)
        prompt_re = re.compile(prompt_re.pattern, prompt_re.flags | re.M)
    except re.error as exc:
        emit("warn", _("The prompt regex could not be converted to Python ({err}); using the default", err=exc))
        prompt_re = re.compile(r"^([\w.@:/-]+[#>]\s?)$", re.M)
    emit("info", f"{p['protocol'].upper()} → {p['host']}:{p['port']}  user={p['username'] or '-'}  "
                 f"password={'set' if p['password'] else 'MISSING'}  enable={'set' if p['enable'] else '-'}  "
                 f"timeout={p['timeout']:.0f}s")
    t0 = time.time()
    try:
        if p["protocol"] == "telnet":
            _telnet(p, emit, stop, prompt_re)
        else:
            _ssh(p, emit, stop, prompt_re)
    except Stopped:
        emit("warn", _("Session stopped by the user"))
    except socket.timeout:
        emit("error", _("Timeout: {host}:{port} does not answer (firewall / port?)", host=p["host"], port=p["port"]))
    except ConnectionRefusedError:
        emit("error", _("Connection refused: port {port} on {host} is closed", host=p["host"], port=p["port"]))
    except paramiko.AuthenticationException as exc:
        emit("error", _("SSH authentication error: {err}", err=exc))
    except paramiko.SSHException as exc:
        emit("error", _("SSH error: {err}", err=exc))
    except Exception as exc:  # noqa: BLE001
        emit("error", f"{exc.__class__.__name__}: {exc}")
    finally:
        emit("done", _("Duration: {sec}s", sec=f"{time.time() - t0:.1f}"))
