import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useAtom } from 'jotai';
import type { SupportedLanguage } from '@lody/shared';
import { cn } from '@/lib/utils';
import { languageAtom } from '@/atoms/settings';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { useTheme, type Theme } from '../../../theme-provider';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';
import { playHover, playSelect } from '../ceremony/ui-sounds';

// Appearance: theme and language, on one screen.
//
// They were two, and neither earned a screen. Theme was two small buttons
// captioned "Light" and "Dark" with no preview at all — you cannot choose an
// appearance from the word for it. Language was a large "A" beside a large
// "中", which names a language you already knew the name of. Two screens, four
// buttons, nothing shown.
//
// They are one question — what does this look like — so they are one screen,
// and the panel does the showing. The preview is the REAL product window, and
// it needs no special wiring to be a preview: picking a theme sets the global
// theme, picking a language changes i18n, and the window re-renders under both.
// One surface, actually correct, rather than two drawings of it.
//
// The controls are deliberately in the STONE palette rather than the semantic
// one. The card is white and stays white; a control painted in `text-foreground`
// turns near-white the moment you pick Dark, on a surface that did not change
// with it.

interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Set when the label is written in a language other than the UI's. */
  lang?: string;
}

/**
 * A segmented control.
 *
 * A closed set of answers to one question, presented as one object.
 * Separate bordered tiles say "here are two things"; a segmented control says
 * "here is one setting, currently on this option" — which is what both of
 * these are. The selected pill is a shared layout element, so switching slides
 * rather than blinking, and there is never a frame with two or zero pills.
 */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  layoutId,
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (next: T) => void;
  layoutId: string;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.09em] text-slate-400">
        {label}
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex rounded-xl bg-stone-900/[0.045] p-1"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              lang={option.lang}
              onMouseEnter={() => playHover()}
              onClick={() => {
                if (selected) return;
                playSelect();
                onChange(option.value);
              }}
              className={cn(
                'relative flex flex-1 items-center justify-center rounded-lg px-4 py-2.5',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-stone-900/25'
              )}
            >
              {selected ? (
                <motion.span
                  layoutId={layoutId}
                  className="absolute inset-0 rounded-lg bg-white shadow-[0_1px_2px_rgba(28,25,23,0.10),0_0_0_0.5px_rgba(28,25,23,0.05)]"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              ) : null}
              <span
                className={cn(
                  'relative flex items-center gap-2 text-[13.5px] font-medium transition-colors duration-150',
                  selected ? 'text-stone-900' : 'text-stone-500 hover:text-stone-700'
                )}
              >
                {option.icon}
                {option.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface AppearanceScreenViewProps {
  /** Selected appearance mode (light, dark, or follow the OS). */
  mode: Theme;
  onModeChange: (next: Theme) => void;
  language: SupportedLanguage;
  onLanguageChange: (next: SupportedLanguage) => void;
  onBack: () => void;
  onNext: () => void;
}

export function AppearanceScreenView({
  mode,
  onModeChange,
  language,
  onLanguageChange,
  onBack,
  onNext,
}: AppearanceScreenViewProps) {
  const { t } = useTranslation();

  return (
    <OnboardingShell
      stepKey="appearance"
      title={t('onboarding.appearance.title', 'Make it yours')}
      description={t(
        'onboarding.appearance.description',
        'Both start from your system settings, and both live in Settings if you change your mind.'
      )}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={<OnboardingNextButton onClick={onNext} />}
    >
      <div className="flex flex-col gap-6 pt-1">
        <Segmented
          layoutId="onboarding-appearance-theme"
          label={t('onboarding.appearance.theme', 'Theme')}
          value={mode}
          onChange={onModeChange}
          options={[
            {
              value: 'light',
              label: t('onboarding.theme.light', 'Light'),
              icon: <Sun className="h-3.5 w-3.5" strokeWidth={1.8} />,
            },
            {
              value: 'dark',
              label: t('onboarding.theme.dark', 'Dark'),
              icon: <Moon className="h-3.5 w-3.5" strokeWidth={1.8} />,
            },
            {
              value: 'system',
              label: t('onboarding.theme.system', 'System'),
              icon: <Monitor className="h-3.5 w-3.5" strokeWidth={1.8} />,
            },
          ]}
        />
        <Segmented
          layoutId="onboarding-appearance-language"
          label={t('onboarding.appearance.language', 'Language')}
          value={language}
          onChange={onLanguageChange}
          options={[
            // Each name in its own language: a list of languages you cannot read
            // is not a list of languages. `lang` so Han characters get a
            // Simplified Chinese face rather than whatever the font stack
            // reaches for first.
            { value: 'en', label: 'English', lang: 'en' },
            { value: 'zh_CN', label: '简体中文', lang: 'zh-Hans' },
          ]}
        />
      </div>
    </OnboardingShell>
  );
}

interface AppearanceScreenProps {
  onBack: () => void;
  onNext: () => void;
}

/**
 * Wires the global appearance mode and the interface language.
 *
 * The app ships one light palette (Lody Light) and one dark palette (Vesper);
 * the theme choice is light, dark, or follow the OS. Click commits — no hover
 * preview, which proved jarring when the whole window flipped under the pointer.
 */
export function AppearanceScreen({ onBack, onNext }: AppearanceScreenProps) {
  const { i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useAtom(languageAtom);

  const handleLanguage = (next: SupportedLanguage) => {
    setLanguage(next);
    void i18n.changeLanguage(next);
    void getIpcServices()?.app.setLanguage(next);
  };

  return (
    <AppearanceScreenView
      mode={theme}
      onModeChange={(next) => setTheme(next)}
      language={language}
      onLanguageChange={handleLanguage}
      onBack={onBack}
      onNext={onNext}
    />
  );
}
