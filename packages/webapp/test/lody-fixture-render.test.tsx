/**
 * The vendored Lody leaves render inside our tree, from fixtures, with no
 * daemon and no network (plans/LODY-SESSIONS.md §10, phase 0's exit test 2) —
 * and, since the Blitz reskin, everything else that can only be measured
 * against the DOM those components actually produce.
 *
 * THREE JOBS, ONE VENDOR GRAPH. Vitest caps its worker count on MEMORY
 * (`vite.config.ts`, `lodyAwareWorkerCount`): a worker that has imported the
 * vendored renderer — Monaco, three, mermaid, shiki, loro's WASM — costs about
 * a gigabyte, and on a four-core box each extra suite that imports it is one
 * more of those competing with the daemon-backed suites' start-up. So the three
 * things that need this graph share one file rather than three:
 *
 * 1. THE PROP CONTRACT. This is what fails first when an upstream merge changes
 *    a prop on `SessionChatStreamView`, `ChatComposer` or `LoroSidebar`. The
 *    phase-3 exit test drives the mounted surface against a real `lody` daemon
 *    and SKIPS wherever one is not installed, which is CI; this needs none of
 *    that and gates every merge.
 * 2. THE SKIN'S SELECTORS. `lody-blitz-theme.test.ts` greps the vendor source
 *    for the class strings `blitz-skin.css` targets, and a grep is not enough
 *    on its own: a class can survive in the source and stop reaching the rail —
 *    behind a prop we do not pass, on a branch we do not take, under a wrapper
 *    that changed. Every selector the skin scopes to the vendored rail must
 *    MATCH SOMETHING here. A rule that matches nothing has silently stopped
 *    skinning.
 * 3. THE REVIEW PAGE. The last block is a build step rather than an assertion,
 *    but it earns its place as a test too: the page must keep rendering the
 *    vendored leaves inside the rail chrome, or it has stopped being a review
 *    of anything.
 *
 * `applyBlitzThemeTo` is measured here as well, because it is a DOM write
 * rather than a CSS rule and a source test cannot see it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
// Compiled through the app's own plugin pipeline — Tailwind v4 plus
// `lodyCascadeLayerPlugin` — exactly as `lody-tailwind-containment.test.ts`
// reads it. This is the whole vendored stylesheet, inside `@layer lody`.
import lodyCss from "../src/lody/lody-surface.css?inline";
import { hexColorToHslChannel } from "@lody/components/lib/vscode-theme";
import { LodyFixtureSurface } from "./lody-fixture-surface";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";
import { ThemeReviewPage } from "./theme-review";
import { readBlitzPalette, type BlitzThemeMode } from "../src/lody/blitz-palette";
import { applyBlitzThemeTo, blitzThemeStylesheet } from "../src/lody/blitz-theme";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const readSrc = (...parts: string[]): string => readFileSync(join(src, ...parts), "utf8");
const skinCss = readSrc("lody", "blitz-skin.css");

/** Written to a temp directory unless `BLITZ_THEME_REVIEW_OUT` names one:
 * `npm test` runs this file like any other, and a generated artefact does not
 * belong in the tree. Point the variable at a real path to review it. */
const OUT = process.env.BLITZ_THEME_REVIEW_OUT ?? join(tmpdir(), "lody-blitz-preview.html");

const MODES: BlitzThemeMode[] = ["dark", "light"];

/**
 * The generated variable block, re-scoped from `:root` / `.lody-surface` to the
 * mode the toggle has selected.
 *
 * `blitzThemeStylesheet` emits two rules: the surface scope, and the `:root`
 * reclaim. Both are prefixed with `html[data-theme='<mode>']` so one document
 * can carry both palettes and the toggle picks between them — which is the only
 * way a static file can show light and dark without two documents.
 */
function scopedThemeCss(mode: BlitzThemeMode): string {
  const sheet = blitzThemeStylesheet(mode, readBlitzPalette(null, mode));
  const guard = `html[data-theme='${mode}']`;
  return sheet.replace(/(^|\n)([^{}/][^{}]*?)\{/gu, (_match, lead: string, selectors: string) =>
    `${lead}${splitSelectorList(selectors)
      .map((selector) => (selector === ":root" ? guard : `${guard} ${selector}`))
      .join(",\n")} {`,
  );
}

/**
 * Splits a selector list on TOP-LEVEL commas only.
 *
 * The portal selector is `body > :where(:not(#root, .files-context-backdrop,
 * .files-context-menu))` — three commas, all inside parentheses, none of them a
 * list separator. A plain `split(',')` cuts the rule into fragments that match
 * nothing, which is the sort of thing a static projection would show as a
 * missing theme rather than as an error.
 */
function splitSelectorList(selectors: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of selectors) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  const last = current.trim();
  if (last !== "") parts.push(last);
  return parts;
}

const TOGGLE_SCRIPT = `
  const root = document.documentElement;
  const set = (mode) => {
    root.setAttribute('data-theme', mode);
    // next-themes writes the mode as a CLASS on <html>; every \`dark:\` variant
    // in the vendored sheet keys off it, so the toggle has to move both.
    root.classList.remove('dark', 'light');
    root.classList.add(mode);
    root.style.colorScheme = mode;
    for (const button of document.querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
  };
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => set(button.dataset.mode));
  }
  set('dark');
`;


/** The token names the page is labelled with, so a reviewer can name what they
 * are looking at rather than describe it. */
function tokenLegend(mode: BlitzThemeMode): string {
  const palette = readBlitzPalette(null, mode);
  const swatches: [string, string][] = [
    ["--paper", palette.paper],
    ["--ink", palette.ink],
    ["--accent", palette.accent],
    ["--live", palette.live],
    ["--soft-ink", palette.softInk],
    ["--muted", palette.muted],
    ["--faint", palette.faint],
    ["--rule", palette.rule],
    ["--hover", palette.hover],
    ["--sunken", palette.sunken],
    ["--selected", palette.selected],
  ];
  return swatches
    .map(
      ([name, value]) =>
        `<span class="legend__chip"><i style="background:${value}"></i><code>${name}</code>${value}</span>`,
    )
    .join("");
}

/** Styling for the two things only the STATIC page carries: the token legend
 * and the divergence note. The toggle's own chrome lives in
 * `theme-review.css`, beside the layout, so the live page and this one agree. */
const LEGEND_CSS = `
  .review-note {
    position: fixed; z-index: 99; left: 60px; bottom: 12px; max-width: 46ch;
    padding: 8px 10px;
    border: 1px solid var(--rule); border-radius: var(--r-control);
    background: var(--paper); color: var(--faint);
    font: 11px/1.5 var(--font-ui);
  }
  .review-note b { color: var(--soft-ink); font-weight: 600; }
  .review-note code { font-family: var(--font-mono); color: var(--accent); }
  .legend {
    display: flex; flex-wrap: wrap; gap: 6px 14px;
    padding: 8px 12px; border-bottom: 1px solid var(--rule);
    font: 10.5px/1.6 var(--font-ui); color: var(--faint);
  }
  .legend__chip { display: inline-flex; align-items: center; gap: 5px; }
  .legend__chip i {
    display: inline-block; width: 11px; height: 11px;
    border: 1px solid var(--rule); border-radius: 3px;
  }
  .legend__chip code { font-family: var(--font-mono); color: var(--soft-ink); }
  html[data-theme='dark'] .legend--light,
  html[data-theme='light'] .legend--dark { display: none; }
  .review-shell { height: calc(100vh - 34px); }
`;


/** Every selector `blitz-skin.css` aims at the vendored rail, one per comma. */
function railSelectors(): string[] {
  const selectors: string[] = [];
  postcss.parse(skinCss).walkRules((rule: Rule) => {
    for (const part of rule.selector.split(",")) {
      const selector = part.trim();
      if (selector.startsWith(".session-list--vendor ")) selectors.push(selector);
    }
  });
  return selectors;
}

let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  installLodyDomStubs();
});

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup();
    cleanup = null;
  }
  document.documentElement.removeAttribute("data-theme");
});

describe("vendored Lody leaves", () => {
  it("renders the chat stream, the composer, and the sidebar body from fixtures", async () => {
    const mounted = await render(<LodyFixtureSurface />);
    cleanup = mounted.unmount;
    await settle();

    const text = mounted.container.textContent ?? "";

    // SessionChatStreamView: the user turn, the assistant answer, the folded
    // tool activity, and the edited-files card built from `fileDiff`.
    expect(text).toContain("Swap the workspace rail over to Lody session rows.");
    expect(text).toContain("The rail now renders");
    // The finished turn folded its tool activity behind a "Worked for" header,
    // which is the stream's own turn-folding contract rather than our fixture.
    expect(text).toMatch(/Worked for/);

    // ChatComposer: its textarea holds the fixture prompt and both pickers
    // rendered their selected option.
    const composer = mounted.container.querySelector("textarea");
    expect(composer).not.toBeNull();
    expect((composer as HTMLTextAreaElement).value).toContain("Move the rail over to Lody");
    expect(text).toContain("blitzdotdev/BlitzOS");

    // LoroSidebar body: both session sections, and the Terminals section our
    // own `.shell-s` rows are injected into through `afterSessionListContent`.
    expect(text).toContain("fix the login redirect");
    expect(text).toContain("rail swap");
    expect(text).toContain("GitHub Worktrees");
    expect(text).toContain("Terminals");
    expect(mounted.container.querySelector(".session-rail-terminals .shell-s")).not.toBeNull();

    // Everything Lody renders stays inside the surface boundary the
    // containment test probes.
    expect(mounted.container.querySelector(".lody-surface")).not.toBeNull();
  });

  it("mounts the sidebar the way the product mounts it", async () => {
    // `hideHeader` / `hideFooter` are declared seam #4: the header they hide is
    // the workspace switcher `div.shell-rhead` already serves, and the footer is
    // Settings / Help / Archive, which BlitzOS serves from its own chrome and
    // which would otherwise draw a `border-t` band across the bottom of the
    // rail. A harness that leaves them out reviews a sidebar the product does
    // not render.
    const mounted = await render(<LodyFixtureSurface />);
    cleanup = mounted.unmount;
    await settle();

    const text = mounted.container.textContent ?? "";
    for (const footerEntry of ["Settings", "Archive"]) {
      expect(text, `the hidden footer's "${footerEntry}" entry`).not.toContain(footerEntry);
    }
    // The composer sits in the same 46rem column as the stream rows, because
    // `SessionChatInputArea` wraps it in one upstream.
    const columns = mounted.container.querySelectorAll(".max-w-\\[46rem\\]");
    expect(columns.length).toBeGreaterThan(1);
  });
});

describe("the Blitz skin over the vendored rail", () => {
  it("has no rule that matches nothing in a real sidebar render", async () => {
    const mounted = await render(<LodyFixtureSurface />);
    cleanup = mounted.unmount;
    await settle();

    const unmatched = railSelectors().filter(
      (selector) => mounted.container.querySelector(selector) === null,
    );
    expect(unmatched).toEqual([]);
  });

  it("finds a selected row wearing the class the skin repaints", async () => {
    // `session-list.tsx:919` fills the selected row with `bg-sidebar-foreground/10`,
    // an alpha of the TEXT colour, so no theme token can move it. The skin
    // repaints it with `--selected`, and this is the assertion that the class is
    // still what a selected row wears.
    const mounted = await render(<LodyFixtureSurface />);
    cleanup = mounted.unmount;
    await settle();

    const selected = mounted.container.querySelectorAll(
      "[data-sidebar-session-id].bg-sidebar-foreground\\/10",
    );
    expect(selected.length).toBeGreaterThan(0);
    const rows = mounted.container.querySelectorAll("[data-sidebar-session-id]");
    expect(rows.length).toBeGreaterThan(selected.length);
  });
});

describe("the applied theme", () => {
  it.each(["dark", "light"] as const)("puts the %s Blitz palette on the element", (mode) => {
    const surface = document.createElement("div");
    document.body.append(surface);
    try {
      const dispose = applyBlitzThemeTo(surface, mode);
      const palette = readBlitzPalette(null, mode);
      expect(surface.style.getPropertyValue("--background")).toBe(
        hexColorToHslChannel(palette.paper),
      );
      expect(surface.style.getPropertyValue("--primary")).toBe(
        hexColorToHslChannel(palette.accent),
      );
      expect(surface.style.getPropertyValue("--vscode-editor-background")).toBe(
        palette.paper.toUpperCase(),
      );
      dispose();
      expect(surface.style.getPropertyValue("--background")).toBe("");
    } finally {
      surface.remove();
    }
  });

  it("replaces the whole palette on a flip, leaving none of the old one", () => {
    const surface = document.createElement("div");
    document.body.append(surface);
    try {
      applyBlitzThemeTo(surface, "dark");
      const darkBackground = surface.style.getPropertyValue("--background");
      applyBlitzThemeTo(surface, "light");
      const lightPalette = readBlitzPalette(null, "light");
      expect(surface.style.getPropertyValue("--background")).not.toBe(darkBackground);
      expect(surface.style.getPropertyValue("--background")).toBe(
        hexColorToHslChannel(lightPalette.paper),
      );
    } finally {
      surface.remove();
    }
  });
});

describe("the theme review page", () => {
  it("renders to a self-contained file", async () => {
    installLodyDomStubs();
    const mounted = await render(<ThemeReviewPage />);
    await settle();
    const markup = mounted.container.innerHTML;
    expect(markup).toContain("session-list--vendor");
    expect(markup).toContain("data-sidebar-session-id");

    const html = [
      "<!doctype html>",
      `<html lang="en" data-theme="dark" class="dark">`,
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<title>BlitzOS — Lody surface, Blitz theme</title>",
      // 1. Our tokens, unchanged. The `:root[data-theme]` blocks are what the
      //    toggle drives, so both palettes are already in this one file.
      `<style>${readSrc("tokens.css")}</style>`,
      // 2. The vendored sheet, compiled and layered exactly as the app builds it.
      `<style>${lodyCss}</style>`,
      // 3. Our compensation, the surface box, and the skin — in load order.
      `<style>${readSrc("lody", "lody-compensation.css")}</style>`,
      `<style>${readSrc("strip-rail.css")}</style>`,
      `<style>${readSrc("lody", "lody-surface-shell.css")}</style>`,
      `<style>${readSrc("lody", "blitz-skin.css")}</style>`,
      `<style>${readFileSync(join(here, "theme-review.css"), "utf8")}</style>`,
      // 4. The generated theme, both modes, guarded by the toggle's attribute.
      `<style>${MODES.map(scopedThemeCss).join("\n")}</style>`,
      `<style>${LEGEND_CSS}</style>`,
      "</head>",
      "<body>",
      `<div class="legend legend--dark">${tokenLegend("dark")}</div>`,
      `<div class="legend legend--light">${tokenLegend("light")}</div>`,
      `<div id="root">${markup}</div>`,
      '<div class="review-bar">',
      "<span>Blitz theme</span>",
      '<button type="button" data-mode="dark" aria-pressed="true">Dark</button>',
      '<button type="button" data-mode="light" aria-pressed="false">Light</button>',
      "</div>",
      '<div class="review-note">',
      "<b>Static projection.</b> Markup and stylesheets are the real ones; four things a file cannot carry: ",
      "no layout pass (auto-grow, virtualisation, the resize sash are frozen), ",
      "<code>LodyThemeProvider</code> is replaced by a stylesheet rule rather than an inline style, ",
      "Inter and Fira Code are not embedded, and Shiki never boots so code blocks show the slab without tokens.",
      "</div>",
      `<script>${TOGGLE_SCRIPT}</script>`,
      "</body>",
      "</html>",
      "",
    ].join("\n");

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html, "utf8");
    await mounted.unmount();
    expect(html.length).toBeGreaterThan(10_000);
  });
});
