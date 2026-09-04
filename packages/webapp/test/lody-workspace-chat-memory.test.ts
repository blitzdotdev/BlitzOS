/**
 * COMING BACK TO A WORKSPACE LANDS WHERE THE MEMBER LEFT.
 *
 * A workspace switch goes through `navigateToWorkspacePage`, which pushes
 * `workspacePath(workspaceId)` — a path with no chat segment — and sets
 * `chat: null`. So returning to a workspace put the member on the chat landing
 * with nothing selected, however deep in a session they had been.
 *
 * A RELOAD was never the problem: the address lives in the URL, so
 * `parseAppRoute` restores it across a refresh unaided. The switch is the one
 * thing that loses it, because the switch is what rewrites the path — which is
 * why this memory is page-lifetime and deliberately not persisted.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetWorkspaceChatPath,
  recallWorkspaceChatPath,
  rememberWorkspaceChatPath,
  resetWorkspaceChatMemoryForTests,
} from "../src/workspace-chat-memory.js";
import { parseAppRoute, workspacePath } from "../src/sessions-page-state.js";

/** `AppRoute` is a union and only its `webApp` arm carries `chat`, so narrow
 * once here rather than casting at each assertion. */
function webAppRoute(pathname: string) {
  const route = parseAppRoute(pathname);
  if (route.page !== "webApp") {
    throw new Error(`expected a webApp route for ${pathname}, got ${route.page}`);
  }
  return route;
}

const WORKSPACE_A = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_B = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  resetWorkspaceChatMemoryForTests();
});

describe("remembering where each workspace was left", () => {
  it("answers null for a workspace never visited this page load", () => {
    expect(recallWorkspaceChatPath(WORKSPACE_A)).toBeNull();
  });

  it("hands back the exact path, so the shell's own parser does the restoring", () => {
    const sessionPath = `/workspaces/${WORKSPACE_A}/chat/session-9`;
    rememberWorkspaceChatPath(WORKSPACE_A, sessionPath);

    const remembered = recallWorkspaceChatPath(WORKSPACE_A);
    expect(remembered).toBe(sessionPath);
    // The whole reason a PATH is stored rather than a parsed `ChatAddress`:
    // restoring reuses `parseAppRoute` and cannot drift from it.
    const route = webAppRoute(remembered ?? "");
    expect(route.workspaceId).toBe(WORKSPACE_A);
    expect(route.chat).toEqual({ sessionId: "session-9" });
  });

  it("keeps one memory per workspace", () => {
    rememberWorkspaceChatPath(WORKSPACE_A, `/workspaces/${WORKSPACE_A}/chat/a-1`);
    rememberWorkspaceChatPath(WORKSPACE_B, `/workspaces/${WORKSPACE_B}/chat/b-1`);

    expect(recallWorkspaceChatPath(WORKSPACE_A)).toBe(`/workspaces/${WORKSPACE_A}/chat/a-1`);
    expect(recallWorkspaceChatPath(WORKSPACE_B)).toBe(`/workspaces/${WORKSPACE_B}/chat/b-1`);
  });

  it("moves with the member, so the LAST address wins", () => {
    rememberWorkspaceChatPath(WORKSPACE_A, `/workspaces/${WORKSPACE_A}/chat/first`);
    rememberWorkspaceChatPath(WORKSPACE_A, `/workspaces/${WORKSPACE_A}/chat/second`);
    expect(recallWorkspaceChatPath(WORKSPACE_A)).toBe(`/workspaces/${WORKSPACE_A}/chat/second`);
  });

  it("forgets a workspace whose sessions may no longer exist", () => {
    rememberWorkspaceChatPath(WORKSPACE_A, `/workspaces/${WORKSPACE_A}/chat/gone`);
    forgetWorkspaceChatPath(WORKSPACE_A);
    // A restore onto a session the box no longer has is worse than the landing
    // it replaced.
    expect(recallWorkspaceChatPath(WORKSPACE_A)).toBeNull();
  });

  it("falls back to the bare workspace path when nothing is remembered", () => {
    // What `navigateToWorkspacePage` does on a first visit — unchanged
    // behaviour, which is what keeps this additive.
    const fallback = recallWorkspaceChatPath(WORKSPACE_B) ?? workspacePath(WORKSPACE_B);
    expect(fallback).toBe(workspacePath(WORKSPACE_B));
    expect(webAppRoute(fallback).chat).toBeNull();
  });
});
