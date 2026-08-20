import { useEffect, useId, useRef } from 'react';
import { ModalOverlay } from './ModalOverlay';

type ConfirmationDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = 'No',
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
    <ModalOverlay onDismiss={onCancel}>
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
        </div>
        <footer className="webapp-confirmation-actions">
          <button
            ref={cancelButton}
            className="webapp-action"
            type="button"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className="webapp-action webapp-confirmation-confirm"
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </ModalOverlay>
  );
}
