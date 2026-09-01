// Preview shim for `@/ui/diff-viewer/diff-viewer-lazy`.
// The real DiffViewer loads @pierre/diffs web workers that are not needed in the
// public-site preview bundle. The embedded preview's mock conversation contains no diff blocks, so a
// no-op renderer keeps the ai-gui message renderer importable.
import type { ReactElement } from 'react';

export type DiffViewerProps = Record<string, unknown>;

export function DiffViewer(_props: DiffViewerProps): ReactElement | null {
  return null;
}
