// Dense and banded solvers, eigen solvers
export const UNSTABLE_MSG = "Structure is unstable. Check supports.";
const PIVOT_TOL = 1e-11; // relative pivot size that counts as zero

export class UnstableError extends Error {
  constructor(message = UNSTABLE_MSG) {
    super(message);
    this.name = "UnstableError";
  }
}

// Dense helpers
export function zeros(n, m = n) {
  return Array.from({ length: n }, () => new Array(m).fill(0));
}

export function identity(n) {
  const I = zeros(n);
  for (let i = 0; i < n; i++) I[i][i] = 1;
  return I;
}

export function transpose(A) {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

export function matMul(A, B) {
  const n = A.length, m = B[0].length, p = B.length;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < p; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < m; j++) C[i][j] += a * B[k][j];
    }
  }
  return C;
}

export function matVec(A, v) {
  return A.map((row) => row.reduce((s, a, j) => s + a * v[j], 0));
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// LU with partial pivoting
export function luSolve(A, b) {
  const n = A.length;
  const M = A.map((row) => row.slice());
  const x = b.slice();
  const scale = Math.max(...M.map((r) => Math.max(...r.map(Math.abs)))) || 1;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if (Math.abs(M[p][k]) <= PIVOT_TOL * scale) throw new UnstableError();
    if (p !== k) {
      [M[p], M[k]] = [M[k], M[p]];
      [x[p], x[k]] = [x[k], x[p]];
    }
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      if (f === 0) continue;
      for (let j = k; j < n; j++) M[i][j] -= f * M[k][j];
      x[i] -= f * x[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

// Symmetric banded storage, upper band by rows
export function createBanded(n, bw) {
  return { n, bw, data: new Float64Array(n * (bw + 1)) };
}

export function bandedAdd(B, i, j, v) {
  const r = Math.min(i, j), c = Math.max(i, j);
  if (c - r > B.bw) throw new Error(`Entry (${i}, ${j}) is outside the band`);
  B.data[r * (B.bw + 1) + (c - r)] += v;
}

export function bandedGet(B, i, j) {
  const r = Math.min(i, j), c = Math.max(i, j);
  if (c - r > B.bw) return 0;
  return B.data[r * (B.bw + 1) + (c - r)];
}

export function bandedFromDense(D, bw) {
  const B = createBanded(D.length, bw);
  for (let i = 0; i < D.length; i++) {
    for (let j = i; j <= Math.min(D.length - 1, i + bw); j++) B.data[i * (bw + 1) + (j - i)] = D[i][j];
  }
  return B;
}

export function bandedMatVec(B, v) {
  const { n, bw, data } = B, w = bw + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] += data[i * w] * v[i];
    for (let k = 1; k <= bw && i + k < n; k++) {
      const a = data[i * w + k];
      out[i] += a * v[i + k];
      out[i + k] += a * v[i];
    }
  }
  return out;
}

// Banded Cholesky, U'U form
export function bandedCholesky(B) {
  const { n, bw } = B, w = bw + 1;
  const U = new Float64Array(B.data);
  for (let i = 0; i < n; i++) {
    const diag0 = B.data[i * w];
    let d = U[i * w];
    for (let k = Math.max(0, i - bw); k < i; k++) {
      const u = U[k * w + (i - k)];
      d -= u * u;
    }
    if (!(d > PIVOT_TOL * Math.abs(diag0)) || !(d > 0)) throw new UnstableError();
    d = Math.sqrt(d);
    U[i * w] = d;
    for (let j = i + 1; j <= Math.min(n - 1, i + bw); j++) {
      let s = U[i * w + (j - i)];
      for (let k = Math.max(0, j - bw); k < i; k++) s -= U[k * w + (i - k)] * U[k * w + (j - k)];
      U[i * w + (j - i)] = s / d;
    }
  }
  return { n, bw, data: U };
}

export function bandedCholeskySolve(F, b) {
  const { n, bw, data } = F, w = bw + 1;
  const y = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let s = y[i];
    for (let k = Math.max(0, i - bw); k < i; k++) s -= data[k * w + (i - k)] * y[k];
    y[i] = s / data[i * w];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j <= Math.min(n - 1, i + bw); j++) s -= data[i * w + (j - i)] * y[j];
    y[i] = s / data[i * w];
  }
  return Array.from(y);
}

export function bandedSolve(B, b) {
  return bandedCholeskySolve(bandedCholesky(B), b);
}

// Jacobi preconditioned conjugate gradient
export function pcg(applyA, b, diag, tol = 1e-10, maxIter = 1000, x0 = null) {
  const n = b.length;
  const x = x0 ? Float64Array.from(x0) : new Float64Array(n);
  const r = Float64Array.from(b);
  if (x0) {
    const Ax = applyA(x);
    for (let i = 0; i < n; i++) r[i] -= Ax[i];
  }
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
  const p = Float64Array.from(z);
  let rz = dot(r, z);
  const bnorm = Math.sqrt(dot(b, b)) || 1;
  let it = 0;
  while (it < maxIter && Math.sqrt(dot(r, r)) / bnorm > tol) {
    const Ap = applyA(p);
    const alpha = rz / dot(p, Ap);
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
    const rzNew = dot(r, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    it++;
  }
  return { x: Array.from(x), iterations: it };
}

// Cyclic Jacobi eigen solver
export function jacobiEigen(Ain, maxSweeps = 100) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V = identity(n);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0, total = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        total += A[i][j] * A[i][j];
        if (i !== j) off += A[i][j] * A[i][j];
      }
    }
    if (off <= 1e-30 * (total || 1)) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (A[p][q] === 0) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[a][a] - A[b][b]);
  const values = idx.map((i) => A[i][i]);
  const vectors = idx.map((i) => fixSign(V.map((row) => row[i])));
  return { values, vectors };
}

function fixSign(v) {
  let big = 0;
  for (let i = 0; i < v.length; i++) if (Math.abs(v[i]) > Math.abs(v[big]) + 1e-12) big = i;
  return v[big] < 0 ? v.map((x) => -x) : v;
}

// Dense Cholesky, lower factor
export function cholesky(A) {
  const n = A.length;
  const L = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) throw new UnstableError("Matrix is not positive definite.");
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

function lowerInverse(L) {
  const n = L.length;
  const X = zeros(n);
  for (let j = 0; j < n; j++) {
    X[j][j] = 1 / L[j][j];
    for (let i = j + 1; i < n; i++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i][k] * X[k][j];
      X[i][j] = s / L[i][i];
    }
  }
  return X;
}

// K x = w2 M x via Cholesky reduction
export function generalizedEigen(K, M) {
  const L = cholesky(M);
  const Li = lowerInverse(L);
  const C = matMul(Li, matMul(K, transpose(Li)));
  const n = C.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = 0.5 * (C[i][j] + C[j][i]);
    C[i][j] = a; C[j][i] = a;
  }
  const { values, vectors } = jacobiEigen(C);
  const LiT = transpose(Li);
  return { values, vectors: vectors.map((y) => fixSign(matVec(LiT, y))) };
}
