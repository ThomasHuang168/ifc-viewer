// Toolbar "Server" menu: connect to the optional backend, save loaded models, reopen stored ones.
import type { ServerClient, ServerModel } from "./server";
import { fmtBytes } from "./resources";
import { saveBlob } from "./zip";

export interface LoadedModel {
  id: string;
  ifc?: Uint8Array;
  frag: () => Promise<ArrayBuffer>;
  elements: () => Promise<unknown[]>;
}

export function createServerUi(opts: {
  button: HTMLElement;
  menu: HTMLElement;
  client: ServerClient;
  loadedModels: () => LoadedModel[];
  /** Adds a stored model to the scene; returns its local model id. */
  open: (m: ServerModel, frag: ArrayBuffer | null, ifc: ArrayBuffer) => Promise<string | null>;
  progress: (text: string | null) => void;
}) {
  const { button, menu, client } = opts;
  const storedAs = new Map<string, string>(); // local model id -> server model id
  let models: ServerModel[] = [];
  let error = "";
  let pollTimer = 0;
  let draftUrl = "http://localhost:8000"; // keeps what was typed across re-renders

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const btn = (text: string, onClick: () => void, cls = "", title = "", ariaLabel = "") => {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
    b.addEventListener("click", onClick);
    return b;
  };

  function setOpen(open: boolean) {
    menu.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    if (open && client.connected) refresh();
    else if (open) render();
  }
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains("hidden"));
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  menu.addEventListener("keydown", (e) => e.stopPropagation());
  document.addEventListener("click", () => setOpen(false));

  function updateButton() {
    button.classList.toggle("connected", client.connected);
    button.title = client.connected ? `Connected to ${client.url}` : "Optional Python backend: not connected";
  }
  client.onChange(() => {
    updateButton();
    if (!menu.classList.contains("hidden")) client.connected ? refresh() : render();
  });
  updateButton();

  async function refresh() {
    try {
      models = await client.list();
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
    render();
    clearTimeout(pollTimer);
    if (models.some((m) => m.extraction === "pending" || m.extraction === "running") && !menu.classList.contains("hidden")) {
      pollTimer = window.setTimeout(refresh, 2000);
    }
  }

  async function guard(task: () => Promise<void>) {
    try {
      await task();
      error = "";
    } catch (e) {
      console.error(e);
      error = (e as Error).message;
    } finally {
      opts.progress(null);
      if (client.connected) await refresh();
      else render();
    }
  }

  // ---------- Actions ----------
  async function saveAll() {
    const pending = opts.loadedModels().filter((m) => !storedAs.has(m.id));
    for (const [i, m] of pending.entries()) {
      if (!m.ifc) {
        console.warn(`${m.id}: original IFC not available, skipped`);
        continue;
      }
      const n = pending.length > 1 ? ` (${i + 1}/${pending.length})` : "";
      opts.progress(`Saving ${m.id} to server${n}: properties…`);
      const elements = await m.elements();
      opts.progress(`Saving ${m.id} to server${n}: uploading…`);
      const saved = await client.upload({ name: m.id, ifc: m.ifc, frag: await m.frag(), elements });
      storedAs.set(m.id, saved.id);
      console.info(`Saved ${m.id} to server as ${saved.id}`);
    }
  }

  async function open(m: ServerModel) {
    opts.progress(`Downloading ${m.name}…`);
    const [frag, ifc] = await Promise.all([
      m.has_frag ? client.file(m.id, "frag") : Promise.resolve(null),
      client.file(m.id, "ifc"),
    ]);
    const localId = await opts.open(m, frag, ifc);
    if (localId) storedAs.set(localId, m.id);
  }

  async function remove(m: ServerModel) {
    if (!confirm(`Delete "${m.name}" from the server? This can't be undone.`)) return;
    await client.remove(m.id);
    for (const [local, server] of storedAs) if (server === m.id) storedAs.delete(local);
    console.info(`Deleted ${m.name} from server`);
  }

  // ---------- Rendering ----------
  function render() {
    const parts: HTMLElement[] = [];
    if (!client.connected) {
      parts.push(el("p", "menu-note",
        "Optional: run the Python backend to store IFC files, geometry and properties on a server. " +
        "Start it with: python -m ifc_server"));
      const form = el("form", "server-form");
      const url = el("input");
      url.type = "url";
      url.placeholder = "http://localhost:8000";
      url.value = client.url ?? draftUrl;
      url.addEventListener("input", () => (draftUrl = url.value));
      url.setAttribute("aria-label", "Server address");
      const tok = el("input");
      tok.type = "password";
      tok.placeholder = "Token (if the server requires one)";
      tok.setAttribute("aria-label", "Token");
      tok.autocomplete = "off";
      const go = el("button", "btn small primary", "Connect");
      go.type = "submit";
      form.append(url, tok, go);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        go.disabled = true;
        go.textContent = "Connecting…";
        guard(async () => { await client.connect(url.value, tok.value || null); });
      });
      parts.push(form);
    } else {
      const head = el("div", "server-head");
      const i = client.info!;
      const label = el("span", "", `Connected to ${client.url}`);
      const sub = el("small", "", i.ifcopenshell ? `IfcOpenShell ${i.ifcopenshell}: geometry is extracted on the server`
        : "IfcOpenShell not installed on the server: storing the viewer's geometry and properties");
      label.append(sub);
      head.append(label, btn("Disconnect", () => client.disconnect(), "btn small"));
      parts.push(head);

      const loaded = opts.loadedModels();
      const unsaved = loaded.filter((m) => !storedAs.has(m.id)).length;
      const save = btn(
        unsaved ? `Save ${unsaved} loaded model${unsaved > 1 ? "s" : ""} to server` : loaded.length ? "All loaded models are saved" : "No models loaded",
        () => guard(saveAll), "btn small primary save-btn",
      );
      save.disabled = unsaved === 0;
      parts.push(save, el("hr"));

      const title = el("div", "server-title");
      title.append(el("strong", "", `Stored on server (${models.length})`), btn("↻", () => refresh(), "icon-btn small", "Refresh", "Refresh list"));
      parts.push(title);
      if (!models.length) parts.push(el("p", "menu-note", "Nothing stored yet."));
      const list = el("div", "server-list");
      for (const m of models) {
        const row = el("div", "server-row");
        const info = el("div", "server-info");
        info.append(el("span", "model-name", m.name));
        info.lastElementChild!.setAttribute("title", m.name);
        const geo =
          m.extraction === "done" ? `${m.geometry_count.toLocaleString()} mesh${m.geometry_count === 1 ? "" : "es"}`
          : m.extraction === "pending" || m.extraction === "running" ? "extracting geometry…"
          : m.extraction === "failed" ? "extraction failed"
          : m.has_frag ? "viewer geometry" : "IFC only";
        const loadedHere = [...storedAs.values()].includes(m.id);
        const meta = el("small", "",
          `${fmtBytes(m.ifc_size)} · ${m.element_count.toLocaleString()} element${m.element_count === 1 ? "" : "s"} · ${geo}` +
          (loadedHere ? " · in viewer" : ""));
        if (m.extraction_error) meta.title = m.extraction_error;
        info.append(meta);
        row.append(
          info,
          btn("Open", () => guard(() => open(m)), "btn small", loadedHere ? "Already in the viewer; opens another copy" : `Open ${m.name}`),
          ...(m.geometry_count ? [btn("OBJ", () => guard(async () => {
            opts.progress(`Exporting ${m.name} as OBJ…`);
            saveBlob(await client.objBlob(m.id), m.name.replace(/\.ifc$/i, "") + ".obj");
          }), "btn small", "Download the server-extracted meshes as Wavefront OBJ")] : []),
          btn("×", () => guard(() => remove(m)), "icon-btn small", `Delete ${m.name} from the server`, `Delete ${m.name} from the server`),
        );
        list.append(row);
      }
      parts.push(list);
    }
    if (error) parts.push(el("p", "menu-error", error));
    menu.replaceChildren(...parts);
  }

  return {
    /** Call when local models change, so removed ones are forgotten. */
    sync(localIds: Iterable<string>) {
      const keep = new Set(localIds);
      for (const id of storedAs.keys()) if (!keep.has(id)) storedAs.delete(id);
      if (!menu.classList.contains("hidden")) render();
    },
    close: () => setOpen(false),
    isOpen: () => !menu.classList.contains("hidden"),
  };
}
