import { atom } from 'jotai';

export type LodyControlConnectionState =
  | 'idle'
  | 'connecting'
  | 'syncing'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'error';

export type LodyConnectionUiState = 'online' | 'loading' | 'offline' | 'reconnecting';

export const lodyControlConnectionStateAtom = atom<LodyControlConnectionState>('idle');

/**
 * Atom that tracks the browser's network status.
 * This provides a more immediate signal for offline detection than WebSocket state.
 *
 * Initial value is read from navigator.onLine. The RuntimeProvider updates this atom
 * when browser online/offline events fire.
 */
const getInitialOnlineState = () => {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
};
export const browserOnlineAtom = atom<boolean>(getInitialOnlineState());

/**
 * Whether the workspace runtime is still initializing locally.
 * This includes:
 * - Waiting for workspaceId (from cache or server)
 * - Creating the workspace runtime (IndexedDB / Loro repo)
 *
 * Goes false as soon as the local runtime is ready, independent of WebSocket
 * connection state (tracked by lodyControlConnectionStateAtom).
 */
export const runtimeInitializingAtom = atom<boolean>(true);

export const deriveLodyConnectionUiState = (args: {
  state: LodyControlConnectionState;
  runtimeInitializing?: boolean;
  browserOnline: boolean;
}): LodyConnectionUiState => {
  const { state, browserOnline } = args;

  if (state === 'online') return 'online';

  if (!browserOnline || state === 'offline') return 'offline';

  if (state === 'connecting' || state === 'syncing') return 'loading';

  if (state === 'reconnecting') return 'reconnecting';

  // 'idle' means connection hasn't been attempted yet (e.g. token not set).
  // With browser online, this is a transient startup state — show 'loading',
  // not 'offline'. True offline is caught by the !browserOnline check above.
  if (state === 'idle') return 'loading';

  return 'offline';
};

export const lodyConnectionUiStateAtom = atom<LodyConnectionUiState>((get) =>
  deriveLodyConnectionUiState({
    state: get(lodyControlConnectionStateAtom),
    runtimeInitializing: get(runtimeInitializingAtom),
    browserOnline: get(browserOnlineAtom),
  })
);
