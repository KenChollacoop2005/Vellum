// Classical laminate theory, units MPa and mm
import { luSolve } from "../../core/linalg.js";

const ZERO_TERM = 1e-9; // relative size treated as zero for warnings

// Material library, moduli and strengths in MPa, ply thickness in mm
export const MATERIALS = {
  t300: { name: "T300/5208", short: "T300", E1: 181000, E2: 10300, G12: 7170, nu12: 0.28, Xt: 1500, Xc: 1500, Yt: 40, Yc: 246, S: 68, t: 0.125, source: "Kaw, Table 2.1 (Tsai and Hahn data)" },
  as4: { name: "AS4/3501-6 (typical)", short: "AS4 (typ.)", E1: 147000, E2: 10300, G12: 7000, nu12: 0.27, Xt: 2280, Xc: 1725, Yt: 57, Yc: 228, S: 76, t: 0.125, source: "typical values after Daniel and Ishai, Appendix A; ply thickness assumed" },
  eglass: { name: "E-glass epoxy (typical)", short: "E-glass (typ.)", E1: 41000, E2: 10400, G12: 4300, nu12: 0.28, Xt: 1140, Xc: 620, Yt: 39, Yc: 128, S: 89, t: 0.125, source: "typical values after Daniel and Ishai, Appendix A; ply thickness assumed" },
  kevlar: { name: "Kevlar 49 epoxy (typical)", short: "Kevlar (typ.)", E1: 80000, E2: 5500, G12: 2200, nu12: 0.34, Xt: 1400, Xc: 335, Yt: 30, Yc: 158, S: 49, t: 0.125, source: "typical values after Daniel and Ishai, Appendix A; ply thickness assumed" },
};

export function reducedQ(m) {
  const nu21 = (m.nu12 * m.E2) / m.E1;
  const d = 1 - m.nu12 * nu21;
  return { Q11: m.E1 / d, Q12: (m.nu12 * m.E2) / d, Q22: m.E2 / d, Q66: m.G12 };
}

// Transformed reduced stiffness, angle in degrees
export function qBar(Q, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const c2 = c * c, s2 = s * s, c4 = c2 * c2, s4 = s2 * s2, cs = c * s;
  const { Q11, Q12, Q22, Q66 } = Q;
  const q11 = Q11 * c4 + 2 * (Q12 + 2 * Q66) * s2 * c2 + Q22 * s4;
  const q12 = (Q11 + Q22 - 4 * Q66) * s2 * c2 + Q12 * (s4 + c4);
  const q22 = Q11 * s4 + 2 * (Q12 + 2 * Q66) * s2 * c2 + Q22 * c4;
  const q16 = (Q11 - Q12 - 2 * Q66) * cs * c2 + (Q12 - Q22 + 2 * Q66) * cs * s2;
  const q26 = (Q11 - Q12 - 2 * Q66) * cs * s2 + (Q12 - Q22 + 2 * Q66) * cs * c2;
  const q66 = (Q11 + Q22 - 2 * Q12 - 2 * Q66) * s2 * c2 + Q66 * (s4 + c4);
  return [[q11, q12, q16], [q12, q22, q26], [q16, q26, q66]];
}

function plyMaterial(p, lib) {
  return lib[p.mat] || MATERIALS[p.mat];
}

export function plyZ(plies, lib = MATERIALS) {
  const h = plies.reduce((s, p) => s + (p.t ?? plyMaterial(p, lib).t), 0);
  const z = [-h / 2];
  for (const p of plies) z.push(z[z.length - 1] + (p.t ?? plyMaterial(p, lib).t));
  return { h, z };
}

export function abd(plies, lib = MATERIALS, rotate = 0) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = A.map((r) => r.slice()), D = A.map((r) => r.slice());
  const { h, z } = plyZ(plies, lib);
  plies.forEach((p, k) => {
    const Qb = qBar(reducedQ(plyMaterial(p, lib)), p.angle + rotate);
    const z0 = z[k], z1 = z[k + 1];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      A[i][j] += Qb[i][j] * (z1 - z0);
      B[i][j] += (Qb[i][j] * (z1 * z1 - z0 * z0)) / 2;
      D[i][j] += (Qb[i][j] * (z1 ** 3 - z0 ** 3)) / 3;
    }
  });
  return { A, B, D, h, z };
}

function inv3(M) {
  const cols = [0, 1, 2].map((j) => luSolve(M, [0, 1, 2].map((i) => (i === j ? 1 : 0))));
  return [0, 1, 2].map((i) => cols.map((c) => c[i]));
}

export function effective(A, h) {
  const a = inv3(A);
  return { Ex: 1 / (h * a[0][0]), Ey: 1 / (h * a[1][1]), Gxy: 1 / (h * a[2][2]), nuxy: -a[0][1] / a[0][0] };
}

// Ex of the laminate rotated by theta degrees
export function laminateEx(plies, theta, lib = MATERIALS) {
  const { A, h } = abd(plies, lib, theta);
  return effective(A, h).Ex;
}

export function plyEx(mat, theta) {
  const t = (theta * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const inv = c ** 4 / mat.E1 + (1 / mat.G12 - (2 * mat.nu12) / mat.E1) * s * s * c * c + s ** 4 / mat.E2;
  return 1 / inv;
}

// Global strains to material axes, engineering shear
function toMaterial(eps, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const [ex, ey, gxy] = eps;
  return [
    ex * c * c + ey * s * s + gxy * c * s,
    ex * s * s + ey * c * c - gxy * c * s,
    2 * (ey - ex) * c * s + gxy * (c * c - s * s),
  ];
}

function maxStressCheck(sig, m) {
  const [s1, s2, t12] = sig;
  const terms = [
    [s1 >= 0 ? s1 / m.Xt : -s1 / m.Xc, s1 >= 0 ? "fiber tension" : "fiber compression"],
    [s2 >= 0 ? s2 / m.Yt : -s2 / m.Yc, s2 >= 0 ? "transverse tension" : "transverse compression"],
    [Math.abs(t12) / m.S, "in plane shear"],
  ];
  let best = terms[0];
  for (const tm of terms) if (tm[0] > best[0]) best = tm;
  return { index: best[0], factor: best[0] > 0 ? 1 / best[0] : Infinity, mode: best[1] };
}

function tsaiWuCheck(sig, m, f12star) {
  const [s1, s2, t12] = sig;
  const F1 = 1 / m.Xt - 1 / m.Xc, F2 = 1 / m.Yt - 1 / m.Yc;
  const F11 = 1 / (m.Xt * m.Xc), F22 = 1 / (m.Yt * m.Yc), F66 = 1 / (m.S * m.S);
  const F12 = f12star * Math.sqrt(F11 * F22);
  const a = F11 * s1 * s1 + F22 * s2 * s2 + F66 * t12 * t12 + 2 * F12 * s1 * s2;
  const b = F1 * s1 + F2 * s2;
  let factor = Infinity;
  if (a > 0) factor = (-b + Math.sqrt(b * b + 4 * a)) / (2 * a);
  else if (b > 0) factor = 1 / b;
  const fiber = Math.abs(F1 * s1 + F11 * s1 * s1), trans = Math.abs(F2 * s2 + F22 * s2 * s2), shear = F66 * t12 * t12;
  let mode = "in plane shear";
  if (fiber >= trans && fiber >= shear) mode = s1 >= 0 ? "fiber tension" : "fiber compression";
  else if (trans >= shear) mode = s2 >= 0 ? "transverse tension" : "transverse compression";
  return { index: Number.isFinite(factor) ? 1 / factor : 0, factor, mode };
}

// Full analysis for a stack and load case
export function analyzeLaminate(plies, load = { N: [0, 0, 0], M: [0, 0, 0] }, f12star = -0.5, lib = MATERIALS) {
  if (!plies.length) return { ok: false, error: "Add at least one ply." };
  const { A, B, D, h, z } = abd(plies, lib);
  const eff = effective(A, h);
  const big = Math.max(...A.flat().map(Math.abs));
  const warnings = [];
  const bmax = Math.max(...B.flat().map(Math.abs));
  if (bmax > ZERO_TERM * big * h) warnings.push("Stack is not symmetric, so stretching and bending are coupled (B is not zero).");
  if (Math.abs(A[0][2]) > ZERO_TERM * big || Math.abs(A[1][2]) > ZERO_TERM * big) warnings.push("A16 or A26 is not zero, so stretching and shear are coupled.");

  const ABD = [
    [...A[0], ...B[0]], [...A[1], ...B[1]], [...A[2], ...B[2]],
    [...B[0], ...D[0]], [...B[1], ...D[1]], [...B[2], ...D[2]],
  ];
  const sol = luSolve(ABD, [...load.N, ...load.M]);
  const eps0 = sol.slice(0, 3), kappa = sol.slice(3);
  const loaded = load.N.some((v) => v !== 0) || load.M.some((v) => v !== 0);

  let msBest = { factor: Infinity }, twBest = { factor: Infinity };
  const plyResults = plies.map((p, k) => {
    const mat = plyMaterial(p, lib);
    const Q = reducedQ(mat);
    const out = { angle: p.angle, mat: p.mat, zBot: z[k], zTop: z[k + 1], points: [] };
    for (const [pos, zz] of [["bottom", z[k]], ["top", z[k + 1]]]) {
      const eg = [0, 1, 2].map((i) => eps0[i] + zz * kappa[i]);
      const em = toMaterial(eg, p.angle);
      const sm = [Q.Q11 * em[0] + Q.Q12 * em[1], Q.Q12 * em[0] + Q.Q22 * em[1], Q.Q66 * em[2]];
      const Qb = qBar(Q, p.angle);
      const sg = [0, 1, 2].map((i) => Qb[i][0] * eg[0] + Qb[i][1] * eg[1] + Qb[i][2] * eg[2]);
      const ms = maxStressCheck(sm, mat), tw = tsaiWuCheck(sm, mat, f12star);
      out.points.push({ pos, z: zz, epsGlobal: eg, epsMat: em, sigMat: sm, sigGlobal: sg, ms, tw });
      if (loaded && ms.factor < msBest.factor - 1e-12) msBest = { ...ms, ply: k, pos };
      if (loaded && tw.factor < twBest.factor - 1e-12) twBest = { ...tw, ply: k, pos };
    }
    out.fiMS = Math.max(...out.points.map((q) => q.ms.index));
    out.fiTW = Math.max(...out.points.map((q) => q.tw.index));
    return out;
  });

  return { ok: true, A, B, D, h, z, ...eff, warnings, eps0, kappa, plies: plyResults, fpf: { maxStress: msBest, tsaiWu: twBest }, loaded };
}

// Layup notation parser, plies listed from ply 1 at the bottom
export function parseLayup(code) {
  const s = code.replace(/\s+/g, "").replace(/°/g, "").replace(/\+-|\+\/-/g, "±").replace(/-\+|-\/\+/g, "∓");
  const m = s.match(/^\[([^\]]+)\](\d*)(s?)$/i);
  if (!m) throw new Error("Use notation like [0/±45/90]s or [0/90]2s.");
  const tokens = m[1].split("/");
  let base = [];
  for (const tok of tokens) {
    const tm = tok.match(/^([±∓]?)(-?\d+(?:\.\d+)?)(?:_(\d+))?$/);
    if (!tm) throw new Error(`Could not read the ply "${tok}".`);
    const ang = Number(tm[2]);
    const rep = tm[3] ? Number(tm[3]) : 1;
    let group = [ang];
    if (tm[1] === "±") group = [ang, -ang];
    if (tm[1] === "∓") group = [-ang, ang];
    for (let r = 0; r < rep; r++) base = base.concat(group);
  }
  const n = m[2] ? Number(m[2]) : 1;
  if (!(n >= 1 && n <= 20)) throw new Error("Repeat count must be between 1 and 20.");
  let out = [];
  for (let r = 0; r < n; r++) out = out.concat(base);
  if (m[3]) out = out.concat(out.slice().reverse());
  if (out.length > 64) throw new Error("That stack has more than 64 plies.");
  return out.map((a) => (Object.is(a, -0) ? 0 : a));
}

function groupPm(angles) {
  const out = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i], b = angles[i + 1];
    if (b !== undefined && a !== 0 && b === -a && Math.abs(a) !== 90) {
      out.push(a > 0 ? `±${a}` : `∓${-a}`);
      i++;
    } else out.push(String(a));
  }
  return out.join("/");
}

function smallestRepeat(arr) {
  for (let len = 1; len <= arr.length / 2; len++) {
    if (arr.length % len) continue;
    let ok = true;
    for (let i = len; i < arr.length && ok; i++) if (arr[i] !== arr[i % len]) ok = false;
    if (ok) return { block: arr.slice(0, len), n: arr.length / len };
  }
  return { block: arr, n: 1 };
}

export function layupCode(angles) {
  if (!angles.length) return "[]";
  const n = angles.length;
  const sym = n % 2 === 0 && angles.every((a, i) => a === angles[n - 1 - i]);
  const core = sym ? angles.slice(0, n / 2) : angles;
  const { block, n: rep } = smallestRepeat(core);
  return `[${groupPm(block)}]${rep > 1 ? rep : ""}${sym ? "s" : ""}`;
}

export const LAM_PRESETS = {
  quasi: { label: "Quasi isotropic", code: "[0/45/-45/90]s", mat: "t300" },
  cross: { label: "Cross ply", code: "[0/90]s", mat: "t300" },
  angle: { label: "Angle ply ±45", code: "[±45]s", mat: "t300" },
  unsym: { label: "Unsymmetric [0/90]", code: "[0/90]", mat: "t300" },
  fairing: { label: "Bike fairing (example)", code: "[0/90/±45]s", mat: "as4" },
};
