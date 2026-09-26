"""File access for the local workspace (config, router.db, logs) and backups taken before every change."""
import os
import stat
import time
from pathlib import Path

from . import settings
from .i18n import _


class FilesError(Exception):
    pass


class LocalFiles:
    def __init__(self, root):
        self.root = os.path.abspath(root)

    def _p(self, rel):
        path = os.path.abspath(os.path.join(self.root, rel))
        if path != self.root and not path.startswith(self.root + os.sep):
            raise FilesError(_("Invalid path: {path}", path=rel))
        return path

    def exists(self, rel):
        return os.path.exists(self._p(rel))

    def read(self, rel):
        try:
            with open(self._p(rel), "r", encoding="utf-8", errors="replace", newline="") as fh:
                return fh.read()
        except FileNotFoundError as exc:
            raise FilesError(_("File not found: {path}", path=rel)) from exc

    def write(self, rel, text):
        path = self._p(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        # Atomic replace; retry briefly if another process holds the file open (Windows)
        for _attempt in range(10):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(0.2)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.remove(tmp)

    def remove(self, rel):
        path = self._p(rel)
        if os.path.isfile(path):
            os.remove(path)

    def listdir(self, rel=""):
        path = self._p(rel)
        if not os.path.isdir(path):
            return []
        out = []
        for name in os.listdir(path):
            st = os.stat(os.path.join(path, name))
            out.append({"name": name, "size": st.st_size, "mtime": st.st_mtime,
                        "dir": stat.S_ISDIR(st.st_mode)})
        return out


def backup_dir(wid):
    path = settings.WORKSPACES_DIR / wid / "backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def make_backup(wid, label, text, keep=50):
    d = backup_dir(wid)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = d / f"{label}.{stamp}"
    n = 1
    while path.exists():
        n += 1
        path = d / f"{label}.{stamp}-{n}"
    path.write_text(text, encoding="utf-8")
    old = sorted(d.glob(f"{label}.*"), key=lambda p: p.stat().st_mtime)
    for p in old[:-keep]:
        p.unlink(missing_ok=True)
    return path.name


def list_backups(wid):
    d = backup_dir(wid)
    out = []
    for p in sorted(d.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        out.append({"name": p.name, "file": p.name.split(".", 1)[0], "size": p.stat().st_size,
                    "mtime": p.stat().st_mtime})
    return out


def read_backup(wid, name):
    d = backup_dir(wid).resolve()
    p = (d / name).resolve()
    if p.parent != d or not p.exists():
        raise FilesError(_("Backup not found"))
    return p.read_text(encoding="utf-8")


def remove_tree(path: Path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)
