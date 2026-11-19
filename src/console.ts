// In-browser console: mirrors console.* output and lets the user run JavaScript.
// Import this module first so it captures logs from the rest of the app.

export type LogLevel = "log" | "info" | "warn" | "error" | "debug" | "input" | "result";
export interface LogEntry {
  time: number;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 2000;
export const logEntries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry | null) => void>();

// ---------- Formatting ----------
export function formatValue(
  value: unknown,
  depth = 2,
  top = true,
  seen = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return top ? (value as string) : JSON.stringify(value);
  if (t === "number" || t === "boolean" || t === "bigint" || t === "symbol") return String(value);
  if (t === "function") return `ƒ ${(value as Function).name || "anonymous"}()`;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? "\n" + value.stack.split("\n").slice(1).join("\n") : ""}`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${(value as unknown as ArrayLike<unknown>).length ?? value.byteLength})`;
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}${value.id ? "#" + value.id : ""}>`;
  }

  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  const ctor = (obj.constructor && obj.constructor.name) || "Object";
  if (depth <= 0) return Array.isArray(obj) ? `Array(${obj.length})` : ctor === "Object" ? "{…}" : ctor;
  seen.add(obj);
  const next = (v: unknown) => formatValue(v, depth - 1, false, seen);

  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, 50).map(next);
      if (obj.length > 50) items.push(`… ${obj.length - 50} more`);
      return `[${items.join(", ")}]`;
    }
    if (obj instanceof Map) {
      const items = [...obj.entries()].slice(0, 30).map(([k, v]) => `${next(k)} => ${next(v)}`);
      return `Map(${obj.size}) {${items.join(", ")}}`;
    }
    if (obj instanceof Set) {
      return `Set(${obj.size}) {${[...obj].slice(0, 30).map(next).join(", ")}}`;
    }
    const keys = Object.keys(obj);
    const shown = keys.slice(0, 40).map((k) => {
      let v: unknown;
      try { v = (obj as Record<string, unknown>)[k]; } catch { v = "[getter threw]"; }
      return `${k}: ${next(v)}`;
    });
    if (keys.length > 40) shown.push(`… ${keys.length - 40} more`);
    return `${ctor === "Object" ? "" : ctor + " "}{${shown.join(", ")}}`;
  } finally {
    seen.delete(obj);
  }
}

function push(level: LogLevel, text: string) {
  const entry: LogEntry = { time: Date.now(), level, text };
  logEntries.push(entry);
  if (logEntries.length > MAX_ENTRIES) logEntries.splice(0, logEntries.length - MAX_ENTRIES);
  listeners.forEach((l) => l(entry));
}

// ---------- Capture ----------
const native: Partial<Record<LogLevel, (...a: unknown[]) => void>> = {};
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  native[level] = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    native[level]!(...args);
    try {
      push(level, args.map((a) => formatValue(a)).join(" "));
    } catch {
      /* never let logging break the app */
    }
  };
}
window.addEventListener("error", (e) => push("error", e.error ? formatValue(e.error) : e.message));
window.addEventListener("unhandledrejection", (e) => push("error", "Unhandled rejection: " + formatValue(e.reason)));

export function logsAsText(): string {
  return logEntries
    .map((e) => `${new Date(e.time).toISOString()} [${e.level.toUpperCase()}] ${e.text}`)
    .join("\n");
}

// ---------- Evaluation ----------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

let scope: Record<string, unknown> = {};
export function setConsoleScope(s: Record<string, unknown>) {
  scope = s;
}

async function evaluate(code: string): Promise<unknown> {
  const names = Object.keys(scope);
  const values = names.map((n) => scope[n]);
  let fn: (...a: unknown[]) => Promise<unknown>;
  try {
    // Try as an expression first so `1 + 1` prints 2
    fn = new AsyncFunction(...names, `return (\n${code}\n);`);
  } catch {
    fn = new AsyncFunction(...names, code);
  }
  return fn(...values);
}

// ---------- UI ----------
export function mountConsole(panel: HTMLElement) {
  panel.innerHTML = `
    <div class="panel-head">
      <strong>Console</strong>
      <span class="console-filters">
        <label><input type="checkbox" data-level="log" checked>Log</label>
        <label><input type="checkbox" data-level="warn" checked>Warn</label>
        <label><input type="checkbox" data-level="error" checked>Error</label>
      </span>
      <span class="spacer"></span>
      <button class="btn small" data-act="clear" title="Clear console">Clear</button>
      <button class="icon-btn" data-act="close" aria-label="Close">×</button>
    </div>
    <div class="console-out" tabindex="0"></div>
    <form class="console-in">
      <span class="prompt">›</span>
      <textarea rows="1" spellcheck="false" autocomplete="off"
        placeholder="Run JavaScript — try: help()"></textarea>
    </form>`;

  const out = panel.querySelector<HTMLElement>(".console-out")!;
  const form = panel.querySelector<HTMLFormElement>(".console-in")!;
  const input = form.querySelector("textarea")!;
  const hidden = new Set<string>();

  const groupOf = (l: LogLevel) => (l === "warn" ? "warn" : l === "error" ? "error" : "log");

  function row(e: LogEntry) {
    const div = document.createElement("div");
    div.className = `line ${e.level}`;
    div.dataset.group = groupOf(e.level);
    if (hidden.has(div.dataset.group)) div.hidden = true;
    const time = document.createElement("time");
    time.textContent = new Date(e.time).toLocaleTimeString();
    const msg = document.createElement("span");
    msg.textContent = (e.level === "input" ? "› " : e.level === "result" ? "← " : "") + e.text;
    div.append(time, msg);
    return div;
  }

  function render(e: LogEntry | null) {
    if (e === null) {
      out.replaceChildren(...logEntries.map(row));
    } else {
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
      out.append(row(e));
      while (out.childElementCount > MAX_ENTRIES) out.firstElementChild!.remove();
      if (!atBottom) return;
    }
    out.scrollTop = out.scrollHeight;
  }
  listeners.add(render);
  render(null);

  panel.querySelectorAll<HTMLInputElement>(".console-filters input").forEach((cb) =>
    cb.addEventListener("change", () => {
      const g = cb.dataset.level!;
      cb.checked ? hidden.delete(g) : hidden.add(g);
      out.querySelectorAll<HTMLElement>(`.line[data-group="${g}"]`).forEach((l) => (l.hidden = !cb.checked));
    }),
  );

  panel.querySelector('[data-act="clear"]')!.addEventListener("click", clear);
  function clear() {
    logEntries.length = 0;
    out.replaceChildren();
  }

  const history: string[] = [];
  let hIndex = 0;

  async function run(code: string) {
    if (!code.trim()) return;
    history.push(code);
    hIndex = history.length;
    push("input", code);
    if (code.trim() === "clear()" || code.trim() === "clear") return clear();
    try {
      const result = await evaluate(code);
      push("result", formatValue(result, 1, false));
    } catch (err) {
      push("error", formatValue(err));
    }
  }

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep viewer shortcuts out of the console
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const code = input.value;
      input.value = "";
      autosize();
      run(code);
    } else if (e.key === "ArrowUp" && !input.value.slice(0, input.selectionStart).includes("\n")) {
      if (hIndex > 0) {
        e.preventDefault();
        input.value = history[--hIndex];
        autosize();
      }
    } else if (e.key === "ArrowDown" && !input.value.slice(input.selectionEnd).includes("\n")) {
      if (hIndex < history.length) {
        e.preventDefault();
        hIndex++;
        input.value = history[hIndex] ?? "";
        autosize();
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clear();
    }
  });
  form.addEventListener("submit", (e) => e.preventDefault());

  return { focus: () => input.focus(), run };
}
