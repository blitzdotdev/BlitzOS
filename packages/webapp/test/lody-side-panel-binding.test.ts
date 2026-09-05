/**
 * The shell side of seam patch 23 (`src/lody/side-panel.tsx`): the strip's
 * fixed vocabulary of panels, two of them ours.
 */
import { describe, expect, it } from "vitest";
import {
  BROWSER_SIDE_PANEL_ID,
  CONNECTIONS_SIDE_PANEL_ID,
  SIDE_PANEL_QUICK_ACTIONS,
  SIDE_PANEL_QUICK_ACTION_LABELS,
} from "../src/lody/side-panel.js";

describe("the strip's vocabulary", () => {
  it("names five panels in strip order, ours last", () => {
    expect(SIDE_PANEL_QUICK_ACTIONS).toEqual([
      "side-session",
      "files",
      "changes",
      BROWSER_SIDE_PANEL_ID,
      CONNECTIONS_SIDE_PANEL_ID,
    ]);
    // A host id can never collide with one of Lody's fixed panels.
    expect(BROWSER_SIDE_PANEL_ID.startsWith("host:")).toBe(true);
    expect(CONNECTIONS_SIDE_PANEL_ID.startsWith("host:")).toBe(true);
  });

  it("labels each panel the way Lody's own tab bar does", () => {
    expect(SIDE_PANEL_QUICK_ACTION_LABELS).toEqual({
      "side-session": "Side Chat",
      files: "Files",
      changes: "All Changes",
      [BROWSER_SIDE_PANEL_ID]: "Browser",
      [CONNECTIONS_SIDE_PANEL_ID]: "Connections",
    });
  });
});
