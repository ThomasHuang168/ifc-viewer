// Collects everything the viewer holds in the browser and offers it as downloads.
import type * as OBC from "@thatopen/components";
import type { FragmentsModel, ItemData } from "@thatopen/fragments";
import { makeZip, saveBlob, type ZipEntry } from "./zip";
import { logsAsText } from "./console";
import type { ResourceSnapshot } from "./resources";

export interface SourceFile {
  name: string;
  data: Uint8Array;
}

const BATCH = 2000;
type Progress = (text: string) => void;

const val = (a: unknown): unknown =>
  a && typeof a === "object" && !Array.isArray(a) && "value" in a ? (a as { value: unknown }).value : undefined;

/** Strips the {value, type} wrappers so exported JSON is readable. Safe against cycles. */
function simplify(item: ItemData, stack = new Set<object>()): Record<string, unknown> {
  if (stack.has(item)) return { _ref: val(item._localId) };
  stack.add(item);
  const out: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(item)) {
    if (Array.isArray(a)) out[k] = a.map((x) => simplify(x as ItemData, stack));
    else {
      const v = val(a);
      out[k] = v === undefined ? a : v;
    }
  }
  stack.delete(item);
  return out;
}

const baseName = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");

async function inBatches<T>(ids: number[], fn: (ids: number[]) => Promise<T[]>, onBatch: (done: number) => void) {
  const all: T[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    all.push(...(await fn(ids.slice(i, i + BATCH))));
    onBatch(Math.min(i + BATCH, ids.length));
  }
  return all;
}

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Elements with geometry, with their property and quantity sets resolved. */
async function elementsData(model: FragmentsModel, progress: Progress, label: string) {
  const ids = await model.getItemsIdsWithGeometry();
  const items = await inBatches(
    ids,
    (batch) =>
      model.getItemsData(batch, {
        attributesDefault: true,
        relations: {
          IsDefinedBy: { attributes: true, relations: true },
          DefinesOcurrence: { attributes: false, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      }),
    (n) => progress(`${label}: element properties ${n}/${ids.length}`),
  );
  return items.map((i) => simplify(i));
}

/** Flattens elements to one row each: fixed attributes plus "PsetName.Property" columns. */
function elementRows(elements: Record<string, unknown>[]) {
  const fixed = ["_localId", "_category", "_guid", "Name", "ObjectType", "Tag", "PredefinedType"];
  const psetCols = new Set<string>();
  const rows = elements.map((el) => {
    const row: Record<string, unknown> = {};
    if (el._model !== undefined) row._model = el._model;
    for (const k of fixed) row[k] = el[k];
    const sets = el.IsDefinedBy;
    if (Array.isArray(sets)) {
      for (const set of sets as Record<string, unknown>[]) {
        const props = (set.HasProperties ?? set.Quantities) as Record<string, unknown>[] | undefined;
        if (!Array.isArray(props)) continue;
        for (const p of props) {
          const vk = Object.keys(p).find((k) => k === "NominalValue" || /Value$/.test(k));
          const col = `${set.Name ?? "Set"}.${p.Name ?? "?"}`;
          psetCols.add(col);
          row[col] = vk ? p[vk] : null;
        }
      }
    }
    return row;
  });
  return { rows, cols: [...fixed, ...[...psetCols].sort()] };
}

function elementsCsv(elements: Record<string, unknown>[]) {
  const { rows, cols } = elementRows(elements);
  return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");
}

export function createExporter(opts: {
  fragments: OBC.FragmentsManager;
  sources: Map<string, SourceFile>;
  snapshot: () => ResourceSnapshot;
  progress: (text: string | null) => void;
}) {
  const { fragments, sources } = opts;
  const enc = new TextEncoder();
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  const models = () => [...fragments.list.entries()];
  const requireModels = () => {
    if (fragments.list.size === 0) throw new Error("No model loaded yet. Open an IFC file first.");
    return models();
  };

  async function withProgress<T>(fn: (p: Progress) => Promise<T>) {
    try {
      return await fn((t) => opts.progress(t));
    } finally {
      opts.progress(null);
    }
  }

  async function modelEntries(id: string, model: FragmentsModel, p: Progress): Promise<ZipEntry[]> {
    const dir = `${baseName(id)}/`;
    const entries: ZipEntry[] = [];
    const src = sources.get(id);
    if (src) entries.push({ name: dir + src.name, data: src.data });

    p(`${id}: fragments`);
    entries.push({ name: `${dir}${baseName(id)}.frag`, data: new Uint8Array(await model.getBuffer(false)) });

    p(`${id}: metadata`);
    const [metadata, categories, spatial] = await Promise.all([
      model.getMetadata().catch(() => ({})),
      model.getCategories(),
      model.getSpatialStructure(),
    ]);
    entries.push({ name: dir + "metadata.json", data: json({ modelId: id, metadata, categories }) });
    entries.push({ name: dir + "spatial-structure.json", data: json(spatial) });

    const elements = await elementsData(model, p, id);
    entries.push({ name: dir + "elements.json", data: json(elements) });
    entries.push({ name: dir + "elements.csv", data: "﻿" + elementsCsv(elements) });

    const allIds = await model.getLocalIds();
    const items = await inBatches(
      allIds,
      (batch) =>
        model.getItemsData(batch, {
          attributesDefault: true,
          relationsDefault: { attributes: false, relations: false },
        }),
      (n) => p(`${id}: all IFC entities ${n}/${allIds.length}`),
    );
    entries.push({ name: dir + "all-entities.json", data: json(items.map((i) => simplify(i))) });
    return entries;
  }

  function sessionEntries(): ZipEntry[] {
    return [
      { name: "console-log.txt", data: logsAsText() },
      { name: "resources.json", data: json(opts.snapshot()) },
    ];
  }

  async function allElements() {
    return withProgress(async (p) => {
      const out: Record<string, unknown>[] = [];
      for (const [id, model] of models()) {
        for (const el of await elementsData(model, p, id)) out.push({ _model: id, ...el });
      }
      return out;
    });
  }

  return {
    /** Elements of one model with their property sets, without the progress spinner. */
    async modelElements(id: string) {
      const model = fragments.list.get(id);
      if (!model) throw new Error(`No model ${id}`);
      return elementsData(model, () => {}, id);
    },
    /** Elements with geometry from all loaded models, with property sets (used by the Python console). */
    elements: allElements,
    /** Same as elements(), flattened to one row per element. */
    async elementRows() {
      return elementRows(await allElements()).rows;
    },
    /** Everything: per model source IFC, fragments, metadata, properties; plus console and resources. */
    async all() {
      await withProgress(async (p) => {
        const entries: ZipEntry[] = [];
        for (const [id, model] of models()) entries.push(...(await modelEntries(id, model, p)));
        entries.push(...sessionEntries());
        p("Packing zip…");
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        saveBlob(makeZip(entries), `ifc-viewer-export-${stamp}.zip`);
        console.info(`Exported ${entries.length} files`);
      });
    },
    async ifc() {
      const list = requireModels().filter(([id]) => sources.has(id));
      for (const [id] of list) {
        const s = sources.get(id)!;
        saveBlob(new Blob([s.data as Uint8Array<ArrayBuffer>]), s.name);
      }
    },
    async frag() {
      await withProgress(async (p) => {
        for (const [id, model] of requireModels()) {
          p(`${id}: fragments`);
          saveBlob(new Blob([await model.getBuffer(false)]), `${baseName(id)}.frag`);
        }
      });
    },
    async propertiesJson() {
      await withProgress(async (p) => {
        for (const [id, model] of requireModels()) {
          const el = await elementsData(model, p, id);
          saveBlob(new Blob([json(el)], { type: "application/json" }), `${baseName(id)}-properties.json`);
        }
      });
    },
    async propertiesCsv() {
      await withProgress(async (p) => {
        for (const [id, model] of requireModels()) {
          const el = await elementsData(model, p, id);
          saveBlob(new Blob(["﻿" + elementsCsv(el)], { type: "text/csv" }), `${baseName(id)}-properties.csv`);
        }
      });
    },
    console() {
      saveBlob(new Blob([logsAsText()], { type: "text/plain" }), "console-log.txt");
    },
    resources() {
      saveBlob(new Blob([enc.encode(json(opts.snapshot()))], { type: "application/json" }), "resources.json");
    },
  };
}
