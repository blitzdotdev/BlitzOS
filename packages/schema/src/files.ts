/**
 * Thirty-two MiB stays above R2's five MiB multipart minimum while remaining
 * well below Cloudflare's smallest current inbound request limit (100 MB).
 */
export const FILES_MULTIPART_CHUNK_BYTES = 32 * 1024 * 1024;

export type FolderRole = "owner" | "admin" | "editor" | "viewer";

export interface FolderGrantView {
  id: string;
  membershipId: string;
  role: "editor" | "viewer";
  createdAt: number;
  member: { name: string; email: string; avatarUrl: string | null };
}

export interface FolderView {
  id: string;
  name: string;
  role: FolderRole | null;
  owner: { name: string; avatarUrl: string | null };
  attachedWorkspaceIds: string[];
  createdAt: number;
  updatedAt: number;
  grants?: FolderGrantView[];
}

export interface FolderObjectView {
  key: string;
  size: number;
  mtime: number;
  editedBy: string;
}

export interface ListFolderObjectsResponse {
  objects: FolderObjectView[];
  cursor: string | null;
  truncated: boolean;
}

export interface FolderAttachmentView {
  id: string;
  name: string;
  role: FolderRole;
  guestPath: string | null;
  attachedAt: number;
}

export interface ListFolderAttachmentsResponse {
  folders: FolderAttachmentView[];
}
