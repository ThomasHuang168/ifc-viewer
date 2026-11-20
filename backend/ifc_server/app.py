"""HTTP API for the IFC Viewer storage backend."""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import tempfile
from pathlib import Path
from typing import Iterator, Optional

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .extract import HAVE_IFCOPENSHELL, IFCOPENSHELL_VERSION, from_browser, run_extraction
from .store import Store

LOCALHOST_ORIGINS = r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"


def create_app(
    data_dir: Path | str = "data",
    allow_origins: list[str] | None = None,
    token: str | None = None,
    static_dir: Path | str | None = None,
    extract: bool = True,
) -> FastAPI:
    store = Store(Path(data_dir))
    app = FastAPI(title="IFC Viewer backend", version=__version__)
    app.state.store = store

    # ---------- Auth (optional bearer token) ----------
    def auth(request: Request) -> None:
        if not token:
            return
        header = request.headers.get("authorization", "")
        given = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token", "")
        if not secrets.compare_digest(given.encode(), token.encode()):
            raise HTTPException(401, "Missing or wrong token", headers={"WWW-Authenticate": "Bearer"})

    def model_or_404(model_id: str) -> dict:
        m = store.get_model(model_id)
        if not m:
            raise HTTPException(404, "Model not found")
        return m

    # ---------- Routes ----------
    @app.get("/api/health")
    def health():
        return {
            "ok": True,
            "service": "ifc-viewer-backend",
            "version": __version__,
            "ifcopenshell": IFCOPENSHELL_VERSION if HAVE_IFCOPENSHELL else None,
            "auth": bool(token),
        }

    @app.get("/api/models", dependencies=[Depends(auth)])
    def list_models():
        return store.list_models()

    @app.post("/api/models", status_code=201, dependencies=[Depends(auth)])
    async def upload_model(
        background: BackgroundTasks,
        ifc: UploadFile = File(..., description="The original .ifc file"),
        frag: Optional[UploadFile] = File(None, description="The viewer's converted .frag geometry"),
        elements: Optional[UploadFile] = File(None, description="elements.json exported by the viewer"),
        name: Optional[str] = Form(None),
    ):
        tmp = Path(tempfile.mkdtemp(prefix="upload-", dir=store.data_dir))
        try:
            ifc_tmp = tmp / "model.ifc"
            await _save(ifc, ifc_tmp)
            with open(ifc_tmp, "rb") as f:
                if b"ISO-10303-21" not in f.read(1024):
                    raise HTTPException(400, "Not an IFC (STEP) file")
            frag_tmp = None
            if frag is not None:
                frag_tmp = tmp / "model.frag"
                await _save(frag, frag_tmp)
            parsed = None
            if elements is not None:
                try:
                    parsed = json.loads(await elements.read())
                    if not isinstance(parsed, list):
                        raise ValueError("expected a JSON array")
                except ValueError as e:
                    raise HTTPException(400, f"elements must be a JSON array: {e}")
            model_id = store.create_model(name or ifc.filename or "model.ifc", ifc_tmp, frag_tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        if parsed is not None:
            store.put_elements(model_id, from_browser(parsed), source="browser")
        if extract and HAVE_IFCOPENSHELL:
            store.set_extraction(model_id, "pending")
            background.add_task(run_extraction, store, model_id)
        elif not HAVE_IFCOPENSHELL:
            store.set_extraction(model_id, "unavailable", "IfcOpenShell is not installed on the server")
        return store.get_model(model_id)

    @app.get("/api/models/{model_id}", dependencies=[Depends(auth)])
    def get_model(model_id: str):
        m = model_or_404(model_id)
        m["classes"] = store.class_counts(model_id)
        return m

    @app.delete("/api/models/{model_id}", status_code=204, dependencies=[Depends(auth)])
    def delete_model(model_id: str):
        if not store.delete_model(model_id):
            raise HTTPException(404, "Model not found")

    @app.post("/api/models/{model_id}/extract", status_code=202, dependencies=[Depends(auth)])
    def extract_again(model_id: str, background: BackgroundTasks):
        model_or_404(model_id)
        if not HAVE_IFCOPENSHELL:
            raise HTTPException(501, "IfcOpenShell is not installed on the server")
        store.set_extraction(model_id, "pending")
        background.add_task(run_extraction, store, model_id)
        return store.get_model(model_id)

    @app.get("/api/models/{model_id}/ifc", dependencies=[Depends(auth)])
    def get_ifc(model_id: str):
        m = model_or_404(model_id)
        return FileResponse(store.ifc_path(model_id), media_type="application/x-step", filename=m["name"])

    @app.get("/api/models/{model_id}/frag", dependencies=[Depends(auth)])
    def get_frag(model_id: str):
        m = model_or_404(model_id)
        if not m["has_frag"]:
            raise HTTPException(404, "No converted geometry stored for this model")
        return FileResponse(store.frag_path(model_id), media_type="application/octet-stream",
                            filename=Path(m["name"]).stem + ".frag")

    @app.get("/api/models/{model_id}/elements", dependencies=[Depends(auth)])
    def model_elements(
        model_id: str,
        ifc_class: Optional[str] = None,
        search: Optional[str] = None,
        pset: Optional[str] = None,
        prop: Optional[str] = None,
        value: Optional[str] = None,
        limit: int = Query(100, ge=1, le=10000),
        offset: int = Query(0, ge=0),
    ):
        model_or_404(model_id)
        return store.query_elements(model_id, ifc_class, search, pset, prop, value, limit, offset)

    @app.get("/api/models/{model_id}/elements/{guid}", dependencies=[Depends(auth)])
    def element(model_id: str, guid: str):
        el = store.get_element(model_id, guid)
        if not el:
            raise HTTPException(404, "Element not found")
        return el

    @app.get("/api/models/{model_id}/elements/{guid}/geometry", dependencies=[Depends(auth)])
    def element_geometry(model_id: str, guid: str):
        g = store.get_geometry(model_id, guid)
        if not g:
            raise HTTPException(404, "No geometry stored for this element (needs IfcOpenShell on the server)")
        return g

    @app.get("/api/models/{model_id}/geometry.obj", dependencies=[Depends(auth)])
    def model_obj(model_id: str):
        m = model_or_404(model_id)
        if not m["geometry_count"]:
            raise HTTPException(404, "No geometry stored for this model (needs IfcOpenShell on the server)")
        name = Path(m["name"]).stem
        return StreamingResponse(
            _obj_lines(store, model_id, m["name"]), media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{name}.obj"'},
        )

    @app.get("/api/elements", dependencies=[Depends(auth)])
    def query_all(
        ifc_class: Optional[str] = None,
        search: Optional[str] = None,
        pset: Optional[str] = None,
        prop: Optional[str] = None,
        value: Optional[str] = None,
        limit: int = Query(100, ge=1, le=10000),
        offset: int = Query(0, ge=0),
    ):
        """Query elements across every stored model."""
        return store.query_elements(None, ifc_class, search, pset, prop, value, limit, offset)

    # Turn unexpected errors into JSON *inside* the CORS layer, so the browser can read the message
    @app.middleware("http")
    async def errors_as_json(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            logging.getLogger("ifc_server").exception("Unhandled error on %s", request.url.path)
            return JSONResponse({"detail": f"Server error: {type(e).__name__}: {e}"}, status_code=500)

    # ---------- CORS (+ Chrome's Private Network Access for http://localhost from https pages) ----------
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins or [],
        allow_origin_regex=LOCALHOST_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )

    @app.middleware("http")
    async def private_network(request: Request, call_next):
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    # ---------- Optionally serve the built viewer from the same origin ----------
    if static_dir and Path(static_dir).is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="viewer")

    return app


async def _save(upload: UploadFile, dest: Path) -> None:
    with open(dest, "wb") as out:
        while chunk := await upload.read(1 << 20):
            out.write(chunk)


def _obj_lines(store: Store, model_id: str, title: str) -> Iterator[str]:
    yield f"# {title}\n# Exported by IFC Viewer backend; world coordinates in metres, Z up\n"
    offset = 1
    for g in store.iter_geometry(model_id):
        yield f"o {g['ifc_class'] or 'Element'}_{g['guid']}\n"
        v = g["vertices"]
        yield "".join(f"v {v[i]:.6f} {v[i + 1]:.6f} {v[i + 2]:.6f}\n" for i in range(0, len(v), 3))
        f = g["faces"]
        yield "".join(f"f {f[i] + offset} {f[i + 1] + offset} {f[i + 2] + offset}\n" for i in range(0, len(f), 3))
        offset += g["vertex_count"]


def app_from_env() -> FastAPI:
    """Entry point for `uvicorn ifc_server.app:app_from_env --factory`."""
    origins = [o.strip() for o in os.environ.get("IFC_VIEWER_ALLOW_ORIGINS", "").split(",") if o.strip()]
    return create_app(
        data_dir=os.environ.get("IFC_VIEWER_DATA", "data"),
        allow_origins=origins,
        token=os.environ.get("IFC_VIEWER_TOKEN") or None,
        static_dir=os.environ.get("IFC_VIEWER_STATIC") or None,
    )
