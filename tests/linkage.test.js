import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import { grashof, fourBarPosition, fourBarSweep, circleIntersect, LINK_PRESETS } from "../sheets/07-linkage/model.js";

testSheetCases("07");

test("circle intersection picks the requested side", () => {
  const up = circleIntersect([0, 0], 5, [8, 0], 5, 1), dn = circleIntersect([0, 0], 5, [8, 0], 5, -1);
  assert.ok(Math.abs(up[0] - 4) < 1e-12 && Math.abs(up[1] - 3) < 1e-12);
  assert.ok(Math.abs(dn[1] + 3) < 1e-12);
  assert.equal(circleIntersect([0, 0], 1, [5, 0], 1, 1), null);
});

test("Grashof classes", () => {
  assert.equal(grashof({ ground: 2, crank: 7, coupler: 6, rocker: 9 }).type, "double crank");
  assert.equal(grashof({ ground: 7, crank: 6, coupler: 2, rocker: 9 }).type, "double rocker");
  assert.equal(grashof({ ground: 7, crank: 6, coupler: 9, rocker: 2 }).type, "rocker crank");
  assert.equal(grashof({ ground: 5, crank: 4, coupler: 6, rocker: 3.5 }).type, "triple rocker");
});

test("crank rocker assembles at every angle, double rocker does not", () => {
  assert.equal(fourBarSweep(LINK_PRESETS.crankRocker.fourBar).pts.filter((p) => !p).length, 0);
  const dr = fourBarSweep(LINK_PRESETS.doubleRocker.fourBar);
  assert.ok(dr.pts.some((p) => !p));
  assert.ok(dr.ranges.length >= 1);
});

test("open and crossed branches differ", () => {
  const fb = { ...LINK_PRESETS.crankRocker.fourBar };
  const a = fourBarPosition(fb, 1), b = fourBarPosition({ ...fb, branch: "crossed" }, 1);
  assert.ok(Math.hypot(a.B[0] - b.B[0], a.B[1] - b.B[1]) > 1);
});

test("crank rocker transmission angle stays in range", () => {
  const s = fourBarSweep(LINK_PRESETS.crankRocker.fourBar);
  assert.ok(s.muMin > 0 && s.muMax <= Math.PI / 2);
});
