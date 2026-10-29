// Sheet 04 interface
import { initSheet, loadState, saveState, wireCopyLink, setAnswer, fillTable, toCsv, download, downloadCanvas, el, reducedMotion } from "../../core/sheet.js";
import { readColors, fitCanvas, createView, fitView, toScreen, attachPanZoom, line, polyline, text, arrow, alpha } from "../../core/draw.js";
import { fixed, fmt } from "../../core/units.js";
import { GRIDS, OBSTACLE, TAU_MIN } from "./model.js";

const SHAPES = { cylinder: "Cylinder", square: "Square", plate: "Flat plate", naca: "NACA airfoil", draw: "Draw" };
const DEFAULT = { shape: "cylinder", angle: 15, code: "2412", re: 100, grid: "medium", mode: "tunnel", speed: "accurate", view: "vorticity", tracers: true, window: 5000, cells: [] };

const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
const view = createView();
let colors = null;
let state = loadState(DEFAULT, validState);
let worker = null;
let info = null, mask = null, frame = null, history = [], running = false, err = "";
let brushValue = 1;
let userView = false;
let painting = false;
let autoRun = true;
const off = document.createElement("canvas");

function validState(s) {
  const f = Number.isFinite;
  return s && SHAPES[s.shape] && GRIDS[s.grid] && ["tunnel", "open"].includes(s.mode) && ["vorticity", "speed", "pressure"].includes(s.view)
    && ["accurate", "fast"].includes(s.speed) && f(s.angle) && /^\d{4}$/.test(s.code) && f(s.re) && f(s.window) && Array.isArray(s.cells) && s.cells.every(Number.isInteger);
}

function cfg() {
  return { grid: state.grid, mode: state.mode, speed: state.speed, re: state.re, shape: state.shape, angle: state.angle, code: state.code, view: state.view, window: state.window, cells: state.cells };
}

// Worker
function setup() {
  err = "";
  $("flow-err").textContent = "";
  history = [];
  frame = null;
  running = false;
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = onWorker;
  }
  worker.postMessage({ cmd: "setup", cfg: cfg() });
  saveState(state);
  renderButtons();
}

function onWorker(e) {
  const m = e.data;
  if (m.type === "setup") {
    info = m.info;
    mask = m.mask;
    if (!userView) fit();
    if (autoRun && !reducedMotion()) { autoRun = false; run(); }
  } else if (m.type === "frame") {
    frame = m;
    history = m.history;
    renderFind();
    draw();
    drawHistory();
  } else if (m.type === "error") {
    err = m.message;
    info = m.info;
    running = false;
    $("flow-err").textContent = err;
    renderButtons();
    draw();
  }
}


function run() {
  if (err) return;
  running = true;
  worker.postMessage({ cmd: "run" });
  renderButtons();
}

function pause() {
  running = false;
  worker?.postMessage({ cmd: "pause" });
  renderButtons();
}

function renderButtons() {
  $("run").textContent = running ? "Pause" : "Run";
  $("step").disabled = running;
  document.querySelectorAll("#shapes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.shape === state.shape)));
  document.querySelectorAll("[data-brush]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.brush) === brushValue)));
  $("shape-angle").hidden = !["plate", "naca"].includes(state.shape);
  $("shape-code").hidden = state.shape !== "naca";
  $("shape-draw").hidden = state.shape !== "draw";
  $("shape-angle").querySelector("label").textContent = state.shape === "naca" ? "Angle of attack" : "Angle";
}

function renderFind() {
  if (!frame || !info) return;
  const s = frame.stats;
  setAnswer("ans-cd", fixed(s.cdAvg, 3), "", `live ${fixed(frame.cd, 3)}, over ${s.samples * 10} steps`);
  setAnswer("ans-cl", fixed(s.clAvg, 3), "", `live ${fixed(frame.cl, 3)}`);
  if (s.periodic) setAnswer("ans-st", fixed(s.St, 3), "", "from lift zero crossings");
  else setAnswer("ans-st", "n/a", "", s.liftAmp < 1e-3 ? "flow looks steady, no shedding" : "waiting for a repeating period");
  const blockage = state.mode === "tunnel" ? info.D / (info.ny - 2) : info.D / info.ny;
  fillTable($("t-info"), ["Quantity", "Value"], [
    ["lattice", `${info.nx} × ${info.ny}`],
    ["size L", `${info.D} cells`],
    ["inlet speed", info.parabolic ? `peak ${fixed(info.uPeak, 4)}, mean U ${fixed(info.u, 4)} (lattice units)` : `U ${fixed(info.u, 4)} (lattice units)`],
    ["inflow", info.parabolic ? "parabolic, fully developed" : "uniform"],
    ["relaxation τ", fixed(info.tau, 4)],
    ["blockage L/H", fixed(blockage, 3)],
    ["steps run", String(frame.step)],
  ]);
  const units = { vorticity: "ω L / U", speed: "|u| / U", pressure: "Cp = Δp / (½ρU²)" }[state.view];
  $("status-note").textContent = `Color: ${state.view}, ${units}. Flow from left to right.`;
}

// Drawing
function fit() {
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 10) || !info) return;
  fitView(view, { minX: 0, maxX: info.nx, minY: -info.ny * 0.12, maxY: info.ny }, r.width, r.height, 12);
}

function draw() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  if (!info) return;
  const [x0, y0] = toScreen(view, 0, info.ny), [x1, y1] = toScreen(view, info.nx, 0);
  if (frame && frame.nx === info.nx && frame.ny === info.ny) {
    off.width = frame.nx;
    off.height = frame.ny;
    off.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame.image), frame.nx, frame.ny), 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }
  // Obstacle hatching
  if (mask) {
    ctx.save();
    ctx.beginPath();
    for (let j = 0; j < info.ny; j++) for (let i = 0; i < info.nx; i++) {
      if (mask[j * info.nx + i] !== OBSTACLE) continue;
      const [a, b] = toScreen(view, i, j + 1), [c, d] = toScreen(view, i + 1, j);
      ctx.rect(a, b, c - a + 0.6, d - b + 0.6);
    }
    ctx.fillStyle = colors.graphite;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = alpha(colors.vellum, 0.55);
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    for (let t = -h; t < w + h; t += 6) { ctx.moveTo(x0 + t, y1); ctx.lineTo(x0 + t + (y1 - y0), y0); }
    ctx.stroke();
    ctx.restore();
  }
  // Tracers
  if (state.tracers && frame?.particles) {
    ctx.fillStyle = state.view === "speed" ? colors.redPencil : colors.ink;
    for (let p = 0; p < frame.particles.length; p += 2) {
      const [sx, sy] = toScreen(view, frame.particles[p] + 0.5, frame.particles[p + 1] + 0.5);
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }
  }
  ctx.strokeStyle = colors.graphite;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
  if (state.mode === "tunnel") {
    const [, wy0] = toScreen(view, 0, info.ny - 1), [, wy1] = toScreen(view, 0, 1);
    line(ctx, x0, wy0, x1, wy0, colors.ink, 1.5);
    line(ctx, x0, wy1, x1, wy1, colors.ink, 1.5);
  }
  // Inlet arrow
  const [ax, ay] = toScreen(view, 0, info.ny / 2);
  arrow(ctx, ax + 6, ay, ax + 40, ay, colors.ink, 1.5, 8);
  text(ctx, `U, Re ${fmt(state.re, 4)}`, ax + 8, ay - 8, { size: 11, color: colors.ink, bg: colors.vellum });
  drawColorBar(ctx, x0, y1 + 10, Math.min(260, x1 - x0));
  if (err) text(ctx, err.length > 90 ? `${err.slice(0, 88)}...` : err, x0 + 6, y0 + 18, { size: 12, color: colors.redPencil, bg: colors.vellum });
}

function drawColorBar(ctx, x, y, wBar) {
  const hBar = 9, n = 60;
  const v = [244, 241, 232], g = [59, 62, 66], r = [178, 58, 46], b = [44, 91, 134];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    let c;
    if (state.view === "speed") c = v.map((a, i) => a + (g[i] - a) * t);
    else {
      const s = 2 * t - 1, end = s >= 0 ? r : b;
      c = v.map((a, i) => a + (end[i] - a) * Math.abs(s));
    }
    ctx.fillStyle = `rgb(${c.map(Math.round).join(", ")})`;
    ctx.fillRect(x + (k * wBar) / n, y, wBar / n + 0.5, hBar);
  }
  ctx.strokeStyle = colors.graphite;
  ctx.lineWidth = 0.75;
  ctx.strokeRect(x + 0.5, y + 0.5, wBar, hBar);
  const labels = { speed: ["0", "1.6 U", "|u|"], vorticity: ["−4", "+4", "ω L / U"], pressure: ["−1.5", "+1.5", "Cp"] }[state.view];
  text(ctx, labels[0], x, y + hBar + 12, { size: 10, color: colors.graphite });
  text(ctx, labels[1], x + wBar, y + hBar + 12, { size: 10, color: colors.graphite, align: "right" });
  text(ctx, labels[2], x + wBar + 8, y + hBar, { size: 10.5, color: colors.graphite });
}

function drawHistory() {
  const c = $("hist");
  const { ctx, w, h } = fitCanvas(c);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  if (history.length < 2) return;
  const pad = { l: 40, r: 10, t: 14, b: 24 };
  const vals = history.flatMap(([, a, b]) => [a, b]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
  const s0 = history[0][0], s1 = history[history.length - 1][0];
  const X = (s) => pad.l + ((s - s0) / Math.max(1, s1 - s0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + ((hi - v) / (hi - lo)) * (h - pad.t - pad.b);
  if (lo < 0 && hi > 0) line(ctx, pad.l, Y(0), w - pad.r, Y(0), colors.graphite, 0.5, [3, 3]);
  polyline(ctx, history.map(([s, a]) => [X(s), Y(a)]), colors.ink, 1.25);
  polyline(ctx, history.map(([s, , b]) => [X(s), Y(b)]), colors.redPencil, 1.25, [4, 2]);
  text(ctx, fmt(hi, 3), pad.l - 4, pad.t + 6, { size: 9.5, align: "right", color: colors.graphite });
  text(ctx, fmt(lo, 3), pad.l - 4, h - pad.b, { size: 9.5, align: "right", color: colors.graphite });
  text(ctx, "Cd solid, Cl dashed", w - pad.r, pad.t + 4, { size: 10.5, color: colors.ink, align: "right", bg: colors.vellum });
  text(ctx, `step ${s1}`, w - pad.r, h - 6, { size: 9.5, align: "right", color: colors.graphite });
}

// Painting in draw mode
function paintAt(mp) {
  if (!info) return;
  const b = Math.max(1, Math.min(8, Math.round(Number($("brush").value) || 3)));
  const ci = Math.floor(mp[0]), cj = Math.floor(mp[1]);
  const cells = [];
  for (let i = ci - b + 1; i < ci + b; i++) for (let j = cj - b + 1; j < cj + b; j++) {
    if (i < 1 || i >= info.nx - 1 || j < 1 || j >= info.ny - 1) continue;
    if (Math.hypot(i - ci, j - cj) > b - 0.5) continue;
    cells.push(j * info.nx + i);
  }
  worker.postMessage({ cmd: "paint", cells, value: brushValue });
  const set = new Set(state.cells);
  for (const c of cells) { if (brushValue) set.add(c); else set.delete(c); }
  state.cells = [...set].sort((a, b2) => a - b2);
}

attachPanZoom(canvas, view, {
  onDown(e, p, mp) {
    if (state.shape !== "draw") return false;
    painting = true;
    paintAt(mp);
    return true;
  },
  onMove(e, p, mp) { if (painting) paintAt(mp); },
  onUp() { painting = false; saveState(state); },
  onView() { userView = true; draw(); },
});

// Inputs
function syncInputs() {
  $("angle").value = state.angle;
  $("code").value = state.code;
  $("re").value = state.re;
  $("grid").value = state.grid;
  $("mode").value = state.mode;
  $("speed").value = state.speed;
  $("view").value = state.view;
  $("tracers").checked = state.tracers;
  $("window").value = String(state.window);
}

function init() {
  for (const [k, label] of Object.entries(SHAPES)) {
    $("shapes").append(el("button", { type: "button", text: label, "data-shape": k, onclick: () => {
      pause();
      state.shape = k;
      if (k === "draw" && !state.cells.length) state.cells = [];
      autoRun = true;
      userView = false;
      renderButtons();
      setup();
    } }));
  }
  const restart = () => { pause(); autoRun = true; setup(); };
  $("angle").addEventListener("change", () => {
    const v = Number($("angle").value);
    if (!(v >= -90 && v <= 90)) { $("flow-err").textContent = "Angle must be between −90 and 90 degrees."; return; }
    state.angle = v;
    restart();
  });
  $("code").addEventListener("change", () => {
    const v = $("code").value.trim();
    if (!/^\d{4}$/.test(v) || Number(v.slice(2)) < 1 || Number(v.slice(2)) > 40) { $("flow-err").textContent = "Use a 4 digit NACA code like 2412, with a thickness from 01 to 40."; return; }
    state.code = v;
    restart();
  });
  $("re").addEventListener("change", () => {
    const v = Number($("re").value);
    if (!(v >= 1 && v <= 1000)) { $("flow-err").textContent = "Reynolds number must be between 1 and 1000."; return; }
    state.re = v;
    restart();
  });
  $("grid").addEventListener("change", () => { state.grid = $("grid").value; state.cells = []; userView = false; restart(); });
  $("mode").addEventListener("change", () => { state.mode = $("mode").value; state.cells = []; restart(); });
  $("speed").addEventListener("change", () => { state.speed = $("speed").value; restart(); renderSpeedNote(); });
  $("view").addEventListener("change", () => { state.view = $("view").value; worker?.postMessage({ cmd: "view", view: state.view }); saveState(state); });
  $("tracers").addEventListener("change", () => { state.tracers = $("tracers").checked; draw(); saveState(state); });
  $("window").addEventListener("change", () => { state.window = Number($("window").value); worker?.postMessage({ cmd: "view", view: state.view, window: state.window }); saveState(state); });
  document.querySelectorAll("[data-brush]").forEach((b) => b.addEventListener("click", () => { brushValue = Number(b.dataset.brush); renderButtons(); }));
  $("run").addEventListener("click", () => (running ? pause() : run()));
  $("step").addEventListener("click", () => { if (!running) worker?.postMessage({ cmd: "step" }); });
  $("reset").addEventListener("click", () => { pause(); autoRun = false; setup(); });
  $("fit").addEventListener("click", () => { userView = false; fit(); draw(); });
  wireCopyLink($("copy-link"));
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-wind-tunnel.png"));
  $("csv").addEventListener("click", () => download("vellum-wind-tunnel.csv", toCsv(["step", "Cd", "Cl"], history), "text/csv"));
  new ResizeObserver(() => { if (!userView) fit(); draw(); if (colors) drawHistory(); }).observe(canvas);
  renderSpeedNote();
}

function renderSpeedNote() {
  $("bar-note").textContent = state.speed === "fast"
    ? "Fast setting: lower accuracy, not the benchmarked setting."
    : `Benchmarked inlet speed. τ must stay above ${TAU_MIN}.`;
  $("bar-note").classList.toggle("warn", state.speed === "fast");
}

init();
syncInputs();
renderButtons();
autoRun = !reducedMotion();
setup();
initSheet({ no: "04", title: "Wind tunnel" });
