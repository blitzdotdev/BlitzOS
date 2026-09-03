/** One retained surface's rail subtree and shell-host ownership wrapper. */
import { memo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { SessionRailSidebar } from "./SessionRailSidebar.js";
import { useLodySurfaceActiveState } from "./surface-active-context.js";
import { markLodyActivationPhase } from "./surface-activation-performance.js";

const RetainedSessionRailSidebar = memo(SessionRailSidebar);

function LodyRailPortalCommitMarker({ targetKey }: { targetKey: string }) {
  useLayoutEffect(() => {
    markLodyActivationPhase(targetKey, "rail-portal-mount-commit");
  }, [targetKey]);
  return null;
}

export function LodySurfaceRailPortal(props: {
  targetKey: string;
  activeSessionId: string | null;
  archiveOpen: boolean;
  openSession: (sessionId: string) => void;
  openLanding: (options?: { resetDraft?: boolean }) => void;
  openArchive: () => void;
}) {
  const { active, hidden, railHost, rail } = useLodySurfaceActiveState();
  if (railHost === null || railHost === undefined || rail === undefined) return null;
  const shown = active;
  return createPortal(
    <div
      data-lody-rail-active={shown ? "true" : "false"}
      hidden={!shown}
      inert={!shown}
      aria-hidden={shown ? undefined : "true"}
    >
      <LodyRailPortalCommitMarker targetKey={props.targetKey} />
      <RetainedSessionRailSidebar
        terminals={rail.terminals}
        activeTerminalId={rail.activeTerminalId}
        activeSessionId={props.activeSessionId}
        archiveActive={props.archiveOpen}
        surfaceVisible={!hidden}
        onSelectTerminal={rail.onSelectTerminal}
        {...(rail.onCloseTerminal === undefined
          ? {}
          : { onCloseTerminal: rail.onCloseTerminal })}
        onSelectSession={rail.onOpenSession ?? props.openSession}
        onOpenLanding={rail.onOpenLanding ?? props.openLanding}
        onOpenArchive={rail.onOpenArchive ?? props.openArchive}
        {...(rail.terminalsAction === undefined
          ? {}
          : { terminalsAction: rail.terminalsAction })}
        {...(rail.onShareSession === undefined
          ? {}
          : { onShareSession: rail.onShareSession })}
        {...(rail.sharedSessions === undefined
          ? {}
          : { sharedSessions: rail.sharedSessions })}
        {...(rail.activeSharedSessionId === undefined
          ? {}
          : { activeSharedSessionId: rail.activeSharedSessionId })}
        {...(rail.onSelectSharedSession === undefined
          ? {}
          : { onSelectSharedSession: rail.onSelectSharedSession })}
      />
    </div>,
    railHost,
  );
}
