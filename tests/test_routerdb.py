import pytest

from app.oxconfig import TEMPLATE, load, schema_of
from app.routerdb import RouterDB, RouterDBError, parse_import


def schema():
    return schema_of(load(TEMPLATE.replace("HOME", "/tmp/x")))


def test_add_update_delete_roundtrip():
    rdb = RouterDB("# header\n", schema())
    rdb.add({"name": "R1", "ip": "10.0.0.1", "model": "ios", "group": "core"})
    rdb.add({"name": "R2", "ip": "10.0.0.2", "model": "ios", "password": "s3cret"})
    text = rdb.render()
    assert text.startswith("# header\n")
    again = RouterDB(text, schema())
    assert [n["name"] for n in again.as_list()] == ["R1", "R2"]
    assert again.as_list()[1]["has_password"] is True
    assert again.as_list(reveal=True)[1]["password"] == "s3cret"
    again.update("R1", {"ip": "10.0.0.9"})
    again.delete("R2")
    assert [(n["name"], n["ip"]) for n in again.as_list()] == [("R1", "10.0.0.9")]


def test_empty_middle_fields_are_nil():
    rdb = RouterDB("", schema())
    rdb.add({"name": "R1", "ip": "10.0.0.1", "model": "ios", "password": "pw"})
    line = rdb.render().strip()
    assert "nil" in line and line.split("|")[0] == "R1"


def test_validation():
    rdb = RouterDB("", schema())
    rdb.add({"name": "R1", "ip": "10.0.0.1", "model": "ios"})
    with pytest.raises(RouterDBError):
        rdb.add({"name": "R1", "ip": "10.0.0.2", "model": "ios"})
    with pytest.raises(RouterDBError):
        rdb.add({"name": "R3", "ip": "bad host!", "model": "ios"})
    with pytest.raises(RouterDBError):
        rdb.add({"name": "R4", "ip": "10.0.0.4", "model": "ios", "ssh_port": "70000"})
    with pytest.raises(RouterDBError):
        rdb.add({"name": "R5", "ip": "10.0.0.5", "model": "ios", "username": "a|b"})


def test_import_csv():
    rows = parse_import("name,ip,model,group\nSW1,10.1.1.1,ios,core\n", schema())
    assert rows == [{"name": "SW1", "ip": "10.1.1.1", "model": "ios", "group": "core"}]
