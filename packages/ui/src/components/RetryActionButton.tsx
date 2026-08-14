import type { RetryAction } from "@blitzos/schema";

export function RetryActionButton({
  retryAction,
  onRetry,
}: {
  retryAction: RetryAction;
  onRetry: (action: Exclude<RetryAction, null>) => void;
}): React.JSX.Element | null {
  if (retryAction === null) return null;
  return (
    <button className="cockpit-action" type="button" data-retry-action={retryAction} onClick={() => onRetry(retryAction)}>
      Retry
    </button>
  );
}

export function ErrorState({
  error,
  retryAction,
  onRetry,
}: {
  error: string;
  retryAction: RetryAction;
  onRetry: (action: Exclude<RetryAction, null>) => void;
}): React.JSX.Element {
  return (
    <div className="error-state" role="alert">
      <p>{error}</p>
      <RetryActionButton retryAction={retryAction} onRetry={onRetry} />
    </div>
  );
}
