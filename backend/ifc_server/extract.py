"""Turning IFC data into rows for the store.

Two sources:
  * the browser: the viewer uploads the element properties it already extracted (always available)
  * IfcOpenShell: if installed, the server re-reads the IFC in Python and stores per-element
    triangle meshes plus property sets. This is optional (pip install ifcopenshell).
"""

from __future__ import annotations

import logging
import multiprocessing
import re
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger("ifc_server")

try:
    import ifcopenshell  # type: ignore
    import ifcopenshell.geom  # type: ignore
    import ifcopenshell.util.element  # type: ignore

    HAVE_IFCOPENSHELL = True
    IFCOPENSHELL_VERSION = getattr(ifcopenshell, "version", "unknown")
except Exception:  # pragma: no cover - depends on environment
    HAVE_IFCOPENSHELL = False
    IFCOPENSHELL_VERSION = None

_VALUE_KEY = re.compile(r"Value$")
_FIXED = {"_localId", "_category", "_guid", "IsDefinedBy", "_model", "_ref"}


def from_browser(elements: list[dict]) -> Iterator[dict]:
    """Normalizes the viewer's elements.json (attributes + IsDefinedBy property sets)."""
    for el in elements:
        if not isinstance(el, dict):
            continue
        psets: dict[str, dict[str, Any]] = {}
        for s in el.get("IsDefinedBy") or []:
            if not isinstance(s, dict):
                continue
            props = s.get("HasProperties") or s.get("Quantities")
            if not isinstance(props, list):
                continue
            target = psets.setdefault(str(s.get("Name") or "Set"), {})
            for p in props:
                if not isinstance(p, dict) or "Name" not in p:
                    continue
                key = next((k for k in p if k == "NominalValue" or _VALUE_KEY.search(k)), None)
                target[str(p["Name"])] = p.get(key) if key else None
        attributes = {
            k: v for k, v in el.items()
            if k not in _FIXED and not isinstance(v, (list, dict))
        }
        yield {
            "guid": el.get("_guid"),
            "step_id": el.get("_localId"),
            "ifc_class": el.get("_category") or "",
            "name": el.get("Name"),
            "tag": el.get("Tag"),
            "attributes": attributes,
            "psets": psets,
        }


def _plain(v: Any) -> Any:
    """Makes IfcOpenShell values JSON-friendly."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if hasattr(v, "is_a"):
        return f"#{v.id()}={v.is_a()}" if v.id() else str(v)
    return str(v)


def with_ifcopenshell(ifc_path: Path) -> tuple[list[dict], Iterator[tuple[str, list[float], list[int]]]]:
    """Returns (elements, meshes). Meshes are generated lazily, in world coordinates."""
    if not HAVE_IFCOPENSHELL:
        raise RuntimeError("IfcOpenShell is not installed on the server")
    f = ifcopenshell.open(str(ifc_path))

    elements = []
    for el in f.by_type("IfcProduct"):
        info = el.get_info(recursive=False)
        attributes = {
            k: _plain(v) for k, v in info.items()
            if k not in ("id", "type", "GlobalId", "OwnerHistory", "ObjectPlacement", "Representation")
            and not hasattr(v, "is_a") and not isinstance(v, tuple)
        }
        psets = ifcopenshell.util.element.get_psets(el)
        for props in psets.values():
            props.pop("id", None)
        elements.append({
            "guid": el.GlobalId,
            "step_id": el.id(),
            "ifc_class": el.is_a(),
            "name": getattr(el, "Name", None),
            "tag": getattr(el, "Tag", None),
            "attributes": attributes,
            "psets": {k: {p: _plain(v) for p, v in props.items()} for k, props in psets.items()},
        })

    def meshes() -> Iterator[tuple[str, list[float], list[int]]]:
        settings = ifcopenshell.geom.settings()
        settings.set("use-world-coords", True)
        it = ifcopenshell.geom.iterator(settings, f, max(1, multiprocessing.cpu_count() - 1))
        if not it.initialize():
            return
        while True:
            shape = it.get()
            g = shape.geometry
            yield shape.guid, list(g.verts), list(g.faces)
            if not it.next():
                break

    return elements, meshes()


def run_extraction(store, model_id: str) -> None:
    """Background job: fills elements, properties and geometry from the stored IFC."""
    if not HAVE_IFCOPENSHELL:
        store.set_extraction(model_id, "unavailable", "Install ifcopenshell on the server to extract geometry")
        return
    store.set_extraction(model_id, "running")
    try:
        elements, meshes = with_ifcopenshell(store.ifc_path(model_id))
        store.put_elements(model_id, elements, source="ifcopenshell", replace=True)
        n = store.put_geometry(model_id, meshes)
        store.set_extraction(model_id, "done")
        log.info("Extracted %d elements and %d meshes for %s", len(elements), n, model_id)
    except Exception as e:  # keep the server up whatever the file contains
        log.exception("Extraction failed for %s", model_id)
        store.set_extraction(model_id, "failed", f"{type(e).__name__}: {e}")
