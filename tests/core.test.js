import { test } from "node:test";
import assert from "node:assert/strict";
import {
  luSolve, createBanded, bandedAdd, bandedSolve, bandedFromDense, pcg,
  jacobiEigen, generalizedEigen, matVec, UnstableError, transpose, matMul,
} from "../core/linalg.js";
import {
  trussGlobalK, frameLocalK, frameTransform, frameGlobalK, udlConsistentLocal,
  udlLumpedLocal, q4KE, addToBanded, rcmOrder, linearLoadConsistent,
} from "../core/fem.js";
import { fmt, fixed, toUnit, fromUnit } from "../core/units.js";
import { encodeState, decodeState } from "../core/state.js";
import { makeRng } from "../core/rng.js";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("LU solve with pivoting", () => {
  const A = [[0, 2, 1], [1, 1, 1], [2, 1, 0]];
  const x = luSolve(A, [5, 4, 4]);
  close(x[0], 1); close(x[1], 2); close(x[2], 1);
});

test("LU detects singular matrix", () => {
  assert.throws(() => luSolve([[1, 2], [2, 4]], [1, 2]), UnstableError);
});

test("banded Cholesky matches LU", () => {
  const rng = makeRng(1);
  const n = 12, bw = 3;
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j <= Math.min(n - 1, i + bw); j++) {
      const v = j === i ? 10 + rng() : rng() - 0.5;
      D[i][j] = v; D[j][i] = v;
    }
  }
  const b = Array.from({ length: n }, () => rng());
  const xLu = luSolve(D, b);
  const xB = bandedSolve(bandedFromDense(D, bw), b);
  for (let i = 0; i < n; i++) close(xB[i], xLu[i], 1e-12);
});

test("banded add keeps symmetric upper band", () => {
  const B = createBanded(3, 1);
  bandedAdd(B, 0, 0, 2); bandedAdd(B, 1, 0, -1); bandedAdd(B, 1, 1, 2);
  bandedAdd(B, 2, 1, -1); bandedAdd(B, 2, 2, 1);
  const x = bandedSolve(B, [0, 0, 1]);
  close(x[0], 1); close(x[1], 2); close(x[2], 3);
});

test("banded Cholesky flags a mechanism", () => {
  const B = createBanded(2, 1);
  bandedAdd(B, 0, 0, 1); bandedAdd(B, 0, 1, -1); bandedAdd(B, 1, 1, 1);
  assert.throws(() => bandedSolve(B, [1, 0]), /Structure is unstable\. Check supports\./);
});

test("preconditioned CG solves SPD system", () => {
  const A = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
  const b = [1, 2, 3];
  const { x, iterations } = pcg((v) => matVec(A, v), b, [4, 3, 2], 1e-12, 50);
  const ref = luSolve(A, b);
  for (let i = 0; i < 3; i++) close(x[i], ref[i], 1e-10);
  assert.ok(iterations <= 3);
});

test("Jacobi eigen of symmetric matrix", () => {
  const A = [[2, -1, 0], [-1, 2, -1], [0, -1, 2]];
  const { values, vectors } = jacobiEigen(A);
  close(values[0], 2 - Math.SQRT2); close(values[1], 2); close(values[2], 2 + Math.SQRT2);
  for (let k = 0; k < 3; k++) {
    const Av = matVec(A, vectors[k]);
    for (let i = 0; i < 3; i++) close(Av[i], values[k] * vectors[k][i], 1e-10);
  }
});

test("generalized eigen gives mass normalized modes", () => {
  const K = [[2000, -1000], [-1000, 1000]];
  const M = [[2, 0], [0, 1]];
  const { values, vectors } = generalizedEigen(K, M);
  const ref = [(2 - Math.SQRT2) / 2 * 1000, (2 + Math.SQRT2) / 2 * 1000];
  close(values[0], ref[0]); close(values[1], ref[1]);
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      const Mb = matVec(M, vectors[b]);
      const dot = vectors[a].reduce((s, v, i) => s + v * Mb[i], 0);
      close(dot, a === b ? 1 : 0, 1e-12);
    }
  }
});

test("matrix helpers", () => {
  const A = [[1, 2], [3, 4]];
  assert.deepEqual(transpose(A), [[1, 3], [2, 4]]);
  assert.deepEqual(matMul(A, [[1, 0], [0, 1]]), A);
});

test("truss element stiffness at 30 degrees", () => {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const k = trussGlobalK(1, 1, 0, 0, c, s);
  close(k[0][0], c * c); close(k[0][1], c * s); close(k[0][2], -c * c); close(k[1][1], s * s);
});

test("frame local stiffness entries", () => {
  const k = frameLocalK(2, 3, 5, 2);
  close(k[0][0], 3); close(k[1][1], 12 * 2 * 5 / 8); close(k[1][2], 6 * 2 * 5 / 4);
  close(k[2][2], 4 * 2 * 5 / 2); close(k[2][5], 2 * 2 * 5 / 2); close(k[4][5], -6 * 2 * 5 / 4);
});

test("frame global stiffness is T'kT and symmetric", () => {
  const kg = frameGlobalK(200e9, 1e-3, 8e-6, 0, 0, 3, 4);
  const T = frameTransform(0.6, 0.8);
  const ref = matMul(transpose(T), matMul(frameLocalK(200e9, 1e-3, 8e-6, 5), T));
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    close(kg[i][j], ref[i][j], 1e-12);
    close(kg[i][j], kg[j][i], 1e-12);
  }
});

test("uniform load equivalent nodal loads", () => {
  assert.deepEqual(udlConsistentLocal(0, 6, 2), [0, 6, 2, 0, 6, -2]);
  assert.deepEqual(udlLumpedLocal(1, 6, 2), [1, 6, 0, 1, 6, 0]);
});

test("Q4 element stiffness matches top88 KE", () => {
  const KE = q4KE(0.3);
  const nu = 0.3;
  const k = [1 / 2 - nu / 6, 1 / 8 + nu / 8, -1 / 4 - nu / 12, -1 / 8 + 3 * nu / 8,
    -1 / 4 + nu / 12, -1 / 8 - nu / 8, nu / 6, 1 / 8 - 3 * nu / 8];
  const ref99 = [
    [k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]],
    [k[1], k[0], k[7], k[6], k[5], k[4], k[3], k[2]],
    [k[2], k[7], k[0], k[5], k[6], k[3], k[4], k[1]],
    [k[3], k[6], k[5], k[0], k[7], k[2], k[1], k[4]],
    [k[4], k[5], k[6], k[7], k[0], k[1], k[2], k[3]],
    [k[5], k[4], k[3], k[2], k[1], k[0], k[7], k[6]],
    [k[6], k[3], k[4], k[1], k[2], k[7], k[0], k[5]],
    [k[7], k[2], k[1], k[4], k[3], k[6], k[5], k[0]],
  ].map((r) => r.map((v) => v / (1 - nu * nu)));
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) close(KE[i][j], ref99[i][j], 1e-12);
});

test("addToBanded scatters element matrix", () => {
  const B = createBanded(4, 3);
  addToBanded(B, [0, 1, 2, 3], [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  addToBanded(B, [3, 0], [[1, 0], [0, 1]]);
  const x = bandedSolve(B, [2, 1, 1, 2]);
  close(x[0], 1); close(x[3], 1);
});

test("RCM ordering reduces bandwidth of a path", () => {
  const edges = [[0, 5], [5, 2], [2, 7], [7, 1], [1, 4], [4, 3], [3, 6]];
  const order = rcmOrder(8, edges);
  const pos = new Array(8); order.forEach((n, i) => { pos[n] = i; });
  const bw = Math.max(...edges.map(([a, b]) => Math.abs(pos[a] - pos[b])));
  assert.equal(bw, 1);
});

test("number formatting", () => {
  assert.equal(fmt(16.6667, 4), "16.67");
  assert.equal(fmt(-0.0000001, 3, 1e-6), "0");
  assert.equal(fixed(3.14159, 2), "3.14");
  assert.equal(fixed(-1e-12, 3), "0.000");
  close(toUnit(2e5, "kN"), 200);
  close(fromUnit(200, "GPa"), 200e9);
  close(toUnit(0.0125, "mm"), 12.5);
});

test("URL state round trip and bad input", () => {
  const s = { a: 1, b: [1.5, "x"], c: { d: "µ" } };
  assert.deepEqual(decodeState(encodeState(s)), s);
  assert.equal(decodeState("%%%not-base64"), null);
  assert.equal(decodeState(""), null);
});

test("seeded generator is deterministic", () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const c = makeRng(43);
  assert.notEqual(makeRng(42)(), c());
});

test("linear load consistent vector reduces to uniform case", () => {
  const u = linearLoadConsistent(6, 6, 2);
  const ref = udlConsistentLocal(0, 6, 2);
  for (const [a, b] of [[0, 1], [1, 2], [2, 4], [3, 5]]) close(u[a], ref[b]);
  const t = linearLoadConsistent(0, 6, 2);
  close(t[0] + t[2], 6);
});
