// Must be first: captures console output from everything that follows
import { mountConsole, setConsoleScope } from "./console";
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import type { ItemData } from "@thatopen/fragments";
// Bundle the fragments worker with the site (no CDN needed at runtime)
import workerUrl from "@thatopen/fragments/worker?url";
import { createResourceMonitor } from "./resources";
import { createExporter, type SourceFile } from "./export";
import { createDashboard, type Row } from "./dashboard";
import { fmtBytes } from "./resources";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $("viewer");
const statusEl = $("status");
const loadingEl = $("loading");
const loadingText = $("loading-text");
const propsPanel = $("props");
const propsBody = $("props-body");

function setLoading(text: string | null) {
  loadingEl.classList.toggle("hidden", text === null);
  if (text) loadingText.textContent = text;
}

// ---------- World ----------
const components = new OBC.Components();
const world = components
  .get(OBC.Worlds)
  .create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();

world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = new THREE.Color(0x1e2228);

world.renderer = new OBC.SimpleRenderer(components, container);
world.camera = new OBC.OrthoPerspectiveCamera(components);
await world.camera.controls.setLookAt(30, 25, 30, 0, 0, 0);

components.init();
components.get(OBC.Grids).create(world);

// ---------- Fragments ----------
const fragments = components.get(OBC.FragmentsManager);
fragments.init(workerUrl);

world.camera.controls.addEventListener("update", () => fragments.core.update());

fragments.list.onItemSet.add(({ value: model }) => {
  model.useCamera(world.camera.three);
  world.scene.three.add(model.object);
  fragments.core.update(true);
});

// Reduce z-fighting between coplanar faces
fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
  if (!("isLodMaterial" in material && material.isLodMaterial)) {
    material.polygonOffset = true;
    material.polygonOffsetUnits = 1;
    material.polygonOffsetFactor = Math.random();
  }
});

// ---------- IFC loader ----------
const ifcLoader = components.get(OBC.IfcLoader);
// web-ifc.wasm is copied into public/wasm/ by scripts/copy-wasm.mjs
await ifcLoader.setup({
  autoSetWasm: false,
  wasm: { path: new URL("wasm/", document.baseURI).href, absolute: true },
});

// Original IFC bytes per model id, kept so they can be downloaded again
const sources = new Map<string, SourceFile>();
const hiddenModels = new Set<string>();

/** Model ids must be unique; loading "a.ifc" twice gives "a.ifc" and "a (2).ifc". */
function uniqueId(name: string) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let id = name;
  for (let n = 2; fragments.list.has(id) || sources.has(id); n++) id = `${base} (${n})${ext}`;
  return id;
}

async function removeModel(id: string) {
  clearSelection();
  await fragments.core.disposeModel(id);
  sources.delete(id);
  hiddenModels.delete(id);
  console.info(`Removed ${id}`);
  modelsChanged();
}

async function clearModels() {
  for (const id of [...fragments.list.keys()]) await removeModel(id);
}

async function setModelVisible(id: string, visible: boolean) {
  const model = fragments.list.get(id);
  if (!model) return;
  if (!visible) await highlighter.clear("select");
  await model.setVisible(undefined, visible);
  visible ? hiddenModels.delete(id) : hiddenModels.add(id);
  await fragments.core.update(true);
  renderModelsMenu();
}

async function fitModel(id: string) {
  const model = fragments.list.get(id);
  if (!model) return;
  await world.camera.fitToItems({ [id]: new Set(await model.getItemsIdsWithGeometry()) });
}

function modelsChanged() {
  dashboard.invalidate();
  if (activeTab === "all" && !propsPanel.classList.contains("hidden")) dashboard.show();
  renderModelsMenu();
  const n = fragments.list.size;
  statusEl.textContent =
    n === 0 ? "Drop .ifc files anywhere, or click Open IFC"
    : n === 1 ? [...fragments.list.keys()][0]
    : `${n} models loaded`;
}

async function loadIfc(buffer: ArrayBuffer, name: string, progress = "") {
  const id = uniqueId(name);
  setLoading(`Converting ${id}${progress}…`);
  try {
    console.info(`Loading ${id} (${(buffer.byteLength / 1048576).toFixed(1)} MB)`);
    const t0 = performance.now();
    const data = new Uint8Array(buffer);
    sources.set(id, { name: id, data });
    await ifcLoader.load(data, true, id, {
      processData: {
        progressCallback: (p: number) =>
          setLoading(`Converting ${id}${progress}… ${Math.round(p * 100)}%`),
      },
    });
    console.info(`Loaded ${id} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return true;
  } catch (err) {
    console.error(err);
    sources.delete(id);
    statusEl.textContent = `Could not load ${name}: ${(err as Error).message}`;
    return false;
  } finally {
    setLoading(null);
  }
}

async function loadFiles(files: File[]) {
  const ifcs = files.filter((f) => f.name.toLowerCase().endsWith(".ifc"));
  if (ifcs.length === 0) {
    statusEl.textContent = "Please choose .ifc files";
    return;
  }
  if (ifcs.length < files.length) console.warn(`Skipped ${files.length - ifcs.length} non-IFC file(s)`);
  let loaded = 0;
  for (const [i, f] of ifcs.entries()) {
    const progress = ifcs.length > 1 ? ` (${i + 1}/${ifcs.length})` : "";
    if (await loadIfc(await f.arrayBuffer(), f.name, progress)) loaded++;
  }
  if (loaded) {
    modelsChanged();
    await new Promise((r) => setTimeout(r, 50));
    await fitAll();
  }
}

async function fitAll() {
  if (fragments.list.size === 0) return;
  await world.camera.fitToItems();
}

// ---------- Selection + properties ----------
const highlighter = components.get(OBF.Highlighter);
highlighter.setup({
  world,
  selectMaterialDefinition: {
    color: new THREE.Color("#4f8cff"),
    opacity: 1,
    transparent: false,
    renderedFaces: 0,
  },
});
highlighter.zoomToSelection = false;

function clearSelection() {
  highlighter.clear("select");
}

const val = (a: unknown): string => {
  if (a && typeof a === "object" && "value" in a) {
    const v = (a as { value: unknown }).value;
    return v === null || v === undefined ? "" : String(v);
  }
  return "";
};

function table(rows: [string, string][]) {
  const t = document.createElement("table");
  for (const [k, v] of rows) {
    const tr = t.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  return t;
}

function section(title: string, rows: [string, string][], sub?: string) {
  if (rows.length === 0) return;
  const h = document.createElement("h4");
  h.textContent = title;
  if (sub) {
    const m = document.createElement("small");
    m.textContent = sub;
    h.append(m);
  }
  propsBody.append(h, table(rows));
}

function renderItem(item: ItemData, modelId?: string) {
  // Direct attributes
  const labels: Record<string, string> = { _category: "IFC class", _guid: "GlobalId" };
  const attrs: [string, string][] = [];
  for (const [key, a] of Object.entries(item)) {
    if (Array.isArray(a) || key === "_localId") continue;
    const v = val(a);
    if (v !== "") attrs.push([labels[key] ?? key, v]);
  }
  section(val(item.Name) || "Element", attrs, modelId);

  // Property sets and quantity sets
  const sets = item.IsDefinedBy;
  if (!Array.isArray(sets)) return;
  for (const set of sets) {
    const rows: [string, string][] = [];
    const props = (set.HasProperties ?? set.Quantities) as ItemData[] | undefined;
    if (!Array.isArray(props)) continue;
    for (const p of props) {
      const valueKey = Object.keys(p).find(
        (k) => k === "NominalValue" || /Value$/.test(k),
      );
      rows.push([val(p.Name), valueKey ? val(p[valueKey]) : ""]);
    }
    section(val(set.Name) || "Property set", rows);
  }
}

const NO_SELECTION = "Click an element in the model to see its properties.";

highlighter.events.select.onHighlight.add(async (modelIdMap) => {
  dashboard.setSelection(modelIdMap);
  if (propsPanel.classList.contains("hidden")) showProps(true, "selected");
  propsBody.innerHTML = "";
  const many = fragments.list.size > 1;
  for (const [modelId, ids] of Object.entries(modelIdMap)) {
    const model = fragments.list.get(modelId);
    if (!model) continue;
    const items = await model.getItemsData([...ids], {
      attributesDefault: true,
      relations: {
        IsDefinedBy: { attributes: true, relations: true },
        DefinesOcurrence: { attributes: false, relations: false },
      },
    });
    items.forEach((it) => renderItem(it, many ? modelId : undefined));
  }
  if (!propsBody.childElementCount) propsBody.textContent = "No properties found.";
});

highlighter.events.select.onClear.add(() => {
  propsBody.textContent = NO_SELECTION;
  dashboard.setSelection({});
});

// ---------- Console, resources, downloads ----------
const consolePanel = $("console");
const resourcesPanel = $("resources");
const btnConsole = $("btn-console");
const btnResources = $("btn-resources");
const consoleUi = mountConsole(consolePanel);

const monitor = createResourceMonitor({
  panel: resourcesPanel,
  renderer: world.renderer.three,
  getModelStats: () => {
    let bytes = 0;
    for (const s of sources.values()) bytes += s.data.byteLength;
    return { models: fragments.list.size, bytes };
  },
});

const exporter = createExporter({
  fragments,
  sources,
  snapshot: monitor.snapshot,
  progress: (t) => setLoading(t),
});

// ---------- Properties panel: "Selected" and "All elements" tabs ----------
const dashboard = createDashboard({
  root: $("dashboard"),
  loadRows: async () => (await exporter.elementRows()) as Row[],
  onSelect: (modelId, localId) =>
    highlighter.highlightByID("select", { [modelId]: new Set([localId]) }, true, true),
});
const btnProps = $("btn-props");
let activeTab: "selected" | "all" = "selected";
propsBody.textContent = NO_SELECTION;

function setTab(tab: "selected" | "all") {
  activeTab = tab;
  $("tab-selected").setAttribute("aria-selected", String(tab === "selected"));
  $("tab-all").setAttribute("aria-selected", String(tab === "all"));
  propsBody.classList.toggle("hidden", tab !== "selected");
  $("dashboard").classList.toggle("hidden", tab !== "all");
  propsPanel.classList.toggle("wide", tab === "all");
  if (tab === "all") dashboard.show().catch((err) => console.error(err));
}
function showProps(show?: boolean, tab?: "selected" | "all") {
  const visible = togglePanel(propsPanel, btnProps, show);
  if (visible) setTab(tab ?? activeTab);
}
$("tab-selected").addEventListener("click", () => setTab("selected"));
$("tab-all").addEventListener("click", () => setTab("all"));
btnProps.addEventListener("click", () => showProps());
$("props-close").addEventListener("click", () => showProps(false));

// ---------- Models menu ----------
const btnModels = $("btn-models");
const modelsMenu = $("models-menu");
const modelsList = $("models-list");
function setModelsMenu(open: boolean) {
  modelsMenu.classList.toggle("hidden", !open);
  btnModels.setAttribute("aria-expanded", String(open));
}
btnModels.addEventListener("click", (e) => {
  e.stopPropagation();
  setModelsMenu(modelsMenu.classList.contains("hidden"));
});
modelsMenu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => setModelsMenu(false));
modelsMenu.querySelector('[data-act="remove-all"]')!.addEventListener("click", async () => {
  setModelsMenu(false);
  await clearModels();
});

function renderModelsMenu() {
  $("models-count").textContent = String(fragments.list.size);
  if (fragments.list.size === 0) {
    modelsList.innerHTML = `<p class="menu-empty">No models loaded. Open or drop .ifc files; each one is added to the scene.</p>`;
    return;
  }
  modelsList.replaceChildren(
    ...[...fragments.list.keys()].map((id) => {
      const row = document.createElement("div");
      row.className = "model-row";
      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = !hiddenModels.has(id);
      vis.title = "Show or hide";
      vis.setAttribute("aria-label", `Show ${id}`);
      vis.addEventListener("change", () => setModelVisible(id, vis.checked));
      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = id;
      name.title = id;
      const size = document.createElement("small");
      size.textContent = fmtBytes(sources.get(id)?.data.byteLength);
      const zoom = document.createElement("button");
      zoom.className = "icon-btn small";
      zoom.textContent = "⤢";
      zoom.title = `Zoom to ${id}`;
      zoom.addEventListener("click", () => fitModel(id));
      const del = document.createElement("button");
      del.className = "icon-btn small";
      del.textContent = "×";
      del.title = `Remove ${id}`;
      del.addEventListener("click", () => removeModel(id));
      row.append(vis, name, size, zoom, del);
      return row;
    }),
  );
}
renderModelsMenu();

function togglePanel(panel: HTMLElement, btn: HTMLElement, show?: boolean) {
  const visible = show ?? panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !visible);
  btn.setAttribute("aria-pressed", String(visible));
  return visible;
}
const toggleConsole = (show?: boolean) => {
  const visible = togglePanel(consolePanel, btnConsole, show);
  document.body.classList.toggle("console-open", visible);
  if (visible) consoleUi.focus();
};
const toggleResources = (show?: boolean) => togglePanel(resourcesPanel, btnResources, show);

btnConsole.addEventListener("click", () => toggleConsole());
btnResources.addEventListener("click", () => toggleResources());
consolePanel.querySelector('[data-act="close"]')!.addEventListener("click", () => toggleConsole(false));
resourcesPanel.querySelector('[data-act="close"]')!.addEventListener("click", () => toggleResources(false));

const btnDownload = $("btn-download");
const downloadMenu = $("download-menu");
const setMenu = (open: boolean) => {
  downloadMenu.classList.toggle("hidden", !open);
  btnDownload.setAttribute("aria-expanded", String(open));
};
btnDownload.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(downloadMenu.classList.contains("hidden"));
});
document.addEventListener("click", () => setMenu(false));
downloadMenu.addEventListener("click", async (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>("[data-dl]");
  if (!item) return;
  setMenu(false);
  const kind = item.dataset.dl as "all" | "ifc" | "frag" | "propertiesJson" | "propertiesCsv" | "console" | "resources";
  try {
    await exporter[kind]();
  } catch (err) {
    console.error(err);
    statusEl.textContent = (err as Error).message;
  }
});

// Handy objects for the in-browser console
const scope = { THREE, OBC, OBF, components, world, fragments, highlighter, ifcLoader, sources, exporter, monitor, dashboard, loadFiles, removeModel };
setConsoleScope({
  ...scope,
  help: () =>
    console.info(
      "Available: " + Object.keys(scope).join(", ") +
      "\nExamples: fragments.list.size · monitor.snapshot() · await exporter.all() · clear()",
    ),
});
console.info("IFC Viewer ready. Press ` to open this console, R for resources.");

// ---------- UI wiring ----------
$<HTMLInputElement>("file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (files.length) await loadFiles(files);
});
$("btn-fit").addEventListener("click", fitAll);
$("btn-clear").addEventListener("click", clearSelection);

window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "f" || e.key === "F") fitAll();
  if (e.key === "`") { e.preventDefault(); toggleConsole(); }
  if (e.key === "r" || e.key === "R") toggleResources();
  if (e.key === "p" || e.key === "P") showProps();
  if (e.key === "Escape") {
    const menuOpen = [downloadMenu, modelsMenu].some((m) => !m.classList.contains("hidden"));
    setMenu(false);
    setModelsMenu(false);
    if (menuOpen) return; // first Escape just closes the open menu
    clearSelection();
    if (activeTab === "selected") showProps(false);
  }
});

// Drag & drop
const overlay = $("drop-overlay");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  overlay.classList.remove("hidden");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) overlay.classList.add("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add("hidden");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) await loadFiles(files);
});

// Optional: load models from the URL, e.g. ?model=models/house.ifc or ?model=a.ifc,b.ifc
// (repeating the parameter also works: ?model=a.ifc&model=b.ifc)
const modelParams = new URLSearchParams(location.search)
  .getAll("model")
  .flatMap((m) => m.split(","))
  .map((m) => m.trim())
  .filter(Boolean);
let urlLoaded = 0;
for (const [i, url] of modelParams.entries()) {
  const progress = modelParams.length > 1 ? ` (${i + 1}/${modelParams.length})` : "";
  setLoading(`Downloading ${url}${progress}…`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (await loadIfc(await res.arrayBuffer(), url.split("/").pop() || "model.ifc", progress)) urlLoaded++;
  } catch (err) {
    setLoading(null);
    console.error(err);
    statusEl.textContent = `Could not fetch ${url}: ${(err as Error).message}`;
  }
}
if (urlLoaded) {
  modelsChanged();
  await new Promise((r) => setTimeout(r, 50));
  await fitAll();
}
