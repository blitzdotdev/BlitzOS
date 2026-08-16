import type { FolderObjectView, FolderRole, FolderView } from '../file-library-api';

export interface DriveScopes {
  mine: FolderView[];
  shared: FolderView[];
}

/** Google Drive semantics: My Drive holds only what you own; everything else
 * you can access lives exclusively under Shared with me. Inaccessible org
 * folders (role null) appear in neither location. */
export function splitFolders(folders: FolderView[]): DriveScopes {
  const mine: FolderView[] = [];
  const shared: FolderView[] = [];
  for (const folder of folders) {
    if (folder.role === 'owner') mine.push(folder);
    else if (folder.role !== null) shared.push(folder);
  }
  return { mine, shared };
}

export function canManageFolder(role: FolderRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

export function canWriteFolder(role: FolderRole | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

export interface DriveDirEntry {
  name: string;
  fileCount: number;
}

export interface DriveFileEntry {
  name: string;
  key: string;
  size: number;
  mtime: number;
  editedBy: string;
}

export interface DriveEntries {
  dirs: DriveDirEntry[];
  files: DriveFileEntry[];
}

/** Folder objects are flat keys; the browse view derives one directory level
 * at a time from the keys under the current path, directories first. */
export function entriesAt(objects: FolderObjectView[], path: string[]): DriveEntries {
  const prefix = path.length === 0 ? '' : `${path.join('/')}/`;
  const dirs = new Map<string, number>();
  const files: DriveFileEntry[] = [];
  for (const object of objects) {
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({
        name: rest,
        key: object.key,
        size: object.size,
        mtime: object.mtime,
        editedBy: object.editedBy,
      });
    } else {
      const dir = rest.slice(0, slash);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  const compare = (left: string, right: string) =>
    left.toLowerCase() < right.toLowerCase() ? -1 : 1;
  return {
    dirs: [...dirs.entries()]
      .map(([name, fileCount]) => ({ name, fileCount }))
      .sort((a, b) => compare(a.name, b.name)),
    files: files.sort((a, b) => compare(a.name, b.name)),
  };
}

/** The mockup's folder-name normalization: lowercase slug safe for the
 * /workspace/shared/<name> materialization path. */
export function normalizeFolderName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}

export function formatWhen(mtime: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - mtime) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)} hr ago`;
  if (minutes < 2_880) return 'Yesterday';
  if (minutes < 10_080) return `${Math.round(minutes / 1_440)} days ago`;
  return new Date(mtime).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function personInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || 'M';
}
