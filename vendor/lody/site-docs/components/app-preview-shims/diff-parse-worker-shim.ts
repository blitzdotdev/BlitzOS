// Preview shim for `@/lib/diff-parse-worker`.
// The real module imports a Vite `?worker` diff-parse worker. The marketing preview
// only shows small mock diffs, which DiffViewer parses on the main thread
// (`parseDiffFromFile`) anyway; returning `undefined` here keeps the off-thread path
// unavailable so the real DiffViewer falls back to that main-thread parse.
export async function parseDiffInWorker(): Promise<undefined> {
  return undefined;
}

export async function parseDiffTextSourceInWorker(): Promise<undefined> {
  return undefined;
}
