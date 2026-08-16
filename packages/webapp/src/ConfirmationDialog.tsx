import { useEffect, useId, useRef } from 'react';

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

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    cancelButton.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onCancel]);

  return (
    <div
      className="webapp-confirmation-screen"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
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
    </div>
  );
}
