// In-browser console: mirrors console.* output and lets the user run JavaScript.
// Import this module first so it captures logs from the rest of the app.

export type LogLevel = "log" | "info" | "warn" | "error" | "debug" | "input" | "result";
export type Lang = "js" | "py";
export interface LogEntry {
  time: number;
  level: LogLevel;
  text: string;
  lang?: Lang;
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
  if (value instanceof Error && value.name === "PythonError") return value.message;
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

const inputPrefix = (e: LogEntry) =>
  e.level === "input" ? (e.lang === "py" ? ">>> " : "› ") : e.level === "result" ? "← " : "";

export function push(level: LogLevel, text: string, lang?: Lang) {
  const entry: LogEntry = { time: Date.now(), level, text, lang };
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
    .map((e) => `${new Date(e.time).toISOString()} [${e.level.toUpperCase()}] ${inputPrefix(e)}${e.text}`)
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

// Same rules as python.ts#pythonNeedsMoreInput, kept here so Enter works before Python has loaded.
function pyNeedsMore(code: string): boolean {
  const lines = code.split("\n");
  const last = lines[lines.length - 1];
  if (last.trimEnd().endsWith(":")) return true;
  if (lines.length > 1 && last.trim() !== "") return true;
  let depth = 0;
  for (const ch of code.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "").replace(/#.*$/gm, "")) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  return depth > 0;
}

// ---------- UI ----------
export function mountConsole(panel: HTMLElement) {
  panel.innerHTML = `
    <div class="panel-head">
      <strong>Console</strong>
      <span class="seg" role="radiogroup" aria-label="Language">
        <button type="button" role="radio" data-lang="js">JS</button>
        <button type="button" role="radio" data-lang="py">Python</button>
      </span>
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
      <textarea rows="1" spellcheck="false" autocomplete="off"></textarea>
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
    msg.textContent = inputPrefix(e) + e.text;
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

  const prompt = panel.querySelector<HTMLElement>(".prompt")!;
  const pyHost = {
    get scope() { return scope; },
    out: (level: "log" | "info" | "warn" | "error", text: string) => push(level, text),
  };
  let lang: Lang = "js";
  try { if (localStorage.getItem("console-lang") === "py") lang = "py"; } catch { /* storage blocked */ }

  function setLang(l: Lang) {
    lang = l;
    try { localStorage.setItem("console-lang", l); } catch { /* storage blocked */ }
    panel.querySelectorAll<HTMLElement>("[data-lang]").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.lang === l)),
    );
    prompt.textContent = l === "py" ? ">>>" : "›";
    input.placeholder = l === "py"
      ? "Run Python — try: await dataframe()"
      : "Run JavaScript — try: help()";
    if (l === "py") import("./python").then((m) => m.loadPython(pyHost)).catch(reportLoadError);
  }
  function reportLoadError(err: unknown) {
    push("error", "Could not load Python: " + formatValue(err) +
      "\nPython is downloaded from cdn.jsdelivr.net, so this needs an internet connection.");
  }
  panel.querySelectorAll<HTMLElement>("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => { setLang(b.dataset.lang as Lang); input.focus(); }),
  );

  const history: { code: string; lang: Lang }[] = [];
  let hIndex = 0;

  async function run(code: string, as: Lang = lang) {
    if (!code.trim()) return;
    history.push({ code, lang: as });
    hIndex = history.length;
    push("input", code, as);
    if (as === "js" && (code.trim() === "clear()" || code.trim() === "clear")) return clear();
    input.disabled = true;
    try {
      if (as === "py") {
        const py = await import("./python");
        const result = await py.runPython(code, pyHost);
        if (result !== undefined) push("result", result);
      } else {
        const result = await evaluate(code);
        push("result", formatValue(result, 1, false));
      }
    } catch (err) {
      push("error", formatValue(err));
    } finally {
      input.disabled = false;
      input.focus();
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
      if (lang === "py" && pyNeedsMore(input.value.slice(0, input.selectionStart)) &&
          input.selectionStart === input.value.length) {
        // Continue the block like the Python REPL, keeping indentation
        const lastLine = input.value.split("\n").pop()!;
        let indent = lastLine.match(/^\s*/)![0];
        if (lastLine.trimEnd().endsWith(":")) indent += "    ";
        input.setRangeText("\n" + indent, input.selectionStart, input.selectionEnd, "end");
        autosize();
        return;
      }
      const code = lang === "py" ? input.value.replace(/\s+$/, "") : input.value;
      input.value = "";
      autosize();
      run(code);
    } else if (e.key === "ArrowUp" && !input.value.slice(0, input.selectionStart).includes("\n")) {
      if (hIndex > 0) {
        e.preventDefault();
        input.value = history[--hIndex].code;
        autosize();
      }
    } else if (e.key === "ArrowDown" && !input.value.slice(input.selectionEnd).includes("\n")) {
      if (hIndex < history.length) {
        e.preventDefault();
        hIndex++;
        input.value = history[hIndex]?.code ?? "";
        autosize();
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clear();
    }
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  // Tab inserts spaces (needed for Python indentation)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      input.setRangeText("    ", input.selectionStart, input.selectionEnd, "end");
    }
  });
  setLang(lang);

  return { focus: () => input.focus(), run, setLang };
}
