from app.perms import allows, required


def test_reads_need_viewer():
    assert required("GET", "/nodes") == "viewer"
    assert required("GET", "/nodes/R1/config") == "viewer"
    assert required("GET", "/overview") == "viewer"


def test_secrets_need_more():
    assert required("GET", "/nodes/R1/secrets") == "operator"
    assert required("GET", "/groups/core/secrets") == "manager"
    assert required("GET", "/config/raw") == "manager"
    assert required("GET", "/routerdb/raw") == "manager"
    assert required("GET", "/export.csv", "reveal=true") == "operator"
    assert required("GET", "/export.csv") == "viewer"


def test_device_changes_need_operator():
    for method, path in [("POST", "/nodes"), ("PUT", "/nodes/R1"), ("DELETE", "/nodes/R1"),
                         ("POST", "/nodes/R1/fetch"), ("POST", "/bulk"), ("POST", "/import"), ("POST", "/reload")]:
        assert required(method, path) == "operator", (method, path)


def test_settings_need_manager():
    for method, path in [("PATCH", "/config/settings"), ("PUT", "/config/raw"), ("POST", "/groups"),
                         ("POST", "/process/restart"), ("PUT", "/routerdb/raw")]:
        assert required(method, path) == "manager", (method, path)


def test_websockets():
    assert required("WS", "/ws/logs") == "viewer"
    assert required("WS", "/ws/test") == "operator"


def test_role_order():
    assert allows("manager", "viewer") and allows("operator", "operator")
    assert not allows("viewer", "operator") and not allows(None, "viewer")
