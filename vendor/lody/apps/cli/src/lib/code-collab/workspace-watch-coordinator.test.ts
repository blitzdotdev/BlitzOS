import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { getLogger } from '@/utils/logger';
import {
  WorkspaceWatchCoordinator,
  buildWorkspaceWatchWorkerEnvironment,
} from './workspace-watch-coordinator';

class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  pid = 1234;
  readonly sent: unknown[] = [];
  send(message: unknown): boolean {
    this.sent.push(message);
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'code-collab-watch/shutdown'
    ) {
      this.connected = false;
      queueMicrotask(() => this.emit('exit', 0, null));
    }
    return true;
  }
  kill(): boolean {
    return true;
  }
}

describe('WorkspaceWatchCoordinator', () => {
  it('shares a canonical root and ignores stale generation messages', async () => {
    const children: FakeChild[] = [];
    const dirtyA = vi.fn();
    const dirtyB = vi.fn();
    const coordinator = new WorkspaceWatchCoordinator(getLogger('workspace-watch-test'), {
      realpath: async () => '/canonical/workspace',
      childLauncher: () => {
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
      restartDelayMs: () => 1_000,
    });

    const first = await coordinator.subscribe({
      workspaceId: 'workspace-a',
      ownerSessionId: 'owner-a',
      workspaceRoot: '/alias-a',
      onDirty: dirtyA,
    });
    const second = await coordinator.subscribe({
      workspaceId: 'workspace-b',
      ownerSessionId: 'owner-b',
      workspaceRoot: '/alias-b',
      onDirty: dirtyB,
    });
    const child = children[0];
    expect(child?.sent.at(-1)).toMatchObject({ roots: ['/canonical/workspace'] });
    const revision = coordinator.getSnapshot().revision;
    child?.emit('message', {
      type: 'code-collab-watch/ready',
      generation: 1,
      revision,
      watchedRoots: ['/canonical/workspace'],
    });
    expect(dirtyA).toHaveBeenCalledWith('coverage');
    expect(dirtyB).toHaveBeenCalledWith('coverage');

    child?.emit('message', {
      type: 'code-collab-watch/dirty',
      generation: 0,
      root: '/canonical/workspace',
    });
    expect(dirtyA).toHaveBeenCalledTimes(1);
    child?.emit('message', {
      type: 'code-collab-watch/stats',
      generation: 1,
      watcherCount: 1,
      rssBytes: 12_345,
      reconfigurationCount: 2,
      uptimeMs: 3_000,
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      actualWatcherCount: 1,
      childRssBytes: 12_345,
      childUptimeMs: 3_000,
    });
    first?.release();
    expect(child?.sent.at(-1)).toMatchObject({ roots: ['/canonical/workspace'] });
    second?.release();
    await coordinator.dispose();
  });

  it('does not forward representative credentials or NODE_OPTIONS', () => {
    expect(
      buildWorkspaceWatchWorkerEnvironment({
        PATH: '/bin',
        LANG: 'en_US.UTF-8',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        GH_TOKEN: 'secret',
        LODY_SUPERVISOR_TOKEN: 'secret',
        OPENAI_API_KEY: 'secret',
      })
    ).toEqual({
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});
