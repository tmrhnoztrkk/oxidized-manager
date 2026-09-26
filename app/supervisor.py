"""Supervision of the embedded Oxidized process: start / stop / restart, automatic restart
after a crash, a ring buffer of log lines and live log subscribers."""
import collections
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import settings

STATES = ("stopped", "starting", "running", "crashed", "waiting_nodes", "error")


class Supervisor:
    def __init__(self, home: Path):
        self.home = Path(home)
        self.proc = None
        self.state = "stopped"
        self.message = ""
        self.started_at = None
        self.restarts = 0
        self.last_exit = None
        self.lines = collections.deque(maxlen=5000)
        self.subscribers = set()
        self.want_running = False
        self._lock = threading.RLock()
        self._seq = 0
        self._watchdog = None
        self._intentional = None
        self.log_file = self.home / "logs" / "oxidized.log"

    # -------------------------------------------------------------- logs
    def _emit(self, line, source="oxidized"):
        ts = time.time()
        item = {"t": "log", "d": line, "ts": ts, "src": source}
        with self._lock:
            self._seq += 1
            item["n"] = self._seq
            self.lines.append(item)
            subs = list(self.subscribers)
        try:
            print(f"[{source}] {line}", flush=True)  # also visible in `docker logs`
        except (OSError, UnicodeError):
            pass
        for cb in subs:
            try:
                cb(item)
            except Exception:  # noqa: BLE001 - a broken subscriber must not affect the others
                self.subscribers.discard(cb)
        try:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            if self.log_file.exists() and self.log_file.stat().st_size > 10 * 1024 * 1024:
                self.log_file.replace(self.log_file.with_suffix(".log.1"))
            with self.log_file.open("a", encoding="utf-8") as fh:
                fh.write(time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) + f" [{source}] {line}\n")
        except OSError:
            pass

    def note(self, text):
        """Writes the panel's own events into the log stream."""
        self._emit(text, source="panel")

    def subscribe(self, cb, tail=300):
        with self._lock:
            backlog = list(self.lines)[-tail:] if tail else []
            self.subscribers.add(cb)
        return backlog

    def unsubscribe(self, cb):
        with self._lock:
            self.subscribers.discard(cb)

    # -------------------------------------------------------------- process
    def _has_nodes(self):
        """Oxidized refuses to start with an empty node list; look for at least one row in router.db."""
        from . import oxconfig  # avoid a circular import
        try:
            text = (self.home / "config").read_text(encoding="utf-8")
            doc = oxconfig.load(text)
            rel = oxconfig.routerdb_rel(doc, self.home.as_posix())
            rdb = (self.home / rel).read_text(encoding="utf-8")
        except (OSError, ValueError):
            return True  # when unsure, try to start; errors show up in the log
        return any(ln.strip() and not ln.lstrip().startswith("#") for ln in rdb.splitlines())

    def _reader(self, proc):
        for raw in iter(proc.stdout.readline, b""):
            self._emit(raw.decode("utf-8", "replace").rstrip("\r\n"))
        code = proc.wait()
        with self._lock:
            if self.proc is not proc:
                return
            self.proc = None
            self.last_exit = code
            if self.want_running and self._intentional is not proc:
                self.state = "crashed"
                self.message = f"Oxidized exited unexpectedly (exit code {code})"
            else:
                self.state = "stopped"
                self.message = ""
        self.note(f"Oxidized process ended (exit code {code})")

    def start(self):
        with self._lock:
            self.want_running = True
            if self.proc and self.proc.poll() is None:
                return self.status()
            if not self._has_nodes():
                self.state = "waiting_nodes"
                self.message = "router.db has no devices — Oxidized will start when the first device is added"
                self._ensure_watchdog()
                return self.status()
            env = dict(os.environ)
            env["OXIDIZED_HOME"] = str(self.home)
            env.setdefault("HOME", str(self.home.parent))
            # A pid file left by a crash prevents Oxidized from starting ("server is already running")
            (self.home / "pid").unlink(missing_ok=True)
            group = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
                     else {"start_new_session": True})
            try:
                self.proc = subprocess.Popen(
                    [settings.OXIDIZED_BIN], cwd=str(self.home), env=env,
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **group,
                )
            except OSError as exc:
                self.state = "error"
                self.message = f"Oxidized could not be run ({settings.OXIDIZED_BIN}): {exc}"
                self.note(self.message)
                return self.status()
            self.state = "running"
            self.message = ""
            self.started_at = time.time()
            self.note(f"Oxidized started (pid {self.proc.pid})")
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
            self._ensure_watchdog()
            return self.status()

    def stop(self, want=False):
        with self._lock:
            self.want_running = want
            proc = self.proc
            self._intentional = proc
        if proc and proc.poll() is None:
            self.note("Stopping Oxidized…")
            _terminate_tree(proc)
        with self._lock:
            if not want:
                self.state = "stopped"
                self.message = ""
        return self.status()

    def restart(self):
        self.stop(want=True)
        with self._lock:
            self.restarts += 1
            self.proc = None
        return self.start()

    def _ensure_watchdog(self):
        if self._watchdog and self._watchdog.is_alive():
            return
        self._watchdog = threading.Thread(target=self._watch, daemon=True)
        self._watchdog.start()

    def _watch(self):
        """Restarts after a crash with increasing back-off; polls for devices while waiting for the first one."""
        backoff = 5
        while True:
            time.sleep(backoff if self.state == "crashed" else 5)
            with self._lock:
                want, state = self.want_running, self.state
            if not want:
                return
            if state == "crashed":
                self.note(f"Automatic restart (after waiting {backoff}s)")
                self.restarts += 1
                self.start()
                backoff = min(backoff * 2, 300)
            elif state == "waiting_nodes":
                if self._has_nodes():
                    self.start()
            elif state == "running":
                backoff = 5

    def status(self):
        with self._lock:
            running = self.proc is not None and self.proc.poll() is None
            return {
                "state": self.state if (running or self.state != "running") else "stopped",
                "message": self.message, "pid": self.proc.pid if running else None,
                "started_at": self.started_at if running else None, "restarts": self.restarts,
                "last_exit": self.last_exit, "binary": settings.OXIDIZED_BIN,
            }


def _terminate_tree(proc):
    """Stops Oxidized and its children (gracefully first, then forcefully)."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)


_sup = None


def local_supervisor():
    global _sup
    if _sup is None:
        _sup = Supervisor(settings.local_home())
    return _sup
