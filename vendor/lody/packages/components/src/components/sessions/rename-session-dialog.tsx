import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SessionId } from '@lody/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { useSessionActions } from '@/hooks/use-session-actions';
import { isImeComposingKeyboardEvent } from '@/lib/ime';

const MAX_VISIBLE_TITLE_LINES = 4;

const normalizePlainTextTitle = (value: string) => {
  return value.replace(/[\r\n]+/g, ' ').trim();
};

const resizeTitleTextarea = (textarea: HTMLTextAreaElement) => {
  const computed = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0;
  const chromeHeight = paddingTop + paddingBottom + borderTop + borderBottom;
  const minHeight = lineHeight + chromeHeight;
  const maxHeight = lineHeight * MAX_VISIBLE_TITLE_LINES + chromeHeight;

  textarea.style.height = `${minHeight}px`;
  const scrollHeight = textarea.scrollHeight + borderTop + borderBottom;
  const nextHeight = textarea.value
    ? Math.max(minHeight, Math.min(scrollHeight, maxHeight))
    : minHeight;

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.value && scrollHeight > maxHeight ? 'auto' : 'hidden';
};

export type RenameSessionDialogTarget = {
  sessionId: SessionId;
  initialTitle: string;
};

export type RenameSessionDialogProps = {
  target: RenameSessionDialogTarget | null;
  onClose: () => void;
};

export type RenameSessionDialogViewProps = RenameSessionDialogProps & {
  onRename: (sessionId: SessionId, nextTitle: string) => void | Promise<void>;
};

export function RenameSessionDialogView({
  target,
  onClose,
  onRename,
}: RenameSessionDialogViewProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (target) {
      setDraft(target.initialTitle);
      setSaving(false);
    }
  }, [target]);

  useLayoutEffect(() => {
    if (textareaRef.current) {
      resizeTitleTextarea(textareaRef.current);
    }
  }, [draft, target]);

  useEffect(() => {
    const handleResize = () => {
      if (textareaRef.current) {
        resizeTitleTextarea(textareaRef.current);
      }
    };

    if (target) {
      window.addEventListener('resize', handleResize);
    }
    return () => window.removeEventListener('resize', handleResize);
  }, [target]);

  const handleOpenChange = (open: boolean) => {
    if (!open && !saving) {
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!target) return;
    const nextTitle = normalizePlainTextTitle(draft);
    if (!nextTitle || nextTitle === target.initialTitle.trim()) {
      onClose();
      return;
    }
    try {
      setSaving(true);
      await onRename(target.sessionId, nextTitle);
      onClose();
    } catch (error: unknown) {
      toast.error(String(error instanceof Error ? error.message : error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target != null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden p-0 sm:p-0">
        <DialogHeader className="border-b border-border/70 px-4 py-4 pr-12 text-left sm:px-5 sm:pr-12">
          <DialogTitle className="text-base">
            {t('sidebar.renameChat.title', 'Rename Chat')}
          </DialogTitle>
          <DialogDescription className="leading-5">
            {t('sidebar.renameChat.description', 'Enter a new name for this chat.')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-4 sm:px-5">
          <Textarea
            ref={textareaRef}
            autoFocus
            rows={1}
            value={draft}
            disabled={saving}
            className="min-h-9 resize-none overflow-y-hidden py-2 leading-5 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeComposingKeyboardEvent(e)) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </div>

        <DialogFooter className="border-t border-border/70 bg-muted/30 px-4 py-3 sm:px-5">
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={saving || normalizePlainTextTitle(draft).length === 0}
          >
            {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameSessionDialog({ target, onClose }: RenameSessionDialogProps) {
  const { updateSessionTitle } = useSessionActions();

  return (
    <RenameSessionDialogView target={target} onClose={onClose} onRename={updateSessionTitle} />
  );
}
