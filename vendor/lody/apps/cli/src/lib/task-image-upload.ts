import fs from 'fs';
import path from 'path';
import {
  buildTaskImageApiUrl,
  buildTaskImageMarkdownUrl,
  getTaskImageUploadApiPath,
  TASK_IMAGE_MAX_SIZE_BYTES,
  type TaskImagePayload,
  type WorkspaceId,
} from '@lody/shared';
import { LODY_SERVER_URL } from '@/utils/const';

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

type UploadableTaskImage = {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
};

const readTaskImage = async (filePath: string): Promise<UploadableTaskImage> => {
  const absolutePath = path.resolve(filePath);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      code === 'ELOOP'
        ? `Image path must not be a symlink: ${filePath}`
        : `Image file not found: ${filePath}`,
      { cause: error }
    );
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Image path is not a file: ${filePath}`);
    if (stat.size <= 0) throw new Error(`Image is empty: ${filePath}`);
    if (stat.size > TASK_IMAGE_MAX_SIZE_BYTES) {
      throw new Error(
        `Image must be <= ${Math.floor(TASK_IMAGE_MAX_SIZE_BYTES / (1024 * 1024))}MB: ${filePath}`
      );
    }

    const fileName = path.basename(absolutePath);
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const mimeType = MIME_TYPE_BY_EXTENSION[extension];
    if (!mimeType) throw new Error(`Unsupported image file extension: ${fileName}`);
    return { fileName, mimeType, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
};

export const uploadTaskImages = async (args: {
  paths: readonly string[];
  workspaceId: WorkspaceId;
  token: string;
}): Promise<Array<TaskImagePayload & { markdownUrl: string }>> => {
  const serverUrl = LODY_SERVER_URL?.trim();
  if (!serverUrl) throw new Error('LODY_SERVER_URL is not defined');
  const uploadUrl = buildTaskImageApiUrl(serverUrl, getTaskImageUploadApiPath(args.workspaceId));

  const results: Array<TaskImagePayload & { markdownUrl: string }> = [];
  for (const filePath of args.paths) {
    const file = await readTaskImage(filePath);
    const bytes = new Uint8Array(file.bytes.byteLength);
    bytes.set(file.bytes);
    const formData = new FormData();
    formData.set('file', new Blob([bytes], { type: file.mimeType }), file.fileName);
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.token}` },
      body: formData,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Failed to upload task image (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }
    const body = await response.json().catch(() => null);
    const image =
      body && typeof body === 'object' && 'image' in body
        ? (body as { image?: unknown }).image
        : undefined;
    if (
      !image ||
      typeof image !== 'object' ||
      typeof (image as TaskImagePayload).imageId !== 'string' ||
      typeof (image as TaskImagePayload).mimeType !== 'string' ||
      typeof (image as TaskImagePayload).sizeBytes !== 'number'
    ) {
      throw new Error('Invalid task image upload payload');
    }
    const payload = image as TaskImagePayload;
    results.push({
      ...payload,
      markdownUrl: buildTaskImageMarkdownUrl(payload.imageId),
    });
  }
  return results;
};
