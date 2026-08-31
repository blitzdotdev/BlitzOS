/**
 * The preview cannot lie again (plans/LODY-RUNTIME-DESIGN.md §17).
 *
 * WHAT WENT WRONG. The reskin was approved against a page that carried its own
 * stylesheet — a shell grid, a rule under the tab strip, a composer band — and
 * that loaded four of the sixteen stylesheets `main.tsx` loads. It therefore
 * showed borders and spacing the product had never had, and hid the two rules
 * that were stripping the vendored components in the product. The picture was
 * approved; the product could not produce it.
 *
 * The new preview (`surface-preview.html` → `test/surface-preview/`) is built
 * so that it CANNOT differ: every stylesheet it loads is one the product loads,
 * in the product's order, and it declares none of its own. This file is what
 * holds that property, because it is the sort of property that decays the
 * moment somebody needs "just one rule" to make the page sit right.
 *
 * The second half pins the two exclusions §17 added. Both are the same shape —
 * a product rule that reaches into Lody's mounts and must not — and both are
 * invisible in any harness that does not render the surface inside
 * `.drive-shell`, which is every harness this repo had.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const read = (...parts: string[]): string => readFileSync(join(...parts), "utf8");

const mainTsx = read(src, "main.tsx");
const previewEntry = read(here, "surface-preview", "entry.tsx");
const previewBody = read(here, "surface-preview", "body.tsx");
const sessionSurface = read(src, "lody", "SessionSurface.tsx");

/** Every `import "...css"` specifier in a file, in source order. */
function cssImports(source: string): string[] {
  return [...source.matchAll(/^import\s+["']([^"']+\.css)["'];/gmu)].map((match) => match[1] ?? "");
}

/** The basename, so `./tokens.css` and `../../src/tokens.css` compare equal. */
const base = (specifier: string): string => specifier.split("/").pop() ?? specifier;

describe("the preview loads the product's stylesheets and no others", () => {
  it("matches main.tsx's list, in main.tsx's order", () => {
    // Not a subset and not a superset: the same list. A stylesheet the preview
    // skips is a rule the reviewer never sees; one it adds is a rule the
    // product never has. Both produced the approved-picture failure.
    expect(cssImports(previewEntry).map(base)).toEqual(cssImports(mainTsx).map(base));
  });

  it("puts the Lody stylesheets behind the same lazy boundary the product does", () => {
    // In the product every Lody sheet is imported by `SessionSurface.tsx`,
    // which `LodySessionsRegion` reaches through a dynamic import, so in a
    // build they are emitted as a separate CSS file appended AFTER the entry
    // sheet. A preview that imported them at the entry level would put them
    // somewhere else in the cascade and could show a rule winning that loses
    // in production.
    expect(cssImports(previewBody).map(base)).toEqual(cssImports(sessionSurface).map(base));
    for (const lodySheet of cssImports(sessionSurface).map(base)) {
      expect(cssImports(previewEntry).map(base), lodySheet).not.toContain(lodySheet);
    }
  });

  it("declares no stylesheet of its own", () => {
    // The whole defect in one assertion. There is no `surface-preview/*.css`,
    // and the entry's only inline styling is the mode toggle, which is the
    // preview's own chrome rather than the subject being reviewed.
    for (const source of [previewEntry, previewBody]) {
      expect(source).not.toMatch(/import\s+["'][^"']*surface-preview[^"']*\.css["']/u);
    }
    const inlineStyled = [...previewEntry.matchAll(/style=\{\{/gu)].length;
    expect(inlineStyled).toBeLessThanOrEqual(2);
    expect(previewEntry).toContain("data-preview-chrome");
  });

  it("renders only class names the product renders", () => {
    // Every structural class on the page, checked against the file that draws
    // it in the product. A preview that invents a box can hide a missing one.
    const owners: Record<string, string[]> = {
      "drive-shell drive-shell--workspace": ["CloudApp.tsx"],
      "shell-nav": ["shell/ShellNav.tsx"],
      "shell-strip": ["shell/WorkspaceStrip.tsx"],
      "session-rail": ["shell/SessionRail.tsx"],
      "shell-rhead": ["shell/SessionRail.tsx"],
      "drive-ws-frame": ["CloudApp.tsx"],
      "webapp-workspace-view": ["CloudApp.tsx"],
      "session-list session-list--vendor": ["shell/SessionRail.tsx"],
    };
    for (const [className, files] of Object.entries(owners)) {
      const preview = `${previewEntry}\n${read(here, "surface-preview", "region.tsx")}`;
      expect(preview, className).toContain(className);
      const product = files.map((file) => read(src, file)).join("\n");
      // The product renders it as one string or as the last word of one.
      const leaf = className.split(" ").pop() ?? className;
      expect(product, `${leaf} is drawn by ${files.join(", ")}`).toContain(leaf);
    }
  });
});

/** Every top-level selector in a stylesheet, parentheses respected. */
function selectorsIn(css: string): string[] {
  const selectors: string[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    let depth = 0;
    let current = "";
    for (const character of rule.selector) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        selectors.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    if (current.trim() !== "") selectors.push(current.trim());
  });
  return selectors;
}

/** The exclusion §17 added, verbatim. */
const EXCLUSION =
  ":where(:not(.lody-surface, .lody-surface *, .session-list--vendor, .session-list--vendor *))";

describe("our own CSS stays out of Lody's two mounts", () => {
  /**
   * The elements the vendored surface renders that our global rules also
   * select. Every one of these was being reverted to a user-agent default in
   * the product, and in none of the harnesses.
   */
  const REACHED_ELEMENTS = ["button", "input", "select", "textarea", "a", "h1", "ul", "img", "table"];

  it("compensation: every shell-scoped rule excludes the Lody mounts", () => {
    // `lody-compensation.css` exists to give NATIVE elements their user-agent
    // defaults back after Tailwind's preflight. Scoped to `.drive-shell`, it
    // was also giving them back to Lody's elements — and `.lody-surface` is a
    // `.drive-shell` descendant in the product (`CloudApp.tsx`), which is
    // exactly the ancestor the file's own docblock warned about for `#root`.
    const css = read(src, "lody", "lody-compensation.css");
    const shellScoped = selectorsIn(css).filter((selector) => selector.includes(".drive-shell"));
    expect(shellScoped.length).toBeGreaterThan(0);
    for (const selector of shellScoped) {
      expect(selector, `${selector} may reach into the surface`).toContain(EXCLUSION);
    }
  });

  it("base: the global element resets exclude the Lody mounts", () => {
    // `button, input, select { font: inherit }` is unlayered, so inside the
    // surface it beat every `text-sm` in `@layer lody`: measured in Chrome, the
    // sidebar's "New session" label painted 16px/normal where Lody asks for
    // 14px/20px.
    const css = read(src, "webapp-base.css");
    for (const selector of selectorsIn(css)) {
      const bare = selector.trim();
      if (!REACHED_ELEMENTS.includes(bare.replace(EXCLUSION, ""))) continue;
      expect(bare, `${bare} in webapp-base.css reaches into the surface`).toContain(EXCLUSION);
    }
  });

  it("names both mounts in the exclusion, and costs no specificity", () => {
    // `:where()` is what keeps `lody-compensation.css` the zero-specificity
    // floor it advertises; a bare `:not(.lody-surface *)` would raise every one
    // of those rules to (0,1,0) and let them start beating our own CSS.
    expect(EXCLUSION.startsWith(":where(:not(")).toBe(true);
    expect(EXCLUSION).toContain(".lody-surface *");
    expect(EXCLUSION).toContain(".session-list--vendor *");
    for (const file of ["lody/lody-compensation.css", "webapp-base.css"]) {
      expect(read(src, ...file.split("/"))).toContain(EXCLUSION);
    }
  });
});
