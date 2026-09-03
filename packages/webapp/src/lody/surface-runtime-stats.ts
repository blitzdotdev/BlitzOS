/** Page-local runtime lifecycle instrumentation used by cleanup tests and the probe. */

let liveRuntimeHandles = 0;

export function lodyLiveRuntimeHandleCount(): number {
  return liveRuntimeHandles;
}

export function recordLodyRuntimeCreated(): void {
  liveRuntimeHandles += 1;
}

export function recordLodyRuntimeDisposed(): void {
  liveRuntimeHandles = Math.max(0, liveRuntimeHandles - 1);
}
