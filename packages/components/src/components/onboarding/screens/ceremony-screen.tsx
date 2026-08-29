import { useTranslation } from 'react-i18next';
import lodyIcon from '@/assets/lody-icon.png';
import { OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

export function CeremonyScreen({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <OnboardingShell
      stepKey="ceremony"
      eyebrow={t('onboarding.ceremony.eyebrow', 'Welcome')}
      title={t('onboarding.ceremony.title', 'Set up Lody')}
      description={t(
        'onboarding.ceremony.description',
        'Connect an agent and a project, then start your first real session.'
      )}
      primaryAction={
        <OnboardingNextButton
          onClick={onNext}
          label={t('onboarding.ceremony.start', 'Get started')}
        />
      }
    >
      <div className="flex min-h-52 items-center justify-center py-6">
        <img src={lodyIcon} alt="" className="size-28 object-contain" />
      </div>
    </OnboardingShell>
  );
}
