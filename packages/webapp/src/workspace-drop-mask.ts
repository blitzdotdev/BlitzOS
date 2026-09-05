import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * The workspace shell's file-drop mask, and the one thing that clears it.
 *
 * `CloudApp` arms the mask on `dragover` and clears it in its own `onDrop`.
 * A DESCENDANT may consume that drop first. The vendored Lody composer calls
 * `event.stopPropagation()` on a file drop
 * (`vendor/lody/packages/components/src/components/chat/chat-composer.tsx:494`),
 * so the shell's handler never runs and the mask stays. `.webapp-drop-overlay`
 * is `position: fixed; inset: 0` over a 72% paper scrim, so a member sees the
 * whole screen go grey and stay grey.
 *
 * THE LISTENERS ARE IN THE CAPTURE PHASE, and that is the whole fix. Capture
 * runs before the target's own handler, so a descendant that stops propagation
 * cannot suppress them. The shell therefore never depends on its own `onDrop`
 * to clear the mask.
 *
 * BOTH EVENTS ARE NEEDED. A drag that ends without a drop fires `dragend`, and
 * a file dragged in from the operating system has no source node in this
 * document, so it fires `drop` and no `dragend` at all.
 *
 * ITS OWN MODULE so a test can drive it without importing `CloudApp.tsx`, which
 * the max-lines warn list already names.
 */
export interface WorkspaceDropMaskState {
  dropActive: boolean;
  setDropActive: Dispatch<SetStateAction<boolean>>;
}

export function useWorkspaceDropMaskState(): WorkspaceDropMaskState {
  const [dropActive, setDropActive] = useState(false);
  useEffect(() => {
    if (!dropActive) return undefined;
    const clearDropMask = (): void => setDropActive(false);
    window.addEventListener('drop', clearDropMask, true);
    window.addEventListener('dragend', clearDropMask, true);
    return () => {
      window.removeEventListener('drop', clearDropMask, true);
      window.removeEventListener('dragend', clearDropMask, true);
    };
  }, [dropActive]);
  return { dropActive, setDropActive };
}
