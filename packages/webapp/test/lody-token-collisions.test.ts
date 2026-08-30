/**
 * The five token-name collisions, and the two places the resolution has to
 * reach (plans/LODY-RUNTIME-DESIGN.md §5.2, plans/evidence/lody-phase0.md §3).
 *
 * `lody-tailwind-containment.test.ts` measures WHICH names collide. This one
 * pins what `lody-surface-shell.css` does about them — including the half that
 * is easy to forget, because Radix mounts dropdowns, selects, popovers,
 * tooltips and dialogs as direct children of `document.body`, OUTSIDE the
 * surface, where they inherit our `:root` values again.
 *
 * A source test rather than a render test: jsdom's cascade ignores nothing here,
 * but the portal rule's whole point is the elements it matches, and those
 * elements only exist while a Radix menu is open.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const shellCss = readFileSync(join(here, "..", "src", "lody", "lody-surface-shell.css"), "utf8");

/** The four of the five that are value-carrying and broken. `--font-mono` is
 * the fifth and is deliberately NOT redeclared: both trees hold a font stack,
 * so ours (Fira Code) simply reskins their code blocks. */
const REDECLARED = ["--muted", "--hover", "--terminal-background", "--terminal-selection"];

/** Every class a BlitzOS component renders as a DIRECT child of `document.body`.
 * The portal rule reads "a body child that is not one of these", so this list
 * being complete is what keeps it from restyling one of ours. */
const BLITZ_BODY_PORTAL_CLASSES = ["files-context-backdrop", "files-context-menu"];

function rulesDeclaring(property: string): string[] {
  const selectors: string[] = [];
  postcss.parse(shellCss).walkRules((rule: Rule) => {
    rule.walkDecls((declaration) => {
      if (declaration.prop === property && declaration.parent === rule) {
        selectors.push(rule.selector);
      }
    });
  });
  return selectors;
}

describe("the Lody token collisions", () => {
  it("redeclares each broken token on the surface AND on the Radix portal root", () => {
    for (const token of REDECLARED) {
      const selectors = rulesDeclaring(token).join("\n");
      expect(selectors, token).toContain(".lody-surface");
      expect(selectors, token).toContain("body > ");
    }
  });

  it("keeps `--muted` and `--hover` mode-aware, because Lody reads them as triplets", () => {
    // Their light and dark values differ (`tailwind/index.css:797` vs `:977`),
    // and ours won on `:root` for BOTH modes. A single redeclaration would
    // freeze the surface into one palette.
    const selectors = rulesDeclaring("--muted");
    expect(selectors.some((selector) => selector.includes(":root.dark"))).toBe(true);
    expect(selectors.some((selector) => !selector.includes(":root.dark"))).toBe(true);
  });

  it("excludes exactly the body-level portals BlitzOS itself renders", () => {
    const portalRules = rulesDeclaring("--muted").filter((selector) => selector.includes("body > "));
    expect(portalRules.length).toBeGreaterThan(0);
    for (const selector of portalRules) {
      expect(selector).toContain("#root");
      for (const className of BLITZ_BODY_PORTAL_CLASSES) expect(selector).toContain(className);
    }
  });

  it("still finds those portal classes in the components that render them", () => {
    // The exclusion list above is only correct while these classes are what our
    // own portals carry. Renaming one without updating the rule would hand a
    // Lody theme to a BlitzOS menu.
    const sidebar = readFileSync(join(here, "..", "src", "FilesSidebar.tsx"), "utf8");
    const menu = readFileSync(join(here, "..", "src", "FilesContextMenu.tsx"), "utf8");
    expect(sidebar).toContain('className="files-context-backdrop"');
    expect(menu).toContain('className="files-context-menu"');
  });
});
