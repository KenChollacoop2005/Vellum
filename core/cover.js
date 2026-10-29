// Cover sheet index
import { SHEETS, el, buildTitleBlock, slowPassed } from "./sheet.js";

const rows = [...SHEETS, { no: "V", slug: null, title: "Verification", blurb: "Every benchmark check, run live in your browser." }];
const href = (s) => (s.slug ? `sheets/${s.slug}/index.html` : "verify.html");

function checkCell(no, label, cls = "") {
  const td = document.getElementById(`chk-${no}`);
  td.replaceChildren(el("a", { href: no === "V" ? "verify.html" : `verify.html#sheet-${no}`, text: label, class: cls }));
}

document.getElementById("index-rows").replaceChildren(...rows.map((s) => el("tr", {},
  el("td", { class: "no", text: s.no }),
  el("td", { class: "title" }, el("a", { href: href(s), text: s.title })),
  el("td", { class: "what", text: s.blurb }),
  el("td", { class: "chk", id: `chk-${s.no}`, text: "Checking" }))));

// Fast checks for every sheet, in a worker
async function runChecks() {
  const [{ cases }, { createChecker }] = await Promise.all([import("../verify/cases.js"), import("../verify/client.js")]);
  const check = createChecker(new URL("../verify/worker.js", import.meta.url));
  let allFast = true, allSlow = true;
  for (const s of SHEETS) {
    const mine = cases.filter((c) => c.sheet === s.no);
    let pass = true;
    for (const c of mine.filter((x) => !x.slow)) if (!(await check(c.id)).pass) pass = false;
    const slow = mine.filter((c) => c.slow);
    const slowOk = slow.every((c) => slowPassed(c.id));
    allFast &&= pass;
    allSlow &&= slowOk;
    if (!pass) checkCell(s.no, "Fail", "warn");
    else if (!slow.length || slowOk) checkCell(s.no, "Verified", "ok");
    else checkCell(s.no, "Fast pass, slow on V");
  }
  if (!allFast) checkCell("V", "Some checks fail", "warn");
  else if (allSlow) checkCell("V", "Verified", "ok");
  else checkCell("V", "Run slow checks");
}

runChecks().catch(() => { for (const s of rows) checkCell(s.no, "See checks"); });

document.getElementById("thumbs").replaceChildren(...rows.map((s) => el("a", { href: href(s) },
  el("img", { src: `media/thumbs/${s.no}.svg`, alt: `Sheet ${s.no} line drawing`, width: "160", height: "100" }),
  el("span", { text: `${s.no}  ${s.title.toUpperCase()}` }),
)));

buildTitleBlock(document.querySelector(".title-block"), { no: "00", title: "Cover sheet and index", root: "" });
document.querySelector("#checked-status").replaceChildren(el("a", { href: "verify.html", text: "See verification" }));
