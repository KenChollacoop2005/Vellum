// Animated captures of four sheets for the README
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { solveStructure, PRESETS } from "../sheets/01-frame/model.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const FPS = 15; // gif frame rate
const WIDTH = 600; // gif width in pixels
const DPR = 2; // capture pixel ratio
const MARGIN = 16; // crop margin in css pixels
const LABEL_BOX = [150, 26]; // bottom left canvas label, css pixels
const AUTO_DEFL = 0.08; // frame sheet auto deflection fraction
const INKS = ["#121314", "#3B3E42", "#7C7F84", "#B23A2E", "#2C5B86", "#3E6B48", "#A4D4E6", "#B8B2A4"]; // design colors over vellum
const MIX_LEVELS = 15; // blend steps from vellum to each ink
const SMOOTH = 8; // lift samples each side in the moving average
const FIELD_MARGIN = 6; // wind crop margin in css pixels

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
    try {
      const body = await readFile(join(ROOT, path || "index.html"));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// Page hook: worker handles and message waits
function hook() {
  const Base = window.Worker;
  window.__workers = [];
  window.__wait = [];
  window.Worker = class extends Base {
    constructor(...a) {
      super(...a);
      window.__workers.push(this);
      this.addEventListener("message", (e) => {
        if (e.data.type === "setup" || e.data.type === "ready") window.__ready = e.data;
        if (e.data.type === "error") window.__error = e.data.message;
        for (const f of window.__wait.splice(0)) f(e.data);
      });
    }
  };
  window.__next = (types) => new Promise((resolve) => {
    const f = (d) => (types.includes(d.type) || d.type === "error" ? setTimeout(() => resolve(d), 0) : window.__wait.push(f));
    window.__wait.push(f);
  });
}

// Canvas frame plus bounding box of the drawing
async function grab(page, skipLabel) {
  return page.evaluate(([skip, lw, lh]) => {
    const c = document.querySelector("canvas.main");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const dpr = window.devicePixelRatio;
    const v = [244, 241, 232], g = [164, 212, 230];
    const seg = g.map((x, i) => x - v[i]), len2 = seg.reduce((a, x) => a + x * x, 0);
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (skip && x < lw * dpr && y > c.height - lh * dpr) continue;
      const o = (y * c.width + x) * 4;
      const p = [d[o] - v[0], d[o + 1] - v[1], d[o + 2] - v[2]];
      const t = Math.max(0, Math.min(1, (p[0] * seg[0] + p[1] * seg[1] + p[2] * seg[2]) / len2));
      if (Math.hypot(p[0] - t * seg[0], p[1] - t * seg[1], p[2] - t * seg[2]) < 28) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { url: c.toDataURL("image/png"), box: [x0, y0, x1, y1], size: [c.width, c.height] };
  }, [skipLabel, ...LABEL_BOX]);
}

class Frames {
  constructor(dir) { this.dir = dir; this.n = 0; this.box = null; this.size = null; }
  async add(shot, useBox = true) {
    const file = join(this.dir, `f${String(this.n++).padStart(5, "0")}.png`);
    await writeFile(file, Buffer.from(shot.url.split(",")[1], "base64"));
    this.size = shot.size;
    if (useBox && shot.box[2] >= 0) {
      const [a, b, c, d] = shot.box;
      this.box = this.box ? [Math.min(this.box[0], a), Math.min(this.box[1], b), Math.max(this.box[2], c), Math.max(this.box[3], d)] : [a, b, c, d];
    }
    this.last = file;
  }
  async hold(count) {
    for (let k = 0; k < count; k++) await copyFile(this.last, join(this.dir, `f${String(this.n++).padStart(5, "0")}.png`));
  }
}

// Crop box with margin and even sizes
function cropOf(box, size, margin = MARGIN * DPR) {
  const x = Math.max(0, Math.floor(box[0] - margin)), y = Math.max(0, Math.floor(box[1] - margin));
  let w = Math.min(size[0] - x, Math.ceil(box[2] + margin) - x), h = Math.min(size[1] - y, Math.ceil(box[3] + margin) - y);
  w -= w % 2;
  h -= h % 2;
  return { x, y, w, h };
}

// Fixed palette: vellum blended toward each design color
async function designPalette(file) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const v = hex("#F4F1E8");
  const seen = new Set(), cols = [];
  const add = (c) => { const k = c.join(); if (!seen.has(k)) { seen.add(k); cols.push(c); } };
  add(v);
  for (const ink of INKS.map(hex)) {
    for (let k = 1; k <= MIX_LEVELS; k++) add(v.map((a, i) => Math.round(a + (ink[i] - a) * (k / MIX_LEVELS))));
  }
  for (const t of [0.04, 0.08, 0.1, 0.14, 0.19, 0.27]) add(v.map((a, i) => Math.round(a + (hex("#3B3E42")[i] - a) * t)));
  while (cols.length < 256) cols.push(v);
  await writeFile(file, Buffer.concat([Buffer.from("P6\n16 16\n255\n"), Buffer.from(cols.slice(0, 256).flat())]));
}

async function encode(frames, crop, out, { colors = 256, dither = "sierra2_4a", palette = "" } = {}) {
  const pre = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${WIDTH}:-2:flags=lanczos`;
  const args = ["-y", "-v", "error", "-framerate", String(FPS), "-i", join(frames.dir, "f%05d.png")];
  let vf;
  if (palette === "design") {
    const pal = join(frames.dir, "palette.ppm");
    await designPalette(pal);
    args.push("-i", pal);
    vf = `[0:v]${pre}[a];[a][1:v]paletteuse=dither=${dither}:diff_mode=rectangle`;
  } else {
    vf = `${pre},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`;
  }
  execFileSync("ffmpeg", [...args, "-filter_complex", vf, "-fflags", "+bitexact", "-loop", "0", out]);
}

async function open(page, path, state) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  if (state) {
    await page.evaluate(async (s) => (await import("/core/sheet.js")).saveState(s), state);
    await page.reload({ waitUntil: "networkidle" });
  }
  await page.evaluate(() => document.fonts.ready);
}

// Equilateral triangle, apex upstream, as painted cells
function triangleCells(nx, ny, side) {
  const cx = Math.round(nx / 4), cy = ny / 2, depth = (side * Math.sqrt(3)) / 2;
  const cells = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const x = i + 0.5 - (cx - depth / 2), y = j + 0.5 - cy;
    if (x >= 0 && x <= depth && Math.abs(y) <= (x / depth) * (side / 2)) cells.push(j * nx + i);
  }
  return cells;
}

// Wind tunnel
async function wind(page, frames, o) {
  const tri = Number(o.tri) > 0;
  const state = { shape: tri ? "draw" : o.shape, angle: Number(o.angle), code: o.code, re: Number(o.re), grid: o.grid, mode: o.mode,
    speed: o.speed, view: o.view, tracers: o.tracers === "1", window: 5000, cells: [] };
  if (tri) {
    const [nx, ny] = { coarse: [200, 80], medium: [300, 120], fine: [420, 168] }[o.grid];
    state.cells = triangleCells(nx, o.mode === "tunnel" ? ny + 2 : ny, Number(o.tri));
  }
  await open(page, "sheets/04-wind-tunnel/index.html", state);
  await page.waitForFunction(() => window.__ready || window.__error);
  const info = await page.evaluate(() => window.__error || window.__ready.info);
  if (typeof info === "string") throw new Error(info);
  const step = (n) => page.evaluate(async (k) => {
    const p = window.__next(["frame"]);
    window.__workers[0].postMessage({ cmd: "step", steps: k });
    const d = await p;
    return d.type === "error" ? { err: d.message } : { step: d.step, history: d.history };
  }, n);
  // Warm up, then record lift
  const lift = new Map();
  const warm = Math.round(Number(o.flows) * info.nx / info.u);
  const span = Math.round(Number(o.measure) * info.nx / info.u);
  for (let s = 0; s < warm + span;) {
    const r = await step(2000);
    if (r.err) throw new Error(r.err);
    s = r.step;
    for (const [k, , cl] of r.history) lift.set(k, cl);
  }
  // Shedding period from the lift autocorrelation
  const raw = [...lift].filter(([k]) => k > warm).sort((p, q) => p[0] - q[0]);
  const x = raw.map((_, i) => {
    const win = raw.slice(Math.max(0, i - SMOOTH), i + SMOOTH + 1);
    return win.reduce((acc, r) => acc + r[1], 0) / win.length;
  });
  const mean = x.reduce((acc, v) => acc + v, 0) / x.length;
  const y = x.map((v) => v - mean);
  const corr = (lag) => { let c = 0; for (let i = 0; i + lag < y.length; i++) c += y[i] * y[i + lag]; return c / (y.length - lag); };
  let lag = 1;
  while (lag < y.length / 2 && corr(lag) > 0) lag++;
  while (lag < y.length / 2 && corr(lag) <= 0) lag++;
  let best = lag;
  while (best < y.length / 2 && corr(best + 1) >= corr(best)) best++;
  const dt = raw[1][0] - raw[0][0];
  const T = best * dt;
  const quality = corr(best) / corr(0);
  const per = Math.max(10, Math.round(T / Number(o.fpc) / 10) * 10);
  const fpc = T / per;
  console.log(`wind: L ${info.D}, U ${info.u.toFixed(4)}, tau ${info.tau.toFixed(4)}, period ${T} steps, repeat ${quality.toFixed(2)}, `
    + `lift amp ${Math.sqrt(2 * corr(0)).toFixed(3)} mean ${mean.toFixed(3)}, ${per} steps per frame, ${fpc.toFixed(1)} frames per cycle`);
  // Field crop from the sheet's own view fit
  const r = await page.evaluate(() => { const b = document.querySelector("canvas.main").getBoundingClientRect(); return [b.width, b.height]; });
  const [w, h] = [Math.round(r[0]), Math.round(r[1])];
  const sc = Math.min((w - 24) / info.nx, (h - 24) / (1.12 * info.ny));
  const ox = w / 2 - (info.nx / 2) * sc, oy = h / 2 + (0.44 * info.ny) * sc;
  const left = ox + Math.max(0, info.cx - Number(o.upstream) * info.D) * sc;
  const m = FIELD_MARGIN;
  const box = [left * DPR, (oy - info.ny * sc - m) * DPR, (ox + info.nx * sc + m) * DPR, (oy + m) * DPR].map(Math.round);
  // Whole cycles plus frames to crossfade
  const n = Math.round(Number(o.cycles) * fpc), fade = Number(o.fade);
  const shots = [];
  for (let k = 0; k < n + fade; k++) {
    const q = await step(per);
    if (q.err) throw new Error(q.err);
    shots.push(await page.evaluate(() => document.querySelector("canvas.main").toDataURL("image/png")));
  }
  const size = await page.evaluate(() => { const c = document.querySelector("canvas.main"); return [c.width, c.height]; });
  for (let k = 0; k < n; k++) {
    let url = shots[k];
    if (k < fade) {
      url = await page.evaluate(async ([under, over, t]) => {
        const load = (u) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = u; });
        const [a, b] = await Promise.all([load(under), load(over)]);
        const c = document.createElement("canvas");
        c.width = a.width;
        c.height = a.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(a, 0, 0);
        ctx.globalAlpha = t;
        ctx.drawImage(b, 0, 0);
        return c.toDataURL("image/png");
      }, [shots[k], shots[n + k], 1 - (k + 1) / (fade + 1)]);
    }
    await frames.add({ url, size }, false);
  }
  frames.box = box;
  return { margin: 0, T, per, cycles: +(n / fpc).toFixed(2), fade };
}

// Jansen leg, four legs, one crank turn
async function jansen(page, frames, o) {
  await open(page, "sheets/07-linkage/index.html");
  await page.locator("#presets button", { hasText: "Jansen" }).click();
  for (const id of ["pair", "mirror", "trace"]) if (!(await page.isChecked(`#${id}`))) await page.check(`#${id}`);
  const n = Number(o.frames);
  for (let k = 0; k < n; k++) {
    await page.evaluate((v) => {
      const r = document.getElementById("theta-range");
      r.value = String(v);
      r.dispatchEvent(new Event("input"));
    }, (Number(o.start) + (360 * k) / n) % 360);
    await frames.add(await grab(page, true));
  }
  return { n };
}

// Topology optimizer, gray start to converged
async function topology(page, frames, o) {
  await open(page, "sheets/03-topology/index.html");
  await page.locator("#presets button", { hasText: o.preset }).click();
  await page.waitForFunction(() => window.__ready);
  if (o.mesh) {
    await page.evaluate(() => { window.__ready = null; });
    await page.selectOption("#mesh", o.mesh);
    await page.waitForFunction(() => window.__ready);
  }
  await page.waitForTimeout(200);
  const shots = [await grab(page, true)];
  let done = false, it = 0;
  while (!done) {
    const d = await page.evaluate(async () => {
      const p = window.__next(["iter"]);
      window.__workers[0].postMessage({ cmd: "step" });
      const m = await p;
      return m.type === "error" ? { err: m.message } : { done: m.done, c: m.rec.c };
    });
    if (d.err) throw new Error(d.err);
    done = d.done;
    it++;
    shots.push(await grab(page, true));
  }
  // Slow start, faster finish
  const keep = Number(o.frames);
  const pick = shots.length <= keep ? shots.map((_, i) => i)
    : [...new Set(Array.from({ length: keep }, (_, k) => Math.round((shots.length - 1) * (k / (keep - 1)) ** Number(o.ease))))];
  await frames.add(shots[0]);
  await frames.hold(Math.round(FPS * Number(o.start)) - 1);
  for (const i of pick.slice(1)) await frames.add(shots[i]);
  await frames.hold(Math.round(FPS * Number(o.hold)));
  return { iterations: it, used: pick.length };
}

// Frame solver, deflection eases in and out
async function frame(page, frames, o) {
  await open(page, "sheets/01-frame/index.html");
  await page.locator("#presets button", { hasText: o.preset }).click();
  await page.selectOption("#field", "axial");
  const model = Object.values(PRESETS).find((p) => p.label.includes(o.preset)).model;
  const res = solveStructure(model);
  const xs = model.nodes.map((n) => n.x), ys = model.nodes.map((n) => n.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const raw = (AUTO_DEFL * size) / res.maxDeflection.value;
  const full = Number(o.scale) || raw;
  const setScale = (v) => page.evaluate((x) => {
    const i = document.getElementById("dscale");
    i.value = String(x);
    i.dispatchEvent(new Event("change"));
  }, v);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const n = Math.round(FPS * Number(o.move));
  const add = async (t) => { await setScale(Math.max(1e-9, full * ease(t))); await frames.add(await grab(page, true)); };
  await add(0);
  await frames.hold(Math.round(FPS * Number(o.rest)) - 1);
  for (let k = 1; k <= n; k++) await add(k / n);
  await frames.hold(Math.round(FPS * Number(o.hold)));
  for (let k = n - 1; k >= 1; k--) await add(k / n);
  return { scale: full };
}

const JOBS = {
  wind: { run: wind, out: "wind.gif", opts: { shape: "plate", angle: "45", code: "0012", re: "450", grid: "fine", mode: "open", speed: "accurate",
    view: "vorticity", tracers: "0", tri: "36", flows: "4", measure: "2", fpc: "26", cycles: "3", fade: "6", upstream: "1.2", vw: "1440", dither: "none", colors: "64" } },
  jansen: { run: jansen, out: "jansen.gif", opts: { frames: "72", start: "0", vw: "1100", dither: "none", palette: "design" } },
  topology: { run: topology, out: "topology.gif", opts: { preset: "MBB", mesh: "", frames: "90", ease: "1.6", start: "0.6", hold: "1", vw: "1100", dither: "none" } },
  frame: { run: frame, out: "frame.gif", opts: { preset: "Pratt", scale: "", rest: "0.6", move: "1.4", hold: "1.6", vw: "1100", dither: "none" } },
};

const args = process.argv.slice(2);
const names = args.filter((a) => !a.includes("="));
const extra = Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
try {
  for (const name of names.length ? names : Object.keys(JOBS)) {
    const job = JOBS[name];
    const o = { ...job.opts, ...extra };
    const dir = await mkdtemp(join(tmpdir(), "vellum-gif-"));
    const context = await browser.newContext({ viewport: { width: Number(o.vw), height: 900 }, deviceScaleFactor: DPR, reducedMotion: "reduce" });
    await context.addInitScript(hook);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`${name} page error: ${e}`));
    const frames = new Frames(dir);
    const t0 = Date.now();
    const meta = await job.run(page, frames, o);
    const out = o.out || join(ROOT, "media", job.out);
    await encode(frames, cropOf(frames.box, frames.size, meta.margin ?? MARGIN * DPR), out, { colors: Number(o.colors) || 256, dither: o.dither, palette: o.palette });
    const kb = (await stat(out)).size / 1024;
    console.log(`${name}: ${frames.n} frames, ${(frames.n / FPS).toFixed(2)} s, ${kb.toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(0)} s to make`, JSON.stringify({ ...meta, info: undefined }));
    if (o.keep) console.log(`frames kept in ${dir}, crop ${JSON.stringify(cropOf(frames.box, frames.size, meta.margin ?? MARGIN * DPR))}`);
    else await rm(dir, { recursive: true });
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
