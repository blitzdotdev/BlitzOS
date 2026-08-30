import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { VisualAnnotationDraftComposer } from '@/components/preview/visual-annotation-draft-composer';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';
import { TOUR_ANNOTATION_ANCHOR } from './tour-fixtures';

// The page is necessarily a fixture: onboarding has no dev server for the real
// Managed Preview iframe to load. The annotation UI around it is production UI,
// driven by scripted data just like the rest of the tour.

const COMMENT_ID = 'onboarding-tour-comment';
const TARGET_LABEL = 'div "Nothing here yet"';
const EMPTY_VIEWPORT = { width: 0, height: 0 };
const ignore = () => undefined;

export function TourBrowserPreview({
  /**
   * The beat's progress, 0 -> 1, in four readable stages:
   *
   *   0.00-0.15  nothing yet
   *   0.15-0.35  the element has been clicked; the composer opens on it
   *   0.35-0.80  the comment types itself
   *   0.80-1.00  the comment is staged in chat and shown on the page
   */
  annotation,
  commentBody,
}: {
  annotation: number;
  commentBody: string;
}): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(EMPTY_VIEWPORT);
  const clicked = annotation > 0.15;
  const submitted = annotation >= 0.8;
  const typed = commentBody.slice(
    0,
    Math.round(commentBody.length * clamp01((annotation - 0.35) / 0.45))
  );
  const stagedComment = useMemo<PreviewVisualComment>(
    () => ({
      id: COMMENT_ID,
      turnId: 'onboarding-tour-turn',
      status: 'completed',
      body: commentBody,
      anchor: TOUR_ANNOTATION_ANCHOR,
      authorId: 'onboarding-tour-user',
      authorName: 'You',
      createdAt: 1,
      updatedAt: 1,
    }),
    [commentBody]
  );

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;

    const updateViewport = () => {
      const rect = preview.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next
      );
    };

    updateViewport();
    return observeResizeOnAnimationFrame(preview, updateViewport);
  }, []);

  return (
    <div data-tour-anchor="browser" className="flex h-full flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/50 px-2.5">
        <span className="size-1.5 rounded-full bg-code-added" />
        <span className="truncate rounded bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
          localhost:5173/settings
        </span>
      </div>

      <div ref={previewRef} className="relative min-h-0 flex-1 overflow-hidden p-4">
        <div className="space-y-3">
          <div className="h-3 w-24 rounded bg-muted-foreground/25" />
          <div className="h-2 w-40 rounded bg-muted-foreground/15" />
          <div className="mt-5 space-y-2 rounded-lg border border-border/60 p-3">
            <div className="h-2.5 w-20 rounded bg-muted-foreground/20" />
            <div className="h-2 w-full rounded bg-muted-foreground/10" />
            <div className="h-2 w-2/3 rounded bg-muted-foreground/10" />
          </div>

          <div
            data-tour-anchor="browser.target"
            className={cn(
              'relative mt-4 flex h-20 items-center justify-center rounded-lg border border-dashed transition-colors duration-300',
              clicked
                ? 'border-primary/70 bg-primary/10'
                : 'border-border/70 text-muted-foreground/50'
            )}
          >
            <span className="text-[11px]">Nothing here yet</span>
          </div>
        </div>

        {clicked && !submitted ? (
          <VisualAnnotationDraftComposer
            targetLabel={TARGET_LABEL}
            value={typed}
            onChange={ignore}
            onCancel={ignore}
            onSubmit={ignore}
            className="absolute bottom-[18px] left-5 z-30 w-[calc(100%-40px)] max-w-none"
          />
        ) : null}
        {submitted ? (
          <VisualAnnotationCommentsOverlay
            comments={[stagedComment]}
            viewport={viewport}
            activeCommentId={COMMENT_ID}
            stagedCommentIds={[COMMENT_ID]}
            onSendToChat={ignore}
          />
        ) : null}
      </div>
    </div>
  );
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}
