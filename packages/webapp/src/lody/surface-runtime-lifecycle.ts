/** Coordinates concrete runtime construction attempts with terminal IPC teardown. */
import {
  recordLodyRuntimeCreated,
  recordLodyRuntimeDisposed,
} from "./surface-runtime-stats.js";

export const LODY_RUNTIME_CONSTRUCTION_WARNING_MS = 10_000;

export interface LodyRuntimeLifecycleEvent {
  attemptId: number;
  phase: "starting" | "created" | "failed" | "disposed";
}

export interface LodySurfaceRuntimeLifecycle {
  onRuntimeLifecycle(event: LodyRuntimeLifecycleEvent): void;
  releaseAfterRuntime(release: () => void): void;
}

export interface LodySurfaceRuntimeLifecycleOptions {
  constructionWarningMs?: number;
  onConstructionSlow?: (details: { attemptId: number; timeoutMs: number }) => void;
}

interface RuntimeAttempt {
  completion: Promise<void>;
  complete: () => void;
  constructionWarning: ReturnType<typeof setTimeout>;
  handleCreated: boolean;
}

export function createLodySurfaceRuntimeLifecycle(
  options: LodySurfaceRuntimeLifecycleOptions = {},
): LodySurfaceRuntimeLifecycle {
  const warningMs = options.constructionWarningMs ?? LODY_RUNTIME_CONSTRUCTION_WARNING_MS;
  const attempts = new Map<number, RuntimeAttempt>();
  let releaseStarted = false;

  const finishAttempt = (attemptId: number): void => {
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) return;
    clearTimeout(attempt.constructionWarning);
    attempts.delete(attemptId);
    attempt.complete();
  };

  return {
    onRuntimeLifecycle: (event) => {
      if (event.phase === "starting") {
        let complete = (): void => undefined;
        const completion = new Promise<void>((resolve) => {
          complete = resolve;
        });
        const constructionWarning = setTimeout(() => {
          options.onConstructionSlow?.({ attemptId: event.attemptId, timeoutMs: warningMs });
        }, warningMs);
        attempts.set(event.attemptId, {
          completion,
          complete,
          constructionWarning,
          handleCreated: false,
        });
        return;
      }
      if (event.phase === "created") {
        const attempt = attempts.get(event.attemptId);
        if (attempt !== undefined && !attempt.handleCreated) {
          clearTimeout(attempt.constructionWarning);
          attempt.handleCreated = true;
          recordLodyRuntimeCreated();
        }
        return;
      }
      if (event.phase === "disposed" && attempts.get(event.attemptId)?.handleCreated === true) {
        recordLodyRuntimeDisposed();
      }
      finishAttempt(event.attemptId);
    },
    releaseAfterRuntime: (release) => {
      if (releaseStarted) return;
      releaseStarted = true;
      const pending = [...attempts.values()].map((attempt) => attempt.completion);
      if (pending.length === 0) {
        release();
        return;
      }
      void Promise.all(pending).then(release);
    },
  };
}
