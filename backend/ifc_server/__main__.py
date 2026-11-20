"""python -m ifc_server [--port 8000] [--data ./data] [--allow-origin https://you.github.io] [--token SECRET]"""

import argparse
import logging
import os
from pathlib import Path

import uvicorn

from .app import create_app
from .extract import HAVE_IFCOPENSHELL


def main() -> None:
    here = Path(__file__).resolve().parent
    default_static = here.parent.parent / "dist"
    p = argparse.ArgumentParser(prog="python -m ifc_server", description="IFC Viewer storage backend")
    p.add_argument("--host", default="127.0.0.1", help="Interface to listen on (default: this computer only)")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--data", default=os.environ.get("IFC_VIEWER_DATA", "data"), help="Where files and the database go")
    p.add_argument("--allow-origin", action="append", default=[],
                   help="Extra site allowed to use this server, e.g. https://you.github.io (localhost is always allowed)")
    p.add_argument("--token", default=os.environ.get("IFC_VIEWER_TOKEN"),
                   help="Require this bearer token (recommended whenever --host is not 127.0.0.1)")
    p.add_argument("--static", default=str(default_static) if default_static.is_dir() else None,
                   help="Serve the built viewer from this folder (default: ../dist if it exists)")
    p.add_argument("--no-extract", action="store_true", help="Don't run IfcOpenShell extraction on upload")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("ifc_server")
    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.token:
        log.warning("Listening on %s without --token: anyone who can reach it can read and change stored models.",
                    args.host)
    log.info("Data folder: %s", Path(args.data).resolve())
    log.info("IfcOpenShell: %s", "available, geometry will be extracted" if HAVE_IFCOPENSHELL
             else "not installed, storing browser-converted geometry and properties only")
    if args.static:
        log.info("Serving the viewer from %s at http://%s:%d/", args.static, args.host, args.port)

    app = create_app(args.data, args.allow_origin, args.token, args.static, extract=not args.no_extract)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
