/**
 * The reskin when the registry seed LOSES (plans/LODY-RUNTIME-DESIGN.md §16).
 *
 * `LodyThemeProvider` looks its theme up by id in `bundledThemesById`, a
 * module-level cache that `resolveBundledThemeDescriptorSync` reads before it
 * writes and never replaces (`bundled-vscode-themes.ts:516`). So registering
 * Blitz under their two fixed ids only works while nothing has resolved those
 * ids first, and the first version of the reskin rested on that entirely: one
 * earlier lookup, from anywhere, and the surface silently kept Vesper —
 * product-wide, with no error and no failing test. That is the shape of the
 * canary report, and whether or not it was the cause, a reskin that depends on
 * winning a race is a reskin that will lose one.
 *
 * This file makes the race UNWINNABLE and then asserts the surface is Blitz
 * anyway. Its whole premise is a poisoned registry, which is why it is a file
 * of its own: `bundledThemesById` is module state, one resolve of `vesper`
 * poisons it for every later test in the same module graph, and Vitest isolates
 * per file.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getBundledVSCodeThemeByIdSync, hexColorToHslChannel } from "@lody/components/lib/vscode-theme";
import { render, settle } from "./dom";
import { readBlitzPalette } from "../src/lody/blitz-palette";
import { BLITZ_THEME_IDS, BLITZ_THEME_LABELS, installBlitzVSCodeThemes } from "../src/lody/blitz-theme";
import { BlitzThemedLodyTree, adoptShellTheme } from "../src/lody/shell-theme";

class PrefersLightQuery extends EventTarget {
  media = "(prefers-color-scheme: light)";
  onchange = null;
  matches = false;
  addListener(): void {}
  removeListener(): void {}
}

/** The poison: resolve their stock themes through the registry BEFORE anything
 * of ours registers. From here on `bundledThemesById` holds Vesper and Lody
 * Light under the two ids the fixed selection asks for, and no later
 * registration can displace them. */
function poisonRegistry(): void {
  for (const mode of ["dark", "light"] as const) {
    getBundledVSCodeThemeByIdSync(BLITZ_THEME_IDS[mode]);
  }
}

let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  window.matchMedia = () => new PrefersLightQuery();
  poisonRegistry();
});

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup();
    cleanup = null;
  }
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

const applied = (name: string): string =>
  document.documentElement.style.getPropertyValue(name);

describe("a lost registry race", () => {
  it("really is lost — the registry answers with Lody's themes", () => {
    for (const mode of ["dark", "light"] as const) {
      const registered = getBundledVSCodeThemeByIdSync(BLITZ_THEME_IDS[mode]) as
        | { label?: string }
        | undefined;
      expect(registered?.label, mode).not.toBe(BLITZ_THEME_LABELS[mode]);
    }
  });

  it("says so, loudly", () => {
    // Every failure mode of the seed is silent on their side: the cache returns
    // the stale entry without a word, and a malformed theme becomes a
    // `console.warn` and a fallback. Ours has to be an error, or the next
    // canary deploy is the first place anybody notices.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    });
    expect(installBlitzVSCodeThemes(null, "dark")).toBe(false);
    expect(errors.join("\n")).toContain("[blitz-theme]");
    expect(errors.join("\n")).toContain("did not take in the bundled registry");
  });

  it("still paints the surface Blitz, because the html write is ours", async () => {
    // THE REGRESSION. `ShellThemeBridge` re-applies the Blitz palette in a
    // PASSIVE effect, and React runs every layout effect in a commit before any
    // passive one — so `LodyThemeProvider`'s application happens first and ours
    // is what survives. Before the fix this assertion read Vesper's #101010.
    const theme = adoptShellTheme();
    const mounted = await render(
      <BlitzThemedLodyTree theme={theme}>
        <div>surface</div>
      </BlitzThemedLodyTree>,
    );
    cleanup = mounted.unmount;
    await settle();

    const palette = readBlitzPalette(null, "dark");
    expect(applied("--vscode-editor-background")).toBe(palette.paper.toUpperCase());
    expect(applied("--primary")).toBe(hexColorToHslChannel(palette.accent));
    // Vesper's accent, which is what the pane's top-edge hairline was.
    expect(applied("--primary")).not.toBe(hexColorToHslChannel("#FFC799"));
    expect(applied("--ring")).not.toBe(hexColorToHslChannel("#FFC799"));
  });

  it("still writes the generated sheet, which never depended on the registry", async () => {
    const theme = adoptShellTheme();
    const mounted = await render(
      <BlitzThemedLodyTree theme={theme}>
        <div>surface</div>
      </BlitzThemedLodyTree>,
    );
    cleanup = mounted.unmount;
    await settle();
    expect(document.getElementById("blitz-lody-theme")?.textContent).toContain(".lody-surface");
  });
});
