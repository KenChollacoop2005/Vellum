// Screenshots of every page at two widths
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "media/screens");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const PAGES = [
  ["cover", "index.html"],
  ["01-frame", "sheets/01-frame/index.html"],
  ["02-beam-mohr", "sheets/02-beam-mohr/index.html"],
  ["03-topology", "sheets/03-topology/index.html"],
  ["04-wind-tunnel", "sheets/04-wind-tunnel/index.html"],
  ["05-laminate", "sheets/05-laminate/index.html"],
  ["06-vibrations", "sheets/06-vibrations/index.html"],
  ["07-linkage", "sheets/07-linkage/index.html"],
  ["verify", "verify.html"],
];
const SIZES = [[1440, 900], [390, 844]];

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
    try {
      const body = await readFile(join(ROOT, path || "index.html"));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const args = process.argv.slice(2);
const withSlow = args.includes("--with-slow");
const only = args.filter((a) => !a.startsWith("--"));
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
let problems = 0;
if (withSlow) {
  const page = await context.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + "verify.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => /passed|failing/.test(document.getElementById("summary").textContent) && !/Running/.test(document.getElementById("summary").textContent), null, { timeout: 120000 });
  await page.click("#run-slow");
  await page.waitForFunction(() => !document.getElementById("run-slow").disabled, null, { timeout: 1800000, polling: 2000 });
  console.log("slow checks:", await page.evaluate(() => document.getElementById("summary").textContent));
  await page.close();
}
const ordered = withSlow ? [...PAGES.filter(([n]) => n === "verify"), ...PAGES.filter(([n]) => n !== "verify")] : PAGES;
for (const [name, path] of ordered) {
  if (only.length && !only.includes(name)) continue;
  try {
    await readFile(join(ROOT, path));
  } catch {
    continue;
  }
  for (const [w, h] of SIZES) {
    const page = await context.newPage();
    await page.setViewportSize({ width: w, height: h });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(Number(process.env.SCREEN_WAIT || 1500));
    const info = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
    }));
    await page.screenshot({ path: join(OUT, `${name}-${w}.png`), fullPage: true });
    const hscroll = info.scrollW > w;
    if (errors.length || hscroll) problems++;
    console.log(`${name} ${w}: scrollW=${info.scrollW}${hscroll ? " HSCROLL" : ""} fonts=[${[...new Set(info.fonts)].join(", ")}]${errors.length ? " ERRORS: " + errors.join(" | ") : ""}`);
    await page.close();
  }
}
if (!only.length || only.includes("cover")) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "index.html", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(ROOT, "media/cover.png") });
  await page.close();
}
await browser.close();
server.closeAllConnections();
server.close();
if (problems) process.exitCode = 1;
