import type { Terminal } from '@xterm/xterm';
import { pasteToSession } from './session-input';
import { isPasteKeyEvent } from './terminal-paste';

export type TerminalKeyHandler = (event: KeyboardEvent) => boolean;

/** What xterm does with a key when nobody has claimed it. */
const XTERM_DEFAULT: TerminalKeyHandler = () => true;
const installed = new WeakMap<Terminal, TerminalKeyHandler>();

/**
 * xterm keeps exactly ONE custom key event handler and offers no getter for it,
 * so two owners cannot share the slot by themselves. Track the installed
 * handler here: a new owner delegates to the one it replaced, and a teardown
 * hands that one back instead of overwriting it with a permissive stub.
 * Returns the teardown.
 */
export function installTerminalKeyHandler(
  terminal: Terminal,
  make: (previous: TerminalKeyHandler) => TerminalKeyHandler,
): () => void {
  const previous = installed.get(terminal) ?? XTERM_DEFAULT;
  const handler = make(previous);
  installed.set(terminal, handler);
  terminal.attachCustomKeyEventHandler(handler);
  return () => {
    // A later owner already took the slot. Restoring here would clobber it.
    if (installed.get(terminal) !== handler) return;
    installed.set(terminal, previous);
    terminal.attachCustomKeyEventHandler(previous);
  };
}

export type TerminalPasteOptions = {
  terminal: Terminal | null;
  surface: HTMLElement | null;
  sendInput: (data: string) => void;
};

/**
 * Keyboard paste. Both halves below are needed — each alone is a shipped bug:
 * 1. Suppress the paste combos from xterm's keydown processing (send nothing!).
 *    Without this, xterm turns ctrl+V into the control byte \x16 and cancels
 *    the event, so the browser never fires a paste event and paste goes fully
 *    dead on non-mac.
 * 2. Own the native "paste" event in the capture phase: stopPropagation keeps
 *    xterm's own textarea paste listener from delivering the same clipboard a
 *    second time (sending from the keydown instead is what caused the
 *    double-paste — the un-prevented default still fired).
 *
 * The two halves bind and unbind together, and their lifetime is the terminal
 * and its surface — nothing else. The browser fires the paste event in a LATER
 * task than the keydown that asked for it. Anything that unbinds in between
 * eats the paste outright: half 1 already took xterm's own path away, and half
 * 2 is not listening yet.
 */
export function bindTerminalPaste({
  terminal,
  surface,
  sendInput,
}: TerminalPasteOptions): (() => void) | undefined {
  if (!terminal || !surface) return;

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const restoreKeyHandler = installTerminalKeyHandler(terminal, (previous) => (event) => (
    isPasteKeyEvent(event, isMac) ? false : previous(event)
  ));
  const handleNativePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    event.preventDefault();
    event.stopPropagation();
    if (text) {
      pasteToSession(text, {
        bracketedPasteMode: terminal.modes.bracketedPasteMode,
        input: (payload) => {
          sendInput(payload);
          return true;
        },
      });
    }
  };
  surface.addEventListener('paste', handleNativePaste, { capture: true });

  return () => {
    surface.removeEventListener('paste', handleNativePaste, { capture: true });
    restoreKeyHandler();
  };
}
