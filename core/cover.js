// Cover sheet index
import { SHEETS, el, buildTitleBlock } from "./sheet.js";

const rows = [...SHEETS, { no: "V", slug: null, title: "Verification", blurb: "Every benchmark check, run live in your browser." }];
const href = (s) => (s.slug ? `sheets/${s.slug}/index.html` : "verify.html");

function stored(no) {
  try {
    return localStorage.getItem(`vellum.sheet.${no}`);
  } catch {
    return null;
  }
}

function status(no) {
  if (no === "V") return SHEETS.every((s) => stored(s.no) === "verified") ? "verified" : null;
  return stored(no);
}

const LABELS = { verified: ["Verified", "ok"], failed: ["Fail", "warn"], slow: ["Pending", ""] };

document.getElementById("index-rows").replaceChildren(...rows.map((s) => {
  const [label, cls] = LABELS[status(s.no)] || ["Not run here yet", ""];
  return el("tr", {},
    el("td", { class: "no", text: s.no }),
    el("td", { class: "title" }, el("a", { href: href(s), text: s.title })),
    el("td", { class: "what", text: s.blurb }),
    el("td", { class: "chk" }, el("a", { href: s.no === "V" ? "verify.html" : `verify.html#sheet-${s.no}`, text: label, class: cls })));
}));

document.getElementById("thumbs").replaceChildren(...rows.map((s) => el("a", { href: href(s) },
  el("img", { src: `media/thumbs/${s.no}.svg`, alt: `Sheet ${s.no} line drawing`, width: "160", height: "100" }),
  el("span", { text: `${s.no}  ${s.title.toUpperCase()}` }),
)));

buildTitleBlock(document.querySelector(".title-block"), { no: "00", title: "Cover sheet and index", root: "" });
document.querySelector("#checked-status").replaceChildren(el("a", { href: "verify.html", text: "See verification" }));
