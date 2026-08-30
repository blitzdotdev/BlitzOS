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
 */
import { Suspense, lazy, useEffect, useState } from "react";
import type { BoxEndpoints } from "../resolver.js";
import { LODY_SESSIONS_ENABLED, lodySessionsRequested } from "./flag.js";
import type { LodySessionSurfaceApi } from "./SessionSurface.js";

const SessionSurface = lazy(async () => await import("./SessionSurface.js"));

export interface LodySessionsRegionProps {
  /** `null` until the box is running — the surface must not dial a box that
   * has no daemon yet, and every URL it needs comes from here. */
  endpoints: BoxEndpoints | null;
  viewerName: string;
  viewerAvatarUrl: string | null;
  workspaceTitle: string;
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange?: (sessionId: string | null) => void;
}

/** `true` while the surface should be on screen. Phase 4 replaces the hash with
 * a rail selection; see `flag.ts`. */
export function useLodySessionsRequested(): boolean {
  const [requested, setRequested] = useState(() =>
    lodySessionsRequested(globalThis.location?.hash ?? ""),
  );
  useEffect(() => {
    if (!LODY_SESSIONS_ENABLED) return undefined;
    const read = (): void => setRequested(lodySessionsRequested(window.location.hash));
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return requested;
}

export function LodySessionsRegion(props: LodySessionsRegionProps) {
  const requested = useLodySessionsRequested();
  // Mounted on the FIRST request and never unmounted afterwards: the runtime
  // owns a WebSocket, an IndexedDB repo and a WASM instance, so a hide has to
  // stay a hide. Not mounted before the first request either, so a member who
  // never opens sessions never fetches the chunk.
  const [everRequested, setEverRequested] = useState(false);
  useEffect(() => {
    if (requested) setEverRequested(true);
  }, [requested]);

  const { endpoints } = props;
  if (!LODY_SESSIONS_ENABLED || endpoints === null || !everRequested) return null;

  const surfaceProps = {
    endpoints: {
      syncUrl: endpoints.lodySyncUrl,
      rpcUrl: endpoints.lodyRpcUrl,
      controlUrl: endpoints.lodyControlUrl,
      projectUrl: endpoints.lodyProjectUrl,
      platformUrl: endpoints.lodyPlatformUrl,
    },
    viewer: { name: props.viewerName, avatarUrl: props.viewerAvatarUrl },
    workspaceTitle: props.workspaceTitle,
    hidden: !requested,
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
