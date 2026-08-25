import { useEffect, useId, useRef } from 'react';
import { ModalOverlay } from './ModalOverlay';

type ConfirmationDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = 'No',
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);

  // Focus lands on the safe choice; ModalOverlay restores the opener's focus.
  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  return (
    <ModalOverlay onDismiss={onCancel} dismissible={!busy}>
      <section
        className="webapp-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="webapp-confirmation-header">
          <h1 id={titleId}>{title}</h1>
        </header>
        <div className="webapp-confirmation-body">
          <p id={descriptionId}>{description}</p>
          {error && <p className="webapp-confirmation-error" role="alert">{error}</p>}
        </div>
        <footer className="webapp-confirmation-actions">
          <button
            ref={cancelButton}
            className="webapp-action"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className="webapp-action webapp-confirmation-confirm"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </footer>
      </section>
    </ModalOverlay>
  );
}
