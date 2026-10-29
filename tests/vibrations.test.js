import { test } from "node:test";
import assert from "node:assert/strict";
import { testSheetCases } from "./helpers.js";
import { chainMatrices, modes, audioMapping, newmarkStepper, initialState, validateChain, harmonicResponse } from "../sheets/06-vibrations/model.js";

testSheetCases("06");

test("free free chain has a rigid body mode", () => {
  const md = modes(chainMatrices({ masses: [1, 2, 1], springs: [500, 500], ends: "free-free" }));
  assert.equal(md.omega[0], 0);
  assert.ok(md.omega[1] > 0);
});

test("audio mapping keeps ratios and puts mode 1 at 220 Hz", () => {
  const m = audioMapping([2, 3, 5]);
  assert.ok(Math.abs(m.tones[0] - 220) < 1e-9);
  assert.ok(Math.abs(m.tones[2] / m.tones[0] - 2.5) < 1e-12);
  assert.equal(m.compressed, false);
  const wide = audioMapping([1, 100]);
  assert.equal(wide.compressed, true);
  assert.ok(wide.tones[1] <= 4000 + 1e-9);
});

test("Newmark keeps energy for an undamped oscillator", () => {
  const sys = chainMatrices({ masses: [1], springs: [1000], ends: "fixed-free" });
  const step = newmarkStepper(sys, 0.001);
  let s = initialState(sys, [0.01]);
  for (let i = 0; i < 5000; i++) s = step(s);
  const E = 0.5 * 1000 * s.u[0] ** 2 + 0.5 * s.v[0] ** 2;
  assert.ok(Math.abs(E - 0.05) / 0.05 < 1e-9);
});

test("static response matches stiffness", () => {
  const sys = chainMatrices({ masses: [1, 1], springs: [1000, 1000], ends: "fixed-free" });
  const x = harmonicResponse(sys, 1, 1, 0);
  assert.ok(Math.abs(x[1] - 0.002) < 1e-12);
});

test("validation catches bad input", () => {
  assert.match(validateChain({ masses: [1, -1], springs: [1, 1], ends: "fixed-free" }), /mass/);
  assert.match(validateChain({ masses: [1, 1], springs: [1], ends: "fixed-free" }), /Spring count/);
});
