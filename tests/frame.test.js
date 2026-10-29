import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import { solveStructure, beamModel, validateModel, memberDiagram, PRESETS } from "../sheets/01-frame/model.js";

testSheetCases("01");

test("mechanism reports instability, not NaN", () => {
  const m = { nodes: [{ x: 0, y: 0, support: "pin" }, { x: 2, y: 0, fy: -1000 }], members: [{ a: 0, b: 1, type: "frame", E: 2e11, A: 1e-3, I: 1e-6 }] };
  const r = solveStructure(m);
  assert.equal(r.ok, false);
  assert.match(r.error, /Structure is unstable\. Check supports\./);
});

test("no supports is unstable", () => {
  const m = { nodes: [{ x: 0, y: 0 }, { x: 2, y: 0 }], members: [{ a: 0, b: 1, type: "frame", E: 2e11, A: 1e-3, I: 1e-6 }] };
  assert.equal(solveStructure(m).ok, false);
});

test("zero length member rejected", () => {
  const m = { nodes: [{ x: 1, y: 1, support: "fixed" }, { x: 1, y: 1 }], members: [{ a: 0, b: 1, type: "frame", E: 2e11, A: 1e-3, I: 1e-6 }] };
  assert.match(validateModel(m), /zero length/i);
  assert.equal(solveStructure(m).ok, false);
});

test("crossing members without shared node do not connect", () => {
  const sec = { type: "truss", E: 2e11, A: 1e-3, I: 0 };
  const m = {
    nodes: [{ x: 0, y: 0, support: "pin" }, { x: 2, y: 2, support: "pin" }, { x: 0, y: 2, support: "pin" }, { x: 2, y: 0, support: "pin" }],
    members: [{ a: 0, b: 1, ...sec }, { a: 2, b: 3, ...sec }],
  };
  const r = solveStructure(m);
  assert.equal(r.ok, true);
  assert.equal(r.members[0].N, 0);
});

test("moment diagram ends match member end forces", () => {
  const m = beamModel({ L: 4, n: 1, E: 2e11, A: 1e-2, I: 8e-6, supports: { 0: "fixed", 1: "fixed" }, w: -5000 });
  const r = solveStructure(m);
  const d = memberDiagram(r.members[0], 20);
  assert.ok(Math.abs(d.M[0] - r.members[0].Mi) < 1e-6);
  assert.ok(Math.abs(d.M[20] - r.members[0].Mj) < 1e-6);
  assert.ok(Math.abs(d.M[10] - 5000 * 16 / 24) < 1e-6);
});

test("every preset solves", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const r = solveStructure(p.model);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
  }
});
