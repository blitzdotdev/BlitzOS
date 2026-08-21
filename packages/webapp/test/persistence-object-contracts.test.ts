import { MAX_PREVIEW_PATH_LENGTH } from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import {
  decodeWorkspaceWebAppStateResponse,
  defaultWorkspaceFiles,
  storedWorkspacePreference,
  withPreviewTabPath,
  workspaceWebAppState,
  type WorkspaceTab,
} from "../src/storage.js";
import { ttydHandshake } from "../src/TtydTerminal.js";

describe("UI protocol and persistence object contracts", () => {
  it("preserves ttyd observer geometry omission and tenant key order", () => {
    const observer = ttydHandshake(true, 120, 40);
    expect(Object.keys(observer)).toEqual(["AuthToken"]);
    expect("columns" in observer).toBe(false);
    expect("rows" in observer).toBe(false);
    expect(JSON.stringify(observer)).toBe('{"AuthToken":""}');

    const tenant = ttydHandshake(false, 120, 40);
    expect(Object.keys(tenant)).toEqual(["AuthToken", "columns", "rows"]);
    expect("columns" in tenant).toBe(true);
    expect("rows" in tenant).toBe(true);
    expect(JSON.stringify(tenant)).toBe('{"AuthToken":"","columns":120,"rows":40}');
  });

  it("preserves stored workspace-title omission before agentDefault", () => {
    const defaultTitle = storedWorkspacePreference("box-1", "box-1", "claude");
    expect(Object.keys(defaultTitle)).toEqual(["agentDefault"]);
    expect("title" in defaultTitle).toBe(false);
    expect(JSON.stringify(defaultTitle)).toBe('{"agentDefault":"claude"}');

    const customTitle = storedWorkspacePreference("Docs", "box-1", "codex");
    expect(Object.keys(customTitle)).toEqual(["title", "agentDefault"]);
    expect("title" in customTitle).toBe(true);
    expect(JSON.stringify(customTitle)).toBe('{"title":"Docs","agentDefault":"codex"}');
  });

  it("preserves restored chat optional-key absence, order, and serialization", () => {
    const absent = decodeWorkspaceWebAppStateResponse(JSON.stringify({
      doc: {
        version: 1,
        agentDefault: "claude",
        tabs: { version: 1, tabs: [{ id: 1, type: "chat" }], activeId: 1, nextId: 2 },
        drawer: { version: 1, open: true, width: 264, expanded: [], segment: "files" },
      },
      updatedAt: 1,
    })).doc?.tabs.tabs[0];
    expect(Object.keys(absent ?? {})).toEqual(["id", "type"]);
    expect(absent && "chatSessionId" in absent).toBe(false);
    expect(absent && "chatProvider" in absent).toBe(false);
    expect(JSON.stringify(absent)).toBe('{"id":1,"type":"chat"}');

    const present = decodeWorkspaceWebAppStateResponse(JSON.stringify({
      doc: {
        version: 1,
        agentDefault: "claude",
        tabs: {
          version: 1,
          tabs: [{ id: 1, type: "chat", chatSessionId: "session-1", chatProvider: "codex" }],
          activeId: 1,
          nextId: 2,
        },
        drawer: { version: 1, open: true, width: 264, expanded: [], segment: "files" },
      },
      updatedAt: 1,
    })).doc?.tabs.tabs[0];
    expect(Object.keys(present ?? {})).toEqual(["id", "type", "chatSessionId", "chatProvider"]);
    expect(present && "chatSessionId" in present).toBe(true);
    expect(present && "chatProvider" in present).toBe(true);
    expect(JSON.stringify(present)).toBe(
      '{"id":1,"type":"chat","chatSessionId":"session-1","chatProvider":"codex"}',
    );
  });

  it("accepts wide drawer widths to the server cap and rejects beyond it", () => {
    const doc = (width: number) => JSON.stringify({
      doc: {
        version: 1,
        agentDefault: "claude",
        tabs: { version: 1, tabs: [{ id: 1, type: "terminal" }], activeId: 1, nextId: 2 },
        drawer: { version: 1, open: true, width, expanded: [], segment: "files" },
      },
      updatedAt: 1,
    });
    // The rail-vanish regression: a stored fractional width above the old
    // 480 ceiling must decode, not throw the whole bootstrap away.
    expect(decodeWorkspaceWebAppStateResponse(doc(724.07421875)).doc?.drawer.width)
      .toBe(724.07421875);
    expect(decodeWorkspaceWebAppStateResponse(doc(2000)).doc?.drawer.width).toBe(2000);
    expect(() => decodeWorkspaceWebAppStateResponse(doc(2001))).toThrow();
    expect(() => decodeWorkspaceWebAppStateResponse(doc(199))).toThrow();
  });

  it("restores port and URL preview tabs and rejects malformed URL variants", () => {
    const decodeTabs = (tabs: object[]) => decodeWorkspaceWebAppStateResponse(JSON.stringify({
      doc: {
        version: 1,
        agentDefault: "claude",
        tabs: { version: 1, tabs, activeId: 1, nextId: tabs.length + 1 },
        drawer: { version: 1, width: 264, expanded: [] },
      },
      updatedAt: 1,
    })).doc?.tabs.tabs;

    expect(decodeTabs([
      { id: 1, type: "preview", port: 3000 },
      { id: 2, type: "preview", url: "https://demo.blitz.dev", title: "Demo" },
    ])).toEqual([
      { id: 1, type: "preview", port: 3000 },
      { id: 2, type: "preview", url: "https://demo.blitz.dev", title: "Demo" },
    ]);
    expect(() => decodeTabs([
      { id: 1, type: "preview", url: "", title: "Empty" },
    ])).toThrow("webApp state response has invalid doc");
    expect(() => decodeTabs([
      { id: 1, type: "preview", url: "https://demo.blitz.dev", title: 42 },
    ])).toThrow("webApp state response has invalid doc");
  });

  // The server mirror (packages/control-plane/core/webapp-state.ts) accepts the
  // same optional field with the same "/"-rooted rule. The two parsers must
  // agree, or a deep-linked preview loses its route on the round trip.
  it("keeps the optional deep-link path on a port preview tab", () => {
    const decodeTabs = (tabs: object[]) => decodeWorkspaceWebAppStateResponse(JSON.stringify({
      doc: {
        version: 1,
        agentDefault: "claude",
        tabs: { version: 1, tabs, activeId: 1, nextId: tabs.length + 1 },
        drawer: { version: 1, width: 264, expanded: [] },
      },
      updatedAt: 1,
    })).doc?.tabs.tabs;

    expect(decodeTabs([
      { id: 1, type: "preview", port: 3000, path: "/dashboard" },
      { id: 2, type: "preview", port: 5173 },
    ])).toEqual([
      { id: 1, type: "preview", port: 3000, path: "/dashboard" },
      { id: 2, type: "preview", port: 5173 },
    ]);
    // A relative or non-string path is dropped, not kept as-is.
    expect(decodeTabs([{ id: 1, type: "preview", port: 3000, path: "dashboard" }]))
      .toEqual([{ id: 1, type: "preview", port: 3000 }]);
    expect(decodeTabs([{ id: 1, type: "preview", port: 3000, path: 42 }]))
      .toEqual([{ id: 1, type: "preview", port: 3000 }]);
    // A `..` segment is dropped by both parsers. It has to be: the browser
    // normalizes `/preview/<port>/app/../../workspace/` before the request
    // leaves the tab, so a kept `..` walks the iframe out of the preview
    // prefix and onto another box surface.
    expect(decodeTabs([{ id: 1, type: "preview", port: 3000, path: "/app/../../workspace/" }]))
      .toEqual([{ id: 1, type: "preview", port: 3000 }]);
    expect(decodeTabs([{ id: 1, type: "preview", port: 3000, path: "/.." }]))
      .toEqual([{ id: 1, type: "preview", port: 3000 }]);
    // `..` inside a segment is an ordinary route and survives.
    expect(decodeTabs([{ id: 1, type: "preview", port: 3000, path: "/a..b" }]))
      .toEqual([{ id: 1, type: "preview", port: 3000, path: "/a..b" }]);
    // Over-long paths are dropped on the way in too.
    expect(decodeTabs([
      { id: 1, type: "preview", port: 3000, path: `/${"a".repeat(MAX_PREVIEW_PATH_LENGTH)}` },
    ])).toEqual([{ id: 1, type: "preview", port: 3000 }]);
  });

  // The server bounds `tabs.tabs[].path` at 4096 and 400s the whole document
  // when it is longer, and one rejected write takes every tab's layout down
  // with it. Nothing upstream of the browser caps the path: it starts life as
  // `blitz preview open --path` inside the box. So the outgoing document drops
  // the route rather than losing persistence.
  it("drops an unusable deep-link from the outgoing document, keeping the rest", () => {
    const tabs = (entries: WorkspaceTab[]) => workspaceWebAppState(
      "box-1",
      "box-1",
      "claude",
      { version: 1, tabs: entries, activeId: 1, nextId: entries.length + 1 },
      defaultWorkspaceFiles(),
    ).tabs.tabs;

    const longest = `/${"a".repeat(MAX_PREVIEW_PATH_LENGTH - 1)}`;
    const tooLong = `/${"a".repeat(MAX_PREVIEW_PATH_LENGTH)}`;

    expect(tabs([{ id: 1, type: "preview", port: 3000, path: longest }]))
      .toEqual([{ id: 1, type: "preview", port: 3000, path: longest }]);

    // The over-long tab keeps its identity and its port; only the route goes,
    // and every other tab in the document is untouched.
    expect(tabs([
      { id: 1, type: "preview", port: 3000, path: tooLong },
      { id: 2, type: "preview", port: 5173, path: "/dashboard" },
      { id: 3, type: "claude" },
    ])).toEqual([
      { id: 1, type: "preview", port: 3000 },
      { id: 2, type: "preview", port: 5173, path: "/dashboard" },
      { id: 3, type: "claude" },
    ]);

    // Same treatment for a traversal path that reached the tab some other way.
    expect(tabs([{ id: 1, type: "preview", port: 3000, path: "/app/../../workspace/" }]))
      .toEqual([{ id: 1, type: "preview", port: 3000 }]);
  });

  // The in-box agent re-runs `blitz preview open` on every server start, so a
  // second "open /dashboard" almost always lands on a port that already has a
  // tab. Selecting that tab without applying the route ignored the request.
  it("re-points an existing preview tab at a new deep-link", () => {
    const tabs: WorkspaceTab[] = [
      { id: 1, type: "claude" },
      { id: 2, type: "preview", port: 3000 },
      { id: 3, type: "preview", port: 5173, path: "/docs" },
    ];

    // A first deep-link onto a bare port tab.
    expect(withPreviewTabPath(tabs, 2, "/dashboard")).toEqual([
      { id: 1, type: "claude" },
      { id: 2, type: "preview", port: 3000, path: "/dashboard" },
      { id: 3, type: "preview", port: 5173, path: "/docs" },
    ]);

    // A different route replaces the old one.
    expect(withPreviewTabPath(tabs, 3, "/docs/api")).toEqual([
      { id: 1, type: "claude" },
      { id: 2, type: "preview", port: 3000 },
      { id: 3, type: "preview", port: 5173, path: "/docs/api" },
    ]);

    // A plain re-open clears the route back to the server root, and the tab
    // keeps the bare shape rather than carrying `path: undefined`.
    const cleared = withPreviewTabPath(tabs, 3, undefined);
    expect(cleared).toEqual([
      { id: 1, type: "claude" },
      { id: 2, type: "preview", port: 3000 },
      { id: 3, type: "preview", port: 5173 },
    ]);
    expect(Object.keys(cleared[2] ?? {})).toEqual(["id", "type", "port"]);

    // No change, no churn: an unchanged route and a tab that is not a port
    // preview both leave every entry identical.
    expect(withPreviewTabPath(tabs, 3, "/docs")).toEqual(tabs);
    expect(withPreviewTabPath(tabs, 1, "/dashboard")).toEqual(tabs);
    expect(withPreviewTabPath(tabs, 99, "/dashboard")).toEqual(tabs);
  });
});

/** The persisted document is server-validated whole: an unknown shape drops
 * every tab a user has. These bind the pre-split shape to the split shape so
 * an old document upgrades instead of being rejected. */
describe("pre-split workspace document migration", () => {
  const decode = (doc: object) => decodeWorkspaceWebAppStateResponse(
    JSON.stringify({ doc, updatedAt: 1 }),
  ).doc;
  const legacy = (drawer: object, tabs: object[] = [{ id: 1, type: "claude" }]) => ({
    version: 1,
    agentDefault: "claude",
    tabs: {
      version: 1,
      tabs,
      activeId: 1,
      nextId: Math.max(...tabs.map((tab) => Number((tab as { id: number }).id))) + 1,
    },
    drawer,
  });

  it("folds an open drawer into a side-pane panel tab and keeps every session", () => {
    // 'integrations' is the pre-rename segment value: it must fold to the
    // 'connections' panel rather than invalidating the stored document.
    const restored = decode(legacy(
      { version: 1, open: true, width: 340, expanded: ["src"], segment: "integrations" },
      [{ id: 1, type: "claude" }, { id: 2, type: "terminal" }, { id: 3, type: "file", filePath: "a.txt" }],
    ));
    expect(restored?.tabs.tabs).toEqual([
      { id: 1, type: "claude" },
      { id: 2, type: "terminal" },
      { id: 3, type: "file", filePath: "a.txt" },
      { id: 4, type: "panel", panel: "connections", region: "side" },
    ]);
    expect(restored?.tabs.activeId).toBe(1);
    expect(restored?.tabs.sideActiveId).toBe(4);
    expect(restored?.tabs.nextId).toBe(5);
    expect(restored?.drawer).toEqual({ version: 1, width: 340, expanded: ["src"] });
  });

  it("leaves the split collapsed when the drawer was closed", () => {
    const restored = decode(legacy(
      { version: 1, open: false, width: 340, expanded: [], segment: "files" },
    ));
    expect(restored?.tabs.tabs).toEqual([{ id: 1, type: "claude" }]);
    expect(restored?.tabs.nextId).toBe(2);
    expect("sideActiveId" in (restored?.tabs ?? {})).toBe(false);
  });

  it("carries the legacy segment fold through into the panel tab", () => {
    const restored = decode(legacy(
      { version: 1, open: true, width: 340, expanded: [], segment: "leases" },
    ));
    expect(restored?.tabs.tabs.at(-1)).toEqual({
      id: 2,
      type: "panel",
      panel: "connections",
      region: "side",
    });
  });

  it("folds a stored 'integrations' panel tab to 'connections'", () => {
    const restored = decode({
      version: 1,
      agentDefault: "claude",
      tabs: {
        version: 1,
        tabs: [
          { id: 1, type: "claude" },
          { id: 2, type: "panel", panel: "integrations", region: "side" },
        ],
        activeId: 1,
        nextId: 3,
        sideActiveId: 2,
      },
      drawer: { version: 1, width: 340, expanded: [] },
    });
    expect(restored?.tabs.tabs.at(-1)).toEqual({
      id: 2,
      type: "panel",
      panel: "connections",
      region: "side",
    });
  });

  it("lets a split-aware tab list win over stale drawer fields beside it", () => {
    const restored = decode({
      version: 1,
      agentDefault: "claude",
      tabs: {
        version: 1,
        tabs: [
          { id: 1, type: "claude" },
          { id: 2, type: "panel", panel: "files", region: "side" },
        ],
        activeId: 1,
        nextId: 3,
        sideActiveId: 2,
      },
      drawer: { version: 1, open: true, width: 340, expanded: [], segment: "previews" },
    });
    expect(restored?.tabs.tabs).toHaveLength(2);
    expect(restored?.tabs.sideActiveId).toBe(2);
  });

  it("round-trips a split document without inventing a region for main tabs", () => {
    const doc = {
      version: 1,
      agentDefault: "claude" as const,
      tabs: {
        version: 1 as const,
        tabs: [
          { id: 1, type: "claude" as const },
          { id: 2, type: "terminal" as const, region: "side" as const },
        ],
        activeId: 1,
        nextId: 3,
        sideActiveId: 2,
      },
      drawer: { version: 1 as const, width: 340, expanded: [] },
    };
    expect(JSON.stringify(decode(doc))).toBe(JSON.stringify(doc));
  });

  it("collapses a document whose tabs all sit in the side pane", () => {
    const restored = decode({
      version: 1,
      agentDefault: "claude",
      tabs: {
        version: 1,
        tabs: [{ id: 1, type: "claude", region: "side" }],
        activeId: null,
        nextId: 2,
        sideActiveId: 1,
      },
      drawer: { version: 1, width: 340, expanded: [] },
    });
    expect(restored?.tabs.tabs).toEqual([{ id: 1, type: "claude" }]);
    expect(restored?.tabs.activeId).toBe(1);
    expect("sideActiveId" in (restored?.tabs ?? {})).toBe(false);
  });

  it("rejects a side active id that names no side tab", () => {
    expect(() => decode({
      version: 1,
      agentDefault: "claude",
      tabs: {
        version: 1,
        tabs: [{ id: 1, type: "claude" }],
        activeId: 1,
        nextId: 2,
        sideActiveId: 1,
      },
      drawer: { version: 1, width: 340, expanded: [] },
    })).toThrow("webApp state response has invalid doc");
  });
});
