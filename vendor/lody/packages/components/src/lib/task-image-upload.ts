import {
  buildTaskImageApiUrl,
  buildTaskImageMarkdownUrl,
  getTaskImageUploadApiPath,
  TASK_IMAGE_ALLOWED_EXTENSIONS,
  TASK_IMAGE_ALLOWED_MIME_TYPES,
  TASK_IMAGE_MAX_SIZE_BYTES,
  type TaskImagePayload,
  type WorkspaceId,
} from '@lody/shared';
import { API_BASE_URL } from '@/lib';
import { postMultipartWithProgress } from '@/lib/multipart-upload';
import { primeTaskImageCache } from './task-image-cache';

const allowedExtensions = new Set<string>(TASK_IMAGE_ALLOWED_EXTENSIONS);
const allowedMimeTypes = new Set<string>(TASK_IMAGE_ALLOWED_MIME_TYPES);

export const TASK_IMAGE_ACCEPT = [
  ...TASK_IMAGE_ALLOWED_MIME_TYPES,
  ...TASK_IMAGE_ALLOWED_EXTENSIONS.map((extension) => `.${extension}`),
].join(',');

const getExtension = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot < 0
    ? ''
    : fileName
        .slice(dot + 1)
        .trim()
        .toLowerCase();
};

export const validateTaskImageFile = (file: File): string | null => {
  const extension = getExtension(file.name);
  if (extension && !allowedExtensions.has(extension)) {
    return `Unsupported image extension: ${extension}`;
  }
  if (!allowedMimeTypes.has(file.type.trim().toLowerCase())) {
    return `Unsupported image type: ${file.type || 'unknown'}`;
  }
  if (file.size <= 0) return 'Image is empty';
  if (file.size > TASK_IMAGE_MAX_SIZE_BYTES) {
    return `Image must be <= ${Math.floor(TASK_IMAGE_MAX_SIZE_BYTES / (1024 * 1024))}MB`;
  }
  return null;
};

export const uploadTaskImage = async (args: {
  workspaceId: WorkspaceId;
  token: string;
  file: File;
  onProgress?: (percent: number) => void;
}): Promise<{ image: TaskImagePayload; markdownUrl: string }> => {
  const validationError = validateTaskImageFile(args.file);
  if (validationError) throw new Error(validationError);

  const formData = new FormData();
  formData.set('file', args.file, args.file.name);
  const body = await postMultipartWithProgress({
    url: buildTaskImageApiUrl(API_BASE_URL, getTaskImageUploadApiPath(args.workspaceId)),
    token: args.token,
    formData,
    onProgress: args.onProgress,
    errorLabel: 'Task image upload',
  });
  const value =
    body && typeof body === 'object' && 'image' in body
      ? (body as { image?: unknown }).image
      : undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as TaskImagePayload).imageId !== 'string' ||
    typeof (value as TaskImagePayload).mimeType !== 'string' ||
    typeof (value as TaskImagePayload).sizeBytes !== 'number'
  ) {
    throw new Error('Invalid task image upload payload');
  }

  const image = value as TaskImagePayload;
  primeTaskImageCache(args.workspaceId, image.imageId, args.file);
  return { image, markdownUrl: buildTaskImageMarkdownUrl(image.imageId) };
};
