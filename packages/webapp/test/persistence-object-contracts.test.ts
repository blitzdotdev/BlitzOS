import { describe, expect, it } from "vitest";
import {
  createStorageNamespace,
  loadWorkspaceTabs,
  storedWorkspacePreference,
} from "../src/storage.js";
import { ttydHandshake } from "../src/TtydTerminal.js";

function storageWithTabs(value: string) {
  return {
    getItem: () => value,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

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
    const namespace = createStorageNamespace("org", "member");
    const absent = loadWorkspaceTabs(
      namespace,
      "workspace",
      storageWithTabs('{"version":1,"tabs":[{"id":1,"type":"chat"}],"activeId":1,"nextId":2}'),
    ).tabs[0];
    expect(Object.keys(absent ?? {})).toEqual(["id", "type"]);
    expect(absent && "chatSessionId" in absent).toBe(false);
    expect(absent && "chatProvider" in absent).toBe(false);
    expect(JSON.stringify(absent)).toBe('{"id":1,"type":"chat"}');

    const present = loadWorkspaceTabs(
      namespace,
      "workspace",
      storageWithTabs('{"version":1,"tabs":[{"id":1,"type":"chat","chatSessionId":"session-1","chatProvider":"codex"}],"activeId":1,"nextId":2}'),
    ).tabs[0];
    expect(Object.keys(present ?? {})).toEqual(["id", "type", "chatSessionId", "chatProvider"]);
    expect(present && "chatSessionId" in present).toBe(true);
    expect(present && "chatProvider" in present).toBe(true);
    expect(JSON.stringify(present)).toBe(
      '{"id":1,"type":"chat","chatSessionId":"session-1","chatProvider":"codex"}',
    );
  });
});
