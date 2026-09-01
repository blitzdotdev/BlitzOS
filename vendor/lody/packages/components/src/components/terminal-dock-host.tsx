import { getSessionRoomId, type ElectronCliState, type SessionId } from '@lody/shared';
import { useAtomValue } from 'jotai';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { useElectronCliDaemon } from '@/hooks/use-electron-cli-daemon';
import { TerminalDock } from './terminal/terminal-dock';
import { createElectronTerminalChannel } from './terminal/electron-terminal-channel';

// The terminal can only attach once the daemon is actually up (running/degraded).
function canUseTerminalCliPhase(phase: ElectronCliState['phase']): boolean {
  return phase === 'running' || phase === 'degraded';
}

/**
 * Mounts the bottom terminal dock for the active route session. Electron-only,
 * and only wires a real `sessionId` when the route session is a local project on
 * this machine — that gate is also what makes the session header's dock icon and
 * the ⌃`/⌘J command appear (via the dock controller). The daemon status +
 * restart/terminate controls now live in Settings → General → Startup.
 */
export function TerminalDockHost() {
  const params = useParams({ strict: false });
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const routeSessionId =
    typeof params.sessionId === 'string' && params.sessionId.trim()
      ? (params.sessionId as SessionId)
      : null;
  const routeSessionRoomId = getSessionRoomId((routeSessionId ?? '__no_session__') as SessionId);
  const routeSession = useAtomValue(sessionMetaAtomFamily(routeSessionRoomId));
  const routeSessionLiveStatus = useAtomValue(
    sessionLiveStatusAtomFamily((routeSessionId ?? '__no_session__') as SessionId)
  );
  const { phase: cliPhase } = useElectronCliDaemon();

  const terminalChannel = useMemo(
    () => (isElectron ? createElectronTerminalChannel() : null),
    [isElectron]
  );

  const isRouteSessionLocal =
    Boolean(terminalChannel && routeSessionId && localMachineId) &&
    routeSession?.machineId === localMachineId;
  const isRouteSessionReadyForTerminal =
    Boolean(routeSession?.acpSessionId) || routeSessionLiveStatus != null;
  const canCreateTerminal =
    isRouteSessionLocal && canUseTerminalCliPhase(cliPhase) && isRouteSessionReadyForTerminal;
  const terminalSessionId =
    terminalChannel && isRouteSessionLocal && routeSessionId ? routeSessionId : undefined;

  if (!isElectron || !terminalChannel) return null;

  return (
    <TerminalDock
      channel={terminalChannel}
      sessionId={terminalSessionId}
      canCreateTerminal={canCreateTerminal}
    />
  );
}
