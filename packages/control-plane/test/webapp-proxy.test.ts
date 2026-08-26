import { describe, expect, it } from "vitest";
import { rewriteWebDavDestination } from "../core/webapp-proxy.js";

const REQUEST_URL = new URL(
  "https://cp.example/workspaces/ws-1/webapp/7445/workspace/.note.tmp",
);

describe("WebDAV Destination proxying", () => {
  it("removes the public proxy prefix before forwarding a workspace move", () => {
    const headers = new Headers({
      Destination: "https://cp.example/workspaces/ws-1/webapp/7445/workspace/a%20note.md",
    });

    rewriteWebDavDestination(headers, REQUEST_URL, "ws-1", 7445);

    expect(headers.get("destination")).toBe("/workspace/a%20note.md");
  });

  it("leaves requests without a Destination header unchanged", () => {
    const headers = new Headers({ Accept: "text/plain" });

    rewriteWebDavDestination(headers, REQUEST_URL, "ws-1", 7445);

    expect(Object.fromEntries(headers)).toEqual({ accept: "text/plain" });
  });

  it.each([
    "https://other.example/workspaces/ws-1/webapp/7445/workspace/note.md",
    "https://cp.example/workspaces/ws-2/webapp/7445/workspace/note.md",
    "https://cp.example/workspaces/ws-1/webapp/7445/terminal/ws",
    "https://cp.example/workspaces/ws-1/webapp/7445/workspace/note.md?copy=1",
  ])("rejects a Destination outside the current file surface: %s", (destination) => {
    const headers = new Headers({ Destination: destination });

    expect(() => rewriteWebDavDestination(headers, REQUEST_URL, "ws-1", 7445))
      .toThrowError("WebDAV Destination must stay on this workspace surface");
  });

  it("rejects a relative Destination", () => {
    const headers = new Headers({ Destination: "/workspace/note.md" });

    expect(() => rewriteWebDavDestination(headers, REQUEST_URL, "ws-1", 7445))
      .toThrowError("WebDAV Destination must be an absolute URL");
  });
});
