import { describe, expect, it } from "vitest";
import type { WorkspaceTabs } from "../src/storage.js";
import {
  appendTab,
  archiveTab,
  closeTab,
  filesHostRegion,
  moveTab,
  paneRegions,
  regionTabs,
  removeTabPermanently,
  renameTab,
  restoreTab,
  showPanelTab,
  splitTab,
  togglePanelTab,
} from "../src/workspace-panes.js";
import {
  dropSideFor,
  insertionBeforeId,
  landingBox,
  paneDropTarget,
} from "../src/workspace-drag.js";

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

  it("moves a tab between panes and keeps each pane's own selection", () => {
    const withPanel = togglePanelTab(tabs(), "files");
    const moved = moveTab(withPanel, 1, "side", 3);
    expect(regionTabs(moved, "side").map(({ id }) => id)).toEqual([1, 3]);
    expect(moved.sideActiveId).toBe(1);
    expect(moved.activeId).toBe(2);
  });

  it("reorders inside one pane when the drop names an insertion point", () => {
    const reordered = moveTab(tabs(), 2, "main", 1);
    expect(reordered.tabs.map(({ id }) => id)).toEqual([2, 1]);
    expect(reordered.activeId).toBe(2);
  });

  it("collapses the split when the last tab leaves the side pane", () => {
    const withPanel = togglePanelTab(tabs(), "files");
    const collapsed = moveTab(withPanel, 3, "main", null);
    expect(paneRegions(collapsed)).toEqual(["main"]);
    expect(collapsed.tabs.at(-1)).toEqual({ id: 3, type: "panel", panel: "files" });
  });

  it("pushes the neighbours aside when a tab claims the column it is already in", () => {
    const split = splitTab(tabs(), 1, "main");
    expect(regionTabs(split, "main").map(({ id }) => id)).toEqual([1]);
    expect(regionTabs(split, "side").map(({ id }) => id)).toEqual([2]);
    expect(split.activeId).toBe(1);
    expect(split.sideActiveId).toBe(2);
  });

  it("splits a tab out to the right when the drop names the other column", () => {
    const split = splitTab(tabs(), 2, "side");
    expect(regionTabs(split, "side").map(({ id }) => id)).toEqual([2]);
    expect(split.activeId).toBe(1);
  });

  it("promotes the side pane when the main pane empties", () => {
    const split = splitTab(tabs(), 2, "side");
    const emptied = closeTab(split, 1);
    expect(paneRegions(emptied)).toEqual(["main"]);
    expect(emptied.activeId).toBe(2);
  });

  it("selects the neighbour of a closed tab inside its own pane", () => {
    const three = appendTab(tabs(), "main", (id) => ({ id, type: "terminal" }));
    expect(closeTab(three, 3).activeId).toBe(2);
    expect(closeTab({ ...three, activeId: 1 }, 2).activeId).toBe(1);
  });

  it("archives and restores a managed tab with its title, id, and pane", () => {
    const split = appendTab(tabs(), "side", (id) => ({
      id,
      type: "chat",
      title: "Release notes",
      chatSessionId: "chat-release",
    }));
    const archived = archiveTab(split, 3);
    expect(archived.tabs.map(({ id }) => id)).toEqual([1, 2]);
    expect(archived.archivedTabs).toEqual([{
      id: 3,
      type: "chat",
      title: "Release notes",
      chatSessionId: "chat-release",
      region: "side",
    }]);
    expect(archived.nextId).toBe(4);

    const restored = restoreTab(archived, 3);
    expect(regionTabs(restored, "side")).toEqual([{
      id: 3,
      type: "chat",
      title: "Release notes",
      chatSessionId: "chat-release",
      region: "side",
    }]);
    expect(restored.sideActiveId).toBe(3);
    expect(restored.archivedTabs).toBeUndefined();
    expect(restored.nextId).toBe(4);
  });

  it("keeps ids monotonic when archived entries are removed", () => {
    const archived = archiveTab(tabs(), 2);
    const removed = removeTabPermanently(archived, 2);
    expect(removed.archivedTabs).toBeUndefined();
    expect(removed.nextId).toBe(3);
    expect(appendTab(removed, "main", (id) => ({ id, type: "terminal" })).tabs.at(-1)?.id)
      .toBe(3);
  });

  it("renames active and archived sessions and resets empty titles", () => {
    const active = renameTab(tabs(), 1, "  Deploy shell  ");
    expect(active.tabs[0]).toEqual({ id: 1, type: "claude", title: "Deploy shell" });
    const archived = archiveTab(active, 1);
    expect(renameTab(archived, 1, "   ").archivedTabs).toEqual([
      { id: 1, type: "claude" },
    ]);
  });

  it("does not archive file, preview, or panel tabs", () => {
    const withFile = appendTab(tabs(), "main", (id) => ({ id, type: "file", filePath: "a.txt" }));
    expect(archiveTab(withFile, 3)).toBe(withFile);
  });
});

describe("workspace tab drag geometry", () => {
  const strip = { left: 100, width: 200 };

  it("splits on the outer fifth of each edge and inserts in the middle", () => {
    expect(dropSideFor(strip, 110)).toBe("left");
    expect(dropSideFor(strip, 140)).toBe("left");
    expect(dropSideFor(strip, 141)).toBeNull();
    expect(dropSideFor(strip, 259)).toBeNull();
    expect(dropSideFor(strip, 260)).toBe("right");
    expect(dropSideFor(strip, 295)).toBe("right");
  });

  it("names the column an edge drop points at, never the pane it came from", () => {
    expect(paneDropTarget("side", "left", [], 0, 1)).toEqual({ kind: "split", region: "main" });
    expect(paneDropTarget("main", "right", [], 0, 1)).toEqual({ kind: "split", region: "side" });
  });

  it("puts the insertion bar in front of the first cell the pointer has not passed", () => {
    const cells = [
      { id: 1, left: 0, width: 100 },
      { id: 2, left: 100, width: 100 },
    ];
    expect(insertionBeforeId(cells, 10, 9)).toBe(1);
    expect(insertionBeforeId(cells, 120, 9)).toBe(2);
    expect(insertionBeforeId(cells, 190, 9)).toBeNull();
    // The tab being dragged is not its own drop anchor.
    expect(insertionBeforeId(cells, 10, 1)).toBe(2);
  });

  it("draws the landing rectangle over the column the drop will use", () => {
    const container = { left: 0, top: 0, width: 400, height: 300 };
    const existing = { left: 240, top: 0, width: 160, height: 300 };
    expect(landingBox({ kind: "tab", region: "side", beforeId: null }, container, existing, 40))
      .toEqual({ left: 240, top: 40, width: 160, height: 260 });
    // A column that does not exist yet claims its own half of the container.
    expect(landingBox({ kind: "split", region: "side" }, container, null, 40))
      .toEqual({ left: 200, top: 40, width: 200, height: 260 });
    expect(landingBox({ kind: "split", region: "main" }, container, null, 40))
      .toEqual({ left: 0, top: 40, width: 200, height: 260 });
  });
});
