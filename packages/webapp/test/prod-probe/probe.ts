/**
 * What the PRODUCTION BUNDLE does with the Blitz theme.
 *
 * WHY THIS EXISTS. The reskin shipped with three green harnesses — a source
 * render, a compiled-CSS read, and a static page — and none of them ran the
 * BUILT artefact. Everything they proved was true of the source graph. This
 * runs the same code after Vite has resolved the vendor aliases, split the
 * chunks, dropped what it thinks is unreachable and minified the rest, which is
 * the only place a "works in test, invisible in production" bug can be seen.
 *
 * IT MOUNTS NO REACT, DELIBERATELY. The link React would add — "their provider
 * applies whatever the registry holds" — is proven twice already, in a source
 * render (`lody-blitz-theme.test.ts`) and against a real daemon
 * (`lody-session-surface.test.tsx`). What only the bundle can answer is whether
 * MY module and THEIR registry are still the same module after chunking, and
 * whether the theme still resolves through their zod schemas and their
 * jsonc parser once minified. So this calls exactly what the provider calls,
 * in the order it calls it, and reports.
 *
 * IT IMPORTS NO CSS, also deliberately. A built stylesheet is a separate file
 * that this jsdom never loads, so importing it would prove nothing and would
 * pull the whole vendored Tailwind pass into the build — which on a four-core
 * box is enough contention to push the daemon-backed suites past their
 * start-up deadline. What the built CSS contains is a question for
 * `lody-blitz-theme.test.ts`, which reads the compiled sheet through the same
 * plugin pipeline.
 */
import {
  applyVSCodeThemeCssVariables,
  getBundledVSCodeThemeByIdSync,
} from "@lody/components/lib/vscode-theme";
import { BLITZ_THEME_IDS, BLITZ_THEME_LABELS, installBlitzLodyTheme, isBlitzThemeInstalled } from "../../src/lody/blitz-theme";
import { resolvedTheme } from "../../src/theme";

declare global {
  interface Window {
    __probe?: Record<string, unknown>;
  }
}

/** `resolveBundledVSCodeThemesFromExtensions` swallows a per-theme failure into
 * `console.warn`, so a probe that did not collect these would read a silent
 * fallback as a success. */
const noise: string[] = [];
for (const level of ["warn", "error"] as const) {
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    noise.push(
      `[${level}] ${args
        .map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value)))
        .join(" ")}`,
    );
    original(...args);
  };
}

const mode = resolvedTheme();
installBlitzLodyTheme(mode);

// Exactly what `LodyThemeProvider`'s layout effect does (`theme-provider.tsx:165`).
const themeId = BLITZ_THEME_IDS[mode];
const active = getBundledVSCodeThemeByIdSync(themeId) as { label?: string } | undefined;
if (active) applyVSCodeThemeCssVariables(document.documentElement, active);

const root = document.documentElement;
window.__probe = {
  shellMode: mode,
  installed: isBlitzThemeInstalled(),
  expectedLabel: BLITZ_THEME_LABELS[mode],
  registryLabel: active?.label ?? null,
  htmlThemeId: root.dataset.lodyVscodeTheme ?? null,
  htmlEditorBackground: root.style.getPropertyValue("--vscode-editor-background"),
  htmlPrimary: root.style.getPropertyValue("--primary"),
  htmlMuted: root.style.getPropertyValue("--muted"),
  sheetPresent: document.getElementById("blitz-lody-theme") !== null,
  sheetText: document.getElementById("blitz-lody-theme")?.textContent ?? "",
  noise,
};
document.title = "probe-ready";
