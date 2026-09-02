/**
 * The one place `CloudApp` touches Lody (plans/LODY-RUNTIME-DESIGN.md §4.5).
 *
 * Everything about the port is behind a DYNAMIC import here, and that is the
 * whole point of this file existing rather than the import living in
 * `CloudApp.tsx`: one static import of `SessionSurface` would pull 3.5 MB of
 * vendored renderer into the entry graph for every member, flag or no flag.
 * `packages/webapp/test/lody-lazy-boundary.test.ts` asserts the entry never
 * names it.
 *
 * With the flag off this renders `null` and imports nothing at all.
 *
 * PHASE 4 CHANGED WHAT MAKES IT VISIBLE. Phase 3 read the `#lody` hash, because
 * the rail could not reach the surface yet. Now the ADDRESS does it
 * (`sessions-page-state.ts`, `ChatAddress`): the rail navigates, `CloudApp`
 * parses, and this component is told. The hash entry point survives only in
 * `main.tsx`, where there is no control plane and therefore no address to
 * parse.
 */
import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import type { SessionShareLevel } from "@blitzos/schema";
import type { BoxEndpoints } from "../resolver.js";
import type { DriveRailSession } from "../shell/rail-sessions.js";
import type { LodySessionsCapability } from "./box-capability.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";
import type { LodyRailBinding, LodySessionSurfaceApi } from "./SessionSurface.js";
import type { SharedSessionRow } from "./shared-sessions.js";
import { SurfaceLoadBoundary } from "./SurfaceLoadBoundary.js";
import type { SurfaceTabsBinding } from "./surface-tabs.js";

/**
 * A fresh `lazy()` per attempt, and that is what makes the retry a retry.
 *
 * React stores a rejected import's outcome on the `lazy` object and re-throws
 * it on every later render, so reusing one after a failure only reproduces the
 * failure. The browser may still have the failed module in its map, in which
 * case the second attempt fails too — and lands on the same notice, which is
 * the whole point: a failure here is a message, never a blank page.
 */
function loadSessionSurface() {
  return lazy(async () => await import("./SessionSurface.js"));
}

export interface LodySessionsRegionProps {
  /** `null` until the box is running — the surface must not dial a box that
   * has no daemon yet, and every URL it needs comes from here. */
  endpoints: BoxEndpoints | null;
  /**
   * Whether that box serves a session daemon at all (`box-capability.ts`).
   *
   * Required rather than defaulted, because it decides whether 3.5 MB is
   * fetched: a default would make forgetting it invisible, which is the exact
   * failure mode this file's whole existence is about.
   */
  sessions: LodySessionsCapability;
  viewerName: string;
  viewerAvatarUrl: string | null;
  workspaceTitle: string;
  /** `true` while the chat surface should cover the panes. */
  visible: boolean;
  /** The rail's list region, once the rail has drawn it. */
  railHost: HTMLElement | null;
  /** What the rail's Terminals section lists, and what a click on one does. */
  terminals: DriveRailSession[];
  activeTerminalId: string;
  onSelectTerminal: (tabId: string) => void;
  /** Close a terminal from its rail row. The native strip carried the only
   * close until it was deleted (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"), and
   * the rail is the one list every layout has. */
  onCloseTerminal?: (tabId: string) => void;
  /** What a session row and "+ New session" do: move the shell's ADDRESS, which
   * is the only thing that can take the view back from the panes. See
   * `LodyRailBinding` in `SessionSurface.tsx`. */
  onOpenSession?: (sessionId: string) => void;
  onOpenLanding?: () => void;
  /** The rail footer's Archive entry: the archived-session list, with its
   * restore and its permanent delete. */
  onOpenArchive?: () => void;
  /** The `+ New tab` control for the Terminals section header. */
  terminalsAction?: ReactNode;
  /** Right-click Share on a session row (plans/LODY-SHARING.md §8). */
  onShareSession?: (sessionId: string) => void;
  /** The rail's "Shared with you" rows, and what a click on one does. */
  sharedSessions?: SharedSessionRow[];
  onSelectSharedSession?: (row: SharedSessionRow) => void;
  /** The workspace's own tabs, as tabs of the session tab strip
   * (plans/LODY-TERMINAL-TABS.md §3.5). Never reaches a shared surface — see
   * where it is read below. */
  surfaceTabs?: SurfaceTabsBinding;
  /**
   * The shared session the address names, with the endpoints of the box that
   * runs it. `null` whenever the grantee is looking at their own box.
   */
  sharedOpen?: SharedSurfaceTarget | null;
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange?: (sessionId: string | null) => void;
  /**
   * The session the shell's address names on the member's OWN box, restored
   * across a workspace switch (`CloudApp.navigateToWorkspacePage` →
   * `recallWorkspaceChatPath`). Handed to the surface so its memory router OPENS
   * on that session instead of the landing: the own-box router otherwise starts
   * at `/chat` and its first resolved address — `null` — is mirrored back and
   * turned into `openLanding()`, erasing the restored selection. Reaches only
   * the owned surface; a shared surface's address is `sharedOpen.sessionId`.
   */
  initialSessionId?: string;
}

/** One open shared session: whose box, which session, at what level. */
export interface SharedSurfaceTarget {
  ownerMembershipId: string;
  sessionId: string;
  level: SessionShareLevel;
  /** `EndpointResolver.resolveShared(workspace, ownerMembershipId)`. */
  endpoints: BoxEndpoints;
}

/**
 * Will this region put a surface on screen at all?
 *
 * IT HAS TWO READERS AND THAT IS THE POINT. The region itself asks it below,
 * and `CloudApp` asks it before it hands the panes over: with the flag on and a
 * box that serves the surface, the native tab strips render nothing and every
 * tab body moves into the strip (plans/LODY-TERMINAL-TABS.md §4.6). Handing
 * both to a host that is not mounted leaves the workspace with no strip, no tab
 * body and no surface — a blank screen.
 *
 * `available` in `useLodyRail` is NOT this question. It is
 * `!lodySessionsUnavailable(capability)`, which is deliberately true throughout `probing` so
 * the rail does not flicker back to its legacy list for one round trip — and
 * `probing` is where a workspace with no running box stays for good
 * (`box-capability.ts`: the hook returns early on a null platform URL). The
 * rail can afford the optimism because an empty rail zone is a rail; the panes
 * cannot, because the optimism costs them their contents.
 */
export function lodySurfaceMounts(
  endpoints: BoxEndpoints | null,
  sessions: LodySessionsCapability,
): boolean {
  return LODY_SESSIONS_ENABLED && endpoints !== null && sessions === "present";
}

/** The box surfaces the Lody runtime dials, out of one endpoint set. */
function lodyEndpoints(endpoints: BoxEndpoints) {
  return {
    syncUrl: endpoints.lodySyncUrl,
    rpcUrl: endpoints.lodyRpcUrl,
    controlUrl: endpoints.lodyControlUrl,
    projectUrl: endpoints.lodyProjectUrl,
    platformUrl: endpoints.lodyPlatformUrl,
    filesBase: endpoints.filesBase,
  };
}

export function LodySessionsRegion(props: LodySessionsRegionProps) {
  const sharedOpen = props.sharedOpen ?? null;
  const rail: LodyRailBinding = {
    terminals: props.terminals,
    activeTerminalId: props.activeTerminalId,
    onSelectTerminal: props.onSelectTerminal,
    activeSharedSessionId: sharedOpen === null ? null : sharedOpen.sessionId,
  };
  if (props.onCloseTerminal !== undefined) rail.onCloseTerminal = props.onCloseTerminal;
  if (props.onOpenSession !== undefined) rail.onOpenSession = props.onOpenSession;
  if (props.onOpenLanding !== undefined) rail.onOpenLanding = props.onOpenLanding;
  if (props.onOpenArchive !== undefined) rail.onOpenArchive = props.onOpenArchive;
  if (props.terminalsAction !== undefined) rail.terminalsAction = props.terminalsAction;
  if (props.onShareSession !== undefined) rail.onShareSession = props.onShareSession;
  if (props.sharedSessions !== undefined) rail.sharedSessions = props.sharedSessions;
  if (props.onSelectSharedSession !== undefined) {
    rail.onSelectSharedSession = props.onSelectSharedSession;
  }

  // Mounted on the FIRST request, and never unmounted BY A HIDE afterwards: the
  // runtime owns a WebSocket, an IndexedDB repo and a WASM instance, so a hide
  // has to stay a hide. Not mounted before the first request either, so a member
  // who never opens sessions never fetches the chunk. The rail's vendored zone
  // is part of the surface, so the rail is what raises the first request in
  // practice — see `useLodyRail`.
  //
  // A CHANGE OF BOX IS NOT A HIDE YET. The key below carries the box, so
  // switching workspaces still unmounts and rebuilds. Per-surface IPC ownership
  // now makes coexistence possible, but the shared vendor referential caches
  // catalogued in plans/LODY-WORKSPACE-KEEPALIVE.md must be scoped first.
  const [everRequested, setEverRequested] = useState(false);
  const wanted = props.visible || props.railHost !== null;
  useEffect(() => {
    if (wanted) setEverRequested(true);
  }, [wanted]);
  const [SessionSurface, setSessionSurface] = useState(loadSessionSurface);
  const retrySurface = useCallback(() => {
    setSessionSurface(loadSessionSurface());
  }, []);

  const { endpoints } = props;
  // THE PROBE COMES BEFORE THE IMPORT (plans/LODY-RUNTIME-DESIGN.md §17). A box
  // on a pre-Lody image cannot use a byte of the chunk, and `probing` is one
  // round trip — far shorter than the fetch it gates — so nothing but `present`
  // may reach `lazy()`. That the gate is `=== "present"` and not `!== "absent"`
  // is why wave 4's fourth reading needed no change here.
  // The null check is repeated ahead of the predicate only to narrow the type
  // for the rest of this function; the predicate is still where the condition
  // is decided, and `CloudApp` asks the same one.
  if (endpoints === null || !lodySurfaceMounts(endpoints, props.sessions) || !everRequested) {
    return null;
  }

  const viewer = { name: props.viewerName, avatarUrl: props.viewerAvatarUrl };
  // EXACTLY ONE SURFACE IS STILL MOUNTED. Seam 18 binds its client and Phase B
  // has audited the non-effect shared state; Phase C is what will add the live
  // pool and Activity boundary. This branch still performs today's sequential
  // hand-off while carrying the active/identity plumbing that pool will use.
  //
  // So opening a shared session tears the runtime down and rebuilds it against
  // the owner's endpoints, which is §6.3's answer taken as written, with the
  // cost it names: the rail's vendored zone lists whichever box is mounted. The
  // native sections — "Shared with you" and Terminals — are props, so they
  // follow the mount and the member always has a way back.
  const surfaceProps =
    sharedOpen === null
      ? {
          // KEYED BY THE BOX, exactly as the shared branch below is.
          //
          // This was the constant `"own"` — one instance covering EVERY
          // workspace the member owns — and that is a stale-address bug, not a
          // style choice. `SessionSurface` builds its bridge once per instance
          // (`useLodySurfaceIpc`: `held.current ??= createLodyLocalBridge(...)`)
          // and that bridge CLOSES OVER the endpoints it was built with: sync,
          // rpc, control, project, platform, files. With one instance shared
          // across workspaces, a switch handed the surface new props and left
          // `window.ipc` pointing at the PREVIOUS box.
          //
          // What the member saw: the snapshot poller and the capability probe
          // both key on `platformUrl`, so they moved to box B and the runtime
          // rebuilt for workspace B — while its data plane still dialled box A,
          // which has no rooms for B. Not an error, just a surface that never
          // populated, until a full page reload rebuilt the ref.
          //
          // The ref-once is CORRECT; the key was wrong. One instance per box
          // makes "build the bridge once" mean what it says, so nothing in
          // `local-bridge.ts` has to become mutable to fix this.
          //
          // Still exactly one surface mounted at a time — a key change unmounts
          // the old one — until Phase C installs the keep-alive pool.
          // `lodySyncUrl` names the box and cannot drift from the thing that went
          // stale, because it IS the thing that went stale.
          surfaceKey: `own:${endpoints.lodySyncUrl}`,
          endpoints: lodyEndpoints(endpoints),
          shared: undefined,
          readOnly: false,
        }
      : {
          // Keyed by the OWNER's membership: switching between two members'
          // shared sessions rebuilds the runtime, and switching between two
          // sessions on the same member's box does not.
          surfaceKey: `shared:${sharedOpen.ownerMembershipId}`,
          endpoints: lodyEndpoints(sharedOpen.endpoints),
          shared: { sessionId: sharedOpen.sessionId },
          readOnly: sharedOpen.level === "ro",
        };
  // NO HOST TABS ON A SHARED SURFACE (plans/LODY-TERMINAL-TABS.md §5.1). A
  // terminal is an arbitrary shell on the OWNER's box, and no share level in
  // §0.1 grants that — the same reason the bridge refuses `/control` outright
  // and narrows `/platform` to three fields. There is no gateway path, no
  // bridge door and no ACL to write, because there is nothing to permit.
  const hostTabs = sharedOpen !== null || props.surfaceTabs === undefined
    ? {}
    : { surfaceTabs: props.surfaceTabs };
  // The restored own-box selection rides ONLY the owned surface. A shared
  // surface opens on `sharedOpen.sessionId` through the branch above, so passing
  // it here too would fight that.
  const ownInitial =
    sharedOpen === null && props.initialSessionId !== undefined
      ? { initialSessionId: props.initialSessionId }
      : {};
  // THE BOUNDARY IS OUTSIDE THE SUSPENSE, so it catches the import's rejection
  // as well as anything the surface throws once it has mounted. Without it a
  // rejected chunk propagates past the whole tree and React unmounts the
  // document (BUG-CV-01).
  return (
    <SurfaceLoadBoundary onRetry={retrySurface}>
      <Suspense fallback={null}>
        <SessionSurface
          surfaceKey={surfaceProps.surfaceKey}
          endpoints={surfaceProps.endpoints}
          viewer={viewer}
          workspaceTitle={props.workspaceTitle}
          hidden={!props.visible}
          active={props.visible}
          railHost={props.railHost}
          rail={rail}
          readOnly={surfaceProps.readOnly}
          {...hostTabs}
          {...ownInitial}
          {...(surfaceProps.shared === undefined ? {} : { shared: surfaceProps.shared })}
          {...(props.onApiReady === undefined ? {} : { onApiReady: props.onApiReady })}
          {...(props.onActiveSessionChange === undefined
            ? {}
            : { onActiveSessionChange: props.onActiveSessionChange })}
        />
      </Suspense>
    </SurfaceLoadBoundary>
  );
}
