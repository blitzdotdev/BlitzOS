import type { CoreRuntime } from "../runtime.js";
import type { FileSyncResult } from "./sync.js";

/** Fire-and-forget convergence; the scheduled sweep remains the backstop.
 * The pass outlives the response through `runtime.waitUntil` — tests observe
 * it by settling their ExecutionContext, not through any registry here. */
export function scheduleSync(
  runtime: CoreRuntime,
  run: (runtime: CoreRuntime) => Promise<FileSyncResult>,
): void {
  const sync = run(runtime).then(() => undefined).catch((caught) => {
    const error = caught instanceof Error ? caught : new Error("folder sync failed");
    runtime.reportError("folder_sync_failed", error);
  });
  try {
    runtime.waitUntil(sync);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("folder sync scheduling failed");
    runtime.reportError("folder_sync_schedule_failed", error);
  }
}
