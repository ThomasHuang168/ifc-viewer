// Live resource monitor: frame rate, memory, GPU load, storage and loaded models.
import type * as THREE from "three";

export interface ResourceSnapshot {
  time: string;
  fps: number;
  frameMs: number;
  jsHeapUsed?: number;
  jsHeapTotal?: number;
  jsHeapLimit?: number;
  deviceMemoryGB?: number;
  cpuCores: number;
  gpu: string;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  storageUsed?: number;
  storageQuota?: number;
  models: number;
  modelBytes: number;
  userAgent: string;
}

export const fmtBytes = (b?: number) => {
  if (b === undefined || !isFinite(b)) return "n/a";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const fmtNum = (n: number) => n.toLocaleString();

type PerfMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };

function gpuName(renderer: THREE.WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return "unknown";
  }
}

class Sparkline {
  private data: number[] = [];
  constructor(private canvas: HTMLCanvasElement, private size = 120) {}
  push(v: number) {
    this.data.push(v);
    if (this.data.length > this.size) this.data.shift();
    this.draw();
  }
  private draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.data.length < 2) return;
    const max = Math.max(...this.data) * 1.1 || 1;
    const accent = getComputedStyle(c).color;
    ctx.beginPath();
    const n = this.data.length;
    const xAt = (i: number) => w - ((n - 1 - i) / (this.size - 1)) * w; // newest sample on the right
    this.data.forEach((v, i) => {
      const x = xAt(i);
      const y = h - (v / max) * (h - 2) - 1;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(xAt(0), h);
    ctx.closePath();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export function createResourceMonitor(opts: {
  panel: HTMLElement;
  renderer: THREE.WebGLRenderer;
  getModelStats: () => { models: number; bytes: number };
}) {
  const { panel, renderer } = opts;
  const gpu = gpuName(renderer);
  const nav = navigator as Navigator & { deviceMemory?: number };

  panel.innerHTML = `
    <div class="panel-head">
      <strong>Resources</strong>
      <span class="live-dot" title="Updating live"></span>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="close" aria-label="Close">×</button>
    </div>
    <div class="res-body">
      <div class="res-metric">
        <div class="res-row"><span>Frame rate</span><b data-k="fps">–</b></div>
        <canvas class="spark" data-spark="fps"></canvas>
      </div>
      <div class="res-metric">
        <div class="res-row"><span>JS heap</span><b data-k="heap">–</b></div>
        <div class="bar"><i data-bar="heap"></i></div>
        <canvas class="spark" data-spark="heap"></canvas>
      </div>
      <div class="res-metric">
        <div class="res-row"><span>Site storage</span><b data-k="storage">–</b></div>
        <div class="bar"><i data-bar="storage"></i></div>
      </div>
      <table class="res-table">
        <tr><td>Draw calls / frame</td><td data-k="calls">–</td></tr>
        <tr><td>Triangles / frame</td><td data-k="tris">–</td></tr>
        <tr><td>GPU geometries</td><td data-k="geoms">–</td></tr>
        <tr><td>GPU textures</td><td data-k="tex">–</td></tr>
        <tr><td>Models loaded</td><td data-k="models">–</td></tr>
        <tr><td>Model data</td><td data-k="mbytes">–</td></tr>
        <tr><td>CPU threads</td><td>${navigator.hardwareConcurrency ?? "n/a"}</td></tr>
        <tr><td>Device memory</td><td>${nav.deviceMemory ? "≥ " + nav.deviceMemory + " GB" : "n/a"}</td></tr>
        <tr><td>GPU</td><td class="gpu"></td></tr>
      </table>
      <p class="res-note" data-k="note"></p>
    </div>`;
  panel.querySelector<HTMLElement>(".gpu")!.textContent = gpu;

  const q = (k: string) => panel.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  const bar = (k: string) => panel.querySelector<HTMLElement>(`[data-bar="${k}"]`)!;
  const fpsSpark = new Sparkline(panel.querySelector('[data-spark="fps"]')!);
  const heapSpark = new Sparkline(panel.querySelector('[data-spark="heap"]')!);

  // Renderer stats are reset each render; accumulate across the frame instead.
  renderer.info.autoReset = false;

  let frames = 0;
  let last = performance.now();
  let frameTimeSum = 0;
  let prevFrame = last;
  const snap: ResourceSnapshot = {
    time: "", fps: 0, frameMs: 0, cpuCores: navigator.hardwareConcurrency ?? 0,
    deviceMemoryGB: nav.deviceMemory, gpu, drawCalls: 0, triangles: 0, geometries: 0,
    textures: 0, models: 0, modelBytes: 0, userAgent: navigator.userAgent,
  };

  const tick = () => {
    const now = performance.now();
    frames++;
    frameTimeSum += now - prevFrame;
    prevFrame = now;

    // Capture per-frame render stats, then reset for the next frame
    const info = renderer.info;
    if (info.render.calls > 0) {
      snap.drawCalls = info.render.calls;
      snap.triangles = info.render.triangles;
    }
    info.reset();

    if (now - last >= 500) {
      snap.fps = (frames * 1000) / (now - last);
      snap.frameMs = frameTimeSum / frames;
      frames = 0;
      frameTimeSum = 0;
      last = now;
      update();
    }
    requestAnimationFrame(tick);
  };

  function update() {
    snap.time = new Date().toISOString();
    snap.geometries = renderer.info.memory.geometries;
    snap.textures = renderer.info.memory.textures;
    const m = opts.getModelStats();
    snap.models = m.models;
    snap.modelBytes = m.bytes;

    const mem = (performance as Performance & { memory?: PerfMemory }).memory;
    if (mem) {
      snap.jsHeapUsed = mem.usedJSHeapSize;
      snap.jsHeapTotal = mem.totalJSHeapSize;
      snap.jsHeapLimit = mem.jsHeapSizeLimit;
    }

    if (panel.classList.contains("hidden")) return;
    q("fps").textContent = `${snap.fps.toFixed(0)} fps · ${snap.frameMs.toFixed(1)} ms`;
    fpsSpark.push(snap.fps);
    if (mem) {
      q("heap").textContent = `${fmtBytes(mem.usedJSHeapSize)} / ${fmtBytes(mem.jsHeapSizeLimit)}`;
      bar("heap").style.width = `${(100 * mem.usedJSHeapSize) / mem.jsHeapSizeLimit}%`;
      heapSpark.push(mem.usedJSHeapSize);
    } else {
      q("heap").textContent = "n/a";
      q("note").textContent = "JS heap size is only reported by Chromium-based browsers.";
    }
    q("calls").textContent = fmtNum(snap.drawCalls);
    q("tris").textContent = fmtNum(snap.triangles);
    q("geoms").textContent = fmtNum(snap.geometries);
    q("tex").textContent = fmtNum(snap.textures);
    q("models").textContent = fmtNum(snap.models);
    q("mbytes").textContent = fmtBytes(snap.modelBytes);
  }

  async function updateStorage() {
    try {
      const est = await navigator.storage?.estimate?.();
      if (!est) throw new Error();
      snap.storageUsed = est.usage;
      snap.storageQuota = est.quota;
      q("storage").textContent = `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`;
      bar("storage").style.width = `${(100 * (est.usage ?? 0)) / (est.quota || 1)}%`;
    } catch {
      q("storage").textContent = "n/a";
    }
  }
  updateStorage();
  setInterval(updateStorage, 5000);
  requestAnimationFrame(tick);

  return { snapshot: (): ResourceSnapshot => ({ ...snap }) };
}
