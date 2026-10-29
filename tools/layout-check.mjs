// Solution panel must never overlap Method
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const SHEETS = ["01-frame", "02-beam-mohr", "03-topology", "04-wind-tunnel", "05-laminate", "06-vibrations", "07-linkage"];
const STEP = 120; // scroll step in pixels

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  try {
    const body = await readFile(join(ROOT, path || "index.html"));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
let failures = 0;
for (const s of SHEETS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}sheets/${s}/index.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => { document.querySelector("details.method").open = true; });
  await page.waitForTimeout(300);
  const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  let worst = 0, at = 0;
  for (let y = 0; y <= max + STEP; y += STEP) {
    await page.evaluate((v) => window.scrollTo(0, v), Math.min(y, max));
    await page.waitForTimeout(30);
    const overlap = await page.evaluate(() => {
      const a = document.querySelector(".solution").getBoundingClientRect();
      const b = document.querySelector("details.method").getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > 0 && h > 0 ? w * h : 0;
    });
    if (overlap > worst) { worst = overlap; at = y; }
  }
  if (worst > 0) failures++;
  console.log(`${s}: ${worst > 0 ? `FAIL overlap ${worst.toFixed(0)} px² at scroll ${at}` : "OK"}`);
  await page.close();
}
await browser.close();
server.closeAllConnections();
server.close();
process.exitCode = failures ? 1 : 0;
