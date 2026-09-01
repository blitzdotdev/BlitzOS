// Preview shim for `@/ui/diff-viewer/diff-render-worker`.
// The real module imports @pierre/diffs' Vite `?worker` render worker, which the
// Next marketing build can't bundle. Returning no pool makes the real DiffViewer's
// <FileDiff> render on the MAIN THREAD (shared highlighter fallback) — still the
// genuine component, just without the off-thread render pool.
export function createDiffRenderWorkerPool(..._args: readonly unknown[]): undefined {
  return undefined;
}

export function configureDiffRenderWorkerPool(..._args: readonly unknown[]): Promise<void> {
  return Promise.resolve();
}
