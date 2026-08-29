'use client';

import type { VisualAnnotationReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import { MousePointer2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type VisualAnnotationReferenceCardProps = {
  reference: VisualAnnotationReferencePayload;
  onClick?: () => void;
  className?: string;
};

const getPageLabel = (reference: VisualAnnotationReferencePayload): string => {
  const pathname = reference.anchor.page.pathname.trim();
  if (pathname) {
    return pathname;
  }
  return reference.anchor.page.url;
};

export function VisualAnnotationReferenceCard({
  reference,
  onClick,
  className,
}: VisualAnnotationReferenceCardProps) {
  const target = reference.anchor.target;
  const preview = truncateCommentBody(reference.body, 72);
  const targetText = target.text ? truncateCommentBody(target.text, 72) : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full max-w-sm flex-col gap-1 rounded-lg border px-3 py-2 text-left text-xs',
        'bg-muted/40 transition-colors hover:bg-muted/70',
        onClick ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      title={reference.body}
    >
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <MousePointer2 className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {getPageLabel(reference)} · {target.tag.toLowerCase()}
        </span>
      </div>
      <div className="truncate text-foreground/75">&ldquo;{preview}&rdquo;</div>
      {targetText ? (
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {target.selector} · {targetText}
        </div>
      ) : (
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {target.selector}
        </div>
      )}
    </button>
  );
}
