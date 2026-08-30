import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ForgotPasswordPage } from '@/components/pages/forgot-password-page';
import {
  getAppOriginForUrlParsing,
  getAppShareOrigin,
  replaceAppWindowLocation,
} from '@/lib/app-location';
import { isSafeAuthRedirect } from '@/lib/auth-redirect';
import { getAuthResponseError } from '@/lib/auth-response';
import { useAuthClient } from '../providers/convex-provider';

type ForgotPasswordSearch = {
  email?: string;
  redirect?: string;
};

type AuthClientWithPasswordReset = ReturnType<typeof useAuthClient> & {
  requestPasswordReset: (input: { email: string; redirectTo?: string }) => Promise<unknown>;
};

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordRoute,
  validateSearch: (search: Record<string, unknown>): ForgotPasswordSearch => {
    return {
      email: typeof search.email === 'string' ? search.email : undefined,
      redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    };
  },
});

const normalizeBasePath = () => {
  const baseUrl = import.meta.env.BASE_URL.length > 0 ? import.meta.env.BASE_URL : '/';
  return baseUrl === '/' ? '' : baseUrl.replace(/\/$/, '');
};

const buildAppUrlWithSearch = (path: string, search: URLSearchParams) => {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  const query = search.toString();
  const appPath = `${normalizeBasePath()}/${normalizedPath}${query.length > 0 ? `?${query}` : ''}`;
  return new URL(appPath, `${getAppShareOrigin()}/`).toString();
};

const getRedirectTarget = (redirect?: string) => {
  const safe = isSafeAuthRedirect(redirect, { appOrigin: getAppOriginForUrlParsing() });
  return safe ?? `${normalizeBasePath()}/login`;
};

function ForgotPasswordRoute() {
  const { t } = useTranslation();
  const authClient = useAuthClient() as AuthClientWithPasswordReset;
  const { email: initialEmail, redirect } = Route.useSearch();
  const [email, setEmail] = useState(() => initialEmail ?? '');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const redirectTarget = useMemo(() => getRedirectTarget(redirect), [redirect]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setSent(false);

    const parsedEmail = z.string().email().safeParse(email.trim());
    if (!parsedEmail.success) {
      setSubmitError(t('forgotPassword.invalidEmail', 'Please enter a valid email address.'));
      return;
    }

    const resetSearch = new URLSearchParams();
    resetSearch.set('redirect', redirectTarget);

    setSubmitting(true);
    try {
      const response = await authClient.requestPasswordReset({
        email: parsedEmail.data.toLowerCase(),
        redirectTo: buildAppUrlWithSearch('/reset-password', resetSearch),
      });
      const authError = getAuthResponseError(response);
      if (authError) {
        setSubmitError(
          authError.message ??
            t('forgotPassword.submitFailed', 'Unable to send reset email. Please try again.')
        );
        return;
      }
      setSent(true);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : t('forgotPassword.submitFailed', 'Unable to send reset email. Please try again.')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ForgotPasswordPage
      email={email}
      submitError={submitError}
      sent={sent}
      submitting={submitting}
      onEmailChange={(value) => {
        setEmail(value);
        setSubmitError(null);
        setSent(false);
      }}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      onBackToLogin={() => replaceAppWindowLocation(redirectTarget)}
    />
  );
}
