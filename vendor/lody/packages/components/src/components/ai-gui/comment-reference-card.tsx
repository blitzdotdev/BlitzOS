'use client';

import type { CommentReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/components/icons/file-icons';

interface CommentReferenceCardProps {
  reference: CommentReferencePayload;
  onClick?: () => void;
  className?: string;
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

/**
 * Compact card shown in user chat bubbles for comment references.
 * Displays file path, line number, and a truncated comment preview.
 * Clicking navigates to the corresponding diff position.
 */
export function CommentReferenceCard({ reference, onClick, className }: CommentReferenceCardProps) {
  const fileName = getFileNameFromPath(reference.path);
  const preview = truncateCommentBody(reference.commentBody, 60);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full max-w-sm flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-xs',
        'bg-muted/40 transition-colors hover:bg-muted/70',
        onClick && 'cursor-pointer',
        !onClick && 'cursor-default',
        className
      )}
      title={reference.commentBody}
    >
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <FileIcon filePath={reference.path} className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {fileName}:{reference.lineNumber}
        </span>
      </div>
      <div className="truncate text-foreground/70">&ldquo;{preview}&rdquo;</div>
    </button>
  );
}
