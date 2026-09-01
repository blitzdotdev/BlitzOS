/**
 * Empty drop-in replacement for shiki's `./themes.mjs`, used ONLY by the standalone
 * single-file build (`vite.standalone.config.ts` aliases shiki's `themes.mjs` here).
 *
 * The viewer registers its own Vesper-derived theme via
 * `registerLodyVSCodeThemeForDiffs` (see `theme-provider.tsx`) and renders with that
 * custom theme name; `@pierre/diffs` also registers `pierre-dark`/`pierre-light`
 * itself. None of shiki's ~60 bundled themes are ever looked up by name, so shipping
 * them would only bloat the inlined HTML. Keeping these maps empty drops every
 * bundled-theme grammar chunk from the build.
 */
type ThemeLoader = () => Promise<{ default: unknown }>;

export const bundledThemesInfo: readonly never[] = [];

export const bundledThemes: Record<string, ThemeLoader> = {};
