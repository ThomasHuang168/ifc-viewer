// Python for the in-browser console, via Pyodide (CPython compiled to WebAssembly).
// Loaded from the CDN only the first time someone switches the console to Python.
import type { PyodideAPI } from "pyodide";

// Keep in sync with the "pyodide" devDependency (used for types only).
export const PYODIDE_VERSION = "314.0.7";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface PythonHost {
  /** Objects exposed to Python as the `viewer` module. */
  scope: Record<string, unknown>;
  out: (level: "log" | "info" | "warn" | "error", text: string) => void;
}

// Python helpers, importable as `ifcviewer` and pre-imported into the console namespace.
const PRELUDE = `
import sys, os
import pyodide_js
from pyodide.code import eval_code_async
import viewer

async def elements():
    """All elements that have geometry, with their property sets, as a list of dicts."""
    return (await viewer.exporter.elements()).to_py()

async def rows():
    """One flat dict per element: attributes plus 'PsetName.Property' columns."""
    return (await viewer.exporter.elementRows()).to_py()

async def dataframe():
    """Elements as a pandas DataFrame (loads pandas on first use)."""
    await pyodide_js.loadPackage("pandas")
    import pandas as pd
    return pd.DataFrame(await rows())

def models():
    """Names of the loaded models."""
    return list(viewer.fragments.list.keys())

def model_files():
    """Writes the loaded IFC files to /models and returns their paths (IFC is plain text)."""
    os.makedirs("/models", exist_ok=True)
    paths = []
    for name in viewer.sources.keys():
        data = viewer.sources.get(name).data.to_bytes()
        path = "/models/" + name
        with open(path, "wb") as f:
            f.write(data)
        paths.append(path)
    return paths

async def _run(code, ns):
    from pyodide.ffi import to_js
    try:
        result = await eval_code_async(code, ns)
    except BaseException as e:
        import traceback
        # Show only the user's frames, not the console machinery
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "<exec>":
            tb = tb.tb_next
        return to_js(["error", "".join(traceback.format_exception(type(e), e, tb)).rstrip()])
    return to_js(["ok", None if result is None else repr(result)])
`;

const BANNER = (v: string) => `Python ${v} (Pyodide ${PYODIDE_VERSION}) running in your browser.
Helpers: await elements() · await rows() · await dataframe() · models() · model_files()
The viewer's JS objects are in the 'viewer' module, e.g. viewer.fragments, viewer.world.
Imports such as numpy and pandas load automatically. More: import micropip; await micropip.install("pkg")
Enter runs; a line ending in ':' starts a block, finish it with an empty line. Shift+Enter adds a line.`;

let loading: Promise<PyodideAPI> | null = null;
let runner: ((code: string, ns: unknown) => Promise<["ok" | "error", string | null]>) | null = null;
let namespace: unknown = null;

export const pythonLoaded = () => runner !== null;

export function loadPython(host: PythonHost): Promise<PyodideAPI> {
  if (loading) return loading;
  loading = (async () => {
    host.out("info", "Loading Python (about 13 MB, cached after the first time)…");
    const t0 = performance.now();
    const mod = (await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`)) as {
      loadPyodide: (o: object) => Promise<PyodideAPI>;
    };
    const py = await mod.loadPyodide({ indexURL: PYODIDE_URL });
    py.setStdout({ batched: (s: string) => host.out("log", s) });
    py.setStderr({ batched: (s: string) => host.out("warn", s) });
    py.setStdin({ error: true }); // no blocking prompt() dialogs
    py.registerJsModule("viewer", host.scope);
    py.FS.writeFile("/home/pyodide/ifcviewer.py", PRELUDE);
    await py.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide")
import ifcviewer
from ifcviewer import elements, rows, dataframe, models, model_files
import viewer
`);
    runner = py.globals.get("ifcviewer")._run;
    namespace = py.globals;
    host.out("info", `Python ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    host.out("info", BANNER(py.runPython("import sys; sys.version.split()[0]")));
    return py;
  })();
  loading.catch(() => (loading = null)); // allow a retry after a network error
  return loading;
}

export async function runPython(code: string, host: PythonHost): Promise<string | undefined> {
  const py = await loadPython(host);
  await py.loadPackagesFromImports(code, {
    messageCallback: (m: string) => host.out("info", m),
    errorCallback: (m: string) => host.out("warn", m),
  });
  const [kind, text] = await runner!(code, namespace);
  if (kind === "error") throw Object.assign(new Error(text ?? ""), { name: "PythonError", stack: "" });
  return text ?? undefined;
}
