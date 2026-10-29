// Beam diagrams and Mohr's circle
import { createBanded, bandedSolve, UnstableError, UNSTABLE_MSG } from "../../core/linalg.js";
import { frameLocalK, linearLoadConsistent, addToBanded } from "../../core/fem.js";

const MESH_ELEMENTS = 240; // uniform beam elements before key points
const MERGE_TOL = 1e-9; // positions closer than this are one node
const DIAGRAM_POINTS = 600; // samples for plotting

export const SUPPORTS = {
  simply: "Simply supported",
  cantilever: "Cantilever (fixed at left)",
  propped: "Propped cantilever",
  fixedFixed: "Fixed at both ends",
  overhang: "Overhanging, two supports",
};

// Support list as [x, kind]
export function supportList(beam) {
  const L = beam.L;
  switch (beam.support) {
    case "simply": return [[0, "pin"], [L, "roller"]];
    case "cantilever": return [[0, "fixed"]];
    case "propped": return [[0, "fixed"], [L, "roller"]];
    case "fixedFixed": return [[0, "fixed"], [L, "fixed"]];
    case "overhang": return [[beam.a ?? 0, "pin"], [beam.b ?? L, "roller"]];
    default: return [];
  }
}

export function validateBeam(beam) {
  if (!(beam.L > 0)) return "Span must be greater than zero.";
  if (!(beam.E > 0) || !(beam.I > 0)) return "E and I must be greater than zero.";
  if (beam.support === "overhang") {
    const a = beam.a ?? 0, b = beam.b ?? beam.L;
    if (!(a >= 0 && b <= beam.L && b - a > MERGE_TOL)) return "Supports must sit on the beam, with the left one before the right one.";
  }
  for (const ld of beam.loads) {
    const xs = ld.type === "dist" ? [ld.x1, ld.x2] : [ld.x];
    if (xs.some((x) => !(x >= -MERGE_TOL && x <= beam.L + MERGE_TOL))) return "Every load must sit on the beam.";
    if (ld.type === "dist" && !(ld.x2 > ld.x1)) return "A distributed load needs its end after its start.";
  }
  return null;
}

function meshPoints(beam) {
  const pts = [];
  for (let i = 0; i <= MESH_ELEMENTS; i++) pts.push((beam.L * i) / MESH_ELEMENTS);
  for (const [x] of supportList(beam)) pts.push(x);
  for (const ld of beam.loads) {
    if (ld.type === "dist") pts.push(ld.x1, ld.x2);
    else pts.push(ld.x);
  }
  pts.sort((a, b) => a - b);
  const out = [];
  for (const x of pts) if (!out.length || x - out[out.length - 1] > MERGE_TOL * Math.max(1, beam.L)) out.push(Math.min(Math.max(x, 0), beam.L));
  return out;
}

function nodeIndex(xs, x) {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
  return best;
}

// Distributed load intensity, positive down
function qAt(ld, x) {
  if (x < ld.x1 || x > ld.x2) return 0;
  return ld.q1 + ((ld.q2 - ld.q1) * (x - ld.x1)) / (ld.x2 - ld.x1);
}

// Finite element solve for reactions and deflection
function feSolve(beam, xs) {
  const n = xs.length;
  const sup = supportList(beam);
  const fixedDof = new Array(2 * n).fill(false);
  const supNodes = sup.map(([x, kind]) => {
    const i = nodeIndex(xs, x);
    fixedDof[2 * i] = true;
    if (kind === "fixed") fixedDof[2 * i + 1] = true;
    return { node: i, x: xs[i], kind };
  });
  const eq = [];
  let nf = 0;
  for (let d = 0; d < 2 * n; d++) eq.push(fixedDof[d] ? -1 : nf++);
  const F = new Float64Array(2 * n);
  for (const ld of beam.loads) {
    if (ld.type === "point") F[2 * nodeIndex(xs, ld.x)] -= ld.P;
    if (ld.type === "moment") F[2 * nodeIndex(xs, ld.x) + 1] += ld.M;
  }
  const elems = [];
  for (let e = 0; e < n - 1; e++) {
    const L = xs[e + 1] - xs[e];
    const k6 = frameLocalK(beam.E, 1, beam.I, L);
    const k = [1, 2, 4, 5].map((i) => [1, 2, 4, 5].map((j) => k6[i][j]));
    let q1 = 0, q2 = 0;
    const xm = 0.5 * (xs[e] + xs[e + 1]);
    for (const ld of beam.loads) {
      if (ld.type !== "dist" || xm < ld.x1 || xm > ld.x2) continue;
      q1 += qAt(ld, xs[e]);
      q2 += qAt(ld, xs[e + 1]);
    }
    const p = linearLoadConsistent(-q1, -q2, L);
    [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3].forEach((g, a) => { F[g] += p[a]; });
    elems.push({ L, k, p, q1, q2 });
  }
  const u = new Float64Array(2 * n);
  if (nf > 0) {
    const K = createBanded(nf, 3);
    elems.forEach((el, e) => addToBanded(K, [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3].map((g) => eq[g]), el.k));
    const rhs = [];
    for (let g = 0; g < 2 * n; g++) if (eq[g] >= 0) rhs[eq[g]] = F[g];
    const x = bandedSolve(K, rhs);
    for (let g = 0; g < 2 * n; g++) if (eq[g] >= 0) u[g] = x[eq[g]];
  }
  // Reactions from element end forces
  const sum = new Float64Array(2 * n);
  const endM = [];
  elems.forEach((el, e) => {
    const ue = [u[2 * e], u[2 * e + 1], u[2 * e + 2], u[2 * e + 3]];
    const f = el.k.map((row, a) => row.reduce((s, v, b) => s + v * ue[b], 0) - el.p[a]);
    [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3].forEach((g, a) => { sum[g] += f[a]; });
    endM.push([-f[1], f[3]]);
  });
  const nodalLoad = new Float64Array(2 * n);
  for (const ld of beam.loads) {
    if (ld.type === "point") nodalLoad[2 * nodeIndex(xs, ld.x)] -= ld.P;
    if (ld.type === "moment") nodalLoad[2 * nodeIndex(xs, ld.x) + 1] += ld.M;
  }
  const reactions = supNodes.map((s) => ({
    x: s.x, kind: s.kind,
    R: sum[2 * s.node] - nodalLoad[2 * s.node],
    M: s.kind === "fixed" ? sum[2 * s.node + 1] - nodalLoad[2 * s.node + 1] : 0,
  }));
  return { u, reactions, endM, elems };
}

// Shear and moment from statics, positive sagging
function staticsAt(beam, reactions, x, side = 1) {
  const left = (p) => (side > 0 ? p <= x + MERGE_TOL : p < x - MERGE_TOL);
  let V = 0, M = 0;
  for (const r of reactions) {
    if (!left(r.x)) continue;
    V += r.R;
    M += r.R * (x - r.x) - r.M;
  }
  for (const ld of beam.loads) {
    if (ld.type === "point" && left(ld.x)) {
      V -= ld.P;
      M -= ld.P * (x - ld.x);
    } else if (ld.type === "moment" && left(ld.x)) {
      M -= ld.M;
    } else if (ld.type === "dist") {
      const b = Math.min(x, ld.x2);
      if (b <= ld.x1) continue;
      const qa = qAt(ld, ld.x1), qb = qAt(ld, b), len = b - ld.x1;
      const W = 0.5 * (qa + qb) * len;
      const xc = qa + qb === 0 ? ld.x1 + len / 2 : ld.x1 + (len * (qa + 2 * qb)) / (3 * (qa + qb));
      V -= W;
      M -= W * (x - xc);
    }
  }
  return { V, M };
}

// Hermite interpolation of FE deflection
function deflectionFromFe(xs, u, x) {
  let e = 0;
  while (e < xs.length - 2 && x > xs[e + 1]) e++;
  const L = xs[e + 1] - xs[e];
  const t = Math.min(1, Math.max(0, (x - xs[e]) / L));
  const h1 = 1 - 3 * t * t + 2 * t ** 3, h2 = L * (t - 2 * t * t + t ** 3);
  const h3 = 3 * t * t - 2 * t ** 3, h4 = L * (-t * t + t ** 3);
  return h1 * u[2 * e] + h2 * u[2 * e + 1] + h3 * u[2 * e + 2] + h4 * u[2 * e + 3];
}

export function solveBeam(beam) {
  const err = validateBeam(beam);
  if (err) return { ok: false, error: err };
  const xs = meshPoints(beam);
  let fe;
  try {
    fe = feSolve(beam, xs);
  } catch (e) {
    if (e instanceof UnstableError) return { ok: false, error: UNSTABLE_MSG };
    throw e;
  }
  const reactions = fe.reactions;
  const shearAt = (x, side = 1) => staticsAt(beam, reactions, x, side).V;
  const momentAt = (x, side = 1) => staticsAt(beam, reactions, x, side).M;
  const deflectionAt = (x) => deflectionFromFe(xs, fe.u, x);

  // Sample points include both sides of every jump
  const keys = new Set();
  for (let i = 0; i <= DIAGRAM_POINTS; i++) keys.add((beam.L * i) / DIAGRAM_POINTS);
  for (const x of xs) keys.add(x);
  const xsPlot = [...keys].sort((a, b) => a - b);
  const plot = [];
  for (const x of xsPlot) {
    const l = staticsAt(beam, reactions, x, -1), r = staticsAt(beam, reactions, x, 1);
    const w = deflectionAt(x);
    if (Math.abs(l.V - r.V) > 1e-9 || Math.abs(l.M - r.M) > 1e-9) plot.push({ x, V: l.V, M: l.M, w });
    plot.push({ x, V: r.V, M: r.M, w });
  }
  if (plot.length) {
    const last = plot[plot.length - 1];
    const tailR = staticsAt(beam, reactions, beam.L + 1e-6, 1);
    if (Math.abs(tailR.V) > 1e-9 && Math.abs(last.x - beam.L) < 1e-12) plot.push({ x: beam.L, V: tailR.V, M: tailR.M, w: last.w });
  }

  // Exact moment extremes: check zero shear points
  const cand = plot.map((p) => p.x);
  for (let i = 1; i < plot.length; i++) {
    const a = plot[i - 1], b = plot[i];
    if (a.V * b.V < 0 && b.x > a.x) {
      let lo = a.x, hi = b.x;
      for (let k = 0; k < 60; k++) {
        const mid = 0.5 * (lo + hi);
        if (shearAt(mid) * a.V > 0) lo = mid; else hi = mid;
      }
      cand.push(0.5 * (lo + hi));
    }
  }
  let maxMoment = { value: 0, signed: 0, x: 0 }, maxPositiveMoment = 0;
  for (const x of cand) {
    for (const side of [-1, 1]) {
      const m = momentAt(x, side);
      if (Math.abs(m) > maxMoment.value + 1e-12) maxMoment = { value: Math.abs(m), signed: m, x };
      maxPositiveMoment = Math.max(maxPositiveMoment, m);
    }
  }
  let maxShear = { value: 0, signed: 0, x: 0 };
  for (const p of plot) if (Math.abs(p.V) > maxShear.value + 1e-12) maxShear = { value: Math.abs(p.V), signed: p.V, x: p.x };

  // Deflection max refined around the largest node
  let iMax = 0;
  for (let i = 0; i < xs.length; i++) if (Math.abs(fe.u[2 * i]) > Math.abs(fe.u[2 * iMax])) iMax = i;
  let maxDeflection = { value: Math.abs(fe.u[2 * iMax]), signed: fe.u[2 * iMax], x: xs[iMax] };
  const lo = xs[Math.max(0, iMax - 1)], hi = xs[Math.min(xs.length - 1, iMax + 1)];
  for (let k = 0; k <= 200; k++) {
    const x = lo + ((hi - lo) * k) / 200, w = deflectionAt(x);
    if (Math.abs(w) > maxDeflection.value) maxDeflection = { value: Math.abs(w), signed: w, x };
  }

  // FE and statics moment agreement at mesh nodes
  let gap = 0;
  fe.endM.forEach(([mi, mj], e) => {
    gap = Math.max(gap, Math.abs(mi - momentAt(xs[e], 1)), Math.abs(mj - momentAt(xs[e + 1], -1)));
  });

  return {
    ok: true, beam, reactions, plot, shearAt, momentAt, deflectionAt, maxMoment, maxPositiveMoment, maxShear,
    maxDeflection, feStaticsGap: gap / 1e3, nodes: xs.length,
  };
}

// Plane stress transformation, angles in radians
export function transformStress(sx, sy, txy, theta) {
  const c = (sx + sy) / 2, a = (sx - sy) / 2;
  const c2 = Math.cos(2 * theta), s2 = Math.sin(2 * theta);
  return { sx: c + a * c2 + txy * s2, sy: c - a * c2 - txy * s2, txy: -a * s2 + txy * c2 };
}

export function principal(sx, sy, txy) {
  const c = (sx + sy) / 2, R = Math.hypot((sx - sy) / 2, txy);
  const s1 = c + R, s2 = c - R;
  const thetaP = 0.5 * Math.atan2(2 * txy, sx - sy);
  const all = [s1, s2, 0];
  const tauAbs = (Math.max(...all) - Math.min(...all)) / 2;
  return { center: c, R, s1, s2, tauMax: R, thetaP, thetaS: thetaP - Math.PI / 4, tauAbs };
}

// Presets in SI, loads positive down
export const BEAM_PRESETS = {
  ssUdl: { label: "Simply supported, UDL", L: 4, support: "simply", E: 200e9, I: 8e-6, loads: [{ type: "dist", x1: 0, x2: 4, q1: 5e3, q2: 5e3 }] },
  cantilever: { label: "Cantilever, tip load", L: 2, support: "cantilever", E: 200e9, I: 8e-6, loads: [{ type: "point", x: 2, P: 10e3 }] },
  propped: { label: "Propped cantilever, UDL", L: 4, support: "propped", E: 200e9, I: 8e-6, loads: [{ type: "dist", x1: 0, x2: 4, q1: 5e3, q2: 5e3 }] },
  fixed: { label: "Fixed fixed, UDL", L: 4, support: "fixedFixed", E: 200e9, I: 8e-6, loads: [{ type: "dist", x1: 0, x2: 4, q1: 5e3, q2: 5e3 }] },
  overhang: {
    label: "Overhang, mixed loads", L: 6, support: "overhang", a: 0, b: 4.5, E: 200e9, I: 2e-5,
    loads: [{ type: "dist", x1: 0, x2: 3, q1: 2e3, q2: 6e3 }, { type: "point", x: 6, P: 4e3 }, { type: "moment", x: 3.5, M: 3e3 }],
  },
};
