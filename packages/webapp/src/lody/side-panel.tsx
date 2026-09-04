/**
 * The right icon strip as a quick-action bar for Lody's side panel
 * (seam patches 19 and 20 in `vendor/lody/BLITZ-PATCHES.md`).
 *
 * ONE PANEL, TWO DRIVERS. Lody's `SessionDetail` owns its side panel — Files,
 * All Changes, Browser, Side Chat, and the viewers a click opens — and draws its
 * own tab bar for it. BlitzOS adds a fifth fixed panel, Connections, and a strip
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
import { createContext, useContext, type ReactNode } from "react";
import { isPreviewPath, isPreviewPort } from "@blitzos/schema";
import { FileDiff, Files, MessageSquare, MonitorPlay, Plug } from "lucide-react";
import { previewUrl } from "../preview.js";

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

/** Mirrors Lody's `PreviewTarget` (`vendor/lody/packages/shared/src/preview.ts`). */
export interface ManagedPreviewTarget {
  protocol: "http" | "https";
  host: string;
  port: number;
  path?: string;
}

/** Our one host tab's id. */
export const CONNECTIONS_SIDE_PANEL_ID = "host:connections" as const;

/** The five things the strip can ask the side panel for, in strip order. Four
 * are Lody's own fixed-panel ids (`side-session` is the Side Chat launcher,
 * which creates a session rather than opening a tab); the fifth is ours. */
export type SidePanelQuickAction =
  | "side-session"
  | "files"
  | "changes"
  | "browser"
  | typeof CONNECTIONS_SIDE_PANEL_ID;

export const SIDE_PANEL_QUICK_ACTIONS: readonly SidePanelQuickAction[] = [
  "side-session",
  "files",
  "changes",
  "browser",
  CONNECTIONS_SIDE_PANEL_ID,
];

/** The label Lody draws for each panel, so the strip's tooltip and the side
 * panel's tab read the same. */
export const SIDE_PANEL_QUICK_ACTION_LABELS = {
  "side-session": "Side Chat",
  files: "Files",
  changes: "All Changes",
  browser: "Browser",
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
    case "browser":
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
  /** Seam patch 20: the iframe URL for a loopback target, through the box
   * gateway's preview proxy. `null` hands the address back to upstream. */
  resolveManagedPreviewViewerUrl: (target: ManagedPreviewTarget) => string | null;
}

/** A CONTEXT, for the reason `SurfaceTabsContext` is one: the router is
 * memoized on the workspace, and the binding changes on every click. */
export const SidePanelContext = createContext<SidePanelBinding | null>(null);

/** `null` wherever the shell drives no side panel: a headless mount, a router
 * unit test, and a surface mounted against another member's box. */
export function useSidePanel(): SidePanelBinding | null {
  return useContext(SidePanelContext);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The gateway URL that shows a loopback target, or `null` when the target is
 * not one the gateway proxies: a non-loopback host, a reserved port, a path
 * the gateway refuses. `null` is upstream's turn, whose answer in a browser is
 * an honest error rather than a page.
 *
 * The target's `path` carries the query and the fragment too
 * (`parseBrowserAddress` in `vendor/lody/packages/shared/src/browser-url.ts`);
 * the fragment stays in the browser and never reaches the gateway.
 */
export function managedPreviewViewerUrl(
  filesBase: string | null,
  target: ManagedPreviewTarget,
): string | null {
  if (filesBase === null) return null;
  if (!LOOPBACK_HOSTS.has(target.host.trim().toLowerCase())) return null;
  if (!isPreviewPort(target.port)) return null;
  const raw = target.path ?? "/";
  const hashAt = raw.indexOf("#");
  const withoutHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  const pathname = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutHash.slice(queryAt);
  const normalized = pathname === "" ? "/" : pathname;
  if (!isPreviewPath(normalized)) return null;
  return previewUrl(filesBase, target.port, normalized, query);
}
