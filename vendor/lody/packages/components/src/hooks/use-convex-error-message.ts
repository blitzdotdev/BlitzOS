import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isConvexError, isConvexUnauthenticatedError } from '@lody/shared';
import { useAuthenticatedConvex } from './use-authenticated-convex';

function containsRawConvexServerDetails(error: unknown): boolean {
  return (
    isConvexError(error) ||
    (error instanceof Error && error.message.trimStart().startsWith('[CONVEX '))
  );
}

export function useConvexErrorMessage() {
  const { t } = useTranslation();
  const { requestAuthRecovery } = useAuthenticatedConvex();

  return useCallback(
    (error: unknown, fallback: string): string => {
      if (isConvexUnauthenticatedError(error)) {
        requestAuthRecovery();
        return t(
          'login.sessionRefreshing',
          'Refreshing your session. Please try again in a moment.'
        );
      }
      if (containsRawConvexServerDetails(error)) {
        return fallback;
      }
      return error instanceof Error && error.message ? error.message : fallback;
    },
    [requestAuthRecovery, t]
  );
}
