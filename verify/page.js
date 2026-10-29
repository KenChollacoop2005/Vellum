// Verification sheet page
import { cases } from "./cases.js";
import { createChecker } from "./client.js";
import { el, buildTitleBlock, SHEETS, markSlowPassed, slowPassed } from "../core/sheet.js";

const $ = (id) => document.getElementById(id);
const SHEET_NAMES = Object.fromEntries(SHEETS.map((s) => [s.no, s.title]));
const results = new Map();
const check = createChecker(new URL("./worker.js", import.meta.url));

function fmtVal(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `${fmtVal(v[0])} to ${fmtVal(v[1])}`;
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a < 1e-4 || a >= 1e6) return v.toExponential(3);
  return String(Number(v.toPrecision(6)));
}

function fmtErr(r) {
  if (r.kind === "info" || r.kind === "bool") return "";
  if (!Number.isFinite(r.error)) return "n/a";
  if (r.kind === "rel" && r.expected !== 0) return `${(r.error * 100).toPrecision(2)} %`;
  return r.error === 0 ? "0" : r.error.toExponential(1);
}

function fmtTol(r) {
  if (r.kind === "rel") return r.expected === 0 ? (r.absTol ?? 1e-9).toExponential(0) : `${fmtVal(r.tol * 100)} %`;
  if (r.kind === "abs" || r.kind === "max") return r.tol.toExponential(0);
  if (r.kind === "range") return "range";
  if (r.kind === "bool") return "exact";
  return "";
}

function resultCell(state) {
  if (state === "ok") return el("td", { class: "res-ok", text: "OK" });
  if (state === "fail") return el("td", { class: "res-fail", text: "FAIL" });
  if (state === "info") return el("td", { class: "res-wait", text: "noted" });
  return el("td", { class: "res-wait", text: state });
}

function caseRows(c, res, extra = null) {
  const src = el("td", { class: "text" }, el("a", { href: c.source.url, text: c.source.label, rel: "noopener" }));
  const head = (n) => [
    el("td", { rowspan: String(n), text: c.id }),
    el("td", { rowspan: String(n), text: c.sheet }),
    el("td", { rowspan: String(n), class: "text desc", text: c.description }),
  ];
  if (!res) {
    const tr = el("tr", { id: `case-${c.id}` }, ...head(1), el("td", { class: "text", colspan: "4" }, extra || "waiting"),
      el("td", { text: "" }), resultCell(c.slow ? "not run" : "running"), src);
    return [tr];
  }
  return res.rows.map((r, i) => {
    const qty = el("td", { class: "text" }, r.quantity, r.note ? el("span", { class: "note", text: r.note }) : null);
    const u = r.unit && typeof r.computed === "number" ? ` ${r.unit}` : "";
    const cells = [qty, el("td", { text: fmtVal(r.expected) + (r.expected !== "" ? u : "") }), el("td", { text: fmtVal(r.computed) + u }),
      el("td", { text: fmtErr(r) }), el("td", { text: fmtTol(r) }), resultCell(r.kind === "info" ? "info" : r.pass ? "ok" : "fail")];
    const tr = el("tr", { id: i === 0 ? `case-${c.id}` : null }, ...(i === 0 ? head(res.rows.length) : []), ...cells);
    if (i === 0) tr.append(el("td", { rowspan: String(res.rows.length), class: "text" }, src.firstChild.cloneNode(true),
      c.slow ? el("span", { class: "note", text: res.stored ? `slow case, result from an earlier run in this browser (${(res.ms / 1000).toFixed(0)} s)` : `ran in ${(res.ms / 1000).toFixed(1)} s` }) : null,
      c.slow && res.stored ? rerunButton(c) : null));
    return tr;
  });
}

function rerunButton(c) {
  const btn = el("button", { type: "button", text: "Run again" });
  btn.addEventListener("click", () => {
    results.delete(c.id);
    renderCase(c);
    document.querySelector(`tr[data-case="${c.id}"] button`)?.click();
  });
  return el("span", { class: "note" }, btn);
}

function renderCase(c) {
  const body = document.getElementById(`sheet-${c.sheet}`);
  const old = body.querySelectorAll(`tr[data-case="${c.id}"]`);
  const res = results.get(c.id);
  let extra = null;
  if (c.slow && !res) {
    const prog = el("progress", { max: "1", value: "0", "aria-label": `${c.id} progress` });
    const btn = el("button", { type: "button", class: "primary", text: "Run" });
    btn.addEventListener("click", () => runSlow(c, btn, prog));
    extra = el("span", {}, btn, " ", prog, el("span", { class: "note", text: slowPassed(c.id) ? "passed earlier in this browser" : "slow, press Run" }));
  }
  const rows = caseRows(c, res, extra);
  rows.forEach((r) => r.setAttribute("data-case", c.id));
  if (old.length) {
    old[0].before(...rows);
    old.forEach((o) => o.remove());
  } else body.append(...rows);
}

const STORE = "vellum.slowres.";

function loadStored(c) {
  try {
    const r = JSON.parse(localStorage.getItem(STORE + c.id));
    if (r && Array.isArray(r.rows)) results.set(c.id, { ...r, stored: true });
  } catch { /* storage blocked or bad data */ }
}

async function runSlow(c, btn, prog) {
  btn.disabled = true;
  const res = await check(c.id, (p) => { prog.value = p; });
  results.set(c.id, res);
  markSlowPassed(c.id, res.pass);
  try { localStorage.setItem(STORE + c.id, JSON.stringify(res)); } catch { /* storage blocked */ }
  renderCase(c);
  summarize();
}

function build() {
  const table = $("checks");
  const order = [...new Set(cases.map((c) => c.sheet))].sort();
  for (const no of order) {
    const body = el("tbody", { id: `sheet-${no}` }, el("tr", { class: "group" }, el("th", { colspan: "10" },
      el("a", { href: `sheets/${SHEETS.find((s) => s.no === no).slug}/index.html`, text: `Sheet ${no}, ${SHEET_NAMES[no]}` }))));
    table.append(body);
  }
  for (const c of cases) {
    if (c.slow) loadStored(c);
    renderCase(c);
  }
}

function summarize() {
  const fast = cases.filter((c) => !c.slow);
  const doneFast = fast.filter((c) => results.has(c.id));
  const failed = cases.filter((c) => results.has(c.id) && !results.get(c.id).pass);
  const slowOk = cases.filter((c) => c.slow).every((c) => (results.has(c.id) ? results.get(c.id).pass : slowPassed(c.id)));
  const passedNow = [...results.values()].filter((r) => r.pass).length;
  const stored = [...results.values()].filter((r) => r.stored).length;
  let msg = `${passedNow} of ${cases.length} cases passed${stored ? ` (${stored} slow results from an earlier run in this browser)` : ""}.`;
  if (doneFast.length < fast.length) msg = `Running fast checks, ${doneFast.length} of ${fast.length} done.`;
  else if (failed.length) msg += ` ${failed.length} failing: ${failed.map((c) => c.id).join(", ")}.`;
  else if (!slowOk) msg += " Slow checks still need a run.";
  $("summary").textContent = msg;
  const allOk = doneFast.length === fast.length && !failed.length && slowOk;
  $("stamp").hidden = !allOk;
  if (allOk) $("stamp").replaceChildren(stampSvg());
  for (const s of SHEETS) {
    const mine = cases.filter((c) => c.sheet === s.no);
    const ok = mine.every((c) => (results.has(c.id) ? results.get(c.id).pass : c.slow && slowPassed(c.id)));
    const anyFail = mine.some((c) => results.has(c.id) && !results.get(c.id).pass);
    try { localStorage.setItem(`vellum.sheet.${s.no}`, ok ? "verified" : anyFail ? "failed" : "slow"); } catch { /* storage blocked */ }
  }
}

function stampSvg() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 220 130");
  svg.setAttribute("width", "220");
  svg.setAttribute("height", "130");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Checked ${date} K.C.`);
  svg.innerHTML = `<g transform="rotate(-7 110 65)" fill="none" stroke="#3E6B48">
    <rect x="12" y="14" width="196" height="102" rx="3" stroke-width="3"/>
    <rect x="19" y="21" width="182" height="88" rx="2" stroke-width="1.2"/>
    <text x="110" y="62" text-anchor="middle" fill="#3E6B48" stroke="none" font-family="Routed Gothic, B612, monospace" font-size="30" letter-spacing="4">CHECKED</text>
    <line x1="34" y1="72" x2="186" y2="72" stroke-width="1"/>
    <text x="110" y="96" text-anchor="middle" fill="#3E6B48" stroke="none" font-family="Routed Gothic, B612, monospace" font-size="14" letter-spacing="2">${date}   K.C.</text>
  </g>`;
  return svg;
}

async function runFast() {
  for (const c of cases.filter((x) => !x.slow)) {
    results.delete(c.id);
    renderCase(c);
  }
  summarize();
  for (const c of cases.filter((x) => !x.slow)) {
    results.set(c.id, await check(c.id));
    renderCase(c);
    summarize();
  }
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

build();
buildTitleBlock(document.querySelector(".title-block"), { no: "V", title: "Verification", root: "" });
document.getElementById("checked-status").textContent = "See stamp";
$("rerun").addEventListener("click", runFast);
$("run-slow").addEventListener("click", async () => {
  $("run-slow").disabled = true;
  for (const c of cases.filter((x) => x.slow)) {
    if (results.get(c.id)?.stored) { results.delete(c.id); renderCase(c); }
    const r2 = document.querySelector(`tr[data-case="${c.id}"]`);
    const b2 = r2?.querySelector("button"), p2 = r2?.querySelector("progress");
    if (b2 && p2 && !b2.disabled) await runSlow(c, b2, p2);
  }
  $("run-slow").disabled = false;
});
runFast();
