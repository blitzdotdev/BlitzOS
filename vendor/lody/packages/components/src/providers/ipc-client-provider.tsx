import { createContext, useContext, type ReactNode } from 'react';
import { windowIpcClient, type LodyIpcClient } from '@/lib/electron-ipc-client';

const IpcClientContext = createContext<readonly [LodyIpcClient, boolean] | null>(null);

export function IpcClientProvider({
  children,
  client,
  localIpcHost = false,
}: {
  children: ReactNode;
  client: LodyIpcClient;
  localIpcHost?: boolean;
}) {
  const value: readonly [LodyIpcClient, boolean] = [client, localIpcHost];
  return <IpcClientContext.Provider value={value}>{children}</IpcClientContext.Provider>;
}

/**
 * The IPC authority for this renderer subtree. Electron mounts no provider and
 * therefore retains the window-backed default.
 */
export function useIpcClient(): LodyIpcClient {
  return useContext(IpcClientContext)?.[0] ?? windowIpcClient;
}

/** Whether the captured client fronts a local machine plane. */
export function useLocalIpcHost(): boolean {
  const context = useContext(IpcClientContext);
  if (context) return context[1];
  return (
    typeof window !== 'undefined' &&
    (window.__LODY_ELECTRON__ === true || window.__LODY_LOCAL_BRIDGE__ === true)
  );
}
