import type { PresenceSnapshotResponse, PutPresenceConnectionRequest } from '@blitzos/schema';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrgPresence, type PresenceApi } from '../src/use-org-presence';
import { render } from './dom';

const EMPTY_SNAPSHOT: PresenceSnapshotResponse = {
  serverTime: 1,
  expiresAfterMs: 35_000,
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
}: {
  presenceApi: PresenceApi;
  view: Pick<PutPresenceConnectionRequest, 'workspaceId' | 'surfaces' | 'focusedSurface'>;
}) {
  const snapshot = useOrgPresence(presenceApi, true, view);
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
});
