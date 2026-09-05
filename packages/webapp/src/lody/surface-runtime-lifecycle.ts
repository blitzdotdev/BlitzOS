/** Coordinates concrete runtime construction attempts with terminal IPC teardown. */

export interface LodyRuntimeLifecycleEvent {
  attemptId: number;
  phase: "starting" | "created" | "failed" | "disposed";
}

export interface LodySurfaceRuntimeLifecycle {
  onRuntimeLifecycle(event: LodyRuntimeLifecycleEvent): void;
  releaseAfterRuntime(release: () => void): void;
}

interface RuntimeAttempt {
  completion: Promise<void>;
  complete: () => void;
}

export function createLodySurfaceRuntimeLifecycle(): LodySurfaceRuntimeLifecycle {
  const attempts = new Map<number, RuntimeAttempt>();
  let releaseStarted = false;

  const finishAttempt = (attemptId: number): void => {
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) return;
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
        attempts.set(event.attemptId, {
          completion,
          complete,
        });
        return;
      }
      if (event.phase === "created") return;
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
