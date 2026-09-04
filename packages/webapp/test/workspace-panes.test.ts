import { describe, expect, it } from "vitest";
import type { WorkspaceTabs } from "../src/storage.js";
import {
  appendTab,
  closeTab,
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
    const opened = togglePanelTab(tabs(), "connections");
    expect(paneRegions(opened)).toEqual(["main", "side"]);
    expect(regionTabs(opened, "side")).toEqual([
      { id: 3, type: "panel", panel: "connections", region: "side" },
    ]);
    expect(opened.sideActiveId).toBe(3);

    const closed = togglePanelTab(opened, "connections");
    expect(paneRegions(closed)).toEqual(["main"]);
    expect(closed.tabs).toEqual(tabs().tabs);
    expect("sideActiveId" in closed).toBe(false);
  });

  it("brings a backgrounded panel forward instead of closing it", () => {
    const withPanel = togglePanelTab(tabs(), "connections");
    // A terminal in the side pane, in front of the panel. Written by hand:
    // `moveTab` is deleted with the strip that was its only caller
    // (plans/LODY-TERMINAL-TABS.md §4.6).
    const withBoth: WorkspaceTabs = {
      ...withPanel,
      tabs: withPanel.tabs.map((tab) => (tab.id === 2 ? { ...tab, region: "side" as const } : tab)),
      activeId: 1,
      sideActiveId: 2,
    };
    // Connections is open but behind it, so its icon selects rather than closes.
    const refocused = togglePanelTab(withBoth, "connections");
    expect(refocused.sideActiveId).toBe(3);
    expect(regionTabs(refocused, "side")).toHaveLength(2);
  });

  it("never toggles a panel shut through the mobile segment strip", () => {
    const opened = showPanelTab(tabs(), "connections");
    expect(showPanelTab(opened, "connections").sideActiveId).toBe(3);
  });

  it("appends a tab at the end of its own column, not the flat list", () => {
    const withPanel = togglePanelTab(tabs(), "connections");
    const withPreview = appendTab(withPanel, "main", (id) => ({ id, type: "preview", port: 3000 }));
    expect(withPreview.tabs.map(({ id }) => id)).toEqual([1, 2, 4, 3]);
    expect(regionTabs(withPreview, "main").map(({ id }) => id)).toEqual([1, 2, 4]);
    expect(withPreview.activeId).toBe(4);
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

  it("renames active sessions and resets empty titles", () => {
    const active = renameTab(tabs(), 1, "  Deploy shell  ");
    expect(active.tabs[0]).toEqual({ id: 1, type: "claude", title: "Deploy shell" });
    expect(renameTab(active, 1, "   ").tabs[0]).toEqual({ id: 1, type: "claude" });
  });
});
