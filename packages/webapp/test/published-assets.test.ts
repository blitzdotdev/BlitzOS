import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// These files are untracked-by-accident bait: they live only in public/, no
// import references them, so nothing else in the build fails when they go
// missing. They went missing once — the deployed origin served /terms,
// /privacy, /security and /landing out of a working tree that had them while
// git did not, so a clean CI checkout would have deployed a site without them.
// This test and scripts/check-published-assets.mjs (which release.yml runs
// before deploying) read the same manifest. Never edit one side alone.
const manifestPath = resolve(process.cwd(), "published-assets.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: string[] };

describe("published static assets", () => {
  it("lists at least the legal pages", () => {
    expect(manifest.files).toEqual(
      expect.arrayContaining(["terms.html", "privacy.html", "security.html"]),
    );
  });

  it.each(manifest.files)("ships %s in public/", (name) => {
    const stats = statSync(resolve(process.cwd(), "public", name), { throwIfNoEntry: false });
    expect(
      stats?.isFile(),
      `${name} is in published-assets.json but missing from packages/webapp/public/`,
    ).toBe(true);
    expect(stats?.size ?? 0).toBeGreaterThan(0);
  });
});
