import { describe, expect, it } from "vitest";
import {
  decodeWorkspaceWebAppStateResponse,
  storedWorkspacePreference,
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
    const restored = decode(legacy(
      { version: 1, open: true, width: 340, expanded: ["src"], segment: "integrations" },
      [{ id: 1, type: "claude" }, { id: 2, type: "terminal" }, { id: 3, type: "file", filePath: "a.txt" }],
    ));
    expect(restored?.tabs.tabs).toEqual([
      { id: 1, type: "claude" },
      { id: 2, type: "terminal" },
      { id: 3, type: "file", filePath: "a.txt" },
      { id: 4, type: "panel", panel: "integrations", region: "side" },
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
      panel: "integrations",
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
