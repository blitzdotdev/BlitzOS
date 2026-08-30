import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { userEvent, within } from 'storybook/test';
import type { MachineId, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';

import { runtimeAtom, userAtom, type WorkspaceRuntime } from '@/atoms';
import { SessionBrowserPanel } from '@/components/sessions/session-browser-panel';

const session: SessionMeta = {
  id: 'session-browser' as SessionId,
  machineId: 'machine-browser' as MachineId,
  createdAt: '2026-07-20T00:00:00.000Z',
  userId: 'user-1',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
};

const createSessionStore = () => ({
  sessionId: session.id,
  roomId: `session:${session.id}`,
  doc: null,
  firstSynced: Promise.resolve(),
  acquireSync: () => () => {},
  getSyncState: () => 'synced' as const,
  subscribeSyncState: () => () => {},
  getState: () => ({ session: { id: session.id }, history: [], mq: [] }),
  setState: () => {},
  subscribe: () => () => {},
  dispose: () => {},
  waitUntilSynced: async () => {},
});

const connectingRemoteRuntime = {
  workspaceSlug: 'workspace-browser',
  workspaceId: 'workspace-browser-id' as WorkspaceId,
  acquireSessionStore: async () => createSessionStore(),
  releaseSessionStoreRef: () => {},
  resolveMachineTargetPlane: async () => 'cloud' as const,
  requestSessionPreviewCreate: async () => await new Promise<never>(() => {}),
  requestSessionPreviewEndpointAcquire: async () => null,
  requestSessionPreviewEndpointRelease: async (
    _machineId: MachineId,
    _sessionId: SessionId,
    endpointId: string
  ) => ({
    type: 'session/preview-endpoint-release_response' as const,
    sessionId: session.id,
    endpointId,
    success: true as const,
  }),
  requestSessionPreviewRevoke: async () => null,
} as unknown as WorkspaceRuntime;

function StoryShell({ runtime = null }: { runtime?: WorkspaceRuntime | null }) {
  const store = createStore();
  store.set(userAtom, { id: 'user-1', name: 'Browser User', email: 'browser@example.com' });
  store.set(runtimeAtom, runtime);
  return (
    <Provider store={store}>
      <div className="h-[calc(100vh-2rem)] max-h-[640px] w-[calc(100vw-2rem)] max-w-[860px] border border-border bg-background">
        <SessionBrowserPanel session={session} />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Sessions/SessionBrowserPanel',
  component: StoryShell,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const ConnectingRemote: Story = {
  args: { runtime: connectingRemoteRuntime },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Address' }), '127.0.0.1:5173');
    await userEvent.keyboard('{Enter}');
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'Confirm' }));
    await canvas.findByText('Establishing a secure preview connection…');
  },
};
