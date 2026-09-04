/**
 * The five token-name collisions, and the two places the resolution has to
 * reach (plans/LODY-RUNTIME-DESIGN.md §5.2, plans/evidence/lody-phase0.md §3).
 *
 * `lody-tailwind-containment.test.ts` measures WHICH names collide. This one
 * pins what is DONE about them — including the half that is easy to forget,
 * because Radix mounts dropdowns, selects, popovers, tooltips and dialogs as
 * direct children of `document.body`, OUTSIDE the surface, where they inherit
 * our `:root` values again.
 *
 * WHAT CHANGED WITH THE RESKIN. Phase 3 resolved the four value-carrying names
 * with LODY's values, hand-written into `lody-surface-shell.css`, and said the
 * flip belonged in the theme layer. `src/lody/blitz-theme.ts` is that theme
 * layer, so the resolution is now:
 *
 * - `--muted` and `--hover` are BLITZ, converted to the HSL triplets Lody reads
 *   by the theme engine's own `hexColorToHslChannel`. They are declared by the
 *   GENERATED sheet, on the same three selectors the hand-written block used.
 * - `--terminal-background` and `--terminal-selection` are OURS, and have no
 *   rule at all: theirs derive from `--background` and `--selection`, which the
 *   Blitz theme now sets to `--paper` and `--selected`, so an override would
 *   restate the colour that is already there.
 * - `--font-mono` is ours, still by being unlayered. It never was broken.
 *
 * `lody-blitz-theme.test.ts` pins the VALUES. This file pins the REACH: which
 * selectors carry them, and that our own body-level portals stay excluded.
 *
 * A source test rather than a render test: jsdom's cascade would ignore the
 * whole question, and the portal rule's point is the elements it matches, which
 * only exist while a Radix menu is open.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { readBlitzPalette } from "../src/lody/blitz-palette";
import { blitzThemeStylesheet } from "../src/lody/blitz-theme";

const here = dirname(fileURLToPath(import.meta.url));
const shellCss = readFileSync(join(here, "..", "src", "lody", "lody-surface-shell.css"), "utf8");
const skinCss = readFileSync(join(here, "..", "src", "lody", "blitz-skin.css"), "utf8");
const generatedCss = blitzThemeStylesheet("dark", readBlitzPalette(null, "dark"));

/** The two the flip has to CARRY, because Lody reads them as bare triplets and
 * ours are finished colours — a type mismatch no aliasing can fix. */
const CONVERTED = ["--muted", "--hover"];

/** The two the flip DELETES: same type, and now the same value. */
const NO_LONGER_OVERRIDDEN = ["--terminal-background", "--terminal-selection"];

function rulesDeclaring(css: string, property: string): string[] {
  const selectors: string[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    rule.walkDecls((declaration) => {
      if (declaration.prop === property && declaration.parent === rule) {
        selectors.push(rule.selector);
      }
    });
  });
  return selectors;
}

describe("the Lody token collisions", () => {
  it("declares each converted token on the surface, the rail AND the portal root", () => {
    for (const token of CONVERTED) {
      const selectors = rulesDeclaring(generatedCss, token).join("\n");
      expect(selectors, token).toContain(".lody-surface");
      expect(selectors, token).toContain(".session-list--vendor");
      expect(selectors, token).toContain("body > ");
    }
  });

  it("needs no mode-aware rule any more, because the sheet is regenerated", () => {
    // Phase 3 shipped a second `:root.dark …` block, because a single
    // hand-written redeclaration would have frozen the surface into one of
    // Lody's two palettes. The sheet is now rebuilt per mode by
    // `applyBlitzSurfaceTheme`, so light and dark are two different sheets
    // rather than two rules — and `ShellThemeBridge` is what rewrites it.
    expect(generatedCss).not.toContain(":root.dark");
    const light = blitzThemeStylesheet("light", readBlitzPalette(null, "light"));
    for (const token of CONVERTED) {
      const dark = rulesDeclaring(generatedCss, token);
      expect(rulesDeclaring(light, token)).toHaveLength(dark.length);
    }
    expect(light).not.toBe(generatedCss);
  });

  it("stops overriding the two terminal names, in every sheet", () => {
    for (const token of NO_LONGER_OVERRIDDEN) {
      expect(rulesDeclaring(shellCss, token), token).toEqual([]);
      expect(rulesDeclaring(skinCss, token), token).toEqual([]);
      expect(rulesDeclaring(generatedCss, token), token).toEqual([]);
    }
  });

  it("excludes exactly the body-level portals BlitzOS itself renders", () => {
    // The portal rule reads "a body child that is not one of ours". Since the
    // files panel's context menu retired, BlitzOS renders nothing as a direct
    // child of `document.body`, so `#root` is the whole exclusion. A component
    // that starts portalling to the body has to be named here and in the rule,
    // or a Lody theme lands on a BlitzOS menu.
    // The token rule's selector is the whole surface scope — the surface, the
    // vendored rail body and the portal root in one list — so the portal part
    // is read out of it.
    const portalSelectors = rulesDeclaring(generatedCss, "--muted")
      .flatMap((selector) => selector.split(",").map((part) => part.trim()))
      .filter((part) => part.startsWith("body > "));
    expect(portalSelectors.length).toBeGreaterThan(0);
    for (const selector of portalSelectors) {
      expect(selector).toBe("body > :where(:not(#root))");
    }
  });

  it("reclaims the two names on :root, which nothing else can do", () => {
    // `LodyThemeProvider` writes every alias onto <html> as an INLINE style, so
    // with the surface mounted our own `tokens.css` values for `--muted` and
    // `--hover` were outranked on every NATIVE surface. This is the one rule in
    // the whole reskin that is about the shell rather than the surface.
    for (const token of CONVERTED) {
      const rootRules = rulesDeclaring(generatedCss, token).filter(
        (selector) => selector === ":root",
      );
      expect(rootRules, token).toHaveLength(1);
    }
    expect(generatedCss).toContain("!important");
  });
});
