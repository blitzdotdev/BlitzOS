import { TERMINAL_SUBMIT_EVENT } from './TtydTerminal';

/** claude and codex tabs run the agent TUI as the tmux session's root process
 * (see blitz-term), so the login flow is the TUI's own slash command. A shell
 * line such as `claude /login` would just be typed into the running TUI. */
export const TERMINAL_SIGN_IN_COMMAND = '/login';

/** Ink folds a submit that arrives in the same write as the text into the
 * pasted content and swallows it, so the Enter is always a separate write. */
export const TERMINAL_SIGN_IN_SUBMIT_MS = 350;

/** A tab that was not already open has to connect its socket and let the TUI
 * take the pty before it reads anything typed at it. Tabs that are already
 * mounted are driven with no warm-up at all. */
export const TERMINAL_SIGN_IN_WARMUP_MS = 1_200;

/**
 * Types the harness login command into one named terminal tab and submits it.
 * Returns a cancel function: the caller aborts the whole sequence if the user
 * navigates away from the tab it was aimed at.
 */
export function driveTerminalSignIn(
  sessionKey: string,
  warmupMs: number,
  onSubmitted: () => void,
): () => void {
  const submit = (data: string): void => {
    window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
      // enters: 0 keeps the paste-code auto-Enter scanner disarmed; the user
      // reaches that step afterwards through the statusline "Paste code"
      // button. sessionKey addresses the tab, so a tab switch between dispatch
      // and delivery cannot type this into another session.
      detail: { data, enters: 0, sessionKey },
    }));
  };
  const command = window.setTimeout(() => submit(TERMINAL_SIGN_IN_COMMAND), warmupMs);
  const enter = window.setTimeout(() => {
    submit('\r');
    onSubmitted();
  }, warmupMs + TERMINAL_SIGN_IN_SUBMIT_MS);
  return () => {
    window.clearTimeout(command);
    window.clearTimeout(enter);
  };
}
