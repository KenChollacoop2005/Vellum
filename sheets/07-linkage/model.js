// Four bar and Jansen linkage kinematics
import { luSolve } from "../../core/linalg.js";

const TWO_PI = 2 * Math.PI;
const FD_STEP = 1e-6; // crank angle step for finite difference velocity, rad
const TOUCH_TOL = 1e-12; // tangent circles still assemble

// Intersection of circle (p, r1) and (q, r2), side +1 is left of p to q
export function circleIntersect(p, r1, q, r2, side) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-15 || d > r1 + r2 + TOUCH_TOL * (r1 + r2) || d < Math.abs(r1 - r2) - TOUCH_TOL * (r1 + r2)) return null;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = dx / d, uy = dy / d;
  const mx = p[0] + a * ux, my = p[1] + a * uy;
  return [mx - side * h * uy, my + side * h * ux];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Grashof classification
export function grashof({ ground, crank, coupler, rocker }) {
  const links = [["ground", ground], ["crank", crank], ["coupler", coupler], ["rocker", rocker]];
  const sorted = links.slice().sort((x, y) => x[1] - y[1]);
  const s = sorted[0][1], l = sorted[3][1], pq = sorted[1][1] + sorted[2][1];
  const diff = s + l - pq;
  const tol = 1e-9 * (s + l);
  let type, grash, cls;
  if (Math.abs(diff) <= tol) {
    type = "change point"; grash = true; cls = "Special Grashof (s + l = p + q)";
  } else if (diff < 0) {
    grash = true;
    cls = "Grashof (s + l < p + q)";
    const who = sorted[0][0];
    type = { ground: "double crank", crank: "crank rocker", coupler: "double rocker", rocker: "rocker crank" }[who];
  } else {
    grash = false; type = "triple rocker"; cls = "Non Grashof (s + l > p + q)";
  }
  return { grashof: grash, type, cls, shortest: sorted[0][0], longest: sorted[3][0], s, l, pq };
}

// Four bar position at crank angle
export function branchSide(fb) {
  return fb.branch === "crossed" ? -1 : 1;
}

export function fourBarPosition(fb, theta, side = branchSide(fb)) {
  const O2 = [0, 0], O4 = [fb.ground, 0];
  const A = [fb.crank * Math.cos(theta), fb.crank * Math.sin(theta)];
  const B = circleIntersect(A, fb.coupler, O4, fb.rocker, side);
  if (!B) return null;
  const th3 = Math.atan2(B[1] - A[1], B[0] - A[0]);
  const ang = th3 + (fb.pAngle * Math.PI) / 180;
  const P = [A[0] + fb.pDist * Math.cos(ang), A[1] + fb.pDist * Math.sin(ang)];
  const u = [A[0] - B[0], A[1] - B[1]], v = [O4[0] - B[0], O4[1] - B[1]];
  let mu = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v)))));
  const muRaw = mu;
  if (mu > Math.PI / 2) mu = Math.PI - mu;
  const closure = Math.max(Math.abs(dist(A, B) - fb.coupler), Math.abs(dist(B, O4) - fb.rocker), Math.abs(dist(A, O2) - fb.crank));
  return { O2, O4, A, B, P, mu, muRaw, closure, theta, side };
}

export function couplerVelocity(fb, theta, omega, side = branchSide(fb)) {
  const a = fourBarPosition(fb, theta - FD_STEP, side), b = fourBarPosition(fb, theta + FD_STEP, side);
  if (!a || !b) return null;
  return [((b.P[0] - a.P[0]) / (2 * FD_STEP)) * omega, ((b.P[1] - a.P[1]) / (2 * FD_STEP)) * omega];
}

// Motion cycle: full crank turn, or a rocker swing on one circuit
export function cycleOf(fb) {
  const ranges = feasibleRanges(fb);
  if (ranges.length === 1 && ranges[0][1] - ranges[0][0] >= TWO_PI - 1e-9) return { mode: "crank", ranges, circuits: 2 };
  if (!ranges.length) return { mode: "none", ranges, circuits: 0 };
  const n = ranges.length;
  const circuit = (((fb.circuit ?? 0) % n) + n) % n;
  const [a, b] = ranges[circuit];
  return { mode: "rocker", ranges, circuit, a, b, circuits: n };
}

// Input angle and branch at a phase in [0, 1)
export function cyclePose(fb, cyc, phase) {
  const p = ((phase % 1) + 1) % 1;
  const s0 = branchSide(fb);
  if (cyc.mode === "crank") return { theta: TWO_PI * p, side: s0, half: 0 };
  const w = cyc.b - cyc.a;
  if (p < 0.5) return { theta: cyc.a + (w * (1 - Math.cos(2 * Math.PI * p))) / 2, side: s0, half: 0 };
  return { theta: cyc.b - (w * (1 - Math.cos(Math.PI * (2 * p - 1)))) / 2, side: -s0, half: 1 };
}

export function positionAtPhase(fb, cyc, phase) {
  const { theta, side } = cyclePose(fb, cyc, phase);
  return fourBarPosition(fb, theta, side);
}

// Phase on the current half that matches an input angle
export function phaseForTheta(cyc, theta, half = 0) {
  if (cyc.mode === "crank") return ((theta / TWO_PI) % 1 + 1) % 1;
  const w = cyc.b - cyc.a;
  let t = theta;
  while (t < cyc.a - 1e-12) t += TWO_PI;
  while (t > cyc.b + 1e-12) t -= TWO_PI;
  const f = Math.min(1, Math.max(0, (t - cyc.a) / w));
  const u = Math.acos(1 - 2 * f) / Math.PI;
  return half === 0 ? u / 2 : 0.5 + (1 - u) / 2;
}

// Sweep one full motion cycle
export function fourBarSweep(fb, steps = 720) {
  const cyc = cycleOf(fb);
  const pts = [];
  let maxClosure = 0, muMin = Infinity, muMax = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const p = cyc.mode === "none" ? null : positionAtPhase(fb, cyc, i / steps);
    pts.push(p);
    if (!p) continue;
    maxClosure = Math.max(maxClosure, p.closure);
    muMin = Math.min(muMin, p.mu);
    muMax = Math.max(muMax, p.mu);
  }
  return { pts, maxClosure, muMin, muMax, ranges: cyc.ranges, cycle: cyc, toggles: toggles(fb, cyc) };
}

function assembles(fb, th) {
  const d = Math.hypot(fb.crank * Math.cos(th) - fb.ground, fb.crank * Math.sin(th));
  return d <= fb.coupler + fb.rocker + TOUCH_TOL && d >= Math.abs(fb.coupler - fb.rocker) - TOUCH_TOL;
}

function refine(f, a, b) {
  let fa = f(a);
  for (let i = 0; i < 80; i++) {
    const m = 0.5 * (a + b), fm = f(m);
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
  }
  return 0.5 * (a + b);
}

// Crank angle ranges that assemble, with exact limits
export function feasibleRanges(fb, steps = 3600) {
  const ok = (th) => (assembles(fb, th) ? 1 : -1);
  const limits = [];
  for (let i = 0; i < steps; i++) {
    const a = (TWO_PI * i) / steps, b = (TWO_PI * (i + 1)) / steps;
    if (ok(a) !== ok(b)) limits.push({ at: refine(ok, a, b), entering: ok(b) > 0 });
  }
  if (!limits.length) return ok(0) > 0 ? [[0, TWO_PI]] : [];
  const ranges = [];
  const starts = limits.filter((l) => l.entering).map((l) => l.at);
  const ends = limits.filter((l) => !l.entering).map((l) => l.at);
  for (const s of starts) {
    let e = ends.find((x) => x > s);
    if (e === undefined) e = ends[0] + TWO_PI;
    ranges.push([s, e]);
  }
  return ranges;
}

// Toggle angles: crank and coupler collinear, or coupler and rocker collinear
function toggles(fb, cyc, steps = 3600) {
  const out = [];
  if (cyc.mode === "none") return out;
  const crossCC = (ph) => {
    const p = positionAtPhase(fb, cyc, ph);
    if (!p) return NaN;
    return p.A[0] * (p.B[1] - p.A[1]) - p.A[1] * (p.B[0] - p.A[0]);
  };
  for (let i = 0; i < steps; i++) {
    const a = i / steps, b = (i + 1) / steps;
    const fa = crossCC(a), fb2 = crossCC(b);
    if (Number.isFinite(fa) && Number.isFinite(fb2) && fa * fb2 < 0) {
      const ph = refine(crossCC, a, b);
      out.push({ angle: cyclePose(fb, cyc, ph).theta % TWO_PI, kind: "crank and coupler collinear (rocker at a limit)" });
    }
  }
  if (cyc.mode === "rocker") {
    out.push({ angle: cyc.a % TWO_PI, kind: "coupler and rocker collinear (input reverses)" });
    out.push({ angle: cyc.b % TWO_PI, kind: "coupler and rocker collinear (input reverses)" });
  }
  return out.sort((x, y) => x.angle - y.angle);
}

// Largest jump and closure gap of a sampled closed path
export function pathContinuity(points) {
  let jump = 0;
  for (let i = 1; i < points.length; i++) jump = Math.max(jump, Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const a = points[0], b = points[points.length - 1];
  return { jump, gap: Math.hypot(a[0] - b[0], a[1] - b[1]) };
}

// Jansen leg, lengths a to m, crank center at origin
export const JANSEN_HOLY = { a: 38.0, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4, g: 36.7, h: 65.7, i: 49.0, j: 50.0, k: 61.9, l: 7.8, m: 15.0 };
const JANSEN_SIDES = { C: 1, D: -1, E: 1, F: 1, G: 1 }; // circle branch for each joint

export function jansenPositions(L, theta) {
  const O = [0, 0], B = [-L.a, -L.l];
  const A = [L.m * Math.cos(theta), L.m * Math.sin(theta)];
  const C = circleIntersect(B, L.b, A, L.j, JANSEN_SIDES.C);
  const D = circleIntersect(B, L.c, A, L.k, JANSEN_SIDES.D);
  if (!C || !D) return null;
  const E = circleIntersect(B, L.d, C, L.e, JANSEN_SIDES.E);
  if (!E) return null;
  const F = circleIntersect(D, L.g, E, L.f, JANSEN_SIDES.F);
  if (!F) return null;
  const G = circleIntersect(D, L.i, F, L.h, JANSEN_SIDES.G);
  if (!G) return null;
  return { O, A, B, C, D, E, F, G };
}

const JANSEN_BARS = [["B", "C", "b"], ["A", "C", "j"], ["B", "D", "c"], ["A", "D", "k"], ["B", "E", "d"], ["C", "E", "e"],
  ["E", "F", "f"], ["D", "F", "g"], ["F", "G", "h"], ["D", "G", "i"]];
export const JANSEN_LINKS = [...JANSEN_BARS, ["O", "A", "m"]];

export function jansenClosure(L, p) {
  let worst = Math.abs(dist(p.O, p.A) - L.m);
  for (const [u, v, k] of JANSEN_BARS) worst = Math.max(worst, Math.abs(dist(p[u], p[v]) - L[k]));
  return worst;
}

// Independent check: Newton solve of all ten bar equations
export function jansenNewton(L, theta, start = null) {
  const keys = ["C", "D", "E", "F", "G"];
  const base = start || jansenPositions(L, theta);
  const x = keys.flatMap((k) => [base[k][0] + 0.8, base[k][1] - 0.6]);
  const fixed = { A: [L.m * Math.cos(theta), L.m * Math.sin(theta)], B: [-L.a, -L.l] };
  const get = (k, v) => (fixed[k] || [v[2 * keys.indexOf(k)], v[2 * keys.indexOf(k) + 1]]);
  for (let it = 0; it < 50; it++) {
    const r = JANSEN_BARS.map(([u, w, k]) => {
      const p = get(u, x), q = get(w, x);
      return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 - L[k] ** 2;
    });
    const J = JANSEN_BARS.map(([u, w]) => {
      const row = new Array(10).fill(0);
      const p = get(u, x), q = get(w, x);
      const iu = keys.indexOf(u), iw = keys.indexOf(w);
      if (iu >= 0) { row[2 * iu] += 2 * (p[0] - q[0]); row[2 * iu + 1] += 2 * (p[1] - q[1]); }
      if (iw >= 0) { row[2 * iw] -= 2 * (p[0] - q[0]); row[2 * iw + 1] -= 2 * (p[1] - q[1]); }
      return row;
    });
    const dx = luSolve(J, r.map((v) => -v));
    let step = 0;
    for (let i = 0; i < 10; i++) { x[i] += dx[i]; step = Math.max(step, Math.abs(dx[i])); }
    if (step < 1e-14) break;
  }
  const out = { ...fixed };
  keys.forEach((k, i) => { out[k] = [x[2 * i], x[2 * i + 1]]; });
  return out;
}

// Foot path, gait numbers and closure
export const CONTACT_BAND = 0.02; // fraction of step height counted as ground contact

export function jansenSweep(L, steps = 720) {
  const foot = [];
  let maxClosure = 0, failed = 0;
  for (let i = 0; i <= steps; i++) {
    const p = jansenPositions(L, (TWO_PI * i) / steps);
    if (!p) { failed++; foot.push(null); continue; }
    foot.push(p.G);
    maxClosure = Math.max(maxClosure, jansenClosure(L, p));
  }
  return { foot, maxClosure, failed, gait: gaitOf(foot.slice(0, steps)) };
}

export function gaitOf(foot) {
  const pts = foot.filter(Boolean);
  if (pts.length < 3) return { stride: 0, stepHeight: 0, contactFraction: 0, contactSegments: 0, band: 0 };
  const ys = pts.map((p) => p[1]);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const band = CONTACT_BAND * (ymax - ymin);
  const inContact = foot.map((p) => !!p && p[1] <= ymin + band);
  let segments = 0;
  for (let i = 0; i < inContact.length; i++) {
    const prev = inContact[(i - 1 + inContact.length) % inContact.length];
    if (inContact[i] && !prev) segments++;
  }
  if (segments === 0 && inContact.every(Boolean)) segments = 1;
  const xs = pts.filter((p) => p[1] <= ymin + band).map((p) => p[0]);
  return {
    stride: Math.max(...xs) - Math.min(...xs), stepHeight: ymax - ymin,
    contactFraction: inContact.filter(Boolean).length / inContact.length, contactSegments: segments, band, ymin,
  };
}

export const LINK_PRESETS = {
  crankRocker: { label: "Crank rocker", mode: "fourBar", fourBar: { ground: 7, crank: 2, coupler: 9, rocker: 6, pDist: 6, pAngle: 30, branch: "open", speed: 1 } },
  doubleCrank: { label: "Double crank", mode: "fourBar", fourBar: { ground: 2, crank: 7, coupler: 6, rocker: 9, pDist: 4, pAngle: 40, branch: "open", speed: 1 } },
  doubleRocker: { label: "Double rocker", mode: "fourBar", fourBar: { ground: 7, crank: 6, coupler: 2, rocker: 9, pDist: 3, pAngle: 60, branch: "open", speed: 1 } },
  changePoint: { label: "Change point", mode: "fourBar", fourBar: { ground: 4, crank: 3, coupler: 5, rocker: 4, pDist: 2.5, pAngle: 0, branch: "open", speed: 1 } },
  jansen: { label: "Jansen leg", mode: "jansen", jansen: { ...JANSEN_HOLY } },
  chebyshev: { label: "Chebyshev straight line", mode: "fourBar", fourBar: { ground: 4, crank: 5, coupler: 2, rocker: 5, pDist: 1, pAngle: 0, branch: "crossed", speed: 1, circuit: 0 } },
};
