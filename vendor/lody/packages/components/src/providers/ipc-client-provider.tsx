import { createContext, useContext, type ReactNode } from 'react';
import { windowIpcClient, type LodyIpcClient } from '@/lib/electron-ipc-client';

const IpcClientContext = createContext<LodyIpcClient>(windowIpcClient);

export function IpcClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client: LodyIpcClient;
}) {
  return <IpcClientContext.Provider value={client}>{children}</IpcClientContext.Provider>;
}

/**
 * The IPC authority for this renderer subtree. Electron mounts no provider and
 * therefore retains the window-backed default.
 */
export function useIpcClient(): LodyIpcClient {
  return useContext(IpcClientContext);
}
