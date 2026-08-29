import { SESSION_IMAGE_ALLOWED_EXTENSIONS, SESSION_IMAGE_ALLOWED_MIME_TYPES } from './ai';
import { WORKSPACE_API_PATH_PREFIX } from './session-image';

/**
 * User / workspace avatars are stored in R2 and served publicly by an opaque
 * UUID id (like `avatars.githubusercontent.com`). Uploads are authenticated by
 * the caller's workspace bearer token; reads are unauthenticated because an
 * avatar is low-sensitivity and shown across workspaces.
 */

// Avatars accept the same image formats as chat session images.
export const AVATAR_ALLOWED_MIME_TYPES = SESSION_IMAGE_ALLOWED_MIME_TYPES;
export const AVATAR_ALLOWED_EXTENSIONS = SESSION_IMAGE_ALLOWED_EXTENSIONS;
// Avatars are small; cap uploads at 1MB.
export const AVATAR_MAX_SIZE_BYTES = 1 * 1024 * 1024;

export const AVATAR_UPLOAD_API_PATH = '/avatars/upload';
export const AVATAR_OBJECT_PREFIX = 'avatars';
export const AVATAR_DOWNLOAD_API_PREFIX = '/api/avatars';
// Public read: the id is unguessable, so we can cache aggressively + publicly.
export const AVATAR_DOWNLOAD_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const AVATAR_KINDS = ['user', 'workspace'] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

export const isAvatarKind = (value: string): value is AvatarKind => {
  return (AVATAR_KINDS as readonly string[]).includes(value);
};

const AVATAR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const isValidAvatarId = (value: string): boolean => AVATAR_ID_PATTERN.test(value);

const AVATAR_DOWNLOAD_PATH_REGEX = /^\/api\/avatars\/([^/]+)$/;

export const getAvatarUploadApiPath = (workspaceId: string): string => {
  return `${WORKSPACE_API_PATH_PREFIX}/${encodeURIComponent(workspaceId)}${AVATAR_UPLOAD_API_PATH}`;
};

export const getAvatarDownloadApiPath = (avatarId: string): string => {
  return `${AVATAR_DOWNLOAD_API_PREFIX}/${encodeURIComponent(avatarId)}`;
};

export const buildAvatarObjectKey = (avatarId: string): string => {
  return `${AVATAR_OBJECT_PREFIX}/${avatarId}`;
};

export const parseAvatarDownloadPath = (
  pathname: string
): { kind: 'none' } | { kind: 'invalid' } | { kind: 'matched'; avatarId: string } => {
  const match = pathname.match(AVATAR_DOWNLOAD_PATH_REGEX);
  if (!match) {
    return { kind: 'none' };
  }

  try {
    const avatarId = decodeURIComponent(match[1] ?? '');
    if (!isValidAvatarId(avatarId)) {
      return { kind: 'invalid' };
    }
    return { kind: 'matched', avatarId };
  } catch {
    return { kind: 'invalid' };
  }
};

export const isAvatarUploadApiPath = (urlPathName: string): boolean => {
  return urlPathName === AVATAR_UPLOAD_API_PATH;
};
