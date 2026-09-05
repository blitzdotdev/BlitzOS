/**
 * How the vendored surface comes to wear the BlitzOS palette, and stays wearing
 * it (plans/LODY-RUNTIME-DESIGN.md §5.3, §14, §16).
 *
 * Its own module, and not two functions inside `SessionSurface.tsx`, because of
 * what §16 found: the reskin shipped green and reached canary looking
 * unchanged, and no test could have caught it — the only harness that mounted
 * the real provider stack was the one that needs a `lody` daemon and skips in
 * CI. Everything here imports their theme provider, our theme module and
 * nothing else, so the whole application path can be mounted in a test for the
 * price of `next-themes`, rather than the price of Monaco, three and shiki.
 */
import { useEffect, type ReactNode } from "react";
import { ThemeProvider, useTheme as useLodyTheme } from "@lody/components/theme-provider";
import { applyBlitzSurfaceTheme, applyBlitzThemeToRoot, installBlitzLodyTheme } from "./blitz-theme.js";
import { resolvedTheme, subscribeTheme } from "../theme.js";

/** next-themes persists under its own key. Ours is namespaced so the surface's
 * light/dark choice can never be confused with `blitz-theme`, which is the
 * shell's and is stored as a `data-theme` attribute rather than a class. */
export const LODY_THEME_STORAGE_KEY = "blitz-lody-theme";

/**
 * Forces their theme engine onto the shell's current choice, and returns it.
 *
 * This is not cosmetic. `LodyThemeProvider` (`theme-provider.tsx:149`) writes
 * `document.documentElement.style.colorScheme` on every resolved theme — an
 * INLINE style on the html element, which beats our `:root { color-scheme }`
 * from any stylesheet. So a surface that resolved `light` while the shell is
 * dark would repaint our scrollbars and form controls, everywhere, not just
 * inside the surface.
 *
 * `defaultTheme` alone is not enough, because next-themes prefers its stored
 * value on every later boot. Writing the key first makes the stored value ours,
 * every mount — which is also what keeps a member who used the surface before
 * the reskin, and still has `light` or `system` in that key, from getting a
 * light surface inside a dark shell. `'system'` is never handed over:
 * `resolvedTheme()` has already resolved it against `prefers-color-scheme`, so
 * the surface adopts the palette `tokens.css` is actually painting rather than
 * a preference name.
 *
 * It also installs the Blitz theme, because both halves have the same deadline:
 * `LodyThemeProvider` reads the bundled registry in a LAYOUT effect on its first
 * render, and `getBundledVSCodeThemeByIdSync` caches whatever answered first.
 */
export function adoptShellTheme(): "dark" | "light" {
  const choice = resolvedTheme();
  installBlitzLodyTheme(choice);
  try {
    window.localStorage.setItem(LODY_THEME_STORAGE_KEY, choice);
  } catch {
    // Sandboxed storage: `defaultTheme` still applies for this mount.
  }
  return choice;
}

/**
 * Keeps the surface on the shell's theme, and keeps the theme ITSELF applied.
 *
 * `adoptShellTheme` settles the first paint; this settles every one after it,
 * and it owns two different jobs.
 *
 * 1. PUSH the shell's choice into their tree. `setTheme` is next-themes', so
 *    this has to be a child of `ThemeProvider`; `applyBlitzSurfaceTheme`
 *    rewrites the generated sheet the surface, the rail and the Radix portals
 *    read.
 * 2. RE-APPLY the Blitz palette to the html element on every commit where their
 *    resolved theme changed, whatever the bundled registry answered.
 *
 * JOB 2 IS §16's FIX. The html-level application used to be theirs alone:
 * `LodyThemeProvider` looks its theme up by id in a cache that never replaces an
 * entry (`bundled-vscode-themes.ts:516`), so the whole reskin rested on our
 * registration running before their first lookup. That is a RACE, not a
 * guarantee — it holds for the mount order this tree happens to have, and
 * nothing upstream promises to keep it. A PASSIVE effect is the hook that
 * settles it: React runs every layout effect in a commit before any passive
 * one, `LodyThemeProvider`'s application included, so ours is the one that
 * stands.
 *
 * It keys on THEIR resolved theme rather than the shell's, so it re-asserts on
 * exactly the commits they re-apply on.
 */
export function ShellThemeBridge(props: { children: ReactNode }) {
  const { setTheme, resolvedTheme: lodyResolvedTheme } = useLodyTheme();
  const mode = lodyResolvedTheme === "light" ? "light" : "dark";
  useEffect(
    () =>
      subscribeTheme((theme) => {
        applyBlitzSurfaceTheme(theme, document.documentElement);
        setTheme(theme);
      }),
    [setTheme],
  );
  useEffect(() => applyBlitzThemeToRoot(mode), [mode]);
  return <>{props.children}</>;
}

/**
 * The theme half of the surface's provider stack: their `ThemeProvider` with the
 * shell's choice already adopted, and the bridge that keeps it there.
 *
 * `SessionSurface` renders this above its keyed per-box provider tree. It is
 * exported whole so a test can mount THE THING, rather than a hand-built stack
 * that happens to look like it — which is the shape of mistake §16 is about.
 */
export function BlitzThemedLodyTree(props: { children: ReactNode; theme: "dark" | "light" }) {
  return (
    <ThemeProvider defaultTheme={props.theme} storageKey={LODY_THEME_STORAGE_KEY}>
      <ShellThemeBridge>{props.children}</ShellThemeBridge>
    </ThemeProvider>
  );
}
