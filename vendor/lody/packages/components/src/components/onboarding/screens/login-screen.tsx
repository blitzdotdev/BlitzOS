import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { usePlatformSession } from '@lody/platform/react';
import { ExternalLink, Loader2, LogIn } from 'lucide-react';
import { Button } from '@/ui/button';
import { OnboardingBackButton, OnboardingShell } from '../onboarding-shell';

type ElectronBrowserSignInClient = {
  signIn: {
    social: (input: { callbackURL: string }) => Promise<unknown>;
  };
};

export function LoginScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation();
  const { authClient } = useRouter().options.context;
  const session = usePlatformSession();
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === 'authenticated') onNext();
  }, [onNext, session.status]);

  const handleSignIn = useCallback(() => {
    setOpeningBrowser(true);
    setError(null);
    void (authClient as unknown as ElectronBrowserSignInClient).signIn
      .social({
        callbackURL: '/onboarding',
      })
      .catch((signInError: unknown) => {
        setOpeningBrowser(false);
        setError(signInError instanceof Error ? signInError.message : String(signInError));
      });
  }, [authClient]);

  const checking = session.status === 'loading';
  return (
    <OnboardingShell
      stepKey="login"
      title={t('onboarding.login.title', 'Sign in to Lody')}
      description={t(
        'onboarding.login.description',
        'Authentication finishes in your browser and returns here automatically.'
      )}
      secondaryAction={<OnboardingBackButton onClick={onBack} disabled={checking} />}
      primaryAction={
        <Button size="lg" onClick={handleSignIn} disabled={checking}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          {openingBrowser
            ? t('onboarding.login.openBrowserAgain', 'Open browser again')
            : t('onboarding.login.openBrowser', 'Continue in browser')}
          {!checking ? <ExternalLink className="size-4" /> : null}
        </Button>
      }
    >
      <div className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-muted/30 px-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          {error ??
            (openingBrowser
              ? t('onboarding.login.returnHint', 'Complete sign-in in the browser to continue.')
              : t('onboarding.login.securityHint', 'Your browser handles account authentication.'))}
        </p>
      </div>
    </OnboardingShell>
  );
}
