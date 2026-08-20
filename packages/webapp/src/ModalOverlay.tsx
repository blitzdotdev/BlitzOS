import { useEffect, useId, type ReactNode } from 'react';

/** The behaviour every modal in the app owes the keyboard: Escape closes it,
 * a click on the backdrop closes it, and the element that had focus when it
 * opened gets focus back when it closes.
 *
 * It exists because the second modal that hand-rolled a backdrop quietly
 * shipped without any of it. The dialog itself — its width, its sections, its
 * buttons — stays with the caller; only the shell is shared. */

/** Open overlays, oldest first. Escape belongs to the newest one alone: a
 * confirmation opened from inside another dialog must close itself, not take
 * the dialog underneath it down as well. */
const openOverlays: string[] = [];

export function ModalOverlay({
  onDismiss,
  dismissible = true,
  children,
}: {
  onDismiss: () => void;
  /** False while a request is in flight, so a stray Escape or backdrop click
   * cannot close a dialog whose save is still running. */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const id = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    openOverlays.push(id);
    return () => {
      const index = openOverlays.lastIndexOf(id);
      if (index !== -1) openOverlays.splice(index, 1);
      previouslyFocused?.focus();
    };
  }, [id]);

  useEffect(() => {
    if (!dismissible) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openOverlays.at(-1) === id) onDismiss();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [dismissible, id, onDismiss]);

  return (
    <div
      className="webapp-modal-screen"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onDismiss();
      }}
    >
      {children}
    </div>
  );
}
