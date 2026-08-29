import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalTitleEvent,
} from '@lody/shared';

export type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalTitleEvent,
} from '@lody/shared';

export type Unsubscribe = () => void;

export interface TerminalChannel {
  /** Enumerate the live terminals for a session (panel mount / reconnect). */
  list(sessionId: string): Promise<TerminalSnapshot[]>;
  /** Create a new PTY; the server assigns the terminalId. */
  open(params: TerminalOpenParams): Promise<TerminalOpenResult>;
  /** Re-attach to an existing terminal: replays scrollback, then streams. */
  attach(terminalId: string, cols: number, rows: number): void;
  /** Send raw input bytes (keystrokes / paste). */
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  /** Close and kill the terminal. */
  close(terminalId: string): void;
  /** Close and kill every terminal owned by the session. */
  closeSession(sessionId: string): void;
  /** Read plain text from the host system clipboard. */
  readClipboardText(): string | Promise<string>;
  /** Write plain text to the host system clipboard. */
  writeClipboardText(text: string): void;

  onData(handler: (event: TerminalDataEvent) => void): Unsubscribe;
  onExit(handler: (event: TerminalExitEvent) => void): Unsubscribe;
  onTitle(handler: (event: TerminalTitleEvent) => void): Unsubscribe;
}
