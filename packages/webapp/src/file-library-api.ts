import {
  FILES_MULTIPART_CHUNK_BYTES,
  type FolderGrantView,
  type FolderObjectView,
  type FolderRole,
  type FolderView,
  type ListFolderObjectsResponse,
} from '@blitzos/schema';
import {
  asJsonObject,
  isBoolean,
  isNumber,
  isString,
  type JsonValue,
} from './type-guards';

export type { FolderGrantView, FolderObjectView, FolderRole, FolderView };

export interface FileLibraryClient {
  listFolders(): Promise<{ folders: FolderView[] }>;
  createFolder(name: string): Promise<{ folder: FolderView }>;
  deleteFolder(folderId: string): Promise<void>;
  createFolderGrant(
    folderId: string,
    membershipId: string,
    role: 'editor' | 'viewer',
  ): Promise<{ grant: FolderGrantView }>;
  revokeFolderGrant(folderId: string, grantId: string): Promise<void>;
  listFolderObjects(folderId: string): Promise<ListFolderObjectsResponse>;
  downloadFolderObject(folderId: string, key: string): Promise<Blob>;
  uploadFolderObject(folderId: string, key: string, file: File): Promise<void>;
}

export type RawControlPlaneRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

function jsonObject(response: Response, label: string): Promise<JsonValue> {
  return response.json().catch(() => { throw new Error(`${label} returned invalid JSON`); });
}

function member(value: JsonValue, label: string): FolderGrantView['member'] {
  const object = asJsonObject(value);
  if (
    object === null
    || !isString(object.name)
    || !isString(object.email)
    || !(object.avatarUrl === null || isString(object.avatarUrl))
  ) throw new Error(`${label} returned an invalid member`);
  return { name: object.name, email: object.email, avatarUrl: object.avatarUrl };
}

function grant(value: JsonValue, label: string): FolderGrantView {
  const object = asJsonObject(value);
  if (
    object === null
    || !isString(object.id)
    || !isString(object.membershipId)
    || (object.role !== 'editor' && object.role !== 'viewer')
    || !isNumber(object.createdAt)
  ) throw new Error(`${label} returned an invalid grant`);
  return {
    id: object.id,
    membershipId: object.membershipId,
    role: object.role,
    createdAt: object.createdAt,
    member: member(object.member ?? null, label),
  };
}

function folder(value: JsonValue, label: string): FolderView {
  const object = asJsonObject(value);
  const role = object?.role;
  if (
    object === null
    || !isString(object.id)
    || !isString(object.name)
    || (role !== 'owner' && role !== 'admin' && role !== 'editor' && role !== 'viewer')
    || !isNumber(object.version)
    || !Number.isSafeInteger(object.version)
    || !isNumber(object.createdAt)
    || !isNumber(object.updatedAt)
    || !Array.isArray(object.grants)
  ) throw new Error(`${label} returned an invalid folder`);
  return {
    id: object.id,
    name: object.name,
    role,
    version: object.version,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    grants: object.grants.map((item) => grant(item, label)),
  };
}

function folderObject(value: JsonValue): FolderObjectView {
  const object = asJsonObject(value);
  if (
    object === null
    || !isString(object.key)
    || !isNumber(object.size)
    || !Number.isSafeInteger(object.size)
    || !isNumber(object.mtime)
    || !Number.isSafeInteger(object.mtime)
    || !isString(object.editedBy)
  ) throw new Error('folder objects returned an invalid object');
  return {
    key: object.key,
    size: object.size,
    mtime: object.mtime,
    editedBy: object.editedBy,
  };
}

function encodedObjectPath(folderId: string, key: string): string {
  return `/folders/${encodeURIComponent(folderId)}/objects/${encodeURIComponent(key)}`;
}

async function allObjects(
  rawRequest: RawControlPlaneRequest,
  folderId: string,
): Promise<ListFolderObjectsResponse> {
  const objects: FolderObjectView[] = [];
  let cursor: string | null = null;
  do {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const value = await jsonObject(
      await rawRequest(`/folders/${encodeURIComponent(folderId)}/objects${query}`),
      'folder objects',
    );
    const object = asJsonObject(value);
    if (
      object === null
      || !Array.isArray(object.objects)
      || !isBoolean(object.truncated)
      || !(object.cursor === null || isString(object.cursor))
    ) throw new Error('folder objects returned an invalid list');
    objects.push(...object.objects.map(folderObject));
    cursor = object.truncated ? object.cursor : null;
    if (object.truncated && cursor === null) {
      throw new Error('folder objects omitted its continuation cursor');
    }
  } while (cursor !== null);
  return { objects, cursor: null, truncated: false };
}

export function createFileLibraryClient(
  rawRequest: RawControlPlaneRequest,
): FileLibraryClient {
  return {
    async listFolders() {
      const value = await jsonObject(await rawRequest('/folders'), 'folders');
      const object = asJsonObject(value);
      if (object === null || !Array.isArray(object.folders)) {
        throw new Error('folders returned an invalid list');
      }
      return { folders: object.folders.map((item) => folder(item, 'folders')) };
    },
    async createFolder(name) {
      const value = await jsonObject(await rawRequest('/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }), 'create folder');
      const object = asJsonObject(value);
      return { folder: folder(object?.folder ?? null, 'create folder') };
    },
    deleteFolder: (folderId) => rawRequest(`/folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE',
    }).then(() => undefined),
    async createFolderGrant(folderId, membershipId, role) {
      const value = await jsonObject(await rawRequest(
        `/folders/${encodeURIComponent(folderId)}/grants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ membershipId, role }),
        },
      ), 'create folder grant');
      const object = asJsonObject(value);
      return { grant: grant(object?.grant ?? null, 'create folder grant') };
    },
    revokeFolderGrant: (folderId, grantId) => rawRequest(
      `/folders/${encodeURIComponent(folderId)}/grants/${encodeURIComponent(grantId)}`,
      { method: 'DELETE' },
    ).then(() => undefined),
    listFolderObjects: (folderId) => allObjects(rawRequest, folderId),
    downloadFolderObject: (folderId, key) => rawRequest(
      encodedObjectPath(folderId, key),
    ).then((response) => response.blob()),
    async uploadFolderObject(folderId, key, file) {
      const path = encodedObjectPath(folderId, key);
      if (file.size <= FILES_MULTIPART_CHUNK_BYTES) {
        await rawRequest(path, {
          method: 'PUT',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-blitz-mtime': String(file.lastModified),
          },
          body: file,
        });
        return;
      }
      const createdValue = await jsonObject(await rawRequest(`${path}/multipart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mtime: file.lastModified }),
      }), 'multipart create');
      const created = asJsonObject(createdValue);
      if (created === null || !isString(created.uploadId)) {
        throw new Error('multipart create returned an invalid upload ID');
      }
      const uploadId = created.uploadId;
      const partCount = Math.ceil(file.size / FILES_MULTIPART_CHUNK_BYTES);
      const uploaded: Array<{ partNumber: number; etag: string }> = [];
      for (let start = 0; start < partCount; start += 3) {
        const batch = Array.from(
          { length: Math.min(3, partCount - start) },
          (_, offset) => start + offset,
        );
        const completed = await Promise.all(batch.map(async (index) => {
          const partNumber = index + 1;
          const responseValue = await jsonObject(await rawRequest(
            `${path}/multipart/${encodeURIComponent(uploadId)}/${partNumber}`,
            {
              method: 'PUT',
              body: file.slice(
                index * FILES_MULTIPART_CHUNK_BYTES,
                Math.min(file.size, (index + 1) * FILES_MULTIPART_CHUNK_BYTES),
              ),
            },
          ), 'multipart part');
          const part = asJsonObject(responseValue);
          if (
            part === null
            || part.partNumber !== partNumber
            || !isString(part.etag)
          ) throw new Error('multipart part returned invalid data');
          return { partNumber, etag: part.etag };
        }));
        uploaded.push(...completed);
      }
      uploaded.sort((left, right) => left.partNumber - right.partNumber);
      await rawRequest(`${path}/multipart/${encodeURIComponent(uploadId)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: uploaded }),
      });
    },
  };
}
