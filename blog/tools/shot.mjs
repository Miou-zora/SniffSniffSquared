// Render a local HTML file to a PNG at a fixed viewport, using the headless
// Chromium that mermaid-cli already installs. Used for blog banner / preview
// images that Medium and GitHub social cards need as raster.
//
//   node tools/shot.mjs <input.html> <output.png> [width] [height] [scale]
//
// Defaults: 1500x750 at 2x (a 2:1 preview card). No network; the HTML must be
// self-contained.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const [input, output, w = "1500", h = "750", scale = "2"] = process.argv.slice(2);

if (!input || !output) {
  console.error("usage: node tools/shot.mjs <input.html> <output.png> [w] [h] [scale]");
  process.exit(2);
}

const browser = await puppeteer.launch({ headless: "shell" });
try {
  const page = await browser.newPage();
  await page.setViewport({
    width: Number(w),
    height: Number(h),
    deviceScaleFactor: Number(scale),
  });
  await page.goto(pathToFileURL(input).href, { waitUntil: "networkidle0" });
  const buf = await page.screenshot({ type: "png" });
  await writeFile(output, buf);
  console.error(`wrote ${output} (${w}x${h} @${scale}x)`);
} finally {
  await browser.close();
}
