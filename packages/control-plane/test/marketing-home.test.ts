import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { perSessionResponse } from "../core/http.js";
import example from "../wrangler.toml.example?raw";

// The Worker test pool sandboxes the filesystem, so these load as raw modules
// at build time, the way every other suite here reads a fixture.
const sources = import.meta.glob<string>(
  ["../../webapp/public/home.html", "../../webapp/published-assets.json"],
  { eager: true, import: "default", query: "?raw" },
);
const home = sources["../../webapp/public/home.html"] ?? "";
const manifestSource = sources["../../webapp/published-assets.json"] ?? "";

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  hellip: "…",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: "\u00a0",
  ndash: "–",
  quot: '"',
  reg: "®",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/giu,
    (entity, reference: string) => {
      if (!reference.startsWith("#")) return HTML_ENTITIES[reference.toLowerCase()] ?? entity;
      const hexadecimal = reference[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(reference.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function visibleCopyWordCount(html: string): number {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1] ?? "";
  const visibleCopy = decodeHtmlEntities(
    body
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<[^>]*>/gu, " "),
  ).replace(/\s+/gu, " ").trim();
  return visibleCopy === "" ? 0 : visibleCopy.split(/\s+/u).length;
}

// The root serves the marketing page to a visitor with no session and the app
// shell to everyone else. That switch lives in src/worker.ts, which the Worker
// test pool cannot mount a route table for, so the parts asserted here are the
// ones that silently stop working: the asset must exist, the config must route
// the root to the Worker, and the page must point at real routes.
describe("marketing home", () => {
  it("routes the exact root to the Worker, never as a prefix", () => {
    const config = parse(example) as { assets?: { run_worker_first?: string[] } };
    const routes = config.assets?.run_worker_first ?? [];
    expect(routes).toContain("/");
    // "/*" would send every asset request through the Worker and break the SPA.
    expect(routes).not.toContain("/*");
  });

  it("keeps the root out of every shared cache", () => {
    // The asset binding answers with the headers of the file it served, and
    // both files are public. Storing either copy under the bare "/" key hands
    // one visitor's answer to the next one: marketing to a signed-in person,
    // or the app shell to a stranger.
    const asset = new Response("<!doctype html>", {
      headers: { "Cache-Control": "public, max-age=0, must-revalidate", "Content-Type": "text/html" },
    });

    const served = perSessionResponse(asset);

    expect(served.headers.get("Cache-Control")).toBe("private, no-store");
    expect(served.headers.get("Vary")).toBe("Cookie");
    expect(served.headers.get("Content-Type")).toBe("text/html");
  });

  it("offers sign-in beside the primary call to action", () => {
    // Existing users need a way in that is not "Start free".
    expect(home).toContain('<a href="/auth/google/start">Sign in</a>');
    const signIn = home.indexOf(">Sign in<");
    const startFree = home.indexOf(">Start free<");
    expect(signIn).toBeGreaterThan(-1);
    expect(startFree).toBeGreaterThan(-1);
    expect(signIn).toBeLessThan(startFree);
  });

  it("does not use the AI operating system framing", () => {
    expect(
      /AI operating system/iu.test(home),
      'home.html must not contain the phrase "AI operating system"',
    ).toBe(false);
  });

  it("keeps visible copy at or below 300 words", () => {
    const count = visibleCopyWordCount(home);
    expect(count, `home.html visible copy word count is ${String(count)}`).toBeLessThanOrEqual(300);
  });

  it("resolves every in-page anchor to a document id", () => {
    const ids = new Set(Array.from(home.matchAll(/\sid="([^"]+)"/gu), (match) => match[1]));
    const anchors = Array.from(home.matchAll(/\shref="#([^"]+)"/gu), (match) => match[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(ids, `missing id="${anchor}"`).toContain(anchor);
  });

  it("sends every call to action to a route that exists", () => {
    // Pointing at the bare domain would reload this page rather than sign
    // anyone in, which is what the source page did.
    expect(home).not.toContain('href="https://blitzos.com">Start free');
    const ctas = home.match(/href="([^"]*)"[^>]*>\s*Start free/gu) ?? [];
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) expect(cta).toContain('href="/auth/google/start"');
  });

  it("references only assets this deployment serves", () => {
    // /agents.md is a teenyapp platform page and 404s here.
    expect(home).not.toContain("/agents.md");
    for (const asset of ["/workspace.png"]) expect(home).toContain(asset);
  });

  it("lists its assets in the published manifest, so a deploy cannot drop them", () => {
    const manifest = JSON.parse(manifestSource) as { files: string[] };
    expect(manifest.files).toContain("home.html");
    expect(manifest.files).toContain("workspace.png");
  });
});
