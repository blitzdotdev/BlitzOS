import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ResetPasswordPage } from '@/components/pages/reset-password-page';
import { getAppOriginForUrlParsing, replaceAppWindowLocation } from '@/lib/app-location';
import { isSafeAuthRedirect } from '@/lib/auth-redirect';
import { getAuthResponseError } from '@/lib/auth-response';
import { formatPasswordValidationFailure, validateNewPassword } from '@/lib/password-validation';
import { useAuthClient } from '../providers/convex-provider';

type ResetPasswordSearch = {
  token?: string;
  redirect?: string;
  error?: string;
};

type AuthClientWithResetPassword = ReturnType<typeof useAuthClient> & {
  resetPassword: (input: { newPassword: string; token: string }) => Promise<unknown>;
};

export const Route = createFileRoute('/reset-password')({
  component: ResetPasswordRoute,
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => {
    return {
      token: typeof search.token === 'string' ? search.token : undefined,
      redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
      error: typeof search.error === 'string' ? search.error : undefined,
    };
  },
});

const normalizeBasePath = () => {
  const baseUrl = import.meta.env.BASE_URL.length > 0 ? import.meta.env.BASE_URL : '/';
  return baseUrl === '/' ? '' : baseUrl.replace(/\/$/, '');
};

const getRedirectTarget = (redirect?: string) => {
  const safe = isSafeAuthRedirect(redirect, { appOrigin: getAppOriginForUrlParsing() });
  return safe ?? `${normalizeBasePath()}/login`;
};

function ResetPasswordRoute() {
  const { t } = useTranslation();
  const authClient = useAuthClient() as AuthClientWithResetPassword;
  const { token, redirect, error } = Route.useSearch();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(
    error !== undefined
      ? t('resetPassword.invalidToken', 'This password reset link is invalid or expired.')
      : null
  );
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const redirectTarget = useMemo(() => getRedirectTarget(redirect), [redirect]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);

    if (token === undefined || token.length === 0) {
      setSubmitError(
        t(
          'resetPassword.missingToken',
          'This reset link is missing a token. Request a new password reset email.'
        )
      );
      return;
    }

    const passwordCheck = validateNewPassword(password);
    if (!passwordCheck.ok) {
      setSubmitError(formatPasswordValidationFailure(passwordCheck, t, 'resetPassword'));
      return;
    }

    if (password !== confirmPassword) {
      setSubmitError(t('resetPassword.passwordMismatch', 'Passwords do not match.'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      const authError = getAuthResponseError(response);
      if (authError) {
        setSubmitError(
          authError.message ??
            t('resetPassword.submitFailed', 'Unable to reset password. Please try again.')
        );
        return;
      }
      setSuccess(true);
      window.setTimeout(() => {
        replaceAppWindowLocation(redirectTarget);
      }, 900);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : t('resetPassword.submitFailed', 'Unable to reset password. Please try again.')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ResetPasswordPage
      password={password}
      confirmPassword={confirmPassword}
      submitError={submitError}
      success={success}
      submitting={submitting}
      tokenAvailable={token !== undefined && token.length > 0}
      onPasswordChange={(value) => {
        setPassword(value);
        setSubmitError(null);
      }}
      onConfirmPasswordChange={(value) => {
        setConfirmPassword(value);
        setSubmitError(null);
      }}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      onBackToLogin={() => replaceAppWindowLocation(redirectTarget)}
    />
  );
}
