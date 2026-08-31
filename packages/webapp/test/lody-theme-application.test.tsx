/**
 * The link the reskin shipped without: their provider, mounted, applying OUR
 * palette to the html element (plans/LODY-RUNTIME-DESIGN.md §16).
 *
 * WHAT WAS MISSING. The reskin had three green harnesses and none of them
 * mounted `ThemeProvider`. They proved the compiled theme's VALUES
 * (`lody-blitz-theme.test.ts`), the skin's SELECTORS against real vendored DOM
 * (`lody-fixture-render.test.tsx`), and a static page built from
 * `blitzThemeStylesheet()` output. Every one of them stopped one step short of
 * the thing a member actually sees, which is `LodyThemeProvider` writing
 * variables onto `<html>` — the only harness that ever ran that is the
 * daemon-backed one, and it skips wherever a `lody` daemon is not installed,
 * which is CI.
 *
 * So this mounts `BlitzThemedLodyTree` — the real subtree `SessionSurface`
 * renders, not a stack assembled here to look like it — and reads the applied
 * inline style back. `lody-theme-race.test.tsx` is its other half: the same
 * mount, with the registry already lost.
 *
 * `getComputedStyle` is not used, for the reason `lody-tailwind-containment.test.ts`
 * gives: jsdom does not cascade custom properties. An INLINE style needs no
 * cascade, and an inline style is exactly what both appliers write.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { getBundledVSCodeThemeByIdSync, hexColorToHslChannel } from "@lody/components/lib/vscode-theme";
import { render, settle } from "./dom";
import { readBlitzPalette } from "../src/lody/blitz-palette";
import { BLITZ_THEME_IDS, BLITZ_THEME_LABELS } from "../src/lody/blitz-theme";
import { BlitzThemedLodyTree, adoptShellTheme } from "../src/lody/shell-theme";

class PrefersLightQuery extends EventTarget {
  media = "(prefers-color-scheme: light)";
  onchange = null;
  matches = false;
  addListener(): void {}
  removeListener(): void {}
}

let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  window.matchMedia = () => new PrefersLightQuery();
});

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup();
    cleanup = null;
  }
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  window.localStorage.clear();
});

const applied = (name: string): string =>
  document.documentElement.style.getPropertyValue(name);

describe("the surface's theme, as their provider applies it", () => {
  it("registers Blitz under the two ids their fixed selection names", () => {
    const theme = adoptShellTheme();
    expect(theme).toBe("dark");
    for (const mode of ["dark", "light"] as const) {
      const registered = getBundledVSCodeThemeByIdSync(BLITZ_THEME_IDS[mode]) as
        | { label?: string }
        | undefined;
      expect(registered?.label, mode).toBe(BLITZ_THEME_LABELS[mode]);
    }
  });

  it("puts the Blitz palette on <html>, not Lody's", async () => {
    const theme = adoptShellTheme();
    const mounted = await render(
      <BlitzThemedLodyTree theme={theme}>
        <div>surface</div>
      </BlitzThemedLodyTree>,
    );
    cleanup = mounted.unmount;
    await settle();

    const palette = readBlitzPalette(null, "dark");
    // `--vscode-editor-background` is the raw colour id, and `--primary` is the
    // alias every accent in the surface is drawn from. Vesper's is #FFC799.
    expect(applied("--vscode-editor-background")).toBe(palette.paper.toUpperCase());
    expect(applied("--primary")).toBe(hexColorToHslChannel(palette.accent));
    expect(applied("--ring")).toBe(hexColorToHslChannel(palette.accent));
    expect(applied("--primary")).not.toBe(hexColorToHslChannel("#FFC799"));
  });

  it("writes the generated sheet, and the :root reclaim with it", async () => {
    const theme = adoptShellTheme();
    const mounted = await render(
      <BlitzThemedLodyTree theme={theme}>
        <div>surface</div>
      </BlitzThemedLodyTree>,
    );
    cleanup = mounted.unmount;
    await settle();

    const sheet = document.getElementById("blitz-lody-theme");
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain(".lody-surface");
    expect(sheet?.textContent).toContain("!important");
  });

  it("adopts the shell's palette rather than a stale stored preference", async () => {
    // A member who used the surface before the reskin still has whatever they
    // last chose in this key. `adoptShellTheme` overwrites it, so `light` here
    // must not produce a light surface inside a dark shell.
    window.localStorage.setItem("blitz-lody-theme", "light");
    const theme = adoptShellTheme();
    expect(theme).toBe("dark");
    expect(window.localStorage.getItem("blitz-lody-theme")).toBe("dark");

    const mounted = await render(
      <BlitzThemedLodyTree theme={theme}>
        <div>surface</div>
      </BlitzThemedLodyTree>,
    );
    cleanup = mounted.unmount;
    await settle();

    const dark = readBlitzPalette(null, "dark");
    expect(applied("--vscode-editor-background")).toBe(dark.paper.toUpperCase());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("follows the shell across a live flip, in both directions", async () => {
    const theme = adoptShellTheme();
    const mounted = await render(
      <BlitzThemedLodyTree theme={theme}>
        <div>surface</div>
      </BlitzThemedLodyTree>,
    );
    cleanup = mounted.unmount;
    await settle();

    const light = readBlitzPalette(null, "light");
    const dark = readBlitzPalette(null, "dark");
    expect(applied("--vscode-editor-background")).toBe(dark.paper.toUpperCase());

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "light");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(applied("--vscode-editor-background")).toBe(light.paper.toUpperCase());
    expect(document.getElementById("blitz-lody-theme")?.textContent).toContain("Blitz light");

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(applied("--vscode-editor-background")).toBe(dark.paper.toUpperCase());
    expect(document.getElementById("blitz-lody-theme")?.textContent).toContain("Blitz dark");
  });
});
