# IFC Viewer

A browser-based IFC (BIM) viewer built with [That Open Engine](https://thatopen.com) (`@thatopen/components` v3), Three.js and web-ifc. Runs entirely client-side, so it can be hosted on GitHub Pages. IFC files are opened locally in the visitor's browser and are never uploaded anywhere.

## Features

- Open an `.ifc` file with the button or by dragging it onto the page
- Orbit, pan and zoom
- Click an element to highlight it and see its attributes, property sets and quantities
- **F** fits the model to the view, **Esc** clears the selection
- Load a model from a URL: `?model=models/my-building.ifc`
- **Console** (toolbar button or the **`** key): shows everything the app logs, including errors, and runs JavaScript. The viewer's objects (`world`, `fragments`, `components`, `THREE`, `exporter`, `monitor`, …) are in scope; type `help()` to list them. Up/Down recalls history, Shift+Enter adds a line, Ctrl+L clears.
- **Python console**: switch the console to **Python** to run real Python 3.14 in the browser ([Pyodide](https://pyodide.org)). It's downloaded from jsDelivr the first time (about 13 MB, then cached), so pages that never use it stay as fast as before. Helpers: `await elements()`, `await rows()`, `await dataframe()` (pandas), `models()`, `model_files()` (writes the loaded IFC files to `/models`). The viewer's JS objects are in the `viewer` module. Imports like `numpy` and `pandas` load automatically, and `micropip` installs pure-Python packages from PyPI. IfcOpenShell is not available, since it has no Pyodide build.
- **Download** menu: save everything the browser holds as one `.zip` (original IFC, converted `.frag`, metadata and categories, spatial structure, element properties as JSON and CSV, every IFC entity as JSON, the console log and a resource snapshot), or any of those on its own.
- **Resources** (toolbar button or **R**): live frame rate, JS heap use, site storage, draw calls, triangles, GPU geometries and textures, loaded model size, CPU threads, device memory and GPU name. JS heap size is only reported by Chromium-based browsers.

## Run locally

Requires Node.js 20 or later.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (on the `main` branch).
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push again, or run the **Deploy to GitHub Pages** workflow from the **Actions** tab.

The site will be published at `https://<your-username>.github.io/<repo-name>/`.

The build uses a relative base path, so it works under any repository name with no config changes.

### Adding it to an existing github.io site

If you want the viewer inside your existing `<username>.github.io` site rather than in its own repo, run `npm run build` and copy the contents of `dist/` into a subfolder of that site (for example `viewer/`).

## Hosting sample models

Put `.ifc` files in `public/models/`. They are deployed with the site. Link to them with:

```
https://<your-username>.github.io/<repo-name>/?model=models/house.ifc
```

GitHub rejects files over 100 MB, and Pages sites have a soft 1 GB limit. For large models, let visitors open their own file instead.

## Notes

- **Pyodide version.** `PYODIDE_VERSION` in `src/python.ts` must match the `pyodide` devDependency (used only for TypeScript types).
- **Pinned versions.** The `@thatopen/*` packages and `web-ifc` are pinned to exact versions that are known to work together. `web-ifc` 0.0.78 is **not** compatible with `@thatopen/fragments` 3.4.x. Upgrade all of them together and re-test.
- **WASM file.** `scripts/copy-wasm.mjs` copies `web-ifc.wasm` into `public/wasm/` before every `dev` and `build`, so the WASM version always matches the installed package.
- **Single-threaded.** GitHub Pages can't send the COOP/COEP headers needed for multi-threaded WASM, so the viewer uses single-threaded web-ifc. That works fine; it's just slower on very large models.
