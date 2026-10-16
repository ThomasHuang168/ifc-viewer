import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import type { ItemData } from "@thatopen/fragments";
// Bundle the fragments worker with the site (no CDN needed at runtime)
import workerUrl from "@thatopen/fragments/worker?url";
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

async function clearModels() {
  for (const [id] of fragments.list) await fragments.core.disposeModel(id);
}

async function loadIfc(buffer: ArrayBuffer, name: string) {
  setLoading(`Converting ${name}…`);
  statusEl.textContent = name;
  try {
    await clearModels();
    clearSelection();
    await ifcLoader.load(new Uint8Array(buffer), true, name, {
      processData: {
        progressCallback: (p: number) =>
          setLoading(`Converting ${name}… ${Math.round(p * 100)}%`),
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    await fitAll();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Could not load ${name}: ${(err as Error).message}`;
  } finally {
    setLoading(null);
  }
}

async function loadFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".ifc")) {
    statusEl.textContent = "Please choose an .ifc file";
    return;
  }
  await loadIfc(await file.arrayBuffer(), file.name);
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
  propsPanel.classList.add("hidden");
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

function section(title: string, rows: [string, string][]) {
  if (rows.length === 0) return;
  const h = document.createElement("h4");
  h.textContent = title;
  propsBody.append(h, table(rows));
}

function renderItem(item: ItemData) {
  // Direct attributes
  const labels: Record<string, string> = { _category: "IFC class", _guid: "GlobalId" };
  const attrs: [string, string][] = [];
  for (const [key, a] of Object.entries(item)) {
    if (Array.isArray(a) || key === "_localId") continue;
    const v = val(a);
    if (v !== "") attrs.push([labels[key] ?? key, v]);
  }
  section(val(item.Name) || "Element", attrs);

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

highlighter.events.select.onHighlight.add(async (modelIdMap) => {
  propsBody.innerHTML = "";
  propsPanel.classList.remove("hidden");
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
    items.forEach(renderItem);
  }
  if (!propsBody.childElementCount) propsBody.textContent = "No properties found.";
});

highlighter.events.select.onClear.add(() => propsPanel.classList.add("hidden"));

// ---------- UI wiring ----------
$<HTMLInputElement>("file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await loadFile(file);
  input.value = "";
});
$("btn-fit").addEventListener("click", fitAll);
$("btn-clear").addEventListener("click", clearSelection);
$("props-close").addEventListener("click", clearSelection);

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  if (e.key === "f" || e.key === "F") fitAll();
  if (e.key === "Escape") clearSelection();
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
  const file = e.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
});

// Optional: load a model from the URL, e.g. ?model=models/house.ifc
const modelParam = new URLSearchParams(location.search).get("model");
if (modelParam) {
  setLoading("Downloading model…");
  try {
    const res = await fetch(modelParam);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadIfc(await res.arrayBuffer(), modelParam.split("/").pop() ?? "model.ifc");
  } catch (err) {
    setLoading(null);
    statusEl.textContent = `Could not fetch ${modelParam}: ${(err as Error).message}`;
  }
}
