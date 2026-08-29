import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function SessionSyncingIndicator({ labelClassName }: { labelClassName?: string }) {
  const { t } = useTranslation();

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="inline-flex h-3 w-3 shrink-0 origin-center animate-spin items-center justify-center">
        <Loader2 className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={labelClassName}>{t('common.syncing', 'Syncing')}</span>
    </span>
  );
}
