/**
 * Runs the BUILT probe bundle and prints what it measured.
 *
 * A child process, not a Vitest test body, for one reason: Vitest resolves
 * every `import()` through its own module graph, so a dynamic import of a
 * built file is intercepted and fails. Plain Node's loader has no such opinion.
 * The jsdom instance here is therefore hand-built rather than Vitest's.
 *
 * The globals are copied from the jsdom window with the TIMERS held back.
 * jsdom's `window.setTimeout` delegates to the global `setTimeout` of the same
 * name, so copying it onto `globalThis` makes every call recurse into itself;
 * Node's own timers drive jsdom perfectly well.
 *
 * Usage: node run-built.mjs <built-dir> [primed-localStorage-json]
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [builtDir, primedStorage] = process.argv.slice(2);
const html = readFileSync(join(builtDir, "index.html"), "utf8");
const entrySrc = /<script[^>]+src="([^"]+)"/u.exec(html)?.[1];
if (!entrySrc) throw new Error(`no module script in ${builtDir}/index.html`);
const entry = join(builtDir, entrySrc.replace(/^\//u, ""));

const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
  url: "http://localhost/",
});
const { window } = dom;

const SKIP = new Set([
  "window", "self", "top", "parent", "globalThis", "performance", "navigator",
  "setTimeout", "setInterval", "setImmediate",
  "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask",
]);
for (const key of Object.getOwnPropertyNames(window)) {
  if (SKIP.has(key)) continue;
  const value = window[key];
  if (value === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  } catch {
    // A global Node owns and refuses to redefine. jsdom's document does not
    // need it back.
  }
}
for (const [key, value] of [["window", window], ["self", window], ["navigator", window.navigator]]) {
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  } catch {
    // Same.
  }
}
window.matchMedia = (media) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
globalThis.matchMedia = window.matchMedia;

if (primedStorage) {
  for (const [key, value] of Object.entries(JSON.parse(primedStorage))) {
    window.localStorage.setItem(key, value);
  }
}

await import(pathToFileURL(entry).href);
process.stdout.write(`__PROBE__${JSON.stringify(window.__probe ?? null)}\n`);
