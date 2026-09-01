import {
  SESSION_IMAGE_ALLOWED_EXTENSIONS,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES,
} from './ai';

export {
  SESSION_IMAGE_ALLOWED_EXTENSIONS,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES,
};

export const WORKSPACE_API_PATH_PREFIX = '/api/workspaces';
export const SESSION_IMAGE_UPLOAD_API_PATH = '/session-images/upload';
export const SESSION_IMAGE_OBJECT_PREFIX = 'session-images';
export const SESSION_IMAGE_DOWNLOAD_CACHE_CONTROL = 'private, max-age=31536000, immutable';
export const SESSION_IMAGE_THUMBNAIL_API_SUFFIX = '/thumbnail';
export const SESSION_IMAGE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_IMAGE_RESIZE_MIN_DIMENSION = 16;
const SESSION_IMAGE_RESIZE_MAX_DIMENSION = 4096;
export const SESSION_IMAGE_RESIZE_DEFAULT_WIDTH = 512;
const SESSION_IMAGE_RESIZE_MIN_QUALITY = 1;
const SESSION_IMAGE_RESIZE_MAX_QUALITY = 100;
const SESSION_IMAGE_RESIZE_DEFAULT_QUALITY = 85;

export type SessionImageResizeFit = 'cover' | 'contain' | 'scale-down';
export type SessionImageThumbnailOptions = {
  width: number;
  height?: number;
  fit?: SessionImageResizeFit;
  quality?: number;
};
/** Fully normalized resize options — what both ends of the thumbnail wire agree on. */
export type SessionImageResizeOptions = {
  width: number;
  height: number | undefined;
  fit: SessionImageResizeFit;
  quality: number;
};

const trimTrailingSlash = (url: string): string => {
  if (!url.endsWith('/')) {
    return url;
  }
  return url.slice(0, -1);
};

const clampRoundedNumber = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, Math.round(value)));
};

const normalizeResizeDimension = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return clampRoundedNumber(
    value,
    SESSION_IMAGE_RESIZE_MIN_DIMENSION,
    SESSION_IMAGE_RESIZE_MAX_DIMENSION
  );
};

const normalizeResizeQuality = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SESSION_IMAGE_RESIZE_DEFAULT_QUALITY;
  }
  return clampRoundedNumber(
    value,
    SESSION_IMAGE_RESIZE_MIN_QUALITY,
    SESSION_IMAGE_RESIZE_MAX_QUALITY
  );
};

const normalizeResizeFit = (
  fit: SessionImageResizeFit | string | null | undefined
): SessionImageResizeFit => {
  if (fit === 'cover' || fit === 'contain' || fit === 'scale-down') {
    return fit;
  }
  return 'scale-down';
};

export const isValidSessionImagePathSegment = (value: string): boolean => {
  return SESSION_IMAGE_PATH_SEGMENT_PATTERN.test(value);
};

export const getSessionImageUploadApiPath = (workspaceId: string): string => {
  return `${WORKSPACE_API_PATH_PREFIX}/${encodeURIComponent(workspaceId)}${SESSION_IMAGE_UPLOAD_API_PATH}`;
};

export const getSessionImageDownloadApiPath = (
  workspaceId: string,
  sessionId: string,
  imageId: string
): string => {
  return `${WORKSPACE_API_PATH_PREFIX}/${encodeURIComponent(
    workspaceId
  )}/session-images/${encodeURIComponent(sessionId)}/${encodeURIComponent(imageId)}`;
};

export const buildSessionImageApiUrl = (apiBaseUrl: string, apiPath: string): string => {
  return `${trimTrailingSlash(apiBaseUrl)}${apiPath}`;
};

/**
 * Clamp caller-supplied resize options. The client normalizes so the thumbnail
 * URL is a stable cache key; the Worker re-normalizes the same way because the
 * query string is untrusted input to a paid transform.
 */
const normalizeThumbnailOptions = (options: {
  width?: number;
  height?: number;
  fit?: SessionImageResizeFit | string | null;
  quality?: number;
}): SessionImageResizeOptions => {
  const width = normalizeResizeDimension(options.width, SESSION_IMAGE_RESIZE_DEFAULT_WIDTH);
  return {
    width,
    height:
      typeof options.height === 'number'
        ? normalizeResizeDimension(options.height, width)
        : undefined,
    fit: normalizeResizeFit(options.fit),
    quality: normalizeResizeQuality(options.quality),
  };
};

const readNumberSearchParam = (searchParams: URLSearchParams, key: string): number | undefined => {
  const rawValue = searchParams.get(key);
  if (rawValue === null || rawValue.trim() === '') {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : undefined;
};

/** Inverse of {@link getSessionImageThumbnailApiPath}'s query string. */
export const parseSessionImageThumbnailOptions = (
  searchParams: URLSearchParams
): SessionImageResizeOptions => {
  return normalizeThumbnailOptions({
    width: readNumberSearchParam(searchParams, 'width'),
    // Absent height means "keep the aspect ratio"; a present but unparseable
    // height falls back to the width, matching the builder.
    height: searchParams.has('height')
      ? (readNumberSearchParam(searchParams, 'height') ?? Number.NaN)
      : undefined,
    fit: searchParams.get('fit'),
    quality: readNumberSearchParam(searchParams, 'quality'),
  });
};

export const getSessionImageThumbnailApiPath = (
  workspaceId: string,
  sessionId: string,
  imageId: string,
  options: SessionImageThumbnailOptions
): string => {
  const { width, height, fit, quality } = normalizeThumbnailOptions(options);
  const searchParams = new URLSearchParams();
  searchParams.set('width', String(width));
  if (height !== undefined) {
    searchParams.set('height', String(height));
  }
  searchParams.set('fit', fit);
  searchParams.set('quality', String(quality));
  return `${getSessionImageDownloadApiPath(
    workspaceId,
    sessionId,
    imageId
  )}${SESSION_IMAGE_THUMBNAIL_API_SUFFIX}?${searchParams.toString()}`;
};

export const buildSessionImageObjectKey = (
  workspaceId: string,
  sessionId: string,
  imageId: string
): string => {
  return `${SESSION_IMAGE_OBJECT_PREFIX}/${workspaceId}/${sessionId}/${imageId}`;
};
