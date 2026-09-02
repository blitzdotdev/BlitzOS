/**
 * THE `<diffs-container>` REGISTRATION MUST SURVIVE THE BUNDLER.
 *
 * `@pierre/diffs` registers its diff-rendering custom element in a module
 * whose only export is a constant (`dist/components/web-components.js`), and
 * ships a `sideEffects` allowlist naming a `src/` path that does not exist in
 * the published package. The allowlist therefore matches nothing, the bundler
 * inlines the constant, drops the module, and `customElements.define` never
 * runs — every diff body in the product renders as an inert empty tag with no
 * shadow root and no error. Measured in a real Chromium against the production
 * build on 2026-09-01: shadow root empty forever, render worker healthy the
 * whole time. That was the "All Changes lists files but expands to nothing"
 * bug.
 *
 * `scripts/apply-vendor-patches.mjs` (postinstall) appends the real dist path
 * to the allowlist. This test pins BOTH halves the same way the i18n override
 * tests do: that our fix is applied, and that upstream still carries the
 * defect — so a fixed upstream release fails here and the postinstall step is
 * deleted instead of silently shadowing it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = resolve(process.cwd(), "../../node_modules/@pierre/diffs");
const manifest = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as {
  version: string;
  sideEffects: string[];
};

describe("@pierre/diffs custom-element registration", () => {
  it("keeps the postinstall sideEffects fix applied", () => {
    expect(
      manifest.sideEffects,
      "postinstall (scripts/apply-vendor-patches.mjs) must add the dist path — without it the bundler tree-shakes the <diffs-container> registration and every diff renders empty",
    ).toContain("dist/components/web-components.js");
  });

  it("still needs the fix: the module registers the element as a side effect only", () => {
    const source = readFileSync(resolve(pkgDir, "dist/components/web-components.js"), "utf8");
    expect(source).toContain("customElements.define");
    // The module's sole export is a constant; nothing else keeps it alive.
    expect(source).toContain("export { DiffsContainerLoaded }");
  });

  it("names the installed version in the postinstall fix, so a bump re-audits it", () => {
    const script = readFileSync(
      resolve(process.cwd(), "../../scripts/apply-vendor-patches.mjs"),
      "utf8",
    );
    expect(script).toContain(`version: "${manifest.version}"`);
  });
});
