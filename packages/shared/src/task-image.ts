import {
  SESSION_IMAGE_ALLOWED_EXTENSIONS,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES,
} from './ai';

export {
  SESSION_IMAGE_ALLOWED_EXTENSIONS as TASK_IMAGE_ALLOWED_EXTENSIONS,
  SESSION_IMAGE_ALLOWED_MIME_TYPES as TASK_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_COUNT as TASK_IMAGE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES as TASK_IMAGE_MAX_SIZE_BYTES,
};

export const TASK_IMAGE_UPLOAD_API_PATH = '/task-images/upload';
export const TASK_IMAGE_OBJECT_PREFIX = 'task-images';
export const TASK_IMAGE_MARKDOWN_PROTOCOL = 'lody-image://';
export const TASK_IMAGE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const TASK_IMAGE_DOWNLOAD_CACHE_CONTROL = 'private, max-age=31536000, immutable';

export type TaskImagePayload = {
  imageId: string;
  mimeType: string;
  fileName?: string;
  sizeBytes: number;
};

const trimTrailingSlash = (url: string): string => (url.endsWith('/') ? url.slice(0, -1) : url);

export const isValidTaskImagePathSegment = (value: string): boolean =>
  TASK_IMAGE_PATH_SEGMENT_PATTERN.test(value);

export const getTaskImageUploadApiPath = (workspaceId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}${TASK_IMAGE_UPLOAD_API_PATH}`;

export const getTaskImageDownloadApiPath = (workspaceId: string, imageId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/task-images/${encodeURIComponent(imageId)}`;

export const buildTaskImageApiUrl = (apiBaseUrl: string, apiPath: string): string =>
  `${trimTrailingSlash(apiBaseUrl)}${apiPath}`;

export const buildTaskImageObjectKey = (workspaceId: string, imageId: string): string =>
  `${TASK_IMAGE_OBJECT_PREFIX}/${workspaceId}/${imageId}`;

export const buildTaskImageMarkdownUrl = (imageId: string): string =>
  `${TASK_IMAGE_MARKDOWN_PROTOCOL}${imageId}`;

export const parseTaskImageMarkdownUrl = (value: string): string | null => {
  if (!value.startsWith(TASK_IMAGE_MARKDOWN_PROTOCOL)) return null;
  const imageId = value.slice(TASK_IMAGE_MARKDOWN_PROTOCOL.length);
  return isValidTaskImagePathSegment(imageId) ? imageId : null;
};

export const extractTaskImageIdsFromMarkdown = (markdown: string): string[] => {
  const ids = new Set<string>();
  const pattern = /lody-image:\/\/([A-Za-z0-9_-]{1,128})/gu;
  for (const match of markdown.matchAll(pattern)) {
    const imageId = match[1];
    if (imageId) ids.add(imageId);
  }
  return [...ids];
};
