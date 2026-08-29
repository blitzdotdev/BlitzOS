import { useEffect, useState } from 'react';
import type { ElectronUpdaterState } from '@lody/shared';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

export function useElectronUpdaterState(): ElectronUpdaterState | null {
  const [state, setState] = useState<ElectronUpdaterState | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.__LODY_ELECTRON__) return undefined;

    if (!getIpcServices()) return undefined;

    let active = true;
    void getIpcServices()!
      .updater.getState()
      .then((s) => {
        if (active) setState(s);
      })
      .catch(() => undefined);

    const unsubscribe = onIpcEvent('updater.state', (s) => {
      if (active) setState(s);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}
