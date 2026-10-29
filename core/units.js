// Unit conversion and number formatting
const SCALE = {
  m: 1, mm: 1e-3, N: 1, kN: 1e3, MN: 1e6, "N·m": 1, "kN·m": 1e3, Pa: 1, kPa: 1e3, MPa: 1e6, GPa: 1e9,
  "kN/m": 1e3, "N/mm": 1e3, "MN/m": 1e6, "mm²": 1e-6, "mm⁴": 1e-12, "1e6 mm⁴": 1e-6, "m²": 1, "m⁴": 1,
  rad: 1, deg: Math.PI / 180, "rad/s": 1, Hz: 2 * Math.PI, "N·mm/mm": 1, "N·m/m": 1, "kN·m/m": 1e3,
};

export function toUnit(si, unit) {
  return si / SCALE[unit];
}

export function fromUnit(value, unit) {
  return value * SCALE[unit];
}

function clean(x, zeroTol) {
  return Math.abs(x) < zeroTol || Object.is(x, -0) ? 0 : x;
}

export function fmt(x, sig = 4, zeroTol = 0) {
  if (!Number.isFinite(x)) return "n/a";
  const v = clean(x, zeroTol);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(sig - 1).replace("e+", "e");
  return String(Number(v.toPrecision(sig)));
}

export function fixed(x, decimals = 3) {
  if (!Number.isFinite(x)) return "n/a";
  const s = x.toFixed(decimals);
  return Number(s) === 0 ? (0).toFixed(decimals) : s;
}
