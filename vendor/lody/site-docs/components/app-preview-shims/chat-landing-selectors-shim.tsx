'use client';

import type { ReactNode } from 'react';
import {
  Compass,
  Eye,
  GitBranch,
  Loader2,
  PenLine,
  ShieldCheck,
  ShieldOff,
  Unlock,
} from 'lucide-react';
import { OptionSelector } from '@/components/shared/option-selector';
import { cn } from '@/lib/utils';

type ChatLandingTone = 'light' | 'dark';

const modeIconClassName = 'h-3.5 w-3.5';

export const getModeIcon = (modeId: string | null): ReactNode => {
  switch (modeId) {
    case 'plan':
      return <Compass className={modeIconClassName} />;
    case 'acceptEdits':
      return <PenLine className={modeIconClassName} />;
    case 'dontAsk':
      return <ShieldOff className={modeIconClassName} />;
    case 'bypassPermissions':
    case 'full-access':
    case 'yolo':
    case 'YOLO':
      return <Unlock className={modeIconClassName} />;
    case 'read-only':
      return <Eye className={modeIconClassName} />;
    default:
      return <ShieldCheck className={modeIconClassName} />;
  }
};

export const getSelectorTagClassName = (_tone: ChatLandingTone): string =>
  [
    'w-auto h-6 px-2 gap-1 rounded-[4px] [&_span]:text-xs [&_span]:leading-tight',
    'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  ].join(' ');

export const getCompactSelectorTagClassName = (_tone: ChatLandingTone): string =>
  [
    'w-auto h-6 px-2 gap-1 rounded-[4px] border [&_span]:text-xs [&_span]:leading-tight',
    'border-input-border/70 bg-input/80 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  ].join(' ');

// ---- BranchSelector: VERBATIM copy of the real one --------------------------
// The real module can't bundle in Next (its other exports pull Vite-only deps),
// but BranchSelector itself is a thin OptionSelector wrapper. Keep this in sync
// with packages/components/src/components/chat/chat-landing-selectors.tsx.

type BranchOption = { value: string; label: string; description?: string };

export interface BranchSelectorProps {
  value: string | null;
  onChange: (value: string) => void;
  options: BranchOption[];
  tone: ChatLandingTone;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingText?: string;
  className?: string;
  contentClassName?: string;
}

export function BranchSelector({
  value,
  onChange,
  options,
  tone,
  placeholder = 'Branch',
  searchPlaceholder,
  emptyText,
  disabled = false,
  loading = false,
  loadingText = 'Loading branches...',
  className,
  contentClassName,
}: BranchSelectorProps) {
  return (
    <OptionSelector
      value={value}
      onSelect={(option) => onChange(option.value)}
      options={options}
      placeholder={placeholder}
      disabled={disabled || loading || options.length === 0}
      align="start"
      tone={tone}
      placeholderIcon={GitBranch}
      searchable={!loading && options.length > 6}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      className={cn('h-6 gap-1 rounded-md border-none bg-transparent px-1', className)}
      contentClassName={cn(
        'min-w-[16rem] max-w-[min(36rem,calc(100vw-2rem))] p-1',
        contentClassName
      )}
      renderTriggerValue={(option) => (
        <>
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin opacity-70" />
          ) : (
            <GitBranch className="h-4 w-4 shrink-0 opacity-70" />
          )}
          <span className="truncate font-medium">
            {loading ? loadingText : (option?.label ?? placeholder ?? '')}
          </span>
        </>
      )}
      renderOption={(option) => (
        <>
          <GitBranch className="h-4 w-4 shrink-0 opacity-70" />
          <div className="flex min-w-0 flex-col">
            <span className="whitespace-normal break-words leading-snug">{option.label}</span>
            {option.description && (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {option.description}
              </span>
            )}
          </div>
        </>
      )}
    />
  );
}
