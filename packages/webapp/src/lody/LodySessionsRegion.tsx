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
import type { BoxEndpoints } from "../resolver.js";
import type { DriveRailSession } from "../shell/rail-sessions.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";
import type { LodyRailBinding, LodySessionSurfaceApi } from "./SessionSurface.js";

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
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange?: (sessionId: string | null) => void;
}

export function LodySessionsRegion(props: LodySessionsRegionProps) {
  const rail: LodyRailBinding = {
    terminals: props.terminals,
    activeTerminalId: props.activeTerminalId,
    onSelectTerminal: props.onSelectTerminal,
  };
  if (props.terminalsAction !== undefined) rail.terminalsAction = props.terminalsAction;
  if (props.onShareSession !== undefined) rail.onShareSession = props.onShareSession;

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

  const surfaceProps = {
    endpoints: {
      syncUrl: endpoints.lodySyncUrl,
      rpcUrl: endpoints.lodyRpcUrl,
      controlUrl: endpoints.lodyControlUrl,
      projectUrl: endpoints.lodyProjectUrl,
      platformUrl: endpoints.lodyPlatformUrl,
      filesBase: endpoints.filesBase,
    },
    viewer: { name: props.viewerName, avatarUrl: props.viewerAvatarUrl },
    workspaceTitle: props.workspaceTitle,
    hidden: !props.visible,
    railHost: props.railHost,
    rail,
  };
  return (
    <Suspense fallback={null}>
      <SessionSurface
        {...surfaceProps}
        {...(props.onApiReady === undefined ? {} : { onApiReady: props.onApiReady })}
        {...(props.onActiveSessionChange === undefined
          ? {}
          : { onActiveSessionChange: props.onActiveSessionChange })}
      />
    </Suspense>
  );
}
