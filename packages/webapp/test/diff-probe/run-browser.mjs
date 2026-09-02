/**
 * Serves the built probe and drives it in headless Chromium.
 * Usage: node run-browser.mjs <dist-dir>
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2];
if (!dist) throw new Error("usage: node run-browser.mjs <dist-dir>");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = normalize(url.pathname).replace(/^\/+/u, "");
  if (path === "" || path === "/") path = "index.html";
  const file = join(dist, path);
  if (!existsSync(file)) {
    res.writeHead(404).end("not found: " + path);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleLines = [];
page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) =>
  consoleLines.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`),
);

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__probe?.done === true, undefined, { timeout: 30000 })
  .catch(() => consoleLines.push("wait: probe never reported done"));

const probe = await page.evaluate(() => window.__probe);
console.log("PROBE:", JSON.stringify(probe, null, 2));
console.log("CONSOLE:");
for (const line of consoleLines) console.log("  " + line);

await browser.close();
server.close();
