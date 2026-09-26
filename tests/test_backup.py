import subprocess

import pytest

from app import backup, settings


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


@pytest.fixture()
def remote(tmp_path):
    path = tmp_path / "remote.git"
    git("init", "-q", "--bare", "-b", "main", str(path))
    return path


def dest(remote, **cfg):
    base = {"url": f"file://{remote}", "branch": "main", "path": "hq", "layout": "group",
            "author_name": "Test", "author_email": "t@example.com", "prune": True, "inventory": True}
    base.update(cfg)
    return {"id": "d1", "type": "git", "config": base}


def bundle(**configs):
    return {"nodes": [{"name": n, "group": "core", "model": "ios", "ip": "10.0.0.1", "config": c}
                      for n, c in configs.items()], "errors": []}


def show(remote, path):
    return git("--git-dir", str(remote), "show", f"main:{path}")


def test_first_push_update_and_prune(remote):
    settings.DESTINATIONS_DIR.mkdir(parents=True, exist_ok=True)
    r = backup.sync(dest(remote), bundle(R1="hostname R1\n", R2="hostname R2\n"), "HQ")
    assert r["status"] == "ok" and r["changed"] == 2
    assert show(remote, "hq/core/R1") == "hostname R1\n"
    assert "R2" in show(remote, "hq/devices.csv")

    r = backup.sync(dest(remote), bundle(R1="hostname R1\n", R2="hostname R2\n"), "HQ")
    assert r["status"] == "unchanged"

    r = backup.sync(dest(remote), bundle(R1="hostname R1\ninterface Gi0/1\n"), "HQ")
    assert r["status"] == "ok"
    assert "interface Gi0/1" in show(remote, "hq/core/R1")
    with pytest.raises(subprocess.CalledProcessError):
        show(remote, "hq/core/R2")  # pruned
    log = git("--git-dir", str(remote), "log", "--format=%an|%s", "main")
    assert log.splitlines()[0].startswith("Test|Update")


def test_failed_fetch_keeps_previous_copy(remote):
    backup.sync(dest(remote, path="keep"), bundle(R1="v1\n", R2="v1\n"), "HQ")
    b = bundle(R1="v2\n")
    b["nodes"].append({"name": "R2", "group": "core", "model": "ios", "ip": "10.0.0.2", "config": None})
    backup.sync(dest(remote, path="keep"), b, "HQ")
    assert show(remote, "keep/core/R2") == "v1\n"


def test_nothing_collected_is_refused(remote):
    with pytest.raises(backup.BackupError):
        backup.sync(dest(remote, path="empty"), {"nodes": [], "errors": []}, "HQ")


def test_normalize_validation():
    ok = backup.normalize("github", {"repo": "https://github.com/acme/net-backups.git", "token": "x"}, "Main DC")
    assert ok["repo"] == "acme/net-backups" and ok["server"] == "https://github.com" and ok["path"] == "Main-DC"
    assert backup.clone_url("github", ok) == "https://github.com/acme/net-backups.git"
    assert backup.web_url("gitlab", {"server": "https://gitlab.com", "repo": "g/p"}, "abc").endswith("/-/commit/abc")
    for bad in ({"repo": "nope"}, {"repo": "a/b", "branch": "../x"}, {"repo": "a/b", "path": "../etc"}):
        with pytest.raises(backup.BackupError):
            backup.normalize("github", bad)
    with pytest.raises(backup.BackupError):
        backup.normalize("git_ssh", {"url": "https://not-ssh"})


def test_keygen_roundtrip():
    priv, pub = backup.generate_key()
    assert pub.startswith("ssh-ed25519 ")
    assert backup.public_key_of(priv) == " ".join(pub.split()[:2])


def test_explain_hints():
    assert "Authentication failed" in backup.explain("fatal: Authentication failed for 'https://x'")
    assert "deploy key" in backup.explain("git@github.com: Permission denied (publickey).")
