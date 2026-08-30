import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import {
  extractTaskImageIdsFromMarkdown,
  parseTaskImageMarkdownUrl,
  type WorkspaceId,
} from '@lody/shared';
import { authTokenAtom, currentWorkspaceIdAtom } from '@/atoms';
import {
  getCachedTaskImageUrl,
  getTaskImageCacheVersion,
  loadTaskImageUrl,
  subscribeTaskImageCache,
} from '@/lib/task-image-cache';

const useTaskImageCacheVersion = (): number =>
  useSyncExternalStore(subscribeTaskImageCache, getTaskImageCacheVersion, getTaskImageCacheVersion);

export const useTaskImageUrl = (markdownUrl: string | undefined): string | undefined => {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const token = useAtomValue(authTokenAtom);
  useTaskImageCacheVersion();
  const imageId = markdownUrl ? parseTaskImageMarkdownUrl(markdownUrl) : null;

  useEffect(() => {
    if (!workspaceId || !token || !imageId) return;
    void loadTaskImageUrl({ workspaceId, imageId, token }).catch(() => undefined);
  }, [imageId, token, workspaceId]);

  return workspaceId && imageId ? getCachedTaskImageUrl(workspaceId, imageId) : undefined;
};

export const useTaskImageResolver = (
  markdown: string
): { resolveImageUrl: (src: string) => string | undefined; cacheVersion: number } => {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const token = useAtomValue(authTokenAtom);
  const cacheVersion = useTaskImageCacheVersion();

  useEffect(() => {
    if (!workspaceId || !token) return;
    for (const imageId of extractTaskImageIdsFromMarkdown(markdown)) {
      void loadTaskImageUrl({ workspaceId, imageId, token }).catch(() => undefined);
    }
  }, [markdown, token, workspaceId]);

  const resolveImageUrl = useCallback(
    (src: string): string | undefined => {
      const imageId = parseTaskImageMarkdownUrl(src);
      if (imageId) {
        return workspaceId ? getCachedTaskImageUrl(workspaceId, imageId) : undefined;
      }
      return /^https?:\/\//iu.test(src) ? src : undefined;
    },
    // A new callback asks meowdown to refresh its image extension after an
    // authenticated blob finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheVersion, workspaceId]
  );

  return { resolveImageUrl, cacheVersion };
};
