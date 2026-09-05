import { gatewayEndpointUrl } from './preview';
import type { ManagedWorkspaceTab } from './storage';

/** The box door that ends the tmux session behind one terminal tab. */
export function terminalKillEndpointUrl(filesBase: string): string {
  return gatewayEndpointUrl(filesBase, 'terminal/kill');
}

/**
 * Ends the tmux session a terminal tab attaches to.
 *
 * A CLOSE is the only caller. Every other way a terminal stops being on screen
 * — a reload, a workspace switch, a lost tunnel, a hidden tab — must leave the
 * session running, because re-attach is the normal path and the scrollback is
 * the member's work (plans/LODY-TERMINAL-TABS.md §4.4).
 *
 * The caller removes the tab first, then uses this answer to keep the close or
 * restore the tab. The box treats an absent tmux session as success, so false
 * means the close could not be confirmed rather than "already gone."
 */
export async function killTerminalSession(
  filesBase: string,
  session: { type: ManagedWorkspaceTab['type']; key: string },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(terminalKillEndpointUrl(filesBase), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: session.type, key: session.key }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
