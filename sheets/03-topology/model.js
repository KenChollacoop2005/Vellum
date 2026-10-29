// SIMP topology optimization, a port of top88.m
const E0 = 1; // solid Young's modulus
const EMIN = 1e-9; // void Young's modulus
const NU = 0.3; // Poisson's ratio
const MOVE = 0.2; // OC move limit
const OC_TOL = 1e-3; // OC bisection tolerance

// KE as in top88, flat row major 8x8
export function keMatrix(nu = NU) {
  const A11 = [12, 3, -6, -3, 3, 12, 3, 0, -6, 3, 12, -3, -3, 0, -3, 12];
  const A12 = [-6, -3, 0, 3, -3, -6, -3, -6, 0, -3, -6, 3, 3, -6, 3, -6];
  const B11 = [-4, 3, -2, 9, 3, -4, -9, 4, -2, -9, -4, -3, 9, 4, -3, -4];
  const B12 = [2, -3, 4, -9, -3, 2, 9, -2, 4, 9, 2, 3, -9, -2, 3, 2];
  const KE = new Float64Array(64);
  const f = 1 / (1 - nu * nu) / 24;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const bi = i < 4 ? 0 : 1, bj = j < 4 ? 0 : 1, ii = i % 4, jj = j % 4;
      let a, b;
      if (bi === bj) { a = A11[ii * 4 + jj]; b = B11[ii * 4 + jj]; }
      else if (bi === 0) { a = A12[ii * 4 + jj]; b = B12[ii * 4 + jj]; }
      else { a = A12[jj * 4 + ii]; b = B12[jj * 4 + ii]; }
      KE[i * 8 + j] = f * (a + nu * b);
    }
  }
  return KE;
}

// Element dof table, same numbering as top88 (0 based)
export function edofTable(nelx, nely) {
  const edof = new Int32Array(nelx * nely * 8);
  for (let elx = 0; elx < nelx; elx++) {
    for (let ely = 0; ely < nely; ely++) {
      const e = elx * nely + ely;
      const n1 = elx * (nely + 1) + ely;
      const base = 2 * n1 + 2;
      const off = [0, 1, 2 * nely + 2, 2 * nely + 3, 2 * nely, 2 * nely + 1, -2, -1];
      for (let k = 0; k < 8; k++) edof[e * 8 + k] = base + off[k];
    }
  }
  return edof;
}

// Filter weights H in compressed rows
export function filterMatrix(nelx, nely, rmin) {
  const rows = new Int32Array(nelx * nely + 1);
  const cols = [], vals = [];
  const r = Math.ceil(rmin) - 1;
  const Hs = new Float64Array(nelx * nely);
  for (let i1 = 0; i1 < nelx; i1++) {
    for (let j1 = 0; j1 < nely; j1++) {
      const e1 = i1 * nely + j1;
      rows[e1] = cols.length;
      for (let i2 = Math.max(i1 - r, 0); i2 <= Math.min(i1 + r, nelx - 1); i2++) {
        for (let j2 = Math.max(j1 - r, 0); j2 <= Math.min(j1 + r, nely - 1); j2++) {
          const w = Math.max(0, rmin - Math.hypot(i1 - i2, j1 - j2));
          if (w <= 0) continue;
          cols.push(i2 * nely + j2);
          vals.push(w);
          Hs[e1] += w;
        }
      }
    }
  }
  rows[nelx * nely] = cols.length;
  return { rows, cols: Int32Array.from(cols), vals: Float64Array.from(vals), Hs };
}

function hMul(H, v, out) {
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = H.rows[i]; k < H.rows[i + 1]; k++) s += H.vals[k] * v[H.cols[k]];
    out[i] = s;
  }
  return out;
}

// Problem setup from plain settings
export function buildProblem(cfg) {
  const { nelx, nely } = cfg;
  const nn = (nelx + 1) * (nely + 1), ndof = 2 * nn;
  const fixed = new Uint8Array(ndof);
  for (const [node, mask] of cfg.supports) {
    if (mask & 1) fixed[2 * node] = 1;
    if (mask & 2) fixed[2 * node + 1] = 1;
  }
  const F = new Float64Array(ndof);
  for (const [node, fx, fy] of cfg.loads) { F[2 * node] += fx; F[2 * node + 1] += fy; }
  const passive = new Uint8Array(nelx * nely);
  if (cfg.passive) for (const [e, kind] of cfg.passive) passive[e] = kind;
  return {
    nelx, nely, volfrac: cfg.volfrac, penal: cfg.penal, rmin: cfg.rmin, ft: cfg.ft,
    maxIter: cfg.maxIter ?? 300, tol: cfg.tol ?? 0.01,
    KE: keMatrix(), edof: edofTable(nelx, nely), H: filterMatrix(nelx, nely, cfg.rmin), fixed, F, passive,
  };
}

// MBB half beam exactly as in top88
export function mbbProblem({ nelx, nely, volfrac, penal, rmin, ft }) {
  const supports = [];
  for (let j = 0; j <= nely; j++) supports.push([j, 1]);
  supports.push([(nelx + 1) * (nely + 1) - 1, 2]);
  return buildProblem({ nelx, nely, volfrac, penal, rmin, ft, supports, loads: [[0, 0, -1]] });
}

// Free dof numbering keeps top88 order
function freeMap(fixed) {
  const eq = new Int32Array(fixed.length);
  let n = 0;
  for (let d = 0; d < fixed.length; d++) eq[d] = fixed[d] ? -1 : n++;
  return { eq, n };
}

// Banded Cholesky solve of K U = F
function solveBanded(p, E, eq, nf) {
  const { edof, KE } = p;
  let bw = 0;
  const ne = p.nelx * p.nely;
  for (let e = 0; e < ne; e++) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 8; k++) {
      const q = eq[edof[e * 8 + k]];
      if (q < 0) continue;
      if (q < lo) lo = q;
      if (q > hi) hi = q;
    }
    if (hi - lo > bw) bw = hi - lo;
  }
  const w = bw + 1;
  const U = new Float64Array(nf * w);
  for (let e = 0; e < ne; e++) {
    const Ee = E[e];
    for (let a = 0; a < 8; a++) {
      const i = eq[edof[e * 8 + a]];
      if (i < 0) continue;
      for (let b = 0; b < 8; b++) {
        const j = eq[edof[e * 8 + b]];
        if (j < i) continue;
        U[i * w + (j - i)] += Ee * KE[a * 8 + b];
      }
    }
  }
  // Factor in place, U'U, row oriented
  for (let i = 0; i < nf; i++) {
    const ii = i * w;
    const piv = U[ii];
    if (!(piv > 0)) throw new Error("Structure is unstable. Check supports.");
    const d = Math.sqrt(piv);
    U[ii] = d;
    const jmax = Math.min(nf - 1, i + bw);
    for (let j = i + 1; j <= jmax; j++) U[ii + (j - i)] /= d;
    for (let j = i + 1; j <= jmax; j++) {
      const f = U[ii + (j - i)];
      if (f === 0) continue;
      const jj = j * w - j, io = ii - i;
      for (let k = j; k <= jmax; k++) U[jj + k] -= f * U[io + k];
    }
  }
  const y = new Float64Array(nf);
  for (let g = 0; g < eq.length; g++) if (eq[g] >= 0) y[eq[g]] = p.F[g];
  for (let i = 0; i < nf; i++) {
    let s = y[i];
    for (let k = Math.max(0, i - bw); k < i; k++) s -= U[k * w + (i - k)] * y[k];
    y[i] = s / U[i * w];
  }
  for (let i = nf - 1; i >= 0; i--) {
    let s = y[i];
    const jmax = Math.min(nf - 1, i + bw);
    for (let j = i + 1; j <= jmax; j++) s -= U[i * w + (j - i)] * y[j];
    y[i] = s / U[i * w];
  }
  return y;
}

export function createOptimizer(p) {
  const ne = p.nelx * p.nely;
  const x = new Float64Array(ne).fill(p.volfrac);
  const xPhys = Float64Array.from(x);
  applyPassive(p, xPhys);
  const { eq, n } = freeMap(p.fixed);
  return { x, xPhys, loop: 0, change: 1, history: [], converged: false, eq, nf: n, U: new Float64Array(p.fixed.length) };
}

function applyPassive(p, xPhys) {
  for (let e = 0; e < xPhys.length; e++) {
    if (p.passive[e] === 1) xPhys[e] = 0;
    else if (p.passive[e] === 2) xPhys[e] = 1;
  }
}

// One top88 iteration
export function stepOptimizer(p, st) {
  const { nelx, nely, penal, ft, volfrac, KE, edof, H } = p;
  const ne = nelx * nely;
  st.loop += 1;
  // FE analysis
  const E = new Float64Array(ne);
  for (let e = 0; e < ne; e++) E[e] = EMIN + st.xPhys[e] ** penal * (E0 - EMIN);
  const uf = solveBanded(p, E, st.eq, st.nf);
  const U = st.U;
  for (let g = 0; g < U.length; g++) U[g] = st.eq[g] >= 0 ? uf[st.eq[g]] : 0;
  // Objective and sensitivity
  const ce = new Float64Array(ne);
  let c = 0;
  const dc = new Float64Array(ne), dv = new Float64Array(ne).fill(1);
  for (let e = 0; e < ne; e++) {
    let s = 0;
    for (let a = 0; a < 8; a++) {
      let t = 0;
      for (let b = 0; b < 8; b++) t += KE[a * 8 + b] * U[edof[e * 8 + b]];
      s += U[edof[e * 8 + a]] * t;
    }
    ce[e] = s;
    c += E[e] * s;
    dc[e] = -penal * (E0 - EMIN) * st.xPhys[e] ** (penal - 1) * s;
  }
  // Filtering of sensitivities
  if (ft === 1) {
    const tmp = new Float64Array(ne);
    for (let e = 0; e < ne; e++) tmp[e] = st.x[e] * dc[e];
    hMul(H, tmp, dc);
    for (let e = 0; e < ne; e++) dc[e] = dc[e] / H.Hs[e] / Math.max(1e-3, st.x[e]);
  } else {
    const t1 = new Float64Array(ne), t2 = new Float64Array(ne);
    for (let e = 0; e < ne; e++) { t1[e] = dc[e] / H.Hs[e]; t2[e] = dv[e] / H.Hs[e]; }
    hMul(H, t1, dc);
    hMul(H, t2, dv);
  }
  // Optimality criteria update
  let l1 = 0, l2 = 1e9;
  const xnew = new Float64Array(ne);
  const target = volfrac * ne;
  while ((l2 - l1) / (l1 + l2) > OC_TOL) {
    const lmid = 0.5 * (l2 + l1);
    for (let e = 0; e < ne; e++) {
      const xe = st.x[e];
      const cand = xe * Math.sqrt(-dc[e] / dv[e] / lmid);
      xnew[e] = Math.max(0, Math.max(xe - MOVE, Math.min(1, Math.min(xe + MOVE, cand))));
    }
    if (ft === 1) st.xPhys.set(xnew);
    else {
      hMul(H, xnew, st.xPhys);
      for (let e = 0; e < ne; e++) st.xPhys[e] /= H.Hs[e];
    }
    applyPassive(p, st.xPhys);
    let sum = 0;
    for (let e = 0; e < ne; e++) sum += st.xPhys[e];
    if (sum > target) l1 = lmid; else l2 = lmid;
  }
  let change = 0;
  for (let e = 0; e < ne; e++) change = Math.max(change, Math.abs(xnew[e] - st.x[e]));
  st.x.set(xnew);
  st.change = change;
  let vol = 0;
  for (let e = 0; e < ne; e++) vol += st.xPhys[e];
  vol /= ne;
  const rec = { loop: st.loop, c, vol, change };
  st.history.push(rec);
  st.converged = change <= p.tol;
  return rec;
}

// Sigmund 2007 measure of non discreteness, percent
export function nonDiscreteness(xPhys) {
  let s = 0;
  for (const v of xPhys) s += 4 * v * (1 - v);
  return (100 * s) / xPhys.length;
}

export async function runOptimizer(p, { onProgress = () => {}, yieldEvery = 5 } = {}) {
  const st = createOptimizer(p);
  while (st.change > p.tol && st.loop < p.maxIter) {
    stepOptimizer(p, st);
    if (st.loop % yieldEvery === 0) {
      onProgress(Math.min(0.99, st.loop / 100));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress(1);
  return { ...st, nonDiscreteness: nonDiscreteness(st.xPhys) };
}

// Thresholded grid, row major by elx then ely as elements
export function thresholdGrid(xPhys, nelx, nely, cut = 0.5) {
  const g = new Uint8Array(nelx * nely);
  for (let e = 0; e < g.length; e++) g[e] = xPhys[e] > cut ? 1 : 0;
  return g;
}

// Fill one cell of each corner only contact so the solid is manifold
export function removeDiagonalContacts(gridIn, nelx, nely) {
  const g = Uint8Array.from(gridIn);
  const at = (i, j) => (i >= 0 && i < nelx && j >= 0 && j < nely ? g[i * nely + j] : 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < nelx - 1; i++) {
      for (let j = 0; j < nely - 1; j++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
        if (a && d && !b && !c) { g[(i + 1) * nely + j] = 1; changed = true; }
        else if (b && c && !a && !d) { g[i * nely + j] = 1; changed = true; }
      }
    }
  }
  return g;
}

// Binary STL of the extruded grid, units mm
export function buildStl(grid, nelx, nely, size, thick) {
  const tris = [];
  const solid = (i, j) => i >= 0 && i < nelx && j >= 0 && j < nely && grid[i * nely + j] === 1;
  // Model coordinates: x = i * size, y = (nely - j) * size, ely 0 is the top row
  const P = (i, j, k) => [i * size, (nely - j) * size, k * thick];
  const quad = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]); };
  for (let i = 0; i < nelx; i++) {
    for (let j = 0; j < nely; j++) {
      if (!solid(i, j)) continue;
      const bl = [i, j + 1], br = [i + 1, j + 1], tr = [i + 1, j], tl = [i, j];
      quad(P(...bl, 1), P(...br, 1), P(...tr, 1), P(...tl, 1));
      quad(P(...bl, 0), P(...tl, 0), P(...tr, 0), P(...br, 0));
      if (!solid(i, j + 1)) quad(P(...bl, 0), P(...br, 0), P(...br, 1), P(...bl, 1));
      if (!solid(i + 1, j)) quad(P(...br, 0), P(...tr, 0), P(...tr, 1), P(...br, 1));
      if (!solid(i, j - 1)) quad(P(...tr, 0), P(...tl, 0), P(...tl, 1), P(...tr, 1));
      if (!solid(i - 1, j)) quad(P(...tl, 0), P(...bl, 0), P(...bl, 1), P(...tl, 1));
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const head = "vellum topology export";
  for (let k = 0; k < head.length; k++) dv.setUint8(k, head.charCodeAt(k));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    for (const val of [...n.map((x) => x / len), ...a, ...b, ...c]) { dv.setFloat32(o, val, true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

export function parseStl(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const tris = [];
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;
    const tri = [];
    for (let k = 0; k < 3; k++) { tri.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]); o += 12; }
    o += 2;
    tris.push(tri);
  }
  return tris;
}

// Outline loops of the solid region, grid units, y down
export function outlinePaths(grid, nelx, nely) {
  const solid = (i, j) => i >= 0 && i < nelx && j >= 0 && j < nely && grid[i * nely + j] === 1;
  const next = new Map();
  const add = (a, b) => next.set(`${a[0]},${a[1]}`, b);
  for (let i = 0; i < nelx; i++) {
    for (let j = 0; j < nely; j++) {
      if (!solid(i, j)) continue;
      if (!solid(i, j - 1)) add([i, j], [i + 1, j]);
      if (!solid(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
      if (!solid(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
      if (!solid(i - 1, j)) add([i, j + 1], [i, j]);
    }
  }
  const loops = [];
  while (next.size) {
    const [startKey, first] = next.entries().next().value;
    const start = startKey.split(",").map(Number);
    const loop = [start];
    let cur = first;
    next.delete(startKey);
    let guard = 0;
    while (guard++ < 1e6) {
      loop.push(cur);
      const k = `${cur[0]},${cur[1]}`;
      if (cur[0] === start[0] && cur[1] === start[1]) break;
      const nx = next.get(k);
      next.delete(k);
      if (!nx) break;
      cur = nx;
    }
    loops.push(simplify(loop));
  }
  return loops;
}

function simplify(loop) {
  const out = [loop[0]];
  for (let k = 1; k < loop.length - 1; k++) {
    const a = out[out.length - 1], b = loop[k], c = loop[k + 1];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue;
    out.push(b);
  }
  out.push(loop[loop.length - 1]);
  return out;
}

export function svgFromGrid(grid, nelx, nely, scale = 10) {
  const loops = outlinePaths(grid, nelx, nely);
  const d = loops.map((l) => `M${l.map((p) => `${p[0] * scale} ${p[1] * scale}`).join("L")}Z`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${nelx * scale} ${nely * scale}" width="${nelx * scale}" height="${nely * scale}"><path d="${d}" fill="#3B3E42" fill-rule="evenodd"/></svg>\n`;
}

// Boundary condition presets, node = elx * (nely + 1) + ely, ely 0 at the top
const node = (nely, i, j) => i * (nely + 1) + j;

export const PRESETS_TOP = {
  mbb: {
    label: "MBB beam (half)", defaults: { nelx: 60, nely: 20, volfrac: 0.5, penal: 3, rmin: 1.5, ft: 1 },
    bc: (nelx, nely) => {
      const supports = [];
      for (let j = 0; j <= nely; j++) supports.push([node(nely, 0, j), 1]);
      supports.push([node(nely, nelx, nely), 2]);
      return { supports, loads: [[node(nely, 0, 0), 0, -1]], passive: [] };
    },
  },
  cantilever: {
    label: "Cantilever", defaults: { nelx: 60, nely: 30, volfrac: 0.4, penal: 3, rmin: 1.5, ft: 1 },
    bc: (nelx, nely) => {
      const supports = [];
      for (let j = 0; j <= nely; j++) supports.push([node(nely, 0, j), 3]);
      return { supports, loads: [[node(nely, nelx, Math.round(nely / 2)), 0, -1]], passive: [] };
    },
  },
  bridge: {
    label: "Bridge", defaults: { nelx: 60, nely: 30, volfrac: 0.3, penal: 3, rmin: 1.5, ft: 1 },
    bc: (nelx, nely) => {
      const loads = [];
      for (let i = 0; i <= nelx; i++) loads.push([node(nely, i, 0), 0, -1 / (nelx + 1)]);
      return { supports: [[node(nely, 0, nely), 3], [node(nely, nelx, nely), 3]], loads, passive: [] };
    },
  },
  lbracket: {
    label: "L-bracket", defaults: { nelx: 60, nely: 60, volfrac: 0.4, penal: 3, rmin: 1.5, ft: 1 },
    bc: (nelx, nely) => {
      const supports = [];
      const arm = Math.round(nelx * 0.4), armH = Math.round(nely * 0.4);
      for (let i = 0; i <= arm; i++) supports.push([node(nely, i, 0), 3]);
      const passive = [];
      for (let i = arm; i < nelx; i++) for (let j = 0; j < nely - armH; j++) passive.push([i * nely + j, 1]);
      return { supports, loads: [[node(nely, nelx, nely - Math.round(armH / 2)), 0, -1]], passive };
    },
  },
};

export function presetProblem(cfg) {
  const bc = PRESETS_TOP[cfg.preset].bc(cfg.nelx, cfg.nely);
  return buildProblem({ ...cfg, ...bc });
}
