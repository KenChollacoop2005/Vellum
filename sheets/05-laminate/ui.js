// Sheet 05 interface
import { initSheet, loadState, saveState, wireCopyLink, setAnswer, fillTable, toCsv, download, downloadCanvas, el } from "../../core/sheet.js";
import { readColors, fitCanvas, line, polyline, circle, text, lettering, alpha } from "../../core/draw.js";
import { fixed, fmt } from "../../core/units.js";
import { MATERIALS, LAM_PRESETS, analyzeLaminate, parseLayup, layupCode, laminateEx, plyEx } from "./model.js";

const LIB_FIELDS = [
  ["E1", "E1", "GPa", 1e-3], ["E2", "E2", "GPa", 1e-3], ["G12", "G12", "GPa", 1e-3], ["nu12", "ν12", "", 1],
  ["Xt", "Xt", "MPa", 1], ["Xc", "Xc", "MPa", 1], ["Yt", "Yt", "MPa", 1], ["Yc", "Yc", "MPa", 1], ["S", "S", "MPa", 1], ["t", "Ply t", "mm", 1],
];
const MAX_PLIES = 64; // stack size limit
const POLAR_STEPS = 180; // samples around the polar plot

const DEFAULT = {
  plies: parseLayup(LAM_PRESETS.fairing.code).map((a) => ({ angle: a, mat: "as4" })),
  load: { N: [100, 0, 0], M: [0, 0, 0] },
  f12: -0.5,
  lib: structuredClone(MATERIALS),
  overlay: false,
  newmat: "as4",
};

const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
let colors = null;
let state = loadState(DEFAULT, validState);
let res = null;
let selectedPly = 0;
let dragFrom = null;

function validState(s) {
  const f = Number.isFinite;
  if (!Array.isArray(s?.plies) || !s.load || !s.lib || !f(s.f12)) return false;
  if (!s.plies.every((p) => f(p.angle) && s.lib[p.mat])) return false;
  if (!Array.isArray(s.load.N) || !Array.isArray(s.load.M) || ![...s.load.N, ...s.load.M].every(f)) return false;
  return Object.values(s.lib).every((m) => typeof m.name === "string"
    && LIB_FIELDS.every(([k]) => (k === "nu12" ? f(m[k]) : f(m[k]) && m[k] > 0)));
}

function libError() {
  for (const m of Object.values(state.lib)) {
    if (!(m.E1 > 0 && m.E2 > 0 && m.G12 > 0 && m.t > 0)) return `${m.name}: moduli and thickness must be greater than zero.`;
    if (!(m.Xt > 0 && m.Xc > 0 && m.Yt > 0 && m.Yc > 0 && m.S > 0)) return `${m.name}: strengths must be greater than zero.`;
    if (!(m.nu12 * m.nu12 * m.E2 / m.E1 < 1)) return `${m.name}: ν12 is too large for these moduli.`;
  }
  return null;
}

// Update
function update() {
  const err = libError();
  $("load-err").textContent = err || "";
  res = err ? { ok: false, error: err } : analyzeLaminate(state.plies, state.load, state.f12, state.lib);
  $("code").value = layupCode(state.plies.map((p) => p.angle));
  renderFind();
  draw();
  saveState(state);
}

function renderFind() {
  const warn = $("warnings");
  if (!res.ok) {
    warn.replaceChildren(el("p", { class: "err", text: res.error }));
    for (const id of ["ans-ex", "ans-ey", "ans-gxy", "ans-nu", "ans-ms", "ans-tw"]) setAnswer(id, "n/a");
    return;
  }
  warn.replaceChildren(...res.warnings.map((w) => el("p", { class: "err", text: w })));
  setAnswer("ans-ex", fixed(res.Ex / 1e3, 3), "GPa");
  setAnswer("ans-ey", fixed(res.Ey / 1e3, 3), "GPa");
  setAnswer("ans-gxy", fixed(res.Gxy / 1e3, 3), "GPa");
  setAnswer("ans-nu", fixed(res.nuxy, 4), "");
  const fp = (f) => {
    if (!res.loaded || !Number.isFinite(f.factor)) return ["n/a", "", "No load applied."];
    const p = res.plies[f.ply];
    return [fixed(f.factor, 3), "λ", `ply ${f.ply + 1} (${fmt(p.angle, 4)}°, ${f.pos}), ${f.mode}`];
  };
  setAnswer("ans-ms", ...fp(res.fpf.maxStress));
  setAnswer("ans-tw", ...fp(res.fpf.tsaiWu));
  const mat3 = (M, scale, d) => M.map((r, i) => [String(i === 2 ? 6 : i + 1), ...r.map((v) => fixed(v * scale, d))]);
  fillTable($("t-a"), ["A MN/m", "1", "2", "6"], mat3(res.A, 1e-3, 3));
  fillTable($("t-b"), ["B N", "1", "2", "6"], mat3(res.B, 1, 1));
  fillTable($("t-d"), ["D N·m", "1", "2", "6"], mat3(res.D, 1e-3, 3));
  const rows = [];
  res.plies.forEach((p, i) => p.points.forEach((q) => rows.push([
    `${i + 1} ${q.pos === "top" ? "top" : "bot"}`, fmt(p.angle, 4),
    ...q.epsMat.map((e) => fixed(e * 1e6, 1)), ...q.sigMat.map((s) => fixed(s, 2)),
    fixed(q.ms.index, 3), fixed(q.tw.index, 3),
  ])));
  fillTable($("t-plies"), ["Ply", "θ°", "ε1 µε", "ε2 µε", "γ12 µε", "σ1 MPa", "σ2 MPa", "τ12 MPa", "FI ms", "FI tw"], rows);
  $("status-note").textContent = `${state.plies.length} plies, h = ${fixed(res.h, 3)} mm. Failure index FI = 1/λ for the applied load.`;
  $("bar-note").textContent = layupCode(state.plies.map((p) => p.angle));
}

// Drawing
function draw() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  if (!res?.ok) return;
  const wide = w >= 620;
  if (wide) {
    const topH = h * (res.loaded ? 0.6 : 1);
    drawSection(ctx, { x: 0, y: 0, w: w * 0.42, h: topH });
    drawPolar(ctx, { x: w * 0.42, y: 0, w: w * 0.58, h: topH });
    if (res.loaded) {
      drawThrough(ctx, { x: 0, y: topH, w: w / 2, h: h - topH }, "strain");
      drawThrough(ctx, { x: w / 2, y: topH, w: w / 2, h: h - topH }, "stress");
    }
    return;
  }
  const parts = res.loaded ? [0.24, 0.36, 0.2, 0.2] : [0.4, 0.6];
  const ys = parts.map((f, i) => parts.slice(0, i).reduce((acc, v) => acc + v, 0) * h);
  drawSection(ctx, { x: 0, y: ys[0], w, h: parts[0] * h });
  drawPolar(ctx, { x: 0, y: ys[1], w, h: parts[1] * h });
  if (res.loaded) {
    drawThrough(ctx, { x: 0, y: ys[2], w, h: parts[2] * h }, "strain");
    drawThrough(ctx, { x: 0, y: ys[3], w, h: parts[3] * h }, "stress");
  }
}

function drawSection(ctx, b) {
  lettering(ctx, "Cross section", b.x + 10, b.y + 18, { size: 11, color: colors.graphite });
  const n = state.plies.length;
  const sh = Math.min(b.h - 70, Math.max(60, n * 26));
  const sw = Math.min(b.w - 170, 260);
  const x0 = b.x + 60, y0 = b.y + 36 + (b.h - 70 - sh) / 2;
  const plyH = sh / n;
  state.plies.forEach((p, i) => {
    const top = y0 + sh - (i + 1) * plyH;
    const sel = i === selectedPly;
    ctx.save();
    ctx.fillStyle = sel ? alpha(colors.graphite, 0.12) : colors.vellum;
    ctx.fillRect(x0, top, sw, plyH);
    ctx.restore();
    drawFibers(ctx, x0, top, sw, plyH, p.angle);
    ctx.strokeStyle = colors.graphite;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, top + 0.5, sw, plyH);
    if (plyH >= 11) {
      text(ctx, `${fmt(p.angle, 4)}°`, x0 + sw / 2, top + plyH / 2, { align: "center", baseline: "middle", size: Math.min(12, plyH - 2), color: colors.ink, bg: colors.vellum });
      text(ctx, String(i + 1), x0 - 8, top + plyH / 2, { align: "right", baseline: "middle", size: Math.min(10.5, plyH - 1), color: colors.graphite });
    }
  });
  text(ctx, "ply", x0 - 8, y0 - 6, { align: "right", size: 10, color: colors.graphite });
  // Thickness dimension and midplane
  const dx = x0 + sw + 54;
  line(ctx, dx, y0, dx, y0 + sh, colors.graphiteSoft, 0.75);
  line(ctx, dx - 4, y0, dx + 4, y0, colors.graphiteSoft, 0.75);
  line(ctx, dx - 4, y0 + sh, dx + 4, y0 + sh, colors.graphiteSoft, 0.75);
  text(ctx, `h = ${fixed(res.h, 3)} mm`, dx + 6, y0 + sh / 2, { baseline: "middle", size: 10.5, color: colors.graphite });
  line(ctx, x0 - 14, y0 + sh / 2, x0 + sw + 10, y0 + sh / 2, colors.graphite, 0.75, [6, 3, 2, 3]);
  text(ctx, "z = 0", x0 + sw + 12, y0 + sh / 2 - 12, { size: 10, color: colors.graphite });
}

function drawFibers(ctx, x, y, w, h, deg) {
  const a = (deg * Math.PI) / 180;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = alpha(colors.graphite, 0.55);
  ctx.lineWidth = 0.6;
  const dir = [Math.cos(a), -Math.sin(a)];
  const nrm = [-dir[1], dir[0]];
  const cx = x + w / 2, cy = y + h / 2, R = Math.hypot(w, h);
  ctx.beginPath();
  for (let s = -R; s <= R; s += 7) {
    const px = cx + nrm[0] * s, py = cy + nrm[1] * s;
    ctx.moveTo(px - dir[0] * R, py - dir[1] * R);
    ctx.lineTo(px + dir[0] * R, py + dir[1] * R);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPolar(ctx, b) {
  lettering(ctx, "Polar plot", b.x + 10, b.y + 18, { size: 11, color: colors.graphite });
  text(ctx, "Ex(θ) of the laminate rotated by θ, GPa", b.x + 10, b.y + 32, { size: 10.5, color: colors.graphite });
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2 + 16;
  const R = Math.min(b.w, b.h) / 2 - 42;
  const ex = [];
  let emax = 0;
  for (let i = 0; i <= POLAR_STEPS; i++) {
    const t = (360 * i) / POLAR_STEPS;
    const v = laminateEx(state.plies, t, state.lib);
    ex.push([t, v]);
    emax = Math.max(emax, v);
  }
  let ply = null;
  if (state.overlay) {
    const mat = state.lib[state.plies[selectedPly]?.mat] || Object.values(state.lib)[0];
    ply = [];
    for (let i = 0; i <= POLAR_STEPS; i++) {
      const t = (360 * i) / POLAR_STEPS;
      const v = plyEx(mat, t - (state.plies[selectedPly]?.angle || 0));
      ply.push([t, v]);
      emax = Math.max(emax, v);
    }
  }
  const step = niceStep(emax / 1e3 / 4);
  const top = Math.ceil(emax / 1e3 / step) * step;
  const sc = R / top;
  for (let r = step; r <= top + 1e-9; r += step) {
    circle(ctx, cx, cy, r * sc, alpha(colors.graphite, 0.35), null, 0.75);
    text(ctx, fmt(r, 3), cx + r * sc - 2, cy + 12, { size: 9.5, color: colors.graphite, align: "right", bg: colors.vellum });
  }
  for (let a = 0; a < 360; a += 30) {
    const t = (a * Math.PI) / 180;
    line(ctx, cx, cy, cx + Math.cos(t) * R, cy - Math.sin(t) * R, alpha(colors.graphite, 0.35), 0.75);
    text(ctx, `${a}°`, cx + Math.cos(t) * (R + 14), cy - Math.sin(t) * (R + 14), { size: 9.5, align: "center", baseline: "middle", color: colors.graphite });
  }
  const pts = (arr) => arr.map(([t, v]) => {
    const r = (v / 1e3) * sc, a = (t * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy - Math.sin(a) * r];
  });
  if (ply) polyline(ctx, pts(ply), colors.graphite, 1, [4, 3]);
  polyline(ctx, pts(ex), colors.ink, 1.75);
  if (ply) text(ctx, `dashed: ply ${selectedPly + 1} alone`, b.x + 10, b.y + b.h - 10, { size: 10.5, color: colors.graphite });
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return k * p;
  return 10 * p;
}

function drawThrough(ctx, b, kind) {
  const pad = { l: 52, r: 16, t: b.w < 420 ? 42 : 26, bt: 26 };
  line(ctx, b.x, b.y + 4, b.x + b.w, b.y + 4, colors.hairline, 1);
  lettering(ctx, kind === "strain" ? "Strain" : "Stress", b.x + 10, b.y + 20, { size: 11, color: colors.graphite });
  text(ctx, kind === "strain" ? "through thickness, µε" : "through thickness, MPa (global axes)", b.x + 70, b.y + 20, { size: 10.5, color: colors.graphite });
  const series = [[], [], []];
  for (const p of res.plies) for (const q of p.points) {
    const v = kind === "strain" ? q.epsGlobal.map((e) => e * 1e6) : q.sigGlobal;
    v.forEach((x, i) => series[i].push([q.z, x]));
  }
  let vmax = 1e-12;
  for (const s of series) for (const [, v] of s) vmax = Math.max(vmax, Math.abs(v));
  vmax *= 1.1;
  const zmin = -res.h / 2, zmax = res.h / 2;
  const X = (v) => b.x + pad.l + ((v + vmax) / (2 * vmax)) * (b.w - pad.l - pad.r);
  const Z = (z) => b.y + pad.t + ((zmax - z) / (zmax - zmin)) * (b.h - pad.t - pad.bt);
  line(ctx, X(0), Z(zmax), X(0), Z(zmin), colors.graphite, 0.75);
  line(ctx, X(-vmax), Z(0), X(vmax), Z(0), colors.graphite, 0.5, [4, 3]);
  for (const zb of res.z) line(ctx, X(-vmax), Z(zb), X(vmax), Z(zb), alpha(colors.hairline, 0.8), 0.5);
  text(ctx, fmt(-vmax, 3), X(-vmax), b.y + b.h - 8, { size: 9.5, color: colors.graphite });
  text(ctx, fmt(vmax, 3), X(vmax), b.y + b.h - 8, { size: 9.5, color: colors.graphite, align: "right" });
  text(ctx, "z top", b.x + 8, Z(zmax) + 4, { size: 9.5, color: colors.graphite });
  text(ctx, "z bot", b.x + 8, Z(zmin), { size: 9.5, color: colors.graphite });
  const styles = [[colors.ink, null], [colors.draftBlue, [5, 3]], [colors.redPencil, [2, 3]]];
  const names = kind === "strain" ? ["εx", "εy", "γxy"] : ["σx", "σy", "τxy"];
  series.forEach((s, i) => {
    for (let k = 0; k < s.length; k += 2) polyline(ctx, [[X(s[k][1]), Z(s[k][0])], [X(s[k + 1][1]), Z(s[k + 1][0])]], styles[i][0], 1.5, styles[i][1]);
    const ly = b.y + (b.w < 420 ? 34 : 16);
    line(ctx, b.x + b.w - 150 + i * 46, ly, b.x + b.w - 136 + i * 46, ly, styles[i][0], 1.5, styles[i][1]);
    text(ctx, names[i], b.x + b.w - 133 + i * 46, ly + 4, { size: 10.5, color: styles[i][0] });
  });
}

// Ply list
function matOptions(sel, short = false) {
  return Object.entries(state.lib).map(([k, m]) => el("option", { value: k, text: short ? (m.short || MATERIALS[k]?.short || m.name) : m.name, title: m.name, selected: k === sel }));
}

function renderPlies() {
  const list = $("plies");
  const items = [];
  for (let i = state.plies.length - 1; i >= 0; i--) {
    const p = state.plies[i];
    const ang = el("input", { type: "number", step: "15", value: String(p.angle), "aria-label": `Ply ${i + 1} angle in degrees` });
    ang.addEventListener("change", () => {
      const v = Number(ang.value);
      if (ang.value.trim() === "" || !Number.isFinite(v) || Math.abs(v) > 180) { ang.setAttribute("aria-invalid", "true"); return; }
      state.plies[i].angle = v;
      update();
    });
    const mat = el("select", { "aria-label": `Ply ${i + 1} material`, title: state.lib[p.mat]?.name || "" }, matOptions(p.mat, true));
    mat.addEventListener("change", () => { state.plies[i].mat = mat.value; update(); });
    const up = el("button", { type: "button", text: "Up", "aria-label": `Move ply ${i + 1} up`, disabled: i === state.plies.length - 1 });
    up.addEventListener("click", () => movePly(i, i + 1));
    const dn = el("button", { type: "button", text: "Dn", "aria-label": `Move ply ${i + 1} down`, disabled: i === 0 });
    dn.addEventListener("click", () => movePly(i, i - 1));
    const rm = el("button", { type: "button", text: "X", "aria-label": `Remove ply ${i + 1}` });
    rm.addEventListener("click", () => { state.plies.splice(i, 1); selectedPly = Math.min(selectedPly, state.plies.length - 1); renderPlies(); update(); });
    const li = el("li", { class: i === selectedPly ? "sel" : "", draggable: "true", value: String(i + 1) },
      el("span", { class: "grip", text: String(i + 1), title: "Drag to reorder" }), ang, el("span", { class: "unit", text: "°" }), mat, up, dn, rm);
    li.addEventListener("click", (e) => { if (e.target === li || e.target.classList.contains("grip")) { selectedPly = i; renderPlies(); draw(); } });
    li.addEventListener("dragstart", (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (e) => { e.preventDefault(); if (dragFrom !== null) movePly(dragFrom, i); dragFrom = null; });
    items.push(li);
  }
  list.replaceChildren(...items);
}

function movePly(from, to) {
  if (to < 0 || to >= state.plies.length || from === to) return;
  const [p] = state.plies.splice(from, 1);
  state.plies.splice(to, 0, p);
  selectedPly = to;
  renderPlies();
  update();
}

// Library editor
function renderLib() {
  const key = $("libmat").value;
  const m = state.lib[key];
  $("libfields").replaceChildren(...LIB_FIELDS.map(([k, label, unit, sc]) => {
    const id = `lib-${k}`;
    const inp = el("input", { type: "number", id, step: "any", value: String(Number((m[k] * sc).toPrecision(6))) });
    inp.addEventListener("change", () => {
      const v = Number(inp.value);
      if (inp.value.trim() === "" || !Number.isFinite(v)) { inp.setAttribute("aria-invalid", "true"); return; }
      inp.setAttribute("aria-invalid", "false");
      state.lib[key][k] = v / sc;
      update();
    });
    return el("div", { class: "field" }, el("label", { for: id }, label.includes("ν") ? el("span", { class: "sym", text: label }) : label), inp, el("span", { class: "unit", text: unit }));
  }));
  $("lib-source").textContent = `Source: ${m.source}`;
}

function syncInputs() {
  ["Nx", "Ny", "Nxy"].forEach((id, i) => { $(id).value = state.load.N[i]; });
  ["Mx", "My", "Mxy"].forEach((id, i) => { $(id).value = state.load.M[i]; });
  $("f12").value = state.f12;
  $("overlay").checked = state.overlay;
  $("newmat").replaceChildren(...matOptions(state.newmat));
  renderPlies();
  renderLib();
}

function init() {
  for (const p of Object.values(LAM_PRESETS)) {
    $("presets").append(el("button", { type: "button", text: p.label, onclick: () => {
      state.plies = parseLayup(p.code).map((a) => ({ angle: a, mat: p.mat }));
      state.newmat = p.mat;
      selectedPly = 0;
      $("preset-note").textContent = p.code === LAM_PRESETS.fairing.code ? "Example layup only, not a real part. A thin carbon stack like the ones used on student bike fairings." : "";
      syncInputs();
      update();
    } }));
  }
  $("libmat").replaceChildren(...matOptions("t300"));
  $("libmat").addEventListener("change", renderLib);
  $("lib-reset").addEventListener("click", () => { state.lib = structuredClone(MATERIALS); syncInputs(); update(); });
  $("expand").addEventListener("click", expand);
  $("code").addEventListener("keydown", (e) => { if (e.key === "Enter") expand(); });
  $("newmat").addEventListener("change", () => { state.newmat = $("newmat").value; });
  $("add-ply").addEventListener("click", () => {
    if (state.plies.length >= MAX_PLIES) return;
    state.plies.push({ angle: 0, mat: state.newmat });
    selectedPly = state.plies.length - 1;
    renderPlies();
    update();
  });
  const loadInput = (id, arr, i) => $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    const ok = $(id).value.trim() !== "" && Number.isFinite(v);
    $(id).setAttribute("aria-invalid", String(!ok));
    $("load-err").textContent = ok ? "" : "Loads must be numbers.";
    if (ok) { state.load[arr][i] = v; update(); }
  });
  ["Nx", "Ny", "Nxy"].forEach((id, i) => loadInput(id, "N", i));
  ["Mx", "My", "Mxy"].forEach((id, i) => loadInput(id, "M", i));
  $("f12").addEventListener("change", () => {
    const v = Number($("f12").value);
    if (!(v >= -1 && v <= 1)) { $("load-err").textContent = "F12* should be between −1 and 1."; return; }
    $("load-err").textContent = "";
    state.f12 = v;
    update();
  });
  $("overlay").addEventListener("change", () => { state.overlay = $("overlay").checked; update(); });
  wireCopyLink($("copy-link"));
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-laminate.png"));
  $("csv").addEventListener("click", () => {
    if (!res?.ok) return;
    const rows = [];
    res.plies.forEach((p, i) => p.points.forEach((q) => rows.push([i + 1, p.angle, p.mat, q.pos, q.z, ...q.epsMat, ...q.sigMat, q.ms.index, q.tw.index])));
    download("vellum-laminate.csv", toCsv(["ply", "angle deg", "material", "surface", "z mm", "eps1", "eps2", "gamma12", "sigma1 MPa", "sigma2 MPa", "tau12 MPa", "FI max stress", "FI Tsai Wu"], rows), "text/csv");
  });
  new ResizeObserver(() => draw()).observe(canvas);
}

function expand() {
  try {
    const angles = parseLayup($("code").value);
    state.plies = angles.map((a) => ({ angle: a, mat: state.newmat }));
    selectedPly = 0;
    $("code-err").textContent = "";
    renderPlies();
    update();
  } catch (e) {
    $("code-err").textContent = e.message;
  }
}

init();
syncInputs();
update();
initSheet({ no: "05", title: "Laminate calculator" });
