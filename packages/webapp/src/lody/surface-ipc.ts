/** One surface's captured IPC authority and compatibility-global ownership. */
import { useEffect, useLayoutEffect, useRef } from "react";
import { createBoundIpcClient } from "@lody/components/lib/electron-ipc-client";
import {
  createLodyLocalBridge,
  publishLodyLocalBridge,
  type LodyLocalBridge,
} from "./local-bridge.js";
import type { LodyRuntimeEndpoints } from "./runtime.js";
import { useLodySurfaceActiveState } from "./surface-active-context.js";
import {
  createLodySurfaceRuntimeLifecycle,
  type LodySurfaceRuntimeLifecycle,
} from "./surface-runtime-lifecycle.js";

type SurfaceIpcClient = {
  readonly signal: AbortSignal;
  dispose: () => void;
};

export type LodySurfaceIpc = {
  bridge: LodyLocalBridge;
  ipcClient: SurfaceIpcClient;
  runtimeLifecycle: LodySurfaceRuntimeLifecycle;
  releaseSurface: () => void;
  pendingTerminalRelease: { cancelled: boolean } | null;
};

/** Capture one bridge/client pair for the full lifetime of a surface. */
export function useLodySurfaceIpc(
  endpoints: LodyRuntimeEndpoints,
  onContinuityLost?: () => void,
  onSurfaceReleased?: () => void,
): LodySurfaceIpc {
  const held = useRef<LodySurfaceIpc | null>(null);
  const continuityRef = useRef(onContinuityLost);
  const releaseRef = useRef(onSurfaceReleased);
  continuityRef.current = onContinuityLost;
  releaseRef.current = onSurfaceReleased;
  if (held.current === null) {
    const bridge = createLodyLocalBridge({
      ...endpoints,
      onContinuity: () => continuityRef.current?.(),
    });
    held.current = {
      bridge,
      ipcClient: createBoundIpcClient(bridge.ipc),
      runtimeLifecycle: createLodySurfaceRuntimeLifecycle({
        onConstructionSlow: ({ attemptId, timeoutMs }) => {
          console.warn("lody: runtime construction is still pending", {
            attemptId,
            platformUrl: endpoints.platformUrl,
            timeoutMs,
          });
        },
      }),
      releaseSurface: () => releaseRef.current?.(),
      pendingTerminalRelease: null,
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
    const pending = held.pendingTerminalRelease;
    if (pending !== null) pending.cancelled = true;
    held.pendingTerminalRelease = null;
    return () => {
      // StrictMode cleans and remounts effects on the same component instance.
      // A real eviction has no next generation and terminally releases both.
      const terminalRelease = { cancelled: false };
      held.pendingTerminalRelease = terminalRelease;
      queueMicrotask(() => {
        if (terminalRelease.cancelled) return;
        held.pendingTerminalRelease = null;
        held.runtimeLifecycle.releaseAfterRuntime(() => {
          ipcClient.dispose();
          try {
            bridge.dispose();
          } finally {
            held.releaseSurface();
          }
        });
      });
    };
  }, [bridge, held, ipcClient]);
}

/** Only this tiny subscriber changes when page-global IPC ownership flips. */
export function LodySurfaceIpcOwner({ held }: { held: LodySurfaceIpc }) {
  const { active } = useLodySurfaceActiveState();
  useLodySurfaceIpcLifecycle(held, active);
  return null;
}
