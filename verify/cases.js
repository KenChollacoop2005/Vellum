// Verification cases, single source of truth
import { solveStructure, beamModel, randomStableStructure, equilibriumResidual } from "../sheets/01-frame/model.js";
import { solveBeam } from "../sheets/02-beam-mohr/model.js";
import { principal, transformStress } from "../sheets/02-beam-mohr/model.js";
import { MATERIALS, reducedQ, analyzeLaminate, laminateEx, parseLayup } from "../sheets/05-laminate/model.js";
import { chainMatrices, modes, peakAmplification, closedFormChain, orthonormalityError, VIB_PRESETS } from "../sheets/06-vibrations/model.js";
import { mbbProblem, runOptimizer, keMatrix } from "../sheets/03-topology/model.js";
import { q4KE } from "../core/fem.js";
import { runSchaferTurek, poiseuilleError, massDrift, runShedding } from "../sheets/04-wind-tunnel/model.js";
import { makeRng } from "../core/rng.js";
import { grashof, fourBarSweep, jansenSweep, jansenPositions, jansenNewton, JANSEN_HOLY, LINK_PRESETS, cycleOf, positionAtPhase, pathContinuity } from "../sheets/07-linkage/model.js";

const GPA = 1e9, KN = 1e3, MM = 1e-3;
const REL = 1e-3; // frame tolerance, 0.1 percent
const HIBBELER_MOM = { label: "Hibbeler, Mechanics of Materials, beam deflection table", url: "https://github.com/KenChollacoop2005/Vellum/blob/main/docs/references.md#sheet-02-beam-diagrams-and-mohrs-circle" };
const KASSIMALI = { label: "Kassimali, Matrix Analysis of Structures", url: "https://github.com/KenChollacoop2005/Vellum/blob/main/docs/references.md#sheet-01-frame-and-truss" };
const MOHR = { label: "Hibbeler, Mechanics of Materials, plane stress transformation", url: "https://github.com/KenChollacoop2005/Vellum/blob/main/docs/references.md#sheet-02-beam-diagrams-and-mohrs-circle" };
const REFS = "https://github.com/KenChollacoop2005/Vellum/blob/main/docs/references.md";
const KAW = { label: "Kaw, Mechanics of Composite Materials, Table 2.1 data and CLT", url: `${REFS}#sheet-05-laminate` };
const INMAN = { label: "Inman, Engineering Vibration, chain and SDOF results", url: `${REFS}#sheet-06-vibrations` };
const NORTON = { label: "Norton, Design of Machinery, Grashof and position analysis", url: `${REFS}#sheet-07-linkage` };
const JANSEN = { label: "Jansen holy numbers, construction by circle intersections", url: `${REFS}#sheet-07-linkage` };
const TOP88 = { label: "Andreassen et al. 2011, top88 (Struct Multidisc Optim 43)", url: "https://doi.org/10.1007/s00158-010-0594-7" };
const memo = new Map();
async function mbbRun(ft, onProgress) {
  if (!memo.has(ft)) memo.set(ft, await runOptimizer(mbbProblem({ nelx: 60, nely: 20, volfrac: 0.5, penal: 3, rmin: 1.5, ft }), { onProgress }));
  return memo.get(ft);
}
const TUREK = { label: "Schäfer and Turek 1996, DFG benchmark 2D-1", url: "http://www.featflow.de/en/benchmarks/cfdbenchmarking/flow/dfg_benchmark1_re20.html" };
const KRUGER = { label: "Krüger et al., The Lattice Boltzmann Method (2017)", url: "https://doi.org/10.1007/978-3-319-44649-3" };
const WILLIAMSON = { label: "Williamson 1996, Vortex dynamics in the cylinder wake", url: "https://doi.org/10.1146/annurev.fl.28.010196.002401" };
const JOINTS = { label: "Method of joints, hand calculation", url: "https://github.com/KenChollacoop2005/Vellum/blob/main/docs/references.md#sheet-01-frame-and-truss" };

const rel = (quantity, expected, computed, unit, tol = REL) => ({ quantity, expected, computed, unit, tol, kind: "rel" });

function solved(model) {
  const r = solveStructure(model);
  if (!r.ok) throw new Error(r.error);
  return r;
}

// F1 cantilever with 1 and 10 elements
function f1(nEl) {
  const L = 2, P = 10 * KN, E = 200 * GPA, I = 8e-6;
  const m = beamModel({ L, n: nEl, E, A: 1e-2, I, supports: { 0: "fixed" }, loads: { [nEl]: { fy: -P } } });
  const r = solved(m);
  const tip = r.disp[nEl], root = r.reactions.find((x) => x.node === 0);
  return [
    rel(`tip deflection, ${nEl} el`, 16.667, -tip.uy / MM, "mm"),
    rel(`tip rotation, ${nEl} el`, 0.0125, -tip.rz, "rad"),
    rel(`root moment, ${nEl} el`, 20.0, Math.abs(root.mz) / KN, "kN·m"),
    rel(`root shear, ${nEl} el`, 10.0, Math.abs(root.ry) / KN, "kN"),
  ];
}

export const cases = [
  {
    id: "F1", sheet: "01", description: "Cantilever, point load at tip", source: HIBBELER_MOM,
    run: async () => [...f1(1), ...f1(10)],
  },
  {
    id: "F2", sheet: "01", description: "Simply supported beam, uniform load, 8 elements", source: HIBBELER_MOM,
    run: async () => {
      const m = beamModel({ L: 4, n: 8, E: 200 * GPA, A: 1e-2, I: 8e-6, supports: { 0: "pin", 8: "rollerX" }, w: -5 * KN });
      const r = solved(m);
      return [
        rel("midspan deflection", 10.417, -r.disp[4].uy / MM, "mm"),
        rel("max moment", 10.0, r.maxMoment.value / KN, "kN·m"),
        rel("left reaction", 10.0, r.reactions.find((x) => x.node === 0).ry / KN, "kN"),
        rel("right reaction", 10.0, r.reactions.find((x) => x.node === 8).ry / KN, "kN"),
      ];
    },
  },
  {
    id: "F3", sheet: "01", description: "Propped cantilever, uniform load", source: HIBBELER_MOM,
    run: async () => {
      const m = beamModel({ L: 4, n: 8, E: 200 * GPA, A: 1e-2, I: 8e-6, supports: { 0: "fixed", 8: "rollerX" }, w: -5 * KN });
      const r = solved(m);
      const fix = r.reactions.find((x) => x.node === 0), rol = r.reactions.find((x) => x.node === 8);
      return [
        rel("roller reaction", 7.5, rol.ry / KN, "kN"),
        rel("fixed reaction", 12.5, fix.ry / KN, "kN"),
        rel("fixed end moment", 10.0, Math.abs(fix.mz) / KN, "kN·m"),
        rel("max positive moment", 5.625, r.maxPositiveMoment / KN, "kN·m"),
      ];
    },
  },
  {
    id: "F4", sheet: "01", description: "Triangle truss, 10 kN at apex", source: JOINTS,
    run: async () => {
      const EA = { E: 200 * GPA, A: 1000 * 1e-6, I: 0 };
      const m = {
        nodes: [
          { x: 0, y: 0, support: "pin" },
          { x: 4, y: 0, support: "rollerX" },
          { x: 2, y: 3, fy: -10 * KN },
        ],
        members: [
          { a: 0, b: 1, type: "truss", ...EA },
          { a: 0, b: 2, type: "truss", ...EA },
          { a: 1, b: 2, type: "truss", ...EA },
        ],
      };
      const r = solved(m);
      return [
        rel("AB axial", 3.333, r.members[0].N / KN, "kN"),
        rel("AC axial", -6.009, r.members[1].N / KN, "kN"),
        rel("BC axial", -6.009, r.members[2].N / KN, "kN"),
        { ...rel("C displacement x", 1 / 30, r.disp[2].ux / MM, "mm"), note: "Exact hand value 1/30 mm. The spec rounds it to 0.0333." },
        rel("C displacement y", -0.1524, r.disp[2].uy / MM, "mm"),
      ];
    },
  },
  {
    id: "F5", sheet: "01", description: "Pratt truss, 20 kN at L1 and L2", source: JOINTS,
    run: async () => {
      const EA = { E: 200 * GPA, A: 2000 * 1e-6, I: 0, type: "truss" };
      const names = ["L0", "L1", "L2", "L3", "U1", "U2"];
      const m = {
        nodes: [
          { x: 0, y: 0, support: "pin" }, { x: 3, y: 0, fy: -20 * KN }, { x: 6, y: 0, fy: -20 * KN },
          { x: 9, y: 0, support: "rollerX" }, { x: 3, y: 3 }, { x: 6, y: 3 },
        ],
        members: [[0, 1], [1, 2], [2, 3], [4, 5], [0, 4], [1, 4], [1, 5], [2, 5], [5, 3]].map(([a, b]) => ({ a, b, ...EA })),
      };
      const r = solved(m);
      const N = (i) => r.members[i].N / KN;
      const label = (i) => names[m.members[i].a] + names[m.members[i].b];
      const expected = [20, 20, 20, -20, -28.284, 20, 0, 20, -28.284];
      return [
        ...expected.map((e, i) => rel(`${label(i)} axial`, e, N(i), "kN")),
        rel("L0 reaction", 20, r.reactions.find((x) => x.node === 0).ry / KN, "kN"),
        rel("L3 reaction", 20, r.reactions.find((x) => x.node === 3).ry / KN, "kN"),
        rel("L1 displacement x", 0.150, r.disp[1].ux / MM, "mm"),
        rel("L1 displacement y", -0.824, r.disp[1].uy / MM, "mm"),
      ];
    },
  },
  {
    id: "F6", sheet: "01", description: "Equilibrium of 20 random stable structures (seeded)", source: KASSIMALI,
    run: async () => {
      let worst = 0;
      for (let k = 0; k < 20; k++) {
        const m = randomStableStructure(1000 + k);
        worst = Math.max(worst, equilibriumResidual(m, solved(m)));
      }
      return [{ quantity: "max relative residual", expected: 0, computed: worst, unit: "", tol: 1e-9, kind: "max" }];
    },
  },
  {
    id: "B1", sheet: "02", description: "Beam: cantilever, 10 kN at tip (F1 values)", source: HIBBELER_MOM,
    run: async () => {
      const r = solveBeam({ L: 2, support: "cantilever", E: 200 * GPA, I: 8e-6, loads: [{ type: "point", x: 2, P: 10 * KN }] });
      return [
        rel("tip deflection", 16.667, -r.deflectionAt(2) / MM, "mm"),
        rel("root moment", 20.0, Math.abs(r.momentAt(0)) / KN, "kN·m"),
        rel("root shear", 10.0, Math.abs(r.shearAt(1e-9)) / KN, "kN"),
        { quantity: "FE vs statics moment gap, relative", expected: 0, computed: r.feStaticsGap / (r.maxMoment.value / KN), unit: "", tol: 1e-6, kind: "max" },
      ];
    },
  },
  {
    id: "B2", sheet: "02", description: "Beam: simply supported, 5 kN/m (F2 values)", source: HIBBELER_MOM,
    run: async () => {
      const r = solveBeam({ L: 4, support: "simply", E: 200 * GPA, I: 8e-6, loads: [{ type: "dist", x1: 0, x2: 4, q1: 5 * KN, q2: 5 * KN }] });
      return [
        rel("midspan deflection", 10.417, -r.deflectionAt(2) / MM, "mm"),
        rel("max moment", 10.0, r.maxMoment.value / KN, "kN·m"),
        rel("left reaction", 10.0, r.reactions[0].R / KN, "kN"),
        rel("right reaction", 10.0, r.reactions[1].R / KN, "kN"),
        rel("max deflection", 10.417, r.maxDeflection.value / MM, "mm"),
      ];
    },
  },
  {
    id: "B3", sheet: "02", description: "Beam: propped cantilever, 5 kN/m (F3 values)", source: HIBBELER_MOM,
    run: async () => {
      const r = solveBeam({ L: 4, support: "propped", E: 200 * GPA, I: 8e-6, loads: [{ type: "dist", x1: 0, x2: 4, q1: 5 * KN, q2: 5 * KN }] });
      return [
        rel("roller reaction", 7.5, r.reactions[1].R / KN, "kN"),
        rel("fixed reaction", 12.5, r.reactions[0].R / KN, "kN"),
        rel("fixed end moment", 10.0, Math.abs(r.momentAt(0)) / KN, "kN·m"),
        rel("max positive moment", 5.625, r.maxPositiveMoment / KN, "kN·m"),
      ];
    },
  },
  {
    id: "B4", sheet: "02", description: "Beam: fixed fixed, 5 kN/m over 4 m", source: HIBBELER_MOM,
    run: async () => {
      const r = solveBeam({ L: 4, support: "fixedFixed", E: 200 * GPA, I: 8e-6, loads: [{ type: "dist", x1: 0, x2: 4, q1: 5 * KN, q2: 5 * KN }] });
      return [
        rel("end moment (hogging)", -6.667, r.momentAt(0) / KN, "kN·m"),
        rel("midspan moment", 3.333, r.momentAt(2) / KN, "kN·m"),
        rel("midspan deflection", 2.083, -r.deflectionAt(2) / MM, "mm"),
        { quantity: "FE vs statics moment gap, relative", expected: 0, computed: r.feStaticsGap / (r.maxMoment.value / KN), unit: "", tol: 1e-6, kind: "max" },
      ];
    },
  },
  {
    id: "M1", sheet: "02", description: "Mohr's circle, σx 80, σy -40, τxy 30 MPa", source: MOHR,
    run: async () => {
      const p = principal(80, -40, 30);
      const rot = transformStress(80, -40, 30, p.thetaP);
      return [
        rel("σ1", 87.082, p.s1, "MPa"),
        rel("σ2", -47.082, p.s2, "MPa"),
        rel("τmax in plane", 67.082, p.tauMax, "MPa"),
        rel("θp", 13.283, (p.thetaP * 180) / Math.PI, "deg"),
        rel("τx'y' at θp", 0, rot.txy, "MPa"),
        rel("σx' at θp equals σ1", 87.082, rot.sx, "MPa"),
        rel("absolute max shear", 67.082, p.tauAbs, "MPa"),
      ];
    },
  },
  {
    id: "L1", sheet: "05", description: "Reduced stiffness Q of T300/5208", source: KAW,
    run: async () => {
      const Q = reducedQ(MATERIALS.t300);
      return [
        rel("Q11", 181.81, Q.Q11 / 1e3, "GPa"),
        rel("Q12", 2.897, Q.Q12 / 1e3, "GPa"),
        rel("Q22", 10.346, Q.Q22 / 1e3, "GPa"),
        rel("Q66", 7.17, Q.Q66 / 1e3, "GPa"),
      ];
    },
  },
  {
    id: "L2", sheet: "05", description: "Quasi isotropic [0/45/-45/90]s, T300/5208", source: KAW,
    run: async () => {
      const plies = parseLayup("[0/45/-45/90]s").map((a) => ({ angle: a, mat: "t300" }));
      const r = analyzeLaminate(plies);
      const ex = [0, 22.5, 30, 60].map((t) => laminateEx(plies, t));
      const spread = Math.max(...ex.map((e) => Math.abs(e - ex[0]) / ex[0]));
      const bmax = Math.max(...r.B.flat().map(Math.abs));
      return [
        rel("A11", 76.368, r.A[0][0] / 1e3, "MN/m"),
        rel("A22", 76.368, r.A[1][1] / 1e3, "MN/m"),
        rel("A12", 22.607, r.A[0][1] / 1e3, "MN/m"),
        rel("A66", 26.880, r.A[2][2] / 1e3, "MN/m"),
        { ...rel("A16", 0, r.A[0][2] / 1e3, "MN/m"), absTol: 1e-9 },
        { ...rel("A26", 0, r.A[1][2] / 1e3, "MN/m"), absTol: 1e-9 },
        { quantity: "max |B|", expected: 0, computed: bmax, unit: "N", tol: 1e-9, kind: "max" },
        rel("Ex", 69.676, r.Ex / 1e3, "GPa"),
        rel("Ey", 69.676, r.Ey / 1e3, "GPa"),
        rel("Gxy", 26.880, r.Gxy / 1e3, "GPa"),
        rel("νxy", 0.2960, r.nuxy, ""),
        { quantity: "Ex(θ) spread at 0, 22.5, 30, 60°", expected: 0, computed: spread, unit: "", tol: 1e-9, kind: "max" },
      ];
    },
  },
  {
    id: "L3", sheet: "05", description: "Cross ply [0/90]s, T300/5208", source: KAW,
    run: async () => {
      const r = analyzeLaminate(parseLayup("[0/90]s").map((a) => ({ angle: a, mat: "t300" })));
      return [
        rel("Ex", 95.991, r.Ex / 1e3, "GPa"),
        rel("Ey", 95.991, r.Ey / 1e3, "GPa"),
        rel("Gxy", 7.17, r.Gxy / 1e3, "GPa"),
        rel("νxy", 0.03015, r.nuxy, ""),
        { quantity: "max |B|", expected: 0, computed: Math.max(...r.B.flat().map(Math.abs)), unit: "N", tol: 1e-9, kind: "max" },
      ];
    },
  },
  {
    id: "L4", sheet: "05", description: "Unsymmetric [0/90], 0° ply at bottom", source: KAW,
    run: async () => {
      const r = analyzeLaminate([{ angle: 0, mat: "t300" }, { angle: 90, mat: "t300" }]);
      const others = [r.B[0][1], r.B[0][2], r.B[1][2], r.B[2][2]].map(Math.abs);
      return [
        rel("B11", -1339.6, r.B[0][0], "N"),
        rel("B22", 1339.6, r.B[1][1], "N"),
        { quantity: "other B terms", expected: 0, computed: Math.max(...others), unit: "N", tol: 1e-9, kind: "max" },
        { quantity: "coupling warning shown", expected: true, computed: r.warnings.some((w) => /not symmetric/.test(w)), unit: "", kind: "bool" },
      ];
    },
  },
  {
    id: "L5", sheet: "05", description: "Angle ply [±45]s, T300/5208", source: KAW,
    run: async () => {
      const r = analyzeLaminate(parseLayup("[±45]s").map((a) => ({ angle: a, mat: "t300" })));
      return [
        rel("Ex", 25.051, r.Ex / 1e3, "GPa"),
        rel("Gxy", 46.591, r.Gxy / 1e3, "GPa"),
        rel("νxy", 0.7469, r.nuxy, ""),
      ];
    },
  },
  {
    id: "L6", sheet: "05", description: "First ply failure of [0/90]s under Nx", source: KAW,
    run: async () => {
      const r = analyzeLaminate(parseLayup("[0/90]s").map((a) => ({ angle: a, mat: "t300" })), { N: [1, 0, 0], M: [0, 0, 0] }, -0.5);
      const ms = r.fpf.maxStress, tw = r.fpf.tsaiWu;
      return [
        rel("Max Stress Nx at FPF", 187.14, ms.factor, "kN/m"),
        rel("Tsai Wu Nx at FPF", 186.70, tw.factor, "kN/m"),
        { quantity: "Max Stress ply angle", expected: 90, computed: r.plies[ms.ply].angle, unit: "deg", kind: "bool" },
        { quantity: "Max Stress mode", expected: "transverse tension", computed: ms.mode, unit: "", kind: "bool" },
        { quantity: "Tsai Wu ply angle", expected: 90, computed: r.plies[tw.ply].angle, unit: "deg", kind: "bool" },
      ];
    },
  },
  {
    id: "V1", sheet: "06", description: "Three 1 kg masses, four 1000 N/m springs, fixed fixed", source: INMAN,
    run: async () => {
      const md = modes(chainMatrices({ masses: [1, 1, 1], springs: [1000, 1000, 1000, 1000], ends: "fixed-fixed" }));
      let worst = 0;
      for (let n = 1; n <= 8; n++) {
        const w = modes(chainMatrices({ masses: Array(n).fill(1), springs: Array(n + 1).fill(1000), ends: "fixed-fixed" })).omega;
        const ref = closedFormChain(n, 1000, 1);
        for (let j = 0; j < n; j++) worst = Math.max(worst, Math.abs(w[j] - ref[j]) / ref[j]);
      }
      return [
        rel("ω1", 24.203, md.omega[0], "rad/s"),
        rel("ω2", 44.721, md.omega[1], "rad/s"),
        rel("ω3", 58.431, md.omega[2], "rad/s"),
        rel("f1", 3.852, md.omega[0] / (2 * Math.PI), "Hz"),
        rel("f2", 7.118, md.omega[1] / (2 * Math.PI), "Hz"),
        rel("f3", 9.300, md.omega[2] / (2 * Math.PI), "Hz"),
        { quantity: "closed form, n = 1 to 8, worst", expected: 0, computed: worst, unit: "", tol: 1e-9, kind: "max" },
      ];
    },
  },
  {
    id: "V2", sheet: "06", description: "Two DOF fixed free, 1 kg and 1000 N/m each", source: INMAN,
    run: async () => {
      const md = modes(chainMatrices({ masses: [1, 1], springs: [1000, 1000], ends: "fixed-free" }));
      return [rel("ω1", 19.544, md.omega[0], "rad/s"), rel("ω2", 51.167, md.omega[1], "rad/s")];
    },
  },
  {
    id: "V3", sheet: "06", description: "Single DOF, ζ = 0.05, peak amplification", source: INMAN,
    run: async () => {
      const z = 0.05, k = 1000, m = 1;
      const pk = peakAmplification({ masses: [m], springs: [k], dampers: [2 * z * Math.sqrt(k * m)], ends: "fixed-free" });
      return [
        rel("peak amplification", 1 / (2 * z * Math.sqrt(1 - z * z)), pk.amplification, ""),
        rel("frequency ratio at peak", Math.sqrt(1 - 2 * z * z), pk.ratio, ""),
      ];
    },
  },
  {
    id: "V4", sheet: "06", description: "Mode shapes are mass orthonormal, all presets", source: INMAN,
    run: async () => {
      let worst = 0;
      for (const p of Object.values(VIB_PRESETS)) {
        const sys = chainMatrices(p);
        worst = Math.max(worst, orthonormalityError(sys, modes(sys)));
      }
      return [{ quantity: "max |ΦᵀMΦ − I|", expected: 0, computed: worst, unit: "", tol: 1e-9, kind: "max" }];
    },
  },
  {
    id: "K1", sheet: "07", description: "Loop closure at every solved crank angle, all presets", source: NORTON,
    run: async () => {
      const rows = [];
      for (const [key, p] of Object.entries(LINK_PRESETS)) {
        const sweep = p.mode === "jansen" ? jansenSweep(p.jansen, 720) : fourBarSweep(p.fourBar, 720);
        rows.push({ quantity: `${p.label}, max closure error`, expected: 0, computed: sweep.maxClosure, unit: "", tol: 1e-9, kind: "max", key });
      }
      return rows;
    },
  },
  {
    id: "K2", sheet: "07", description: "Grashof classification", source: NORTON,
    run: async () => {
      const a = grashof({ ground: 7, crank: 2, coupler: 9, rocker: 6 });
      const b = grashof({ ground: 4, crank: 3, coupler: 5, rocker: 4 });
      return [
        { quantity: "(7, 2, 9, 6) type", expected: "crank rocker", computed: a.type, unit: "", kind: "bool" },
        { quantity: "(7, 2, 9, 6) shortest", expected: "crank", computed: a.shortest, unit: "", kind: "bool" },
        { quantity: "(7, 2, 9, 6) Grashof", expected: true, computed: a.grashof, unit: "", kind: "bool" },
        { quantity: "(4, 3, 5, 4) type", expected: "change point", computed: b.type, unit: "", kind: "bool" },
      ];
    },
  },
  {
    id: "K3", sheet: "07", description: "Jansen leg with the holy numbers", source: JANSEN,
    run: async () => {
      const sw = jansenSweep(JANSEN_HOLY, 720);
      const first = sw.foot[0], last = jansenPositions(JANSEN_HOLY, 2 * Math.PI).G;
      const a = jansenPositions(JANSEN_HOLY, 0), b = jansenNewton(JANSEN_HOLY, 0);
      let gap = 0;
      for (const k of ["C", "D", "E", "F", "G"]) gap = Math.max(gap, Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]));
      return [
        { quantity: "foot path returns after 360°", expected: 0, computed: Math.hypot(last[0] - first[0], last[1] - first[1]), unit: "", tol: 1e-9, kind: "max" },
        { quantity: "flat low segments", expected: 1, computed: sw.gait.contactSegments, unit: "", kind: "bool" },
        { quantity: "stride (reported)", expected: "", computed: sw.gait.stride, unit: "", kind: "info" },
        { quantity: "joints at 0°, circle vs Newton solve", expected: 0, computed: gap, unit: "", tol: 1e-9, kind: "max" },
      ];
    },
  },
  {
    id: "T1", sheet: "03", slow: true, description: "MBB 60x20, sensitivity filter (ft = 1)", source: TOP88,
    run: async (onProgress) => {
      const r = await mbbRun(1, onProgress);
      return [
        { ...rel("final compliance", 203.19, r.history[r.history.length - 1].c, "", 5e-3), note: "Independent top88 port reports 203.19." },
        { quantity: "iterations", expected: [91, 97], computed: r.loop, unit: "", kind: "range", note: "94 ± 3" },
        { quantity: "converged", expected: true, computed: r.converged, unit: "", kind: "bool" },
      ];
    },
  },
  {
    id: "T2", sheet: "03", slow: true, description: "MBB 60x20, density filter (ft = 2)", source: TOP88,
    run: async (onProgress) => {
      const r = await mbbRun(2, onProgress);
      return [
        { quantity: "converged", expected: true, computed: r.converged, unit: "", kind: "bool" },
        { quantity: "final compliance (recorded)", expected: "", computed: r.history[r.history.length - 1].c, unit: "", kind: "info" },
        { quantity: "iterations (recorded)", expected: "", computed: r.loop, unit: "", kind: "info" },
        { quantity: "gray elements, Mnd (recorded)", expected: "", computed: r.nonDiscreteness, unit: "%", kind: "info" },
      ];
    },
  },
  {
    id: "T3", sheet: "03", description: "Q4 element stiffness KE matches the paper", source: TOP88,
    run: async () => {
      const a = keMatrix(0.3), b = q4KE(0.3);
      let gap = 0;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) gap = Math.max(gap, Math.abs(a[i * 8 + j] - b[i][j]));
      return [{ quantity: "max |KE − paper KE|", expected: 0, computed: gap, unit: "", tol: 1e-12, kind: "max" }];
    },
  },
  {
    id: "T4", sheet: "03", slow: true, description: "Volume constraint at every iteration (T1 run)", source: TOP88,
    run: async (onProgress) => {
      const r = await mbbRun(1, onProgress);
      const worst = Math.max(...r.history.map((h) => Math.abs(h.vol - 0.5)));
      return [{ quantity: "max |volume − 0.5|", expected: 0, computed: worst, unit: "", tol: 1e-3, kind: "max" }];
    },
  },
  {
    id: "W1", sheet: "04", slow: true, nodeSlow: true, description: "Schäfer and Turek 2D-1, Re = 20, 20 cells per diameter", source: TUREK,
    run: async (onProgress) => {
      const r = await runSchaferTurek({ d: 20, onProgress });
      return [
        { quantity: "Cd", expected: [5.5, 5.8], computed: r.cd, unit: "", kind: "range", note: "Reference 5.5795. Peak lattice inlet speed 0.05, TRT." },
        { quantity: "Cl (reported)", expected: "", computed: r.cl, unit: "", kind: "info", note: "Reference 0.0106" },
        { quantity: "Δp front to back (reported)", expected: "", computed: r.dp, unit: "", kind: "info", note: "Reference 0.1175" },
        { quantity: "steps to steady state", expected: "", computed: r.steps, unit: "", kind: "info" },
      ];
    },
  },
  {
    id: "W2", sheet: "04", description: "Poiseuille channel, developed profile vs parabola", source: KRUGER,
    run: async () => [{ quantity: "max error / centerline speed", expected: 0, computed: poiseuilleError(), unit: "", tol: 0.01, kind: "max" }],
  },
  {
    id: "W3", sheet: "04", slow: true, nodeSlow: true, description: "Cylinder, Re = 100, open mode, blockage 1/12", source: WILLIAMSON,
    run: async (onProgress) => {
      const r = await runShedding({ onProgress });
      return [
        { quantity: "periodic shedding", expected: true, computed: !!r.periodic, unit: "", kind: "bool" },
        { quantity: "Strouhal number", expected: [0.15, 0.18], computed: r.St ?? NaN, unit: "", kind: "range", note: "Blockage D/H = 1/12, periodic top and bottom, 16 cells per D, inlet speed 0.05" },
      ];
    },
  },
  {
    id: "W4", sheet: "04", description: "Mass drift over 10,000 steps, closed periodic box", source: KRUGER,
    run: async () => [{ quantity: "relative mass drift", expected: 0, computed: massDrift(makeRng(2024), 10000, 32), unit: "", tol: 1e-6, kind: "max" }],
  },
  {
    id: "K4", sheet: "07", description: "One full motion cycle is continuous and closed, all presets", source: NORTON,
    run: async () => {
      const rows = [];
      for (const p of Object.values(LINK_PRESETS)) {
        let path, longest;
        if (p.mode === "jansen") {
          path = jansenSweep(p.jansen, 1000).foot;
          longest = Math.max(...Object.values(p.jansen));
        } else {
          path = fourBarSweep(p.fourBar, 1000).pts.map((q) => (q ? q.P : [NaN, NaN]));
          longest = Math.max(p.fourBar.ground, p.fourBar.crank, p.fourBar.coupler, p.fourBar.rocker);
        }
        const { jump, gap } = pathContinuity(path);
        rows.push({ quantity: `${p.label}, largest step / longest link`, expected: 0, computed: jump / longest, unit: "", tol: 0.02, kind: "max" });
        rows.push({ quantity: `${p.label}, closure gap`, expected: 0, computed: gap, unit: "", tol: 1e-9, kind: "max" });
      }
      return rows;
    },
  },
  {
    id: "K5", sheet: "07", description: "Chebyshev straight line linkage, crossed, P at coupler midpoint", source: { label: "Closed form circle limits; flat line checked against a separate quadratic solution", url: `${REFS}#sheet-07-linkage` },
    run: async () => {
      const fb = LINK_PRESETS.chebyshev.fourBar;
      const cyc = cycleOf(fb);
      const halves = [[], []];
      for (let i = 0; i <= 4000; i++) {
        const ph = i / 4000;
        halves[ph < 0.5 ? 0 : 1].push(positionAtPhase(fb, cyc, ph).P);
      }
      const flatErr = (pts) => Math.max(...pts.filter(([x]) => x >= 0 && x <= 3.9).map(([, y]) => Math.abs(y - 4)));
      const [e0, e1] = halves.map(flatErr);
      const flat = e0 < e1 ? 0 : 1;
      const top = Math.max(...halves[1 - flat].map(([, y]) => y));
      return [
        { quantity: "input lower limit", expected: 0.6435, computed: cyc.a, unit: "rad", tol: 5e-5, kind: "abs" },
        { quantity: "input upper limit", expected: 1.7722, computed: cyc.b, unit: "rad", tol: 5e-5, kind: "abs" },
        { quantity: "flat half, max |y − 4| for x from 0 to 3.9", expected: 0, computed: Math.min(e0, e1), unit: "", tol: 0.01, kind: "max" },
        { quantity: "other half, highest y", expected: 4.9, computed: top, unit: "", tol: 0.01, kind: "abs" },
      ];
    },
  },
];
