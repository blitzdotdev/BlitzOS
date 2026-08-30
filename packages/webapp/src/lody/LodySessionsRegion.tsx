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
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import type { SessionShareLevel } from "@blitzos/schema";
import type { BoxEndpoints } from "../resolver.js";
import type { DriveRailSession } from "../shell/rail-sessions.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";
import type { LodyRailBinding, LodySessionSurfaceApi } from "./SessionSurface.js";
import type { SharedSessionRow } from "./shared-sessions.js";

const SessionSurface = lazy(async () => await import("./SessionSurface.js"));

export interface LodySessionsRegionProps {
  /** `null` until the box is running — the surface must not dial a box that
   * has no daemon yet, and every URL it needs comes from here. */
  endpoints: BoxEndpoints | null;
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
  /** The `+ New tab` control for the Terminals section header. */
  terminalsAction?: ReactNode;
  /** Right-click Share on a session row (plans/LODY-SHARING.md §8). */
  onShareSession?: (sessionId: string) => void;
  /** The rail's "Shared with you" rows, and what a click on one does. */
  sharedSessions?: SharedSessionRow[];
  onSelectSharedSession?: (row: SharedSessionRow) => void;
  /**
   * The shared session the address names, with the endpoints of the box that
   * runs it. `null` whenever the grantee is looking at their own box.
   */
  sharedOpen?: SharedSurfaceTarget | null;
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange?: (sessionId: string | null) => void;
  /** Opens the workspace connections panel with `provider` selected. The
   * signed-out banner offers it when an agent turn returns `acp_auth_required`,
   * because the box's agent credential is minted from a workspace connection
   * and that panel is the only place to supply one. */
  onOpenConnections?: (provider: string) => void;
}

/** One open shared session: whose box, which session, at what level. */
export interface SharedSurfaceTarget {
  ownerMembershipId: string;
  sessionId: string;
  level: SessionShareLevel;
  /** `EndpointResolver.resolveShared(workspace, ownerMembershipId)`. */
  endpoints: BoxEndpoints;
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
  if (props.terminalsAction !== undefined) rail.terminalsAction = props.terminalsAction;
  if (props.onShareSession !== undefined) rail.onShareSession = props.onShareSession;
  if (props.sharedSessions !== undefined) rail.sharedSessions = props.sharedSessions;
  if (props.onSelectSharedSession !== undefined) {
    rail.onSelectSharedSession = props.onSelectSharedSession;
  }

  // Mounted on the FIRST request and never unmounted afterwards: the runtime
  // owns a WebSocket, an IndexedDB repo and a WASM instance, so a hide has to
  // stay a hide. Not mounted before the first request either, so a member who
  // never opens sessions never fetches the chunk. The rail's vendored zone is
  // part of the surface, so the rail is what raises the first request in
  // practice — see `useLodyRail`.
  const [everRequested, setEverRequested] = useState(false);
  const wanted = props.visible || props.railHost !== null;
  useEffect(() => {
    if (wanted) setEverRequested(true);
  }, [wanted]);

  const { endpoints } = props;
  if (!LODY_SESSIONS_ENABLED || endpoints === null || !everRequested) return null;

  const viewer = { name: props.viewerName, avatarUrl: props.viewerAvatarUrl };
  // EXACTLY ONE SURFACE IS MOUNTED, and this is the constraint that decides it:
  // the vendored renderer's local plane is a SINGLETON on `window.ipc`
  // (plans/LODY-SHARING.md §6.1). `sendIpc` re-reads that global on every call,
  // so a second mounted surface does not get a second bridge — it takes the
  // first one's. Measured, not reasoned about: with both mounted, the OWNER's
  // own `session/dispatch-turn` came back `share_forbidden`, because it had been
  // routed to the grantee's box.
  //
  // So opening a shared session tears the runtime down and rebuilds it against
  // the owner's endpoints, which is §6.3's answer taken as written, with the
  // cost it names: the rail's vendored zone lists whichever box is mounted. The
  // native sections — "Shared with you" and Terminals — are props, so they
  // follow the mount and the member always has a way back.
  const surfaceProps =
    sharedOpen === null
      ? {
          key: "own",
          endpoints: lodyEndpoints(endpoints),
          shared: undefined,
          readOnly: false,
        }
      : {
          // Keyed by the OWNER's membership: switching between two members'
          // shared sessions rebuilds the runtime, and switching between two
          // sessions on the same member's box does not.
          key: `shared:${sharedOpen.ownerMembershipId}`,
          endpoints: lodyEndpoints(sharedOpen.endpoints),
          shared: { sessionId: sharedOpen.sessionId },
          readOnly: sharedOpen.level === "ro",
        };
  return (
    <Suspense fallback={null}>
      <SessionSurface
        key={surfaceProps.key}
        endpoints={surfaceProps.endpoints}
        viewer={viewer}
        workspaceTitle={props.workspaceTitle}
        hidden={!props.visible}
        railHost={props.railHost}
        rail={rail}
        readOnly={surfaceProps.readOnly}
        {...(surfaceProps.shared === undefined ? {} : { shared: surfaceProps.shared })}
        {...(props.onOpenConnections === undefined
          ? {}
          : { onOpenConnections: props.onOpenConnections })}
        {...(props.onApiReady === undefined ? {} : { onApiReady: props.onApiReady })}
        {...(props.onActiveSessionChange === undefined
          ? {}
          : { onActiveSessionChange: props.onActiveSessionChange })}
      />
    </Suspense>
  );
}
