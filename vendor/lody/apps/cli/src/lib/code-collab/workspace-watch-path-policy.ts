import path from 'node:path';

export const CODE_COLLAB_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
]);

export function shouldIgnoreWorkspaceWatchFilename(filename: string): boolean {
  return filename
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .some((segment) => CODE_COLLAB_IGNORED_DIRECTORY_NAMES.has(segment));
}

export function normalizeWorkspaceWatchFilename(filename: string | Buffer): string | null {
  const value = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
  if (!value || value.includes('\0') || path.isAbsolute(value)) {
    return null;
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}
