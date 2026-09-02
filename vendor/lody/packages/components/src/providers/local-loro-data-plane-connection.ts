import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import {
  getIpcServices,
  onIpcEvent,
  sendIpc,
  windowIpcClient,
  type LodyIpcClient,
} from '@/lib/electron-ipc-client';

export function createLocalLoroDataPlaneConnection(ipcClient: LodyIpcClient = windowIpcClient): {
  connection: LocalLoroDataPlaneConnection;
  dispose: () => void;
} | null {
  if (!getIpcServices(ipcClient)) return null;

  let connected = false;
  const statusListeners = new Set<(connected: boolean) => void>();
  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    for (const listener of statusListeners) listener(next);
  };
  sendIpc('loro.subscribe', null, ipcClient);
  const unsubscribeStatus = onIpcEvent('loro.status', setConnected, ipcClient);
  void getIpcServices(ipcClient)!.loro.isConnected().then(setConnected);

  return {
    connection: {
      send: (message) => sendIpc('loro.send', message, ipcClient),
      onMessage: (listener) => onIpcEvent('loro.event', listener, ipcClient),
      onStatusChange: (listener) => {
        statusListeners.add(listener);
        listener(connected);
        return () => statusListeners.delete(listener);
      },
      isConnected: () => connected,
    },
    dispose: () => {
      unsubscribeStatus();
      statusListeners.clear();
    },
  };
}
