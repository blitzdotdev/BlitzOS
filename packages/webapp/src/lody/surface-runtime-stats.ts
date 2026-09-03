/** Page-local runtime lifecycle instrumentation used by cleanup tests and the probe. */

let liveRepos = 0;

export function lodyLiveRepoCount(): number {
  return liveRepos;
}

export function recordLodyRuntimeCreated(): void {
  liveRepos += 1;
}

export function recordLodyRuntimeDisposed(): void {
  liveRepos = Math.max(0, liveRepos - 1);
}
