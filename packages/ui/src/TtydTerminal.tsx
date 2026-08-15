import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { CockpitLoadingPane } from './LoadingSkeleton';
import { hasTerminalChoiceMenu } from './terminal-choices';
import { isTouchInputDevice } from './terminal-touch';
import { extractTerminalUrls } from './terminal-url';
import { useTerminalTouch } from './use-terminal-touch';
import type { TerminalAgent } from './protocol';

const encoder = new TextEncoder();

export const TERMINAL_BACKGROUND_PROPERTY = '--terminal-background';

// Statusline paste-code and Enter actions submit input through this event.
export const TERMINAL_SUBMIT_EVENT = 'blitz:terminal-submit';

export type TerminalSessionType = TerminalAgent | 'terminal';

// The prompt wraps at narrow widths ("Press Enter to" / "continue…"), so
// match across joined rows, not per row.
export function hasEnterPrompt(rows: string[]): boolean {
  return /press\s+enter\s+to\s+continue/iu.test(rows.join(' '));
}

export function TtydTerminal({
  url,
  sessionType = 'claude',
  sessionKey = '0',
  readOnly = false,
  onSignInUrl,
  onOpenPreview,
}: {
  url: string;
  sessionType?: TerminalSessionType;
  sessionKey?: string;
  /** Observer mode: render the session without ever sending input or resizes. */
  readOnly?: boolean;
  onSignInUrl?: (url: string | null) => void;
  onOpenPreview?: (port: number) => boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<((command: '0' | '1', data: string) => void) | null>(null);
  const choiceMenuActiveRef = useRef(false);
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
  const [connected, setConnected] = useState(false);
  const sendInput = useCallback((data: string) => {
    if (readOnly) return;
    sendRef.current?.('0', data);
  }, [readOnly]);
  const {
    selectionChip,
    copySelection,
    deselectSelection,
    showPasteHint,
  } = useTerminalTouch({
    terminal: terminalInstance,
    surface: hostRef.current,
    sendInput,
    active: true,
    choiceMenuActiveRef,
    onOpenPreview,
  });

  // Armed by paste-code Send: presses Enter each time a "Press Enter to
  // continue" prompt is actually on screen (the login flow shows two). The
  // recording of the real flow showed write-gated Enters fire before the
  // prompts exist — the prompt text itself is the only reliable trigger.
  const autoEnter = useRef<{
    remaining: number;
    until: number;
    lastFired: string;
    lastAt: number;
  } | null>(null);

  useEffect(() => {
    if (readOnly) return;
    const handleSubmit = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: string; enters?: number }>).detail;
      if (!detail?.data) return;
      const enters = detail.enters ?? 0;
      sendInput(detail.data);
      if (enters > 0) {
        // First Enter submits the code field itself ("Paste code here…" — the
        // scanner's continue-prompt never appears until the code is submitted).
        // Delayed past Ink's paste-batching window so it isn't folded into the
        // pasted text; the armed scanner then rides the continue prompts.
        window.setTimeout(() => {
          sendInput('\r');
        }, 350);
        autoEnter.current = {
          remaining: enters,
          until: Date.now() + 90_000,
          lastFired: '',
          lastAt: 0,
        };
      } else {
        autoEnter.current = null;
      }
    };
    window.addEventListener(TERMINAL_SUBMIT_EVENT, handleSubmit);
    return () => window.removeEventListener(TERMINAL_SUBMIT_EVENT, handleSubmit);
  }, [readOnly, sendInput]);

  useEffect(() => {
    if (!terminalInstance) {
      onSignInUrl?.(null);
      choiceMenuActiveRef.current = false;
      return;
    }

    let renderTimer: number | null = null;
    const scanBuffer = () => {
      const buffer = terminalInstance.buffer.active;
      const firstRow = Math.max(0, buffer.length - 60);
      const rows: string[] = [];
      for (let row = firstRow; row < buffer.length; row += 1) {
        rows.push(buffer.getLine(row)?.translateToString(true) ?? '');
      }
      const matches = extractTerminalUrls(rows, terminalInstance.cols)
        .filter((candidate) => /oauth|login|authorize|device/iu.test(candidate));
      onSignInUrl?.(matches.at(-1) ?? null);
      choiceMenuActiveRef.current = hasTerminalChoiceMenu(rows);
      const armed = autoEnter.current;
      if (armed) {
        if (armed.remaining <= 0 || Date.now() > armed.until) {
          autoEnter.current = null;
        } else {
          // Consecutive screens both end in "Press Enter to continue…", so a
          // visible/hidden edge never happens — dedupe on screen content
          // instead: a different screen showing the prompt fires again, the
          // same screen cannot double-fire.
          const fingerprint = rows.join('\n');
          if (
            hasEnterPrompt(rows)
            && fingerprint !== armed.lastFired
            && Date.now() - armed.lastAt > 250
          ) {
            armed.lastFired = fingerprint;
            armed.lastAt = Date.now();
            armed.remaining -= 1;
            sendInput('\r');
          }
        }
      }
    };
    const scheduleScan = () => {
      if (renderTimer !== null) window.clearTimeout(renderTimer);
      // Armed auto-Enter wants reaction time; the passive URL/choice scan
      // doesn't need to run that hot.
      renderTimer = window.setTimeout(scanBuffer, autoEnter.current ? 80 : 500);
    };
    const renderSubscription = terminalInstance.onRender(scheduleScan);
    // Render-driven scans stall on static screens: a fire blocked by the
    // anti-double-fire floor would never retry. While armed, tick on a clock.
    const armedTick = window.setInterval(() => {
      if (autoEnter.current) scanBuffer();
    }, 150);
    scheduleScan();

    return () => {
      if (renderTimer !== null) window.clearTimeout(renderTimer);
      window.clearInterval(armedTick);
      renderSubscription.dispose();
      onSignInUrl?.(null);
      choiceMenuActiveRef.current = false;
    };
  }, [onSignInUrl, terminalInstance]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const styles = getComputedStyle(host);
    const terminal = new Terminal({
      cursorBlink: true,
      // tmux mouse mode captures the wheel and drag; Shift-drag keeps native
      // selection everywhere else, but macOS only gets an escape hatch when
      // Option-drag is explicitly allowed to force selection.
      macOptionClickForcesSelection: true,
      theme: {
        background: styles.getPropertyValue(TERMINAL_BACKGROUND_PROPERTY).trim(),
        cursor: styles.getPropertyValue('--ink').trim(),
        selectionBackground: styles.getPropertyValue('--terminal-selection').trim(),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    if (terminal.textarea) {
      terminal.textarea.autocomplete = 'off';
      terminal.textarea.setAttribute('autocorrect', 'off');
      terminal.textarea.autocapitalize = 'none';
      terminal.textarea.spellcheck = false;
      terminal.textarea.removeAttribute('name');
    }
    // WebGL renderer: 4-10x faster full-screen repaints than the default DOM
    // renderer (claude-code redraws constantly). Must load after open(). On
    // context loss or unsupported WebGL2, dispose and fall back to DOM —
    // same chain stock ttyd uses.
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    try {
      terminal.loadAddon(webgl);
    } catch {
      webgl.dispose();
      // WebGL2 unavailable — DOM renderer remains active.
    }
    fit.fit();
    if (!isTouchInputDevice()) terminal.focus();

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 500;
    let stopped = false;

    const send = (command: '0' | '1', data: string) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(encoder.encode(`${command}${data}`));
    };
    if (!readOnly) {
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          event.type === 'keydown'
          && event.key === 'Enter'
          && event.shiftKey
          && !event.altKey
          && !event.ctrlKey
          && !event.metaKey
        ) {
          send('0', '\x1b[13;2u');
          return false;
        }
        return true;
      });
    }
    sendRef.current = send;
    setTerminalInstance(terminal);

    // Trailing debounce: mid-animation refits while the iOS keyboard is
    // presenting make WebKit abort the keyboard. Fit once the geometry settles.
    let resizeTimer: number | null = null;
    const resize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fit.fit();
        // Observers must not resize the tenant's pty.
        if (readOnly) return;
        send('1', JSON.stringify({
          columns: terminal.cols,
          rows: terminal.rows,
        }));
      }, 200);
    };

    const connect = () => {
      if (stopped) return;
      // Second arg = a per-tab key so blitz-session names a UNIQUE tmux session
      // (claude-<key>); without it every Claude tab attached to the same session.
      // Third arg "ro" = observer mode: blitz-session does tmux attach -r, so the
      // VM itself discards observer keystrokes (goldens without ro support just
      // ignore the extra arg — client-side read-only still applies).
      const next = new WebSocket(
        `${url}?arg=${encodeURIComponent(sessionType)}&arg=${encodeURIComponent(sessionKey)}${readOnly ? '&arg=ro' : ''}`,
        'tty',
      );
      socket = next;
      next.binaryType = 'arraybuffer';

      next.onopen = () => {
        fit.fit();
        // blitz-session's tmux attach -r client is read-only,ignore-size (proved
        // with a real tmux client in golden.test.mjs), so omit observer geometry
        // here as well and leave the active tenant client in sole control.
        next.send(JSON.stringify({
          AuthToken: '',
          ...(readOnly ? {} : {
            columns: terminal.cols,
            rows: terminal.rows,
          }),
        }));
        if (!isTouchInputDevice()) terminal.focus();
      };

      next.onmessage = (event) => {
        const frame = new Uint8Array(event.data as ArrayBuffer);
        if (frame[0] === '0'.charCodeAt(0)) {
          reconnectDelay = 500;
          setConnected(true);
          terminal.write(frame.subarray(1));
        }
      };

      next.onclose = () => {
        if (stopped || socket !== next) return;
        setConnected(false);
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    const input = readOnly
      ? { dispose: () => undefined }
      : terminal.onData((data) => send('0', data));
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      socket?.close();
      if (sendRef.current === send) sendRef.current = null;
      terminal.dispose();
    };
  }, [readOnly, sessionType, sessionKey, url]);

  return (
    <div className="terminal-panel">
      <div ref={hostRef} className="terminal-surface" />
      {!connected && (
        <div className="cockpit-loading-overlay">
          <CockpitLoadingPane ariaLabel="Connecting terminal" stage="connecting · terminal" />
        </div>
      )}
      {selectionChip.visible && (
        <div
          className="terminal-selection-chip"
          role="toolbar"
          aria-label="Terminal selection"
          style={{ left: selectionChip.x, top: selectionChip.y }}
        >
          <button type="button" onClick={() => { void copySelection(); }}>
            Copy
          </button>
          <button type="button" onClick={deselectSelection}>
            Deselect
          </button>
        </div>
      )}
      {showPasteHint && (
        <div className="terminal-paste-hint" role="status">
          Paste: Ctrl+Shift+V (or right-click)
        </div>
      )}
    </div>
  );
}
