/**
 * The Blitz reskin of the vendored Lody surface, measured at the only place a
 * value can be measured without a browser: the theme engine's OUTPUT.
 *
 * WHY NOT `getComputedStyle`. Same reason `lody-tailwind-containment.test.ts`
 * gives at the top, one layer deeper: jsdom does not cascade custom properties
 * at all, so `getComputedStyle(el).getPropertyValue('--background')` is `""`
 * for every element under every stylesheet. What the browser will actually
 * paint is `createThemeCssVariables(blitzTheme)`, a plain record of finished
 * values, and `applyVSCodeThemeCssVariables` writes exactly that record onto an
 * element's inline style. So these assertions read the same bytes the browser
 * reads — they simply skip the cascade jsdom cannot run.
 *
 * FOUR THINGS THIS PINS.
 *
 * 1. The palette is `tokens.css`, not a copy of it. The literals and the
 *    `color-mix` ratios in `blitz-palette.ts` are parsed back out of
 *    `tokens.css` and compared, so a palette change there fails HERE rather
 *    than drifting silently into the surface.
 * 2. The five collisions, after the flip: `--muted` and `--hover` come out as
 *    HSL TRIPLETS carrying our colours, and the two terminal names are gone
 *    from the overlay because ours already win.
 * 3. The gold is dead. Vesper points `--primary`, `--ring` and
 *    `--tab-active-accent` at `#FFC799`, and the vendored sheet spends all
 *    three on document-wide outlines and inset rings.
 * 4. Every vendor hook `blitz-skin.css` targets still exists upstream.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import {
  createThemeCssVariables,
  getBundledVSCodeThemeByIdSync,
  hexColorToHslChannel,
} from "@lody/components/lib/vscode-theme";
import {
  BLITZ_ANSI_TOKENS,
  BLITZ_BASE_LITERALS,
  BLITZ_MIX_RATIOS,
  mixOklab,
  readBlitzPalette,
  type BlitzThemeMode,
} from "../src/lody/blitz-palette";
import {
  BLITZ_THEME_IDS,
  BLITZ_THEME_LABELS,
  RECLAIMED_ROOT_TOKENS,
  blitzThemeStylesheet,
  createBlitzVSCodeTheme,
  installBlitzVSCodeThemes,
} from "../src/lody/blitz-theme";
import { resolvedTheme, subscribeTheme } from "../src/theme";

const here = dirname(fileURLToPath(import.meta.url));
const webappSrc = join(here, "..", "src");
const vendorSrc = join(here, "..", "..", "..", "vendor", "lody", "packages", "components", "src");

const read = (...parts: string[]): string => readFileSync(join(...parts), "utf8");
const tokensCss = read(webappSrc, "tokens.css");
const skinCss = read(webappSrc, "lody", "blitz-skin.css");

/**
 * Every custom property `tokens.css` declares, per mode.
 *
 * The dark palette is the bare `:root` block; the light palette is the
 * `prefers-color-scheme: light` media block layered on top of it, which is what
 * a light browser actually computes. `:root[data-theme='…']` restates both, and
 * the third test below is what keeps those two spellings equal.
 */
function tokensFor(mode: BlitzThemeMode, selector?: string): Record<string, string> {
  const declared: Record<string, string> = {};
  const wanted = selector ?? ":root";
  postcss.parse(tokensCss).walkRules((rule: Rule) => {
    if (rule.selector !== wanted) return;
    const inMedia = rule.parent?.type === "atrule";
    // Dark is the bare `:root` block alone. Light is that block with the
    // `prefers-color-scheme: light` overrides applied on top, which is exactly
    // what a light browser computes — and why `--muted`'s recipe, declared only
    // once, is found for both modes.
    if (inMedia && (mode === "dark" || selector !== undefined)) return;
    rule.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) declared[declaration.prop] = declaration.value.trim();
    });
  });
  return declared;
}

const MODES: BlitzThemeMode[] = ["dark", "light"];

describe("the Blitz palette is tokens.css", () => {
  it.each(MODES)("states %s's base literals exactly as tokens.css declares them", (mode) => {
    const declared = tokensFor(mode);
    const literals = BLITZ_BASE_LITERALS[mode];
    const measured: Record<string, string> = {};
    for (const token of Object.keys(literals)) measured[token] = declared[token] ?? "MISSING";
    expect(measured).toEqual(literals);
  });

  it.each(MODES)("covers the whole ANSI ramp for %s", (mode) => {
    const declared = tokensFor(mode);
    for (const token of BLITZ_ANSI_TOKENS) expect(declared[token], token).toBeDefined();
  });

  it.each(MODES)("derives each %s mix at the ratio tokens.css declares", (mode) => {
    const declared = tokensFor(mode);
    for (const [token, recipe] of Object.entries(BLITZ_MIX_RATIOS[mode])) {
      const value = declared[token];
      expect(value, `${token} is not declared for ${mode}`).toBeDefined();
      // `color-mix(in oklab, var(--ink) 52%, var(--paper))`
      const match = /^color-mix\(in oklab,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*var\((--[\w-]+)\)\)$/u
        .exec(value ?? "");
      expect(match, `${token} for ${mode} is not an oklab color-mix: ${value ?? ""}`).not.toBeNull();
      expect([match?.[1], Number(match?.[2]), match?.[3]], `${token} for ${mode}`).toEqual([
        recipe.from,
        recipe.percent,
        recipe.over,
      ]);
    }
  });

  it("keeps the data-theme blocks equal to the media-query palettes", () => {
    // `readBlitzPalette` reads whichever of the two is active, so a divergence
    // would give the surface one palette and the shell the other.
    for (const mode of MODES) {
      const attribute = tokensFor(mode, `:root[data-theme='${mode}']`);
      const literals = BLITZ_BASE_LITERALS[mode];
      for (const [token, value] of Object.entries(literals)) {
        expect(attribute[token], `${token} under [data-theme='${mode}']`).toBe(value);
      }
    }
  });

  it("mixes in OKLab the way CSS does", () => {
    // Two anchors a mixer cannot fake: 0% is the base, 100% is the foreground.
    expect(mixOklab("#dfe2e8", "#16181d", 0)).toBe("#16181d");
    expect(mixOklab("#dfe2e8", "#16181d", 1)).toBe("#dfe2e8");
    // And one measured value: --hover is 7% ink over paper, which has to land
    // just above the paper rather than halfway to the ink.
    const hover = readBlitzPalette(null, "dark").hover;
    expect(hover).toMatch(/^#[0-9a-f]{6}$/u);
    expect(Number.parseInt(hover.slice(1, 3), 16)).toBeGreaterThan(0x16);
    expect(Number.parseInt(hover.slice(1, 3), 16)).toBeLessThan(0x30);
  });
});

describe("the compiled Blitz theme", () => {
  const compiled = (mode: BlitzThemeMode): Record<string, string> =>
    createThemeCssVariables(createBlitzVSCodeTheme(mode, readBlitzPalette(null, mode)));

  it.each(MODES)("paints %s on --paper, in --ink, with --accent", (mode) => {
    const palette = readBlitzPalette(null, mode);
    const variables = compiled(mode);
    expect(variables["--background"]).toBe(hexColorToHslChannel(palette.paper));
    expect(variables["--foreground"]).toBe(hexColorToHslChannel(palette.ink));
    expect(variables["--sidebar-background"]).toBe(hexColorToHslChannel(palette.paper));
    expect(variables["--primary"]).toBe(hexColorToHslChannel(palette.accent));
    expect(variables["--sidebar-hover"]).toBe(hexColorToHslChannel(palette.hover));
    expect(variables["--sidebar-selection"]).toBe(hexColorToHslChannel(palette.selected));
    expect(variables["--border"]).toBe(hexColorToHslChannel(palette.rule));
    expect(variables["--code-background"]).toBe(hexColorToHslChannel(palette.sunken));
    expect(variables["--status-success"]).toBe(hexColorToHslChannel(palette.live));
  });

  it.each(MODES)("resolves the two broken collisions to Blitz triplets in %s", (mode) => {
    const palette = readBlitzPalette(null, mode);
    const variables = compiled(mode);
    // The type conversion §5.2 asked for: ours are finished `color-mix()`
    // colours, theirs are read as `hsl(var(--muted))`, and this is the bridge.
    expect(variables["--hover"]).toBe(hexColorToHslChannel(palette.hover));
    expect(variables["--muted"]).toBe(hexColorToHslChannel(palette.sunken));
    for (const token of ["--hover", "--muted"]) {
      expect(variables[token], token).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/u);
    }
  });

  it.each(MODES)("leaves no Vesper gold anywhere the vendored sheet spends it (%s)", (mode) => {
    const palette = readBlitzPalette(null, mode);
    const variables = compiled(mode);
    const accent = hexColorToHslChannel(palette.accent);
    // `* { outline-ring/50 }`, `:focus-visible { inset ring --primary }` and
    // `[data-qs-active] { inset 2px ring --primary }` are document-wide rules in
    // `tailwind/index.css`; `--tab-active-accent` is the active tab's top edge.
    expect(variables["--ring"]).toBe(accent);
    expect(variables["--primary"]).toBe(accent);
    expect(variables["--highlight"]).toBe(accent);
    expect(variables["--tab-active-accent"]).toBe(accent);
    expect(variables["--sidebar-ring"]).toBe(accent);
    const vesperGold = hexColorToHslChannel("#FFC799");
    expect(Object.values(variables)).not.toContain(vesperGold);
    expect(Object.values(variables)).not.toContain("#FFC799");
  });

  it.each(MODES)("hands their terminal the BlitzOS ANSI ramp (%s)", (mode) => {
    const palette = readBlitzPalette(null, mode);
    const variables = compiled(mode);
    expect(variables["--vscode-terminal-ansiBlue"]).toBe(palette.ansi["--ansi-blue"].toUpperCase());
    expect(variables["--vscode-terminal-ansiGreen"]).toBe(
      palette.ansi["--ansi-green"].toUpperCase(),
    );
    expect(variables["--vscode-terminal-ansiBrightWhite"]).toBe(
      palette.ansi["--ansi-bright-white"].toUpperCase(),
    );
  });

  it("gives light and dark genuinely different values", () => {
    const dark = compiled("dark");
    const light = compiled("light");
    expect(dark["--background"]).not.toBe(light["--background"]);
    expect(dark["--primary"]).not.toBe(light["--primary"]);
    expect(dark["--sidebar-hover"]).not.toBe(light["--sidebar-hover"]);
  });

  it("names every collision the :root reclaim has to cover", () => {
    // The one measurement that keeps `RECLAIMED_ROOT_TOKENS` honest: the names
    // Lody's compiled variables share with `tokens.css`. Anything in this set
    // is a BlitzOS token an inline `<html>` style would overwrite.
    const ours = new Set(Object.keys(tokensFor("dark")));
    const collisions = Object.keys(compiled("dark"))
      .filter((name) => ours.has(name))
      .sort();
    expect(collisions).toEqual([...RECLAIMED_ROOT_TOKENS]);
  });
});

describe("the generated stylesheet", () => {
  const sheet = blitzThemeStylesheet("dark", readBlitzPalette(null, "dark"));

  it("scopes the variables to the surface, the rail and the Radix portals", () => {
    expect(sheet).toContain(".lody-surface");
    expect(sheet).toContain(".session-list--vendor");
    expect(sheet).toContain("body > :where(:not(#root))");
  });

  it("points their two font names at ours", () => {
    expect(sheet).toContain("--font-sans: var(--font-ui);");
    expect(sheet).toContain("--font-terminal: var(--font-mono);");
    // `--font-mono` is the fifth collision and is deliberately NOT restated:
    // both trees hold a font stack and ours wins by being unlayered.
    expect(sheet).not.toContain("--font-mono:");
  });

  it("reclaims --muted and --hover on :root, as color-mix and !important", () => {
    // `!important` is the only author declaration that beats the inline style
    // `applyVSCodeThemeCssVariables` writes on <html>. `color-mix` rather than a
    // hex snapshot, so the reclaim keeps tracking --ink and --paper.
    for (const token of RECLAIMED_ROOT_TOKENS) {
      expect(sheet).toMatch(
        new RegExp(`${token}: color-mix\\(in oklab, var\\(--\\w+\\) \\d+%, var\\(--paper\\)\\) !important;`, "u"),
      );
    }
  });

  it("carries the same values for light", () => {
    const light = blitzThemeStylesheet("light", readBlitzPalette(null, "light"));
    expect(light).not.toBe(sheet);
    expect(light).toContain("Blitz light");
  });
});

describe("the vendored theme registry", () => {
  it("answers with Blitz for the two ids the fixed selection names", () => {
    // Must be seeded before anything resolves them: `bundledThemesById` never
    // replaces an entry. `SessionSurface` seeds during the render that creates
    // `ThemeProvider`, which is before their layout effect reads it.
    expect(installBlitzVSCodeThemes(null, "dark")).toBe(true);
    for (const mode of MODES) {
      const theme = getBundledVSCodeThemeByIdSync(BLITZ_THEME_IDS[mode]) as
        | { label: string; type: string }
        | undefined;
      expect(theme?.label, mode).toBe(BLITZ_THEME_LABELS[mode]);
      expect(theme?.type, mode).toBe(mode);
    }
  });

  it("still targets the ids their selection module declares", () => {
    const source = read(vendorSrc, "lib", "vscode-theme", "theme-selection-storage.ts");
    expect(source).toContain(`lightThemeId: '${BLITZ_THEME_IDS.light}'`);
    expect(source).toContain(`darkThemeId: '${BLITZ_THEME_IDS.dark}'`);
    // And the provider is still the one that pins the selection, so there is
    // still no picker a member could move off these two ids.
    const provider = read(vendorSrc, "theme-provider.tsx");
    expect(provider).toContain("FIXED_VSCODE_THEME_SELECTION = DEFAULT_VSCODE_THEME_SELECTION");
  });
});

describe("the overlay's vendor hooks", () => {
  /** Each class or attribute `blitz-skin.css` selects, and the vendor file that
   * has to keep rendering it. An upstream rename fails here instead of quietly
   * reverting one rule of the skin. */
  const HOOKS: { hook: string; file: string[] }[] = [
    { hook: "data-sidebar-session-id", file: ["components", "session-list.tsx"] },
    { hook: "bg-sidebar-foreground/10", file: ["components", "session-list.tsx"] },
    { hook: "text-sm", file: ["components", "session-list.tsx"] },
    { hook: "text-primary", file: ["components", "sidebar-row-shared.tsx"] },
    { hook: "bg-primary", file: ["components", "sidebar-row-shared.tsx"] },
    { hook: "viewportClassName", file: ["components", "loro-sidebar.tsx"] },
    // Wave 4, C3: the side panel's tab strip. The attribute is upstream's own
    // marker on the panel, and the tablist is inside their `ScrollArea`.
    {
      hook: 'data-lody-session-tab-region="side-panel"',
      file: ["components", "sessions", "session-detail.tsx"],
    },
    // The footer's icon buttons (seam patches 13 and 18): the class is the
    // rest-state colour `getLoroSidebarFooterIconButtonClassName` spends.
    { hook: "text-sidebar-foreground dark:text-sidebar-foreground-muted", file: ["components", "loro-sidebar.tsx"] },
  ];

  it.each(HOOKS)("still finds $hook in the vendored source", ({ hook, file }) => {
    expect(read(vendorSrc, ...file)).toContain(hook);
  });

  it("uses each hook in the skin", () => {
    for (const { hook } of HOOKS) {
      if (hook === "viewportClassName") continue; // the prop, not the selector
      // The skin selects on the first class of a two-class hook.
      const [selector] = hook.split(" ");
      expect(skinCss).toContain((selector ?? hook).replace("/", "\\/"));
    }
    expect(skinCss).toContain("[data-radix-scroll-area-viewport]");
  });

  it("keeps the rail's row geometry equal to the native row's", () => {
    // `.shell-s` is the native row — "Shared with you", drawn below the
    // vendored Chats rows in the same list (`strip-rail.css`, mockup `.s`). The
    // two have to be one row or the rail reads as two components.
    const railCss = read(webappSrc, "strip-rail.css");
    const nativeRow = /\.shell-s \{([^}]*)\}/u.exec(railCss)?.[1] ?? "";
    const vendorRow =
      /\.session-list--vendor \[data-sidebar-session-id\] \{([^}]*)\}/u.exec(skinCss)?.[1] ?? "";
    for (const declaration of ["height: 31px", "padding: 0 9px", "border-radius: var(--r-item)"]) {
      const [property] = declaration.split(":");
      expect(nativeRow, `native row ${property ?? ""}`).toContain(declaration);
      expect(vendorRow, `vendored row ${property ?? ""}`).toContain(declaration);
    }
    expect(vendorRow).toContain("color: var(--soft-ink)");
    expect(nativeRow).toContain("color: var(--soft-ink)");
  });
});

/**
 * A controllable `prefers-color-scheme: light` query.
 *
 * jsdom implements no `matchMedia` at all, and the OS half of the subscription
 * is the half that has no DOM change to watch — under `system` the page
 * repaints with nothing in the document moving. So the stub is not scaffolding
 * around an inconvenience: it is the only way to drive that path.
 */
class PrefersLightQuery extends EventTarget {
  media = "(prefers-color-scheme: light)";
  onchange = null;
  matches = false;
  addListener(): void {}
  removeListener(): void {}
}

function installPrefersLight(): { set: (light: boolean) => void; restore: () => void } {
  const query = new PrefersLightQuery();
  const previous = window.matchMedia;
  window.matchMedia = () => query;
  return {
    set: (light: boolean) => {
      query.matches = light;
      // A real event on a real EventTarget, so the subscription's own
      // `addEventListener('change', …)` is what runs — not a stub's callback
      // list standing in for it.
      query.dispatchEvent(new Event("change"));
    },
    restore: () => {
      window.matchMedia = previous;
    },
  };
}

let media: ReturnType<typeof installPrefersLight> | null = null;

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  media?.restore();
  media = null;
});

describe("the shell theme subscription", () => {
  it("resolves `system` against the media query, not to a constant", () => {
    // The bug this replaces: `adoptShellTheme` mapped `system` to dark, so the
    // surface stayed dark on a light laptop while `tokens.css` painted the shell
    // light out of its `prefers-color-scheme` block.
    media = installPrefersLight();
    expect(resolvedTheme()).toBe("dark");
    media.set(true);
    expect(resolvedTheme()).toBe("light");
    // An explicit choice still outranks the OS, in both directions.
    document.documentElement.setAttribute("data-theme", "dark");
    expect(resolvedTheme()).toBe("dark");
    document.documentElement.setAttribute("data-theme", "light");
    media.set(false);
    expect(resolvedTheme()).toBe("light");
  });

  it("notices an OS flip, which moves no attribute at all", () => {
    media = installPrefersLight();
    const seen: string[] = [];
    const stop = subscribeTheme((theme) => seen.push(theme));
    try {
      media.set(true);
      media.set(false);
      expect(seen).toEqual(["light", "dark"]);
    } finally {
      stop();
    }
  });

  it("fires once per real change and never on a no-op", async () => {
    media = installPrefersLight();
    const seen: string[] = [];
    const stop = subscribeTheme((theme) => seen.push(theme));
    try {
      document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
      // Writing the same value again is not a repaint.
      document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
      document.documentElement.setAttribute("data-theme", "dark");
      await Promise.resolve();
      expect(seen).toEqual(["light", "dark"]);
    } finally {
      stop();
    }
  });

  it("stops listening when released", async () => {
    media = installPrefersLight();
    const seen: string[] = [];
    subscribeTheme((theme) => seen.push(theme))();
    document.documentElement.setAttribute("data-theme", "light");
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});

describe("the reskin reaches nothing outside the vendored zone", () => {
  /**
   * Every element the NATIVE product renders that sits beside the surface, or
   * around it. `div.shell-rhead` is the one the review page shows: it is the
   * rail's own head, above the vendored list region, styled by `strip-rail.css`
   * alone.
   */
  const NATIVE_PROBES = `
    <div id="root">
      <div class="drive-shell">
        <aside class="shell-strip"><button class="shell-wtile"></button></aside>
        <aside class="session-rail">
          <div class="shell-rhead"><b>Workspace</b><span class="shell-rhead__sub"></span>
            <button class="shell-ib"><span class="shell-ib__glyph"></span></button></div>
          <div class="shell-newbar"><button class="shell-new"></button></div>
          <div class="session-list">
            <button class="shell-s shell-s--on"><span class="shell-g"></span>
              <span class="shell-s__t">tab</span><span class="shell-s__a"></span></button>
          </div>
        </aside>
        <div class="cfg-section"><h2 class="cfg-title">Agent rules</h2></div>
        <button>New tab</button><input /><a href="#">link</a>
      </div>
    </div>`;

  /** Every top-level selector in a sheet, parens respected. */
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

  it("matches no native element, from either sheet", () => {
    // The exact form of "the theme has zero effect on `.shell-rhead`": not that
    // its computed style is unchanged — jsdom's cascade could not answer that —
    // but that no rule of ours SELECTS it in the first place. Selector matching
    // is jsdom's own `Element.matches`, which is reliable; the cascade is never
    // consulted. This is the same method `lody-tailwind-containment.test.ts`
    // uses, pointed the other way: there, what leaks into us; here, what of ours
    // leaks out.
    document.body.innerHTML = NATIVE_PROBES;
    const elements = [...document.querySelectorAll("#root, #root *")];
    const generated = blitzThemeStylesheet("dark", readBlitzPalette(null, "dark"));
    const reached: string[] = [];
    for (const selector of [...selectorsIn(skinCss), ...selectorsIn(generated)]) {
      // The `:root` reclaim is deliberate and is the ONE rule that is about the
      // shell rather than the surface: it puts `tokens.css`'s own `--muted` and
      // `--hover` back after their inline `<html>` style overwrote them.
      if (selector === ":root") continue;
      for (const element of elements) {
        try {
          if (element.matches(selector)) reached.push(`${selector} -> ${element.className}`);
        } catch {
          // A selector jsdom's engine cannot evaluate matches no element here.
        }
      }
    }
    expect(reached).toEqual([]);
  });

  it("touches :root for exactly the two reclaimed tokens and nothing else", () => {
    const generated = blitzThemeStylesheet("dark", readBlitzPalette(null, "dark"));
    const declared: string[] = [];
    postcss.parse(generated).walkRules((rule: Rule) => {
      if (rule.selector !== ":root") return;
      rule.walkDecls((declaration) => {
        declared.push(declaration.prop);
      });
    });
    expect(declared.sort()).toEqual([...RECLAIMED_ROOT_TOKENS]);
    expect(selectorsIn(skinCss)).not.toContain(":root");
  });
});
