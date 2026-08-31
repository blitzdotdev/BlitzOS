/**
 * The Blitz theme, measured out of a PRODUCTION BUILD
 * (plans/LODY-RUNTIME-DESIGN.md §16).
 *
 * WHY THIS EXISTS. The reskin shipped with three green harnesses and reached
 * canary looking unchanged. Every one of those harnesses ran the SOURCE graph
 * through Vitest, and the static review page inlined `blitzThemeStylesheet()`
 * output directly — so between "the code is right" and "the member sees it"
 * there was a whole build nobody had run: vendor aliases resolved, chunks split,
 * unreachable code dropped, everything minified, the bundled theme JSONs
 * inlined as `?raw` strings. This test closes that gap, and it is the reason
 * `test/prod-probe/` exists.
 *
 * WHAT IT ACTUALLY PROVES, which is narrow and worth stating:
 *
 * - `blitz-theme.ts` and the vendored registry are STILL THE SAME MODULE after
 *   chunking. They land in different chunks (`SessionSurface-*` and
 *   `markdown-renderer-*`), and a second instance of `bundledThemesById` would
 *   mean our registration and their lookup were talking past each other, with
 *   no error anywhere.
 * - The theme still resolves through their zod schemas and their jsonc parser
 *   once minified, and `resolveBundledVSCodeThemesFromExtensions` logs nothing.
 * - The generated sheet is written, and the compiled variables land on `<html>`
 *   exactly as `LodyThemeProvider`'s layout effect would land them.
 *
 * WHAT IT DOES NOT PROVE: that React mounts. The probe mounts none — that link
 * is covered where it can be covered honestly, in `lody-theme-application.test.tsx`
 * (their real provider, source), `lody-theme-race.test.tsx` (the same, with the
 * registry lost) and `lody-session-surface.test.tsx` (the real `SessionSurface`
 * against a real daemon). Running React out of the built bundle needs a browser,
 * and this box has no working one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexColorToHslChannel } from "@lody/components/lib/vscode-theme";
import { readBlitzPalette } from "../src/lody/blitz-palette";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = join(here, "..");
const repo = join(webapp, "..", "..");

interface ProbeReport {
  readonly shellMode: string;
  readonly installed: boolean;
  readonly expectedLabel: string;
  readonly registryLabel: string | null;
  readonly htmlThemeId: string | null;
  readonly htmlEditorBackground: string;
  readonly htmlPrimary: string;
  readonly htmlMuted: string;
  readonly sheetPresent: boolean;
  readonly sheetText: string;
  readonly noise: readonly string[];
}

let built: string;

/** Builds `test/prod-probe` with the product's own plugin pipeline. */
function buildProbe(outDir: string): void {
  execFileSync(
    process.execPath,
    [
      `--env-file=${join(repo, "env.defaults")}`,
      join(repo, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--config",
      join("test", "prod-probe", "vite.config.ts"),
    ],
    {
      cwd: webapp,
      env: { ...process.env, BLITZ_PROBE_OUT: outDir },
      stdio: "pipe",
      timeout: 300_000,
    },
  );
}

/** Runs the built probe in a plain Node process with a hand-built jsdom. */
function runProbe(primedStorage?: string): ProbeReport {
  const output = execFileSync(
    process.execPath,
    [
      join(here, "prod-probe", "run-built.mjs"),
      built,
      ...(primedStorage === undefined ? [] : [primedStorage]),
    ],
    { cwd: webapp, stdio: "pipe", encoding: "utf8", timeout: 120_000 },
  );
  const line = output.split("\n").find((row) => row.startsWith("__PROBE__"));
  if (line === undefined) throw new Error(`probe printed no report:\n${output}`);
  return JSON.parse(line.slice("__PROBE__".length)) as ProbeReport;
}

beforeAll(() => {
  built = mkdtempSync(join(tmpdir(), "blitz-theme-probe-"));
  buildProbe(built);
}, 300_000);

afterAll(() => {
  if (built !== undefined) rmSync(built, { recursive: true, force: true });
});

describe("the Blitz theme in a production build", () => {
  it("registers, resolves and applies, with nothing logged", () => {
    const report = runProbe();
    const palette = readBlitzPalette(null, "dark");

    expect(report.shellMode).toBe("dark");
    // The registration took. A `false` here with an empty `noise` would mean
    // something resolved their ids first; a `false` WITH noise would mean the
    // theme failed their schema once minified.
    expect(report.installed).toBe(true);
    expect(report.registryLabel).toBe(report.expectedLabel);
    expect(report.noise).toEqual([]);

    // And it reached the html element, which is what a member sees.
    expect(report.htmlThemeId).toBe("vesper");
    expect(report.htmlEditorBackground).toBe(palette.paper.toUpperCase());
    expect(report.htmlPrimary).toBe(hexColorToHslChannel(palette.accent));
    expect(report.htmlPrimary).not.toBe(hexColorToHslChannel("#FFC799"));
  }, 60_000);

  it("writes the generated sheet, with the :root reclaim in it", () => {
    const report = runProbe();
    expect(report.sheetPresent).toBe(true);
    expect(report.sheetText).toContain(".lody-surface");
    expect(report.sheetText).toContain(".session-list--vendor");
    expect(report.sheetText).toContain("!important");
  }, 60_000);

  it("is unmoved by a returning member's stored Lody theme", () => {
    // A member who used the surface before the reskin still has whatever they
    // last chose under `blitz-lody-theme`. `adoptShellTheme` overwrites the key
    // before their provider reads it, so none of these may change the palette
    // the surface adopts — including a value that names a theme which no longer
    // resolves.
    // Three cases, not five: each is a fresh Node process, because `installed`
    // and their registry are module state. `light` and `system` are the two
    // that used to be able to disagree with the shell, and `not-a-theme` is the
    // value their parser rejects.
    for (const stored of ["light", "system", "not-a-theme"]) {
      const report = runProbe(JSON.stringify({ "blitz-lody-theme": stored }));
      const palette = readBlitzPalette(null, "dark");
      expect(report.shellMode, stored).toBe("dark");
      expect(report.installed, stored).toBe(true);
      expect(report.htmlEditorBackground, stored).toBe(palette.paper.toUpperCase());
    }
  }, 120_000);

  it("is unmoved by a stale VS Code theme selection", () => {
    // Their selection module can persist a pair of theme ids. The provider
    // ignores storage entirely today (`theme-provider.tsx:42` pins the
    // selection), and this is what fails if that ever changes.
    const report = runProbe(
      JSON.stringify({
        "lody-vscode-theme-selection": JSON.stringify({
          schemaVersion: 1,
          darkThemeId: "tokyo-night",
          lightThemeId: "github-light-default",
        }),
      }),
    );
    expect(report.installed).toBe(true);
    expect(report.htmlEditorBackground).toBe(readBlitzPalette(null, "dark").paper.toUpperCase());
  }, 60_000);
});
