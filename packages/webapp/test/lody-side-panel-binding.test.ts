/**
 * The shell side of seam patch 23 (`src/lody/side-panel.tsx`): the strip's
 * fixed vocabulary of panels, one of them ours.
 */
import { describe, expect, it } from "vitest";
import {
  BROWSER_SIDE_PANEL_ID,
  SIDE_PANEL_QUICK_ACTIONS,
  SIDE_PANEL_QUICK_ACTION_LABELS,
} from "../src/lody/side-panel.js";

describe("the strip's vocabulary", () => {
  it("names four panels in strip order, ours last", () => {
    expect(SIDE_PANEL_QUICK_ACTIONS).toEqual([
      "side-session",
      "files",
      "changes",
      BROWSER_SIDE_PANEL_ID,
    ]);
    // A host id can never collide with one of Lody's fixed panels.
    expect(BROWSER_SIDE_PANEL_ID.startsWith("host:")).toBe(true);
  });

  it("labels each panel the way Lody's own tab bar does", () => {
    expect(SIDE_PANEL_QUICK_ACTION_LABELS).toEqual({
      "side-session": "Side Chat",
      files: "Files",
      changes: "All Changes",
      [BROWSER_SIDE_PANEL_ID]: "Browser",
    });
  });

  /** `host:connections` was the second host tab. A workspace's connections are
   * a tab of the workspace-details dialog now, so the strip has no id for
   * them and nothing may reintroduce one here. */
  it("has no connections panel", () => {
    expect(SIDE_PANEL_QUICK_ACTIONS).not.toContain("host:connections");
  });
});
