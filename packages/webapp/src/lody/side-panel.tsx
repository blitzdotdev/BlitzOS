/**
 * The right icon strip as a quick-action bar for Lody's side panel
 * (seam patch 19 in `vendor/lody/BLITZ-PATCHES.md`).
 *
 * ONE PANEL, TWO DRIVERS. Lody's `SessionDetail` owns its side panel — Files,
 * All Changes, Browser, Side Chat, and the viewers a click opens — and draws its
 * own tab bar for it. BlitzOS adds two fixed panels of its own, Browser and
 * Connections, and a strip
 * of icons at the right edge of the shell that opens any of the five without
 * the member hunting for the `+` menu. The strip lives in the entry chunk and
 * the panel lives in the lazy Lody chunk, so what crosses is this binding: the
 * host tabs going in, one request at a time going in, and the panel's state
 * coming back out so the strip can draw a pressed icon.
 *
 * WHY THE TYPES ARE RE-STATED HERE. Every `@lody/components/*` specifier is
 * `any` at our seam (`vendor-modules.d.ts`), so the shapes seam patch 19
 * declares in `session-detail.tsx` are stated again on our side, the same way
 * `surface-tabs.ts` re-states seam patch 5's.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { FileDiff, Files, MessageSquare, MonitorPlay, Plug } from "lucide-react";

/** Mirrors `SessionHostSidePanelTab` (seam patch 19). The `host:` prefix is
 * what keeps a host id out of Lody's persisted side-panel state. */
export interface SessionHostSidePanelTab {
  id: `host:${string}`;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
}

/** Mirrors `SessionSidePanelRequest` (seam patch 19). `seq` is what makes a
 * repeat of the same request a new one. */
export interface SessionSidePanelRequest {
  tabId: string;
  action: "open" | "close";
  seq: number;
}

/** Mirrors `SessionSidePanelHostState` (seam patch 19). */
export interface SessionSidePanelHostState {
  open: boolean;
  activeTabId: string | null;
  openedTabIds: readonly string[];
  availableOptions: readonly { id: string; disabled: boolean }[];
}

/** Our two host tabs' ids. */
export const CONNECTIONS_SIDE_PANEL_ID = "host:connections" as const;
export const BROWSER_SIDE_PANEL_ID = "host:browser" as const;

/** The five things the strip can ask the side panel for, in strip order. Three
 * are Lody's own fixed-panel ids (`side-session` is the Side Chat launcher,
 * which creates a session rather than opening a tab); Browser and Connections
 * are ours. Lody's own Browser tab is not offered: its public engine is
 * Electron-only, and `browser/BrowserPanel.tsx` is what opens a port, a file
 * or an app here. */
export type SidePanelQuickAction =
  | "side-session"
  | "files"
  | "changes"
  | typeof BROWSER_SIDE_PANEL_ID
  | typeof CONNECTIONS_SIDE_PANEL_ID;

export const SIDE_PANEL_QUICK_ACTIONS: readonly SidePanelQuickAction[] = [
  "side-session",
  "files",
  "changes",
  BROWSER_SIDE_PANEL_ID,
  CONNECTIONS_SIDE_PANEL_ID,
];

/** The label Lody draws for each panel, so the strip's tooltip and the side
 * panel's tab read the same. */
export const SIDE_PANEL_QUICK_ACTION_LABELS = {
  "side-session": "Side Chat",
  files: "Files",
  changes: "All Changes",
  [BROWSER_SIDE_PANEL_ID]: "Browser",
  [CONNECTIONS_SIDE_PANEL_ID]: "Connections",
} as const satisfies Record<SidePanelQuickAction, string>;

/**
 * ONE GLYPH PER PANEL, DRAWN IN TWO PLACES. These are the lucide icons Lody's
 * `SidePanelTabIcon` draws for the same kinds (`session-side-panel-tab-bar.tsx`),
 * so the strip icon a member presses is the icon on the tab that opens. The
 * Connections glyph is ours, and reaches Lody's tab bar through the host tab's
 * `icon` (seam patch 19), so it too is the same on both sides.
 */
export function sidePanelQuickActionIcon(
  action: SidePanelQuickAction,
  className: string,
): ReactNode {
  switch (action) {
    case "side-session":
      return <MessageSquare className={className} aria-hidden="true" />;
    case "files":
      return <Files className={className} aria-hidden="true" />;
    case "changes":
      return <FileDiff className={className} aria-hidden="true" />;
    case BROWSER_SIDE_PANEL_ID:
      return <MonitorPlay className={className} aria-hidden="true" />;
    case CONNECTIONS_SIDE_PANEL_ID:
      return <Plug className={className} aria-hidden="true" />;
  }
}

/** What the shell hands the surface, and what comes back. */
export interface SidePanelBinding {
  hostTabs: readonly SessionHostSidePanelTab[];
  /** The latest request, or `null` before the first. The surface acts on a
   * change of `seq`, never on the object's identity. */
  request: SessionSidePanelRequest | null;
  /** The panel's state after every change, and `null` when no session detail
   * is on screen — the landing, a missing session, the surface unmounting. */
  onStateChange: (state: SessionSidePanelHostState | null) => void;
}

/** A CONTEXT, for the reason `SurfaceTabsContext` is one: the router is
 * memoized on the workspace, and the binding changes on every click. */
export const SidePanelContext = createContext<SidePanelBinding | null>(null);

/** `null` wherever the shell drives no side panel: a headless mount, a router
 * unit test, and a surface mounted against another member's box. */
export function useSidePanel(): SidePanelBinding | null {
  return useContext(SidePanelContext);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Field-wise equality of two reports, so the shell can tell a change of the
 * panel from a report of the panel it already holds. */
export function sidePanelStatesEqual(
  a: SessionSidePanelHostState | null,
  b: SessionSidePanelHostState | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.open === b.open &&
    a.activeTabId === b.activeTabId &&
    sameIds(a.openedTabIds, b.openedTabIds) &&
    a.availableOptions.length === b.availableOptions.length &&
    a.availableOptions.every(
      (option, index) =>
        option.id === b.availableOptions[index]?.id &&
        option.disabled === b.availableOptions[index]?.disabled,
    )
  );
}

/**
 * The shell's copy of the panel's state, and the `onStateChange` to hand the
 * surface for it.
 *
 * WHY EQUAL REPORTS MUST NOT RE-RENDER. The surface reports whenever any INPUT
 * of the panel changes, and the host tabs are one of those inputs: a new
 * `hostTabs` array recomputes the panel's options and reports the panel again,
 * with every field equal to the last report. Held naively, that report is a
 * new object in state, the shell re-renders, its binding is a new object, the
 * surface re-renders under it — and whether that ever ends depends on every
 * input of `hostTabs` being referentially stable across a render. One that is
 * not (a handler declared in the render body, a `filter` result) makes the
 * page loop until React throws "Maximum update depth exceeded" (#185). So a
 * report equal to what the shell holds is dropped HERE, and the loop cannot
 * start whatever the tabs are built from.
 */
export function useSidePanelHostState(): [
  SessionSidePanelHostState | null,
  (state: SessionSidePanelHostState | null) => void,
] {
  const [state, setState] = useState<SessionSidePanelHostState | null>(null);
  const onStateChange = useCallback((next: SessionSidePanelHostState | null) => {
    setState((previous) => (sidePanelStatesEqual(previous, next) ? previous : next));
  }, []);
  return [state, onStateChange];
}
