import type { PresenceSnapshotResponse, PutPresenceConnectionRequest } from '@blitzos/schema';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api-adapter';
import { useOrgPresence, type PresenceApi } from '../src/use-org-presence';
import { render } from './dom';

const EMPTY_SNAPSHOT: PresenceSnapshotResponse = {
  serverTime: 1,
  expiresAfterMs: 35_000,
  truncated: false,
  members: [],
};

function api(): PresenceApi {
  return {
    putPresenceConnection: vi.fn(async () => undefined),
    deletePresenceConnection: vi.fn(async () => undefined),
    getPresence: vi.fn(async () => EMPTY_SNAPSHOT),
  };
}

function Probe({
  presenceApi,
  view,
  poll,
}: {
  presenceApi: PresenceApi;
  view: Pick<PutPresenceConnectionRequest, 'workspaceId' | 'surfaces' | 'focusedSurface'>;
  poll?: boolean;
}) {
  const snapshot = useOrgPresence(presenceApi, true, view, poll === undefined ? {} : { poll });
  return <div data-testid="snapshot">{snapshot?.serverTime ?? 'none'}</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

describe('organization presence lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    sessionStorage.clear();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports immediately, reacts to focus and visibility, and cleans up with keepalive', async () => {
    const presenceApi = api();
    const view = await render(<Probe presenceApi={presenceApi} view={{
      workspaceId: null,
      surfaces: [],
      focusedSurface: null,
    }} />);
    await flush();

    expect(presenceApi.putPresenceConnection).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ visible: true, focused: true }),
    );
    expect(presenceApi.getPresence).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toBe('1');

    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => window.dispatchEvent(new Event('blur')));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ visible: true, focused: false }),
    );

    setVisibility('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ visible: false, focused: false }),
    );

    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(presenceApi.deletePresenceConnection).toHaveBeenCalledWith(expect.any(String), true);
    await view.unmount();
    expect(presenceApi.deletePresenceConnection).toHaveBeenCalledWith(expect.any(String));
  });

  it('uses the documented heartbeat and hidden snapshot intervals', async () => {
    const presenceApi = api();
    const view = await render(<Probe presenceApi={presenceApi} view={{
      workspaceId: null,
      surfaces: [],
      focusedSurface: null,
    }} />);
    await flush();
    const initialHeartbeats = vi.mocked(presenceApi.putPresenceConnection).mock.calls.length;

    await act(async () => vi.advanceTimersByTime(14_999));
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(initialHeartbeats);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(initialHeartbeats + 1);

    setVisibility('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    const hiddenPolls = vi.mocked(presenceApi.getPresence).mock.calls.length;
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(presenceApi.getPresence).toHaveBeenCalledTimes(hiddenPolls);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(presenceApi.getPresence).toHaveBeenCalledTimes(hiddenPolls + 1);

    await view.unmount();
  });

  it('backs off after failures and refreshes immediately when navigation changes', async () => {
    const presenceApi = api();
    vi.mocked(presenceApi.putPresenceConnection)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const firstView = {
      workspaceId: null,
      surfaces: [],
      focusedSurface: null,
    };
    const view = await render(<Probe presenceApi={presenceApi} view={firstView} />);
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(999));
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(2);

    await act(async () => view.root.render(<Probe presenceApi={presenceApi} view={{
      workspaceId: 'workspace',
      surfaces: [{ kind: 'workspace' }],
      focusedSurface: 0,
    }} />));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ workspaceId: 'workspace' }),
    );
    expect(presenceApi.getPresence).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it('reports one step less after an outright rejection instead of retrying it', async () => {
    const presenceApi = api();
    vi.mocked(presenceApi.putPresenceConnection)
      .mockRejectedValueOnce(new ApiError('presence references an invalid session', 400))
      .mockResolvedValue(undefined);
    const view = await render(<Probe presenceApi={presenceApi} view={{
      workspaceId: 'workspace',
      surfaces: [{ kind: 'session', sessionId: 'archived-by-someone-else' }],
      focusedSurface: 0,
    }} />);
    await flush();
    // The rejection is answered with a different payload right away, not with
    // the same one after a backoff: the workspace alone, no surfaces.
    await act(async () => vi.advanceTimersByTime(0));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(2);
    expect(presenceApi.putPresenceConnection).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        workspaceId: 'workspace',
        surfaces: [{ kind: 'workspace' }],
        focusedSurface: 0,
      }),
    );

    // Losing the workspace itself (403) steps down to organization presence.
    vi.mocked(presenceApi.putPresenceConnection)
      .mockRejectedValueOnce(new ApiError('forbidden', 403))
      .mockResolvedValue(undefined);
    await act(async () => vi.advanceTimersByTime(15_000));
    await flush();
    await act(async () => vi.advanceTimersByTime(0));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ workspaceId: null, surfaces: [], focusedSurface: null }),
    );

    // A transport failure still backs off with the same payload.
    vi.mocked(presenceApi.putPresenceConnection).mockRejectedValueOnce(new Error('offline'));
    const before = vi.mocked(presenceApi.putPresenceConnection).mock.calls.length;
    await act(async () => vi.advanceTimersByTime(15_000));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(before + 1);
    await act(async () => vi.advanceTimersByTime(999));
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(before + 1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalledTimes(before + 2);

    await view.unmount();
  });

  it('keeps reporting but skips snapshot polling when the shell has no presence UI', async () => {
    const presenceApi = api();
    const view = await render(<Probe presenceApi={presenceApi} poll={false} view={{
      workspaceId: null,
      surfaces: [],
      focusedSurface: null,
    }} />);
    await flush();
    await act(async () => vi.advanceTimersByTime(60_000));
    await flush();
    expect(presenceApi.putPresenceConnection).toHaveBeenCalled();
    expect(presenceApi.getPresence).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe('none');
    await view.unmount();
  });

  it('keeps the last snapshot visible through a reconnect backoff', async () => {
    const presenceApi = api();
    vi.mocked(presenceApi.getPresence)
      .mockResolvedValueOnce(EMPTY_SNAPSHOT)
      .mockRejectedValueOnce(new Error('offline'));
    const view = await render(<Probe presenceApi={presenceApi} view={{
      workspaceId: null,
      surfaces: [],
      focusedSurface: null,
    }} />);
    await flush();
    expect(view.container.textContent).toBe('1');

    await act(async () => vi.advanceTimersByTime(5_000));
    await flush();
    expect(presenceApi.getPresence).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toBe('1');
    await view.unmount();
  });
});
