import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

export function SummaryScreen({
  onBack,
  onComplete,
}: {
  onBack: () => void;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <OnboardingShell
      stepKey="summary"
      title={t('onboarding.summary.title', 'Lody is ready')}
      description={t(
        'onboarding.summary.description',
        'You can add providers and projects later from Settings.'
      )}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={
        <OnboardingNextButton
          finish
          onClick={onComplete}
          label={t('onboarding.summary.open', 'Open Lody')}
        />
      }
    >
      <div className="flex min-h-48 items-center justify-center">
        <CheckCircle2 className="size-16 text-primary" />
      </div>
    </OnboardingShell>
  );
}
