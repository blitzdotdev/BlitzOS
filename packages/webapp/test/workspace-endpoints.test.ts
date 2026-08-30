import { describe, expect, it } from 'vitest';
import type { V2WorkspaceRecord } from '../src/api-adapter.js';
import {
  rememberWorkspaceEndpoints,
  terminalWebSocketUrl,
  type WorkspaceEndpoints,
} from '../src/workspace-endpoints.js';

function record(id: string): V2WorkspaceRecord {
  return {
    id,
    ingressLabel: `box-${id}`,
    wire: {
      id,
      machineTypeId: 'cx23@fsn1',
      phase: 'ready',
      retryAction: null,
      canObserve: true,
      launchable: true,
      revision: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ssh: null,
      volumeId: null,
      error: null,
    },
  } as V2WorkspaceRecord;
}

function endpointsAt(prefix: string) {
  return {
    terminalUrl: `https://box.example/${prefix}/terminal/?token=discarded#fragment`,
    filesBase: `https://box.example/${prefix}/workspace/`,
    lodySyncUrl: `wss://box.example/${prefix}/lody/sync`,
    lodyRpcUrl: `https://box.example/${prefix}/lody/rpc`,
    lodyControlUrl: `https://box.example/${prefix}/lody/control`,
    lodyProjectUrl: `https://box.example/${prefix}/lody/project`,
    lodyPlatformUrl: `https://box.example/${prefix}/lody/platform`,
  };
}

const resolver = {
  resolve: (wire: V2WorkspaceRecord['wire']) => endpointsAt(wire.id),
  resolveShared: (wire: V2WorkspaceRecord['wire'], ownerMembershipId: string) =>
    endpointsAt(`${wire.id}/shared/${ownerMembershipId}`),
  previewUrl: () => '',
};

describe('workspace endpoint selection', () => {
  it('converts the terminal URL to its websocket endpoint without query or hash', () => {
    expect(terminalWebSocketUrl('https://box.example/terminal/?token=x#fragment')).toBe(
      'wss://box.example/terminal/ws',
    );
  });

  it('merges incremental records and prunes stale records only for authoritative refreshes', () => {
    const entries = new Map<string, WorkspaceEndpoints>();
    rememberWorkspaceEndpoints(entries, [record('one'), record('two')], resolver);
    rememberWorkspaceEndpoints(entries, [record('three')], resolver);
    expect([...entries.keys()]).toEqual(['one', 'two', 'three']);

    rememberWorkspaceEndpoints(entries, [record('two')], resolver, true);
    expect([...entries.keys()]).toEqual(['two']);
    expect(entries.get('two')).toMatchObject({
      label: 'box-two',
      terminalUrl: 'wss://box.example/two/terminal/ws',
    });
  });
});
