// Sheet 07 interface
import { initSheet, loadState, saveState, wireCopyLink, fillTable, toCsv, download, downloadCanvas, el, reducedMotion, symText } from "../../core/sheet.js";
import {
  readColors, fitCanvas, createView, fitView, toScreen, attachPanZoom, line, polyline, circle, text, alpha, ground,
} from "../../core/draw.js";
import { fixed, fmt } from "../../core/units.js";
import {
  grashof, fourBarPosition, fourBarSweep, couplerVelocity, feasibleRanges, jansenPositions, jansenSweep, JANSEN_HOLY,
  JANSEN_LINKS, LINK_PRESETS, CONTACT_BAND,
} from "./model.js";

const DEG = Math.PI / 180;
const TRACE_STEPS = 720; // samples on the coupler curve
const PICK_PX = 12; // joint drag radius in pixels
const BAR_PX = 7; // drawn bar width in pixels
const JANSEN_KEYS = "abcdefghijklm".split("");

const DEFAULT = { mode: "fourBar", fourBar: { ...LINK_PRESETS.crankRocker.fourBar }, jansen: { ...JANSEN_HOLY }, theta: 30, speed: 2, pair: false, mirror: false, trace: true };

const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
const deadCanvas = $("dead");
const view = createView();
let colors = null;
let state = loadState(DEFAULT, validState);
let sweep = null, ranges = [[0, 2 * Math.PI]];
let playing = !reducedMotion();
let dir = 1;
let raf = 0, last = 0;
let drag = null;
let userView = false;
let geoError = "";

function validState(s) {
  const f = Number.isFinite;
  const fb = s?.fourBar, j = s?.jansen;
  return s && ["fourBar", "jansen"].includes(s.mode) && fb && j && ["ground", "crank", "coupler", "rocker", "pDist", "pAngle"].every((k) => f(fb[k]))
    && ["open", "crossed"].includes(fb.branch) && JANSEN_KEYS.every((k) => f(j[k])) && f(s.theta) && f(s.speed);
}

function fourBarError(fb) {
  if (!["ground", "crank", "coupler", "rocker"].every((k) => fb[k] > 0)) return "All four link lengths must be greater than zero.";
  if (!feasibleRanges(fb).length) return "These lengths can't be assembled at any crank angle.";
  return "";
}

function jansenError(j) {
  if (!JANSEN_KEYS.every((k) => j[k] > 0 || k === "l")) return "Lengths a to m must be greater than zero (l may be zero).";
  return jansenPositions(j, state.theta * DEG) ? "" : "The leg can't be assembled at this crank angle.";
}

// Recompute the cycle
function recompute() {
  if (state.mode === "fourBar") {
    geoError = fourBarError(state.fourBar);
    sweep = geoError ? null : fourBarSweep(state.fourBar, TRACE_STEPS);
    ranges = sweep ? sweep.ranges : [];
  } else {
    geoError = jansenError(state.jansen);
    sweep = jansenSweep(state.jansen, TRACE_STEPS);
    ranges = feasibleJansen();
  }
  $("geo-err").textContent = geoError;
  clampTheta();
}

function feasibleJansen() {
  const ok = (th) => !!jansenPositions(state.jansen, th);
  const n = 720;
  const out = [];
  let start = null;
  for (let i = 0; i <= n; i++) {
    const th = (2 * Math.PI * i) / n;
    if (ok(th) && start === null) start = th;
    if ((!ok(th) || i === n) && start !== null) { out.push([start, ok(th) ? th : th - (2 * Math.PI) / n]); start = null; }
  }
  return out;
}

function inRanges(th) {
  const t = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return ranges.some(([a, b]) => (t >= a - 1e-12 && t <= b + 1e-12) || (b > 2 * Math.PI && t + 2 * Math.PI <= b));
}

function clampTheta() {
  if (!ranges.length) return;
  const th = state.theta * DEG;
  if (inRanges(th)) return;
  let best = ranges[0][0], bd = Infinity;
  const t = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (const [a, b] of ranges) for (const e of [a, b % (2 * Math.PI)]) {
    const d = Math.min(Math.abs(e - t), 2 * Math.PI - Math.abs(e - t));
    if (d < bd) { bd = d; best = e; }
  }
  state.theta = best / DEG;
}

function current() {
  const th = state.theta * DEG;
  return state.mode === "fourBar" ? fourBarPosition(state.fourBar, th) : jansenPositions(state.jansen, th);
}

// Find panel
function renderFind() {
  const host = $("answers");
  const pos = current();
  if (state.mode === "fourBar") {
    const g = grashof(state.fourBar);
    const v = pos ? couplerVelocity(state.fourBar, state.theta * DEG, state.speed) : null;
    host.replaceChildren(
      box("ans-class", "Grashof class", g.grashof ? (g.type === "change point" ? "Special" : "Grashof") : "Non Grashof", "", g.cls),
      box("ans-type", "Motion type", g.type, "", `shortest link: ${g.shortest}`),
      box("ans-mu", "Transmission angle μ", pos ? fixed(pos.mu / DEG, 2) : "n/a", "°",
        sweep ? `min ${fixed(sweep.muMin / DEG, 2)}°, max ${fixed(sweep.muMax / DEG, 2)}° over the cycle` : ""),
      box("ans-p", "Coupler point P", pos ? `${fixed(pos.P[0], 3)}, ${fixed(pos.P[1], 3)}` : "n/a", "",
        v ? `velocity ${fixed(v[0], 3)}, ${fixed(v[1], 3)} units/s (|v| = ${fixed(Math.hypot(...v), 3)})` : ""),
    );
    const rows = [["s + l", fixed(g.s + g.l, 3)], ["p + q", fixed(g.pq, 3)]];
    for (const t of sweep?.toggles || []) rows.push([`toggle at ${fixed(t.angle / DEG, 2)}°`, t.kind]);
    if (!(sweep?.toggles || []).length) rows.push(["toggle positions", "none, the crank turns fully and the rocker never locks"]);
    fillTable($("t-info"), ["Quantity", "Value"], rows);
    $("t-info").querySelectorAll("td:last-child").forEach((td) => td.classList.add("text"));
  } else {
    const gait = sweep.gait;
    const th = state.theta * DEG;
    const a = jansenPositions(state.jansen, th - 1e-6), b = jansenPositions(state.jansen, th + 1e-6);
    const v = a && b ? [(b.G[0] - a.G[0]) / 2e-6 * state.speed, (b.G[1] - a.G[1]) / 2e-6 * state.speed] : null;
    host.replaceChildren(
      box("ans-stride", "Stride", fixed(gait.stride, 2), "units", `horizontal length of the ground contact part`),
      box("ans-step", "Step height", fixed(gait.stepHeight, 2), "units", "top to bottom of the foot path"),
      box("ans-contact", "Ground contact", fixed(gait.contactFraction * 100, 1), "%", `of the cycle, band ${fixed(gait.band, 2)} units (${CONTACT_BAND * 100}% of step height)`),
      box("ans-foot", "Foot G", pos ? `${fixed(pos.G[0], 2)}, ${fixed(pos.G[1], 2)}` : "n/a", "",
        v ? `velocity ${fixed(v[0], 2)}, ${fixed(v[1], 2)} units/s` : ""),
    );
    const rows = pos ? ["A", "B", "C", "D", "E", "F", "G"].map((k) => [`joint ${k}`, `${fixed(pos[k][0], 3)}, ${fixed(pos[k][1], 3)}`]) : [];
    rows.push(["max loop closure error", fmt(sweep.maxClosure, 3)]);
    fillTable($("t-info"), ["Quantity", "Value"], rows);
  }
  const deadDeg = ranges.length ? 360 - ranges.reduce((s2, [x, y]) => s2 + (y - x), 0) / DEG : 360;
  $("dead-note").textContent = deadDeg > 0.01 ? `Hatched: ${fixed(deadDeg, 1)}° of crank angle can't be assembled.` : "The crank turns all the way around.";
  $("status-note").textContent = state.mode === "fourBar"
    ? "Units are arbitrary, use any consistent length. Velocity by central finite difference."
    : "Lengths in Jansen's units (cm in his drawings). Foot velocity by central finite difference.";
}

function box(id, q, v, u, s) {
  return el("div", { class: "answer", id }, el("span", { class: "q" }, symText(q)), el("span", { class: "v" }, v, el("span", { class: "u", text: u ? ` ${u}` : "" })), el("span", { class: "s", text: s }));
}

// Drawing
function modelBounds() {
  const pts = [];
  if (state.mode === "fourBar") {
    for (const p of sweep?.pts || []) if (p) pts.push(p.A, p.B, p.P, p.O2, p.O4);
  } else {
    for (let i = 0; i < 72; i++) {
      const p = jansenPositions(state.jansen, (i / 72) * 2 * Math.PI);
      if (p) for (const k of Object.keys(p)) { pts.push(p[k]); if (state.mirror) pts.push([-p[k][0], p[k][1]]); }
    }
  }
  if (!pts.length) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return {
    minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
  };
}

function fit() {
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 10)) return;
  fitView(view, modelBounds(), r.width, r.height, 44);
}

function draw() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  const S = (p) => toScreen(view, p[0], p[1]);
  if (state.mode === "fourBar") drawFourBar(ctx, S);
  else drawJansen(ctx, S);
  drawDeadZones();
}

function bar(ctx, a, b, color = colors.graphite, fill = colors.vellum) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const nx = -Math.sin(ang) * BAR_PX / 2, ny = Math.cos(ang) * BAR_PX / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a[0] + nx, a[1] + ny);
  ctx.lineTo(b[0] + nx, b[1] + ny);
  ctx.arc(b[0], b[1], BAR_PX / 2, ang + Math.PI / 2, ang - Math.PI / 2, true);
  ctx.lineTo(a[0] - nx, a[1] - ny);
  ctx.arc(a[0], a[1], BAR_PX / 2, ang - Math.PI / 2, ang + Math.PI / 2, true);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.restore();
}

function pin(ctx, p, label, color = colors.ink) {
  circle(ctx, p[0], p[1], 3.2, color, colors.vellum, 1.25);
  if (label) text(ctx, label, p[0] + 7, p[1] - 7, { size: 11, color: colors.graphite });
}

function groundPivot(ctx, p, label) {
  ctx.save();
  ctx.strokeStyle = colors.draftBlue;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo(p[0] - 9, p[1] + 14);
  ctx.lineTo(p[0] + 9, p[1] + 14);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
  ground(ctx, p[0], p[1] + 14, 26, 0, colors.draftBlue);
  circle(ctx, p[0], p[1], 3.2, colors.draftBlue, colors.vellum, 1.25);
  if (label) text(ctx, label, p[0] - 8, p[1] - 8, { size: 11, color: colors.graphite, align: "right" });
}

function drawFourBar(ctx, S) {
  if (!sweep) {
    text(ctx, geoError, 16, 30, { color: colors.redPencil, size: 13 });
    return;
  }
  if (state.trace) {
    let seg = [];
    for (const p of sweep.pts) {
      if (p) seg.push(S(p.P));
      else { polyline(ctx, seg, colors.graphite, 1); seg = []; }
    }
    polyline(ctx, seg, colors.graphite, 1);
  }
  const pos = current();
  if (!pos) return;
  const O2 = S(pos.O2), O4 = S(pos.O4), A = S(pos.A), B = S(pos.B), P = S(pos.P);
  line(ctx, O2[0], O2[1], O4[0], O4[1], colors.graphiteSoft, 0.75, [6, 3, 2, 3]);
  // Coupler plate as a triangle
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(...A); ctx.lineTo(...B); ctx.lineTo(...P); ctx.closePath();
  ctx.fillStyle = alpha(colors.graphite, 0.08);
  ctx.fill();
  ctx.restore();
  polyline(ctx, [A, P, B], colors.graphite, 0.75, [3, 3]);
  bar(ctx, O4, B);
  bar(ctx, A, B);
  bar(ctx, O2, A, colors.ink);
  groundPivot(ctx, O2, "O2");
  groundPivot(ctx, O4, "O4");
  pin(ctx, A, "A");
  pin(ctx, B, "B");
  circle(ctx, P[0], P[1], 4.5, colors.redPencil, colors.redPencil);
  text(ctx, "P", P[0] + 8, P[1] + 4, { size: 11, color: colors.redPencil });
  // Transmission angle arc
  const a1 = Math.atan2(A[1] - B[1], A[0] - B[0]), a2 = Math.atan2(O4[1] - B[1], O4[0] - B[0]);
  ctx.save();
  ctx.strokeStyle = colors.graphite;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  let d = a2 - a1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  ctx.arc(B[0], B[1], 18, a1, a1 + d, d < 0);
  ctx.stroke();
  ctx.restore();
  text(ctx, `μ ${fixed(pos.mu / DEG, 1)}°`, B[0] + 14, B[1] + 22, { size: 10.5, color: colors.graphite, bg: colors.vellum });
  text(ctx, `θ2 = ${fixed(state.theta, 1)}°`, 10, canvas.getBoundingClientRect().height - 10, { size: 11, color: colors.graphite, bg: colors.vellum });
}

function mirrorPos(p) {
  const out = {};
  for (const k of Object.keys(p)) out[k] = [-p[k][0], p[k][1]];
  return out;
}

function drawLeg(ctx, S, p, faded) {
  const col = faded ? colors.graphiteSoft : colors.graphite;
  for (const tri of [["B", "C", "E"], ["D", "F", "G"]]) {
    ctx.save();
    ctx.beginPath();
    tri.forEach((k, i) => (i ? ctx.lineTo(...S(p[k])) : ctx.moveTo(...S(p[k]))));
    ctx.closePath();
    ctx.fillStyle = alpha(colors.graphite, faded ? 0.04 : 0.1);
    ctx.fill();
    ctx.restore();
  }
  for (const [u, v] of JANSEN_LINKS) bar(ctx, S(p[u]), S(p[v]), u === "O" ? (faded ? col : colors.ink) : col);
  for (const k of ["A", "C", "D", "E", "F"]) pin(ctx, S(p[k]), faded ? "" : k, col);
  const G = S(p.G);
  circle(ctx, G[0], G[1], faded ? 3.5 : 5, colors.redPencil, faded ? colors.vellum : colors.redPencil);
  if (!faded) text(ctx, "G", G[0] + 8, G[1] + 4, { size: 11, color: colors.redPencil });
}

function drawJansen(ctx, S) {
  const th = state.theta * DEG;
  if (state.trace) {
    const pts = sweep.foot.filter(Boolean).map((p) => S(p));
    polyline(ctx, pts, colors.graphite, 1, null, true);
    if (state.mirror) polyline(ctx, sweep.foot.filter(Boolean).map((p) => S([-p[0], p[1]])), colors.graphiteSoft, 1, null, true);
    const yb = sweep.gait.ymin + sweep.gait.band;
    const [x0, y0] = S([Math.min(...sweep.foot.filter(Boolean).map((p) => p[0])) - 5, yb]);
    const [x1] = S([Math.max(...sweep.foot.filter(Boolean).map((p) => p[0])) + 5, yb]);
    line(ctx, x0, y0, x1, y0, colors.redPencil, 0.75, [3, 3]);
    text(ctx, "contact band", x1 + 4, y0 + 3, { size: 10, color: colors.redPencil });
  }
  const legs = [];
  if (state.pair) { const q = jansenPositions(state.jansen, th + Math.PI); if (q) legs.push([q, true]); }
  if (state.mirror) {
    const m1 = jansenPositions(state.jansen, Math.PI - th);
    if (m1) legs.push([mirrorPos(m1), true]);
    if (state.pair) { const m2 = jansenPositions(state.jansen, -th); if (m2) legs.push([mirrorPos(m2), true]); }
  }
  const p = current();
  for (const [q, f] of legs) drawLeg(ctx, S, q, f);
  if (p) drawLeg(ctx, S, p, false);
  const O = S([0, 0]), B = S([-state.jansen.a, -state.jansen.l]);
  groundPivot(ctx, O, "O");
  groundPivot(ctx, B, "B");
  if (state.mirror) groundPivot(ctx, S([state.jansen.a, -state.jansen.l]), "");
  const r = state.jansen.m * view.scale;
  circle(ctx, O[0], O[1], r, colors.graphiteSoft, null, 0.75);
  text(ctx, `θ = ${fixed(state.theta, 1)}°`, 10, canvas.getBoundingClientRect().height - 10, { size: 11, color: colors.graphite, bg: colors.vellum });
}

function drawDeadZones() {
  const { ctx, w, h } = fitCanvas(deadCanvas);
  ctx.clearRect(0, 0, w, h);
  const X = (rad) => (rad / (2 * Math.PI)) * w;
  ctx.save();
  ctx.strokeStyle = colors.redPencil;
  ctx.lineWidth = 0.75;
  for (let x = -h; x < w; x += 5) {
    const t = ((x + h / 2) / w) * 2 * Math.PI;
    if (inRanges(t)) continue;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.stroke();
  }
  ctx.restore();
  for (const [a, b] of ranges) {
    for (const e of [a, b]) {
      const t = ((e % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (t > 1e-9 && t < 2 * Math.PI - 1e-9) line(ctx, X(t), 0, X(t), h, colors.redPencil, 1);
    }
  }
  line(ctx, 0, 0.5, w, 0.5, colors.hairline, 1);
}

// Animation
function loop() {
  cancelAnimationFrame(raf);
  last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (playing && !geoError) step(dt);
    if (playing) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function step(dt) {
  const next = state.theta + dir * state.speed * dt / DEG;
  if (inRanges(next * DEG)) {
    state.theta = ((next % 360) + 360) % 360;
  } else {
    // Stop at the limit and turn around
    let lo = state.theta, hi = next;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (inRanges(mid * DEG)) lo = mid; else hi = mid;
    }
    state.theta = ((lo % 360) + 360) % 360;
    dir = -dir;
  }
  syncTheta();
  renderFind();
  draw();
}

function syncTheta() {
  $("theta").value = fixed(state.theta, 2);
  $("theta-range").value = state.theta;
}

// Joint dragging, four bar only
attachPanZoom(canvas, view, {
  onDown(e, p) {
    if (state.mode !== "fourBar") return false;
    const pos = current();
    if (!pos) return false;
    for (const k of ["P", "B", "A", "O4"]) {
      const s = toScreen(view, pos[k][0], pos[k][1]);
      if (Math.hypot(s[0] - p[0], s[1] - p[1]) < PICK_PX) {
        drag = k;
        playing = false;
        $("play").textContent = "Play";
        return true;
      }
    }
    return false;
  },
  onMove(e, p, m) {
    if (!drag) return;
    const fb = state.fourBar;
    const pos = current() || fourBarPosition(fb, state.theta * DEG);
    const round = (v) => Math.max(0.05, Math.round(v * 100) / 100);
    if (drag === "A") {
      fb.crank = round(Math.hypot(m[0], m[1]));
      state.theta = ((Math.atan2(m[1], m[0]) / DEG) + 360) % 360;
    } else if (drag === "O4") {
      fb.ground = round(Math.max(0.05, m[0]));
    } else if (drag === "B" && pos) {
      fb.coupler = round(Math.hypot(m[0] - pos.A[0], m[1] - pos.A[1]));
      fb.rocker = round(Math.hypot(m[0] - fb.ground, m[1]));
    } else if (drag === "P" && pos) {
      const th3 = Math.atan2(pos.B[1] - pos.A[1], pos.B[0] - pos.A[0]);
      fb.pDist = round(Math.hypot(m[0] - pos.A[0], m[1] - pos.A[1]));
      fb.pAngle = Math.round(((Math.atan2(m[1] - pos.A[1], m[0] - pos.A[0]) - th3) / DEG) * 10) / 10;
    }
    syncInputs();
    update(false);
  },
  onUp() { drag = null; update(false); },
  onView() { userView = true; draw(); },
});

// Inputs
function syncInputs() {
  $("mode").value = state.mode;
  $("given-fb").hidden = state.mode !== "fourBar";
  $("given-jansen").hidden = state.mode !== "jansen";
  const fb = state.fourBar;
  for (const k of ["ground", "crank", "coupler", "rocker"]) $(k).value = fb[k];
  $("pdist").value = fb.pDist;
  $("pangle").value = fb.pAngle;
  $("branch").value = fb.branch;
  for (const k of JANSEN_KEYS) $(`j-${k}`).value = state.jansen[k];
  $("pair").checked = state.pair;
  $("mirror").checked = state.mirror;
  $("speed").value = state.speed;
  $("trace").checked = state.trace;
  syncTheta();
}

function update(refit = true) {
  recompute();
  if (refit && !userView) fit();
  syncTheta();
  renderFind();
  draw();
  saveState(state);
}

function init() {
  for (const p of Object.values(LINK_PRESETS)) {
    $("presets").append(el("button", { type: "button", text: p.label, onclick: () => {
      state.mode = p.mode;
      if (p.fourBar) state.fourBar = { ...p.fourBar };
      if (p.jansen) state.jansen = { ...p.jansen };
      state.theta = 30;
      userView = false;
      dir = 1;
      syncInputs();
      update();
    } }));
  }
  $("jansen-fields").replaceChildren(...JANSEN_KEYS.map((k) => el("div", { class: "field" },
    el("label", { for: `j-${k}` }, el("span", { class: "sym", text: k }), k === "m" ? " (crank)" : ""),
    el("input", { type: "number", id: `j-${k}`, step: "0.1", min: "0" }), el("span", { class: "unit", text: "units" }))));
  const num = (id, fn) => $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    const ok = $(id).value.trim() !== "" && Number.isFinite(v);
    $(id).setAttribute("aria-invalid", String(!ok));
    if (ok) { fn(v); update(); }
  });
  for (const k of ["ground", "crank", "coupler", "rocker"]) num(k, (v) => { state.fourBar[k] = v; });
  num("pdist", (v) => { state.fourBar.pDist = v; });
  num("pangle", (v) => { state.fourBar.pAngle = v; });
  for (const k of JANSEN_KEYS) num(`j-${k}`, (v) => { state.jansen[k] = v; });
  num("speed", (v) => { state.speed = Math.max(0, v); });
  num("theta", (v) => { state.theta = ((v % 360) + 360) % 360; });
  $("theta-range").addEventListener("input", () => { state.theta = Number($("theta-range").value); clampTheta(); syncTheta(); renderFind(); draw(); saveState(state); });
  $("branch").addEventListener("change", () => { state.fourBar.branch = $("branch").value; update(); });
  $("mode").addEventListener("change", () => { state.mode = $("mode").value; userView = false; syncInputs(); update(); });
  $("pair").addEventListener("change", () => { state.pair = $("pair").checked; update(false); });
  $("mirror").addEventListener("change", () => { state.mirror = $("mirror").checked; userView = false; update(); });
  $("trace").addEventListener("change", () => { state.trace = $("trace").checked; draw(); saveState(state); });
  $("play").addEventListener("click", () => {
    playing = !playing;
    $("play").textContent = playing ? "Pause" : "Play";
    if (playing) loop();
  });
  $("fit").addEventListener("click", () => { userView = false; fit(); draw(); });
  wireCopyLink($("copy-link"));
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-linkage.png"));
  $("csv").addEventListener("click", () => {
    const rows = [];
    for (let i = 0; i <= 360; i++) {
      const p = state.mode === "fourBar" ? fourBarPosition(state.fourBar, i * DEG) : jansenPositions(state.jansen, i * DEG);
      if (!p) { rows.push([i, "", ""]); continue; }
      const q = state.mode === "fourBar" ? p.P : p.G;
      rows.push([i, q[0], q[1]]);
    }
    download("vellum-linkage.csv", toCsv(["crank deg", state.mode === "fourBar" ? "P x" : "G x", state.mode === "fourBar" ? "P y" : "G y"], rows), "text/csv");
  });
  new ResizeObserver(() => { if (!userView) fit(); draw(); }).observe(canvas);
}

init();
syncInputs();
update();
$("play").textContent = playing ? "Pause" : "Play";
if (playing) loop();
initSheet({ no: "07", title: "Linkage simulator" });
