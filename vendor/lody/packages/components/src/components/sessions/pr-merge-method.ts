import { useSyncExternalStore } from 'react';
import type { GitHubMergeMethod } from '@lody/shared';

const MERGE_METHOD_STORAGE_KEY = 'lody:pr-tab:last-merge-method';

let currentMethod: GitHubMergeMethod | undefined;
const listeners = new Set<() => void>();

function readStoredMergeMethod(): GitHubMergeMethod {
  if (typeof window === 'undefined') return 'merge';
  try {
    const raw = window.localStorage.getItem(MERGE_METHOD_STORAGE_KEY);
    if (raw === 'merge' || raw === 'squash' || raw === 'rebase') return raw;
  } catch {
    // Storage is an optional preference; merge still works with the default.
  }
  return 'merge';
}

function getSnapshot(): GitHubMergeMethod {
  currentMethod ??= readStoredMergeMethod();
  return currentMethod;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPreferredPrMergeMethod(method: GitHubMergeMethod): void {
  if (currentMethod === method) return;
  currentMethod = method;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MERGE_METHOD_STORAGE_KEY, method);
    }
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

/** One merge-method preference shared by the Info Bar and PR side panel. */
export function usePreferredPrMergeMethod(): GitHubMergeMethod {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'merge');
}
