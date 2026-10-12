#!/usr/bin/env node
// Step 4 (optional but recommended): screenshot the original page and the
// React route at the same widths and report the share of differing pixels.
// Only a number per width reaches the model; open diff-<w>.png only when a
// number is high.
// Usage: node visual-diff.mjs <original.html|url> <react-url> [--widths 1280,390] [--out dir] [--wait 800] [--hide "body > header"]
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

async function loadPlaywright() {
  const roots = [path.dirname(new URL(import.meta.url).pathname), process.cwd()];
  try {
    roots.push(execSync("npm root -g", { encoding: "utf8" }).trim());
  } catch {
    /* no global npm */
  }
  for (const r of roots) {
    for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
      try {
        const req = createRequire(path.join(r, r.endsWith("node_modules") ? "x" : "package.json"));
        const p = req.resolve(name);
        const mod = await import(pathToFileURL(p).href);
        return mod.chromium ? mod : mod.default;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important} nextjs-portal{display:none!important}`;

async function shoot(browser, url, width, wait, hide) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  // dev servers may reload the page once after compiling it: retry once
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => page.goto(url, { waitUntil: "load", timeout: 60000 }));
      await page.addStyleTag({ content: FREEZE + (hide ? `${hide}{display:none!important}` : "") });
      break;
    } catch (e) {
      if (attempt >= 1) throw e;
      await page.waitForTimeout(1500);
    }
  }
  // reveal-on-scroll libraries hide content until it is scrolled into view
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(wait);
  const buf = await page.screenshot({ fullPage: true });
  await page.close();
  return PNG.sync.read(buf);
}

function crop(png, w, h) {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, 0, 0, Math.min(w, png.width), Math.min(h, png.height), 0, 0);
  return out;
}

async function main() {
  const o = args(process.argv.slice(2));
  const [a, b] = o._;
  if (!a || !b) {
    console.error("usage: node visual-diff.mjs <original.html|url> <react-url> [--widths 1280,390] [--out dir] [--wait 800]");
    process.exit(2);
  }
  const pw = await loadPlaywright();
  if (!pw) {
    console.error("playwright not found. Install it next to the skill scripts: npm i --prefix <skill>/scripts playwright-core  (then point it at an installed Chromium via PLAYWRIGHT_BROWSERS_PATH or run `npx playwright install chromium`)");
    process.exit(3);
  }
  const urlA = /^https?:|^file:/.test(a) ? a : pathToFileURL(path.resolve(a)).href;
  const widths = (o.widths || "1280,390").split(",").map(Number);
  const out = path.resolve(o.out || ".h2r/visual");
  fs.mkdirSync(out, { recursive: true });
  const wait = Number(o.wait || 800);
  const browser = await pw.chromium.launch();
  const lines = [];
  try {
    for (const w of widths) {
      // --hide hides host-app chrome (site header, cookie bar) on the React side
      const [pa, pb] = [await shoot(browser, urlA, w, wait, null), await shoot(browser, b, w, wait, o.hide || null)];
      const h = Math.max(pa.height, pb.height);
      const A = crop(pa, w, h), B = crop(pb, w, h);
      const diff = new PNG({ width: w, height: h });
      const n = pixelmatch(A.data, B.data, diff.data, w, h, { threshold: 0.12 });
      fs.writeFileSync(path.join(out, `a-${w}.png`), PNG.sync.write(pa));
      fs.writeFileSync(path.join(out, `b-${w}.png`), PNG.sync.write(pb));
      fs.writeFileSync(path.join(out, `diff-${w}.png`), PNG.sync.write(diff));
      // first differing row: tells where to look without opening images
      let firstRow = -1;
      for (let y = 0; y < h && firstRow < 0; y++) for (let x = 0; x < w; x++) if (diff.data[(y * w + x) * 4] === 255 && diff.data[(y * w + x) * 4 + 1] === 0) {
        firstRow = y;
        break;
      }
      const pct = ((100 * n) / (w * h)).toFixed(2);
      lines.push(`${w}px: ${pct}% pixels differ | height original ${pa.height}px, react ${pb.height}px${firstRow >= 0 ? ` | first difference at y=${firstRow}px` : ""} -> ${path.relative(process.cwd(), path.join(out, `diff-${w}.png`))}`);
    }
  } finally {
    await browser.close();
  }
  console.log(lines.join("\n"));
  console.log("guide: <1% = same; 1-5% = fonts/antialiasing/images, check visually; >5% or a height mismatch = layout bug, open diff png");
}

main().catch((e) => {
  console.error(`visual-diff failed: ${e.message}`);
  process.exit(1);
});
