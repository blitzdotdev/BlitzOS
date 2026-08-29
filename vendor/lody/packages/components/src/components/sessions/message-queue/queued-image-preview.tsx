import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionId, SessionInputBlock, WorkspaceId } from '@lody/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { currentWorkspaceIdAtom } from '@/atoms';
import { authTokenAtom } from '@/atoms/runtime';
import { getSessionImageBlobUrl } from '@/lib/session-image-cache';
import { cn } from '@/lib/utils';

export type QueuedImageBlock = Extract<SessionInputBlock, { type: 'image' }>;

export function QueuedImagePreview({
  sessionId,
  image,
  size = 20,
  className,
}: {
  sessionId: SessionId;
  image: QueuedImageBlock;
  size?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const authToken = useAtomValue(authTokenAtom);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const label = image.fileName || t('sessions.uploadedImage', 'Uploaded image');

  useEffect(() => {
    let active = true;
    setThumbnailUrl(null);
    setLoadFailed(false);

    if (!workspaceId || !authToken) {
      setLoadFailed(true);
      return () => {
        active = false;
      };
    }

    void getSessionImageBlobUrl({
      workspaceId,
      sessionId,
      imageId: image.imageId,
      token: authToken,
      variant: 'thumbnail',
      thumbnailWidth: size * 2,
      thumbnailHeight: size * 2,
      thumbnailFit: 'cover',
      thumbnailQuality: 80,
    })
      .then((url) => {
        if (active) {
          setThumbnailUrl(url);
        }
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true);
        }
      });

    return () => {
      active = false;
    };
  }, [authToken, image.imageId, sessionId, workspaceId, size]);

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'flex shrink-0 items-center justify-center overflow-hidden rounded',
            'border border-border/40 bg-background/60',
            className
          )}
          style={{ width: size, height: size }}
          role="img"
          aria-label={label}
        >
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt={label} className="h-full w-full object-cover" />
          ) : loadFailed ? (
            <ImageIcon
              className="text-muted-foreground"
              style={{ width: size * 0.5, height: size * 0.5 }}
            />
          ) : (
            <div className="h-full w-full animate-pulse bg-muted/70" />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
