/**
 * The Lody chunk must never enter the entry graph
 * (plans/LODY-RUNTIME-DESIGN.md §4.5).
 *
 * Phase 0 measured the cost of getting this wrong: the vendored renderer is
 * ~3.5 MB raw / 849 KB gzip, and ONE static import from `CloudApp.tsx` would
 * pull all of it into the bundle every member downloads, flag or no flag. The
 * flag defaults off, so the failure would be invisible — the surface never
 * renders and the bytes ship anyway.
 *
 * A source test rather than a bundle test: the bundle is 40 MB and takes
 * minutes to build, and the property being defended ("no module the entry
 * reaches names `SessionSurface` outside a dynamic import") is exactly a source
 * property.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(join(here, "..", "src", file), "utf8");

/** Every module the entry graph reaches that is allowed to name the surface. */
const ENTRY_MODULES = ["main.tsx", "CloudApp.tsx", "lody/LodySessionsRegion.tsx"];

/** A static `import … from "…SessionSurface"` — the thing that would pull the
 * vendored renderer into the entry chunk. `import(` and `lazy(async () =>
 * import(` are the two spellings that stay lazy, and neither matches. */
const STATIC_IMPORT = /(^|\n)\s*import\s+(?!type\b)[^;]*?from\s*["'][^"']*SessionSurface[^"']*["']/u;

describe("the Lody lazy boundary", () => {
  it("keeps every reference to SessionSurface behind a dynamic import", () => {
    for (const file of ENTRY_MODULES) {
      expect(STATIC_IMPORT.test(source(file)), file).toBe(false);
    }
  });

  it("reaches the surface through `import()` in both mount points", () => {
    expect(source("main.tsx")).toMatch(/import\(\s*['"]\.\/lody\/SessionSurface['"]\s*\)/u);
    expect(source("lody/LodySessionsRegion.tsx")).toMatch(
      /lazy\(async \(\) => await import\(["']\.\/SessionSurface\.js["']\)\)/u,
    );
  });

  it("gates both mount points on the flag", () => {
    // `LODY_SESSIONS_ENABLED` is false unless VITE_BLITZ_LODY_SESSIONS is
    // "true", and both entry points check it before importing anything.
    expect(source("main.tsx")).toContain("lodySessionsRequested");
    expect(source("lody/LodySessionsRegion.tsx")).toContain("LODY_SESSIONS_ENABLED");
  });
});
