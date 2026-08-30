import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { openExternalUrl } from '@/lib/native-browser';
import { cn } from '@/lib/utils';

/**
 * Subtle text link to the public pricing page, shown on checkout surfaces
 * (billing upgrade card, paid-workspace creation). Opens in the system
 * browser on Electron / a new tab on web (`openExternalUrl` handles both).
 */
export function PricingPageLink({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const url = i18n.language?.startsWith('zh')
    ? 'https://lody.ai/zh/price'
    : 'https://lody.ai/price';

  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url)}
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline',
        className
      )}
    >
      {t('billing.viewPricingPage')}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
