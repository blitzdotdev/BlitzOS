export type TinypoolRuntime = 'worker_threads' | 'child_process';

type ProcessVersionsLike = {
  readonly bun?: unknown;
};

export function isBunProcessVersions(versions: ProcessVersionsLike | undefined): boolean {
  return typeof versions?.bun === 'string' && versions.bun.length > 0;
}

export function tinypoolRuntimeOptions(): { readonly runtime?: TinypoolRuntime } {
  const versions =
    typeof process === 'undefined' ? undefined : (process.versions as ProcessVersionsLike);
  // Bun 1.3.x can complete Tinypool worker_threads jobs but leave the process alive.
  return isBunProcessVersions(versions) ? { runtime: 'child_process' } : {};
}
