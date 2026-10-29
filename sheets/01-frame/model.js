// Frame and truss solver
import { createBanded, bandedSolve, UnstableError, UNSTABLE_MSG } from "../../core/linalg.js";
import {
  memberGeometry, trussGlobalK, frameLocalK, frameTransform, udlConsistentLocal, udlLumpedLocal,
  addToBanded, rcmOrder,
} from "../../core/fem.js";
import { matMul, matVec, transpose } from "../../core/linalg.js";
import { makeRng } from "../../core/rng.js";

const MIN_LENGTH = 1e-9; // members shorter than this are rejected
const RESTRAINTS = {
  free: [false, false, false],
  pin: [true, true, false],
  rollerX: [false, true, false],
  rollerY: [true, false, false],
  fixed: [true, true, true],
};

export const SUPPORT_TYPES = Object.keys(RESTRAINTS);

export function validateModel(model) {
  if (!model.nodes.length) return "Add at least one node.";
  if (!model.members.length) return "Add at least one member.";
  for (const [i, m] of model.members.entries()) {
    const a = model.nodes[m.a], b = model.nodes[m.b];
    if (!a || !b) return `Member ${i + 1} points to a missing node.`;
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_LENGTH) return `Member ${i + 1} has zero length.`;
    if (!(m.E > 0) || !(m.A > 0)) return `Member ${i + 1} needs E and A greater than zero.`;
    if ((m.type || "frame") === "frame" && !(m.I > 0)) return `Member ${i + 1} is a frame member and needs I greater than zero.`;
  }
  if (!model.nodes.some((n) => n.support && n.support !== "free")) return UNSTABLE_MSG;
  return null;
}

// Uniform load in local axes
export function memberLocalLoad(member, c, s) {
  const w = member.w || 0;
  if (!w) return [0, 0];
  if (member.wDir === "local") return [0, w];
  return [w * s, w * c];
}

function memberData(model, m) {
  const A = model.nodes[m.a], B = model.nodes[m.b];
  const { L, c, s } = memberGeometry(A.x, A.y, B.x, B.y);
  const type = m.type || "frame";
  const [qx, qy] = memberLocalLoad(m, c, s);
  const T = frameTransform(c, s);
  let kl;
  if (type === "truss") {
    const k = (m.E * m.A) / L;
    kl = Array.from({ length: 6 }, () => new Array(6).fill(0));
    kl[0][0] = k; kl[0][3] = -k; kl[3][0] = -k; kl[3][3] = k;
  } else {
    kl = frameLocalK(m.E, m.A, m.I, L);
  }
  const pl = type === "truss" ? udlLumpedLocal(qx, qy, L) : udlConsistentLocal(qx, qy, L);
  const kg = matMul(transpose(T), matMul(kl, T));
  const pg = matVec(transpose(T), pl);
  return { L, c, s, type, qx, qy, T, kl, kg, pl, pg, E: m.E, A: m.A, I: m.I };
}

export function solveStructure(model) {
  const err = validateModel(model);
  if (err) return { ok: false, error: err };
  const nN = model.nodes.length;
  const order = rcmOrder(nN, model.members.map((m) => [m.a, m.b]));
  const pos = new Array(nN);
  order.forEach((n, i) => { pos[n] = i; });

  // Rotation is live only where a frame member connects
  const hasFrame = new Array(nN).fill(false);
  for (const m of model.members) if ((m.type || "frame") === "frame") { hasFrame[m.a] = true; hasFrame[m.b] = true; }

  const restrained = model.nodes.map((n, i) => {
    const r = (RESTRAINTS[n.support || "free"] || RESTRAINTS.free).slice();
    if (!hasFrame[i]) r[2] = true;
    return r;
  });
  const eq = new Array(nN * 3).fill(-1);
  let nFree = 0;
  for (const n of order) for (let d = 0; d < 3; d++) if (!restrained[n][d]) eq[n * 3 + d] = nFree++;

  const data = model.members.map((m) => memberData(model, m));
  const gdofs = model.members.map((m) => [m.a * 3, m.a * 3 + 1, m.a * 3 + 2, m.b * 3, m.b * 3 + 1, m.b * 3 + 2]);
  let bw = 0;
  for (const g of gdofs) {
    const live = g.map((d) => eq[d]).filter((d) => d >= 0);
    if (live.length) bw = Math.max(bw, Math.max(...live) - Math.min(...live));
  }

  const F = new Float64Array(nN * 3);
  model.nodes.forEach((n, i) => {
    F[i * 3] += n.fx || 0;
    F[i * 3 + 1] += n.fy || 0;
    F[i * 3 + 2] += n.m || 0;
  });
  data.forEach((d, e) => gdofs[e].forEach((g, k) => { F[g] += d.pg[k]; }));

  const u = new Float64Array(nN * 3);
  if (nFree > 0) {
    const K = createBanded(nFree, bw);
    data.forEach((d, e) => addToBanded(K, gdofs[e].map((g) => eq[g]), d.kg));
    const rhs = new Array(nFree).fill(0);
    for (let g = 0; g < nN * 3; g++) if (eq[g] >= 0) rhs[eq[g]] = F[g];
    let x;
    try {
      x = bandedSolve(K, rhs);
    } catch (e) {
      if (e instanceof UnstableError) return { ok: false, error: UNSTABLE_MSG };
      throw e;
    }
    for (let g = 0; g < nN * 3; g++) if (eq[g] >= 0) u[g] = x[eq[g]];
  }
  const freeRotLocked = model.nodes.map((_, i) => !hasFrame[i]);

  // Member end forces and nodal sums
  const nodeSum = new Float64Array(nN * 3);
  const members = data.map((d, e) => {
    const ue = gdofs[e].map((g) => u[g]);
    const ul = matVec(d.T, ue);
    const kul = matVec(d.kl, ul);
    const f = kul.map((v, k) => v - d.pl[k]);
    const fg = matVec(transpose(d.T), f);
    gdofs[e].forEach((g, k) => { nodeSum[g] += fg[k]; });
    return {
      index: e, a: model.members[e].a, b: model.members[e].b, type: d.type, L: d.L, c: d.c, s: d.s,
      qx: d.qx, qy: d.qy, E: d.E, A: d.A, I: d.I, ul, f,
      N: d.type === "truss" ? f[3] : 0.5 * (-f[0] + f[3]),
      Ni: -f[0], Vi: f[1], Mi: -f[2], Nj: f[3], Vj: -f[4], Mj: f[5],
    };
  });

  const reactions = [];
  model.nodes.forEach((n, i) => {
    const r = restrained[i];
    if (!r[0] && !r[1] && !(r[2] && !freeRotLocked[i])) return;
    const rx = r[0] ? nodeSum[i * 3] - (n.fx || 0) : 0;
    const ry = r[1] ? nodeSum[i * 3 + 1] - (n.fy || 0) : 0;
    const mz = r[2] && !freeRotLocked[i] ? nodeSum[i * 3 + 2] - (n.m || 0) : 0;
    reactions.push({ node: i, rx, ry, mz });
  });

  const disp = model.nodes.map((_, i) => ({ ux: u[i * 3], uy: u[i * 3 + 1], rz: freeRotLocked[i] ? 0 : u[i * 3 + 2] }));
  const res = { ok: true, disp, reactions, members, bandwidth: bw, nFree };
  Object.assign(res, summarize(model, res));
  return res;
}

// Internal force diagrams along a member
export function memberDiagram(mr, n = 40) {
  const s = [], N = [], V = [], M = [];
  for (let k = 0; k <= n; k++) {
    const x = (mr.L * k) / n;
    s.push(x);
    N.push(mr.type === "truss" ? mr.N : -mr.f[0] - mr.qx * x);
    V.push(mr.type === "truss" ? 0 : mr.f[1] + mr.qy * x);
    M.push(mr.type === "truss" ? 0 : -mr.f[2] + mr.f[1] * x + (mr.qy * x * x) / 2);
  }
  return { s, N, V, M };
}

// Moment extremes including the parabola vertex
export function momentExtremes(mr) {
  if (mr.type === "truss") return { max: 0, min: 0, maxAt: 0, minAt: 0 };
  const M = (x) => -mr.f[2] + mr.f[1] * x + (mr.qy * x * x) / 2;
  const xs = [0, mr.L];
  if (mr.qy !== 0) {
    const xv = -mr.f[1] / mr.qy;
    if (xv > 0 && xv < mr.L) xs.push(xv);
  }
  let max = -Infinity, min = Infinity, maxAt = 0, minAt = 0;
  for (const x of xs) {
    const v = M(x);
    if (v > max) { max = v; maxAt = x; }
    if (v < min) { min = v; minAt = x; }
  }
  return { max, min, maxAt, minAt };
}

// Local displacement along a member, exact for uniform load
export function memberDeflection(mr, t) {
  const L = mr.L, x = t * L, [u1, v1, r1, u2, v2, r2] = mr.ul;
  const ax = u1 + (u2 - u1) * t;
  if (mr.type === "truss") return [ax, v1 + (v2 - v1) * t];
  const h1 = 1 - 3 * t * t + 2 * t ** 3, h2 = L * (t - 2 * t * t + t ** 3);
  const h3 = 3 * t * t - 2 * t ** 3, h4 = L * (-t * t + t ** 3);
  let v = h1 * v1 + h2 * r1 + h3 * v2 + h4 * r2;
  if (mr.qy) v += (mr.qy * x * x * (L - x) ** 2) / (24 * mr.E * mr.I);
  let a = ax;
  if (mr.qx) a += (mr.qx * x * (L - x)) / (2 * mr.E * mr.A);
  return [a, v];
}

export function deflectedPoints(model, mr, scale = 1, n = 24) {
  const A = model.nodes[mr.a];
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const [ul, vl] = memberDeflection(mr, t);
    const x0 = A.x + mr.c * mr.L * t, y0 = A.y + mr.s * mr.L * t;
    pts.push([x0 + scale * (mr.c * ul - mr.s * vl), y0 + scale * (mr.s * ul + mr.c * vl)]);
  }
  return pts;
}

function summarize(model, res) {
  let maxAxial = { value: 0, member: -1 };
  let maxMoment = { value: 0, member: -1, at: 0 };
  let maxPositiveMoment = 0;
  for (const mr of res.members) {
    const nAbs = Math.max(Math.abs(mr.Ni), Math.abs(mr.Nj));
    if (nAbs > Math.abs(maxAxial.value) + 1e-12) maxAxial = { value: Math.abs(mr.Ni) >= Math.abs(mr.Nj) ? mr.Ni : mr.Nj, member: mr.index };
    const ex = momentExtremes(mr);
    if (Math.abs(ex.max) > Math.abs(maxMoment.value)) maxMoment = { value: Math.abs(ex.max), signed: ex.max, member: mr.index, at: ex.maxAt };
    if (Math.abs(ex.min) > Math.abs(maxMoment.value)) maxMoment = { value: Math.abs(ex.min), signed: ex.min, member: mr.index, at: ex.minAt };
    maxPositiveMoment = Math.max(maxPositiveMoment, ex.max);
  }
  let maxDefl = { value: 0, node: -1, member: -1, at: 0 };
  res.disp.forEach((d, i) => {
    const v = Math.hypot(d.ux, d.uy);
    if (v > maxDefl.value) maxDefl = { value: v, node: i, member: -1, at: 0 };
  });
  for (const mr of res.members) {
    if (mr.type === "truss") continue;
    for (let k = 1; k < 32; k++) {
      const [ul, vl] = memberDeflection(mr, k / 32);
      const v = Math.hypot(ul, vl);
      if (v > maxDefl.value * (1 + 1e-9)) maxDefl = { value: v, node: -1, member: mr.index, at: (k / 32) * mr.L };
    }
  }
  return { maxAxial, maxMoment, maxPositiveMoment, maxDeflection: maxDefl };
}

// Sum of reactions plus loads, relative to load size
export function equilibriumResidual(model, res) {
  let fx = 0, fy = 0, mz = 0, scale = 0;
  const addForce = (x, y, Fx, Fy, M = 0) => {
    fx += Fx; fy += Fy; mz += x * Fy - y * Fx + M;
    scale = Math.max(scale, Math.abs(Fx), Math.abs(Fy));
  };
  model.nodes.forEach((n) => addForce(n.x, n.y, n.fx || 0, n.fy || 0, n.m || 0));
  for (const mr of res.members) {
    const A = model.nodes[mr.a];
    const Qx = mr.qx * mr.L, Qy = mr.qy * mr.L;
    const gx = mr.c * Qx - mr.s * Qy, gy = mr.s * Qx + mr.c * Qy;
    addForce(A.x + mr.c * mr.L / 2, A.y + mr.s * mr.L / 2, gx, gy);
  }
  for (const r of res.reactions) {
    const n = model.nodes[r.node];
    addForce(n.x, n.y, r.rx, r.ry, r.mz);
  }
  let size = 1;
  for (const n of model.nodes) size = Math.max(size, Math.abs(n.x), Math.abs(n.y));
  return Math.max(Math.abs(fx), Math.abs(fy), Math.abs(mz) / size) / (scale || 1);
}

// Straight beam built from n frame elements
export function beamModel({ L, n, E, A, I, supports = {}, loads = {}, w = 0 }) {
  const nodes = [];
  for (let i = 0; i <= n; i++) nodes.push({ x: (L * i) / n, y: 0, support: supports[i] || "free", ...(loads[i] || {}) });
  const members = [];
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, type: "frame", E, A, I, w, wDir: "global" });
  return { nodes, members };
}

// Seeded random frame that is always stable
export function randomStableStructure(seed) {
  const rng = makeRng(seed);
  const n = 4 + Math.floor(rng() * 5);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      x: i * 2 + rng(), y: rng() * 3, support: "free",
      fx: (rng() - 0.5) * 2e4, fy: (rng() - 0.5) * 2e4, m: (rng() - 0.5) * 1e4,
    });
  }
  nodes[0].support = "fixed";
  nodes[n - 1].support = "pin";
  const members = [];
  const sec = () => ({ E: 200e9 * (0.5 + rng()), A: 1e-3 * (0.5 + rng()), I: 1e-5 * (0.5 + rng()) });
  for (let i = 0; i < n - 1; i++) {
    members.push({ a: i, b: i + 1, type: "frame", ...sec(), w: (rng() - 0.5) * 1e4, wDir: rng() < 0.5 ? "global" : "local" });
  }
  for (let i = 0; i < n - 2; i += 2) members.push({ a: i, b: i + 2, type: rng() < 0.5 ? "truss" : "frame", ...sec() });
  return { nodes, members };
}

// Presets in SI
const STEEL = { E: 200e9 };
const W_SEC = { A: 5.0e-3, I: 8.0e-6 };

function line(nodes, members) {
  return { nodes, members };
}

export const PRESETS = {
  cantilever: {
    label: "Cantilever",
    model: line(
      [{ x: 0, y: 0, support: "fixed" }, { x: 1, y: 0 }, { x: 2, y: 0, fy: -10e3 }],
      [{ a: 0, b: 1, type: "frame", ...STEEL, ...W_SEC }, { a: 1, b: 2, type: "frame", ...STEEL, ...W_SEC }],
    ),
  },
  simply: {
    label: "Simply supported, UDL",
    model: beamModel({ L: 4, n: 4, ...STEEL, ...W_SEC, supports: { 0: "pin", 4: "rollerX" }, w: -5e3 }),
  },
  propped: {
    label: "Propped cantilever",
    model: beamModel({ L: 4, n: 4, ...STEEL, ...W_SEC, supports: { 0: "fixed", 4: "rollerX" }, w: -5e3 }),
  },
  triangle: {
    label: "Triangle truss",
    model: line(
      [{ x: 0, y: 0, support: "pin" }, { x: 4, y: 0, support: "rollerX" }, { x: 2, y: 3, fy: -10e3 }],
      [[0, 1], [0, 2], [1, 2]].map(([a, b]) => ({ a, b, type: "truss", ...STEEL, A: 1e-3, I: 8e-6 })),
    ),
  },
  pratt: {
    label: "Pratt truss",
    model: line(
      [{ x: 0, y: 0, support: "pin" }, { x: 3, y: 0, fy: -20e3 }, { x: 6, y: 0, fy: -20e3 }, { x: 9, y: 0, support: "rollerX" },
        { x: 3, y: 3 }, { x: 6, y: 3 }],
      [[0, 1], [1, 2], [2, 3], [4, 5], [0, 4], [1, 4], [1, 5], [2, 5], [5, 3]].map(([a, b]) => ({ a, b, type: "truss", ...STEEL, A: 2e-3, I: 8e-6 })),
    ),
  },
  portal: {
    label: "Portal frame, side load",
    model: line(
      [{ x: 0, y: 0, support: "fixed" }, { x: 0, y: 3, fx: 10e3 }, { x: 4, y: 3 }, { x: 4, y: 0, support: "fixed" }],
      [[0, 1], [1, 2], [2, 3]].map(([a, b]) => ({ a, b, type: "frame", ...STEEL, ...W_SEC })),
    ),
  },
};
