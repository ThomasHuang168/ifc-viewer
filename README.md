# IFC Viewer

A browser-based IFC (BIM) viewer built with [That Open Engine](https://thatopen.com) (`@thatopen/components` v3), Three.js and web-ifc. Runs entirely client-side, so it can be hosted on GitHub Pages. IFC files are opened locally in the visitor's browser and are never uploaded anywhere.

## Features

- Open an `.ifc` file with the button or by dragging it onto the page
- Orbit, pan and zoom
- Click an element to highlight it and see its attributes, property sets and quantities
- **F** fits the model to the view, **Esc** clears the selection
- Load a model from a URL: `?model=models/my-building.ifc`

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

- **Pinned versions.** The `@thatopen/*` packages and `web-ifc` are pinned to exact versions that are known to work together. `web-ifc` 0.0.78 is **not** compatible with `@thatopen/fragments` 3.4.x. Upgrade all of them together and re-test.
- **WASM file.** `scripts/copy-wasm.mjs` copies `web-ifc.wasm` into `public/wasm/` before every `dev` and `build`, so the WASM version always matches the installed package.
- **Single-threaded.** GitHub Pages can't send the COOP/COEP headers needed for multi-threaded WASM, so the viewer uses single-threaded web-ifc. That works fine; it's just slower on very large models.
