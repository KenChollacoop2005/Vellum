import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import { parseLayup, layupCode, analyzeLaminate, plyEx, laminateEx, MATERIALS, LAM_PRESETS } from "../sheets/05-laminate/model.js";

testSheetCases("05");

test("layup parser expands shorthand", () => {
  assert.deepEqual(parseLayup("[0/±45/90]s"), [0, 45, -45, 90, 90, -45, 45, 0]);
  assert.deepEqual(parseLayup("[0/90]2s"), [0, 90, 0, 90, 90, 0, 90, 0]);
  assert.deepEqual(parseLayup("[0_2/90]"), [0, 0, 90]);
  assert.deepEqual(parseLayup("[ 0 / 90 ]"), [0, 90]);
  assert.throws(() => parseLayup("0/90"));
  assert.throws(() => parseLayup("[0/abc]s"));
});

test("layup code round trips", () => {
  for (const code of ["[0/±45/90]s", "[0/90]2s", "[±45]s", "[0/90]", "[0/45/-45/90]s"]) {
    assert.deepEqual(parseLayup(layupCode(parseLayup(code))), parseLayup(code));
  }
  assert.equal(layupCode(parseLayup("[0/90]2s")), "[0/90]2s");
  assert.equal(layupCode([45, -45, -45, 45]), "[±45]s");
});

test("single ply laminate matches ply Ex at any angle", () => {
  const plies = [{ angle: 0, mat: "t300" }];
  for (const t of [0, 15, 45, 80]) {
    const a = laminateEx(plies, t), b = plyEx(MATERIALS.t300, t);
    assert.ok(Math.abs(a - b) / b < 1e-12);
  }
});

test("unloaded laminate has no first ply failure", () => {
  const r = analyzeLaminate(parseLayup("[0/90]s").map((a) => ({ angle: a, mat: "t300" })));
  assert.equal(r.fpf.maxStress.factor, Infinity);
});

test("every preset parses and analyzes", () => {
  for (const p of Object.values(LAM_PRESETS)) {
    const r = analyzeLaminate(parseLayup(p.code).map((a) => ({ angle: a, mat: p.mat })), { N: [100, 0, 0], M: [0, 0, 0] });
    assert.equal(r.ok, true);
    assert.ok(Number.isFinite(r.fpf.tsaiWu.factor));
  }
});
