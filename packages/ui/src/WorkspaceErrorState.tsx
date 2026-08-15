import { useState } from 'react';
import type { RetryAction } from '@blitzos/schema';

const ERROR_DETAIL_PREVIEW_LENGTH = 180;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workspace retry failed.';
}

export function WorkspaceErrorState({
  workspaceName,
  errorDetail,
  retryAction,
  onRetry,
}: {
  workspaceName: string;
  errorDetail: string | null;
  retryAction: RetryAction;
  onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const detail = errorDetail?.trim() || 'No persisted diagnostic detail was returned.';
  const truncated = detail.length > ERROR_DETAIL_PREVIEW_LENGTH;
  const preview = truncated
    ? `${detail.slice(0, ERROR_DETAIL_PREVIEW_LENGTH - 1)}…`
    : detail;

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry();
    } catch (error) {
      setRetryError(failureMessage(error));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="workspace-error-state" role="alert">
      <div className="workspace-error-state__copy">
        <p className="workspace-error-state__eyebrow">Workspace error</p>
        <h1>{workspaceName} could not start</h1>
        {truncated ? (
          <details className="workspace-error-state__detail">
            <summary>{preview}</summary>
            <pre>{detail}</pre>
          </details>
        ) : (
          <pre className="workspace-error-state__detail">{preview}</pre>
        )}
        <p>The stored cause is shown above. Retry follows the control plane recovery action.</p>
        <button
          className="cockpit-action cockpit-action--primary"
          type="button"
          data-retry-action={retryAction ?? undefined}
          disabled={retrying}
          onClick={() => { void retry(); }}
        >{retrying ? 'Retrying…' : 'Retry'}</button>
        {retryError && <p className="workspace-error-state__retry-error">{retryError}</p>}
      </div>
    </div>
  );
}
