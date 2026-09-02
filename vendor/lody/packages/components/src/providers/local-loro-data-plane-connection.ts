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
  const messageUnsubscribers = new Set<() => void>();
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
      onMessage: (listener) => {
        const unsubscribe = onIpcEvent('loro.event', listener, ipcClient);
        messageUnsubscribers.add(unsubscribe);
        return () => {
          messageUnsubscribers.delete(unsubscribe);
          unsubscribe();
        };
      },
      onStatusChange: (listener) => {
        statusListeners.add(listener);
        listener(connected);
        return () => statusListeners.delete(listener);
      },
      isConnected: () => connected,
    },
    dispose: () => {
      unsubscribeStatus();
      for (const unsubscribe of messageUnsubscribers) unsubscribe();
      messageUnsubscribers.clear();
      statusListeners.clear();
    },
  };
}
