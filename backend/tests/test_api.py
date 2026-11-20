"""Run with: pytest backend/tests (uses the sample IFC in tests/data)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ifc_server.app import create_app
from ifc_server.extract import HAVE_IFCOPENSHELL

HERE = Path(__file__).parent
IFC = (HERE / "data" / "wall.ifc").read_bytes()
ELEMENTS = [{
    "_category": "IFCWALL", "_localId": 36, "_guid": "7YvctVUKr0kugbFTf53O9L", "Name": "Wall A", "Tag": "W-01",
    "PredefinedType": "STANDARD",
    "IsDefinedBy": [{"Name": "Pset_WallCommon", "HasProperties": [
        {"Name": "FireRating", "NominalValue": "2HR"}, {"Name": "IsExternal", "NominalValue": True}]}],
}]


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(tmp_path, extract=True))


def upload(client, **extra):
    files = {
        "ifc": ("wall.ifc", IFC, "application/octet-stream"),
        "frag": ("wall.frag", b"FRAGDATA", "application/octet-stream"),
        "elements": ("elements.json", json.dumps(ELEMENTS), "application/json"),
    }
    r = client.post("/api/models", files=files, **extra)
    assert r.status_code == 201, r.text
    return r.json()


def test_health(client):
    r = client.get("/api/health").json()
    assert r["ok"] and r["service"] == "ifc-viewer-backend"


def test_upload_list_download_delete(client):
    m = upload(client)
    assert m["name"] == "wall.ifc" and m["schema"] == "IFC4" and m["has_frag"]
    assert [x["id"] for x in client.get("/api/models").json()] == [m["id"]]
    assert client.get(f"/api/models/{m['id']}/ifc").content == IFC
    assert client.get(f"/api/models/{m['id']}/frag").content == b"FRAGDATA"
    assert client.delete(f"/api/models/{m['id']}").status_code == 204
    assert client.get(f"/api/models/{m['id']}").status_code == 404
    assert client.get("/api/models").json() == []


def test_properties_query(client):
    m = upload(client)
    q = client.get("/api/elements", params={"pset": "Pset_WallCommon", "prop": "FireRating", "value": "2hr"}).json()
    assert q["total"] == 1 and q["items"][0]["name"] == "Wall A"
    assert client.get("/api/elements", params={"prop": "FireRating", "value": "1HR"}).json()["total"] == 0
    el = client.get(f"/api/models/{m['id']}/elements/7YvctVUKr0kugbFTf53O9L").json()
    assert el["psets"]["Pset_WallCommon"]["IsExternal"] is True
    assert client.get(f"/api/models/{m['id']}/elements", params={"ifc_class": "ifcwall"}).json()["total"] == 1


@pytest.mark.skipif(not HAVE_IFCOPENSHELL, reason="IfcOpenShell not installed")
def test_ifcopenshell_geometry(client):
    m = upload(client)  # TestClient runs background tasks before returning
    m = client.get(f"/api/models/{m['id']}").json()
    assert m["extraction"] == "done", m
    assert m["geometry_count"] == 1
    g = client.get(f"/api/models/{m['id']}/elements/7YvctVUKr0kugbFTf53O9L/geometry").json()
    assert g["vertex_count"] == 8 and g["face_count"] == 12
    assert g["bbox"][3] - g["bbox"][0] == pytest.approx(4.0)  # 4 m long wall
    obj = client.get(f"/api/models/{m['id']}/geometry.obj").text
    assert obj.count("\nv ") == 8 and obj.count("\nf ") == 12


def test_rejects_non_ifc(client):
    r = client.post("/api/models", files={"ifc": ("x.ifc", b"hello", "text/plain")})
    assert r.status_code == 400


def test_token(tmp_path):
    c = TestClient(create_app(tmp_path, token="s3cret"))
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/models").status_code == 401
    assert c.get("/api/models", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/api/models", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_cors_github_pages_and_private_network(tmp_path):
    c = TestClient(create_app(tmp_path, allow_origins=["https://example.github.io"]))
    pre = c.options("/api/models", headers={
        "Origin": "https://example.github.io",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
    })
    assert pre.headers["access-control-allow-origin"] == "https://example.github.io"
    assert pre.headers["access-control-allow-private-network"] == "true"
    other = c.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers
    local = c.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert local.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_server_errors_keep_cors_headers(tmp_path):
    app = create_app(tmp_path)
    app.state.store.list_models = lambda: 1 / 0  # simulate a crash
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/models", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 500 and "ZeroDivisionError" in r.json()["detail"]
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
