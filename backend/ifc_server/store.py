"""SQLite + file storage for models, elements, properties and geometry."""

from __future__ import annotations

import json
import shutil
import sqlite3
import time
import uuid
from array import array
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS models (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    created_at    REAL NOT NULL,
    ifc_size      INTEGER NOT NULL,
    frag_size     INTEGER,
    schema        TEXT,
    element_count INTEGER NOT NULL DEFAULT 0,
    geometry_count INTEGER NOT NULL DEFAULT 0,
    extraction    TEXT NOT NULL DEFAULT 'none',   -- none | pending | running | done | failed | unavailable
    extraction_error TEXT
);

CREATE TABLE IF NOT EXISTS elements (
    model_id   TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    guid       TEXT NOT NULL,
    step_id    INTEGER,
    ifc_class  TEXT NOT NULL COLLATE NOCASE,
    name       TEXT,
    tag        TEXT,
    attributes TEXT NOT NULL DEFAULT '{}',  -- JSON
    psets      TEXT NOT NULL DEFAULT '{}',  -- JSON {pset: {prop: value}}
    source     TEXT NOT NULL,               -- browser | ifcopenshell
    PRIMARY KEY (model_id, guid)
);
CREATE INDEX IF NOT EXISTS elements_class ON elements(ifc_class);

CREATE TABLE IF NOT EXISTS properties (
    model_id   TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    guid       TEXT NOT NULL,
    pset       TEXT NOT NULL COLLATE NOCASE,
    name       TEXT NOT NULL COLLATE NOCASE,
    value_text TEXT,
    value_num  REAL
);
CREATE INDEX IF NOT EXISTS properties_lookup ON properties(pset, name, value_text);
CREATE INDEX IF NOT EXISTS properties_element ON properties(model_id, guid);

CREATE TABLE IF NOT EXISTS geometry (
    model_id     TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    vertex_count INTEGER NOT NULL,
    face_count   INTEGER NOT NULL,
    vertices     BLOB NOT NULL,   -- float64 little-endian x,y,z,... (world coordinates, metres)
    faces        BLOB NOT NULL,   -- uint32 little-endian triangle vertex indices
    min_x REAL, min_y REAL, min_z REAL, max_x REAL, max_y REAL, max_z REAL,
    PRIMARY KEY (model_id, guid)
);
"""


def _value(v: Any) -> tuple[str | None, float | None]:
    if v is None:
        return None, None
    if isinstance(v, bool):
        return ("true" if v else "false"), None
    if isinstance(v, (int, float)):
        return repr(v) if isinstance(v, float) else str(v), float(v)
    if isinstance(v, (dict, list)):
        return json.dumps(v), None
    return str(v), None


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.files_dir = self.data_dir / "models"
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "ifc_viewer.sqlite"
        with self.db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)

    @contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ---------- Files ----------
    def model_dir(self, model_id: str) -> Path:
        return self.files_dir / model_id

    def ifc_path(self, model_id: str) -> Path:
        return self.model_dir(model_id) / "model.ifc"

    def frag_path(self, model_id: str) -> Path:
        return self.model_dir(model_id) / "model.frag"

    # ---------- Models ----------
    def create_model(self, name: str, ifc_src: Path, frag_src: Path | None) -> str:
        model_id = uuid.uuid4().hex[:12]
        d = self.model_dir(model_id)
        d.mkdir(parents=True)
        shutil.move(str(ifc_src), self.ifc_path(model_id))
        frag_size = None
        if frag_src is not None:
            shutil.move(str(frag_src), self.frag_path(model_id))
            frag_size = self.frag_path(model_id).stat().st_size
        schema = _read_schema(self.ifc_path(model_id))
        with self.db() as db:
            db.execute(
                "INSERT INTO models (id, name, created_at, ifc_size, frag_size, schema) VALUES (?,?,?,?,?,?)",
                (model_id, name, time.time(), self.ifc_path(model_id).stat().st_size, frag_size, schema),
            )
        return model_id

    def get_model(self, model_id: str) -> dict | None:
        with self.db() as db:
            row = db.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
        return _model_dict(row) if row else None

    def list_models(self) -> list[dict]:
        with self.db() as db:
            rows = db.execute("SELECT * FROM models ORDER BY created_at DESC").fetchall()
        return [_model_dict(r) for r in rows]

    def delete_model(self, model_id: str) -> bool:
        with self.db() as db:
            cur = db.execute("DELETE FROM models WHERE id=?", (model_id,))
        shutil.rmtree(self.model_dir(model_id), ignore_errors=True)
        return cur.rowcount > 0

    def set_extraction(self, model_id: str, status: str, error: str | None = None) -> None:
        with self.db() as db:
            db.execute("UPDATE models SET extraction=?, extraction_error=? WHERE id=?", (status, error, model_id))

    def _refresh_counts(self, db: sqlite3.Connection, model_id: str) -> None:
        db.execute(
            """UPDATE models SET
                 element_count=(SELECT COUNT(*) FROM elements WHERE model_id=?),
                 geometry_count=(SELECT COUNT(*) FROM geometry WHERE model_id=?)
               WHERE id=?""",
            (model_id, model_id, model_id),
        )

    # ---------- Elements & properties ----------
    def put_elements(self, model_id: str, elements: Iterable[dict], source: str, replace: bool = False) -> int:
        """Upserts elements: {guid, step_id, ifc_class, name, tag, attributes, psets}."""
        n = 0
        with self.db() as db:
            if replace:
                db.execute("DELETE FROM elements WHERE model_id=?", (model_id,))
                db.execute("DELETE FROM properties WHERE model_id=?", (model_id,))
            for el in elements:
                guid = el.get("guid")
                if not guid:
                    continue
                db.execute("DELETE FROM properties WHERE model_id=? AND guid=?", (model_id, guid))
                db.execute(
                    """INSERT OR REPLACE INTO elements
                       (model_id, guid, step_id, ifc_class, name, tag, attributes, psets, source)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (
                        model_id, guid, el.get("step_id"), el.get("ifc_class") or "", el.get("name"),
                        el.get("tag"), json.dumps(el.get("attributes") or {}, default=str),
                        json.dumps(el.get("psets") or {}, default=str), source,
                    ),
                )
                rows = []
                for pset, props in (el.get("psets") or {}).items():
                    for prop, v in (props or {}).items():
                        if prop == "id":
                            continue
                        rows.append((model_id, guid, pset, prop, *_value(v)))
                db.executemany(
                    "INSERT INTO properties (model_id, guid, pset, name, value_text, value_num) VALUES (?,?,?,?,?,?)",
                    rows,
                )
                n += 1
            self._refresh_counts(db, model_id)
        return n

    def query_elements(
        self,
        model_id: str | None = None,
        ifc_class: str | None = None,
        search: str | None = None,
        pset: str | None = None,
        prop: str | None = None,
        value: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        where, args = [], []
        if model_id:
            where.append("e.model_id=?"); args.append(model_id)
        if ifc_class:
            where.append("e.ifc_class=?"); args.append(ifc_class)
        if search:
            like = f"%{search}%"
            where.append("(e.name LIKE ? OR e.tag LIKE ? OR e.guid LIKE ? OR e.psets LIKE ?)")
            args += [like, like, like, like]
        if pset or prop or value is not None:
            sub, sargs = ["p.model_id=e.model_id", "p.guid=e.guid"], []
            if pset:
                sub.append("p.pset=?"); sargs.append(pset)
            if prop:
                sub.append("p.name=?"); sargs.append(prop)
            if value is not None:
                sub.append("p.value_text=? COLLATE NOCASE"); sargs.append(value)
            where.append(f"EXISTS (SELECT 1 FROM properties p WHERE {' AND '.join(sub)})")
            args += sargs
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        with self.db() as db:
            total = db.execute(f"SELECT COUNT(*) FROM elements e {clause}", args).fetchone()[0]
            rows = db.execute(
                f"""SELECT e.*, (g.guid IS NOT NULL) AS has_geometry
                    FROM elements e LEFT JOIN geometry g ON g.model_id=e.model_id AND g.guid=e.guid
                    {clause} ORDER BY e.model_id, e.ifc_class, e.name LIMIT ? OFFSET ?""",
                [*args, limit, offset],
            ).fetchall()
        return {"total": total, "limit": limit, "offset": offset, "items": [_element_dict(r) for r in rows]}

    def get_element(self, model_id: str, guid: str) -> dict | None:
        with self.db() as db:
            row = db.execute(
                """SELECT e.*, (g.guid IS NOT NULL) AS has_geometry FROM elements e
                   LEFT JOIN geometry g ON g.model_id=e.model_id AND g.guid=e.guid
                   WHERE e.model_id=? AND e.guid=?""",
                (model_id, guid),
            ).fetchone()
        return _element_dict(row) if row else None

    def class_counts(self, model_id: str) -> dict[str, int]:
        with self.db() as db:
            rows = db.execute(
                "SELECT ifc_class, COUNT(*) n FROM elements WHERE model_id=? GROUP BY ifc_class ORDER BY n DESC",
                (model_id,),
            ).fetchall()
        return {r["ifc_class"]: r["n"] for r in rows}

    # ---------- Geometry ----------
    def put_geometry(self, model_id: str, meshes: Iterable[tuple[str, Iterable[float], Iterable[int]]]) -> int:
        n = 0
        with self.db() as db:
            db.execute("DELETE FROM geometry WHERE model_id=?", (model_id,))
            for guid, verts, faces in meshes:
                v = array("d", verts)
                f = array("I", faces)
                if len(v) < 3 or len(f) < 3:
                    continue
                xs, ys, zs = v[0::3], v[1::3], v[2::3]
                db.execute(
                    """INSERT OR REPLACE INTO geometry VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        model_id, guid, len(v) // 3, len(f) // 3, _le(v), _le(f),
                        min(xs), min(ys), min(zs), max(xs), max(ys), max(zs),
                    ),
                )
                n += 1
            self._refresh_counts(db, model_id)
        return n

    def get_geometry(self, model_id: str, guid: str) -> dict | None:
        with self.db() as db:
            row = db.execute("SELECT * FROM geometry WHERE model_id=? AND guid=?", (model_id, guid)).fetchone()
        return _geometry_dict(row) if row else None

    def iter_geometry(self, model_id: str) -> Iterator[dict]:
        with self.db() as db:
            for row in db.execute(
                """SELECT g.*, e.ifc_class, e.name FROM geometry g
                   LEFT JOIN elements e ON e.model_id=g.model_id AND e.guid=g.guid
                   WHERE g.model_id=? ORDER BY e.ifc_class, e.name""",
                (model_id,),
            ):
                d = _geometry_dict(row)
                d["ifc_class"], d["name"] = row["ifc_class"], row["name"]
                yield d


def _le(a: array) -> bytes:
    import sys

    if sys.byteorder != "little":
        a = array(a.typecode, a)
        a.byteswap()
    return a.tobytes()


def _from_le(typecode: str, data: bytes) -> array:
    import sys

    a = array(typecode)
    a.frombytes(data)
    if sys.byteorder != "little":
        a.byteswap()
    return a


def _read_schema(path: Path) -> str | None:
    with open(path, "rb") as f:
        head = f.read(4096).decode("latin-1", "replace")
    import re

    m = re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", head, re.I)
    return m.group(1).upper() if m else None


def _model_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["has_frag"] = d["frag_size"] is not None
    return d


def _element_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["attributes"] = json.loads(d["attributes"])
    d["psets"] = json.loads(d["psets"])
    d["has_geometry"] = bool(d.get("has_geometry"))
    return d


def _geometry_dict(row: sqlite3.Row) -> dict:
    return {
        "guid": row["guid"],
        "vertex_count": row["vertex_count"],
        "face_count": row["face_count"],
        "vertices": list(_from_le("d", row["vertices"])),
        "faces": list(_from_le("I", row["faces"])),
        "bbox": [row["min_x"], row["min_y"], row["min_z"], row["max_x"], row["max_y"], row["max_z"]],
    }
