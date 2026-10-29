// Runs verification cases in browser or Node
const ZERO_TOL = 1e-9; // absolute tolerance when expected is zero

export function judge(row) {
  const { kind = "rel", expected, computed, tol } = row;
  let error = NaN, pass = false;
  if (kind === "rel") {
    if (expected === 0) {
      error = Math.abs(computed);
      pass = error <= (row.absTol ?? ZERO_TOL);
    } else {
      error = Math.abs(computed - expected) / Math.abs(expected);
      pass = error <= tol;
    }
  } else if (kind === "abs") {
    error = Math.abs(computed - expected);
    pass = error <= tol;
  } else if (kind === "range") {
    error = computed < expected[0] ? expected[0] - computed : computed > expected[1] ? computed - expected[1] : 0;
    pass = computed >= expected[0] && computed <= expected[1];
  } else if (kind === "max") {
    error = Math.abs(computed);
    pass = error <= tol;
  } else if (kind === "bool") {
    error = computed === expected ? 0 : 1;
    pass = computed === expected;
  } else if (kind === "info") {
    pass = true;
  }
  return { ...row, error, pass: pass && (kind === "bool" || kind === "info" || Number.isFinite(computed)) };
}

export async function runCase(c, onProgress = () => {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  let rows;
  try {
    rows = (await c.run(onProgress)).map(judge);
  } catch (e) {
    rows = [{ quantity: "run", expected: "no error", computed: String(e.message || e), kind: "bool", error: 1, pass: false }];
  }
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { id: c.id, rows, pass: rows.every((r) => r.pass), ms: t1 - t0 };
}

export async function runAll(cases, { includeSlow = false, onCase = () => {} } = {}) {
  const out = [];
  for (const c of cases) {
    if (c.slow && !includeSlow) continue;
    const r = await runCase(c);
    onCase(c, r);
    out.push(r);
  }
  return out;
}
