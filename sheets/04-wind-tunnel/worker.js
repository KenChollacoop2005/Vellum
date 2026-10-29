// Wind tunnel worker
import {
  createLbm, stepLbm, macros, vorticity, sample, tauFor, rasterize, shapeOutline, refreshKinds, feq, strouhal,
  OBSTACLE, TAU_MIN, GRIDS,
} from "./model.js";

const LIFT_EVERY = 10; // steps between force samples
const SIZE_FACTOR = { plate: 2, naca: 3 }; // shape length in grid cells per size unit
const TARGET_MS = 24; // compute time per batch
const TAU_COMFORT = 1.5; // largest tau before the inlet speed is lowered
const SPEEDS = { accurate: 0.05, fast: 0.1 }; // peak lattice inlet speed
const WARMUP_FLOWS = 2; // flow-through times before averaging
const KICK = 0.3; // startup transverse kick, fraction of U
const KICK_RE = 40; // kick only where shedding is expected
const PARTICLES = 500; // tracer count
const COLORS = { vellum: [244, 241, 232], graphite: [59, 62, 66], red: [178, 58, 46], blue: [44, 91, 134], ink: [18, 19, 20] };

let sim = null, cfg = null, info = null;
let running = false, token = 0;
let batch = 20;
let forces = [];
let particles = null;
let rngState = 12345;

function rand() {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
}

function obstacleSize(mask, nx, ny) {
  let j0 = ny, j1 = -1;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (mask[j * nx + i] === OBSTACLE) { j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
  return j1 >= j0 ? j1 - j0 + 1 : 0;
}

function setup(c) {
  cfg = c;
  const [nx, nyBase, D] = GRIDS[c.grid];
  const ny = c.mode === "tunnel" ? nyBase + 2 : nyBase;
  const cx = Math.round(nx / 4), cy = ny / 2 + 0.3;
  let mask, outline = null;
  if (c.shape === "draw") {
    mask = new Uint8Array(nx * ny);
    if (c.cells) for (const k of c.cells) if (k >= 0 && k < nx * ny) mask[k] = OBSTACLE;
  } else {
    const shape = shapeOutline(c.shape, D * (SIZE_FACTOR[c.shape] || 1), c.angle, c.code);
    mask = rasterize(nx, ny, shape, cx, cy);
    outline = shape.map(([x, y]) => [x + cx, y + cy]);
  }
  const L = c.shape === "draw" ? Math.max(1, obstacleSize(mask, nx, ny)) : D * (SIZE_FACTOR[c.shape] || 1);
  const parabolic = c.mode === "tunnel";
  const meanOverPeak = parabolic ? 2 / 3 : 1;
  const uPeak = Math.min(SPEEDS[c.speed] ?? SPEEDS.accurate, ((TAU_COMFORT - 0.5) / 3) * c.re / L / meanOverPeak);
  const u = uPeak * meanOverPeak;
  const tau = tauFor(c.re, u, L);
  info = { nx, ny, D: L, u, uPeak, tau, cx, cy, parabolic };
  forces = [];
  if (tau < TAU_MIN) {
    sim = null;
    postMessage({ type: "error", message: `That Reynolds number is too high for this grid (τ = ${tau.toFixed(3)}, it must stay above ${TAU_MIN}). Use a finer grid or a lower Reynolds number.`, info });
    return;
  }
  const kx = cx + 1.5 * L, ky = cy;
  const H = ny - 2;
  const baseU = (j) => (parabolic ? Math.max(0, (4 * uPeak * (j - 0.5) * (H - (j - 0.5))) / (H * H)) : uPeak);
  const init = c.re >= KICK_RE
    ? (i, j) => [1, baseU(j), KICK * u * Math.exp(-((i - kx) ** 2 + (j - ky) ** 2) / (L * L))]
    : null;
  sim = createLbm({ nx, ny, tau, uIn: uPeak, profile: parabolic ? "parabolic" : "uniform", yMode: parabolic ? "walls" : "periodic", solid: mask, outline, init });
  info.warmup = Math.round((WARMUP_FLOWS * nx) / u);
  seedParticles();
  postMessage({ type: "setup", info, mask: Uint8Array.from(sim.mask) });
  frame();
}

function seedParticles() {
  const { nx, ny } = sim;
  particles = new Float32Array(PARTICLES * 2);
  for (let p = 0; p < PARTICLES; p++) { particles[2 * p] = rand() * nx; particles[2 * p + 1] = 1 + rand() * (ny - 2); }
}

function advect(ux, uy, steps) {
  const { nx, ny, mask } = sim;
  for (let p = 0; p < PARTICLES; p++) {
    let x = particles[2 * p], y = particles[2 * p + 1];
    x += sample(ux, nx, ny, x, y) * steps;
    y += sample(uy, nx, ny, x, y) * steps;
    const c = Math.round(y) * nx + Math.round(x);
    if (x >= nx - 1 || x < 0 || y < 0.5 || y > ny - 1.5 || mask[c]) { x = rand() * 2; y = 1 + rand() * (ny - 2); }
    particles[2 * p] = x;
    particles[2 * p + 1] = y;
  }
}

function colorImage(view, rho, ux, uy) {
  const { nx, ny, mask } = sim;
  const img = new Uint8ClampedArray(nx * ny * 4);
  const U = info.u;
  const w = view === "vorticity" ? vorticity(sim, ux, uy) : null;
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    const o = ((ny - 1 - j) * nx + i) * 4;
    let col;
    if (mask[c]) col = COLORS.graphite;
    else if (view === "speed") col = mix(COLORS.vellum, COLORS.graphite, Math.min(1, Math.hypot(ux[c], uy[c]) / (1.6 * U)));
    else {
      const v = view === "vorticity" ? (w[c] * info.D) / U / 4 : (rho[c] - 1) / 3 / (0.5 * U * U) / 1.5;
      const t = Math.max(-1, Math.min(1, v));
      col = mix(COLORS.vellum, t >= 0 ? COLORS.red : COLORS.blue, Math.abs(t));
    }
    img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; img[o + 3] = 255;
  }
  return img;
}

function frame() {
  const { rho, ux, uy } = macros(sim);
  const img = colorImage(cfg.view, rho, ux, uy);
  const parts = Float32Array.from(particles);
  const coef = 2 / (info.u * info.u * info.D);
  const last = forces[forces.length - 1];
  postMessage({
    type: "frame", image: img, nx: sim.nx, ny: sim.ny, step: sim.step, particles: parts,
    cd: last ? last[1] * coef : 0, cl: last ? last[2] * coef : 0, history: forces.slice(-400).map(([s, fx, fy]) => [s, fx * coef, fy * coef]),
    stats: stats(coef),
  }, [img.buffer, parts.buffer]);
}

function stats(coef) {
  const win = cfg.window;
  const warm = sim.step >= info.warmup;
  const recent = warm ? forces.filter(([s]) => s > Math.max(sim.step - win, info.warmup)) : [];
  const n = recent.length || 1;
  const cdAvg = recent.reduce((acc, r) => acc + r[1], 0) / n * coef;
  const clAvg = recent.reduce((acc, r) => acc + r[2], 0) / n * coef;
  const lift = warm ? forces.filter(([s]) => s > Math.max(sim.step - Math.max(win, 20000), info.warmup)).map((r) => r[2]) : [];
  const st = strouhal(lift, LIFT_EVERY, info.D, info.u);
  return { warm, warmup: info.warmup, cdAvg, clAvg, samples: recent.length, St: st.periodic ? st.St : null, periodic: st.periodic, liftAmp: (st.amp || 0) * coef };
}

function runBatch() {
  const t0 = performance.now();
  for (let k = 0; k < batch; k += LIFT_EVERY) {
    stepLbm(sim, LIFT_EVERY);
    forces.push([sim.step, sim.fx, sim.fy]);
  }
  if (forces.length > 20000) forces = forces.slice(-10000);
  const dt = performance.now() - t0;
  batch = Math.max(LIFT_EVERY, Math.min(200, Math.round((batch * TARGET_MS) / Math.max(1, dt) / LIFT_EVERY) * LIFT_EVERY));
  const { ux, uy, rho } = macros(sim);
  for (let c = 0; c < sim.n; c++) {
    if (!(rho[c] > 0.5 && rho[c] < 2)) {
      running = false;
      postMessage({ type: "error", message: "The flow went unstable. Lower the Reynolds number or use a finer grid.", info });
      return false;
    }
  }
  advect(ux, uy, batch);
  return true;
}

async function loop(my) {
  while (running && my === token) {
    if (!runBatch()) return;
    frame();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function paint(cells, value) {
  if (!sim) return;
  for (const c of cells) {
    if (c < 0 || c >= sim.n || sim.mask[c] === 2) continue;
    sim.mask[c] = value ? OBSTACLE : 0;
    const u0 = value ? 0 : info.u;
    for (let q = 0; q < 9; q++) sim.f[q * sim.n + c] = feq(q, 1, u0, 0);
  }
  refreshKinds(sim);
  sim.qw = null;
  const L = Math.max(1, obstacleSize(sim.mask, sim.nx, sim.ny));
  const tau = tauFor(cfg.re, info.u, L);
  info = { ...info, D: L, tau };
  if (tau < TAU_MIN) {
    running = false;
    postMessage({ type: "error", message: `That shape makes τ = ${tau.toFixed(3)}, below ${TAU_MIN}. Lower the Reynolds number.`, info });
    return;
  }
  sim.tau = tau;
  forces = [];
  postMessage({ type: "setup", info, mask: Uint8Array.from(sim.mask) });
  frame();
}

onmessage = (e) => {
  const m = e.data;
  if (m.cmd === "setup") { token++; running = false; setup(m.cfg); }
  else if (m.cmd === "run" && sim) { if (!running) { running = true; loop(++token); } }
  else if (m.cmd === "pause") { running = false; token++; }
  else if (m.cmd === "step" && sim && !running) { if (runBatch()) frame(); }
  else if (m.cmd === "view" && sim) { cfg.view = m.view; cfg.window = m.window ?? cfg.window; frame(); }
  else if (m.cmd === "paint") paint(m.cells, m.value);
};
