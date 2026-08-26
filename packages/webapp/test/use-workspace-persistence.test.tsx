import type { WorkspaceSessionView } from '@blitzos/schema';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAdapter } from '../src/api-adapter';
import { ApiRequestError, type ControlPlaneClient } from '../src/api';
import { defaultWorkspaceWebAppState, type WorkspaceWebAppStateV1 } from '../src/storage';
import { useWorkspacePersistence } from '../src/use-workspace-persistence';
import { appendTab } from '../src/workspace-panes';
import { render, settle } from './dom';

const session: WorkspaceSessionView = {
  id: 'session-1',
  workspaceId: 'workspace',
  kind: 'claude',
  title: null,
  terminalKey: 'session-1',
  chatSessionId: null,
  chatProvider: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

function seededDoc(): WorkspaceWebAppStateV1 {
  const state = defaultWorkspaceWebAppState();
  return {
    ...state,
    tabs: {
      ...state.tabs,
      tabs: state.tabs.tabs.map((tab) => tab.id === 1 ? { ...tab, sessionId: session.id } : tab),
    },
  };
}

/** A member view as the server holds it: one revision per membership,
 * regardless of how many browsers that member has open. */
function serverView() {
  const server = { revision: 1, doc: seededDoc() as WorkspaceWebAppStateV1 | null };
  const stub = {
    getWorkspaceWebAppState: vi.fn(async () => ({
      doc: server.doc,
      revision: server.revision,
      migratedFromV1: false,
      sessions: [session],
    })),
    putWorkspaceWebAppState: vi.fn(async (_id: string, doc: WorkspaceWebAppStateV1, revision: number) => {
      if (revision !== server.revision) {
        throw new ApiRequestError('workspace view changed; reload and retry', 409, null);
      }
      server.revision += 1;
      server.doc = doc;
      return { doc, revision: server.revision, migratedFromV1: false, sessions: [session] };
    }),
    listWorkspaceSessions: vi.fn(async () => ({ sessions: [session] })),
    createWorkspaceSession: vi.fn(async () => ({ session })),
  };
  // SAFETY: The persistence hook reaches only the four members stubbed here;
  // the rest of the wire client is never called by it.
  const api = new ApiAdapter(stub as unknown as ControlPlaneClient, () => undefined);
  return { server, stub, api };
}

function Probe({ api, onError }: { api: ApiAdapter; onError: (cause: Error) => void }) {
  const { workspaceTabs, setWorkspaceTabs } = useWorkspacePersistence(
    api,
    true,
    'workspace',
    // A fresh object each render, exactly like the workspace poll produces.
    { title: 'Title', serverName: 'server', agentDefault: 'claude', canCreateSessions: true },
    onError,
  );
  return (
    <button
      data-loaded={String(workspaceTabs.loaded)}
      onClick={() => setWorkspaceTabs((current) => ({
        ...current,
        value: appendTab(current.value, 'main', (id) => ({
          id,
          type: 'file',
          filePath: `/workspace/file-${id}.ts`,
        })),
      }))}
    >
      edit
    </button>
  );
}

async function waitForDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

describe('personal view persistence across two browsers of one member', () => {
  it('adopts the newer revision after a 409 and applies the local layout once', async () => {
    const { server, stub, api } = serverView();
    const onError = vi.fn();
    const view = await render(<Probe api={api} onError={onError} />);
    await settle();
    await settle();
    expect(view.container.querySelector('button')?.dataset.loaded).toBe('true');
    expect(stub.getWorkspaceWebAppState).toHaveBeenCalledTimes(1);

    // The member's other browser saved in the meantime.
    server.revision = 2;

    await act(async () => view.container.querySelector('button')?.click());
    await waitForDebounce();
    await settle();

    // Stale PUT → 409 → re-read → PUT against the fresh revision. No banner:
    // both layouts belong to the same person.
    expect(stub.putWorkspaceWebAppState).toHaveBeenCalledTimes(2);
    expect(stub.getWorkspaceWebAppState).toHaveBeenCalledTimes(2);
    expect(stub.putWorkspaceWebAppState.mock.calls.map(([, , revision]) => revision)).toEqual([1, 2]);
    expect(server.revision).toBe(3);
    expect(server.doc?.tabs.tabs.some((tab) => tab.type === 'file')).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    // The adopted revision is the one later saves build on.
    await act(async () => view.container.querySelector('button')?.click());
    await waitForDebounce();
    expect(stub.putWorkspaceWebAppState).toHaveBeenLastCalledWith('workspace', expect.anything(), 3);
    expect(onError).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('reports a refused save once and does not re-send it on every re-render', async () => {
    const { stub, api } = serverView();
    const onError = vi.fn();
    const view = await render(<Probe api={api} onError={onError} />);
    await settle();
    await settle();
    stub.putWorkspaceWebAppState.mockRejectedValue(
      new ApiRequestError('view references an invalid session', 400, null),
    );

    await act(async () => view.container.querySelector('button')?.click());
    await waitForDebounce();
    expect(stub.putWorkspaceWebAppState).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Every workspace poll re-renders the shell with fresh metadata. The
    // refused doc must not go out again, nor its error, until the next edit.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => view.root.render(<Probe api={api} onError={onError} />));
      await waitForDebounce();
    }
    expect(stub.putWorkspaceWebAppState).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // A real edit is a different doc and tries again.
    await act(async () => view.container.querySelector('button')?.click());
    await waitForDebounce();
    expect(stub.putWorkspaceWebAppState).toHaveBeenCalledTimes(2);

    await view.unmount();
  });
});

describe('shared-session registry polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  it('polls on the presence cadence and backs off while the control plane is down', async () => {
    const { stub, api } = serverView();
    const view = await render(<Probe api={api} onError={() => undefined} />);
    await flush();
    await flush();
    expect(view.container.querySelector('button')?.dataset.loaded).toBe('true');
    const polls = () => stub.listWorkspaceSessions.mock.calls.length;
    const initial = polls();
    expect(initial).toBeGreaterThanOrEqual(1);

    // Visible: every 5s.
    await act(async () => vi.advanceTimersByTime(4_999));
    expect(polls()).toBe(initial);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(polls()).toBe(initial + 1);

    // Hidden: every 30s, not 5s.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    const hidden = polls();
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(polls()).toBe(hidden);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(polls()).toBe(hidden + 1);

    // An outage backs off instead of knocking every interval.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    stub.listWorkspaceSessions.mockRejectedValue(new Error('offline'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await flush();
    const failedAt = polls();
    await act(async () => vi.advanceTimersByTime(999));
    expect(polls()).toBe(failedAt);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(polls()).toBe(failedAt + 1);
    await act(async () => vi.advanceTimersByTime(1_999));
    expect(polls()).toBe(failedAt + 1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(polls()).toBe(failedAt + 2);

    await view.unmount();
  });
});
