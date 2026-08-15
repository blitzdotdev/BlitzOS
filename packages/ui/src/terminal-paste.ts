export type PasteKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>;

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

// True for the paste key combos (cmd+V on mac, ctrl+V elsewhere, ctrl+shift+V
// everywhere). Used to keep xterm's keydown processing away from them: xterm
// maps a bare ctrl+V to the control byte \x16 and CANCELS the event, which
// suppresses the browser's native paste event entirely. Returning false from
// the custom key handler for these combos lets the native paste event fire —
// the capture-phase paste listener is then the single delivery path.
export function isPasteKeyEvent(event: PasteKeyEvent, isMac: boolean): boolean {
  if (event.type !== 'keydown' || event.key.toLowerCase() !== 'v' || event.altKey) {
    return false;
  }

  if (event.ctrlKey && event.shiftKey && !event.metaKey) {
    return true;
  }

  return isMac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function terminalPastePayload(text: string, bracketedPasteMode: boolean): string {
  // Strip trailing newlines before framing. Browsers append one when copying a
  // line — e.g. the OAuth code from the sign-in page — and forwarding it as a CR
  // rides into the app as an extra Enter: Claude Code's login reads the code as
  // multi-line (so it takes two Enters to submit) and rejects it as malformed
  // ("make sure the full code was copied"). Internal newlines survive (multi-line
  // paste into an editor must work) and normalize to CR.
  const normalized = text.replace(/[\r\n]+$/u, '').replace(/\r?\n/gu, '\r');
  return bracketedPasteMode
    ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`
    : normalized;
}
