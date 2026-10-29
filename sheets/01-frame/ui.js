// Sheet 01 interface
import {
  initSheet, loadState, saveState, wireCopyLink, setAnswer, fillTable, toCsv, download, downloadCanvas, el, readNumber,
} from "../../core/sheet.js";
import {
  readColors, fitCanvas, createView, fitView, toScreen, attachPanZoom, line, polyline, circle, text, arrow,
  momentArrow, pinSupport, rollerSupport, fixedSupport, dimension, alpha, hexToRgb, rgbCss,
} from "../../core/draw.js";
import { fmt, fixed } from "../../core/units.js";
import { solveStructure, memberDiagram, deflectedPoints, PRESETS, SUPPORT_TYPES } from "./model.js";

const MATERIALS = [
  { name: "Steel", E: 200 },
  { name: "Aluminum 6061", E: 69 },
  { name: "Titanium", E: 114 },
  { name: "Custom", E: null },
];
const SECTIONS = [
  { name: "W200x46 steel beam", A: 5890, I: 45.5 },
  { name: "Square tube 100x100x6", A: 2160, I: 3.11 },
  { name: "Round bar 30 mm", A: 707, I: 0.0398 },
  { name: "Default (A 5000, I 8)", A: 5000, I: 8 },
  { name: "Custom", A: null, I: null },
];
const SUPPORT_LABELS = { free: "Free", pin: "Pin", rollerX: "Roller, moves in x", rollerY: "Roller, moves in y", fixed: "Fixed" };
const PICK_PX = 10; // hit radius for nodes in pixels
const AUTO_DEFL = 0.08; // auto deflection as a fraction of model size
const UNDO_LIMIT = 100; // stored undo steps

const DEFAULT = { model: PRESETS.pratt.model, ui: { field: "axial", moment: false, labels: false, dscale: 0, grid: 0.5 } };

const $ = (id) => document.getElementById(id);
const canvas = document.querySelector("canvas.main");
const tip = document.querySelector(".tip");
const view = createView();
let colors = null;
let state = loadState(DEFAULT, validState);
let result = null;
let tool = "select";
let selection = null;
let drag = null;
let hover = null;
const undoStack = [], redoStack = [];
let fitted = false;
let userView = false;

function validState(s) {
  const m = s?.model;
  if (!m || !Array.isArray(m.nodes) || !Array.isArray(m.members) || !s.ui) return false;
  const num = (v) => v === undefined || Number.isFinite(v);
  return m.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && num(n.fx) && num(n.fy) && num(n.m)
    && (!n.support || SUPPORT_TYPES.includes(n.support)))
    && m.members.every((b) => Number.isInteger(b.a) && Number.isInteger(b.b) && b.a < m.nodes.length && b.b < m.nodes.length
      && Number.isFinite(b.E) && Number.isFinite(b.A) && num(b.I) && num(b.w));
}

// Editing with undo
function edit(fn) {
  undoStack.push(JSON.stringify(state.model));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  fn(state.model);
  update();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state.model));
  state.model = JSON.parse(undoStack.pop());
  selection = null;
  update();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state.model));
  state.model = JSON.parse(redoStack.pop());
  selection = null;
  update();
}

function newMemberProps() {
  const E = readNumber($("E"), { positive: true, name: "E" });
  const A = readNumber($("A"), { positive: true, name: "A" });
  const I = readNumber($("I"), { positive: true, name: "I" });
  if (E === null || A === null || I === null) return null;
  return { type: $("mtype").value, E: E * 1e9, A: A * 1e-6, I: I * 1e-6 };
}

function snap(v) {
  const g = state.ui.grid > 0 ? state.ui.grid : 0.5;
  return Math.round(v / g) * g;
}

function addNode(x, y) {
  const m = state.model;
  const i = m.nodes.findIndex((n) => Math.hypot(n.x - x, n.y - y) < 1e-9);
  if (i >= 0) return i;
  edit((mm) => mm.nodes.push({ x, y, support: "free" }));
  return m.nodes.length - 1;
}

function addMember(a, b) {
  const err = $("add-err");
  err.textContent = "";
  if (a === b) { err.textContent = "A member needs two different nodes."; return; }
  const m = state.model;
  if (Math.hypot(m.nodes[a].x - m.nodes[b].x, m.nodes[a].y - m.nodes[b].y) < 1e-9) { err.textContent = "Zero length members are not allowed."; return; }
  if (m.members.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))) { err.textContent = "Those nodes are already connected."; return; }
  const props = newMemberProps();
  if (!props) { err.textContent = "Fix the section values first."; return; }
  edit((mm) => mm.members.push({ a, b, ...props, w: 0, wDir: "global" }));
  selection = { kind: "member", index: m.members.length - 1 };
  update();
}

function deleteSelection() {
  if (!selection) return;
  const sel = selection;
  edit((m) => {
    if (sel.kind === "member") m.members.splice(sel.index, 1);
    else {
      m.members = m.members.filter((b) => b.a !== sel.index && b.b !== sel.index)
        .map((b) => ({ ...b, a: b.a > sel.index ? b.a - 1 : b.a, b: b.b > sel.index ? b.b - 1 : b.b }));
      m.nodes.splice(sel.index, 1);
    }
  });
  selection = null;
  update();
}

// Solve and refresh everything
function update() {
  result = solveStructure(state.model);
  if (!fitted) fitModel();
  renderFind();
  renderEditor();
  draw();
  saveState(state);
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
}

function bounds() {
  const ns = state.model.nodes;
  if (!ns.length) return { minX: -1, maxX: 5, minY: -1, maxY: 3 };
  const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function fitModel() {
  const { width: w, height: h } = canvas.getBoundingClientRect();
  if (!(w > 10)) return;
  const b = bounds();
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  const pad = 0.08 * span;
  fitView(view, { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad }, w, h, 56);
  fitted = true;
}

function modelSize() {
  const b = bounds();
  return Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
}

function deflScale() {
  if (!result?.ok) return 0;
  if (state.ui.dscale > 0) return state.ui.dscale;
  const d = result.maxDeflection.value;
  if (!(d > 0)) return 1;
  const raw = (AUTO_DEFL * modelSize()) / d;
  const p = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map((k) => k * p).filter((v) => v <= raw);
  return nice[nice.length - 1] || p;
}

// Drawing
function fieldValue(mr) {
  if (state.ui.field === "axial") return mr.type === "truss" ? mr.N : 0.5 * (mr.Ni + mr.Nj);
  if (state.ui.field === "moment") return Math.abs(mr.Mi) > Math.abs(mr.Mj) ? mr.Mi : mr.Mj;
  return 0;
}

function memberColor(v, vmax) {
  if (state.ui.field === "none" || !(vmax > 0)) return colors.ink;
  const t = v / vmax;
  if (Math.abs(t) < 0.02) return colors.graphite;
  const g = hexToRgb(colors.graphite), end = hexToRgb(t > 0 ? colors.redPencil : colors.draftBlue);
  const k = 0.45 + 0.55 * Math.abs(t);
  return rgbCss(g.map((c, i) => Math.round(c + (end[i] - c) * k)));
}

function draw() {
  if (!colors) colors = readColors();
  const { ctx, w, h } = fitCanvas(canvas);
  view.w = w; view.h = h;
  ctx.fillStyle = colors.vellum;
  ctx.fillRect(0, 0, w, h);
  drawGrid(ctx, w, h);
  const m = state.model;
  const S = (x, y) => toScreen(view, x, y);
  const ok = result?.ok;
  const scale = deflScale();
  let vmax = 0;
  if (ok) for (const mr of result.members) vmax = Math.max(vmax, Math.abs(fieldValue(mr)));

  drawDimensions(ctx);

  // Moment diagram
  if (ok && state.ui.moment) {
    let mmax = 0;
    for (const mr of result.members) if (mr.type === "frame") mmax = Math.max(mmax, Math.abs(mr.Mi), Math.abs(mr.Mj), Math.abs(memberDiagram(mr, 20).M[10]));
    const hpx = 40;
    for (const mr of result.members) {
      if (mr.type !== "frame" || !(mmax > 0)) continue;
      const d = memberDiagram(mr, 30);
      const A = m.nodes[mr.a];
      const pts = d.s.map((s, k) => {
        const off = (-d.M[k] / mmax) * hpx / view.scale;
        const x = A.x + mr.c * s - mr.s * off, y = A.y + mr.s * s + mr.c * off;
        return S(x, y);
      });
      const base0 = S(A.x, A.y), base1 = S(A.x + mr.c * mr.L, A.y + mr.s * mr.L);
      ctx.save();
      ctx.fillStyle = alpha(colors.graphite, 0.1);
      ctx.beginPath();
      ctx.moveTo(...base0);
      for (const p of pts) ctx.lineTo(...p);
      ctx.lineTo(...base1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      polyline(ctx, pts, colors.graphite, 1);
    }
  }

  // Undeformed members
  m.members.forEach((b, i) => {
    const [x1, y1] = S(m.nodes[b.a].x, m.nodes[b.a].y), [x2, y2] = S(m.nodes[b.b].x, m.nodes[b.b].y);
    const sel = selection?.kind === "member" && selection.index === i;
    const hov = hover?.kind === "member" && hover.index === i;
    if (ok) line(ctx, x1, y1, x2, y2, colors.graphite, sel || hov ? 2 : 1, [5, 4]);
    else line(ctx, x1, y1, x2, y2, colors.graphite, sel || hov ? 2.5 : 1.5);
    if (sel) line(ctx, x1, y1, x2, y2, alpha(colors.ink, 0.15), 9);
    if (b.type === "truss" && !ok) {
      circle(ctx, x1, y1, 3, colors.graphite, colors.vellum);
      circle(ctx, x2, y2, 3, colors.graphite, colors.vellum);
    }
  });

  // Deformed members
  if (ok) {
    for (const mr of result.members) {
      const pts = deflectedPoints(m, mr, scale, mr.type === "truss" ? 1 : 24).map(([x, y]) => S(x, y));
      polyline(ctx, pts, memberColor(fieldValue(mr), vmax), 2.5);
    }
  }

  // Distributed loads
  m.members.forEach((b) => {
    if (!b.w) return;
    const A = m.nodes[b.a], B = m.nodes[b.b];
    const [x1, y1] = S(A.x, A.y), [x2, y2] = S(B.x, B.y);
    const L = Math.hypot(B.x - A.x, B.y - A.y), c = (B.x - A.x) / L, s = (B.y - A.y) / L;
    let nx = 0, ny = 1;
    if (b.wDir === "local") { nx = -s; ny = c; }
    const dir = Math.sign(b.w);
    const len = 26;
    const pts = [];
    const n = Math.max(3, Math.round(Math.hypot(x2 - x1, y2 - y1) / 22));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const bx = x1 + (x2 - x1) * t, by = y1 + (y2 - y1) * t;
      const tx = bx - nx * len * dir, ty = by + ny * len * dir;
      pts.push([tx, ty]);
      arrow(ctx, tx, ty, bx - nx * 3 * dir, by + ny * 3 * dir, colors.redPencil, 1, 6);
    }
    polyline(ctx, pts, colors.redPencil, 1);
    const mid = pts[Math.floor(pts.length / 2)];
    text(ctx, `${fmt(Math.abs(b.w) / 1e3, 3)} kN/m`, mid[0] + 4, mid[1] - 4 * dir, { color: colors.redPencil, size: 11, bg: colors.vellum });
  });

  // Supports and nodes
  m.nodes.forEach((n, i) => {
    const [x, y] = S(n.x, n.y);
    if (n.support === "pin") pinSupport(ctx, x, y, colors.draftBlue);
    else if (n.support === "rollerX") rollerSupport(ctx, x, y, colors.draftBlue);
    else if (n.support === "rollerY") rollerSupport(ctx, x, y, colors.draftBlue, 14, Math.PI / 2);
    else if (n.support === "fixed") fixedSupport(ctx, x, y, colors.draftBlue, 22, supportAngle(i));
    const sel = selection?.kind === "node" && selection.index === i;
    const hov = hover?.kind === "node" && hover.index === i;
    circle(ctx, x, y, sel || hov ? 5 : 3.5, colors.ink, sel ? colors.ink : colors.vellum, 1.25);
    text(ctx, `N${i + 1}`, x + 7, y - 7, { color: colors.graphite, size: 10 });
  });

  // Point loads
  m.nodes.forEach((n) => {
    const [x, y] = S(n.x, n.y);
    const L = 42;
    if (n.fy) {
      const d = Math.sign(n.fy);
      arrow(ctx, x, y + d * L, x, y + d * 6, colors.redPencil, 1.5, 8);
      text(ctx, `${fmt(Math.abs(n.fy) / 1e3, 3)} kN`, x + 5, y + d * (L - 2), { color: colors.redPencil, size: 11, baseline: d > 0 ? "top" : "alphabetic", bg: colors.vellum });
    }
    if (n.fx) {
      const d = Math.sign(n.fx);
      arrow(ctx, x - d * L, y, x - d * 6, y, colors.redPencil, 1.5, 8);
      text(ctx, `${fmt(Math.abs(n.fx) / 1e3, 3)} kN`, x - d * L, y - 6, { color: colors.redPencil, size: 11, align: d > 0 ? "left" : "right", bg: colors.vellum });
    }
    if (n.m) {
      momentArrow(ctx, x, y, 16, n.m > 0, colors.redPencil);
      text(ctx, `${fmt(Math.abs(n.m) / 1e3, 3)} kN·m`, x + 18, y + 18, { color: colors.redPencil, size: 11, bg: colors.vellum });
    }
  });

  // Force labels
  if (ok && state.ui.labels) {
    for (const mr of result.members) {
      const A = m.nodes[mr.a];
      const [mx, my] = S(A.x + mr.c * mr.L / 2, A.y + mr.s * mr.L / 2);
      const lx = mx + 14, ly = my - 16;
      line(ctx, mx, my, lx, ly, colors.graphite, 0.75);
      text(ctx, memberLabel(mr), lx + 2, ly - 2, { size: 10.5, color: colors.ink, bg: colors.vellum });
    }
  }

  // Member creation preview
  if (drag?.kind === "newMember" && drag.to) {
    const [x1, y1] = S(m.nodes[drag.from].x, m.nodes[drag.from].y);
    line(ctx, x1, y1, drag.to[0], drag.to[1], colors.ink, 1.25, [3, 3]);
  }

  // Scale label
  if (ok) text(ctx, `Deflection x ${fmt(scale, 3)}`, 10, h - 10, { size: 11, color: colors.graphite, bg: colors.vellum });
  else if (result) text(ctx, result.error, 10, h - 10, { size: 12, color: colors.redPencil, bg: colors.vellum });
}

function supportAngle(i) {
  const m = state.model;
  const b = m.members.find((x) => x.a === i || x.b === i);
  if (!b) return 0;
  const o = m.nodes[b.a === i ? b.b : b.a], n = m.nodes[i];
  const dx = o.x - n.x, dy = o.y - n.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  return dy > 0 ? 0 : Math.PI;
}

function memberLabel(mr) {
  if (mr.type === "truss") return `M${mr.index + 1}  N ${fmt(mr.N / 1e3, 4, 1e-9)} kN`;
  return `M${mr.index + 1}  N ${fmt(0.5 * (mr.Ni + mr.Nj) / 1e3, 3, 1e-9)}  M ${fmt(mr.Mi / 1e3, 3, 1e-9)}/${fmt(mr.Mj / 1e3, 3, 1e-9)}`;
}

function drawGrid(ctx, w, h) {
  const g = state.ui.grid > 0 ? state.ui.grid : 0.5;
  let step = g;
  while (step * view.scale < 12) step *= 2;
  const x0 = Math.floor((0 - view.ox) / view.scale / step) * step;
  const x1 = (w - view.ox) / view.scale;
  const y0 = Math.floor((view.oy - h) / view.scale / step) * step;
  const y1 = view.oy / view.scale;
  ctx.save();
  ctx.lineWidth = 1;
  for (let x = x0; x <= x1; x += step) {
    const sx = Math.round(view.ox + x * view.scale) + 0.5;
    const major = Math.abs(Math.round(x / (step * 5)) * step * 5 - x) < 1e-9;
    ctx.strokeStyle = alpha(colors.grid, major ? 0.35 : 0.15);
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
  }
  for (let y = y0; y <= y1; y += step) {
    const sy = Math.round(view.oy - y * view.scale) + 0.5;
    const major = Math.abs(Math.round(y / (step * 5)) * step * 5 - y) < 1e-9;
    ctx.strokeStyle = alpha(colors.grid, major ? 0.35 : 0.15);
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
  }
  ctx.restore();
}

function drawDimensions(ctx) {
  const m = state.model;
  if (m.nodes.length < 2) return;
  const b = bounds();
  const S = (x, y) => toScreen(view, x, y);
  if (b.maxX - b.minX > 1e-9) {
    const [x1, y1] = S(b.minX, b.minY), [x2] = S(b.maxX, b.minY);
    dimension(ctx, x1, y1 + 38, x2, y1 + 38, 0, `${fmt(b.maxX - b.minX, 4)} m`, colors.graphiteSoft, colors.graphite);
  }
  if (b.maxY - b.minY > 1e-9) {
    const [x1, y1] = S(b.minX, b.minY), [, y2] = S(b.minX, b.maxY);
    dimension(ctx, x1 - 40, y1, x1 - 40, y2, 0, `${fmt(b.maxY - b.minY, 4)} m`, colors.graphiteSoft, colors.graphite);
  }
}

// Hit testing
function pick(p) {
  const m = state.model;
  let best = null, bestD = PICK_PX;
  m.nodes.forEach((n, i) => {
    const [x, y] = toScreen(view, n.x, n.y);
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bestD) { best = { kind: "node", index: i }; bestD = d; }
  });
  if (best) return best;
  bestD = 6;
  m.members.forEach((b, i) => {
    const [x1, y1] = toScreen(view, m.nodes[b.a].x, m.nodes[b.a].y), [x2, y2] = toScreen(view, m.nodes[b.b].x, m.nodes[b.b].y);
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / (L2 || 1)));
    const d = Math.hypot(x1 + t * dx - p[0], y1 + t * dy - p[1]);
    if (d < bestD) { best = { kind: "member", index: i }; bestD = d; }
  });
  return best;
}

attachPanZoom(canvas, view, {
  onDown(e, p, mp) {
    const hit = pick(p);
    if (tool === "node" && !hit) {
      const i = addNode(snap(mp[0]), snap(mp[1]));
      selection = { kind: "node", index: i };
      update();
      return true;
    }
    if (tool === "member" && hit?.kind === "node") {
      drag = { kind: "newMember", from: hit.index, to: p };
      return true;
    }
    if (tool === "select" && hit) {
      selection = hit;
      if (hit.kind === "node") {
        drag = { kind: "moveNode", index: hit.index, before: JSON.stringify(state.model), moved: false };
      }
      update();
      return true;
    }
    return false;
  },
  onMove(e, p, mp) {
    if (drag?.kind === "newMember") {
      drag.to = p;
      draw();
    } else if (drag?.kind === "moveNode") {
      const n = state.model.nodes[drag.index];
      const x = snap(mp[0]), y = snap(mp[1]);
      if (x !== n.x || y !== n.y) {
        n.x = x; n.y = y;
        drag.moved = true;
        result = solveStructure(state.model);
        renderFind();
        draw();
      }
    }
  },
  onUp(e, p) {
    if (drag?.kind === "newMember") {
      const hit = pick(p);
      const from = drag.from;
      drag = null;
      if (hit?.kind === "node" && hit.index !== from) addMember(from, hit.index);
      else if (!hit) {
        const [mx, my] = [(p[0] - view.ox) / view.scale, (view.oy - p[1]) / view.scale];
        const to = addNode(snap(mx), snap(my));
        if (to !== from) addMember(from, to);
      }
      draw();
    } else if (drag?.kind === "moveNode") {
      if (drag.moved) {
        undoStack.push(drag.before);
        redoStack.length = 0;
      }
      drag = null;
      update();
    }
  },
  onCancel() { drag = null; },
  onClick(e, p) {
    if (tool === "select") {
      selection = pick(p);
      update();
    }
  },
  onHover(e, p) {
    const hit = pick(p);
    const changed = JSON.stringify(hit) !== JSON.stringify(hover);
    hover = hit;
    showTip(hit, p);
    if (changed) draw();
  },
  onLeave() {
    hover = null;
    tip.hidden = true;
    draw();
  },
  onView: () => { userView = true; draw(); },
});

function showTip(hit, p) {
  if (!hit || !result?.ok) { tip.hidden = true; return; }
  let s = "";
  if (hit.kind === "member") {
    const mr = result.members[hit.index];
    s = mr.type === "truss"
      ? `Member ${hit.index + 1} (truss)\nN = ${fixed(mr.N / 1e3, 3)} kN ${mr.N > 1e-9 ? "tension" : mr.N < -1e-9 ? "compression" : ""}`
      : `Member ${hit.index + 1} (frame)\nN = ${fixed(mr.Ni / 1e3, 3)} / ${fixed(mr.Nj / 1e3, 3)} kN\nV = ${fixed(mr.Vi / 1e3, 3)} / ${fixed(mr.Vj / 1e3, 3)} kN\nM = ${fixed(mr.Mi / 1e3, 3)} / ${fixed(mr.Mj / 1e3, 3)} kN·m`;
  } else {
    const d = result.disp[hit.index], n = state.model.nodes[hit.index];
    s = `Node ${hit.index + 1} (${fmt(n.x, 4)}, ${fmt(n.y, 4)}) m\nux = ${fixed(d.ux * 1e3, 4)} mm\nuy = ${fixed(d.uy * 1e3, 4)} mm`;
  }
  tip.textContent = s;
  tip.hidden = false;
  const stage = canvas.getBoundingClientRect();
  tip.style.left = `${Math.min(p[0] + 14, stage.width - 200)}px`;
  tip.style.top = `${p[1] + 14}px`;
}

// Find panel
function renderFind() {
  const err = $("solve-err");
  if (!result.ok) {
    err.textContent = result.error;
    for (const id of ["ans-axial", "ans-defl", "ans-moment"]) setAnswer(id, "n/a", "", "");
    fillTable($("t-react"), ["Node"], []);
    fillTable($("t-members"), ["Member"], []);
    fillTable($("t-disp"), ["Node"], []);
    $("status-note").textContent = "";
    return;
  }
  err.textContent = "";
  const r = result;
  setAnswer("ans-axial", fixed(Math.abs(r.maxAxial.value) / 1e3, 3), "kN",
    r.maxAxial.member >= 0 ? `member ${r.maxAxial.member + 1}, ${r.maxAxial.value > 0 ? "tension" : "compression"}` : "");
  const md = r.maxDeflection;
  setAnswer("ans-defl", fixed(md.value * 1e3, 3), "mm", md.node >= 0 ? `node ${md.node + 1}` : md.member >= 0 ? `member ${md.member + 1} at ${fixed(md.at, 3)} m` : "");
  const anyFrame = r.members.some((x) => x.type === "frame");
  setAnswer("ans-moment", anyFrame ? fixed(r.maxMoment.value / 1e3, 3) : "n/a", anyFrame ? "kN·m" : "",
    anyFrame && r.maxMoment.member >= 0 ? `member ${r.maxMoment.member + 1} at ${fixed(r.maxMoment.at, 3)} m` : "truss mode, no bending");

  fillTable($("t-react"), ["Node", "Rx kN", "Ry kN", "M kN·m"], r.reactions.map((x) => [
    `N${x.node + 1}`, fixed(x.rx / 1e3, 3), fixed(x.ry / 1e3, 3), fixed(x.mz / 1e3, 3)]));
  fillTable($("t-members"), ["Mem", "Ni", "Vi", "Mi", "Nj", "Vj", "Mj"], r.members.map((x) => x.type === "truss"
    ? [`M${x.index + 1} T`, fixed(x.N / 1e3, 3), "", "", fixed(x.N / 1e3, 3), "", ""]
    : [`M${x.index + 1} F`, ...[x.Ni, x.Vi, x.Mi, x.Nj, x.Vj, x.Mj].map((v) => fixed(v / 1e3, 3))]));
  fillTable($("t-disp"), ["Node", "ux mm", "uy mm", "θ rad"], r.disp.map((d, i) => [
    `N${i + 1}`, fixed(d.ux * 1e3, 4), fixed(d.uy * 1e3, 4), d.rz ? d.rz.toExponential(3) : "0"]));
  $("status-note").textContent = `${state.model.nodes.length} nodes, ${state.model.members.length} members, ${r.nFree} unknowns, half bandwidth ${r.bandwidth}. Forces in kN and kN·m. N is positive in tension.`;
}

// Selection editor
function numField(label, value, unit, onChange, step = "any") {
  const id = `f-${label.replace(/\W+/g, "-")}`;
  const input = el("input", { type: "number", id, step, value: String(value) });
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(v)) {
      input.setAttribute("aria-invalid", "true");
      return;
    }
    input.setAttribute("aria-invalid", "false");
    onChange(v);
  });
  return el("div", { class: "field" }, el("label", { for: id, text: label }), input, el("span", { class: "unit", text: unit }));
}

function selectField(label, value, options, onChange) {
  const id = `f-${label.replace(/\W+/g, "-")}`;
  const s = el("select", { id }, options.map(([v, t]) => el("option", { value: v, text: t, selected: v === value })));
  s.addEventListener("change", () => onChange(s.value));
  return el("div", { class: "field wide" }, el("label", { for: id, text: label }), s);
}

function renderEditor() {
  const host = $("sel-editor");
  const m = state.model;
  if (!selection || (selection.kind === "node" && !m.nodes[selection.index]) || (selection.kind === "member" && !m.members[selection.index])) {
    selection = null;
    host.replaceChildren(el("p", { class: "soft", text: "Select a node or member on the drawing to edit supports and loads." }));
    return;
  }
  const i = selection.index;
  if (selection.kind === "node") {
    const n = m.nodes[i];
    host.replaceChildren(
      el("h4", { text: `Node ${i + 1}` }),
      numField("x", n.x, "m", (v) => edit((mm) => { mm.nodes[i].x = v; })),
      numField("y", n.y, "m", (v) => edit((mm) => { mm.nodes[i].y = v; })),
      selectField("Support", n.support || "free", SUPPORT_TYPES.map((t) => [t, SUPPORT_LABELS[t]]), (v) => edit((mm) => { mm.nodes[i].support = v; })),
      numField("Fx", (n.fx || 0) / 1e3, "kN", (v) => edit((mm) => { mm.nodes[i].fx = v * 1e3; })),
      numField("Fy", (n.fy || 0) / 1e3, "kN", (v) => edit((mm) => { mm.nodes[i].fy = v * 1e3; })),
      numField("M", (n.m || 0) / 1e3, "kN·m", (v) => edit((mm) => { mm.nodes[i].m = v * 1e3; })),
      el("p", { class: "soft", text: "Forces are in global axes, positive right and up. Moment is positive counterclockwise." }),
    );
  } else {
    const b = m.members[i];
    host.replaceChildren(
      el("h4", { text: `Member ${i + 1}, node ${b.a + 1} to node ${b.b + 1}` }),
      selectField("Type", b.type || "frame", [["frame", "Frame"], ["truss", "Truss"]], (v) => edit((mm) => { mm.members[i].type = v; })),
      numField("E", b.E / 1e9, "GPa", (v) => edit((mm) => { mm.members[i].E = v * 1e9; })),
      numField("A", b.A * 1e6, "mm²", (v) => edit((mm) => { mm.members[i].A = v * 1e-6; })),
      numField("I", (b.I || 0) * 1e6, "10⁶mm⁴", (v) => edit((mm) => { mm.members[i].I = v * 1e-6; })),
      numField("w", (b.w || 0) / 1e3, "kN/m", (v) => edit((mm) => { mm.members[i].w = v * 1e3; })),
      selectField("w acts", b.wDir || "global", [["global", "Global y (per m of member)"], ["local", "Perpendicular to member"]], (v) => edit((mm) => { mm.members[i].wDir = v; })),
      el("p", { class: "soft", text: "Negative w points down (global) or to the member's right (perpendicular)." }),
    );
  }
}

// Controls
function setTool(t) {
  tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
  canvas.style.cursor = t === "select" ? "default" : "crosshair";
}

function initControls() {
  const presets = $("presets");
  for (const p of Object.values(PRESETS)) {
    presets.append(el("button", {
      type: "button", text: p.label, onclick: () => {
        edit((m) => { m.nodes = structuredClone(p.model.nodes); m.members = structuredClone(p.model.members); });
        selection = null;
        fitted = false;
        userView = false;
        update();
      },
    }));
  }
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("delete").addEventListener("click", deleteSelection);
  $("clear").addEventListener("click", () => { edit((m) => { m.nodes = []; m.members = []; }); selection = null; });
  $("grid").value = state.ui.grid;
  $("grid").addEventListener("change", () => {
    const v = readNumber($("grid"), { positive: true, name: "Grid" });
    if (v !== null) { state.ui.grid = v; update(); }
  });
  $("add-node").addEventListener("click", () => {
    const x = readNumber($("nx"), { name: "x" }), y = readNumber($("ny"), { name: "y" });
    if (x === null || y === null) return;
    selection = { kind: "node", index: addNode(x, y) };
    update();
  });
  $("add-member").addEventListener("click", () => {
    const a = Math.round(Number($("ma").value)) - 1, b = Math.round(Number($("mb").value)) - 1;
    const n = state.model.nodes.length;
    if (!(a >= 0 && a < n && b >= 0 && b < n)) { $("add-err").textContent = `Node numbers go from 1 to ${n}.`; return; }
    addMember(a, b);
  });
  const mat = $("mat");
  MATERIALS.forEach((x, i) => mat.append(el("option", { value: String(i), text: x.E ? `${x.name} (${x.E} GPa)` : x.name })));
  mat.addEventListener("change", () => { const x = MATERIALS[mat.value]; if (x.E) $("E").value = x.E; });
  $("E").addEventListener("input", () => { mat.value = String(MATERIALS.findIndex((x) => x.E === Number($("E").value)) >= 0 ? MATERIALS.findIndex((x) => x.E === Number($("E").value)) : 3); });
  const sec = $("sec");
  SECTIONS.forEach((x, i) => sec.append(el("option", { value: String(i), text: x.name })));
  sec.value = "3";
  sec.addEventListener("change", () => { const x = SECTIONS[sec.value]; if (x.A) { $("A").value = x.A; $("I").value = x.I; } });
  for (const id of ["A", "I"]) $(id).addEventListener("input", () => { sec.value = "4"; });
  $("apply-all").addEventListener("click", () => {
    const p = newMemberProps();
    if (!p) { $("sec-err").textContent = "Fix the section values first."; return; }
    $("sec-err").textContent = "";
    edit((m) => { m.members.forEach((b) => Object.assign(b, p)); });
  });
  $("all-truss").addEventListener("click", () => edit((m) => m.members.forEach((b) => { b.type = "truss"; })));
  $("all-frame").addEventListener("click", () => edit((m) => m.members.forEach((b) => { b.type = "frame"; if (!(b.I > 0)) b.I = 8e-6; })));

  $("field").value = state.ui.field;
  $("field").addEventListener("change", () => { state.ui.field = $("field").value; update(); });
  $("show-moment").checked = state.ui.moment;
  $("show-moment").addEventListener("change", () => { state.ui.moment = $("show-moment").checked; update(); });
  $("show-labels").checked = state.ui.labels;
  $("show-labels").addEventListener("change", () => { state.ui.labels = $("show-labels").checked; update(); });
  $("dscale").value = state.ui.dscale;
  $("dscale").addEventListener("change", () => {
    const v = Number($("dscale").value);
    state.ui.dscale = Number.isFinite(v) && v > 0 ? v : 0;
    update();
  });
  $("fit").addEventListener("click", () => { userView = false; fitModel(); draw(); });
  wireCopyLink($("copy-link"));
  $("csv").addEventListener("click", exportCsv);
  $("png").addEventListener("click", () => downloadCanvas(canvas, "vellum-frame.png"));

  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "Delete" || e.key === "Backspace") { deleteSelection(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.shiftKey ? redo() : undo(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { redo(); e.preventDefault(); }
  });
  new ResizeObserver(() => { if (!userView) fitModel(); draw(); }).observe(canvas);
}

function exportCsv() {
  if (!result?.ok) return;
  const rows = [];
  rows.push(["section", "id", "a", "b", "c", "d", "e", "f"]);
  for (const r of result.reactions) rows.push(["reaction", `N${r.node + 1}`, r.rx / 1e3, r.ry / 1e3, r.mz / 1e3, "", "", ""]);
  for (const x of result.members) rows.push(["member_end_forces", `M${x.index + 1}`, x.Ni / 1e3, x.Vi / 1e3, x.Mi / 1e3, x.Nj / 1e3, x.Vj / 1e3, x.Mj / 1e3]);
  result.disp.forEach((d, i) => rows.push(["displacement", `N${i + 1}`, d.ux * 1e3, d.uy * 1e3, d.rz, "", "", ""]));
  const head = ["section", "id", "Rx kN | Ni kN | ux mm", "Ry kN | Vi kN | uy mm", "M kN·m | Mi kN·m | rot rad", "Nj kN", "Vj kN", "Mj kN·m"];
  download("vellum-frame.csv", toCsv(head, rows.slice(1)), "text/csv");
}

initControls();
setTool("select");
update();
initSheet({ no: "01", title: "Frame and truss solver" });
