// Promise wrapper around the check worker
export function createChecker(workerUrl) {
  const worker = new Worker(workerUrl, { type: "module" });
  const pending = new Map();
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "progress") p.onProgress(m.p);
    else { pending.delete(m.id); p.resolve(m.res); }
  };
  return (id, onProgress = () => {}) => new Promise((resolve) => {
    pending.set(id, { resolve, onProgress });
    worker.postMessage({ id });
  });
}
