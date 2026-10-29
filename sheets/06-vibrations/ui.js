// Sheet 06 interface
import { initSheet, loadState, saveState, wireCopyLink, fillTable, toCsv, download, downloadCanvas, el, reducedMotion } from "../../core/sheet.js";
import { readColors, fitCanvas, line, polyline, text, lettering, alpha, hatchRect, arrow } from "../../core/draw.js";
import { fixed, fmt } from "../../core/units.js";
import {
  END_TYPES, VIB_PRESETS, springCount, springNodes, validateChain, chainMatrices, modes, frequencySweep, newmarkStepper,
  initialState, audioMapping,
} from "./model.js";
import { playModes, setVolume } from "./audio.js";

const VIS_HZ = 0.6; // on screen mode animation frequency
const FREE_PERIOD = 2.2; // on screen seconds per lowest mode period
const SUBSTEPS_PER_PERIOD = 40; // Newmark steps per shortest period
const FRF_POINTS = 500; // frequency response samples

const DEFAULT = {
  ...structuredClone(VIB_PRESETS.three), label: undefined,
  rayleigh: { on: false, alpha: 0, beta: 0 }, forceAt: 0, watch: 0, w0: 1, w1: 80, kickAt: 0, volume: 0.15,
};

const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
const frfCanvas = $("frf");
let colors = null;
let state = loadState(DEFAULT, validState);
let sys = null, md = null, err = null, frf = [];
let anim = { kind: "mode", index: 0, playing: !reducedMotion(), t0: performance.now(), sim: null, simT: 0 };
let raf = 0;
let lastFrame = performance.now();
let playingTone = -1;

function validState(s) {
  const f = (v) => Number.isFinite(v);
  return s && Array.isArray(s.masses) && Array.isArray(s.springs) && Array.isArray(s.dampers) && END_TYPES[s.ends]
    && s.masses.every(f) && s.springs.every(f) && s.dampers.every(f) && s.rayleigh && f(s.rayleigh.alpha) && f(s.rayleigh.beta)
    && f(s.w0) && f(s.w1) && Number.isInteger(s.forceAt) && Number.isInteger(s.watch) && Number.isInteger(s.kickAt) && f(s.volume);
}

function chainInput() {
  return {
    masses: state.masses, springs: state.springs, dampers: state.dampers, ends: state.ends,
    rayleigh: state.rayleigh.on ? { alpha: state.rayleigh.alpha, beta: state.rayleigh.beta } : null,
  };
}

function resize(n, ends) {
  const fit = (arr, len, fill) => Array.from({ length: len }, (_, i) => (arr[i] !== undefined ? arr[i] : (arr[arr.length - 1] ?? fill)));
  state.masses = fit(state.masses, n, 1);
  const ns = springCount(n, ends);
  state.springs = fit(state.springs, ns, 1000);
  state.dampers = fit(state.dampers, ns, 0);
  state.ends = ends;
  state.forceAt = Math.min(state.forceAt, n - 1);
  state.watch = Math.min(state.watch, n - 1);
  state.kickAt = Math.min(state.kickAt, n - 1);
}

// Update
function update() {
  err = validateChain(chainInput());
  if (!err && !(state.w0 > 0 && state.w1 > state.w0)) err = "The sweep needs 0 < from < to.";
  $("chain-err").textContent = err || "";
  if (err) {
    md = null;
    renderFind();
    draw();
    return;
  }
  sys = chainMatrices(chainInput());
  md = modes(sys);
  if (anim.kind === "mode" && anim.index >= sys.n) anim.index = 0;
  frf = computeFrf();
  renderFind();
  renderModeButtons();
  if (anim.kind === "free") startFree();
  draw();
  saveState(state);
}

function computeFrf() {
  const base = frequencySweep(sys, state.forceAt, state.watch, state.w0, state.w1, FRF_POINTS);
  const extra = md.omega.filter((w) => w > state.w0 && w < state.w1).flatMap((w) => [w * 0.999, w, w * 1.001])
    .map((w) => frequencySweep(sys, state.forceAt, state.watch, w, w * (1 + 1e-12), 2)[0]);
  return [...base, ...extra].sort((a, b) => a[0] - b[0]);
}

function renderFind() {
  const box = $("freqs");
  if (!md) {
    box.replaceChildren();
    fillTable($("t-modes"), ["Mode"], []);
    drawFrf();
    return;
  }
  box.replaceChildren(...md.omega.map((w, i) => el("div", { class: `answer${i === playingTone ? " lit" : ""}`, id: `ans-mode-${i}` },
    el("span", { class: "q", text: `Mode ${i + 1}` }),
    el("span", { class: "v" }, fixed(w, 3), el("span", { class: "u", text: " rad/s" })),
    el("span", { class: "s", text: `${fixed(md.hz[i], 3)} Hz${w === 0 ? ", rigid body" : ""}` }))));
  const n = sys.n;
  const head = ["", ...md.omega.map((_, j) => `φ${j + 1}`)];
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([`mass ${i + 1}`, ...md.shapes.map((phi) => fixed(phi[i], 4))]);
  rows.push(["ω rad/s", ...md.omega.map((w) => fixed(w, 3))]);
  rows.push(["ζ", ...md.zeta.map((z, j) => (md.omega[j] > 0 ? fixed(z, 4) : "n/a"))]);
  fillTable($("t-modes"), head, rows);
  let note = "";
  if (!md.damped) note = "No damping set. Add dashpots or Rayleigh damping to see ζ and finite peaks.";
  else if (md.proportional) note = "Damping is proportional, so each mode keeps its own ζ.";
  else note = "Damping is not proportional, so damping couples the modes. The ζ values are the diagonal terms only (approximate). The frequency response is exact.";
  $("damp-note").textContent = note;
  const map = audioMapping(md.hz);
  $("pitch-note").textContent = map.compressed
    ? "Spread too wide for hearing, so pitches are compressed on a log scale. The intervals are not exact."
    : `Pitch shifted ×${fmt(map.factor, 4)}. The intervals between modes are exact.`;
  $("status-note").textContent = statusText();
  drawFrf();
}

function statusText() {
  if (!md) return "";
  if (anim.kind === "free") return `Free response after displacing mass ${state.kickAt + 1}. Slowed so one period of mode 1 takes about ${FREE_PERIOD} s.`;
  const w = md.omega[anim.index];
  return `Mode ${anim.index + 1}, ω = ${fixed(w, 3)} rad/s. Motion is exaggerated and slowed down to about ${VIS_HZ} Hz.`;
}

function renderModeButtons() {
  const host = $("mode-buttons");
  host.replaceChildren(...md.omega.map((_, i) => {
    const b = el("button", { type: "button", text: `Mode ${i + 1}`, "aria-pressed": String(anim.kind === "mode" && anim.index === i) });
    b.addEventListener("click", () => { anim = { ...anim, kind: "mode", index: i, playing: true, t0: performance.now() }; refreshAnim(); });
    return b;
  }));
  $("free").setAttribute("aria-pressed", String(anim.kind === "free"));
  $("play").textContent = anim.playing ? "Pause" : "Play";
}

function refreshAnim() {
  renderModeButtons();
  $("status-note").textContent = statusText();
  if (anim.playing) loop(); else draw();
}

// Free response
function startFree() {
  const live = md.omega.filter((w) => w > 0);
  if (!live.length) { anim.sim = null; return; }
  const wMax = Math.max(...live), wMin = Math.min(...live);
  const dt = (2 * Math.PI) / wMax / SUBSTEPS_PER_PERIOD;
  const u0 = new Array(sys.n).fill(0);
  u0[state.kickAt] = 1;
  anim.sim = { step: newmarkStepper(sys, dt), s: initialState(sys, u0), dt, scale: ((2 * Math.PI) / wMin) / FREE_PERIOD };
}

// Animation
function loop() {
  cancelAnimationFrame(raf);
  const tick = (now) => {
    const dtFrame = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (anim.playing && anim.kind === "free" && anim.sim) {
      const target = anim.sim.s.t + dtFrame * anim.sim.scale;
      let guard = 0;
      while (anim.sim.s.t < target && guard++ < 4000) anim.sim.s = anim.sim.step(anim.sim.s);
    }
    draw(now);
    if (anim.playing) raf = requestAnimationFrame(tick);
  };
  lastFrame = performance.now();
  raf = requestAnimationFrame(tick);
}

function displacements(now) {
  if (!md) return null;
  const n = sys.n;
  if (anim.kind === "free" && anim.sim) return anim.sim.s.u.slice();
  const phi = md.shapes[anim.index] || new Array(n).fill(0);
  const big = Math.max(...phi.map(Math.abs)) || 1;
  const t = ((now ?? performance.now()) - anim.t0) / 1000;
  const s = anim.playing ? Math.sin(2 * Math.PI * VIS_HZ * t) : 1;
  return phi.map((p) => (p / big) * s);
}

function draw(now) {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  if (!md) {
    if (err) text(ctx, err, 16, 30, { color: colors.redPencil, size: 13 });
    return;
  }
  const n = sys.n;
  const leftWall = state.ends !== "free-free";
  const rightWall = state.ends === "fixed-fixed";
  const x0 = 40, x1 = w - 40;
  const slots = n + 1;
  const pitch = (x1 - x0) / slots;
  const bw = Math.min(70, pitch * 0.42), bh = Math.min(64, h * 0.22);
  const cy = h * 0.46;
  const u = displacements(now) || new Array(n).fill(0);
  const amp = pitch * 0.28;
  const mx = (i) => x0 + pitch * (i + 1) + u[i] * amp;
  const restX = (i) => x0 + pitch * (i + 1);

  // Ground
  const floorY = cy + bh / 2;
  line(ctx, x0 - 20, floorY, x1 + 20, floorY, colors.graphite, 1);
  hatchRect(ctx, x0 - 20, floorY, x1 - x0 + 40, 7, colors.graphite, 6, 0.6);
  if (leftWall) { line(ctx, x0, cy - bh, x0, floorY, colors.graphite, 1.5); hatchRect(ctx, x0 - 9, cy - bh, 9, bh * 1.5, colors.graphite, 6, 0.6); }
  if (rightWall) { line(ctx, x1, cy - bh, x1, floorY, colors.graphite, 1.5); hatchRect(ctx, x1, cy - bh, 9, bh * 1.5, colors.graphite, 6, 0.6); }

  // Springs and dashpots
  const nodes = springNodes(n, state.ends);
  nodes.forEach(([l, r], i) => {
    const xa = l < 0 ? x0 : mx(l) + bw / 2;
    const xb = r < 0 ? x1 : mx(r) - bw / 2;
    const c = state.dampers[i] > 0;
    const ys = c ? cy - bh * 0.18 : cy;
    spring(ctx, xa, xb, ys, Math.min(9, bh * 0.16));
    const midX = l < 0 ? (x0 + restX(r) - bw / 2) / 2 : r < 0 ? (restX(l) + bw / 2 + x1) / 2 : (restX(l) + restX(r)) / 2;
    text(ctx, `k${i + 1}`, midX, ys - 14, { align: "center", size: 10.5, color: colors.graphite });
    if (c) {
      dashpot(ctx, xa, xb, cy + bh * 0.22);
      text(ctx, `c${i + 1}`, midX, cy + bh * 0.22 + 20, { align: "center", size: 10.5, color: colors.graphite });
    }
  });

  // Masses
  for (let i = 0; i < n; i++) {
    const x = mx(i);
    ctx.save();
    ctx.fillStyle = colors.vellum;
    ctx.fillRect(x - bw / 2, cy - bh / 2, bw, bh);
    ctx.fillStyle = alpha(colors.graphite, 0.1);
    ctx.fillRect(x - bw / 2, cy - bh / 2, bw, bh);
    ctx.restore();
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - bw / 2, cy - bh / 2, bw, bh);
    text(ctx, `m${i + 1}`, x, cy + 4, { align: "center", size: 12, color: colors.ink });
    // Wheels
    for (const dx of [-bw / 4, bw / 4]) {
      ctx.beginPath();
      ctx.arc(x + dx, floorY - 3, 3, 0, Math.PI * 2);
      ctx.strokeStyle = colors.graphite;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Rest position tick and displacement arrow
    line(ctx, restX(i), cy - bh / 2 - 22, restX(i), cy - bh / 2 - 8, colors.graphiteSoft, 0.75);
    if (Math.abs(u[i]) > 0.02) arrow(ctx, restX(i), cy - bh / 2 - 15, restX(i) + u[i] * amp, cy - bh / 2 - 15, colors.redPencil, 1.25, 6);
    text(ctx, `${fmt(state.masses[i], 4)} kg`, restX(i), floorY + 26, { align: "center", size: 10.5, color: colors.graphite });
  }
  text(ctx, "x", x1 + 14, cy - bh / 2 - 12, { size: 11, color: colors.graphite });

  // Mode shape plot below
  if (anim.kind === "mode") {
    const py = h * 0.84;
    const phi = md.shapes[anim.index];
    const big = Math.max(...phi.map(Math.abs)) || 1;
    const pts = [];
    if (leftWall) pts.push([x0, py]);
    for (let i = 0; i < n; i++) pts.push([restX(i), py - (phi[i] / big) * h * 0.08]);
    if (rightWall) pts.push([x1, py]);
    line(ctx, x0, py, x1, py, colors.graphite, 0.75, [4, 3]);
    polyline(ctx, pts, colors.ink, 1.25);
    for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2); ctx.fillStyle = colors.ink; ctx.fill(); }
    lettering(ctx, `Mode ${anim.index + 1} shape`, x0, py - h * 0.1 - 4, { size: 10.5, color: colors.graphite });
  }
  text(ctx, "Motion exaggerated", 10, h - 10, { size: 10.5, color: colors.graphite, bg: colors.vellum });
}

function spring(ctx, xa, xb, y, amp) {
  const len = xb - xa;
  const lead = Math.min(10, Math.abs(len) * 0.15);
  const coils = 8;
  const pts = [[xa, y], [xa + lead, y]];
  for (let k = 0; k < coils * 2; k++) pts.push([xa + lead + ((len - 2 * lead) * (k + 0.5)) / (coils * 2), y + (k % 2 ? amp : -amp)]);
  pts.push([xb - lead, y], [xb, y]);
  polyline(ctx, pts, colors.graphite, 1);
}

function dashpot(ctx, xa, xb, y) {
  const mid = (xa + xb) / 2, cw = Math.min(26, (xb - xa) * 0.35), ch = 12;
  line(ctx, xa, y, mid - 4, y, colors.graphite, 1);
  line(ctx, mid - 4, y - ch / 2 + 2, mid - 4, y + ch / 2 - 2, colors.graphite, 1.5);
  line(ctx, mid - cw / 2, y - ch / 2, mid + cw / 2, y - ch / 2, colors.graphite, 1);
  line(ctx, mid - cw / 2, y + ch / 2, mid + cw / 2, y + ch / 2, colors.graphite, 1);
  line(ctx, mid + cw / 2, y - ch / 2, mid + cw / 2, y + ch / 2, colors.graphite, 1);
  line(ctx, mid + cw / 2, y, xb, y, colors.graphite, 1);
}

// Frequency response plot
function drawFrf() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(frfCanvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  if (!md || !frf.length) return;
  const pad = { l: 52, r: 10, t: 12, b: 30 };
  const vals = frf.map(([, a]) => a).filter((a) => Number.isFinite(a) && a > 0);
  if (!vals.length) return;
  let lo = Math.log10(Math.min(...vals)), hi = Math.log10(Math.max(...vals));
  lo = Math.floor(lo); hi = Math.ceil(hi);
  if (hi - lo > 8) lo = hi - 8;
  if (hi === lo) hi = lo + 1;
  const X = (wv) => pad.l + ((wv - state.w0) / (state.w1 - state.w0)) * (w - pad.l - pad.r);
  const Y = (a) => pad.t + ((hi - Math.log10(Math.max(a, 10 ** lo))) / (hi - lo)) * (h - pad.t - pad.b);
  for (let d = lo; d <= hi; d++) {
    line(ctx, pad.l, Y(10 ** d), w - pad.r, Y(10 ** d), alpha(colors.grid, 0.6), 0.75);
    text(ctx, `1e${d}`, pad.l - 4, Y(10 ** d) + 3, { size: 9.5, align: "right", color: colors.graphite });
  }
  for (const wn of md.omega) if (wn > state.w0 && wn < state.w1) line(ctx, X(wn), pad.t, X(wn), h - pad.b, colors.graphiteSoft, 0.75, [3, 3]);
  polyline(ctx, frf.map(([wv, a]) => [X(wv), Y(Number.isFinite(a) ? a : 10 ** hi)]), colors.ink, 1.25);
  line(ctx, pad.l, h - pad.b, w - pad.r, h - pad.b, colors.graphite, 0.75);
  text(ctx, `${fmt(state.w0, 3)}`, pad.l, h - pad.b + 13, { size: 9.5, color: colors.graphite });
  text(ctx, `${fmt(state.w1, 3)} rad/s`, w - pad.r, h - pad.b + 13, { size: 9.5, color: colors.graphite, align: "right" });
  text(ctx, `|X${state.watch + 1}| / F${state.forceAt + 1}, m/N`, pad.l + 4, pad.t + 10, { size: 10, color: colors.graphite, bg: colors.vellum });
}

// Inputs
function cellInput(value, onChange, label) {
  const i = el("input", { type: "number", step: "any", min: "0", value: String(value), "aria-label": label });
  i.addEventListener("change", () => {
    const v = Number(i.value);
    const ok = i.value.trim() !== "" && Number.isFinite(v);
    i.setAttribute("aria-invalid", String(!ok));
    if (ok) { onChange(v); update(); }
  });
  return i;
}

function renderInputs() {
  const n = state.masses.length;
  $("n").value = n;
  $("ends").value = state.ends;
  fillTable($("t-masses"), ["Mass", "Mass kg"], []);
  $("t-masses").querySelector("tbody").replaceChildren(...state.masses.map((m, i) => el("tr", {},
    el("td", { text: `m${i + 1}` }), el("td", {}, cellInput(m, (v) => { state.masses[i] = v; }, `Mass ${i + 1} in kg`)))));
  const nodes = springNodes(n, state.ends);
  fillTable($("t-springs"), ["Spring", "Stiffness N/m", "Damping N·s/m"], []);
  $("t-springs").querySelector("tbody").replaceChildren(...state.springs.map((k, i) => el("tr", {},
    el("td", { text: `${nodes[i][0] < 0 ? "wall" : `m${nodes[i][0] + 1}`} to ${nodes[i][1] < 0 ? "wall" : `m${nodes[i][1] + 1}`}` }),
    el("td", {}, cellInput(k, (v) => { state.springs[i] = v; }, `Spring ${i + 1} stiffness in N/m`)),
    el("td", {}, cellInput(state.dampers[i], (v) => { state.dampers[i] = v; }, `Damper ${i + 1} in N s/m`)))));
  $("rayleigh").checked = state.rayleigh.on;
  $("alpha").value = state.rayleigh.alpha;
  $("beta").value = state.rayleigh.beta;
  const opts = (sel) => state.masses.map((_, i) => el("option", { value: String(i), text: `mass ${i + 1}`, selected: i === sel }));
  $("force-at").replaceChildren(...opts(state.forceAt));
  $("watch").replaceChildren(...opts(state.watch));
  $("kick-at").replaceChildren(...opts(state.kickAt));
  $("w0").value = state.w0;
  $("w1").value = state.w1;
  $("volume").value = state.volume;
}

function suggestSweep() {
  const s = chainMatrices(chainInput());
  const m = modes(s);
  const top = Math.max(...m.omega, 1);
  const low = m.omega.find((w) => w > 0) || 1;
  state.w0 = Number((low * 0.3).toPrecision(2));
  state.w1 = Number((top * 1.4).toPrecision(2));
}

function init() {
  for (const p of Object.values(VIB_PRESETS)) {
    $("presets").append(el("button", { type: "button", text: p.label, onclick: () => {
      Object.assign(state, structuredClone({ ...p, label: undefined }));
      state.rayleigh = p.rayleigh ? { on: true, ...p.rayleigh } : { on: false, alpha: 0, beta: 0 };
      state.forceAt = 0;
      state.watch = 0;
      state.kickAt = 0;
      suggestSweep();
      anim = { ...anim, kind: "mode", index: 0, t0: performance.now() };
      renderInputs();
      update();
    } }));
  }
  for (const [k, v] of Object.entries(END_TYPES)) $("ends").append(el("option", { value: k, text: v }));
  $("n").addEventListener("change", () => {
    const n = Math.round(Number($("n").value));
    if (!(n >= 1 && n <= 8)) { $("chain-err").textContent = "Use 1 to 8 masses."; return; }
    resize(n, state.ends);
    renderInputs();
    update();
  });
  $("ends").addEventListener("change", () => { resize(state.masses.length, $("ends").value); renderInputs(); update(); });
  $("rayleigh").addEventListener("change", () => { state.rayleigh.on = $("rayleigh").checked; update(); });
  const num = (id, fn) => $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    const ok = $(id).value.trim() !== "" && Number.isFinite(v);
    $(id).setAttribute("aria-invalid", String(!ok));
    if (ok) { fn(v); update(); }
  });
  num("alpha", (v) => { state.rayleigh.alpha = Math.max(0, v); });
  num("beta", (v) => { state.rayleigh.beta = Math.max(0, v); });
  num("w0", (v) => { state.w0 = v; });
  num("w1", (v) => { state.w1 = v; });
  $("force-at").addEventListener("change", () => { state.forceAt = Number($("force-at").value); update(); });
  $("watch").addEventListener("change", () => { state.watch = Number($("watch").value); update(); });
  $("kick-at").addEventListener("change", () => { state.kickAt = Number($("kick-at").value); if (anim.kind === "free") update(); else saveState(state); });
  $("free").addEventListener("click", () => {
    if (!md) return;
    anim = { ...anim, kind: "free", playing: true };
    startFree();
    refreshAnim();
  });
  $("play").addEventListener("click", () => {
    anim.playing = !anim.playing;
    anim.t0 = performance.now();
    refreshAnim();
  });
  $("volume").addEventListener("input", () => { state.volume = Number($("volume").value); setVolume(state.volume); saveState(state); });
  $("tones").addEventListener("click", () => {
    if (!md) return;
    const map = audioMapping(md.hz);
    playModes(map.tones, md.zeta, md.damped, state.volume, (i) => {
      playingTone = i;
      document.querySelectorAll("#freqs .answer").forEach((b, k) => b.classList.toggle("lit", k === i));
      if (i >= 0) { anim = { ...anim, kind: "mode", index: i, playing: true, t0: performance.now() }; refreshAnim(); }
    });
  });
  wireCopyLink($("copy-link"));
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-vibrations.png"));
  $("csv").addEventListener("click", () => {
    if (!md) return;
    const rows = md.omega.map((w, j) => [j + 1, w, md.hz[j], md.zeta[j], ...md.shapes[j]]);
    const head = ["mode", "omega rad/s", "f Hz", "zeta", ...state.masses.map((_, i) => `phi mass ${i + 1}`)];
    download("vellum-modes.csv", toCsv(head, rows) + "\n" + toCsv(["omega rad/s", "amplitude m/N"], frf), "text/csv");
  });
  new ResizeObserver(() => { draw(); drawFrf(); }).observe(canvas);
}

init();
renderInputs();
update();
if (anim.playing) loop();
else $("play").textContent = "Play";
initSheet({ no: "06", title: "Vibrations you can hear" });
