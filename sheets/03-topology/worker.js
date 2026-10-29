// Optimizer worker
import { buildProblem, createOptimizer, stepOptimizer, nonDiscreteness } from "./model.js";

let problem = null;
let st = null;
let running = false;
let token = 0;

function report(rec) {
  const xPhys = Float64Array.from(st.xPhys);
  const U = Float64Array.from(st.U);
  postMessage({ type: "iter", rec, xPhys, U, gray: nonDiscreteness(st.xPhys), converged: st.converged, done: isDone() }, [xPhys.buffer, U.buffer]);
}

function isDone() {
  return st.converged || st.loop >= problem.maxIter;
}

function stepOnce() {
  try {
    const rec = stepOptimizer(problem, st);
    report(rec);
    return true;
  } catch (e) {
    running = false;
    postMessage({ type: "error", message: e.message });
    return false;
  }
}

async function runLoop(my) {
  while (running && my === token && !isDone()) {
    if (!stepOnce()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  running = false;
  postMessage({ type: "stopped" });
}

onmessage = (e) => {
  const m = e.data;
  if (m.cmd === "setup") {
    token++;
    running = false;
    problem = buildProblem(m.cfg);
    st = createOptimizer(problem);
    postMessage({ type: "ready", xPhys: Float64Array.from(st.xPhys) });
  } else if (m.cmd === "run" && st) {
    if (running) return;
    running = true;
    runLoop(++token);
  } else if (m.cmd === "pause") {
    running = false;
    token++;
  } else if (m.cmd === "step" && st && !running) {
    if (!isDone() || st.loop < problem.maxIter) stepOnce();
  }
};
