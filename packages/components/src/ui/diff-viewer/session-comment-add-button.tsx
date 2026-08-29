'use client';

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SessionCommentAddButtonProps {
  onClick: () => void;
  className?: string;
}

/**
 * The "+" button shown when hovering over a commentable line in the diff viewer.
 * Positioned in the gutter area, similar to GitHub's review button.
 */
export function SessionCommentAddButton({ onClick, className }: SessionCommentAddButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-sm',
        'bg-primary text-primary-foreground shadow-xs',
        'hover:bg-primary/90 active:scale-95',
        'transition-all duration-100',
        'touch-action-manipulation',
        className
      )}
      aria-label="Add comment"
    >
      <Plus className="h-3 w-3" />
    </button>
  );
}
