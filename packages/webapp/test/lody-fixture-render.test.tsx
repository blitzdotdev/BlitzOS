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
 * The review page moved OUT of this file (§17). It used to be generated here as
 * a self-contained HTML artefact, and because it carried its own stylesheet it
 * showed a composition the product could not produce. It is now
 * `surface-preview.html`, which loads only the product's own stylesheets, and
 * `lody-preview-fidelity.test.ts` is what keeps it honest.
 *
 * `applyBlitzThemeTo` is measured here as well, because it is a DOM write
 * rather than a CSS rule and a source test cannot see it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { hexColorToHslChannel } from "@lody/components/lib/vscode-theme";
import { LodyFixtureSurface } from "./lody-fixture-surface";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";
import { readBlitzPalette } from "../src/lody/blitz-palette";
import { applyBlitzThemeTo } from "../src/lody/blitz-theme";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const readSrc = (...parts: string[]): string => readFileSync(join(src, ...parts), "utf8");
const skinCss = readSrc("lody", "blitz-skin.css");

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
