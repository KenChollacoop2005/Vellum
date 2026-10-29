import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import { solveBeam, principal, transformStress, BEAM_PRESETS } from "../sheets/02-beam-mohr/model.js";

testSheetCases("02");

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("overhang reactions from statics", () => {
  const r = solveBeam({ L: 6, support: "overhang", a: 0, b: 4, E: 2e11, I: 1e-5, loads: [{ type: "point", x: 6, P: 10e3 }] });
  close(r.reactions[0].R, -5e3);
  close(r.reactions[1].R, 15e3);
  close(r.momentAt(4), -20e3);
});

test("triangular load on simple beam", () => {
  const L = 6, q = 3e3;
  const r = solveBeam({ L, support: "simply", E: 2e11, I: 1e-5, loads: [{ type: "dist", x1: 0, x2: L, q1: 0, q2: q }] });
  close(r.reactions[0].R, (q * L) / 6);
  close(r.reactions[1].R, (q * L) / 3);
  close(r.maxMoment.value, (q * L * L) / (9 * Math.sqrt(3)), 1e-6);
  close(r.maxMoment.x, L / Math.sqrt(3), 1e-6);
  assert.ok(r.feStaticsGap < 1e-6);
});

test("point moment on simple beam jumps the moment diagram", () => {
  const r = solveBeam({ L: 4, support: "simply", E: 2e11, I: 1e-5, loads: [{ type: "moment", x: 2, M: 8e3 }] });
  close(r.momentAt(2, -1), 4e3);
  close(r.momentAt(2, 1), -4e3);
});

test("stress transformation keeps invariants", () => {
  const t = transformStress(50, 10, -20, 0.7);
  close(t.sx + t.sy, 60);
  const p = principal(50, 10, -20), q = principal(t.sx, t.sy, t.txy);
  close(p.s1, q.s1); close(p.s2, q.s2);
});

test("absolute max shear uses sigma3 = 0 when both principals share a sign", () => {
  const p = principal(100, 40, 0);
  close(p.tauMax, 30);
  close(p.tauAbs, 50);
});

test("every beam preset solves", () => {
  for (const [k, p] of Object.entries(BEAM_PRESETS)) {
    const r = solveBeam(p);
    assert.equal(r.ok, true, k);
  }
});
