import type { CoreRuntime } from "../runtime.js";
import type { FileSyncResult } from "./sync.js";

const pendingScheduledSyncs = new Set<Promise<void>>();

/** Settles when every schedule-triggered pass started so far has finished. */
export async function scheduledSyncsSettled(): Promise<void> {
  while (pendingScheduledSyncs.size > 0) {
    await Promise.all([...pendingScheduledSyncs]);
  }
}

/** Fire-and-forget convergence; the scheduled sweep remains the backstop. */
export function scheduleSync(
  runtime: CoreRuntime,
  run: (runtime: CoreRuntime) => Promise<FileSyncResult>,
): void {
  const sync = run(runtime).then(() => undefined).catch((caught) => {
    const error = caught instanceof Error ? caught : new Error("folder sync failed");
    runtime.reportError("folder_sync_failed", error);
  });
  pendingScheduledSyncs.add(sync);
  void sync.finally(() => pendingScheduledSyncs.delete(sync));
  try {
    runtime.waitUntil(sync);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("folder sync scheduling failed");
    runtime.reportError("folder_sync_schedule_failed", error);
  }
}
