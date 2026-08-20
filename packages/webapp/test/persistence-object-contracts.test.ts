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
        drawer: { version: 1, open: true, width: 264, expanded: [], segment: "previews" },
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
        drawer: { version: 1, open: true, width: 264, expanded: [], segment: "previews" },
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
  });
});
