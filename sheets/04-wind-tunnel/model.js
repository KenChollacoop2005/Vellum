// D2Q9 lattice Boltzmann, TRT collision
export const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
export const TAU_MIN = 0.51; // smallest relaxation time allowed
export const U_MAX = 0.1; // largest lattice inlet speed
export const MAGIC = 0.25; // TRT magic parameter
const RHO_GUARD = [0.5, 2]; // density range treated as unstable

export const GRIDS = { coarse: [200, 80, 10], medium: [300, 120, 16], fine: [420, 168, 24] }; // nx, ny, cells per size
export const OBSTACLE = 1;
export const WALL = 2;

// Simulation state, plain typed arrays
export function createLbm({ nx, ny, tau, uIn = 0, profile = "uniform", yMode = "walls", xMode = "inout", solid, outline = null, init = null }) {
  const n = nx * ny;
  const f = new Float64Array(9 * n), g = new Float64Array(9 * n);
  const mask = solid ? Uint8Array.from(solid) : new Uint8Array(n);
  if (yMode === "walls") for (let i = 0; i < nx; i++) { mask[i] = WALL; mask[(ny - 1) * nx + i] = WALL; }
  const inlet = new Float64Array(ny);
  const H = yMode === "walls" ? ny - 2 : ny;
  for (let j = 0; j < ny; j++) {
    if (profile === "parabolic") {
      const y = (yMode === "walls" ? j - 1 : j) + 0.5;
      inlet[j] = y > 0 && y < H ? (4 * uIn * y * (H - y)) / (H * H) : 0;
    } else inlet[j] = uIn;
  }
  const sim = { nx, ny, n, tau, f, g, mask, inlet, yMode, xMode, step: 0, fx: 0, fy: 0, unstable: false };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    let rho = 1, ux = xMode === "inout" ? inlet[j] : 0, uy = 0;
    if (init) [rho, ux, uy] = init(i, j);
    if (mask[c]) { rho = 1; ux = 0; uy = 0; }
    for (let q = 0; q < 9; q++) f[q * n + c] = feq(q, rho, ux, uy);
  }
  refreshKinds(sim);
  if (outline) setWallDistances(sim, outline);
  return sim;
}

export function feq(q, rho, ux, uy) {
  const cu = 3 * (CX[q] * ux + CY[q] * uy);
  return W[q] * rho * (1 + cu + 0.5 * cu * cu - 1.5 * (ux * ux + uy * uy));
}

// Cell kinds: 0 interior fluid, 1 fluid near a boundary, 2 solid
export function refreshKinds(sim) {
  const { nx, ny, mask, xMode } = sim;
  const kind = sim.kind || new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (mask[c]) { kind[c] = 2; continue; }
    let k = 0;
    if (j === 0 || j === ny - 1 || i === 0 || i === nx - 1 || (xMode !== "periodic" && i === nx - 2)) k = 1;
    else {
      for (let q = 1; q < 9; q++) if (mask[(j - CY[q]) * nx + (i - CX[q])]) { k = 1; break; }
    }
    kind[c] = k;
  }
  sim.kind = kind;
}

// Advance n steps with fused pull streaming and collision
export function stepLbm(sim, steps = 1) {
  const { nx, ny, n, mask, inlet, yMode, xMode } = sim;
  const wp = 1 / sim.tau, wm = 1 / (0.5 + MAGIC / (sim.tau - 0.5));
  const eqs = new Float64Array(9);
  if (!sim.kind) refreshKinds(sim);
  const kind = sim.kind;
  const qw = sim.qw || null;
  const periodicY = yMode === "periodic", freeSlip = yMode === "freeslip", periodicX = xMode === "periodic";
  const fin = new Float64Array(9);
  const prev = new Float64Array(9);
  const n2 = 2 * n, n3 = 3 * n, n4 = 4 * n, n5 = 5 * n, n6 = 6 * n, n7 = 7 * n, n8 = 8 * n;
  const w0 = 4 / 9, w1 = 1 / 9, w5 = 1 / 36;
  for (let s = 0; s < steps; s++) {
    const f = sim.f, g = sim.g;
    let fx = 0, fy = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const k = kind[c];
        if (k === 0) {
          // Interior fast path, unrolled
          const f0 = f[c], f1 = f[n + c - 1], f2 = f[n2 + c - nx], f3 = f[n3 + c + 1], f4 = f[n4 + c + nx];
          const f5 = f[n5 + c - nx - 1], f6 = f[n6 + c - nx + 1], f7 = f[n7 + c + nx + 1], f8 = f[n8 + c + nx - 1];
          const rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
          const ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho, uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
          const usq = 1.5 * (ux * ux + uy * uy);
          const r1 = w1 * rho, r5 = w5 * rho;
          const a1 = 3 * ux, a2 = 3 * uy, a5 = 3 * (ux + uy), a6 = 3 * (uy - ux);
          // Even and odd equilibrium parts per direction pair
          const p1 = r1 * (1 + 0.5 * a1 * a1 - usq), m1 = r1 * a1;
          const p2 = r1 * (1 + 0.5 * a2 * a2 - usq), m2 = r1 * a2;
          const p5 = r5 * (1 + 0.5 * a5 * a5 - usq), m5 = r5 * a5;
          const p6 = r5 * (1 + 0.5 * a6 * a6 - usq), m6 = r5 * a6;
          g[c] = f0 + wp * (w0 * rho * (1 - usq) - f0);
          let sp = wp * (p1 - 0.5 * (f1 + f3)), sm = wm * (m1 - 0.5 * (f1 - f3));
          g[n + c] = f1 + sp + sm;
          g[n3 + c] = f3 + sp - sm;
          sp = wp * (p2 - 0.5 * (f2 + f4)); sm = wm * (m2 - 0.5 * (f2 - f4));
          g[n2 + c] = f2 + sp + sm;
          g[n4 + c] = f4 + sp - sm;
          sp = wp * (p5 - 0.5 * (f5 + f7)); sm = wm * (m5 - 0.5 * (f5 - f7));
          g[n5 + c] = f5 + sp + sm;
          g[n7 + c] = f7 + sp - sm;
          sp = wp * (p6 - 0.5 * (f6 + f8)); sm = wm * (m6 - 0.5 * (f6 - f8));
          g[n6 + c] = f6 + sp + sm;
          g[n8 + c] = f8 + sp - sm;
          continue;
        }
        if (k === 2) { for (let q = 0; q < 9; q++) g[q * n + c] = f[q * n + c]; continue; }
        // Gather incoming populations
        for (let q = 0; q < 9; q++) {
          let si = i - CX[q], sj = j - CY[q];
          if (periodicX) si = (si + nx) % nx;
          let mirrored = false;
          if (periodicY) sj = (sj + ny) % ny;
          else if (freeSlip && (sj < 0 || sj >= ny)) { sj = j; mirrored = true; }
          if (si < 0 || si >= nx || sj < 0 || sj >= ny) { fin[q] = NaN; continue; }
          if (mirrored) {
            fin[q] = f[mirrorY(q) * n + (sj * nx + si)];
            continue;
          }
          const sc = sj * nx + si;
          if (mask[sc]) {
            const o = OPP[q];
            const fo = f[o * n + c];
            let v = fo;
            if (mask[sc] === OBSTACLE && qw) {
              // Interpolated bounce back, Bouzidi linear
              const t = qw[o * n + c];
              if (t < 0.5) {
                const fi = i + CX[q], fj = j + CY[q];
                const c2 = fj * nx + fi;
                if (fi >= 0 && fi < nx && fj >= 0 && fj < ny && !mask[c2]) v = 2 * t * fo + (1 - 2 * t) * f[o * n + c2];
              } else v = fo / (2 * t) + ((2 * t - 1) / (2 * t)) * f[q * n + c];
            }
            fin[q] = v;
            if (mask[sc] === OBSTACLE) { fx += CX[o] * (fo + v); fy += CY[o] * (fo + v); }
          } else fin[q] = f[q * n + sc];
        }
        // Open boundaries
        if (!periodicX && i === 0) zouHeInlet(fin, inlet[j]);
        else if (!periodicX && i === nx - 1) {
          extrapolationOutlet(fin, prev);
        }
        // Collision
        let rho = 0, mx = 0, my = 0;
        for (let q = 0; q < 9; q++) { rho += fin[q]; mx += CX[q] * fin[q]; my += CY[q] * fin[q]; }
        const ux = mx / rho, uy = my / rho;
        const usq = 1.5 * (ux * ux + uy * uy);
        for (let q = 0; q < 9; q++) {
          const cu = 3 * (CX[q] * ux + CY[q] * uy);
          eqs[q] = W[q] * rho * (1 + cu + 0.5 * cu * cu - usq);
        }
        for (let q = 0; q < 9; q++) {
          const o = OPP[q];
          prev[q] = fin[q];
          g[q * n + c] = fin[q] + wp * (0.5 * (eqs[q] + eqs[o]) - 0.5 * (fin[q] + fin[o])) + wm * (0.5 * (eqs[q] - eqs[o]) - 0.5 * (fin[q] - fin[o]));
        }
      }
    }
    sim.f = g;
    sim.g = f;
    sim.fx = fx;
    sim.fy = fy;
    sim.step++;
  }
  return sim;
}

function mirrorY(q) {
  return [0, 1, 4, 3, 2, 8, 7, 6, 5][q];
}

// Fixed density, non equilibrium part copied from the neighbor
function extrapolationOutlet(fin, nb) {
  let rho = 0, mx = 0, my = 0;
  for (let q = 0; q < 9; q++) { rho += nb[q]; mx += CX[q] * nb[q]; my += CY[q] * nb[q]; }
  const ux = mx / rho, uy = my / rho;
  for (const q of [3, 6, 7]) fin[q] = feq(q, 1, ux, uy) + nb[q] - feq(q, rho, ux, uy);
}

function zouHeInlet(fin, ux) {
  const rho = (fin[0] + fin[2] + fin[4] + 2 * (fin[3] + fin[6] + fin[7])) / (1 - ux);
  fin[1] = fin[3] + (2 / 3) * rho * ux;
  fin[5] = fin[7] - 0.5 * (fin[2] - fin[4]) + (1 / 6) * rho * ux;
  fin[8] = fin[6] + 0.5 * (fin[2] - fin[4]) + (1 / 6) * rho * ux;
}

// Fraction of each fluid to obstacle link that lies in the fluid
export function setWallDistances(sim, poly) {
  const { nx, ny, n, mask } = sim;
  const qw = new Float64Array(9 * n).fill(0.5);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (mask[c]) continue;
    for (let q = 1; q < 9; q++) {
      const si = i + CX[q], sj = j + CY[q];
      if (si < 0 || si >= nx || sj < 0 || sj >= ny || mask[sj * nx + si] !== OBSTACLE) continue;
      const t = segmentHit(poly, i, j, CX[q], CY[q]);
      if (t !== null) qw[q * n + c] = Math.min(1, Math.max(1e-6, t));
    }
  }
  sim.qw = qw;
}

function segmentHit(poly, x, y, dx, dy) {
  let best = null;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [x1, y1] = poly[b], [x2, y2] = poly[a];
    const ex = x2 - x1, ey = y2 - y1;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-14) continue;
    const t = ((x1 - x) * ey - (y1 - y) * ex) / den;
    const u = ((x1 - x) * dy - (y1 - y) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}

// Density and velocity fields
export function macros(sim) {
  const { n, f, mask } = sim;
  const rho = new Float64Array(n), ux = new Float64Array(n), uy = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    if (mask[c]) { rho[c] = 1; continue; }
    let r = 0, mx = 0, my = 0;
    for (let q = 0; q < 9; q++) { const v = f[q * n + c]; r += v; mx += CX[q] * v; my += CY[q] * v; }
    rho[c] = r; ux[c] = mx / r; uy[c] = my / r;
  }
  return { rho, ux, uy };
}

export function totalMass(sim) {
  let m = 0;
  for (let k = 0; k < sim.f.length; k++) m += sim.f[k];
  return m;
}

export function checkStable(sim) {
  const { rho } = macros(sim);
  for (let c = 0; c < sim.n; c++) {
    if (sim.mask[c]) continue;
    if (!(rho[c] > RHO_GUARD[0] && rho[c] < RHO_GUARD[1])) { sim.unstable = true; return false; }
  }
  return true;
}

export function vorticity(sim, ux, uy) {
  const { nx, ny } = sim;
  const w = new Float64Array(nx * ny);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const c = j * nx + i;
    w[c] = 0.5 * (uy[c + 1] - uy[c - 1]) - 0.5 * (ux[c + nx] - ux[c - nx]);
  }
  return w;
}

// Bilinear sample of a node field at lattice coordinates
export function sample(field, nx, ny, x, y) {
  const i = Math.max(0, Math.min(nx - 2, Math.floor(x))), j = Math.max(0, Math.min(ny - 2, Math.floor(y)));
  const tx = Math.min(1, Math.max(0, x - i)), ty = Math.min(1, Math.max(0, y - j));
  const c = j * nx + i;
  return (1 - tx) * (1 - ty) * field[c] + tx * (1 - ty) * field[c + 1] + (1 - tx) * ty * field[c + nx] + tx * ty * field[c + nx + 1];
}

// Relaxation time from Reynolds number
export function tauFor(re, uRef, length) {
  return 3 * ((uRef * length) / re) + 0.5;
}

// Shapes rasterized on the lattice, node centers at (i, j)
export function naca4(code, chord, aoaDeg, n = 120) {
  const s = String(code).padStart(4, "0");
  const m = Number(s[0]) / 100, p = Number(s[1]) / 10, t = Number(s.slice(2)) / 100;
  const upper = [], lower = [];
  for (let k = 0; k <= n; k++) {
    const x = (1 - Math.cos((Math.PI * k) / n)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    let yc = 0, dy = 0;
    if (m > 0 && p > 0) {
      if (x < p) { yc = (m / (p * p)) * (2 * p * x - x * x); dy = ((2 * m) / (p * p)) * (p - x); }
      else { yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x); dy = ((2 * m) / ((1 - p) ** 2)) * (p - x); }
    }
    const th = Math.atan(dy);
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  const poly = [...upper, ...lower.reverse()];
  const a = (-aoaDeg * Math.PI) / 180;
  return poly.map(([x, y]) => {
    const xx = (x - 0.25) * chord, yy = y * chord;
    return [xx * Math.cos(a) - yy * Math.sin(a), xx * Math.sin(a) + yy * Math.cos(a)];
  });
}

function insidePoly(poly, x, y) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

export function shapeOutline(shape, size, angleDeg = 0, code = "2412") {
  const r = size / 2;
  if (shape === "cylinder") return Array.from({ length: 360 }, (_, k) => [r * Math.cos((2 * Math.PI * k) / 360), r * Math.sin((2 * Math.PI * k) / 360)]);
  if (shape === "square") return [[-r, -r], [r, -r], [r, r], [-r, r]];
  if (shape === "plate") {
    const a = (-angleDeg * Math.PI) / 180, t = Math.max(1.2, size * 0.06);
    return [[-r, -t / 2], [r, -t / 2], [r, t / 2], [-r, t / 2]].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
  }
  return naca4(code, size, angleDeg);
}

export function rasterize(nx, ny, outline, cx, cy) {
  const mask = new Uint8Array(nx * ny);
  const xs = outline.map((p) => p[0] + cx), ys = outline.map((p) => p[1] + cy);
  const poly = outline.map(([x, y]) => [x + cx, y + cy]);
  const i0 = Math.max(0, Math.floor(Math.min(...xs))), i1 = Math.min(nx - 1, Math.ceil(Math.max(...xs)));
  const j0 = Math.max(0, Math.floor(Math.min(...ys))), j1 = Math.min(ny - 1, Math.ceil(Math.max(...ys)));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (insidePoly(poly, i, j)) mask[j * nx + i] = OBSTACLE;
  return mask;
}

// Strouhal number from upward zero crossings of the lift
export function strouhal(lift, dtSteps, size, uRef) {
  if (lift.length < 50) return { periodic: false };
  const mean = lift.reduce((s, v) => s + v, 0) / lift.length;
  const amp = Math.max(...lift.map((v) => Math.abs(v - mean)));
  const cross = [];
  for (let k = 1; k < lift.length; k++) {
    const a = lift[k - 1] - mean, b = lift[k] - mean;
    if (a < 0 && b >= 0) cross.push(k - 1 + a / (a - b));
  }
  if (cross.length < 4 || amp < 1e-6) return { periodic: false, amp };
  const periods = [];
  for (let k = 1; k < cross.length; k++) periods.push((cross[k] - cross[k - 1]) * dtSteps);
  const recent = periods.slice(-6);
  const T = recent.reduce((s, v) => s + v, 0) / recent.length;
  const spread = Math.max(...recent.map((p) => Math.abs(p - T))) / T;
  return { periodic: spread < 0.05, St: size / (T * uRef), period: T, spread, amp };
}

// Schafer and Turek 2D-1 setup, cells per diameter d
export function schaferTurekSetup(d = 20, uMax = 0.05) {
  const dx = 0.1 / d;
  const H = Math.round(0.41 / dx), L = Math.round(2.2 / dx);
  const nx = L, ny = H + 2;
  const uMean = (2 / 3) * uMax;
  const tau = tauFor(20, uMean, d);
  const toLat = (x, y) => [x / dx - 0.5, y / dx - 0.5 + 1];
  const [cx, cy] = toLat(0.2, 0.2);
  const outline = shapeOutline("cylinder", d).map(([x, y]) => [x + cx, y + cy]);
  const solid = rasterize(nx, ny, shapeOutline("cylinder", d), cx, cy);
  return { nx, ny, d, dx, tau, uMax, uMean, cx, cy, solid, outline, toLat, scaleP: (0.3 / uMax) ** 2 };
}

export async function runSchaferTurek({ d = 20, uMax = 0.05, maxSteps = 200000, check = 2000, tol = 1e-5, onProgress = () => {} } = {}) {
  const st = schaferTurekSetup(d, uMax);
  const sim = createLbm({ nx: st.nx, ny: st.ny, tau: st.tau, uIn: st.uMax, profile: "parabolic", yMode: "walls", solid: st.solid, outline: st.outline });
  let last = Infinity, cd = 0;
  while (sim.step < maxSteps) {
    stepLbm(sim, check);
    cd = (2 * sim.fx) / (st.uMean * st.uMean * st.d);
    onProgress(Math.min(0.99, sim.step / 60000));
    await new Promise((r) => setTimeout(r, 0));
    if (!checkStable(sim)) throw new Error("Simulation went unstable.");
    if (Math.abs(cd - last) < tol * Math.abs(cd)) break;
    last = cd;
  }
  const cl = (2 * sim.fy) / (st.uMean * st.uMean * st.d);
  const { rho } = macros(sim);
  const [ax, ay] = st.toLat(0.15, 0.2), [bx, by] = st.toLat(0.25, 0.2);
  const pa = sample(rho, st.nx, st.ny, ax - 0.5, ay) / 3, pb = sample(rho, st.nx, st.ny, bx + 0.5, by) / 3;
  onProgress(1);
  return { cd, cl, dp: (pa - pb) * st.scaleP, steps: sim.step, setup: st };
}

// Poiseuille channel check, max error relative to the centerline speed
export function poiseuilleError({ ny = 22, lengthH = 6, re = 10, steps = 8000 } = {}) {
  const H = ny - 2, nx = Math.round(lengthH * H);
  const u = 0.05;
  const tau = tauFor(re, u, H);
  const sim = createLbm({ nx, ny, tau, uIn: u, profile: "uniform", yMode: "walls" });
  stepLbm(sim, steps);
  const { ux } = macros(sim);
  const i = Math.round(nx * 0.66);
  let flux = 0;
  for (let j = 1; j < ny - 1; j++) flux += ux[j * nx + i];
  const uMean = flux / H;
  let worst = 0;
  for (let j = 1; j < ny - 1; j++) {
    const y = j - 0.5;
    const ref = 6 * uMean * (y / H) * (1 - y / H);
    worst = Math.max(worst, Math.abs(ux[j * nx + i] - ref));
  }
  return worst / (1.5 * uMean);
}

// Closed periodic box with a seeded random start
export function massDrift(rng, steps = 10000, size = 32) {
  const sim = createLbm({
    nx: size, ny: size, tau: 0.6, xMode: "periodic", yMode: "periodic",
    init: () => [1 + 0.01 * (rng() - 0.5), 0.02 * (rng() - 0.5), 0.02 * (rng() - 0.5)],
  });
  const m0 = totalMass(sim);
  stepLbm(sim, steps);
  return Math.abs(totalMass(sim) - m0) / m0;
}

// Open mode cylinder for shedding
export async function runShedding({ d = 16, heightD = 12, lengthD = 24, re = 100, u = 0.05, steps = 80000, onProgress = () => {} } = {}) {
  const ny = heightD * d, nx = lengthD * d;
  const tau = tauFor(re, u, d);
  const cx = 5 * d, cy = ny / 2 + 0.3;
  const solid = rasterize(nx, ny, shapeOutline("cylinder", d), cx, cy);
  const outline = shapeOutline("cylinder", d).map(([x, y]) => [x + cx, y + cy]);
  const sim = createLbm({ nx, ny, tau, uIn: u, yMode: "periodic", solid, outline,
    init: (i, j) => [1, u, 0.01 * u * Math.sin((2 * Math.PI * i) / nx) * Math.exp(-(((j - cy) / d) ** 2))] });
  const lift = [];
  const every = 10;
  while (sim.step < steps) {
    stepLbm(sim, every);
    if (sim.step > steps / 2) lift.push(sim.fy);
    if (sim.step % 2000 === 0) {
      onProgress(sim.step / steps);
      await new Promise((r) => setTimeout(r, 0));
      if (!checkStable(sim)) throw new Error("Simulation went unstable.");
    }
  }
  onProgress(1);
  return { ...strouhal(lift, every, d, u), blockage: d / ny, tau };
}
