/** One surface's captured IPC authority and compatibility-global ownership. */
import { useEffect, useLayoutEffect, useRef } from "react";
import { createBoundIpcClient } from "@lody/components/lib/electron-ipc-client";
import {
  createLodyLocalBridge,
  publishLodyLocalBridge,
  type LodyLocalBridge,
} from "./local-bridge.js";
import type { LodyRuntimeEndpoints } from "./runtime.js";

type SurfaceIpcClient = {
  readonly signal: AbortSignal;
  dispose: () => void;
};

export type LodySurfaceIpc = {
  bridge: LodyLocalBridge;
  ipcClient: SurfaceIpcClient;
  lifecycleGeneration: number;
};

/** Capture one bridge/client pair for the full lifetime of a surface. */
export function useLodySurfaceIpc(endpoints: LodyRuntimeEndpoints): LodySurfaceIpc {
  const held = useRef<LodySurfaceIpc | null>(null);
  if (held.current === null) {
    const bridge = createLodyLocalBridge(endpoints);
    held.current = {
      bridge,
      ipcClient: createBoundIpcClient(bridge.ipc),
      lifecycleGeneration: 0,
    };
  }
  return held.current;
}

/** Publish only the active surface and release both authorities on eviction. */
export function useLodySurfaceIpcLifecycle(held: LodySurfaceIpc, active: boolean): void {
  const { bridge, ipcClient } = held;
  useLayoutEffect(() => {
    if (!active) return undefined;
    return publishLodyLocalBridge(bridge);
  }, [active, bridge]);

  useEffect(() => {
    held.lifecycleGeneration += 1;
    const generation = held.lifecycleGeneration;
    return () => {
      // StrictMode cleans and remounts effects on the same component instance.
      // A real eviction has no next generation and terminally releases both.
      queueMicrotask(() => {
        if (held.lifecycleGeneration !== generation) return;
        ipcClient.dispose();
        bridge.dispose();
      });
    };
  }, [bridge, held, ipcClient]);
}
