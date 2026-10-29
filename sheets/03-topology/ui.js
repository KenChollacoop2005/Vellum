// Sheet 03 interface
import { initSheet, loadState, saveState, wireCopyLink, setAnswer, fillTable, toCsv, download, downloadCanvas, el, reducedMotion } from "../../core/sheet.js";
import {
  readColors, fitCanvas, createView, fitView, toScreen, attachPanZoom, line, polyline, text, arrow, alpha, hexToRgb,
} from "../../core/draw.js";
import { fixed, fmt } from "../../core/units.js";
import { PRESETS_TOP, thresholdGrid, removeDiagonalContacts, buildStl, svgFromGrid, nonDiscreteness } from "./model.js";

const PICK_PX = 14; // node pick radius in pixels
const DEFORM_FRACTION = 0.06; // deformed mesh max shift as a fraction of size
const MESHES = { "60x20": [60, 20], "120x40": [120, 40], "180x60": [180, 60], "60x30": [60, 30], "60x60": [60, 60], "90x90": [90, 90] };
const LOAD_DIRS = { down: [0, -1], up: [0, 1], left: [-1, 0], right: [1, 0] };

function presetState(key, nelx, nely) {
  const p = PRESETS_TOP[key];
  const d = p.defaults;
  const nx = nelx ?? d.nelx, ny = nely ?? d.nely;
  const bc = p.bc(nx, ny);
  return {
    preset: key, nelx: nx, nely: ny, volfrac: d.volfrac, penal: d.penal, rmin: d.rmin * (nx / d.nelx), ft: d.ft,
    maxIter: 300, tol: 0.01, supports: bc.supports, loads: bc.loads, passive: bc.passive, esize: 1, thick: 0.1 * Math.min(nx, ny), fast: false,
  };
}

const DEFAULT = presetState("mbb");
const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
const view = createView();
let colors = null;
let state = loadState(DEFAULT, validState);
let worker = null;
let xPhys = null, U = null, history = [], gray = 0, converged = false, running = false, done = false;
let tool = "pan";
let userView = false;
let painting = null;
let autoStart = true;

function validState(s) {
  const f = Number.isFinite;
  if (!s || !PRESETS_TOP[s.preset] || !Number.isInteger(s.nelx) || !Number.isInteger(s.nely)) return false;
  if (!MESHES[`${s.nelx}x${s.nely}`]) return false;
  if (![s.volfrac, s.penal, s.rmin, s.ft, s.maxIter, s.tol, s.esize, s.thick].every(f)) return false;
  if (s.fast !== undefined && typeof s.fast !== "boolean") return false;
  const nn = (s.nelx + 1) * (s.nely + 1), ne = s.nelx * s.nely;
  return Array.isArray(s.supports) && s.supports.every(([n, m]) => Number.isInteger(n) && n >= 0 && n < nn && [1, 2, 3].includes(m))
    && Array.isArray(s.loads) && s.loads.every(([n, a, b]) => Number.isInteger(n) && n >= 0 && n < nn && f(a) && f(b))
    && Array.isArray(s.passive) && s.passive.every(([e, k]) => Number.isInteger(e) && e >= 0 && e < ne && [1, 2].includes(k));
}

function paramError() {
  if (!(state.volfrac > 0 && state.volfrac < 1)) return "Volume fraction must be between 0 and 1.";
  if (!(state.penal >= 1)) return "Penalty must be at least 1.";
  if (!(state.rmin >= 1)) return "Filter radius must be at least 1 element.";
  if (!(state.maxIter >= 1)) return "Max iterations must be at least 1.";
  if (!(state.tol > 0)) return "Tolerance must be greater than zero.";
  if (!state.loads.length) return "Add at least one load.";
  if (!state.supports.length) return "Add supports.";
  return "";
}

// Worker
function setup() {
  const err = paramError();
  $("param-err").textContent = err;
  history = [];
  converged = false;
  done = false;
  running = false;
  $("run-err").textContent = "";
  if (err) { render(); return; }
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = onWorker;
  }
  worker.postMessage({ cmd: "pace", paced: !state.fast });
  worker.postMessage({ cmd: "setup", cfg: {
    nelx: state.nelx, nely: state.nely, volfrac: state.volfrac, penal: state.penal, rmin: state.rmin, ft: state.ft,
    maxIter: state.maxIter, tol: state.tol, supports: state.supports, loads: state.loads, passive: state.passive,
  } });
  saveState(state);
}

function onWorker(e) {
  const m = e.data;
  if (m.type === "ready") {
    xPhys = m.xPhys;
    U = null;
    render();
    if (!reducedMotion() && autoStart) { autoStart = false; run(); }
  } else if (m.type === "iter") {
    xPhys = m.xPhys;
    U = m.U;
    gray = m.gray;
    converged = m.converged;
    done = m.done;
    history.push(m.rec);
    render();
  } else if (m.type === "stopped") {
    running = false;
    render();
  } else if (m.type === "error") {
    running = false;
    $("run-err").textContent = m.message;
    renderButtons();
  }
}


function run() {
  if (done || paramError()) return;
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
  $("run").disabled = done && !running;
  $("step").disabled = running || done;
  document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
}

// Rendering
function render() {
  renderFind();
  renderButtons();
  draw();
  drawHistory();
}

function renderFind() {
  const last = history[history.length - 1];
  setAnswer("ans-c", last ? fixed(last.c, 3) : "n/a", "", last ? `at the start of iteration ${last.loop}` : "press Run or Step");
  const vol = xPhys ? xPhys.reduce((s, v) => s + v, 0) / xPhys.length : state.volfrac;
  setAnswer("ans-vol", fixed(vol, 4), "", `target ${fixed(state.volfrac, 3)}`);
  setAnswer("ans-it", String(last ? last.loop : 0), "", `max ${state.maxIter}`);
  setAnswer("ans-conv", converged ? "yes" : "no", "", last ? `change ${fixed(last.change, 4)}, limit ${state.tol}` : "");
  fillTable($("t-stats"), ["Quantity", "Value"], [
    ["gray elements, Sigmund Mnd", `${fixed(xPhys ? nonDiscreteness(xPhys) : gray, 2)} %`],
    ["elements", `${state.nelx} × ${state.nely} = ${state.nelx * state.nely}`],
    ["filter", state.ft === 1 ? "sensitivity" : "density"],
  ]);
  $("status-note").textContent = running ? "Running in a worker. You can keep editing settings; edits restart the run."
    : done ? (converged ? "Converged." : "Stopped at the iteration limit.") : "Graphite is solid (x = 1), vellum is void (x = 0).";
}

function fit() {
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 10)) return;
  fitView(view, { minX: -3, maxX: state.nelx + 3, minY: -4, maxY: state.nely + 3 }, r.width, r.height, 14);
}

// Model space: x = elx, y = nely - ely, nodes at integer points
function nodeXY(n) {
  const i = Math.floor(n / (state.nely + 1)), j = n % (state.nely + 1);
  return [i, state.nely - j];
}

function draw() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  const { nelx, nely } = state;
  const [x0, y0] = toScreen(view, 0, nely), [x1, y1] = toScreen(view, nelx, 0);
  const show = deformedOn() && U;
  if (xPhys && !show) {
    const img = new ImageData(nelx, nely);
    const v = hexToRgb(colors.vellum), g = hexToRgb(colors.graphite);
    for (let i = 0; i < nelx; i++) for (let j = 0; j < nely; j++) {
      const x = xPhys[i * nely + j];
      const o = (j * nelx + i) * 4;
      img.data[o] = v[0] + (g[0] - v[0]) * x;
      img.data[o + 1] = v[1] + (g[1] - v[1]) * x;
      img.data[o + 2] = v[2] + (g[2] - v[2]) * x;
      img.data[o + 3] = 255;
    }
    const off = new OffscreenCanvas(nelx, nely);
    off.getContext("2d").putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  } else if (xPhys && show) {
    drawDeformed(ctx);
  }
  // Passive regions outline
  for (const [e, kind] of state.passive) {
    const i = Math.floor(e / nely), j = e % nely;
    const [a, b] = toScreen(view, i, nely - j), [c, d] = toScreen(view, i + 1, nely - j - 1);
    ctx.save();
    ctx.fillStyle = kind === 1 ? alpha(colors.redPencil, 0.12) : alpha(colors.draftBlue, 0.18);
    ctx.fillRect(a, b, c - a, d - b);
    ctx.restore();
  }
  ctx.strokeStyle = colors.graphite;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
  drawBcs(ctx);
  text(ctx, `${nelx} × ${nely} elements`, 10, h - 10, { size: 11, color: colors.graphite, bg: colors.vellum });
}

function deformedOn() {
  return $("deformed").checked;
}

function drawDeformed(ctx) {
  const { nelx, nely } = state;
  let umax = 0;
  for (let k = 0; k < U.length; k++) umax = Math.max(umax, Math.abs(U[k]));
  const sc = umax > 0 ? (DEFORM_FRACTION * Math.max(nelx, nely)) / umax : 0;
  const P = (n) => {
    const [x, y] = nodeXY(n);
    return toScreen(view, x + sc * U[2 * n], y + sc * U[2 * n + 1]);
  };
  const g = hexToRgb(colors.graphite), v = hexToRgb(colors.vellum);
  for (let i = 0; i < nelx; i++) for (let j = 0; j < nely; j++) {
    const x = xPhys[i * nely + j];
    if (x < 0.02) continue;
    const n1 = i * (nely + 1) + j;
    const pts = [P(n1), P(n1 + nely + 1), P(n1 + nely + 2), P(n1 + 1)];
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (let k = 1; k < 4; k++) ctx.lineTo(...pts[k]);
    ctx.closePath();
    ctx.fillStyle = `rgb(${v.map((c, k) => Math.round(c + (g[k] - c) * x)).join(", ")})`;
    ctx.fill();
  }
  text(ctx, `Deformed, displacements x ${fmt(sc, 3)}`, 10, 18, { size: 11, color: colors.graphite, bg: colors.vellum });
}

function drawBcs(ctx) {
  const s = Math.max(6, Math.min(14, view.scale * 1.2));
  for (const [n, mask] of state.supports) {
    const [x, y] = nodeXY(n);
    const [sx, sy] = toScreen(view, x, y);
    ctx.save();
    ctx.strokeStyle = colors.draftBlue;
    ctx.fillStyle = alpha(colors.draftBlue, 0.15);
    ctx.lineWidth = 1;
    if (mask === 3) {
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      ctx.strokeRect(sx - s / 2, sy - s / 2, s, s);
      line(ctx, sx - s / 2, sy + s / 2, sx + s / 2, sy - s / 2, colors.draftBlue, 0.75);
    } else {
      ctx.translate(sx, sy);
      if (mask === 1) ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-s / 2, s * 0.8);
      ctx.lineTo(s / 2, s * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, s * 0.8 + 2, 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  let fmax = 0;
  for (const [, fx, fy] of state.loads) fmax = Math.max(fmax, Math.hypot(fx, fy));
  for (const [n, fx, fy] of state.loads) {
    const [x, y] = nodeXY(n);
    const [sx, sy] = toScreen(view, x, y);
    const L = 14 + 26 * (Math.hypot(fx, fy) / (fmax || 1));
    const ux = fx / (Math.hypot(fx, fy) || 1), uy = -fy / (Math.hypot(fx, fy) || 1);
    arrow(ctx, sx - ux * L, sy - uy * L, sx, sy, colors.redPencil, 1.5, 7);
  }
}

function drawHistory() {
  const c = $("hist");
  const { ctx, w, h } = fitCanvas(c);
  ctx.fillStyle = colors?.vellum || "#F4F1E8";
  ctx.fillRect(0, 0, w, h);
  if (!colors || history.length < 1) return;
  const pad = { l: 46, r: 10, t: 12, b: 26 };
  const cs = history.map((r) => r.c);
  const cmax = Math.max(...cs), cmin = Math.min(...cs);
  const span = cmax - cmin || 1;
  const n = Math.max(history.length, 10);
  const X = (i) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + ((cmax - v) / span) * (h - pad.t - pad.b);
  line(ctx, pad.l, h - pad.b, w - pad.r, h - pad.b, colors.graphite, 0.75);
  line(ctx, pad.l, pad.t, pad.l, h - pad.b, colors.graphite, 0.75);
  polyline(ctx, cs.map((v, i) => [X(i), Y(v)]), colors.ink, 1.25);
  text(ctx, fmt(cmax, 4), pad.l - 4, pad.t + 8, { size: 9.5, align: "right", color: colors.graphite });
  text(ctx, fmt(cmin, 4), pad.l - 4, h - pad.b, { size: 9.5, align: "right", color: colors.graphite });
  text(ctx, "iteration", w - pad.r, h - 8, { size: 9.5, align: "right", color: colors.graphite });
  text(ctx, String(history.length), X(history.length - 1), h - pad.b + 12, { size: 9.5, align: "center", color: colors.graphite });
}

// Editing
function nearestNode(mp) {
  const i = Math.round(mp[0]), y = Math.round(mp[1]);
  if (i < 0 || i > state.nelx || y < 0 || y > state.nely) return -1;
  const [sx, sy] = toScreen(view, i, y), [px, py] = toScreen(view, mp[0], mp[1]);
  if (Math.hypot(sx - px, sy - py) > Math.max(PICK_PX, view.scale * 0.7)) return -1;
  return i * (state.nely + 1) + (state.nely - y);
}

function applyTool(mp) {
  if (["solid", "void", "erase"].includes(tool)) return paint(mp);
  const n = nearestNode(mp);
  if (n < 0) return false;
  const key = `${tool}:${n}`;
  if (painting?.done.has(key)) return false;
  painting?.done.add(key);
  const sup = state.supports.filter(([m]) => m !== n);
  const cur = state.supports.find(([m]) => m === n)?.[1] || 0;
  if (tool === "fixx") state.supports = [...sup, [n, cur | 1]];
  else if (tool === "fixy") state.supports = [...sup, [n, cur | 2]];
  else if (tool === "fixxy") state.supports = [...sup, [n, 3]];
  else if (tool === "load") {
    const [dx, dy] = LOAD_DIRS[$("ldir").value];
    state.loads = [...state.loads.filter(([m]) => m !== n), [n, dx, dy]];
  } else if (tool === "clear") {
    state.supports = sup;
    state.loads = state.loads.filter(([m]) => m !== n);
  }
  return true;
}

function paint(mp) {
  const b = Math.max(1, Math.min(5, Math.round(Number($("brush").value) || 1)));
  const ci = Math.floor(mp[0]), cj = state.nely - 1 - Math.floor(mp[1]);
  const half = Math.floor((b - 1) / 2);
  const map = new Map(state.passive);
  let changed = false;
  for (let i = ci - half; i < ci - half + b; i++) for (let j = cj - half; j < cj - half + b; j++) {
    if (i < 0 || i >= state.nelx || j < 0 || j >= state.nely) continue;
    const e = i * state.nely + j;
    const want = tool === "solid" ? 2 : tool === "void" ? 1 : 0;
    if ((map.get(e) || 0) === want) continue;
    if (want) map.set(e, want); else map.delete(e);
    changed = true;
  }
  if (changed) state.passive = [...map.entries()];
  return changed;
}

attachPanZoom(canvas, view, {
  onDown(e, p, mp) {
    if (tool === "pan") return false;
    painting = { done: new Set() };
    if (applyTool(mp)) draw();
    return true;
  },
  onMove(e, p, mp) {
    if (painting && applyTool(mp)) draw();
  },
  onUp() {
    if (painting) { painting = null; setup(); }
  },
  onView() { userView = true; draw(); },
});

// Inputs
function syncInputs() {
  $("mesh").value = `${state.nelx}x${state.nely}`;
  $("volfrac").value = state.volfrac;
  $("penal").value = state.penal;
  $("rmin").value = Number(state.rmin.toFixed(3));
  $("ft").value = String(state.ft);
  $("maxiter").value = state.maxIter;
  $("tol").value = state.tol;
  $("esize").value = state.esize;
  $("thick").value = Number(state.thick.toFixed(3));
}

function exportGrid() {
  return removeDiagonalContacts(thresholdGrid(xPhys, state.nelx, state.nely), state.nelx, state.nely);
}

function init() {
  for (const [k, p] of Object.entries(PRESETS_TOP)) {
    $("presets").append(el("button", { type: "button", text: p.label, onclick: () => {
      pause();
      state = presetState(k);
      userView = false;
      syncInputs();
      fit();
      autoStart = !reducedMotion();
      setup();
    } }));
  }
  $("mesh").addEventListener("change", () => {
    const [nx, ny] = $("mesh").value.split("x").map(Number);
    pause();
    const keep = { volfrac: state.volfrac, penal: state.penal, ft: state.ft, maxIter: state.maxIter, tol: state.tol };
    const scale = nx / state.nelx;
    const rmin = state.rmin * scale;
    state = { ...presetState(state.preset, nx, ny), ...keep, rmin };
    userView = false;
    syncInputs();
    fit();
    setup();
  });
  const num = (id, key, conv = (v) => v) => $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    const ok = $(id).value.trim() !== "" && Number.isFinite(v);
    $(id).setAttribute("aria-invalid", String(!ok));
    if (!ok) return;
    pause();
    state[key] = conv(v);
    setup();
  });
  num("volfrac", "volfrac");
  num("penal", "penal");
  num("rmin", "rmin");
  num("maxiter", "maxIter", Math.round);
  num("tol", "tol");
  $("ft").addEventListener("change", () => { pause(); state.ft = Number($("ft").value); setup(); });
  for (const id of ["esize", "thick"]) $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    if (v > 0) { state[id] = v; saveState(state); }
  });
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => { tool = b.dataset.tool; canvas.style.cursor = tool === "pan" ? "grab" : "crosshair"; renderButtons(); }));
  $("brush").value = 2;
  $("run").addEventListener("click", () => (running ? pause() : run()));
  $("step").addEventListener("click", () => { if (!running && !done) worker?.postMessage({ cmd: "step" }); });
  $("reset").addEventListener("click", () => { pause(); autoStart = false; setup(); });
  $("deformed").addEventListener("change", draw);
  $("fast").checked = !!state.fast;
  $("fast").addEventListener("change", () => { state.fast = $("fast").checked; worker?.postMessage({ cmd: "pace", paced: !state.fast }); saveState(state); });
  $("fit").addEventListener("click", () => { userView = false; fit(); draw(); });
  wireCopyLink($("copy-link"));
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-topology.png"));
  $("svg").addEventListener("click", () => { if (xPhys) download("vellum-topology.svg", svgFromGrid(exportGrid(), state.nelx, state.nely, state.esize), "image/svg+xml"); });
  $("stl").addEventListener("click", () => { if (xPhys) download("vellum-topology.stl", new Blob([buildStl(exportGrid(), state.nelx, state.nely, state.esize, state.thick)], { type: "model/stl" })); });
  $("csv").addEventListener("click", () => {
    if (!xPhys) return;
    const rows = [];
    for (let i = 0; i < state.nelx; i++) for (let j = 0; j < state.nely; j++) rows.push([i, j, xPhys[i * state.nely + j]]);
    download("vellum-topology.csv", toCsv(["elx", "ely from top", "density"], rows) + "\n" + toCsv(["iteration", "compliance", "volume", "change"], history.map((r) => [r.loop, r.c, r.vol, r.change])), "text/csv");
  });
  new ResizeObserver(() => { if (!userView) fit(); draw(); drawHistory(); }).observe(canvas);
}

init();
syncInputs();
fit();
autoStart = !reducedMotion();
setup();
renderButtons();
initSheet({ no: "03", title: "Topology optimizer" });
