// Sheet 02 interface
import { initSheet, loadState, saveState, wireCopyLink, setAnswer, fillTable, toCsv, download, downloadCanvas, el } from "../../core/sheet.js";
import {
  readColors, fitCanvas, line, polyline, circle, text, lettering, arrow, momentArrow, pinSupport, rollerSupport,
  fixedSupport, distLoad, dimension, alpha,
} from "../../core/draw.js";
import { fmt, fixed } from "../../core/units.js";
import { solveBeam, principal, transformStress, SUPPORTS, BEAM_PRESETS, supportList } from "./model.js";

const DEG = Math.PI / 180;
const MOHR_PRESETS = [
  { label: "Spec case M1", sx: 80, sy: -40, txy: 30 },
  { label: "Pure shear", sx: 0, sy: 0, txy: 50 },
  { label: "Uniaxial tension", sx: 100, sy: 0, txy: 0 },
  { label: "Biaxial, same sign", sx: 120, sy: 40, txy: 25 },
];
const DEFAULT = {
  tab: "beam",
  beam: structuredClone({ ...BEAM_PRESETS.overhang, label: undefined }),
  mohr: { sx: 80, sy: -40, txy: 30, theta: 0 },
};
const PLOT = { left: 64, right: 22, top: 10, gap: 14 }; // beam plot margins in px

const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
const tip = document.querySelector(".tip");
let colors = null;
let state = loadState(DEFAULT, validState);
let beamRes = null;
let cursorX = null;
let mohrGeom = null;
let dragging = false;

function validState(s) {
  const b = s?.beam, m = s?.mohr;
  const f = Number.isFinite;
  return b && m && ["beam", "mohr"].includes(s.tab) && f(b.L) && f(b.E) && f(b.I) && SUPPORTS[b.support] && Array.isArray(b.loads)
    && b.loads.every((l) => ["point", "moment", "dist"].includes(l.type))
    && f(m.sx) && f(m.sy) && f(m.txy) && f(m.theta);
}

// Tabs
function setTab(t) {
  state.tab = t;
  const beam = t === "beam";
  $("tab-beam").setAttribute("aria-selected", String(beam));
  $("tab-beam").setAttribute("aria-pressed", String(beam));
  $("tab-mohr").setAttribute("aria-selected", String(!beam));
  $("tab-mohr").setAttribute("aria-pressed", String(!beam));
  $("given-beam").hidden = !beam;
  $("find-beam").hidden = !beam;
  $("given-mohr").hidden = beam;
  $("find-mohr").hidden = beam;
  canvas.setAttribute("aria-label", beam ? "Beam loading, shear, moment and deflection diagrams. Left and right arrow keys move the cursor and read V, M and deflection." : "Mohr's circle and rotated stress element. Drag the red point to rotate.");
  tip.hidden = true;
  update();
}

// Beam inputs
function numInput(value, onChange, attrs = {}) {
  const i = el("input", { type: "number", step: "any", value: String(value), ...attrs });
  i.addEventListener("change", () => {
    const v = Number(i.value);
    const ok = i.value.trim() !== "" && Number.isFinite(v);
    i.setAttribute("aria-invalid", String(!ok));
    if (ok) onChange(v);
  });
  return i;
}

function loadRow(ld, idx) {
  const set = (k, scale = 1) => (v) => { state.beam.loads[idx][k] = v * scale; update(); };
  const fields = [];
  const fld = (label, value, unit, cb) => {
    const id = `ld-${idx}-${label.replace(/\W+/g, "")}`;
    const inp = numInput(value, cb, { id });
    fields.push(el("div", { class: "field" }, el("label", { for: id, text: label }), inp, el("span", { class: "unit", text: unit })));
  };
  let title = "";
  if (ld.type === "point") {
    title = "Point load";
    fld("at x", ld.x, "m", set("x"));
    fld("P", ld.P / 1e3, "kN", set("P", 1e3));
  } else if (ld.type === "moment") {
    title = "Point moment";
    fld("at x", ld.x, "m", set("x"));
    fld("M", ld.M / 1e3, "kN·m", set("M", 1e3));
  } else {
    title = "Distributed load";
    fld("from x", ld.x1, "m", set("x1"));
    fld("to x", ld.x2, "m", set("x2"));
    fld("q start", ld.q1 / 1e3, "kN/m", set("q1", 1e3));
    fld("q end", ld.q2 / 1e3, "kN/m", set("q2", 1e3));
  }
  const rm = el("button", { type: "button", text: "Remove", "aria-label": `Remove load ${idx + 1}` });
  rm.addEventListener("click", () => { state.beam.loads.splice(idx, 1); renderLoads(); update(); });
  return el("fieldset", { class: "load" }, el("legend", { text: `${idx + 1}. ${title}` }), ...fields, el("div", { class: "btn-row" }, rm));
}

function renderLoads() {
  $("loads").replaceChildren(...state.beam.loads.map(loadRow));
}

function syncBeamInputs() {
  const b = state.beam;
  $("L").value = b.L;
  $("support").value = b.support;
  $("sa").value = b.a ?? 0;
  $("sb").value = b.b ?? b.L;
  $("overhang-fields").hidden = b.support !== "overhang";
  $("bE").value = b.E / 1e9;
  $("bI").value = b.I * 1e6;
  renderLoads();
}

function syncMohrInputs() {
  const m = state.mohr;
  $("sx").value = m.sx; $("sy").value = m.sy; $("txy").value = m.txy;
  $("theta").value = fixed(m.theta, 2); $("theta-range").value = m.theta;
}

// Update
function update() {
  if (state.tab === "beam") {
    beamRes = solveBeam(state.beam);
    renderBeamFind();
  } else {
    renderMohrFind();
  }
  draw();
  saveState(state);
}

function renderBeamFind() {
  const err = $("beam-err");
  if (!beamRes.ok) {
    err.textContent = beamRes.error;
    for (const id of ["ans-v", "ans-m", "ans-w"]) setAnswer(id, "n/a");
    fillTable($("t-react"), ["Support"], []);
    $("status-note").textContent = "";
    return;
  }
  err.textContent = "";
  const r = beamRes;
  setAnswer("ans-v", fixed(r.maxShear.value / 1e3, 3), "kN", `at x = ${fixed(r.maxShear.x, 3)} m`);
  setAnswer("ans-m", fixed(r.maxMoment.value / 1e3, 3), "kN·m", `at x = ${fixed(r.maxMoment.x, 3)} m, ${r.maxMoment.signed >= 0 ? "sagging" : "hogging"}`);
  setAnswer("ans-w", fixed(r.maxDeflection.value * 1e3, 3), "mm", `at x = ${fixed(r.maxDeflection.x, 3)} m, ${r.maxDeflection.signed <= 0 ? "down" : "up"}`);
  fillTable($("t-react"), ["Support", "x m", "R kN", "M kN·m"], r.reactions.map((x) => [
    x.kind, fixed(x.x, 3), fixed(x.R / 1e3, 3), x.kind === "fixed" ? fixed(x.M / 1e3, 3) : "",
  ]));
  $("status-note").textContent = `R positive up, M counterclockwise. ${r.nodes - 1} beam elements. FE and statics moments agree to ${fmt(r.feStaticsGap, 2)} kN·m.`;
  $("bar-note").textContent = "Hover the diagrams, or focus them and use the arrow keys, to read values.";
}

function renderMohrFind() {
  const m = state.mohr;
  const p = principal(m.sx, m.sy, m.txy);
  const t = transformStress(m.sx, m.sy, m.txy, m.theta * DEG);
  setAnswer("ans-s1", fixed(p.s1, 3), "MPa");
  setAnswer("ans-s2", fixed(p.s2, 3), "MPa");
  setAnswer("ans-tmax", fixed(p.tauMax, 3), "MPa", `at θs = ${fixed(p.thetaS / DEG, 3)}°`);
  setAnswer("ans-tp", fixed(p.thetaP / DEG, 3), "°", "x axis to σ1, counterclockwise");
  fillTable($("t-rot"), ["θ deg", "σx' MPa", "σy' MPa", "τx'y' MPa"], [[fixed(m.theta, 2), fixed(t.sx, 3), fixed(t.sy, 3), fixed(t.txy, 3)]]);
  fillTable($("t-abs"), ["Quantity", "MPa"], [["σ3 (plane stress)", "0.000"], ["absolute max shear", fixed(p.tauAbs, 3)]]);
  $("status-note").textContent = "τ is plotted positive downward. Drag the red point on the circle to rotate the element.";
  $("bar-note").textContent = "";
}

// Drawing
function draw() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  if (state.tab === "beam") drawBeam(ctx, w, h);
  else drawMohr(ctx, w, h);
}

function beamX(x, w) {
  return PLOT.left + (x / state.beam.L) * (w - PLOT.left - PLOT.right);
}

function panels(h) {
  const usable = h - PLOT.top - 3 * PLOT.gap - 8;
  const hs = [0.28, 0.24, 0.24, 0.24].map((f) => f * usable);
  let y = PLOT.top;
  return hs.map((ph) => {
    const p = { y, h: ph };
    y += ph + PLOT.gap;
    return p;
  });
}

function drawBeam(ctx, w, h) {
  if (!beamRes?.ok) {
    text(ctx, beamRes?.error || "", 16, 30, { color: colors.redPencil, size: 13 });
    return;
  }
  const b = state.beam, r = beamRes;
  const [pl, pv, pm, pw] = panels(h);
  const X = (x) => beamX(x, w);

  // Loading diagram
  const by = pl.y + pl.h * 0.62;
  lettering(ctx, "Loading", 6, pl.y + 12, { size: 11, color: colors.graphite });
  for (const ld of b.loads.filter((l) => l.type === "dist")) {
    const qmax = Math.max(...b.loads.filter((l) => l.type === "dist").map((l) => Math.max(Math.abs(l.q1), Math.abs(l.q2))), 1e-9);
    const L1 = (Math.abs(ld.q1) / qmax) * 34, L2 = (Math.abs(ld.q2) / qmax) * 34;
    drawDist(ctx, X(ld.x1), X(ld.x2), by - 4, ld.q1 >= 0 ? L1 : -L1, ld.q2 >= 0 ? L2 : -L2);
    text(ctx, ld.q1 === ld.q2 ? `${fmt(ld.q1 / 1e3, 3)} kN/m` : `${fmt(ld.q1 / 1e3, 3)} to ${fmt(ld.q2 / 1e3, 3)} kN/m`,
      (X(ld.x1) + X(ld.x2)) / 2, by - 44, { align: "center", color: colors.redPencil, size: 11, bg: colors.vellum });
  }
  ctx.save();
  ctx.fillStyle = alpha(colors.graphite, 0.12);
  ctx.fillRect(X(0), by - 3, X(b.L) - X(0), 6);
  ctx.restore();
  line(ctx, X(0), by - 3, X(b.L), by - 3, colors.graphite, 1.25);
  line(ctx, X(0), by + 3, X(b.L), by + 3, colors.graphite, 1.25);
  line(ctx, X(0), by - 3, X(0), by + 3, colors.graphite, 1.25);
  line(ctx, X(b.L), by - 3, X(b.L), by + 3, colors.graphite, 1.25);
  for (const [x, kind] of supportList(b)) {
    if (kind === "pin") pinSupport(ctx, X(x), by + 3, colors.draftBlue, 12);
    else if (kind === "roller") rollerSupport(ctx, X(x), by + 3, colors.draftBlue, 12);
    else fixedSupport(ctx, X(x), by, colors.draftBlue, 30, x === 0 ? Math.PI / 2 : -Math.PI / 2);
  }
  for (const ld of b.loads) {
    if (ld.type === "point") {
      const d = ld.P >= 0 ? 1 : -1;
      arrow(ctx, X(ld.x), by - 3 - d * 38 - (d < 0 ? 6 : 0), X(ld.x), by - 3 - (d < 0 ? -6 : 0), colors.redPencil, 1.5, 8);
      const nearEnd = X(ld.x) > w - 80;
      text(ctx, `${fmt(Math.abs(ld.P) / 1e3, 3)} kN`, X(ld.x) + (nearEnd ? -5 : 5), by - 36, { color: colors.redPencil, size: 11, bg: colors.vellum, align: nearEnd ? "right" : "left" });
    } else if (ld.type === "moment") {
      momentArrow(ctx, X(ld.x), by, 14, ld.M > 0, colors.redPencil);
      text(ctx, `${fmt(Math.abs(ld.M) / 1e3, 3)} kN·m`, X(ld.x) + 16, by - 18, { color: colors.redPencil, size: 11, bg: colors.vellum });
    }
  }
  dimension(ctx, X(0), pl.y + pl.h - 4, X(b.L), pl.y + pl.h - 4, 0, `L = ${fmt(b.L, 4)} m`, colors.graphiteSoft, colors.graphite);

  const pts = r.plot;
  plotPanel(ctx, pv, w, pts.map((p) => [p.x, p.V / 1e3]), "Shear V", "kN", true);
  plotPanel(ctx, pm, w, pts.map((p) => [p.x, p.M / 1e3]), "Moment M", "kN·m", true);
  plotPanel(ctx, pw, w, pts.map((p) => [p.x, p.w * 1e3]), "Deflection", "mm", false);

  // Cursor
  if (cursorX !== null) {
    const sx = X(cursorX);
    line(ctx, sx, pl.y, sx, pw.y + pw.h, colors.ink, 0.75, [3, 3]);
  }
}

function drawDist(ctx, x1, x2, y, len1, len2) {
  distLoad(ctx, x1, y, x2, y, len1, len2, colors.redPencil, Math.max(Math.abs(len1), Math.abs(len2)));
}

function plotPanel(ctx, p, w, data, title, unit, shade) {
  const X = (x) => beamX(x, w);
  const mid = p.y + p.h / 2;
  let vmax = 0;
  for (const [, v] of data) vmax = Math.max(vmax, Math.abs(v));
  const sc = vmax > 0 ? (p.h * 0.42) / vmax : 0;
  const Y = (v) => mid - v * sc;
  lettering(ctx, title, 6, p.y + 12, { size: 11, color: colors.graphite });
  text(ctx, unit, 6, p.y + 26, { size: 10, color: colors.graphite });
  line(ctx, X(0), mid, X(state.beam.L), mid, colors.graphite, 0.75);
  if (shade && vmax > 0) {
    for (const [sign, col] of [[1, colors.redPencil], [-1, colors.draftBlue]]) {
      ctx.save();
      ctx.beginPath();
      if (sign > 0) ctx.rect(X(0), p.y, X(state.beam.L) - X(0), mid - p.y);
      else ctx.rect(X(0), mid, X(state.beam.L) - X(0), p.y + p.h - mid);
      ctx.clip();
      ctx.fillStyle = alpha(col, 0.13);
      ctx.beginPath();
      ctx.moveTo(X(data[0][0]), mid);
      for (const [x, v] of data) ctx.lineTo(X(x), Y(v));
      ctx.lineTo(X(data[data.length - 1][0]), mid);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  polyline(ctx, data.map(([x, v]) => [X(x), Y(v)]), shade ? colors.ink : colors.ink, 1.5);
  if (!shade) polyline(ctx, [[X(0), mid], [X(state.beam.L), mid]], colors.graphite, 1, [5, 4]);
  // Extreme labels
  let iMax = 0, iMin = 0;
  data.forEach(([, v], i) => { if (v > data[iMax][1]) iMax = i; if (v < data[iMin][1]) iMin = i; });
  const lab = (i, above) => {
    const [x, v] = data[i];
    if (Math.abs(v) < 1e-9) return;
    text(ctx, `${fixed(v, 3)}`, Math.min(X(x) + 4, w - 70), Y(v) + (above ? -5 : 13), { size: 10.5, color: colors.ink, bg: colors.vellum });
  };
  if (data[iMax][1] > 0) lab(iMax, true);
  if (data[iMin][1] < 0) lab(iMin, false);
}

// Mohr drawing
function mohrLayout(w, h) {
  if (w >= 620) return { circ: { x: 0, y: 0, w: w * 0.6, h }, elem: { x: w * 0.6, y: 0, w: w * 0.4, h } };
  return { circ: { x: 0, y: 0, w, h: h * 0.6 }, elem: { x: 0, y: h * 0.6, w, h: h * 0.4 } };
}

function drawMohr(ctx, w, h) {
  const m = state.mohr;
  const p = principal(m.sx, m.sy, m.txy);
  const t = transformStress(m.sx, m.sy, m.txy, m.theta * DEG);
  const { circ, elem } = mohrLayout(w, h);
  const R = p.R, C = p.center;
  const smin = Math.min(0, C - R), smax = Math.max(0, C + R);
  const span = Math.max(smax - smin, 2 * R, 1e-9);
  const sc = Math.min((circ.w - 90) / span, (circ.h - 80) / Math.max(2 * R, 1e-9), 1e9);
  const scale = Number.isFinite(sc) && sc > 0 ? sc : 1;
  const cx0 = circ.x + 50 + (circ.w - 90 - span * scale) / 2 + (0 - smin) * scale;
  const cy0 = circ.y + circ.h / 2;
  const S = (s, tau) => [cx0 + s * scale, cy0 + tau * scale];
  mohrGeom = { S, C, R, scale, cx0, cy0, phi0: Math.atan2(m.txy, (m.sx - m.sy) / 2) };

  // Axes
  arrow(ctx, circ.x + 16, cy0, circ.x + circ.w - 10, cy0, colors.graphite, 1, 7);
  arrow(ctx, cx0, circ.y + 20, cx0, circ.y + circ.h - 12, colors.graphite, 1, 7);
  text(ctx, "σ (MPa)", circ.x + circ.w - 12, cy0 + 16, { align: "right", size: 11, color: colors.graphite, bg: colors.vellum });
  text(ctx, "τ (MPa), + down", cx0 + 6, circ.y + circ.h - 14, { size: 11, color: colors.graphite });

  // Circle
  const [ccx, ccy] = S(C, 0);
  circle(ctx, ccx, ccy, R * scale, colors.ink, null, 1.25);
  circle(ctx, ccx, ccy, 2, colors.ink, colors.ink);
  // Original diameter
  const X0 = S(m.sx, m.txy), Y0 = S(m.sy, -m.txy);
  line(ctx, X0[0], X0[1], Y0[0], Y0[1], colors.graphite, 1, [4, 3]);
  circle(ctx, X0[0], X0[1], 3, colors.graphite, colors.vellum);
  text(ctx, "X", X0[0] + 6, X0[1] - 6, { size: 11, color: colors.graphite });
  text(ctx, "Y", Y0[0] + 6, Y0[1] - 6, { size: 11, color: colors.graphite });
  // Rotated diameter
  const Xr = S(t.sx, t.txy), Yr = S(t.sy, -t.txy);
  line(ctx, Xr[0], Xr[1], Yr[0], Yr[1], colors.ink, 1.5);
  circle(ctx, Yr[0], Yr[1], 3.5, colors.ink, colors.vellum);
  circle(ctx, Xr[0], Xr[1], dragging ? 7 : 6, colors.redPencil, colors.redPencil);
  text(ctx, "X'", Xr[0] + 9, Xr[1] + 4, { size: 12, color: colors.redPencil, bg: colors.vellum });
  // Angle arc 2θ
  if (Math.abs(m.theta) > 0.2 && R > 0) {
    const a0 = Math.atan2(X0[1] - ccy, X0[0] - ccx), a1 = Math.atan2(Xr[1] - ccy, Xr[0] - ccx);
    ctx.save();
    ctx.strokeStyle = colors.redPencil;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ccx, ccy, Math.min(26, R * scale * 0.4), a0, a1, m.theta > 0);
    ctx.stroke();
    ctx.restore();
    text(ctx, `2θ = ${fixed(2 * m.theta, 1)}°`, ccx + 8, ccy - Math.min(26, R * scale * 0.4) - 6, { size: 10.5, color: colors.redPencil, bg: colors.vellum });
  }
  // Principal and shear points
  const P1 = S(p.s1, 0), P2 = S(p.s2, 0);
  circle(ctx, P1[0], P1[1], 2.5, colors.ink, colors.ink);
  circle(ctx, P2[0], P2[1], 2.5, colors.ink, colors.ink);
  text(ctx, `σ1 ${fixed(p.s1, 2)}`, P1[0] - 5, P1[1] - 6, { size: 10.5, color: colors.ink, align: "right", bg: colors.vellum });
  text(ctx, `σ2 ${fixed(p.s2, 2)}`, P2[0] + 5, P2[1] - 6, { size: 10.5, color: colors.ink, bg: colors.vellum });
  const T1 = S(C, -R);
  line(ctx, T1[0], T1[1], T1[0], ccy, colors.graphiteSoft, 0.75, [2, 3]);
  text(ctx, `τmax ${fixed(p.tauMax, 2)}`, T1[0] + 4, T1[1] - 5, { size: 10.5, color: colors.ink, bg: colors.vellum });

  drawElement(ctx, elem, m, t);
}

function drawElement(ctx, box, m, t) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const half = Math.min(box.w, box.h) * 0.17;
  const th = m.theta * DEG;
  const ex = [Math.cos(th), -Math.sin(th)], ey = [-Math.sin(th), -Math.cos(th)];
  const at = (n, d) => [cx + n[0] * d, cy + n[1] * d];
  const neg = (v) => [-v[0], -v[1]];

  // Reference axes
  arrow(ctx, cx, cy, cx + half * 2.6, cy, colors.graphiteSoft, 0.75, 6);
  arrow(ctx, cx, cy, cx, cy - half * 2.6, colors.graphiteSoft, 0.75, 6);
  text(ctx, "x", cx + half * 2.6 + 4, cy + 4, { size: 11, color: colors.graphite });
  text(ctx, "y", cx + 4, cy - half * 2.6, { size: 11, color: colors.graphite });

  // Element square
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => [
    cx + half * (a * ex[0] + b * ey[0]), cy + half * (a * ex[1] + b * ey[1])]);
  ctx.save();
  ctx.beginPath();
  corners.forEach((c, i) => (i ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1])));
  ctx.closePath();
  ctx.fillStyle = alpha(colors.graphite, 0.08);
  ctx.fill();
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  const xa = at(ex, half * 2.2);
  line(ctx, cx, cy, xa[0], xa[1], colors.ink, 0.75, [4, 3]);
  text(ctx, "x'", xa[0] + ex[0] * 8, xa[1] + ex[1] * 8, { size: 11, color: colors.ink, align: "center", baseline: "middle" });
  if (Math.abs(m.theta) > 0.2) text(ctx, `θ = ${fixed(m.theta, 1)}°`, cx + half * 1.3, cy + 16, { size: 10.5, color: colors.graphite });

  const smax = Math.max(Math.abs(t.sx), Math.abs(t.sy), Math.abs(t.txy), 1e-9);
  const len = (v) => 10 + (Math.abs(v) / smax) * half * 0.9;

  // Normal stresses, tension outward
  const faces = [[ex, t.sx, "σx'"], [neg(ex), t.sx, ""], [ey, t.sy, "σy'"], [neg(ey), t.sy, ""]];
  for (const [n, sv, label] of faces) {
    if (Math.abs(sv) < 1e-9) continue;
    const L = len(sv), col = sv > 0 ? colors.redPencil : colors.draftBlue;
    const p0 = at(n, half + 4), p1 = at(n, half + 4 + L);
    if (sv > 0) arrow(ctx, p0[0], p0[1], p1[0], p1[1], col, 1.5, 7);
    else arrow(ctx, p1[0], p1[1], p0[0], p0[1], col, 1.5, 7);
    if (label) {
      const q = at(n, half + L + 18);
      text(ctx, `${label} ${fixed(sv, 1)}`, q[0], q[1], { size: 10.5, color: col, align: "center", baseline: "middle", bg: colors.vellum });
    }
  }

  // Shear, positive acts in +y' on the +x' face
  if (Math.abs(t.txy) > 1e-9) {
    const L = len(t.txy), sg = Math.sign(t.txy);
    const shearOn = (n, d) => {
      const c = at(n, half + 6);
      const dir = [d[0] * sg, d[1] * sg];
      arrow(ctx, c[0] - dir[0] * L / 2, c[1] - dir[1] * L / 2, c[0] + dir[0] * L / 2, c[1] + dir[1] * L / 2, colors.ink, 1.25, 6);
    };
    shearOn(ex, ey);
    shearOn(neg(ex), neg(ey));
    shearOn(ey, ex);
    shearOn(neg(ey), neg(ex));
    text(ctx, `τx'y' ${fixed(t.txy, 1)}`, cx - half - 8, cy + half + 26, { size: 10.5, color: colors.ink, align: "right", bg: colors.vellum });
  }
}

// Hover and drag
const KEY_STEPS = 100; // arrow key steps across the span

function showCursor(x, py) {
  const r = canvas.getBoundingClientRect();
  cursorX = Math.max(0, Math.min(state.beam.L, x));
  const V = beamRes.shearAt(cursorX), M = beamRes.momentAt(cursorX), wv = beamRes.deflectionAt(cursorX);
  const msg = `x = ${fixed(cursorX, 3)} m\nV = ${fixed(V / 1e3, 3)} kN\nM = ${fixed(M / 1e3, 3)} kN·m\nv = ${fixed(wv * 1e3, 3)} mm`;
  tip.textContent = msg;
  tip.hidden = false;
  tip.style.left = `${Math.min(beamX(cursorX, r.width) + 12, r.width - 150)}px`;
  tip.style.top = `${Math.max(4, py - 70)}px`;
  $("cursor-read").textContent = msg.replace(/\n/g, ", ");
  draw();
}

function hideCursor() {
  cursorX = null;
  tip.hidden = true;
  $("cursor-read").textContent = "";
  draw();
}

canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (state.tab === "beam") {
    if (!beamRes?.ok) return;
    const x0 = beamX(0, r.width), x1 = beamX(state.beam.L, r.width);
    if (px < x0 || px > x1) { hideCursor(); return; }
    showCursor(((px - x0) / (x1 - x0)) * state.beam.L, py);
  } else if (dragging) {
    rotateTo(px, py);
  }
});
canvas.addEventListener("pointerleave", () => { if (state.tab === "beam" && document.activeElement !== canvas) hideCursor(); });
canvas.addEventListener("focus", () => {
  if (state.tab === "beam" && beamRes?.ok && cursorX === null) showCursor(state.beam.L / 2, canvas.getBoundingClientRect().height * 0.4);
});
canvas.addEventListener("blur", () => { if (state.tab === "beam") hideCursor(); });
canvas.addEventListener("keydown", (e) => {
  if (state.tab !== "beam" || !beamRes?.ok) return;
  const L = state.beam.L, step = (L / KEY_STEPS) * (e.shiftKey ? 10 : 1);
  const py = canvas.getBoundingClientRect().height * 0.4;
  let x = cursorX ?? L / 2;
  if (e.key === "ArrowRight") x += step;
  else if (e.key === "ArrowLeft") x -= step;
  else if (e.key === "Home") x = 0;
  else if (e.key === "End") x = L;
  else return;
  e.preventDefault();
  showCursor(x, py);
});
canvas.addEventListener("pointerdown", (e) => {
  if (state.tab !== "mohr" || !mohrGeom) return;
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const { S, C, R } = mohrGeom;
  const [ccx, ccy] = S(C, 0);
  const d = Math.hypot(px - ccx, py - ccy);
  if (Math.abs(d - R * mohrGeom.scale) < 16) {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    rotateTo(px, py);
  }
});
canvas.addEventListener("pointerup", () => { if (dragging) { dragging = false; draw(); } });

function rotateTo(px, py) {
  const { S, C, phi0 } = mohrGeom;
  const [ccx, ccy] = S(C, 0);
  const ang = Math.atan2(py - ccy, px - ccx);
  let th = (phi0 - ang) / 2 / DEG;
  while (th > 90) th -= 180;
  while (th < -90) th += 180;
  state.mohr.theta = Math.round(th * 10) / 10;
  syncMohrInputs();
  update();
}

// Controls
function init() {
  for (const p of Object.values(BEAM_PRESETS)) {
    $("beam-presets").append(el("button", { type: "button", text: p.label, onclick: () => {
      state.beam = structuredClone({ ...p, label: undefined });
      syncBeamInputs();
      update();
    } }));
  }
  for (const [k, v] of Object.entries(SUPPORTS)) $("support").append(el("option", { value: k, text: v }));
  const onNum = (id, fn) => $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    const ok = $(id).value.trim() !== "" && Number.isFinite(v);
    $(id).setAttribute("aria-invalid", String(!ok));
    if (ok) { fn(v); update(); }
  });
  onNum("L", (v) => { state.beam.L = v; });
  onNum("sa", (v) => { state.beam.a = v; });
  onNum("sb", (v) => { state.beam.b = v; });
  onNum("bE", (v) => { state.beam.E = v * 1e9; });
  onNum("bI", (v) => { state.beam.I = v * 1e-6; });
  $("support").addEventListener("change", () => {
    state.beam.support = $("support").value;
    if (state.beam.support === "overhang" && state.beam.a === undefined) { state.beam.a = 0; state.beam.b = state.beam.L * 0.75; }
    syncBeamInputs();
    update();
  });
  const addLoad = (ld) => { state.beam.loads.push(ld); renderLoads(); update(); };
  $("add-point").addEventListener("click", () => addLoad({ type: "point", x: state.beam.L / 2, P: 10e3 }));
  $("add-moment").addEventListener("click", () => addLoad({ type: "moment", x: state.beam.L / 2, M: 5e3 }));
  $("add-dist").addEventListener("click", () => addLoad({ type: "dist", x1: 0, x2: state.beam.L, q1: 5e3, q2: 5e3 }));

  onNum("sx", (v) => { state.mohr.sx = v; });
  onNum("sy", (v) => { state.mohr.sy = v; });
  onNum("txy", (v) => { state.mohr.txy = v; });
  onNum("theta", (v) => { state.mohr.theta = Math.max(-90, Math.min(90, v)); $("theta-range").value = state.mohr.theta; });
  $("theta-range").addEventListener("input", () => { state.mohr.theta = Number($("theta-range").value); $("theta").value = fixed(state.mohr.theta, 2); update(); });
  $("to-principal").addEventListener("click", () => {
    const m = state.mohr;
    state.mohr.theta = principal(m.sx, m.sy, m.txy).thetaP / DEG;
    syncMohrInputs();
    update();
  });
  $("to-zero").addEventListener("click", () => { state.mohr.theta = 0; syncMohrInputs(); update(); });
  for (const p of MOHR_PRESETS) {
    $("mohr-presets").append(el("button", { type: "button", text: p.label, onclick: () => {
      Object.assign(state.mohr, { sx: p.sx, sy: p.sy, txy: p.txy, theta: 0 });
      syncMohrInputs();
      update();
    } }));
  }
  $("tab-beam").addEventListener("click", () => setTab("beam"));
  $("tab-mohr").addEventListener("click", () => setTab("mohr"));
  wireCopyLink($("copy-link"));
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-beam.png"));
  $("csv").addEventListener("click", () => {
    if (!beamRes?.ok) return;
    download("vellum-beam.csv", toCsv(["x m", "V kN", "M kN·m", "v mm"],
      beamRes.plot.map((p) => [p.x, p.V / 1e3, p.M / 1e3, p.w * 1e3])), "text/csv");
  });
  new ResizeObserver(() => draw()).observe(canvas);
}

init();
syncBeamInputs();
syncMohrInputs();
setTab(state.tab);
initSheet({ no: "02", title: "Beam and Mohr's circle" });
