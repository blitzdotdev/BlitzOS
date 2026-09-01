/**
 * THE NATIVE TERMINAL TAB STRIP IS DELETED, AND STAYS DELETED.
 *
 * plans/LODY-TERMINAL-TABS.md §4.6 called this "PR 2 — the deletion". A terminal
 * is a tab of Lody's session strip; the BlitzOS-native strip was the second tab
 * system item 4 forbids, and the report that ordered its removal was that it
 * "sometimes comes back when I refresh the page".
 *
 * A SOURCE TEST, on the precedent `lody-lazy-boundary.test.ts` set. The property
 * being defended is "no module names these things", which is exactly a source
 * property: a render test can only prove the strip did not appear in the cases
 * it thought to mount, and the two leaks that produced the report were both
 * cases nobody had mounted. This file cannot be satisfied by a gate, a flag or a
 * branch — only by the code being gone.
 *
 * `lody-terminal-tab-wave3.test.tsx` is the behavioural half: it mounts the real
 * shell and asserts that a cold load renders no strip and that the workspace
 * root resolves into the chat plane. `lody-old-box-fallback.test.tsx` is the
 * third: a box with no session plane gets the rail's notice and not a strip.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

/** Every `.ts`/`.tsx` under `packages/webapp/src`, vendored tree excluded — the
 * vendored renderer has a terminal dock of its own and it is not ours. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "stubs") continue;
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

const FILES = sourceFiles(src);
const read = (path: string): string => readFileSync(path, "utf8");
const name = (path: string): string => relative(src, path);

/**
 * The modules that were the native tab system. Deleted outright rather than
 * emptied, so the assertion is that nothing imports them — a resurrection has
 * to re-create a file, which a reviewer sees.
 */
const DELETED_MODULES = [
  "WebAppHeader",
  "use-workspace-tab-drag",
  "workspace-drag",
];

/**
 * The DOM markers the strip drew. `webapp-tab-cell`, `webapp-tab-select` and
 * `webapp-tab-label` are deliberately NOT here: the workspace drawer's segment
 * strip shares that chrome and kept it (`WorkspaceDrawer.tsx`), which is the one
 * piece of the deletion a class-name sweep would get wrong.
 */
const DELETED_MARKERS = [
  "webapp-tabstrip",
  "webapp-pane-strip",
  "webapp-tab-close",
  "webapp-tab-insert",
  "webapp-tab-rename",
  "webapp-tab-dirty",
  "webapp-new-tab-control",
  "webapp-new-tab-spawn",
  "webapp-pane-drop",
  "webapp-pane-ghost",
  "webapp-pane-droptip",
];

/** The exported names that only the strip and its drag ever had a caller for. */
const DELETED_SYMBOLS = [
  "WebAppHeader",
  "useWorkspaceTabDrag",
  "terminalFirstWorkspaceTabs",
  "moveTab",
  "splitTab",
  "paneTabModels",
  "tabStrips",
];

describe("the deleted native tab strip", () => {
  it("has no module left to import", () => {
    for (const file of FILES) {
      const source = read(file);
      for (const module of DELETED_MODULES) {
        expect(
          source.includes(`from './${module}'`)
            || source.includes(`from "./${module}.js"`)
            || source.includes(`from '../${module}'`)
            || source.includes(`from "../${module}.js"`),
          `${name(file)} imports the deleted ${module}`,
        ).toBe(false);
      }
    }
  });

  it("names none of its DOM markers", () => {
    for (const file of FILES) {
      const source = read(file);
      for (const marker of DELETED_MARKERS) {
        expect(source.includes(marker), `${name(file)} still draws .${marker}`).toBe(false);
      }
    }
  });

  it("names none of its symbols", () => {
    for (const file of FILES) {
      const source = read(file);
      for (const symbol of DELETED_SYMBOLS) {
        // Comments are where the deletion is EXPLAINED, so they are exempt;
        // code is not.
        const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
        // Word-bounded, and never a property access: `moveTab` must not match
        // `tabs.moveTab` in a type it does not own, nor `withRegionActiveId`.
        const used = new RegExp(`(?<![\\w.])${symbol}\\b`, "u").test(code);
        expect(used, `${name(file)} still uses ${symbol}`).toBe(false);
      }
    }
  });

  it("leaves no stylesheet rule to draw it", () => {
    // The CSS is the other half: a rule with no element is dead weight, and a
    // rule that survives is what makes a resurrection look finished.
    const sheets = readdirSync(src)
      .filter((entry) => entry.endsWith(".css"))
      .map((entry) => join(src, entry));
    for (const sheet of sheets) {
      // Comments name what was removed, on purpose.
      const source = read(sheet).replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const marker of DELETED_MARKERS) {
        expect(
          source.includes(`.${marker}`),
          `${relative(src, sheet)} still styles .${marker}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the pieces the session strip and the drawer still need", () => {
    // The deletion must not have taken the shared chrome with it. `NewTabMenu`
    // is the rail's `+`, `SessionTypeIcon` is every glyph, and the drawer's
    // segment strip still uses the tab-cell classes.
    const kept = ["NewTabMenu.tsx", "SessionTypeIcon.tsx", "shell/NewTabControl.tsx"];
    for (const file of kept) {
      expect(() => read(join(src, file)), `${file} was deleted with the strip`).not.toThrow();
    }
    expect(read(join(src, "WorkspaceDrawer.tsx"))).toContain("webapp-tab-cell");
    expect(read(join(src, "SessionTypeIcon.tsx"))).toContain("WebAppTabModel");
  });
});
