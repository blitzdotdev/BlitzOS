import { gatewayEndpointUrl } from './preview';

/** Shared-session kinds the box runs as a tmux session and can therefore end.
 * Mirrors blitz-term and the gateway's prefix map; other kinds have no process
 * to stop, so the browser never posts them. */
export type EndableSessionKind = 'terminal' | 'claude' | 'codex';

export function isEndableSessionKind(kind: string): kind is EndableSessionKind {
  return kind === 'terminal' || kind === 'claude' || kind === 'codex';
}

export function endTerminalSessionUrl(filesBase: string): string {
  return gatewayEndpointUrl(filesBase, 'terminal/session/end');
}

export type EndTerminalSessionResult =
  | { ok: true; ended: boolean }
  | { ok: false };

/** Asks the box to stop the tmux session `blitz-term` created for `key`. The
 * key is the shared session's `terminalKey`, so the name matches what the
 * launcher chose. A box too old to know the route reports `ok: false` rather
 * than a false "ended". */
export async function endWorkspaceTerminalSession(
  filesBase: string,
  kind: EndableSessionKind,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<EndTerminalSessionResult> {
  try {
    const response = await fetcher(endTerminalSessionUrl(filesBase), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key }),
    });
    if (!response.ok) return { ok: false };
    // SAFETY: Response.json parses JSON text; the boolean read below is guarded
    // (=== true), so a missing or non-boolean `ended` reads as false.
    const value = await response.json() as { ended?: unknown };
    return { ok: true, ended: value.ended === true };
  } catch {
    return { ok: false };
  }
}
