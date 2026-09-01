import { AtSign, Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * Full-surface drop mask for a conversation page or the chat landing.
 *
 * The zone itself lives on the parent (`useDropZone`). Session-mention drags
 * also arm this from sidebar `dragstart` so the mask is up before the pointer
 * reaches the page. `pointer-events-none` is required: a hit-testing overlay
 * would fire `dragleave` on every nested child and flicker the highlight the
 * depth counter exists to prevent.
 */
export type ConversationDropKind = 'session-mention' | 'files';

export function ConversationDropOverlay({
  active,
  kind = 'session-mention',
}: {
  active: boolean;
  kind?: ConversationDropKind;
}) {
  if (!active) return null;
  return <ConversationDropOverlayPaint kind={kind} />;
}

function ConversationDropOverlayPaint({ kind }: { kind: ConversationDropKind }) {
  const { t } = useTranslation();
  const isMention = kind === 'session-mention';
  const label = isMention ? t('sessions.drop.mention') : t('sessions.drop.files');
  const Icon = isMention ? AtSign : Paperclip;

  return (
    <div
      data-testid="conversation-drop-overlay"
      data-drop-kind={kind}
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        className={cn(
          'absolute inset-3 rounded-2xl border-2 border-dashed',
          'border-primary/55 bg-primary/12 backdrop-blur-[2px]',
          'dark:border-primary/45 dark:bg-primary/16'
        )}
      />
      <div
        className={cn(
          'relative flex max-w-[min(100%,20rem)] items-center gap-2 rounded-full',
          'border border-primary/25 bg-background/90 px-4 py-2',
          'text-sm font-medium text-foreground shadow-sm'
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}
