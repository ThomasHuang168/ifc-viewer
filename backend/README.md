# IFC Viewer backend (optional)

A small Python server that stores what the viewer loads:

- **Files**: the original `.ifc` and the viewer's converted `.frag` geometry. Reopening a stored model uses the `.frag` directly, so it loads with no IFC conversion.
- **Properties**: every element's attributes and property/quantity sets, in SQLite tables you can query.
- **Geometry**: if [IfcOpenShell](https://ifcopenshell.org) is installed, the server re-reads each IFC in Python and stores a triangle mesh per element (world coordinates, metres), plus the property sets IfcOpenShell finds. Meshes can be fetched per element as JSON or for a whole model as an `.obj` file.

The viewer works without it. Once connected (toolbar **Server** menu), it can save the loaded models, list what's stored, reopen and delete them.

## Run it

Requires Python 3.10 or later.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements-ifc.txt   # or requirements.txt to skip IfcOpenShell
python -m ifc_server
```

The server listens on http://127.0.0.1:8000 and keeps everything in `backend/data/` (change it with `--data`).

If you've run `npm run build` in the repository root, the server also serves the viewer itself at http://127.0.0.1:8000/, which connects automatically.

### Using it from the GitHub Pages site

Allow the site's address, then connect from the **Server** menu (or open the site with `?server=http://localhost:8000`):

```bash
python -m ifc_server --allow-origin https://<your-username>.github.io
```

Chrome, Edge and Firefox allow an https page to talk to a server on `localhost`. Safari blocks it, so in Safari use the copy of the viewer that the server itself serves.

### Running it on a shared server

Anyone who can reach the server can read and change what's stored, so set a token and put it behind HTTPS (for example with a reverse proxy):

```bash
python -m ifc_server --host 0.0.0.0 --port 8000 --token "a-long-random-string" --allow-origin https://<your-username>.github.io
```

People enter the token in the viewer's **Server** menu. It's remembered in that browser.

Everything can also be set with environment variables when running under another ASGI server:

```bash
IFC_VIEWER_DATA=/srv/ifc IFC_VIEWER_TOKEN=... IFC_VIEWER_ALLOW_ORIGINS=https://you.github.io \
  uvicorn ifc_server.app:app_from_env --factory --host 0.0.0.0 --port 8000
```

## API

Interactive docs are at `/docs` while the server runs. With a token, send `Authorization: Bearer <token>`.

| Method and path | What it does |
|---|---|
| `GET /api/health` | Server version, whether IfcOpenShell is available, whether a token is required |
| `GET /api/models` | List stored models |
| `POST /api/models` | Store a model. Multipart form: `ifc` (required), `frag` and `elements` (the viewer's `elements.json`), `name` |
| `GET /api/models/{id}` | One model, with element counts per IFC class |
| `DELETE /api/models/{id}` | Delete a model and its files |
| `GET /api/models/{id}/ifc`, `/frag` | Download the stored files |
| `GET /api/models/{id}/elements` | Query one model's elements. Filters: `ifc_class`, `search`, `pset`, `prop`, `value`, `limit`, `offset` |
| `GET /api/models/{id}/elements/{guid}` | One element with all its property sets |
| `GET /api/models/{id}/elements/{guid}/geometry` | That element's mesh: `vertices` (x,y,z,…), `faces` (vertex indices, 3 per triangle), `bbox` |
| `GET /api/models/{id}/geometry.obj` | All meshes of a model as Wavefront OBJ |
| `POST /api/models/{id}/extract` | Re-run the IfcOpenShell extraction |
| `GET /api/elements` | The same element query across every stored model |

Examples:

```bash
# Upload an IFC without the viewer (the viewer converts it the first time it's opened)
curl -F ifc=@house.ifc http://localhost:8000/api/models

# Every element in any stored model with a 2-hour fire rating
curl "http://localhost:8000/api/elements?pset=Pset_WallCommon&prop=FireRating&value=2HR"
```

## Data layout

```
data/
  ifc_viewer.sqlite        tables: models, elements, properties, geometry
  models/<id>/model.ifc
  models/<id>/model.frag
```

`geometry.vertices` is little-endian float64 and `geometry.faces` little-endian uint32, so in Python:

```python
import sqlite3, numpy as np
db = sqlite3.connect("data/ifc_viewer.sqlite")
guid, v, f = db.execute("SELECT guid, vertices, faces FROM geometry LIMIT 1").fetchone()
verts = np.frombuffer(v, "<f8").reshape(-1, 3)
tris = np.frombuffer(f, "<u4").reshape(-1, 3)
```

When IfcOpenShell is installed its element data replaces what the browser sent, and it also includes spatial elements (site, building, storeys). That's why the server's element count can be a little higher than the viewer's.

## Tests

```bash
pip install pytest httpx
python -m pytest tests
```
