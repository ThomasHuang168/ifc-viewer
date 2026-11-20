// Client for the optional Python backend (see backend/README.md).
// The viewer works without it; when connected, models can be stored and reopened.

export interface ServerInfo {
  ok: boolean;
  service: string;
  version: string;
  ifcopenshell: string | null;
  auth: boolean;
}

export interface ServerModel {
  id: string;
  name: string;
  created_at: number;
  ifc_size: number;
  frag_size: number | null;
  has_frag: boolean;
  schema: string | null;
  element_count: number;
  geometry_count: number;
  extraction: "none" | "pending" | "running" | "done" | "failed" | "unavailable";
  extraction_error: string | null;
}

const STORAGE_KEY = "ifc-viewer-server";

function normalize(url: string) {
  const u = new URL(url.trim(), location.href);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.search = "";
  u.hash = "";
  return u.href;
}

export function createServerClient() {
  let base: string | null = null;
  let token: string | null = null;
  let info: ServerInfo | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  async function request(path: string, init: RequestInit = {}, b = base, t = token) {
    if (!b) throw new Error("Not connected to a server");
    const headers = new Headers(init.headers);
    if (t) headers.set("Authorization", `Bearer ${t}`);
    const res = await fetch(b + path, { ...init, headers });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch { /* not JSON */ }
      throw new Error(detail);
    }
    return res;
  }

  async function probe(url: string, tok: string | null, timeoutMs = 4000): Promise<ServerInfo> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await request("api/health", { signal: ctrl.signal }, url, tok);
      const j = (await res.json()) as ServerInfo;
      if (j?.service !== "ifc-viewer-backend") throw new Error("That address is not an IFC Viewer backend");
      if (j.auth) await request("api/models", { signal: ctrl.signal }, url, tok); // check the token
      return j;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error("No answer from the server");
      if (e instanceof TypeError) throw new Error("Could not reach the server (is it running, and does it allow this site?)");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const client = {
    get connected() { return info !== null; },
    get url() { return base; },
    get info() { return info; },
    onChange(fn: () => void) { listeners.add(fn); },

    async connect(url: string, tok: string | null, remember = true) {
      const b = normalize(url);
      const i = await probe(b, tok || null);
      base = b;
      token = tok || null;
      info = i;
      if (remember) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: b, token })); } catch { /* storage blocked */ }
      }
      emit();
      return i;
    },

    disconnect() {
      base = token = null;
      info = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
      emit();
    },

    /** ?server=URL, then the last server used, then the site's own origin (when the backend serves the viewer). */
    async autoConnect() {
      const param = new URLSearchParams(location.search).get("server");
      let saved: { url?: string; token?: string } = {};
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"); } catch { /* ignore */ }
      const candidates: [string, string | null, boolean][] = [];
      if (param) candidates.push([param, saved.url && normalize(param) === saved.url ? saved.token ?? null : null, true]);
      if (saved.url) candidates.push([saved.url, saved.token ?? null, true]);
      if (location.protocol.startsWith("http")) candidates.push([new URL("./", location.href).href, null, false]);
      for (const [url, tok, remember] of candidates) {
        try {
          return await client.connect(url, tok, remember);
        } catch { /* try the next one */ }
      }
      return null;
    },

    async list(): Promise<ServerModel[]> {
      return (await request("api/models")).json();
    },

    async upload(m: { name: string; ifc: Uint8Array; frag?: ArrayBuffer; elements?: unknown[] }): Promise<ServerModel> {
      const form = new FormData();
      form.append("name", m.name);
      form.append("ifc", new Blob([m.ifc as Uint8Array<ArrayBuffer>]), m.name);
      if (m.frag) form.append("frag", new Blob([m.frag]), "model.frag");
      if (m.elements) form.append("elements", new Blob([JSON.stringify(m.elements)], { type: "application/json" }), "elements.json");
      return (await request("api/models", { method: "POST", body: form })).json();
    },

    async file(id: string, kind: "ifc" | "frag"): Promise<ArrayBuffer> {
      return (await request(`api/models/${encodeURIComponent(id)}/${kind}`)).arrayBuffer();
    },

    async objBlob(id: string): Promise<Blob> {
      return (await request(`api/models/${encodeURIComponent(id)}/geometry.obj`)).blob();
    },

    async remove(id: string) {
      await request(`api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    /** Raw access for the console, e.g. await server.get("api/elements?prop=FireRating&value=2HR") */
    async get(path: string) {
      const res = await request(path.replace(/^\//, ""));
      return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
    },
  };
  return client;
}

export type ServerClient = ReturnType<typeof createServerClient>;
