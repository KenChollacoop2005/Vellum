// Mode tones with Web Audio
const NOTE_GAP = 0.85; // seconds between single tones
const ATTACK = 0.015; // seconds
const HARMONIC = 0.08; // level of the second harmonic
const UNDAMPED_TAU = 0.6; // decay time constant without damping, s

let ctx = null;
let master = null;

function ensure(volume) {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  master.gain.setValueAtTime(volume, ctx.currentTime);
  return ctx;
}

export function setVolume(volume) {
  if (ctx && master) master.gain.setValueAtTime(volume, ctx.currentTime);
}

export function decayTau(zeta, damped) {
  if (!damped || !(zeta > 0)) return UNDAMPED_TAU;
  return Math.min(1.2, Math.max(0.08, 0.06 / zeta));
}

function tone(freq, start, tau, level) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(level, start + ATTACK);
  g.gain.setTargetAtTime(0, start + ATTACK, tau);
  g.connect(master);
  const end = start + ATTACK + 6 * tau;
  for (const [mult, amp] of [[1, 1], [2, HARMONIC]]) {
    if (freq * mult > 20000) continue;
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq * mult, start);
    og.gain.setValueAtTime(amp, start);
    o.connect(og).connect(g);
    o.start(start);
    o.stop(end);
  }
  return end;
}

// Plays each tone low to high, then all together
export function playModes(tones, zetas, damped, volume, onNote = () => {}) {
  if (!ensure(volume)) return 0;
  const t0 = ctx.currentTime + 0.05;
  const live = tones.map((f, i) => [f, i]).filter(([f]) => f > 0);
  live.forEach(([f, i], k) => {
    tone(f, t0 + k * NOTE_GAP, decayTau(zetas[i], damped), 0.5);
    setTimeout(() => onNote(i), (0.05 + k * NOTE_GAP) * 1000);
  });
  const tc = t0 + live.length * NOTE_GAP + 0.1;
  let end = tc;
  for (const [f, i] of live) end = Math.max(end, tone(f, tc, decayTau(zetas[i], damped) * 1.5, 0.5 / Math.sqrt(live.length)));
  setTimeout(() => onNote(-1), (tc - ctx.currentTime) * 1000);
  return end - ctx.currentTime;
}
