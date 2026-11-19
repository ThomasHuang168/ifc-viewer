// "All elements" dashboard: summary tiles, elements-per-class chart and a
// virtualized, sortable, filterable table of every element's properties.
import { saveBlob } from "./zip";

export type Row = Record<string, unknown> & { _model: string; _localId: number; _category: string };

const ROW_H = 28;
const LABELS: Record<string, string> = {
  _model: "Model", _category: "IFC class", _guid: "GlobalId", _localId: "ID",
};
const BASE_COLS = ["_model", "_category", "Name", "ObjectType", "Tag", "PredefinedType", "_guid", "_localId"];
const DEFAULT_BASE = ["_category", "Name", "Tag", "_guid"];
const DEFAULT_PSET_COLS = 6;
const CHART_BARS = 10;

const label = (c: string) => LABELS[c] ?? c;
const key = (model: string, id: number) => `${model}\u0000${id}`;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : String(+v.toPrecision(10));
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function cmp(a: unknown, b: unknown) {
  const ae = a === null || a === undefined || a === "", be = b === null || b === undefined || b === "";
  if (ae || be) return ae && be ? 0 : ae ? 1 : -1; // blanks last
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function createDashboard(opts: {
  root: HTMLElement;
  loadRows: () => Promise<Row[]>;
  onSelect: (model: string, localId: number) => void;
}) {
  const { root } = opts;
  root.innerHTML = `
    <div class="dash-filters">
      <input type="search" class="dash-search" placeholder="Search all properties…" aria-label="Search all properties" />
      <select class="dash-model" aria-label="Model"></select>
      <select class="dash-class" aria-label="IFC class"></select>
      <span class="menu">
        <button class="btn small dash-cols-btn" aria-expanded="false">Columns ▾</button>
        <div class="menu-list dash-cols hidden">
          <input type="search" placeholder="Find a property…" aria-label="Find a column" />
          <div class="dash-cols-list"></div>
        </div>
      </span>
      <button class="btn small dash-csv" title="Download the filtered rows and visible columns">CSV</button>
    </div>
    <div class="dash-tiles"></div>
    <details class="dash-chart" open>
      <summary>Elements by IFC class</summary>
      <div class="bars" role="list"></div>
    </details>
    <div class="dash-count"></div>
    <div class="dash-table" tabindex="0">
      <div class="dash-inner">
        <div class="dash-head" role="row"></div>
        <div class="dash-body"></div>
      </div>
    </div>
    <div class="chart-tip hidden" role="tooltip"></div>
    <p class="dash-empty hidden">Load an IFC file to see its elements here.</p>`;

  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const search = q<HTMLInputElement>(".dash-search");
  const modelSel = q<HTMLSelectElement>(".dash-model");
  const classSel = q<HTMLSelectElement>(".dash-class");
  const tiles = q(".dash-tiles");
  const bars = q(".bars");
  const countEl = q(".dash-count");
  const tableWrap = q(".dash-table");
  const inner = q(".dash-inner");
  const head = q(".dash-head");
  const body = q(".dash-body");
  const tip = q(".chart-tip");
  const colsBtn = q(".dash-cols-btn");
  const colsMenu = q(".dash-cols");
  const colsList = q(".dash-cols-list");
  const colsFind = colsMenu.querySelector("input")!;
  const empty = q(".dash-empty");

  let rows: Row[] = [];
  let haystack: string[] = [];
  let allCols: { col: string; filled: number }[] = [];
  let visibleCols: string[] = [];
  let userPickedCols = false;
  let view: Row[] = [];
  let sort: { col: string; dir: 1 | -1 } | null = null;
  let selected = new Set<string>();
  let stale = true;
  let loading: Promise<void> | null = null;

  const colWidth = (c: string) =>
    c === "_category" ? 170 : c === "Name" ? 220 : c === "_guid" ? 200 : c === "_localId" ? 70 : c === "_model" ? 160 : 150;

  // ---------- Loading ----------
  async function load() {
    rows = await opts.loadRows();
    haystack = rows.map((r) => Object.values(r).map(fmt).join("\u0001").toLowerCase());
    const counts = new Map<string, number>();
    for (const r of rows) for (const [k, v] of Object.entries(r)) {
      if (v !== null && v !== undefined && v !== "") counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const psetCols = [...counts.keys()].filter((k) => k.includes(".") && !BASE_COLS.includes(k));
    psetCols.sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
    allCols = [...BASE_COLS, ...psetCols].map((col) => ({ col, filled: counts.get(col) ?? 0 }));

    const models = [...new Set(rows.map((r) => r._model))];
    if (!userPickedCols) {
      visibleCols = [...(models.length > 1 ? ["_model"] : []), ...DEFAULT_BASE, ...psetCols.slice(0, DEFAULT_PSET_COLS)];
    } else {
      visibleCols = visibleCols.filter((c) => counts.has(c) || BASE_COLS.includes(c));
    }

    const prevModel = modelSel.value;
    modelSel.replaceChildren(new Option(`All models (${models.length})`, ""), ...models.map((m) => new Option(m, m)));
    modelSel.value = models.includes(prevModel) ? prevModel : "";
    modelSel.hidden = models.length < 2;

    empty.classList.toggle("hidden", rows.length > 0);
    stale = false;
    renderColumnsMenu();
    refresh();
  }

  function ensureLoaded() {
    if (!stale) return Promise.resolve();
    loading ??= load().finally(() => (loading = null));
    return loading;
  }

  // ---------- Filtering ----------
  function baseFiltered() {
    const term = search.value.trim().toLowerCase();
    const model = modelSel.value;
    const out: Row[] = [];
    rows.forEach((r, i) => {
      if (model && r._model !== model) return;
      if (term && !haystack[i].includes(term)) return;
      out.push(r);
    });
    return out;
  }

  function refresh() {
    const base = baseFiltered();
    const cls = classSel.value;
    view = cls ? base.filter((r) => r._category === cls) : base;
    if (sort) {
      const { col, dir } = sort;
      view = [...view].sort((a, b) => dir * cmp(a[col], b[col]));
    }
    renderClassOptions(base);
    renderTiles();
    renderChart(base);
    renderHead();
    countEl.textContent = rows.length
      ? `${view.length.toLocaleString()} of ${rows.length.toLocaleString()} elements` +
        (selected.size ? ` · ${selected.size} selected` : "")
      : "";
    body.style.height = `${view.length * ROW_H}px`;
    renderRows(true);
  }

  function renderClassOptions(base: Row[]) {
    const counts = new Map<string, number>();
    for (const r of base) counts.set(r._category, (counts.get(r._category) ?? 0) + 1);
    const cur = classSel.value;
    const classes = [...counts.keys()].sort();
    if (cur && !counts.has(cur)) classes.push(cur);
    classSel.replaceChildren(
      new Option(`All classes (${counts.size})`, ""),
      ...classes.map((c) => new Option(`${c} (${counts.get(c) ?? 0})`, c)),
    );
    classSel.value = cur;
  }

  // ---------- Tiles ----------
  function renderTiles() {
    const models = new Set(view.map((r) => r._model)).size;
    const classes = new Set(view.map((r) => r._category)).size;
    const props = allCols.filter((c) => c.col.includes(".")).length;
    const tile = (value: string, name: string) => {
      const t = el("div", "tile");
      t.append(el("b", "", value), el("span", "", name));
      return t;
    };
    tiles.replaceChildren(
      tile(view.length.toLocaleString(), view.length === rows.length ? "Elements" : `of ${rows.length.toLocaleString()} elements`),
      tile(classes.toLocaleString(), "IFC classes"),
      tile(props.toLocaleString(), "Distinct properties"),
      tile(models.toLocaleString(), models === 1 ? "Model" : "Models"),
    );
  }

  // ---------- Chart: horizontal bars, one series, sorted by count ----------
  function renderChart(base: Row[]) {
    const counts = new Map<string, number>();
    for (const r of base) counts.set(r._category, (counts.get(r._category) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    let shown = sorted.slice(0, CHART_BARS);
    const rest = sorted.slice(CHART_BARS);
    const active = classSel.value;
    // Keep the active class visible even if it's outside the top N
    if (active && !shown.some(([c]) => c === active)) {
      const hit = sorted.find(([c]) => c === active);
      if (hit) shown = [...shown.slice(0, CHART_BARS - 1), hit];
    }
    const restItems = rest.filter(([c]) => !shown.some(([s]) => s === c));
    const max = Math.max(1, ...shown.map(([, n]) => n), restItems.reduce((s, [, n]) => s + n, 0));
    const total = base.length || 1;

    const items: HTMLElement[] = shown.map(([cls, n]) => bar(cls, cls, n));
    if (restItems.length) {
      const n = restItems.reduce((s, [, v]) => s + v, 0);
      items.push(bar(`Other (${restItems.length} classes)`, null, n));
    }
    bars.replaceChildren(...items);
    root.querySelector(".dash-chart")!.classList.toggle("hidden", sorted.length === 0);

    function bar(name: string, cls: string | null, n: number) {
      const b = el("button", "bar-row");
      b.type = "button";
      b.setAttribute("role", "listitem");
      if (active && cls !== active) b.classList.add("dim");
      if (cls && cls === active) b.setAttribute("aria-pressed", "true");
      const pct = ((100 * n) / total).toFixed(1);
      b.setAttribute("aria-label", `${name}: ${n.toLocaleString()} elements, ${pct}%`);
      const track = el("span", "bar-track");
      const fill = el("i", "bar-fill");
      fill.style.width = `${(100 * n) / max}%`;
      track.append(fill);
      b.append(el("span", "bar-label", name), track, el("span", "bar-value", n.toLocaleString()));
      b.disabled = cls === null;
      b.addEventListener("click", () => {
        if (!cls) return;
        classSel.value = classSel.value === cls ? "" : cls;
        refresh();
      });
      b.addEventListener("pointermove", (e) => {
        tip.textContent = `${name} · ${n.toLocaleString()} elements (${pct}%)` + (cls ? (cls === active ? " · click to clear" : " · click to filter") : "");
        tip.classList.remove("hidden");
        const r = root.getBoundingClientRect();
        tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - tip.offsetWidth - 8)}px`;
        tip.style.top = `${e.clientY - r.top + 14}px`;
      });
      b.addEventListener("pointerleave", () => tip.classList.add("hidden"));
      return b;
    }
  }

  // ---------- Table ----------
  function renderHead() {
    const width = visibleCols.reduce((s, c) => s + colWidth(c), 0);
    inner.style.width = `${width}px`;
    head.replaceChildren(
      ...visibleCols.map((c) => {
        const h = el("button", "cell th");
        h.type = "button";
        h.style.width = `${colWidth(c)}px`;
        h.title = `${label(c)} — click to sort`;
        const arrow = sort?.col === c ? (sort.dir === 1 ? " ▲" : " ▼") : "";
        h.textContent = label(c) + arrow;
        if (sort?.col === c) h.setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
        h.addEventListener("click", () => {
          sort = sort?.col !== c ? { col: c, dir: 1 } : sort.dir === 1 ? { col: c, dir: -1 } : null;
          refresh();
        });
        return h;
      }),
    );
  }

  let lastRange = "";
  function renderRows(force = false) {
    const top = Math.max(0, tableWrap.scrollTop - head.offsetHeight);
    const first = Math.max(0, Math.floor(top / ROW_H) - 10);
    const last = Math.min(view.length, Math.ceil((top + tableWrap.clientHeight) / ROW_H) + 10);
    const range = `${first}:${last}`;
    if (!force && range === lastRange) return;
    lastRange = range;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const r = view[i];
      const tr = el("div", "tr");
      tr.style.top = `${i * ROW_H}px`;
      tr.dataset.i = String(i);
      if (selected.has(key(r._model, r._localId))) tr.classList.add("sel");
      for (const c of visibleCols) {
        const v = r[c];
        const td = el("span", "cell", fmt(v));
        td.style.width = `${colWidth(c)}px`;
        if (typeof v === "number") td.classList.add("num");
        if (td.textContent!.length > 18) td.title = td.textContent!;
        tr.append(td);
      }
      frag.append(tr);
    }
    body.replaceChildren(frag);
  }
  tableWrap.addEventListener("scroll", () => renderRows());
  new ResizeObserver(() => renderRows(true)).observe(tableWrap);

  body.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>(".tr");
    if (!tr) return;
    const r = view[Number(tr.dataset.i)];
    opts.onSelect(r._model, r._localId);
  });

  // ---------- Column picker ----------
  function renderColumnsMenu() {
    const term = colsFind.value.trim().toLowerCase();
    const total = rows.length || 1;
    colsList.replaceChildren(
      ...allCols
        .filter(({ col }) => !term || label(col).toLowerCase().includes(term))
        .slice(0, 300)
        .map(({ col, filled }) => {
          const l = el("label", "col-opt");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = visibleCols.includes(col);
          cb.addEventListener("change", () => {
            userPickedCols = true;
            if (cb.checked) visibleCols.push(col);
            else visibleCols = visibleCols.filter((c) => c !== col);
            refresh();
          });
          l.append(cb, el("span", "", label(col)), el("small", "", `${Math.round((100 * filled) / total)}%`));
          l.title = `${filled.toLocaleString()} of ${rows.length.toLocaleString()} elements have this value`;
          return l;
        }),
    );
  }
  colsFind.addEventListener("input", renderColumnsMenu);
  colsFind.addEventListener("keydown", (e) => e.stopPropagation());
  colsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = colsMenu.classList.contains("hidden");
    colsMenu.classList.toggle("hidden", !open);
    colsBtn.setAttribute("aria-expanded", String(open));
    if (open) colsFind.focus();
  });
  colsMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    colsMenu.classList.add("hidden");
    colsBtn.setAttribute("aria-expanded", "false");
  });

  // ---------- Filters ----------
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(refresh, 150);
  });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  modelSel.addEventListener("change", refresh);
  classSel.addEventListener("change", refresh);

  q(".dash-csv").addEventListener("click", () => {
    const lines = [visibleCols.map((c) => csvCell(label(c))).join(",")];
    for (const r of view) lines.push(visibleCols.map((c) => csvCell(r[c])).join(","));
    saveBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }), "elements-filtered.csv");
  });

  return {
    /** Model list changed: data is rebuilt the next time the dashboard is shown. */
    invalidate() {
      stale = true;
    },
    async show() {
      await ensureLoaded();
      renderRows(true);
    },
    /** Highlights the rows of elements selected in 3D and scrolls to the first. */
    setSelection(map: Record<string, Iterable<number>>) {
      selected = new Set();
      for (const [m, ids] of Object.entries(map)) for (const id of ids) selected.add(key(m, id));
      const i = view.findIndex((r) => selected.has(key(r._model, r._localId)));
      if (i >= 0) {
        const y = i * ROW_H;
        const visTop = tableWrap.scrollTop, visH = tableWrap.clientHeight - head.offsetHeight;
        if (y < visTop || y > visTop + visH - ROW_H) tableWrap.scrollTop = Math.max(0, y - visH / 2);
      }
      countEl.textContent = rows.length
        ? `${view.length.toLocaleString()} of ${rows.length.toLocaleString()} elements` +
          (selected.size ? ` · ${selected.size} selected` : "")
        : "";
      renderRows(true);
    },
  };
}
