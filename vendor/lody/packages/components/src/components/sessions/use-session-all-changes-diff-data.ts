import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '@lody/shared';
import { sessionFileProviderDiffResultToFileDiffData } from '@/lib/session-file-provider-diff';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import { arePathsEquivalent, type FileDiffData } from './session-conversation-diff-types';
import { shouldRetrySessionProviderDiffErrorMessage } from './use-session-conversation-diff-data';

const RETRY_DELAY_MS = 800;
const DEFERRED_LOAD_CONCURRENCY = 4;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }
    window.setTimeout(resolve, ms);
  });

/**
 * Base ("All Changes") diff loader. Unlike {@link useSessionConversationDiffData}, which pulls
 * each file with its own gated Machine RPC, this fires ONE batched `getAllChangesDiff` request
 * that returns every changed file's current diff. Files the machine could not inline come back
 * `deferred` and are lazily fetched per file via `getDiff` (focus first, bounded). One request
 * means no per-file fan-out, no 1200ms trickle, and a clean single-request retry.
 *
 * Returns the same shape the diff panel consumes from the conversation hook, so the panel can
 * select between the two by `mode`.
 */
export function useSessionAllChangesDiffData({
  filePaths,
  focusPath,
  fileProvider,
  fileProviderPending = false,
  enabled = true,
}: {
  sessionId: SessionId;
  filePaths: string[];
  focusPath?: string | null;
  fileProvider?: SessionFileProvider | null;
  fileProviderPending?: boolean;
  enabled?: boolean;
}): {
  cacheKey: string | null;
  normalizedPaths: string[];
  resolvedByPath: Record<string, FileDiffData>;
  hasAllResolved: boolean;
  isDiffUnavailable: boolean;
  isPanelLoading: boolean;
} {
  const normalizedPaths = useMemo(
    () => Array.from(new Set(filePaths.filter(Boolean))).toSorted((a, b) => a.localeCompare(b)),
    [filePaths]
  );
  const normalizedPathsKey = useMemo(() => JSON.stringify(normalizedPaths), [normalizedPaths]);

  const [resolvedByPath, setResolvedByPath] = useState<Record<string, FileDiffData>>({});

  // Keep focusPath out of the fetch deps (it only affects inline ordering, not the result set)
  // so changing the selected file does not re-fire the whole batch.
  const focusPathRef = useRef(focusPath);
  focusPathRef.current = focusPath;

  const canBatch = Boolean(fileProvider?.getAllChangesDiff);
  const isDiffUnavailable =
    !fileProviderPending && (!fileProvider || !canBatch) && normalizedPaths.length > 0;

  useEffect(() => {
    if (!enabled || !fileProvider?.getAllChangesDiff) {
      return undefined;
    }
    let cancelled = false;
    const getAllChangesDiff = fileProvider.getAllChangesDiff.bind(fileProvider);

    const applyEntry = (path: string, data: FileDiffData): void => {
      if (cancelled) return;
      setResolvedByPath((prev) => ({ ...prev, [path]: data }));
    };

    const run = async (): Promise<void> => {
      const focus = focusPathRef.current ?? undefined;
      let result = await getAllChangesDiff(focus);
      if (
        !cancelled &&
        result.status === 'unavailable' &&
        shouldRetrySessionProviderDiffErrorMessage(result.message ?? result.reason)
      ) {
        await delay(RETRY_DELAY_MS);
        if (cancelled) return;
        result = await getAllChangesDiff(focus);
      }
      if (cancelled) return;

      if (result.status === 'unavailable') {
        // Mark every expected path unavailable so the panel stops spinning.
        const next: Record<string, FileDiffData> = {};
        for (const path of normalizedPaths) {
          next[path] = sessionFileProviderDiffResultToFileDiffData({
            status: 'unavailable',
            path,
            reason: result.reason,
            ...(result.message === undefined ? {} : { message: result.message }),
          });
        }
        if (!cancelled) setResolvedByPath(next);
        return;
      }

      const entryPaths = new Set(result.entries.map((entry) => entry.path));
      const deferredPaths: string[] = [];
      const next: Record<string, FileDiffData> = {};
      for (const entry of result.entries) {
        if (entry.diff.status === 'deferred') {
          deferredPaths.push(entry.path);
          continue;
        }
        next[entry.path] = sessionFileProviderDiffResultToFileDiffData(entry.diff);
      }
      // Reconcile: any expected path the batch did not mention is treated as unavailable so
      // `hasAllResolved` can complete (the list can briefly disagree with git).
      for (const path of normalizedPaths) {
        if (next[path] !== undefined || entryPaths.has(path)) {
          continue;
        }
        next[path] = sessionFileProviderDiffResultToFileDiffData({
          status: 'unavailable',
          path,
          reason: 'metadata-only',
        });
      }
      if (cancelled) return;
      setResolvedByPath(next);

      // Lazily fetch deferred files (focus first), bounded concurrency. Deferred is the rare
      // oversized case, so this fan-out stays small.
      const focusValue = focusPathRef.current;
      const orderedDeferred = focusValue
        ? [
            ...deferredPaths.filter((path) => arePathsEquivalent(path, focusValue)),
            ...deferredPaths.filter((path) => !arePathsEquivalent(path, focusValue)),
          ]
        : deferredPaths;
      const getDiffBound = fileProvider.getDiff.bind(fileProvider);
      let index = 0;
      const loadNext = async (): Promise<void> => {
        while (index < orderedDeferred.length) {
          if (cancelled) return;
          const path = orderedDeferred[index];
          index += 1;
          if (path === undefined) continue;
          const single = sessionFileProviderDiffResultToFileDiffData(await getDiffBound(path));
          if (cancelled) return;
          applyEntry(path, single);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DEFERRED_LOAD_CONCURRENCY, orderedDeferred.length) }, () =>
          loadNext()
        )
      );
    };

    void run();
    return () => {
      cancelled = true;
    };
    // Refetch when the provider is rebuilt (file-index/list changed → D4) or the path set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fileProvider, normalizedPathsKey]);

  // Reset when disabled or the path set changes so stale rows do not leak across sessions/tabs.
  useEffect(() => {
    setResolvedByPath({});
  }, [normalizedPathsKey]);

  const hasAllResolved = useMemo(
    () => normalizedPaths.every((path) => Boolean(resolvedByPath[path])),
    [normalizedPaths, resolvedByPath]
  );
  const isPanelLoading = normalizedPaths.length > 0 && !isDiffUnavailable && !hasAllResolved;

  return {
    cacheKey: null,
    normalizedPaths,
    resolvedByPath,
    hasAllResolved,
    isDiffUnavailable,
    isPanelLoading,
  };
}
