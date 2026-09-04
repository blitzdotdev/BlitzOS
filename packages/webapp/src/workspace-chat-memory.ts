/**
 * Which chat address each workspace was last left on.
 *
 * THE GAP THIS FILLS. A workspace switch goes through
 * `navigateToWorkspacePage`, which pushes `workspacePath(workspaceId)` — a path
 * with no chat segment — and sets `chat: null`. Coming back therefore lands on
 * the chat landing with nothing selected, however deep in a session the member
 * was when they left.
 *
 * A RELOAD IS ALREADY FINE, and that is what decides the shape of this. The
 * address lives in the URL (`/workspaces/:id/chat/:sessionId`), so `parseAppRoute`
 * restores it across a refresh without help. The one thing that loses it is the
 * switch, because the switch is what rewrites the path. So this is a
 * page-lifetime memory and deliberately not persisted: adding localStorage would
 * duplicate what the URL already does, and give two sources for one fact.
 *
 * IT REMEMBERS THE PATHNAME, NOT THE PARSED ADDRESS. `ChatAddress` has six
 * shapes and each has its own builder (`workspaceChatPath`,
 * `workspaceChatTerminalPath`, `workspaceSharedChatPath`, …); reconstructing a
 * URL from one would mean a second switch over that union, which is exactly the
 * kind of thing that drifts from `parseAppRoute` the next time a shape is added.
 * Storing the path the shell already built means restoring is the parser it
 * already has.
 */

/** Page-lifetime only. Keyed by workspace id, holding the last path that
 * carried a chat address. */
const lastChatPathByWorkspace = new Map<string, string>();

/**
 * Record where a workspace is being left.
 *
 * Called for a path that carries a real chat address and for nothing else — the
 * bare `/workspaces/:id` is what a restore is trying to improve on, so writing
 * it would erase the memory on the way out.
 */
export function rememberWorkspaceChatPath(
  workspaceId: string,
  pathname: string,
): void {
  lastChatPathByWorkspace.set(workspaceId, pathname);
}

/** The path this workspace was last left on, or `null` if it has not been
 * visited in this page's lifetime. */
export function recallWorkspaceChatPath(workspaceId: string): string | null {
  return lastChatPathByWorkspace.get(workspaceId) ?? null;
}

/**
 * Forget a workspace.
 *
 * A workspace whose machine was replaced, or which the member left, must not
 * hand a stale session id to the next visit — a restore that lands on a session
 * the box no longer has is worse than the landing it replaced.
 */
export function forgetWorkspaceChatPath(workspaceId: string): void {
  lastChatPathByWorkspace.delete(workspaceId);
}

/** Test-only: drop every remembered path, so a case starts clean. */
export function resetWorkspaceChatMemoryForTests(): void {
  lastChatPathByWorkspace.clear();
}
