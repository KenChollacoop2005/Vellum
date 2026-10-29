import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import { createLbm, stepLbm, macros, feq, tauFor, naca4, rasterize, shapeOutline, strouhal, W } from "../sheets/04-wind-tunnel/model.js";

testSheetCases("04");

test("equilibrium weights sum to one and recover density and velocity", () => {
  assert.ok(Math.abs(W.reduce((s, w) => s + w, 0) - 1) < 1e-15);
  let rho = 0, mx = 0;
  for (let q = 0; q < 9; q++) { rho += feq(q, 1.02, 0.05, -0.02); mx += [0, 1, 0, -1, 0, 1, -1, -1, 1][q] * feq(q, 1.02, 0.05, -0.02); }
  assert.ok(Math.abs(rho - 1.02) < 1e-14);
  assert.ok(Math.abs(mx / rho - 0.05) < 1e-14);
});

test("tau follows the viscosity relation", () => {
  assert.ok(Math.abs(tauFor(100, 0.1, 20) - (3 * 0.02 + 0.5)) < 1e-14);
});

test("uniform flow in an empty open channel stays uniform", () => {
  const sim = createLbm({ nx: 40, ny: 20, tau: 0.8, uIn: 0.05, yMode: "periodic" });
  stepLbm(sim, 200);
  const { ux, uy } = macros(sim);
  for (let c = 0; c < sim.n; c++) {
    assert.ok(Math.abs(ux[c] - 0.05) < 1e-9);
    assert.ok(Math.abs(uy[c]) < 1e-9);
  }
});

test("symmetric NACA 0012 at zero angle is symmetric", () => {
  const poly = naca4("0012", 100, 0);
  const ys = poly.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...ys) + Math.min(...ys)) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - 6) < 0.1);
});

test("rasterized cylinder has about the right area", () => {
  const m = rasterize(100, 100, shapeOutline("cylinder", 40), 50, 50);
  const area = m.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(area - Math.PI * 400) / (Math.PI * 400) < 0.03);
});

test("Strouhal from a clean sine", () => {
  const lift = Array.from({ length: 2000 }, (_, k) => Math.sin((2 * Math.PI * k * 10) / 1000));
  const s = strouhal(lift, 10, 16, 0.1);
  assert.equal(s.periodic, true);
  assert.ok(Math.abs(s.St - 16 / (1000 * 0.1)) < 1e-3);
});
