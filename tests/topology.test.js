import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import {
  mbbProblem, createOptimizer, stepOptimizer, thresholdGrid, removeDiagonalContacts, buildStl, parseStl, outlinePaths, PRESETS_TOP,
  presetProblem,
} from "../sheets/03-topology/model.js";

testSheetCases("03");

test("a few iterations lower compliance and keep volume", () => {
  const p = mbbProblem({ nelx: 30, nely: 10, volfrac: 0.5, penal: 3, rmin: 1.5, ft: 1 });
  const st = createOptimizer(p);
  const first = stepOptimizer(p, st);
  let last = first;
  for (let i = 0; i < 5; i++) last = stepOptimizer(p, st);
  assert.ok(last.c < first.c);
  assert.ok(Math.abs(last.vol - 0.5) < 1e-3);
});

test("diagonal contacts are removed", () => {
  const g = thresholdGrid(Float64Array.from([1, 0, 0, 1]), 2, 2);
  const fixed = removeDiagonalContacts(g, 2, 2);
  const solid = fixed.reduce((s, v) => s + v, 0);
  assert.equal(solid, 3);
});

function edgeCheck(tris) {
  const key = (a, b) => `${a.join(",")}|${b.join(",")}`;
  const directed = new Map();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const kk = key(a, b);
      directed.set(kk, (directed.get(kk) || 0) + 1);
    }
  }
  let bad = 0;
  for (const [kk, n] of directed) {
    const [a, b] = kk.split("|");
    const back = directed.get(`${b}|${a}`) || 0;
    if (n !== 1 || back !== 1) bad++;
  }
  return bad;
}

test("STL is watertight: every edge shared by exactly two triangles, opposite directions", () => {
  const rng = (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); })();
  const nelx = 14, nely = 9;
  const x = Float64Array.from({ length: nelx * nely }, () => (rng() < 0.55 ? 1 : 0));
  const grid = removeDiagonalContacts(thresholdGrid(x, nelx, nely), nelx, nely);
  const tris = parseStl(buildStl(grid, nelx, nely, 1, 2));
  assert.ok(tris.length > 0);
  assert.equal(edgeCheck(tris), 0);
});

test("STL of the MBB preset grid is watertight", () => {
  const p = presetProblem({ ...PRESETS_TOP.mbb.defaults, nelx: 30, nely: 10, preset: "mbb" });
  const st = createOptimizer(p);
  for (let i = 0; i < 15; i++) stepOptimizer(p, st);
  const grid = removeDiagonalContacts(thresholdGrid(st.xPhys, 30, 10), 30, 10);
  assert.equal(edgeCheck(parseStl(buildStl(grid, 30, 10, 1, 3))), 0);
});

test("SVG outline loops close", () => {
  const grid = Uint8Array.from([1, 1, 0, 1, 1, 1, 0, 1, 1]);
  const paths = outlinePaths(grid, 3, 3);
  assert.ok(paths.length >= 1);
  for (const loop of paths) assert.deepEqual(loop[0], loop[loop.length - 1]);
});
