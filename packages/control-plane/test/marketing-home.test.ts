import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import example from "../wrangler.toml.example?raw";

// The Worker test pool sandboxes the filesystem, so these load as raw modules
// at build time, the way every other suite here reads a fixture.
const sources = import.meta.glob<string>(
  ["../../webapp/public/home.html", "../../webapp/published-assets.json"],
  { eager: true, import: "default", query: "?raw" },
);
const home = sources["../../webapp/public/home.html"] ?? "";
const manifestSource = sources["../../webapp/published-assets.json"] ?? "";

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

  it("offers sign-in beside the primary call to action", () => {
    // Existing users need a way in that is not "Start free".
    expect(home).toContain('<a href="/auth/google/start">Sign in</a>');
    const signIn = home.indexOf(">Sign in<");
    const startFree = home.indexOf(">Start free<");
    expect(signIn).toBeGreaterThan(-1);
    expect(startFree).toBeGreaterThan(-1);
    expect(signIn).toBeLessThan(startFree);
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
