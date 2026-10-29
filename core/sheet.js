// Shared page shell behavior
import { readHashState, writeHashState } from "./state.js";

export const SHEETS = [
  { no: "01", slug: "01-frame", title: "Frame and truss solver", blurb: "Draw a structure, load it, see where the forces go." },
  { no: "02", slug: "02-beam-mohr", title: "Beam diagrams and Mohr's circle", blurb: "Shear, moment and deflection of a beam, plus stress transformation." },
  { no: "03", slug: "03-topology", title: "Topology optimizer", blurb: "Let the algorithm carve away material you don't need." },
  { no: "04", slug: "04-wind-tunnel", title: "Wind tunnel", blurb: "Draw a shape and watch the flow and vortex shedding around it." },
  { no: "05", slug: "05-laminate", title: "Laminate calculator", blurb: "Stiffness and first ply failure of a composite layup." },
  { no: "06", slug: "06-vibrations", title: "Vibrations you can hear", blurb: "Hear the natural frequencies of a spring and mass system." },
  { no: "07", slug: "07-linkage", title: "Linkage simulator", blurb: "Four bar linkages and the Strandbeest leg, with coupler curves." },
];

export const TOTAL_SHEETS = 7;
const SLOW_KEY = "vellum.slow.";

export function reducedMotion() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

// Title block
export function buildTitleBlock(host, { no, title, scale = "NTS", root = "../../" }) {
  host.replaceChildren(
    cell("Project", "Vellum", "full"),
    cell("Sheet", no === "V" ? "V" : no === "00" ? "Cover" : `${no} of 0${TOTAL_SHEETS}`),
    cell("Rev", "A", "r"),
    cell("Title", title, "full"),
    cell("Drawn", "K. Chollacoop"),
    cell("Scale", scale, "r"),
    checkedCell(),
  );
}

function cell(k, v, cls = "") {
  return el("div", { class: cls }, el("span", { class: "k", text: k }), el("span", { class: "v", text: v }));
}

function checkedCell() {
  const v = el("span", { class: "v", text: "Pending", id: "checked-status" });
  return el("div", { class: "full" }, el("span", { class: "k", text: "Checked" }), v);
}

export function setChecked(state, no, root = "../../") {
  const v = document.getElementById("checked-status");
  if (!v) return;
  v.className = "v";
  const href = `${root}verify.html#sheet-${no}`;
  if (state === "verified") {
    v.className = "v verified";
    v.replaceChildren(el("a", { href, class: "ok", text: "Verified" }));
  } else if (state === "failed") {
    v.className = "v failed";
    v.replaceChildren(el("a", { href, class: "warn", text: "Fail, see checks" }));
  } else {
    v.replaceChildren(el("a", { href, text: state === "slow" ? "Pending, slow checks not run" : "Pending" }));
  }
}

export function markSlowPassed(id, passed) {
  try {
    if (passed) localStorage.setItem(SLOW_KEY + id, "pass");
    else localStorage.removeItem(SLOW_KEY + id);
  } catch { /* storage blocked */ }
}

export function slowPassed(id) {
  try {
    return localStorage.getItem(SLOW_KEY + id) === "pass";
  } catch {
    return false;
  }
}

// Runs this sheet's fast checks in a worker after load
export async function runSheetChecks(no, root = "../../") {
  const base = new URL(root, location.href);
  const [{ cases }, { createChecker }] = await Promise.all([
    import(new URL("verify/cases.js", base).href),
    import(new URL("verify/client.js", base).href),
  ]);
  const mine = cases.filter((c) => c.sheet === no);
  if (!mine.length) return;
  const check = createChecker(new URL("verify/worker.js", base));
  let allPass = true, slowMissing = false;
  for (const c of mine) {
    if (c.slow) {
      if (!slowPassed(c.id)) slowMissing = true;
      continue;
    }
    const res = await check(c.id);
    if (!res.pass) allPass = false;
  }
  const status = !allPass ? "failed" : slowMissing ? "slow" : "verified";
  setChecked(status, no, root);
  try { localStorage.setItem(`vellum.sheet.${no}`, status === "verified" ? "verified" : status); } catch { /* storage blocked */ }
}

export function initSheet(opts) {
  const host = document.querySelector(".title-block");
  if (host) buildTitleBlock(host, opts);
  const start = () => runSheetChecks(opts.no, opts.root).catch((e) => console.warn(e));
  if (typeof requestIdleCallback !== "undefined") requestIdleCallback(start, { timeout: 2000 });
  else setTimeout(start, 300);
}

// URL state
export function loadState(defaults, validate = () => true) {
  const s = readHashState();
  if (s && validate(s)) return s;
  return structuredClone(defaults);
}

export function saveState(s) {
  writeHashState(s);
}

export function wireCopyLink(button) {
  if (!button) return;
  button.addEventListener("click", async () => {
    const old = button.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => { button.textContent = old; }, 1400);
  });
}

// Boxed answer
export function setAnswer(id, value, unit = "", sub = "") {
  const box = document.getElementById(id);
  if (!box) return;
  box.querySelector(".v").firstChild.textContent = value;
  const u = box.querySelector(".u");
  if (u) u.textContent = unit ? ` ${unit}` : "";
  const s = box.querySelector(".s");
  if (s) s.textContent = sub;
}

// Keeps Greek letters lowercase inside uppercase labels
export function symText(str) {
  return String(str).split(/([\u0370-\u03ff][^\s]*)/).filter(Boolean)
    .map((part) => (/^[\u0370-\u03ff]/.test(part) ? el("span", { class: "sym", text: part }) : document.createTextNode(part)));
}

// First word is the label, the rest is a unit
function headLabel(h) {
  const [label, ...unit] = String(h).split(" ");
  const out = symText(label);
  if (unit.length) out.push(document.createTextNode(" "), el("span", { class: "sym", text: unit.join(" ") }));
  return out;
}

export function fillTable(table, headers, rows) {
  const thead = el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, headLabel(h)))));
  const tbody = el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", { text: String(c) })))));
  table.replaceChildren(thead, tbody);
}

// Exports
export function toCsv(headers, rows) {
  const q = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

export function download(name, content, mime = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCanvas(canvas, name) {
  canvas.toBlob((b) => b && download(name, b, "image/png"));
}

// Number input helper with inline validation
export function readNumber(input, { min = -Infinity, max = Infinity, name = "Value", positive = false } = {}) {
  const v = Number(input.value);
  const err = input.closest(".group, .field, fieldset")?.querySelector(".err") || null;
  let msg = "";
  if (input.value.trim() === "" || !Number.isFinite(v)) msg = `${name} must be a number.`;
  else if (positive && v <= 0) msg = `${name} must be greater than zero.`;
  else if (v < min) msg = `${name} must be at least ${min}.`;
  else if (v > max) msg = `${name} must be at most ${max}.`;
  input.setAttribute("aria-invalid", msg ? "true" : "false");
  if (err) err.textContent = msg;
  return msg ? null : v;
}
