import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAtom } from 'jotai';
import type { SupportedLanguage } from '@lody/shared';
import { cn } from '@/lib/utils';
import { languageAtom } from '@/atoms/settings';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { OnboardingShell, OnboardingNextButton } from '../onboarding-shell';

interface LanguageOption {
  value: SupportedLanguage;
  // Display label is intentionally rendered in the option's own language so the
  // user can recognise it without relying on the current UI locale.
  nativeLabel: string;
  caption: string;
  glyph: string;
}

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: 'en', nativeLabel: 'English', caption: 'English', glyph: 'A' },
  { value: 'zh_CN', nativeLabel: '简体中文', caption: 'Chinese (Simplified)', glyph: '中' },
];

export interface LanguageScreenViewProps {
  /** Currently selected language. */
  value: SupportedLanguage;
  onChange: (next: SupportedLanguage) => void;
  onNext: () => void;
}

export function LanguageScreenView({ value, onChange, onNext }: LanguageScreenViewProps) {
  const { t } = useTranslation();

  return (
    <OnboardingShell
      stepKey="language"
      title={t('onboarding.language.title', 'Choose your language')}
      description={t(
        'onboarding.language.description',
        'You can switch this anytime from settings.'
      )}
      primaryAction={<OnboardingNextButton onClick={onNext} />}
    >
      <div
        role="radiogroup"
        aria-label={t('onboarding.language.title', 'Choose your language')}
        className="grid gap-3 sm:grid-cols-2"
      >
        {LANGUAGE_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <motion.button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onChange(option.value)}
              className={cn(
                'group relative flex flex-col items-center gap-3 rounded-xl border px-6 py-6 text-center transition-all',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-primary/70 bg-primary/[0.06] shadow-[0_0_0_4px_hsl(var(--primary)/0.1)]'
                  : 'border-border/60 bg-card/40 hover:border-border hover:bg-card/70'
              )}
            >
              {selected ? (
                <motion.span
                  layoutId="onboarding-language-check"
                  className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                  <Check className="h-3 w-3" />
                </motion.span>
              ) : null}
              <div
                className={cn(
                  'flex h-14 w-14 items-center justify-center rounded-xl text-2xl font-medium transition-colors',
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-foreground/80 group-hover:bg-muted'
                )}
              >
                {option.glyph}
              </div>
              <div className="space-y-0.5">
                <div className="text-base font-medium text-foreground">{option.nativeLabel}</div>
                <div className="text-xs text-muted-foreground">{option.caption}</div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}

interface LanguageScreenProps {
  onNext: () => void;
}

export function LanguageScreen({ onNext }: LanguageScreenProps) {
  const { i18n } = useTranslation();
  const [language, setLanguage] = useAtom(languageAtom);

  const handleSelect = (next: SupportedLanguage) => {
    setLanguage(next);
    void i18n.changeLanguage(next);
    void getIpcServices()?.app.setLanguage(next);
  };

  return <LanguageScreenView value={language} onChange={handleSelect} onNext={onNext} />;
}
