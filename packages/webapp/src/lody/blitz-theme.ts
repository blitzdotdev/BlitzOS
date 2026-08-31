/**
 * "Blitz Dark" and "Blitz Light", compiled through Lody's own VS Code theme
 * engine (plans/LODY-RUNTIME-DESIGN.md §5.2's last paragraph, §5.3).
 *
 * WHY A VS CODE THEME AND NOT A STYLESHEET. Every colour the Lody surface
 * paints comes from one of ~70 semantic custom properties — `--background`,
 * `--sidebar-hover`, `--primary`, `--code-background`, `--syntax-*` — and their
 * Tailwind preset reads all of them as bare HSL triplets
 * (`hsl(var(--muted) / <alpha>)`). Those properties are not authored anywhere.
 * They are COMPILED at runtime from a VS Code colour theme by
 * `lib/vscode-theme/vscode-theme-css.ts`, whose `LODY_ALIAS_RULES` table maps
 * each one to an ordered list of VS Code colour ids. So the way to reskin the
 * surface is to hand that compiler a theme built out of BlitzOS tokens, and
 * leave every component class alone. Overriding the ~70 properties by hand
 * would be a second copy of their alias table, and it would go stale at the
 * next merge without saying so.
 *
 * WHAT THE ENGINE GIVES US FOR FREE. `hexColorToHslChannel` is the type
 * conversion the five-collision note called for: `--muted` and `--hover` come
 * out as `H S% L%` triplets derived from OUR palette, so Lody's `hsl(var(…))`
 * reads a Blitz colour instead of a Lody one. The same theme also drives their
 * xterm palette (`createVSCodeTerminalTheme`) and the Shiki theme their diff
 * viewer registers, so the terminal's ANSI ramp and code-block syntax come from
 * `tokens.css` too, through one object rather than three stylesheets.
 *
 * TWO APPLICATION POINTS, WITH DIFFERENT JOBS.
 *
 * 1. `installBlitzVSCodeThemes()` registers the two themes in the vendored
 *    bundle registry under the two ids their FIXED selection names
 *    (`theme-selection-storage.ts:10`: `lody-light` and `vesper`). The app ships
 *    no theme picker — `theme-provider.tsx:42` pins the selection — so those two
 *    ids are simply "the light theme" and "the dark theme", and registering
 *    Blitz under them is how `LodyThemeProvider` comes to apply it. Everything
 *    downstream of `useActiveVSCodeTheme` follows without another hook.
 * 2. `applyBlitzSurfaceTheme()` writes the SAME compiled variables into a
 *    stylesheet of our own, scoped to `.lody-surface`, the rail's vendored zone
 *    and the Radix body portals. `LodyThemeProvider` applies its variables as an
 *    INLINE style on `<html>`, which reaches the surface only by inheritance —
 *    and a declaration on the element always beats an inherited value. So this
 *    sheet is what makes the surface's palette independent of the html element,
 *    and it is what carries the theme into a portal that mounts outside `#root`.
 *
 * AND ONE RECLAIM. `applyVSCodeThemeCssVariables` writes every alias name onto
 * `<html>`, `--muted` and `--hover` included, and an inline style outranks our
 * `:root` rule in `tokens.css`. Those two names are also BlitzOS tokens, and
 * ours are finished colours while theirs are triplets — so with the surface
 * mounted, 150-odd `var(--muted)` / `var(--hover)` sites across the NATIVE
 * webapp resolved to an invalid colour. The generated sheet restates both on
 * `:root` with `!important`, which is the one thing that beats an inline style.
 * It restates them as `color-mix()` expressions built from the ratio table in
 * `blitz-palette.ts`, so they keep tracking `--ink` and `--paper` rather than
 * freezing a snapshot.
 */
import {
  applyVSCodeThemeCssVariables,
  createThemeCssVariables,
  getBundledVSCodeThemeByIdSync,
  resolveBundledVSCodeThemesFromExtensions,
  resolveVSCodeThemeSync,
} from "@lody/components/lib/vscode-theme";
import {
  BLITZ_MIX_RATIOS,
  mixOklab,
  readBlitzPalette,
  type BlitzPalette,
  type BlitzThemeMode,
} from "./blitz-palette.js";
import { LODY_SURFACE_CLASS } from "./surface-class.js";

/**
 * The two ids `FIXED_VSCODE_THEME_SELECTION` asks for
 * (`vendor/lody/packages/components/src/lib/vscode-theme/theme-selection-storage.ts:10`).
 *
 * They are ids, not names a member ever sees: the surface mounts no theme
 * picker, so "the dark theme" and `vesper` are the same thing here. Registering
 * under them is what makes `LodyThemeProvider` apply Blitz without a vendor
 * edit; the human-readable half is `label`, below.
 */
export const BLITZ_THEME_IDS = {
  dark: "vesper",
  light: "lody-light",
} as const satisfies Record<BlitzThemeMode, string>;

export const BLITZ_THEME_LABELS = {
  dark: "Blitz Dark",
  light: "Blitz Light",
} as const satisfies Record<BlitzThemeMode, string>;

/** The id of the `<style>` element `applyBlitzSurfaceTheme` owns. */
const SHEET_ELEMENT_ID = "blitz-lody-theme";

/**
 * What `resolveVSCodeThemeSync` hands back, narrowed to what this file reads.
 *
 * Their `LodyResolvedVSCodeTheme` cannot cross the vendor type seam — every
 * `@lody/*` export is `any` (`vendor-modules.d.ts`) — so this states the
 * contract on our side, the same convention `SessionRailSidebar`'s
 * `LodySessionRow` follows. The whole value travels straight back into their
 * own functions; `id`, `label` and `type` are the three fields we assert on.
 */
export interface BlitzResolvedTheme {
  readonly id: string;
  readonly label: string;
  readonly type: string;
}

/**
 * A VS Code theme's `colors` block: a workbench colour id to a hex colour.
 *
 * The id set is open by definition — it is VS Code's, it grows with each
 * release, and a theme may set any subset — so the contract that matters is the
 * VALUE, which their loader pins as `z.record(z.string(), HexColorSchema)`
 * (`vscode-theme-schemas.ts:69`) and rejects if it is not `#RGB`/`#RRGGBB(AA)`.
 */
export type VSCodeColorMap = Record<string, string>;

/**
 * One TextMate rule, as `TextMateTokenColorRuleSchema` accepts it
 * (`vscode-theme-schemas.ts:33`). Only the foreground form is used here: the
 * `--syntax-*` aliases are resolved by `findTokenForeground`, which reads
 * nothing else.
 */
export interface BlitzTokenColorRule {
  readonly name: string;
  readonly scope: readonly string[];
  readonly settings: { readonly foreground: string };
}

/**
 * The Radix portal scope, kept identical to the selector `lody-surface-shell.css`
 * documents: "a body child that is not ours". Dropdowns, selects, popovers,
 * tooltips, dialogs and the command palette all mount as direct children of
 * `document.body`, where they would otherwise inherit BlitzOS's own tokens.
 */
const PORTAL_SELECTOR = "body > :where(:not(#root, .files-context-backdrop, .files-context-menu))";

/** The names Lody's compiled variables share with `tokens.css`.
 *
 * Both are BlitzOS tokens AND Lody alias names, and the two trees disagree on
 * the TYPE: ours are finished `color-mix()` colours, theirs are bare HSL
 * triplets. `packages/webapp/test/lody-blitz-theme.test.ts` recomputes this
 * intersection from `tokens.css` and the compiled variable set, so a new
 * collision fails a test instead of silently breaking a native surface. */
export const RECLAIMED_ROOT_TOKENS = ["--hover", "--muted"] as const;

/**
 * The Blitz theme as VS Code sees it.
 *
 * Every colour id here is one the alias table in `vscode-theme-css.ts` reads
 * FIRST for the property named beside it, so the mapping is exact rather than a
 * cascade through fallbacks.
 */
function blitzThemeColors(palette: BlitzPalette) {
  const { paper, ink, accent, live, muted, faint, softInk, rule, hover, sunken, selected, ansi } =
    palette;
  // A pressed/hovered accent: the accent walked one step toward the ink, which
  // lightens it on dark paper and darkens it on light paper.
  const accentHover = mixOklab(ink, accent, 0.15);
  return {
    /* --background, --foreground, --code-foreground */
    "editor.background": paper,
    // `--foreground` reads `foreground` first; `--code-foreground` reads
    // `editor.foreground` first. The mockup sets body prose to `--soft-ink` and
    // reserves `--ink` for emphasis, which is exactly that split.
    foreground: ink,
    "editor.foreground": softInk,
    "editor.selectionBackground": selected,

    /* --card, --popover, --sidebar-*: every panel is the same paper. */
    "sideBar.background": paper,
    "sideBar.foreground": ink,
    "sideBar.border": rule,
    "sideBarTitle.foreground": ink,
    "sideBarSectionHeader.foreground": faint,
    // `--muted` is a chip / slab fill, never prose. `--sunken` is the BlitzOS
    // token for exactly that (mockup: code blocks and command output).
    "sideBarSectionHeader.background": sunken,
    "sideBarSectionHeader.border": rule,
    "editorWidget.background": paper,
    "editorWidget.border": rule,
    "editorHoverWidget.background": paper,
    "editorHoverWidget.border": rule,
    "quickInput.background": paper,
    "quickInput.foreground": ink,
    "panel.background": paper,
    "panel.border": rule,
    "dropdown.background": paper,
    "dropdown.border": rule,
    "dropdown.foreground": ink,
    descriptionForeground: faint,
    disabledForeground: faint,

    /* --hover, --selection: the rail's own two states, from strip-rail.css. */
    "list.hoverBackground": hover,
    "list.hoverForeground": ink,
    "list.activeSelectionBackground": selected,
    "list.activeSelectionForeground": ink,
    "list.inactiveSelectionBackground": hover,
    "list.inactiveSelectionForeground": ink,
    "list.focusBackground": hover,
    "list.focusForeground": ink,
    "list.deemphasizedForeground": faint,
    "menu.selectionBackground": hover,
    "menu.selectionForeground": ink,
    "quickInputList.focusBackground": hover,
    "quickInputList.focusForeground": ink,

    /* --primary, --ring, --highlight, --tab-active-accent: ONE accent.
     *
     * This is the hunk that kills the gold. Vesper points all four of these at
     * `#FFC799`, and the vendored sheet puts `outline-ring/50` on `*`,
     * `hsl(var(--primary)/0.5)` on every `:focus-visible`, and a 2px inset
     * `hsl(var(--primary)/0.75)` ring on the chat landing's keyboard-nav row —
     * whose top segment is the warm hairline at the pane's top edge. */
    "button.background": accent,
    "button.foreground": paper,
    "button.hoverBackground": accentHover,
    "button.secondaryBackground": hover,
    "button.secondaryForeground": softInk,
    "button.secondaryHoverBackground": rule,
    focusBorder: accent,
    "textLink.foreground": accent,
    "textLink.activeForeground": accentHover,
    "progressBar.background": accent,
    "activityBarBadge.background": accent,
    "activityBarBadge.foreground": paper,

    /* --input*: an editable field is the sunken slab, delimited by --rule. */
    "input.background": sunken,
    "input.foreground": ink,
    "input.border": rule,
    "input.placeholderForeground": faint,
    "checkbox.border": rule,

    /* --tab-*: the tab strip in the mockup — paper canvas, quiet rule. */
    "editorGroupHeader.tabsBackground": paper,
    "editorGroup.border": rule,
    "tab.activeBackground": selected,
    "tab.activeForeground": ink,
    "tab.inactiveBackground": paper,
    "tab.inactiveForeground": muted,
    "tab.hoverBackground": hover,
    "tab.hoverForeground": ink,
    "tab.border": rule,
    "tab.activeBorderTop": accent,
    "tab.activeBorder": accent,

    /* --bottom-bar */
    "statusBar.background": paper,
    "statusBar.foreground": muted,

    /* --status-*, --code-added/removed, --modified-file.
     * `--live` is the running-session green (mockup `.s__a--live`), and it is
     * the same semantic Lody's "added lines" and success states carry. */
    "gitDecoration.addedResourceForeground": live,
    "gitDecoration.untrackedResourceForeground": live,
    "gitDecoration.deletedResourceForeground": ansi["--ansi-red"],
    "gitDecoration.modifiedResourceForeground": ansi["--ansi-yellow"],
    "editorGutter.addedBackground": live,
    "editorGutter.deletedBackground": ansi["--ansi-red"],
    "editorGutter.modifiedBackground": ansi["--ansi-yellow"],
    "editorError.foreground": ansi["--ansi-red"],
    errorForeground: ansi["--ansi-red"],
    "editorWarning.foreground": ansi["--ansi-yellow"],
    "list.warningForeground": ansi["--ansi-yellow"],
    "diffEditor.insertedTextBackground": live,
    "diffEditor.removedTextBackground": ansi["--ansi-red"],

    /* --code-*: the mockup's recessed code slab. */
    "textCodeBlock.background": sunken,
    "textPreformat.foreground": ink,
    "textSeparator.foreground": rule,

    /* --scrollbar-*: quiet, and the same three steps `strip-rail.css` uses. */
    "scrollbarSlider.background": rule,
    "scrollbarSlider.hoverBackground": mixOklab(ink, paper, 0.22),
    "scrollbarSlider.activeBackground": faint,

    /* The terminal, straight off the ANSI ramp in `tokens.css`. */
    "terminal.background": paper,
    "terminal.foreground": ink,
    "terminal.selectionBackground": selected,
    "terminal.ansiBlack": ansi["--ansi-black"],
    "terminal.ansiRed": ansi["--ansi-red"],
    "terminal.ansiGreen": ansi["--ansi-green"],
    "terminal.ansiYellow": ansi["--ansi-yellow"],
    "terminal.ansiBlue": ansi["--ansi-blue"],
    "terminal.ansiMagenta": ansi["--ansi-magenta"],
    "terminal.ansiCyan": ansi["--ansi-cyan"],
    "terminal.ansiWhite": ansi["--ansi-white"],
    "terminal.ansiBrightBlack": ansi["--ansi-bright-black"],
    "terminal.ansiBrightRed": ansi["--ansi-bright-red"],
    "terminal.ansiBrightGreen": ansi["--ansi-bright-green"],
    "terminal.ansiBrightYellow": ansi["--ansi-bright-yellow"],
    "terminal.ansiBrightBlue": ansi["--ansi-bright-blue"],
    "terminal.ansiBrightMagenta": ansi["--ansi-bright-magenta"],
    "terminal.ansiBrightCyan": ansi["--ansi-bright-cyan"],
    "terminal.ansiBrightWhite": ansi["--ansi-bright-white"],
    // `satisfies`, not an annotation: the colour-id keys ARE the evidence — a
    // typo becomes an id VS Code never reads, and an annotation would erase the
    // literal keys that let a reader see the whole map at a glance.
  } satisfies VSCodeColorMap;
}

/**
 * The `--syntax-*` half, and the TextMate rules Shiki reads for code blocks and
 * the diff viewer. Every colour is an ANSI-ramp entry, so a code block inside
 * the chat stream and a `ttyd` terminal beside it agree on what a string is.
 *
 * `findTokenForeground` matches by `scope.startsWith(desired)`, so the scopes
 * below are the exact strings `SYNTAX_ALIAS_SCOPES` looks for.
 */
function blitzTokenColors(palette: BlitzPalette): BlitzTokenColorRule[] {
  const { ansi, softInk } = palette;
  const rule = (
    name: string,
    scope: readonly string[],
    foreground: string,
  ): BlitzTokenColorRule => ({ name, scope, settings: { foreground } });
  return [
    rule("Comment", ["comment"], ansi["--ansi-bright-black"]),
    rule("String", ["string"], ansi["--ansi-green"]),
    rule("Keyword", ["keyword", "storage.type"], ansi["--ansi-magenta"]),
    rule("Number", ["constant.numeric", "constant.language.boolean"], ansi["--ansi-yellow"]),
    rule("Function", ["entity.name.function", "support.function"], ansi["--ansi-blue"]),
    rule("Variable", ["variable", "identifier"], softInk),
    rule("Type", ["entity.name.type", "entity.name.class"], ansi["--ansi-cyan"]),
    rule(
      "Attribute",
      ["entity.other.attribute-name", "support.type.property-name"],
      ansi["--ansi-yellow"],
    ),
    rule("Builtin", ["support.class", "support.type", "variable.language"], ansi["--ansi-cyan"]),
  ];
}

/**
 * One Blitz theme, resolved by the vendored loader.
 *
 * It goes through `resolveVSCodeThemeSync` with an in-memory reader rather than
 * being hand-built as a `LodyResolvedVSCodeTheme`, so the theme is validated,
 * hex-normalized and shaped by THEIR schema. A colour id we spell wrong, or a
 * value that is not a hex colour, fails here instead of resolving to nothing at
 * paint time.
 */
export function createBlitzVSCodeTheme(
  mode: BlitzThemeMode,
  palette: BlitzPalette,
): BlitzResolvedTheme {
  const path = `themes/blitz-${mode}.json`;
  const document = JSON.stringify({
    name: BLITZ_THEME_LABELS[mode],
    type: mode,
    colors: blitzThemeColors(palette),
    tokenColors: blitzTokenColors(palette),
  });
  return resolveVSCodeThemeSync({
    id: BLITZ_THEME_IDS[mode],
    label: BLITZ_THEME_LABELS[mode],
    uiTheme: mode === "dark" ? "vs-dark" : "vs",
    path,
    source: { kind: "builtin", extensionId: "blitz.theme-blitz", extensionVersion: "1.0.0" },
    readFile: (requested: string) => {
      if (requested !== path) throw new Error(`Blitz theme has no file "${requested}"`);
      return document;
    },
  });
}

let installed = false;

/**
 * Registers both Blitz themes in the vendored bundle registry, under the ids
 * the fixed selection names.
 *
 * MUST RUN BEFORE the first `getBundledVSCodeThemeByIdSync` call, because
 * `resolveBundledThemeDescriptorSync` returns the cached entry when one exists
 * and never replaces it. `SessionSurface` calls this during the render that
 * creates `ThemeProvider`, which is the same slot `adoptShellTheme` uses and for
 * the same reason: their code reads it on ITS first render.
 *
 * BOTH themes are built here, but only ONE of them can be read off the DOM:
 * `:root` is painting `currentMode`, so `getPropertyValue('--paper')` answers
 * with that mode's literal whichever mode is being asked for. The other theme is
 * built from the `tokens.css` literals instead. That is also why the registry is
 * registered once and never re-registered on a flip — it already holds both.
 *
 * Idempotent, and re-registering after the registry already answered is a
 * no-op — so the return value says whether the registry is actually Blitz.
 */
export function installBlitzVSCodeThemes(
  root: Element | null,
  currentMode: BlitzThemeMode,
): boolean {
  if (installed) return isBlitzThemeInstalled();
  installed = true;
  const files: Record<string, string> = {};
  const themes: { id: string; label: string; uiTheme: string; path: string }[] = [];
  for (const mode of ["dark", "light"] as const) {
    const palette = readBlitzPalette(mode === currentMode ? root : null, mode);
    const path = `themes/blitz-${mode}.json`;
    files[path] = JSON.stringify({
      name: BLITZ_THEME_LABELS[mode],
      type: mode,
      colors: blitzThemeColors(palette),
      tokenColors: blitzTokenColors(palette),
    });
    themes.push({
      id: BLITZ_THEME_IDS[mode],
      label: BLITZ_THEME_LABELS[mode],
      uiTheme: mode === "dark" ? "vs-dark" : "vs",
      path,
    });
  }
  resolveBundledVSCodeThemesFromExtensions([
    {
      extensionId: "blitz.theme-blitz",
      extensionVersion: "1.0.0",
      manifest: {
        name: "theme-blitz",
        displayName: "BlitzOS",
        publisher: "blitz",
        version: "1.0.0",
        contributes: { themes },
      },
      files,
    },
  ]);
  if (isBlitzThemeInstalled()) return true;
  // LOUD, because every way this can fail is silent. `resolveBundledThemeDescriptorSync`
  // returns a CACHED entry rather than replacing it, so anything that resolved
  // one of these two ids first wins and says nothing; and
  // `resolveBundledVSCodeThemesFromExtensions` swallows a malformed theme into
  // a `console.warn` and carries on with the stock one. Either way the surface
  // silently keeps Lody's palette, which is exactly how the reskin reached
  // canary looking unchanged. The surface no longer DEPENDS on this — see
  // `applyBlitzThemeToRoot` — but a failure here still costs the terminal
  // palette and the diff viewer's syntax theme, so it must be visible.
  console.error(
    "[blitz-theme] the Blitz VS Code themes did not take in the bundled registry;",
    "the surface falls back to the overlay and their terminal/diff themes stay Lody's.",
    {
      registry: Object.fromEntries(
        (["dark", "light"] as const).map((mode) => [
          BLITZ_THEME_IDS[mode],
          registeredThemeLabel(mode) ?? null,
        ]),
      ),
      expected: BLITZ_THEME_LABELS,
    },
  );
  return false;
}

/**
 * Applies the Blitz theme's variables to the html element, whatever the
 * registry did.
 *
 * WHY THIS EXISTS AT ALL. `LodyThemeProvider` looks its theme up by id in a
 * cache that never replaces an entry (`bundled-vscode-themes.ts:516`), so the
 * whole reskin used to rest on `installBlitzVSCodeThemes` running before the
 * first lookup. That is a RACE, not a guarantee: it holds for the mount order
 * this tree happens to have today, and nothing upstream promises to keep it —
 * a second surface mount, a component that reads `useActiveVSCodeTheme` from
 * above the provider, or an upstream eager resolve would each flip it, silently
 * and product-wide.
 *
 * So the surface stops depending on the race. This writes the same compiled
 * variables the registry seed would have produced, from a `useEffect` in
 * `ShellThemeBridge` — a PASSIVE effect, which React runs after every layout
 * effect in the commit, `LodyThemeProvider`'s included. Whatever they applied,
 * ours is what stands.
 *
 * `mode` is THEIR resolved theme, not the shell's: the two agree because
 * `adoptShellTheme` seeds it and the bridge keeps it in step, and reading it
 * from their side means we overwrite exactly the application they just made.
 */
export function applyBlitzThemeToRoot(mode: BlitzThemeMode): () => void {
  const root = document.documentElement;
  const palette = readBlitzPalette(root, mode);
  return applyVSCodeThemeCssVariables(root, createBlitzVSCodeTheme(mode, palette)).dispose;
}

/**
 * The label the bundled registry currently holds for one of the two fixed ids.
 *
 * SAFETY: their `LodyResolvedVSCodeTheme` declares `label` as a required string
 * (`vscode-theme-schemas.ts:59`) and `getBundledVSCodeThemeByIdSync` returns it
 * or `undefined`; the vendor type seam erases every `@lody/*` export to `any`
 * (`vendor-modules.d.ts`), so the one field this file reads is restated here
 * rather than borrowed. Nothing else is read, and a wrong guess could only
 * yield `undefined` — which reports as "not installed" and is louder, never a
 * wrong theme.
 */
function registeredThemeLabel(mode: BlitzThemeMode): string | undefined {
  // SAFETY: their schema declares `label` as a required string on a resolved
  // theme (`vscode-theme-schemas.ts:59`), and this getter returns a resolved
  // theme or `undefined`. The narrowing is weaker than the truth, and the only
  // field read is the one being narrowed to.
  const theme = getBundledVSCodeThemeByIdSync(BLITZ_THEME_IDS[mode]) as
    | { label?: string }
    | undefined;
  return theme?.label;
}

/** Whether the registry answers with Blitz for both fixed ids. */
export function isBlitzThemeInstalled(): boolean {
  return (["dark", "light"] as const).every(
    (mode) => registeredThemeLabel(mode) === BLITZ_THEME_LABELS[mode],
  );
}

/**
 * The generated stylesheet: the compiled variables on the surface, on the
 * rail's vendored zone and on the Radix portals, plus the `:root` reclaim.
 *
 * Exported so `packages/webapp/test/lody-blitz-theme.test.ts` can read the CSS
 * without a document.
 */
export function blitzThemeStylesheet(mode: BlitzThemeMode, palette: BlitzPalette): string {
  const theme = createBlitzVSCodeTheme(mode, palette);
  const variables = createThemeCssVariables(theme);
  const declarations = Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  // Their two font names, pointed at ours. `--font-mono` needs no line: it is
  // the fifth collision, both trees hold a font stack, and ours already wins by
  // being unlayered — which is the whole of that resolution.
  const fonts = "  --font-sans: var(--font-ui);\n  --font-terminal: var(--font-mono);";
  const surfaceScope = `.${LODY_SURFACE_CLASS},\n.session-list--vendor,\n${PORTAL_SELECTOR}`;
  const reclaim = RECLAIMED_ROOT_TOKENS.map((token) => {
    const recipe = BLITZ_MIX_RATIOS[mode][token];
    if (recipe === undefined) throw new Error(`No mix recipe for the reclaimed token ${token}`);
    return `  ${token}: color-mix(in oklab, var(${recipe.from}) ${recipe.percent}%, var(${recipe.over})) !important;`;
  }).join("\n");
  return [
    `/* Generated by src/lody/blitz-theme.ts — Blitz ${mode}. Do not edit by hand. */`,
    `${surfaceScope} {`,
    declarations,
    fonts,
    "}",
    "/* Reclaim: `LodyThemeProvider` writes these two onto <html> as an inline",
    "   style, where they outrank tokens.css and break every native var(--muted)",
    "   and var(--hover). Author `!important` is what beats an inline style. */",
    ":root {",
    reclaim,
    "}",
    "",
  ].join("\n");
}

/**
 * Writes (or rewrites) the generated sheet into `document.head`.
 *
 * One `<style>` element, replaced in place: a theme flip must not leave the
 * previous mode's declarations behind it in the cascade.
 */
export function applyBlitzSurfaceTheme(mode: BlitzThemeMode, root: Element | null): void {
  const palette = readBlitzPalette(root, mode);
  let sheet = document.getElementById(SHEET_ELEMENT_ID);
  if (sheet === null) {
    sheet = document.createElement("style");
    sheet.id = SHEET_ELEMENT_ID;
    document.head.append(sheet);
  }
  sheet.textContent = blitzThemeStylesheet(mode, palette);
}

/**
 * Everything the surface needs before its first paint, in one call: the
 * registry seed and the generated sheet.
 */
export function installBlitzLodyTheme(mode: BlitzThemeMode): void {
  const root = document.documentElement;
  installBlitzVSCodeThemes(root, mode);
  applyBlitzSurfaceTheme(mode, root);
}

/**
 * `applyBlitzThemeToRoot`, aimed at any element.
 *
 * The review harness uses it to theme a detached surface, and the tests use it
 * to read the applied palette back off an element's inline style — the one
 * place a value can be measured without a cascade.
 */
export function applyBlitzThemeTo(element: HTMLElement, mode: BlitzThemeMode): () => void {
  const palette = readBlitzPalette(element.ownerDocument.documentElement, mode);
  return applyVSCodeThemeCssVariables(element, createBlitzVSCodeTheme(mode, palette)).dispose;
}
