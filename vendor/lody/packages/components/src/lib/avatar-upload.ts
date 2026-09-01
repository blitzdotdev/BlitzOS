import {
  AVATAR_ALLOWED_EXTENSIONS,
  AVATAR_ALLOWED_MIME_TYPES,
  AVATAR_MAX_SIZE_BYTES,
  buildSessionImageApiUrl,
  getAvatarDownloadApiPath,
  getAvatarUploadApiPath,
  type AvatarKind,
  type WorkspaceId,
} from '@lody/shared';
import { API_BASE_URL } from '@/lib';
import { getFileExtension } from '@/lib/session-image-upload';
import { postMultipartWithProgress } from '@/lib/multipart-upload';

const allowedExtensionSet = new Set<string>(AVATAR_ALLOWED_EXTENSIONS);
const allowedMimeTypeSet = new Set<string>(AVATAR_ALLOWED_MIME_TYPES);

export const AVATAR_ACCEPT = [
  ...AVATAR_ALLOWED_MIME_TYPES,
  ...AVATAR_ALLOWED_EXTENSIONS.map((extension) => `.${extension}`),
].join(',');

export const validateAvatarFile = (file: File): string | null => {
  const extension = getFileExtension(file.name);
  if (extension && !allowedExtensionSet.has(extension)) {
    return `Unsupported file extension: ${file.name}`;
  }

  const mimeType = file.type.trim().toLowerCase();
  if (!allowedMimeTypeSet.has(mimeType)) {
    return `Unsupported image type: ${mimeType || 'unknown'}`;
  }

  if (file.size > AVATAR_MAX_SIZE_BYTES) {
    return `Image must be <= ${Math.floor(AVATAR_MAX_SIZE_BYTES / (1024 * 1024))}MB`;
  }

  if (file.size <= 0) {
    return 'Image is empty';
  }

  return null;
};

const buildAvatarUploadUrl = (workspaceId: WorkspaceId): string =>
  buildSessionImageApiUrl(API_BASE_URL, getAvatarUploadApiPath(workspaceId));

const buildAvatarDownloadUrl = (avatarId: string): string =>
  buildSessionImageApiUrl(API_BASE_URL, getAvatarDownloadApiPath(avatarId));

type UploadAvatarArgs = {
  workspaceId: WorkspaceId;
  kind: AvatarKind;
  token: string;
  file: File;
};

/** Upload an avatar image to R2 and return its public download URL. */
export const uploadAvatarImage = async ({
  workspaceId,
  kind,
  token,
  file,
}: UploadAvatarArgs): Promise<{ url: string }> => {
  const validationError = validateAvatarFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const formData = new FormData();
  formData.set('kind', kind);
  formData.set('file', file, file.name);

  // Avatars don't need upload progress (capped at 1MB), so onProgress is omitted.
  const responseBody = await postMultipartWithProgress({
    url: buildAvatarUploadUrl(workspaceId),
    token,
    formData,
    errorLabel: 'Avatar upload',
  });

  const avatarValue =
    responseBody && typeof responseBody === 'object' && 'avatar' in responseBody
      ? (responseBody as { avatar?: unknown }).avatar
      : undefined;

  if (
    !avatarValue ||
    typeof avatarValue !== 'object' ||
    typeof (avatarValue as { avatarId?: unknown }).avatarId !== 'string'
  ) {
    throw new Error('Invalid upload payload');
  }

  const { avatarId } = avatarValue as { avatarId: string };
  // Prefer the canonical API-base URL so the stored value stays stable even
  // if the upload happened via a different origin than the configured API.
  return { url: buildAvatarDownloadUrl(avatarId) };
};
