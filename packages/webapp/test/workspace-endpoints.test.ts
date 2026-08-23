import { describe, expect, it } from 'vitest';
import type { WorkspaceView } from '@blitzos/schema';
import type { BoxEndpoints } from '../src/resolver.js';
import {
  rememberWorkspaceEndpoints,
  terminalWebSocketUrl,
} from '../src/workspace-endpoints.js';

function record(id: string): WorkspaceView {
  return {
    id,
    name: `box-${id}`,
    machineTypeId: 'cx23@fsn1',
    phase: 'ready',
    retryAction: null,
    canObserve: true,
    launchable: true,
    revision: 1,
    ssh: null,
    volumeId: null,
    error: null,
    role: 'owner',
    orgShareRole: null,
    owner: { name: 'Owner', avatarUrl: null },
    environment: null,
    agentRuleId: null,
    connections: [],
  };
}

const resolver = {
  resolve: (wire: WorkspaceView) => ({
    terminalUrl: `https://box.example/${wire.id}/terminal/?token=discarded#fragment`,
    acpUrl: `wss://box.example/${wire.id}/acp`,
    filesBase: `https://box.example/${wire.id}/workspace/`,
  }),
  previewUrl: () => '',
};

describe('workspace endpoint selection', () => {
  it('converts the terminal URL to its websocket endpoint without query or hash', () => {
    expect(terminalWebSocketUrl('https://box.example/terminal/?token=x#fragment')).toBe(
      'wss://box.example/terminal/ws',
    );
  });

  it('merges incremental records and prunes stale records only for authoritative refreshes', () => {
    const entries = new Map<string, BoxEndpoints>();
    rememberWorkspaceEndpoints(entries, [record('one'), record('two')], resolver);
    rememberWorkspaceEndpoints(entries, [record('three')], resolver);
    expect([...entries.keys()]).toEqual(['one', 'two', 'three']);

    rememberWorkspaceEndpoints(entries, [record('two')], resolver, true);
    expect([...entries.keys()]).toEqual(['two']);
    expect(entries.get('two')).toMatchObject({
      terminalUrl: 'wss://box.example/two/terminal/ws',
    });
  });
});
