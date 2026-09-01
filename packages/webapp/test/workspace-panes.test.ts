import { describe, expect, it } from "vitest";
import type { WorkspaceTabs } from "../src/storage.js";
import {
  appendTab,
  closeFileTabsAtPath,
  closeTab,
  filesHostRegion,
  paneRegions,
  regionTabs,
  renameTab,
  showPanelTab,
  togglePanelTab,
} from "../src/workspace-panes.js";

function tabs(): WorkspaceTabs {
  return {
    version: 1,
    tabs: [{ id: 1, type: "claude" }, { id: 2, type: "terminal" }],
    activeId: 1,
    nextId: 3,
  };
}

describe("workspace pane model", () => {
  it("opens a panel into the side pane and collapses the split when it closes", () => {
    const opened = togglePanelTab(tabs(), "files");
    expect(paneRegions(opened)).toEqual(["main", "side"]);
    expect(regionTabs(opened, "side")).toEqual([
      { id: 3, type: "panel", panel: "files", region: "side" },
    ]);
    expect(opened.sideActiveId).toBe(3);

    const closed = togglePanelTab(opened, "files");
    expect(paneRegions(closed)).toEqual(["main"]);
    expect(closed.tabs).toEqual(tabs().tabs);
    expect("sideActiveId" in closed).toBe(false);
  });

  it("brings a backgrounded panel forward instead of closing it", () => {
    const withFiles = togglePanelTab(tabs(), "files");
    const withBoth = togglePanelTab(withFiles, "previews");
    expect(withBoth.sideActiveId).toBe(4);
    // Files is open but behind teenyapps, so its icon selects rather than closes.
    const refocused = togglePanelTab(withBoth, "files");
    expect(refocused.sideActiveId).toBe(3);
    expect(regionTabs(refocused, "side")).toHaveLength(2);
  });

  it("never toggles a panel shut through the mobile segment strip", () => {
    const opened = showPanelTab(tabs(), "files");
    expect(showPanelTab(opened, "files").sideActiveId).toBe(3);
  });

  it("hosts a file beside the Files panel, whichever pane that is", () => {
    expect(filesHostRegion(tabs())).toBe("main");
    expect(filesHostRegion(togglePanelTab(tabs(), "files"))).toBe("side");
  });

  it("appends a tab at the end of its own column, not the flat list", () => {
    const withPanel = togglePanelTab(tabs(), "files");
    const withFile = appendTab(withPanel, "main", (id) => ({ id, type: "file", filePath: "a.txt" }));
    expect(withFile.tabs.map(({ id }) => id)).toEqual([1, 2, 4, 3]);
    expect(regionTabs(withFile, "main").map(({ id }) => id)).toEqual([1, 2, 4]);
    expect(withFile.activeId).toBe(4);
  });

  it("promotes the side pane when the main pane empties", () => {
    // A document that already holds a side-pane tab still collapses correctly.
    // Written by hand rather than by `splitTab`, which is deleted with the
    // strip that was its only caller (plans/LODY-TERMINAL-TABS.md §4.6).
    const split: WorkspaceTabs = {
      version: 1,
      tabs: [{ id: 1, type: "claude" }, { id: 2, type: "terminal", region: "side" }],
      activeId: 1,
      sideActiveId: 2,
      nextId: 3,
    };
    expect(paneRegions(split)).toEqual(["main", "side"]);
    const emptied = closeTab(split, 1);
    expect(paneRegions(emptied)).toEqual(["main"]);
    expect(emptied.activeId).toBe(2);
  });

  it("selects the neighbour of a closed tab inside its own pane", () => {
    const three = appendTab(tabs(), "main", (id) => ({ id, type: "terminal" }));
    expect(closeTab(three, 3).activeId).toBe(2);
    expect(closeTab({ ...three, activeId: 1 }, 2).activeId).toBe(1);
  });

  it("closes every file tab at or below a deleted path and preserves pane invariants", () => {
    const withFiles: WorkspaceTabs = {
      version: 1,
      tabs: [
        { id: 1, type: "claude" },
        { id: 2, type: "file", filePath: "src/index.ts" },
        { id: 3, type: "file", filePath: "src/components/App.tsx", region: "side" },
        { id: 4, type: "file", filePath: "README.md", region: "side" },
      ],
      activeId: 2,
      sideActiveId: 3,
      nextId: 5,
    };

    const closed = closeFileTabsAtPath(withFiles, "src");
    expect(closed.tabs).toEqual([
      { id: 1, type: "claude" },
      { id: 4, type: "file", filePath: "README.md", region: "side" },
    ]);
    expect(closed.activeId).toBe(1);
    expect(closed.sideActiveId).toBe(4);
    expect(closed.nextId).toBe(5);
  });

  it("renames active sessions and resets empty titles", () => {
    const active = renameTab(tabs(), 1, "  Deploy shell  ");
    expect(active.tabs[0]).toEqual({ id: 1, type: "claude", title: "Deploy shell" });
    expect(renameTab(active, 1, "   ").tabs[0]).toEqual({ id: 1, type: "claude" });
  });
});
