// Constants live in ai.ts (single source of truth, mirroring session-image).
// `WORKSPACE_API_PATH_PREFIX` is already exported by session-image.ts; import
// it here rather than re-exporting to avoid a duplicate-export collision under
// the barrel's `export *`.
import { WORKSPACE_API_PATH_PREFIX } from './session-image';

export const SESSION_FILE_OBJECT_PREFIX = 'session-files';
export const SESSION_FILE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Maximum size of a single multipart part. Uploads at or below one part go
 * through the single-shot endpoint; anything larger MUST use multipart
 * (create → upload parts → complete). 16 MiB keeps part counts low for the
 * 100 MB ceiling (≤7 parts) while staying well above R2's 5 MiB part minimum.
 */
export const SESSION_FILE_PART_SIZE_BYTES = 16 * 1024 * 1024;

export const isValidSessionFilePathSegment = (value: string): boolean => {
  return SESSION_FILE_PATH_SEGMENT_PATTERN.test(value);
};

const trimTrailingSlash = (url: string): string => {
  if (!url.endsWith('/')) {
    return url;
  }
  return url.slice(0, -1);
};

const workspaceBasePath = (workspaceId: string): string => {
  return `${WORKSPACE_API_PATH_PREFIX}/${encodeURIComponent(workspaceId)}/${SESSION_FILE_OBJECT_PREFIX}`;
};

/**
 * True if a file of `sizeBytes` should use the single-shot upload endpoint
 * (i.e. it fits in a single part). Larger files MUST use multipart upload.
 */
export const shouldUseSingleShotUpload = (sizeBytes: number): boolean => {
  return sizeBytes <= SESSION_FILE_PART_SIZE_BYTES;
};

/** Number of multipart parts required for a file of `sizeBytes`. */
export const getSessionFilePartCount = (sizeBytes: number): number => {
  if (sizeBytes <= 0) {
    return 0;
  }
  return Math.ceil(sizeBytes / SESSION_FILE_PART_SIZE_BYTES);
};

/**
 * Upload metadata travels in these `x-*` headers (fileName percent-encoded
 * UTF-8) alongside a raw-bytes body, so the server can stream the body
 * straight into R2. Single source for every uploading client (web, CLI); the
 * server decodes the same names in its metadata parser.
 */
export const buildSessionFileUploadMetadataHeaders = (args: {
  sessionId: string;
  fileName: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  textPreview: boolean;
}): Record<string, string> => ({
  'x-session-id': args.sessionId,
  'x-file-name': encodeURIComponent(args.fileName),
  'x-file-mime-type': args.mimeType || 'application/octet-stream',
  'x-file-sha256': args.sha256,
  'x-file-size-bytes': String(args.sizeBytes),
  'x-file-text-preview': String(args.textPreview),
});

// --- Single-shot upload -----------------------------------------------------

export const getSessionFileUploadApiPath = (workspaceId: string): string => {
  return `${workspaceBasePath(workspaceId)}/upload`;
};

// --- Multipart upload -------------------------------------------------------

export const getSessionFileMultipartCreateApiPath = (workspaceId: string): string => {
  return `${workspaceBasePath(workspaceId)}/multipart/create`;
};

export const getSessionFileMultipartPartApiPath = (
  workspaceId: string,
  uploadId: string,
  partNumber: number
): string => {
  return `${workspaceBasePath(workspaceId)}/multipart/${encodeURIComponent(
    uploadId
  )}/part/${encodeURIComponent(String(partNumber))}`;
};

export const getSessionFileMultipartCompleteApiPath = (
  workspaceId: string,
  uploadId: string
): string => {
  return `${workspaceBasePath(workspaceId)}/multipart/${encodeURIComponent(uploadId)}/complete`;
};

export const getSessionFileMultipartAbortApiPath = (
  workspaceId: string,
  uploadId: string
): string => {
  return `${workspaceBasePath(workspaceId)}/multipart/${encodeURIComponent(uploadId)}`;
};

// --- Download & preview -----------------------------------------------------

export const getSessionFileDownloadApiPath = (
  workspaceId: string,
  sessionId: string,
  fileId: string
): string => {
  return `${workspaceBasePath(workspaceId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(
    fileId
  )}`;
};

export const getSessionFilePreviewApiPath = (
  workspaceId: string,
  sessionId: string,
  fileId: string
): string => {
  return `${workspaceBasePath(workspaceId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(
    fileId
  )}/preview`;
};

export const buildSessionFileApiUrl = (apiBaseUrl: string, apiPath: string): string => {
  return `${trimTrailingSlash(apiBaseUrl)}${apiPath}`;
};

/** Relay-store object key for a file's bytes. Mirrors the image key layout. */
export const buildSessionFileObjectKey = (
  workspaceId: string,
  sessionId: string,
  fileId: string
): string => {
  return `${SESSION_FILE_OBJECT_PREFIX}/${workspaceId}/${sessionId}/${fileId}`;
};
