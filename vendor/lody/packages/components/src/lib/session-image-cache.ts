import type { SessionId, WorkspaceId } from '@lody/shared';
import type { SessionImageResizeFit } from '@lody/shared';
import { SESSION_IMAGE_RESIZE_DEFAULT_WIDTH } from '@lody/shared';
import {
  buildSessionImageDownloadUrl,
  buildSessionImageThumbnailUrl,
} from './session-image-upload';

type CacheEntry = {
  key: string;
  blob: Blob;
  blobUrl: string;
  dataUrl?: string;
  sizeBytes: number;
  lastAccessedAt: number;
};

const imageCache = new Map<string, CacheEntry>();
const inFlightCache = new Map<string, Promise<CacheEntry>>();
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const PERSISTENT_CACHE_NAME = 'lody-session-image-v1';
// Advertise modern formats so the Worker thumbnail route can transcode to
// AVIF/WebP. `fetch()` otherwise sends `Accept: */*`, which disables that
// server-side negotiation and ships the larger original format.
const SESSION_IMAGE_FETCH_ACCEPT = 'image/avif,image/webp,image/*,*/*';

let totalCachedBytes = 0;

export type SessionImageLoadVariant = 'original' | 'thumbnail';

const getCacheKey = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  imageId: string,
  variant: SessionImageLoadVariant,
  requestUrl: string
): string => `${workspaceId}:${sessionId}:${imageId}:${variant}:${requestUrl}`;

const touchCacheEntry = (entry: CacheEntry): void => {
  entry.lastAccessedAt = Date.now();
  imageCache.delete(entry.key);
  imageCache.set(entry.key, entry);
};

const evictIfNeeded = (): void => {
  if (totalCachedBytes <= MAX_CACHE_BYTES) {
    return;
  }

  for (const [key, entry] of imageCache) {
    imageCache.delete(key);
    URL.revokeObjectURL(entry.blobUrl);
    totalCachedBytes = Math.max(0, totalCachedBytes - entry.sizeBytes);
    if (totalCachedBytes <= MAX_CACHE_BYTES) {
      break;
    }
  }
};

const supportsPersistentCacheStorage = (): boolean => {
  return typeof window !== 'undefined' && typeof window.caches !== 'undefined';
};

const readBlobFromPersistentCache = async (downloadUrl: string): Promise<Blob | null> => {
  if (!supportsPersistentCacheStorage()) {
    return null;
  }

  try {
    const cache = await window.caches.open(PERSISTENT_CACHE_NAME);
    const response = await cache.match(downloadUrl);
    if (!response) {
      return null;
    }
    return await response.blob();
  } catch {
    return null;
  }
};

const writeBlobToPersistentCache = async (downloadUrl: string, blob: Blob): Promise<void> => {
  if (!supportsPersistentCacheStorage()) {
    return;
  }

  try {
    const cache = await window.caches.open(PERSISTENT_CACHE_NAME);
    await cache.put(
      downloadUrl,
      new Response(blob, {
        status: 200,
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    );
  } catch {
    // Ignore CacheStorage failures and continue using in-memory cache only.
  }
};

const writeBlobToMemoryCache = (key: string, blob: Blob): CacheEntry => {
  const existingEntry = imageCache.get(key);
  if (existingEntry) {
    URL.revokeObjectURL(existingEntry.blobUrl);
    totalCachedBytes = Math.max(0, totalCachedBytes - existingEntry.sizeBytes);
    imageCache.delete(key);
  }

  const blobUrl = URL.createObjectURL(blob);
  const entry: CacheEntry = {
    key,
    blob,
    blobUrl,
    sizeBytes: blob.size,
    lastAccessedAt: Date.now(),
  };

  imageCache.set(key, entry);
  totalCachedBytes += blob.size;
  evictIfNeeded();
  return entry;
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Failed to encode image'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to encode image'));
    reader.readAsDataURL(blob);
  });

type GetSessionImageCacheEntryArgs = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  imageId: string;
  token: string;
  variant?: SessionImageLoadVariant;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  thumbnailFit?: SessionImageResizeFit;
  thumbnailQuality?: number;
};

const getSessionImageCacheEntry = async (
  args: GetSessionImageCacheEntryArgs
): Promise<CacheEntry> => {
  const {
    workspaceId,
    sessionId,
    imageId,
    token,
    variant = 'original',
    thumbnailWidth,
    thumbnailHeight,
    thumbnailFit,
    thumbnailQuality,
  } = args;

  const originalUrl = buildSessionImageDownloadUrl(workspaceId, sessionId, imageId);
  const requestUrl =
    variant === 'thumbnail'
      ? buildSessionImageThumbnailUrl(workspaceId, sessionId, imageId, {
          width: thumbnailWidth ?? SESSION_IMAGE_RESIZE_DEFAULT_WIDTH,
          height: thumbnailHeight,
          fit: thumbnailFit,
          quality: thumbnailQuality,
        })
      : originalUrl;
  const key = getCacheKey(workspaceId, sessionId, imageId, variant, requestUrl);
  const cached = imageCache.get(key);
  if (cached) {
    touchCacheEntry(cached);
    return cached;
  }

  const pending = inFlightCache.get(key);
  if (pending) {
    return await pending;
  }

  const requestPromise = (async () => {
    const persistedBlob = await readBlobFromPersistentCache(requestUrl);
    if (persistedBlob) {
      return writeBlobToMemoryCache(key, persistedBlob);
    }

    let response: Response | null = null;
    let requestError: unknown;
    try {
      response = await fetch(requestUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: SESSION_IMAGE_FETCH_ACCEPT,
        },
      });
    } catch (error) {
      requestError = error;
    }

    let blob: Blob;
    let shouldPersistRequestUrl = false;
    if (response?.ok) {
      blob = await response.blob();
      shouldPersistRequestUrl = true;
    } else if (variant === 'thumbnail') {
      // Fallback to the original image when the thumbnail transform is unavailable.
      const persistedOriginalBlob = await readBlobFromPersistentCache(originalUrl);
      if (persistedOriginalBlob) {
        blob = persistedOriginalBlob;
      } else {
        const fallbackResponse = await fetch(originalUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!fallbackResponse.ok) {
          throw new Error(`Failed to load image (${fallbackResponse.status})`);
        }
        blob = await fallbackResponse.blob();
        void writeBlobToPersistentCache(originalUrl, blob);
      }
    } else {
      if (response) {
        throw new Error(`Failed to load image (${response.status})`);
      }
      throw requestError instanceof Error ? requestError : new Error('Failed to load image');
    }

    const entry = writeBlobToMemoryCache(key, blob);
    if (shouldPersistRequestUrl) {
      void writeBlobToPersistentCache(requestUrl, blob);
    }
    return entry;
  })();

  inFlightCache.set(key, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inFlightCache.delete(key);
  }
};

export const getSessionImageBlobUrl = async (
  args: GetSessionImageCacheEntryArgs
): Promise<string> => {
  const entry = await getSessionImageCacheEntry(args);
  return entry.blobUrl;
};

export const getSessionImageDataUrl = async (
  args: GetSessionImageCacheEntryArgs
): Promise<string> => {
  const entry = await getSessionImageCacheEntry(args);
  if (entry.dataUrl) {
    return entry.dataUrl;
  }

  const dataUrl = await blobToDataUrl(entry.blob);
  const current = imageCache.get(entry.key);
  if (current) {
    current.dataUrl = dataUrl;
  }
  return dataUrl;
};

export const clearSessionImageCache = (): void => {
  for (const entry of imageCache.values()) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  imageCache.clear();
  inFlightCache.clear();
  totalCachedBytes = 0;
  if (supportsPersistentCacheStorage()) {
    void window.caches.delete(PERSISTENT_CACHE_NAME);
  }
};
