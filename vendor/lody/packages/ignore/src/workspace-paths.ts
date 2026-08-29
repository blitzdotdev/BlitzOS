import path from 'node:path';

/**
 * Convert an absolute path to a workspace-relative POSIX path, normalized
 * to NFC. macOS readdir returns NFD; normalizing here keeps stored paths,
 * comparison keys, and event paths in agreement so a tarball's `café`
 * (NFC) and a macOS rename's `café` (NFD) don't coexist as distinct keys.
 */
export function toWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join('/').normalize('NFC');
}

/**
 * Normalize an already-relative workspace path to the same POSIX + NFC
 * form used as a map key, dropping a redundant leading `./`. This is the
 * default key normalizer for the watcher; callers with stricter rules
 * (e.g. a dedicated workspace-path validator) can inject their own.
 */
export function normalizeWorkspaceRelativePath(relativePath: string): string {
  const posix = relativePath.split(path.sep).join('/').normalize('NFC');
  return posix.startsWith('./') ? posix.slice(2) : posix;
}

export function isInsideWorkspace(workspaceRoot: string, absolutePath: string): boolean {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { readonly code?: unknown }).code === 'ENOENT' ||
      (error as { readonly code?: unknown }).code === 'ENOTDIR')
  );
}
