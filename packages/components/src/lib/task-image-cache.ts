import { buildTaskImageApiUrl, getTaskImageDownloadApiPath, type WorkspaceId } from '@lody/shared';
import { API_BASE_URL } from '@/lib';

const MAX_MEMORY_ENTRIES = 64;

type CacheEntry = {
  url: string;
  touchedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();
let cacheVersion = 0;
let accessSequence = 0;

const nextAccessSequence = (): number => {
  accessSequence += 1;
  return accessSequence;
};

const cacheKey = (workspaceId: WorkspaceId, imageId: string): string => `${workspaceId}:${imageId}`;

const notify = () => {
  cacheVersion += 1;
  for (const listener of listeners) listener();
};

const evictIfNeeded = () => {
  while (cache.size > MAX_MEMORY_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache) {
      if (entry.touchedAt < oldestAt) {
        oldestAt = entry.touchedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    const entry = cache.get(oldestKey);
    if (entry) URL.revokeObjectURL(entry.url);
    cache.delete(oldestKey);
  }
};

const storeBlob = (key: string, blob: Blob): string => {
  const existing = cache.get(key);
  if (existing) URL.revokeObjectURL(existing.url);
  const url = URL.createObjectURL(blob);
  cache.set(key, { url, touchedAt: nextAccessSequence() });
  evictIfNeeded();
  notify();
  return url;
};

export const subscribeTaskImageCache = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getTaskImageCacheVersion = (): number => cacheVersion;

export const getCachedTaskImageUrl = (
  workspaceId: WorkspaceId,
  imageId: string
): string | undefined => {
  const entry = cache.get(cacheKey(workspaceId, imageId));
  if (!entry) return undefined;
  entry.touchedAt = nextAccessSequence();
  return entry.url;
};

export const primeTaskImageCache = (
  workspaceId: WorkspaceId,
  imageId: string,
  blob: Blob
): string => storeBlob(cacheKey(workspaceId, imageId), blob);

export const loadTaskImageUrl = async (args: {
  workspaceId: WorkspaceId;
  imageId: string;
  token: string;
}): Promise<string> => {
  const key = cacheKey(args.workspaceId, args.imageId);
  const cached = getCachedTaskImageUrl(args.workspaceId, args.imageId);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return await pending;

  const promise = (async () => {
    const response = await fetch(
      buildTaskImageApiUrl(
        API_BASE_URL,
        getTaskImageDownloadApiPath(args.workspaceId, args.imageId)
      ),
      { headers: { Authorization: `Bearer ${args.token}` } }
    );
    if (!response.ok) {
      throw new Error(`Failed to load task image (${response.status})`);
    }
    return storeBlob(key, await response.blob());
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
};
