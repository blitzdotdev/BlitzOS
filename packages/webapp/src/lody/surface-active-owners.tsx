/** Tiny active-state subscribers around the retained surface body. */
import { useEffect, useRef, type ReactNode } from "react";
import {
  activeSessionIdFromPathname,
  isArchivePathname,
  type LodyRouter,
} from "./router.js";
import type { LodySessionSurfaceApi } from "./SessionSurface.js";
import { LodyAgentAuthNotice } from "./agent-auth-notice.js";
import { LODY_SURFACE_CLASS } from "./surface-class.js";
import { LodyRouteActivity, LodySurfaceVisibilityRoot } from "./surface-activity.js";
import { useLodySurfaceActiveState } from "./surface-active-context.js";
import { LodySurfaceToaster } from "./surface-providers.js";
import { SurfaceTabsContext } from "./surface-tabs.js";
import { SidePanelContext } from "./side-panel.js";
import type { LodyAtomStore } from "./runtime.js";

export function LodySurfaceShellOwnership(props: {
  router: LodyRouter;
  openSession: (sessionId: string) => void;
  openLanding: (options?: { resetDraft?: boolean }) => void;
  openArchive: () => void;
  unsupportedIpcChannels: () => readonly string[];
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange?: (sessionId: string | null) => void;
}) {
  const { active } = useLodySurfaceActiveState();
  const onApiReadyRef = useRef(props.onApiReady);
  onApiReadyRef.current = props.onApiReady;
  const onActiveSessionChangeRef = useRef(props.onActiveSessionChange);
  onActiveSessionChangeRef.current = props.onActiveSessionChange;
  useEffect(() => {
    if (!active) return undefined;
    return props.router.subscribe("onResolved", () => {
      onActiveSessionChangeRef.current?.(
        activeSessionIdFromPathname(props.router.state.location.pathname),
      );
    });
  }, [active, props.router]);
  useEffect(() => {
    if (!active) return undefined;
    const api: LodySessionSurfaceApi = {
      openSession: props.openSession,
      openLanding: props.openLanding,
      openArchive: props.openArchive,
      activeSessionId: () =>
        activeSessionIdFromPathname(props.router.state.location.pathname),
      isArchiveOpen: () => isArchivePathname(props.router.state.location.pathname),
      unsupportedIpcChannels: props.unsupportedIpcChannels,
    };
    onApiReadyRef.current?.(api);
    return () => onApiReadyRef.current?.(null);
  }, [
    active,
    props.openArchive,
    props.openLanding,
    props.openSession,
    props.router,
    props.unsupportedIpcChannels,
  ]);
  return null;
}

export function LodySurfaceRouteActivity(props: { children: ReactNode }) {
  const { active, hidden, sidePanel, surfaceTabs } = useLodySurfaceActiveState();
  return (
    <LodyRouteActivity active={active && !hidden}>
      <SurfaceTabsContext.Provider value={surfaceTabs ?? null}>
        <SidePanelContext.Provider value={sidePanel ?? null}>
          {props.children}
        </SidePanelContext.Provider>
      </SurfaceTabsContext.Provider>
    </LodyRouteActivity>
  );
}

export function LodySurfaceRailActivity(props: { children: ReactNode }) {
  const { active } = useLodySurfaceActiveState();
  return (
    <LodyRouteActivity active={active}>
      {props.children}
    </LodyRouteActivity>
  );
}

export function LodySurfaceVisibilityOwner(props: { children: ReactNode }) {
  const { active, hidden } = useLodySurfaceActiveState();
  return (
    <LodySurfaceVisibilityRoot
      hidden={hidden}
      active={active}
      className={LODY_SURFACE_CLASS}
    >
      {props.children}
    </LodySurfaceVisibilityRoot>
  );
}

export function LodySurfaceToasterOwner() {
  const { active } = useLodySurfaceActiveState();
  return active ? <LodySurfaceToaster /> : null;
}

export function LodySurfaceAgentAuthNotice(props: {
  store: LodyAtomStore;
  machineId: string;
  sessionId: string | null;
  shared: boolean;
}) {
  const { surfaceTabs } = useLodySurfaceActiveState();
  if (surfaceTabs !== undefined && surfaceTabs.activeTabId !== null) return null;
  return (
    <LodyAgentAuthNotice
      store={props.store}
      sessionId={props.sessionId}
      {...(props.shared ? {} : { machineId: props.machineId })}
    />
  );
}
