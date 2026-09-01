/**
 * Workspace tabs, as tabs of Lody's session tab strip
 * (plans/LODY-TERMINAL-TABS.md §3.5).
 *
 * ONE STRIP, TWO HOSTS. `SessionDetail` draws the strip when a session is open;
 * `TerminalTabsStrip` draws the same vendored component on the chat landing,
 * where there is no session to root it in. Both read the SAME binding out of
 * the context below, so there is one tab array, one selection and one address —
 * which is what makes it one tab system rather than two.
 *
 * WHY THE TYPE IS RE-STATED HERE. Every `@lody/components/*` specifier is `any`
 * at our seam (`vendor-modules.d.ts`), so a host that wants the vendored
 * contract has to state it on our side. `SessionSurfaceTab` below is the exact
 * shape seam patch 5 declares in
 * `vendor/lody/packages/components/src/components/sessions/session-detail.tsx`;
 * `packages/webapp/test/lody-surface-tabs.test.tsx` pins the two together, so a
 * merge that moves the vendored declaration fails a test rather than silently
 * passing `any` through.
 */
import { createContext, createElement, useContext, type ReactNode } from "react";
import { SessionTypeIcon, type WebAppTabModel } from "../SessionTypeIcon.js";

/** One tab a HOST contributes to the session tab strip. Mirrors
 * `SessionSurfaceTab` in the vendored `session-detail.tsx` (seam patch 5). */
export interface SessionSurfaceTab {
  /** Unique across the strip. Namespaced by {@link surfaceTabId}. */
  id: string;
  label: string;
  icon?: ReactNode;
  /** Mounted always, hidden when another tab is active. */
  content: ReactNode;
}

/**
 * The id namespace, and the reason it exists.
 *
 * A strip id has to survive beside a session id, a `file:`/`diff:` viewer id
 * and a `draft-` id, and the numeric `WorkspaceTab.id` collides with none of
 * those only by luck. The prefix makes it structural, and it is what
 * `onSurfaceTabSelect` parses back into the id `webapp_state` and the tmux
 * session name (`<type>-<id>`) both key on.
 */
export const SURFACE_TAB_ID_PREFIX = "blitz-tab:";

/** `7` → `blitz-tab:7`. */
export function surfaceTabId(workspaceTabId: string | number): string {
  return `${SURFACE_TAB_ID_PREFIX}${String(workspaceTabId)}`;
}

/** `blitz-tab:7` → `7`, and `null` for anything that is not one of ours — a
 * session id, a viewer id, a draft id. */
export function workspaceTabIdFromSurfaceTabId(surfaceId: string): string | null {
  if (!surfaceId.startsWith(SURFACE_TAB_ID_PREFIX)) return null;
  const id = surfaceId.slice(SURFACE_TAB_ID_PREFIX.length);
  return id === "" ? null : id;
}

/** The strip's glyph for one workspace tab: the same `SessionTypeIcon` the
 * native strip and the rail draw, so a kind looks the same everywhere. */
export function surfaceTabIcon(tab: WebAppTabModel): ReactNode {
  const className = "h-3 w-3";
  // A file tab's glyph follows its extension and a panel tab's follows which
  // panel it is; every other kind reads its icon off `agent` alone.
  if (tab.filePath !== undefined) {
    return createElement(SessionTypeIcon, { type: tab.agent, className, filePath: tab.filePath });
  }
  if (tab.panel !== undefined) {
    return createElement(SessionTypeIcon, { type: tab.agent, className, panel: tab.panel });
  }
  return createElement(SessionTypeIcon, { type: tab.agent, className });
}

/**
 * `WebAppTabModel[]` → `SessionSurfaceTab[]`.
 *
 * The input is the tab model `CloudApp` already computes from `WorkspaceTab[]`
 * for the native strip and the rail. Re-deriving the labels from `WorkspaceTab`
 * here would be a second copy of rules that already have one home — the file
 * basename disambiguation, the preview-link label, the renamed-tab title — and
 * the whole point of this change is that the two strips draw ONE list.
 *
 * `content` is asked for per tab rather than passed in, so a tab that has never
 * been visited can answer `null` and stay unmounted (`CloudApp`'s
 * `renderedSessions` rule).
 */
export function toSessionSurfaceTabs(
  tabs: readonly WebAppTabModel[],
  content: (workspaceTabId: string) => ReactNode,
): SessionSurfaceTab[] {
  return tabs.map((tab) => ({
    id: surfaceTabId(tab.id),
    label: tab.label,
    icon: surfaceTabIcon(tab),
    content: content(tab.id),
  }));
}

/** What both hosts need: the list, the selection, and both verbs. */
export interface SurfaceTabsBinding {
  tabs: readonly SessionSurfaceTab[];
  /** The namespaced id of the selected host tab, or `null` when a session tab
   * (or the landing) owns the view. */
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /**
   * The strip moved to a tab that is NOT one of ours, so our selection is over.
   *
   * The two hosts are asymmetric and this is the whole of the asymmetry. On the
   * landing there is nothing else in the strip, so a host tab is deselected only
   * by selecting another one. Inside `SessionDetail` the strip also carries the
   * conversation tabs, and selecting one of those is state we cannot see: the
   * vendored page keeps it in `useState` and does not put it in the URL. Without
   * this callback `activeTabId` stays set, hunk 15 keeps our content mounted and
   * visible, and the conversation the member just clicked never appears.
   *
   * WHICH TRANSITIONS REACH IT. Seam patch 5's `onSessionTabSelect` fires from
   * `handleSessionTabSelect`, which is every SELECT the strip can make — a tab
   * click, the archived-tab restore, the Cmd+Alt+arrow cycle, a fork landing in
   * a tab, and an in-session navigation. The transitions that move the
   * conversation selection WITHOUT going through it are the strip's `+`
   * (`handleNewTab`), a tab close (`handleTabClose`, `closeDraftTab`) and a
   * draft's first send. Each is one more `onSessionTabSelect?.(id)` line in the
   * vendored page beside the `setActiveTabSessionId` it already calls; see
   * `vendor/lody/BLITZ-PATCHES.md` seam patch 5 hunk 17.
   */
  onDeselect: () => void;
  /**
   * The session the strip is drawn in does not exist (seam patch 5 hunk 20).
   *
   * `SessionDetail` renders its not-found card and returns ABOVE the strip, so
   * the whole tab list disappears — the terminal the member was looking at
   * included. Required like the other verbs, and raised by the session host
   * alone: the landing has no session to be missing, so it never calls it.
   */
  onSessionMissing: () => void;
}

/**
 * A CONTEXT, not a router option.
 *
 * The router is memoized on the workspace slug (`SessionSurface.tsx`), and the
 * tab list changes whenever a member opens, closes or renames a tab. Threading
 * the binding through `createLodySessionRouter` would rebuild the whole route
 * tree — and the page under the member's cursor — on every one of those.
 */
export const SurfaceTabsContext = createContext<SurfaceTabsBinding | null>(null);

/** `null` wherever the shell contributes no tabs: a headless mount, a router
 * unit test, and every surface mounted against another member's box (§5.1). */
export function useSurfaceTabs(): SurfaceTabsBinding | null {
  return useContext(SurfaceTabsContext);
}
