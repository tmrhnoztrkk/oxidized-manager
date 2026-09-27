import hashlib
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import mailer, settings
from app.main import app


@pytest.fixture(scope="module")
def admin():
    c = TestClient(app)
    assert c.get("/api/setup/status").json()["needs_setup"] is True
    assert c.post("/api/setup", json={"username": "admin", "password": "admin-pass-1"}).status_code == 200
    return c


def login(user, pw):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return c


def test_setup_only_once(admin):
    assert admin.post("/api/setup", json={"username": "x" * 5, "password": "12345678"}).status_code == 409


def test_users_workspaces_and_sharing(admin):
    # two remote (plain Oxidized API) workspaces; nothing listens there, which is fine for these checks
    w1 = admin.post("/api/workspaces", json={"type": "oxidized", "name": "Branch A", "config": {"url": "http://127.0.0.1:9"}}).json()
    w2 = admin.post("/api/workspaces", json={"type": "oxidized", "name": "Branch B", "config": {"url": "http://127.0.0.1:9"}}).json()
    r = admin.post("/api/users", json={"username": "alice", "password": "alice-pass", "role": "user",
                                       "access": {w1["id"]: "viewer"}})
    assert r.status_code == 200 and r.json()["access"] == {w1["id"]: "viewer"}
    bob = admin.post("/api/users", json={"username": "bob", "password": "bob-pass-1"}).json()
    assert admin.put(f"/api/workspaces/{w2['id']}/members", json={"user_id": bob["id"], "role": "manager"}).status_code == 200

    alice = login("alice", "alice-pass")
    names = [w["name"] for w in alice.get("/api/workspaces").json()]
    assert names == ["Branch A"]
    assert alice.get("/api/workspaces").json()[0]["role"] == "viewer"
    # viewer: cannot change devices, cannot open other workspaces, no admin endpoints
    assert alice.post(f"/api/w/{w1['id']}/nodes", json={"name": "X"}).status_code == 403
    assert alice.get(f"/api/w/{w2['id']}/nodes").status_code == 403
    assert alice.get("/api/users").status_code == 403
    assert alice.post("/api/workspaces", json={"type": "oxidized", "name": "Z", "config": {"url": "http://x"}}).status_code == 403
    # viewer passes the permission check for reads (then fails to reach the fake Oxidized → 200 with api_error)
    assert alice.get(f"/api/w/{w1['id']}/nodes").status_code == 200

    bobc = login("bob", "bob-pass-1")
    # a workspace manager can share their workspace, but not change their own access
    assert bobc.get(f"/api/workspaces/{w2['id']}/members").status_code == 200
    alice_id = r.json()["id"]
    assert bobc.put(f"/api/workspaces/{w2['id']}/members", json={"user_id": alice_id, "role": "operator"}).status_code == 200
    assert bobc.put(f"/api/workspaces/{w2['id']}/members", json={"user_id": bob["id"], "role": None}).status_code == 400
    assert bobc.get(f"/api/workspaces/{w1['id']}/members").status_code == 403
    assert sorted(w["name"] for w in alice.get("/api/workspaces").json()) == ["Branch A", "Branch B"]

    # disabled users cannot sign in and existing sessions stop working
    assert admin.put(f"/api/users/{alice_id}", json={"disabled": True}).status_code == 200
    assert alice.get("/api/workspaces").status_code == 401
    assert TestClient(app).post("/api/auth/login", json={"username": "alice", "password": "alice-pass"}).status_code == 401

    # audit log: bob (manager of B) sees only B
    entries = bobc.get("/api/audit").json()
    assert entries and all(e["workspace"] == w2["id"] for e in entries)


def test_last_admin_is_protected(admin):
    me = next(u for u in admin.get("/api/users").json() if u["username"] == "admin")
    assert admin.put(f"/api/users/{me['id']}", json={"role": "user"}).status_code == 400
    assert admin.delete(f"/api/users/{me['id']}").status_code == 400


def test_remote_workspace_limit(admin):
    # MAX_REMOTE_WORKSPACES=3 in conftest; two exist from the previous test
    assert admin.post("/api/workspaces", json={"type": "oxidized", "name": "C", "config": {"url": "http://127.0.0.1:9"}}).status_code == 200
    r = admin.post("/api/workspaces", json={"type": "oxidized", "name": "D", "config": {"url": "http://127.0.0.1:9"}})
    assert r.status_code == 409


def test_api_tokens_only_reach_local(admin):
    tok = admin.post("/api/tokens", json={"name": "hq", "scope": "read"}).json()["token"]
    c = TestClient(app)
    h = {"Authorization": f"Bearer {tok}"}
    ws = admin.get("/api/workspaces").json()[0]["id"]
    assert c.get(f"/api/w/{ws}/nodes", headers=h).status_code == 403
    assert c.get("/api/users", headers=h).status_code == 401
    assert c.post("/api/w/local/reload", headers=h).status_code == 403
    assert c.get("/api/agent/info", headers=h).json()["local"] is False
    assert c.get("/api/w/local/nodes", headers={"Authorization": "Bearer oxm_wrong"}).status_code == 401


def test_translated_errors(admin):
    r = TestClient(app).post("/api/auth/login", json={"username": "nobody", "password": "x"}, headers={"X-Lang": "tr"})
    assert r.status_code == 401 and r.json()["detail"] == "Kullanıcı adı veya şifre hatalı"


def test_destination_validation(admin):
    ws = admin.get("/api/workspaces").json()[0]["id"]
    r = admin.post(f"/api/workspaces/{ws}/destinations", json={"type": "github", "config": {"repo": "acme/backups"}})
    assert r.status_code == 400  # token missing
    r = admin.post(f"/api/workspaces/{ws}/destinations",
                   json={"type": "github", "name": "gh", "config": {"repo": "acme/backups", "token": "ghp_secret"}, "interval_min": 0})
    assert r.status_code == 200
    d = r.json()
    assert "token" not in d["config"] and d["config"]["has_token"] is True and "ghp_secret" not in r.text
    assert d["web_url"] == "https://github.com/acme/backups/tree/main"
    k = admin.post("/api/keygen").json()
    assert k["public_key"].startswith("ssh-ed25519") and k["sealed"].startswith("enc:")


def test_profile_and_gravatar(admin):
    r = admin.put("/api/profile", json={"first_name": "Ada", "last_name": "Lovelace", "email": " Ada@Example.com "})
    assert r.status_code == 200
    assert r.json()["avatar"] == hashlib.sha256(b"ada@example.com").hexdigest()
    me = admin.get("/api/auth/me").json()
    assert me["profile"]["first_name"] == "Ada" and me["profile"]["email"] == "Ada@Example.com"
    assert admin.put("/api/profile", json={"email": "not-an-address"}).status_code == 400
    # e-mail addresses are unique (case-insensitive), because they identify the account for a reset
    carol = admin.post("/api/users", json={"username": "carol", "password": "carol-pass", "email": "carol@example.com"}).json()
    assert carol["email"] == "carol@example.com"
    assert admin.put("/api/profile", json={"email": "CAROL@example.com"}).status_code == 400
    assert admin.put(f"/api/users/{carol['id']}", json={"first_name": "Carol"}).json()["first_name"] == "Carol"


def test_smtp_settings_hide_the_password(admin):
    assert TestClient(app).get("/api/auth/me").json()["reset_enabled"] is False
    body = {"host": "smtp.example.com", "port": 587, "security": "starttls", "username": "mailer",
            "password": "smtp-secret", "from_email": "noreply@example.com", "public_url": "https://oxmgr.example.com/"}
    assert admin.put("/api/settings/smtp", json={**body, "public_url": ""}).status_code == 400
    r = admin.put("/api/settings/smtp", json=body)
    assert r.status_code == 200 and "smtp-secret" not in r.text and r.json()["has_password"] is True
    assert r.json()["public_url"] == "https://oxmgr.example.com"
    # an empty password keeps the stored one
    admin.put("/api/settings/smtp", json={**body, "password": ""})
    assert mailer.load(reveal=True)["password"] == "smtp-secret"
    assert TestClient(app).get("/api/auth/me").json()["reset_enabled"] is True
    assert login("carol", "carol-pass").get("/api/settings/smtp").status_code == 403


def test_forgot_and_reset_password(admin, monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, text, cfg=None: sent.append((to, text)))
    anon = TestClient(app)
    carol_old = login("carol", "carol-pass")  # an open session elsewhere, e.g. on a stolen laptop
    # unknown accounts get the same answer and no e-mail
    assert anon.post("/api/auth/forgot", json={"login": "nobody"}).json() == {"ok": True}
    assert sent == []
    assert anon.post("/api/auth/forgot", json={"login": "carol@example.com"}).status_code == 200
    assert len(sent) == 1 and sent[0][0] == "carol@example.com"
    link = re.search(r"https://oxmgr\.example\.com/#/reset/(\S+)", sent[0][1])
    assert link, sent[0][1]
    token = link.group(1)
    # at most one e-mail per minute
    anon.post("/api/auth/forgot", json={"login": "carol"})
    assert len(sent) == 1
    assert anon.get(f"/api/auth/reset/{token}").json() == {"user": "carol"}
    assert anon.post("/api/auth/reset", json={"token": token, "password": "short"}).status_code == 400
    assert anon.post("/api/auth/reset", json={"token": token, "password": "carol-new-pass"}).status_code == 200
    # the reset signs the account out everywhere
    assert carol_old.get("/api/workspaces").status_code == 401
    assert carol_old.get("/api/auth/me").json()["user"] is None
    login("carol", "carol-new-pass")
    # the link works only once
    assert anon.post("/api/auth/reset", json={"token": token, "password": "another-pass"}).status_code == 400
    assert anon.get("/api/auth/reset/wrong-token").status_code == 400


def test_password_change_signs_out_other_sessions(admin):
    dave = admin.post("/api/users", json={"username": "dave", "password": "dave-pass-1"}).json()
    laptop, phone = login("dave", "dave-pass-1"), login("dave", "dave-pass-1")
    # own change: this browser stays signed in, the others are signed out
    assert laptop.put("/api/users/me/password", json={"current": "dave-pass-1", "new": "dave-pass-2"}).status_code == 200
    assert laptop.get("/api/workspaces").status_code == 200
    assert phone.get("/api/workspaces").status_code == 401
    # an administrator setting a new password signs the user out everywhere
    assert admin.put(f"/api/users/{dave['id']}", json={"password": "dave-pass-3"}).status_code == 200
    assert laptop.get("/api/workspaces").status_code == 401
    login("dave", "dave-pass-3")
    # ...but not the administrator's own session when they change their own password there
    me = next(u for u in admin.get("/api/users").json() if u["username"] == "admin")
    assert admin.put(f"/api/users/{me['id']}", json={"password": "admin-pass-2"}).status_code == 200
    assert admin.get("/api/users").status_code == 200
    # a too short password is rejected before anything is changed
    assert admin.put(f"/api/users/{dave['id']}", json={"password": "short", "first_name": "Dave"}).status_code == 400
    assert next(u for u in admin.get("/api/users").json() if u["username"] == "dave")["first_name"] == ""


def test_version_is_the_same_everywhere():
    root = Path(__file__).resolve().parent.parent
    v = settings.VERSION
    assert f"image: oxidized-manager:{v}" in (root / "docker-compose.yml").read_text()
    assert f'org.opencontainers.image.version="{v}"' in (root / "Dockerfile").read_text()
    assert f"## {v}" in (root / "CHANGELOG.md").read_text()
