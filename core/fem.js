// Element routines for trusses, frames and Q4 plane stress
import { bandedAdd, matMul, transpose } from "./linalg.js";

export function memberGeometry(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = Math.hypot(dx, dy);
  return { L, c: dx / L, s: dy / L };
}

// Truss element, global 4x4
export function trussGlobalK(E, A, x1, y1, x2, y2) {
  const { L, c, s } = memberGeometry(x1, y1, x2, y2);
  const k = (E * A) / L;
  const cc = k * c * c, cs = k * c * s, ss = k * s * s;
  return [
    [cc, cs, -cc, -cs],
    [cs, ss, -cs, -ss],
    [-cc, -cs, cc, cs],
    [-cs, -ss, cs, ss],
  ];
}

// Frame element, local 6x6
export function frameLocalK(E, A, I, L) {
  const a = (E * A) / L;
  const b = (12 * E * I) / L ** 3;
  const c = (6 * E * I) / L ** 2;
  const d = (4 * E * I) / L;
  const e = (2 * E * I) / L;
  return [
    [a, 0, 0, -a, 0, 0],
    [0, b, c, 0, -b, c],
    [0, c, d, 0, -c, e],
    [-a, 0, 0, a, 0, 0],
    [0, -b, -c, 0, b, -c],
    [0, c, e, 0, -c, d],
  ];
}

export function frameTransform(c, s) {
  return [
    [c, s, 0, 0, 0, 0],
    [-s, c, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0],
    [0, 0, 0, c, s, 0],
    [0, 0, 0, -s, c, 0],
    [0, 0, 0, 0, 0, 1],
  ];
}

export function frameGlobalK(E, A, I, x1, y1, x2, y2) {
  const { L, c, s } = memberGeometry(x1, y1, x2, y2);
  const T = frameTransform(c, s);
  return matMul(transpose(T), matMul(frameLocalK(E, A, I, L), T));
}

// Equivalent nodal loads for uniform load, local axes
export function udlConsistentLocal(qx, qy, L) {
  return [qx * L / 2, qy * L / 2, qy * L * L / 12, qx * L / 2, qy * L / 2, -qy * L * L / 12];
}

export function udlLumpedLocal(qx, qy, L) {
  return [qx * L / 2, qy * L / 2, 0, qx * L / 2, qy * L / 2, 0];
}

// Q4 bilinear element for unit E, as in top88
export function q4KE(nu) {
  const A11 = [[12, 3, -6, -3], [3, 12, 3, 0], [-6, 3, 12, -3], [-3, 0, -3, 12]];
  const A12 = [[-6, -3, 0, 3], [-3, -6, -3, -6], [0, -3, -6, 3], [3, -6, 3, -6]];
  const B11 = [[-4, 3, -2, 9], [3, -4, -9, 4], [-2, -9, -4, -3], [9, 4, -3, -4]];
  const B12 = [[2, -3, 4, -9], [-3, 2, 9, -2], [4, 9, 2, 3], [-9, -2, 3, 2]];
  const block = (P, Q) => {
    const Qt = transpose(Q);
    const out = [];
    for (let i = 0; i < 4; i++) out.push([...P[i], ...Q[i]]);
    for (let i = 0; i < 4; i++) out.push([...Qt[i], ...P[i]]);
    return out;
  };
  const A = block(A11, A12), B = block(B11, B12);
  const f = 1 / (1 - nu * nu) / 24;
  return A.map((row, i) => row.map((a, j) => f * (a + nu * B[i][j])));
}

// Assembly into banded storage
export function addToBanded(B, dofs, ke) {
  for (let a = 0; a < dofs.length; a++) {
    const i = dofs[a];
    if (i < 0) continue;
    for (let b = 0; b < dofs.length; b++) {
      const j = dofs[b];
      if (j < i) continue;
      bandedAdd(B, i, j, ke[a][b]);
    }
  }
}

export function bandwidthOf(elementDofs) {
  let bw = 0;
  for (const dofs of elementDofs) {
    const live = dofs.filter((d) => d >= 0);
    if (live.length) bw = Math.max(bw, Math.max(...live) - Math.min(...live));
  }
  return bw;
}

// Reverse Cuthill McKee node order
export function rcmOrder(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    if (a === b) continue;
    adj[a].push(b);
    adj[b].push(a);
  }
  const deg = adj.map((l) => l.length);
  const seen = new Array(n).fill(false);
  const order = [];
  while (order.length < n) {
    let start = -1;
    for (let i = 0; i < n; i++) if (!seen[i] && (start < 0 || deg[i] < deg[start])) start = i;
    const queue = [start];
    seen[start] = true;
    while (queue.length) {
      const v = queue.shift();
      order.push(v);
      const next = adj[v].filter((u) => !seen[u]).sort((a, b) => deg[a] - deg[b] || a - b);
      for (const u of next) {
        seen[u] = true;
        queue.push(u);
      }
    }
  }
  return order.reverse();
}

// Linearly varying transverse load, consistent nodal loads
export function linearLoadConsistent(q1, q2, L) {
  return [
    (L * (7 * q1 + 3 * q2)) / 20,
    (L * L * (3 * q1 + 2 * q2)) / 60,
    (L * (3 * q1 + 7 * q2)) / 20,
    (-L * L * (2 * q1 + 3 * q2)) / 60,
  ];
}
