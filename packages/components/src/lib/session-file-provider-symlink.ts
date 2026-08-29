import { resolveCodeCollabSymlinkTarget } from '@lody/shared';
import type { SessionFileProvider } from './session-file-provider';

export type SessionFileProviderOpenPathResolution =
  | {
      readonly path: string;
      readonly redirected: false;
      readonly fileId?: string;
      readonly reason?: 'dangling' | 'external' | 'cycle' | 'not-symlink';
    }
  | {
      readonly path: string;
      readonly redirected: true;
      readonly from: string;
      readonly fileId?: string;
    };

export async function resolveSessionFileProviderOpenPath(
  provider: SessionFileProvider | null | undefined,
  path: string
): Promise<SessionFileProviderOpenPathResolution> {
  if (!provider) {
    return { path, redirected: false };
  }

  const entry = await provider.getFile(path);
  if (!entry || entry.kind !== 'symlink') {
    return {
      path,
      redirected: false,
      ...(entry?.fileId === undefined ? {} : { fileId: entry.fileId }),
    };
  }

  const files = await provider.listFiles();
  const entriesByPath = new Map(
    files.map((file) => [
      file.path,
      {
        path: file.path,
        kind: file.kind,
        ...(file.fileId === undefined ? {} : { fileId: file.fileId }),
        ...(file.linkTarget === undefined ? {} : { linkTarget: file.linkTarget }),
      },
    ])
  );
  const resolution = resolveCodeCollabSymlinkTarget(entry.path, entriesByPath);

  if (resolution.kind === 'resolved') {
    const targetEntry = entriesByPath.get(resolution.path);
    return {
      path: resolution.path,
      redirected: true,
      from: entry.path,
      ...(targetEntry?.fileId === undefined ? {} : { fileId: targetEntry.fileId }),
    };
  }

  return {
    path: entry.path,
    redirected: false,
    reason: resolution.kind,
  };
}
