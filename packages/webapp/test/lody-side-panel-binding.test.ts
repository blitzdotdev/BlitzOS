/**
 * The shell side of seam patches 10 and 11 (`src/lody/side-panel.tsx`): the
 * gateway URL a loopback address in Lody's Browser panel resolves to, and the
 * strip's fixed vocabulary of panels.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTIONS_SIDE_PANEL_ID,
  SIDE_PANEL_QUICK_ACTIONS,
  SIDE_PANEL_QUICK_ACTION_LABELS,
  managedPreviewViewerUrl,
} from "../src/lody/side-panel.js";

// The files base the resolver hands out ends in the dufs root, `workspace/`.
const filesBase = "https://app.example/workspaces/ws-1/webapp/7445/workspace/";

describe("managedPreviewViewerUrl", () => {
  it("routes a loopback target through the box gateway's preview proxy", () => {
    expect(
      managedPreviewViewerUrl(filesBase, { protocol: "http", host: "localhost", port: 3000 }),
    ).toBe("https://app.example/workspaces/ws-1/webapp/7445/preview/3000/");
    expect(
      managedPreviewViewerUrl(filesBase, { protocol: "http", host: "127.0.0.1", port: 5173, path: "/app/x" }),
    ).toBe("https://app.example/workspaces/ws-1/webapp/7445/preview/5173/app/x");
  });

  it("keeps the query, drops the fragment, and normalizes an empty path", () => {
    expect(
      managedPreviewViewerUrl(filesBase, {
        protocol: "http",
        host: "localhost",
        port: 3000,
        path: "/docs?tab=2#top",
      }),
    ).toBe("https://app.example/workspaces/ws-1/webapp/7445/preview/3000/docs?tab=2");
    expect(
      managedPreviewViewerUrl(filesBase, { protocol: "http", host: "LOCALHOST", port: 3000, path: "" }),
    ).toBe("https://app.example/workspaces/ws-1/webapp/7445/preview/3000/");
  });

  it("hands everything the gateway would refuse back to upstream", () => {
    // Not loopback.
    expect(
      managedPreviewViewerUrl(filesBase, { protocol: "http", host: "10.0.0.5", port: 3000 }),
    ).toBeNull();
    // A reserved box port.
    expect(
      managedPreviewViewerUrl(filesBase, { protocol: "http", host: "localhost", port: 7445 }),
    ).toBeNull();
    // A path with a `..` segment.
    expect(
      managedPreviewViewerUrl(filesBase, { protocol: "http", host: "localhost", port: 3000, path: "/a/../b" }),
    ).toBeNull();
    // No box to proxy through.
    expect(
      managedPreviewViewerUrl(null, { protocol: "http", host: "localhost", port: 3000 }),
    ).toBeNull();
  });
});

describe("the strip's vocabulary", () => {
  it("names five panels in strip order, with Connections last", () => {
    expect(SIDE_PANEL_QUICK_ACTIONS).toEqual([
      "side-session",
      "files",
      "changes",
      "browser",
      CONNECTIONS_SIDE_PANEL_ID,
    ]);
    expect(CONNECTIONS_SIDE_PANEL_ID.startsWith("host:")).toBe(true);
  });

  it("labels each panel the way Lody's own tab bar does", () => {
    expect(SIDE_PANEL_QUICK_ACTION_LABELS).toEqual({
      "side-session": "Side Chat",
      files: "Files",
      changes: "All Changes",
      browser: "Browser",
      [CONNECTIONS_SIDE_PANEL_ID]: "Connections",
    });
  });
});
