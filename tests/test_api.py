import pytest
from fastapi.testclient import TestClient

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
