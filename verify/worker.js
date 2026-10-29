// Runs verification cases off the main thread
import { cases } from "./cases.js";
import { runCase } from "./run.js";

let queue = Promise.resolve();

onmessage = (e) => {
  const { id } = e.data;
  queue = queue.then(async () => {
    const c = cases.find((x) => x.id === id);
    if (!c) { postMessage({ type: "result", id, res: { id, rows: [], pass: false, ms: 0 } }); return; }
    const res = await runCase(c, (p) => postMessage({ type: "progress", id, p }));
    postMessage({ type: "result", id, res });
  });
};
