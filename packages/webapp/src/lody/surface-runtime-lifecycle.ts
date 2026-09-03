/** Coordinates a surface's runtime effect cycles with terminal IPC teardown. */
import {
  recordLodyRuntimeCreated,
  recordLodyRuntimeDisposed,
} from "./surface-runtime-stats.js";

export const LODY_RUNTIME_CONSTRUCTION_BACKSTOP_MS = 10_000;

export interface LodyRuntimeLifecycleEvent {
  phase: "created" | "failed" | "disposed";
}

export interface LodySurfaceRuntimeLifecycle {
  startCycle(): void;
  onRuntimeLifecycle(event: LodyRuntimeLifecycleEvent): void;
  releaseAfterRuntime(release: () => void): void;
}

export interface LodySurfaceRuntimeLifecycleOptions {
  constructionBackstopMs?: number;
  onConstructionTimeout?: (details: { timeoutMs: number }) => void;
}

export function createLodySurfaceRuntimeLifecycle(
  options: LodySurfaceRuntimeLifecycleOptions = {},
): LodySurfaceRuntimeLifecycle {
  const timeoutMs = options.constructionBackstopMs ?? LODY_RUNTIME_CONSTRUCTION_BACKSTOP_MS;
  const listeners = new Set<() => void>();
  let started = 0;
  let settled = 0;
  let created = 0;
  let disposed = 0;
  let releaseStarted = false;

  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  const waitUntil = async (predicate: () => boolean): Promise<void> => {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      const listener = (): void => {
        if (!predicate()) return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });
  };
  const waitForConstruction = async (expected: number): Promise<boolean> => {
    if (settled >= expected) return true;
    return await new Promise<boolean>((resolve) => {
      const finish = (result: boolean): void => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(result);
      };
      const listener = (): void => {
        if (settled >= expected) finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      listeners.add(listener);
    });
  };

  return {
    startCycle: () => {
      started += 1;
      changed();
    },
    onRuntimeLifecycle: (event) => {
      if (event.phase === "created") {
        settled += 1;
        created += 1;
        recordLodyRuntimeCreated();
      } else if (event.phase === "failed") {
        settled += 1;
      } else {
        disposed += 1;
        recordLodyRuntimeDisposed();
      }
      changed();
    },
    releaseAfterRuntime: (release) => {
      if (releaseStarted) return;
      releaseStarted = true;
      void (async () => {
        if (started === 0) {
          release();
          return;
        }
        const expected = started;
        const constructionSettled = await waitForConstruction(expected);
        if (!constructionSettled) {
          options.onConstructionTimeout?.({ timeoutMs });
          release();
          return;
        }
        await waitUntil(() => disposed >= created);
        release();
      })();
    },
  };
}
