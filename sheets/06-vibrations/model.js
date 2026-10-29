// Mass, spring and damper chains
import { generalizedEigen, luSolve, matMul, transpose, zeros } from "../../core/linalg.js";

export const END_TYPES = { "fixed-fixed": "Fixed both ends", "fixed-free": "Fixed left, free right", "free-free": "Free both ends" };
const RIGID_TOL = 1e-8; // relative omega squared treated as rigid body
const PROP_TOL = 1e-8; // relative off diagonal modal damping

export function springCount(n, ends) {
  return ends === "fixed-fixed" ? n + 1 : ends === "fixed-free" ? n : n - 1;
}

// Spring i joins left and right masses, -1 is ground
export function springNodes(n, ends) {
  const out = [];
  const count = springCount(n, ends);
  const offset = ends === "free-free" ? 0 : -1;
  for (let i = 0; i < count; i++) {
    const l = i + offset, r = l + 1;
    out.push([l, r >= n ? -1 : r]);
  }
  return out;
}

export function validateChain(sys) {
  const n = sys.masses.length;
  if (n < 1 || n > 8) return "Use 1 to 8 masses.";
  if (sys.masses.some((m) => !(m > 0))) return "Every mass must be greater than zero.";
  if (sys.springs.length !== springCount(n, sys.ends)) return "Spring count does not match the masses and ends.";
  if (sys.springs.some((k) => !(k > 0))) return "Every spring must be greater than zero.";
  if ((sys.dampers || []).some((c) => !(c >= 0))) return "Damping can't be negative.";
  return null;
}

export function chainMatrices(sys) {
  const n = sys.masses.length;
  const M = zeros(n), K = zeros(n), C = zeros(n);
  sys.masses.forEach((m, i) => { M[i][i] = m; });
  const add = (Mx, [l, r], v) => {
    if (l >= 0) Mx[l][l] += v;
    if (r >= 0) Mx[r][r] += v;
    if (l >= 0 && r >= 0) { Mx[l][r] -= v; Mx[r][l] -= v; }
  };
  const nodes = springNodes(n, sys.ends);
  nodes.forEach((lr, i) => {
    add(K, lr, sys.springs[i]);
    add(C, lr, (sys.dampers || [])[i] || 0);
  });
  if (sys.rayleigh) {
    const { alpha = 0, beta = 0 } = sys.rayleigh;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) C[i][j] += alpha * M[i][j] + beta * K[i][j];
  }
  return { n, M, K, C, ends: sys.ends };
}

export function modes(sys) {
  const { values, vectors } = generalizedEigen(sys.K, sys.M);
  const scale = Math.max(...values.map(Math.abs), 1e-30);
  const w2 = values.map((v) => (Math.abs(v) < RIGID_TOL * scale ? 0 : v));
  const omega = w2.map((v) => Math.sqrt(Math.max(0, v)));
  const Phi = vectors;
  const PtCP = matMul(Phi, matMul(sys.C, transpose(Phi)));
  let off = 0, diag = 0;
  for (let i = 0; i < sys.n; i++) for (let j = 0; j < sys.n; j++) {
    if (i === j) diag = Math.max(diag, Math.abs(PtCP[i][j]));
    else off = Math.max(off, Math.abs(PtCP[i][j]));
  }
  const proportional = off <= PROP_TOL * Math.max(diag, 1e-30);
  const zeta = omega.map((w, i) => (w > 0 ? PtCP[i][i] / (2 * w) : 0));
  return { omega, hz: omega.map((w) => w / (2 * Math.PI)), shapes: Phi, zeta, proportional, damped: diag > 0 };
}

export function orthonormalityError(sys, md) {
  let worst = 0;
  const P = md.shapes;
  for (let a = 0; a < sys.n; a++) for (let b = 0; b < sys.n; b++) {
    let s = 0;
    for (let i = 0; i < sys.n; i++) for (let j = 0; j < sys.n; j++) s += P[a][i] * sys.M[i][j] * P[b][j];
    worst = Math.max(worst, Math.abs(s - (a === b ? 1 : 0)));
  }
  return worst;
}

export function closedFormChain(n, k, m) {
  return Array.from({ length: n }, (_, j) => 2 * Math.sqrt(k / m) * Math.sin(((j + 1) * Math.PI) / (2 * (n + 1))));
}

// Steady state amplitudes under F at one mass, exact complex solve
export function harmonicResponse(sys, at, F, w) {
  const n = sys.n;
  const big = zeros(2 * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const re = sys.K[i][j] - w * w * sys.M[i][j], im = w * sys.C[i][j];
    big[i][j] = re; big[i][j + n] = -im;
    big[i + n][j] = im; big[i + n][j + n] = re;
  }
  const rhs = new Array(2 * n).fill(0);
  rhs[at] = F;
  let x;
  try {
    x = luSolve(big, rhs);
  } catch {
    return Array(n).fill(Infinity);
  }
  return Array.from({ length: n }, (_, i) => Math.hypot(x[i], x[i + n]));
}

export function frequencySweep(sys, at, watch, w0, w1, count = 400) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const w = w0 * (w1 / w0) ** (i / (count - 1));
    out.push([w, harmonicResponse(sys, at, 1, w)[watch]]);
  }
  return out;
}

// Single degree peak by golden section on the response
export function peakAmplification(chain) {
  const sys = chainMatrices(chain);
  const wn = Math.sqrt(sys.K[0][0] / sys.M[0][0]);
  const amp = (w) => harmonicResponse(sys, 0, 1, w)[0] * sys.K[0][0];
  let a = 0.5 * wn, b = 1.5 * wn;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  for (let i = 0; i < 200 && b - a > 1e-14 * wn; i++) {
    if (amp(c) > amp(d)) b = d; else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  const w = 0.5 * (a + b);
  return { amplification: amp(w), ratio: w / wn, omega: w };
}

// Newmark average acceleration step
export function newmarkStepper(sys, dt) {
  const n = sys.n;
  const a0 = 4 / (dt * dt), a1 = 2 / dt;
  const Keff = sys.K.map((row, i) => row.map((k, j) => k + a0 * sys.M[i][j] + a1 * sys.C[i][j]));
  return (state) => {
    const { u, v, a } = state;
    const rhs = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        rhs[i] += sys.M[i][j] * (a0 * u[j] + (4 / dt) * v[j] + a[j]) + sys.C[i][j] * (a1 * u[j] + v[j]);
      }
    }
    const u1 = luSolve(Keff, rhs);
    const a1n = u1.map((x, i) => a0 * (x - u[i]) - (4 / dt) * v[i] - a[i]);
    const v1 = v.map((x, i) => x + (dt / 2) * (a[i] + a1n[i]));
    return { u: u1, v: v1, a: a1n, t: state.t + dt };
  };
}

export function initialState(sys, u0) {
  const n = sys.n;
  const Ku = u0.map((_, i) => -sys.K[i].reduce((s, k, j) => s + k * u0[j], 0));
  let a;
  try {
    a = luSolve(sys.M, Ku);
  } catch {
    a = new Array(n).fill(0);
  }
  return { u: u0.slice(), v: new Array(n).fill(0), a, t: 0 };
}

// Pitch mapping for audio
export function audioMapping(hz, low = 220, cap = 4000) {
  const live = hz.filter((f) => f > 1e-9);
  if (!live.length) return { tones: [], factor: 0, compressed: false };
  const f1 = Math.min(...live), fN = Math.max(...live);
  const factor = low / f1;
  if (fN * factor <= cap) return { tones: hz.map((f) => (f > 1e-9 ? f * factor : 0)), factor, compressed: false };
  const p = Math.log(cap / low) / Math.log(fN / f1);
  return { tones: hz.map((f) => (f > 1e-9 ? low * (f / f1) ** p : 0)), factor, compressed: true, exponent: p };
}

// Presets
export const VIB_PRESETS = {
  sdof: { label: "Single DOF", masses: [1], springs: [1000], dampers: [3.1623], ends: "fixed-free" },
  twoDof: { label: "Two DOF fixed free", masses: [1, 1], springs: [1000, 1000], dampers: [0, 0], ends: "fixed-free" },
  three: { label: "Three equal, fixed fixed", masses: [1, 1, 1], springs: [1000, 1000, 1000, 1000], dampers: [0, 0, 0, 0], ends: "fixed-fixed" },
  building: { label: "Building, 5 floors", masses: [20000, 20000, 20000, 20000, 15000], springs: [3.2e7, 2.8e7, 2.4e7, 2.0e7, 1.6e7], dampers: [0, 0, 0, 0, 0], ends: "fixed-free", rayleigh: { alpha: 0.25, beta: 0.002 } },
  tmd: { label: "Tuned mass damper", masses: [100, 5], springs: [1e5, 4535], dampers: [20, 38.3], ends: "fixed-free" },
};
