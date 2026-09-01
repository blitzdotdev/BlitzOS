import { describe, expect, it, vi } from 'vitest';
import { EphemeralStore, type Value } from 'loro-crdt';
import {
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  bytesToBase64,
  getMachineMonitorSnapshotKey,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
  type MachineId,
  type MachineMonitorSnapshot,
  type WorkspaceId,
} from '@lody/shared';
import { WorkspaceLocalMachineMonitorTransport } from '../src/providers/workspace-local-machine-monitor-transport';

const WORKSPACE_ID = 'workspace-1' as WorkspaceId;
const MACHINE_ID = 'machine-1' as MachineId;

describe('WorkspaceLocalMachineMonitorTransport', () => {
  it('publishes observer leases locally and delivers CLI snapshots', () => {
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    const messageListeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const transport = new WorkspaceLocalMachineMonitorTransport({
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      connection: {
        send: (message) => sent.push(message),
        onMessage: (listener) => {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onStatusChange: (listener) => {
          listener(true);
          return () => {};
        },
        isConnected: () => true,
      },
    });
    const listener = vi.fn();
    const unsubscribe = transport.subscribeMachine(MACHINE_ID, listener);

    expect(sent.some((message) => message.type === 'machine-monitor')).toBe(true);

    const snapshot = makeSnapshot();
    const store = new EphemeralStore(30_000);
    store.set(
      getMachineMonitorSnapshotKey(MACHINE_ID, snapshot.instanceId),
      snapshot as unknown as Value
    );
    const message: LocalLoroDataPlaneServerMessage = {
      type: 'machine-monitor',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: WORKSPACE_ID,
      dataBase64: bytesToBase64(store.encodeAll()),
    };
    for (const notify of messageListeners) notify(message);

    expect(listener).toHaveBeenLastCalledWith(snapshot);
    unsubscribe();
    transport.stop();
    store.destroy();
  });
});

function makeSnapshot(): MachineMonitorSnapshot {
  const resource = {
    memoryBytes: 1,
    cpuCores: 0,
    cpuPercentOfMachine: 0,
    processCount: 1,
    memoryKind: 'rss' as const,
    quality: 'exact-process' as const,
  };
  return {
    kind: 'snapshot',
    protocolVersion: 1,
    machineId: MACHINE_ID,
    instanceId: 'instance-1',
    updatedAtMs: 1,
    sampleWindowMs: 1,
    platform: 'linux',
    cpuLogicalCores: 1,
    effectiveMemoryBytes: 1,
    availableMemoryBytes: 1,
    sessionAccounting: 'process-tree',
    cliControlPlane: resource,
    sessionsAggregate: resource,
    sessions: [],
    sessionsTruncated: false,
    warnings: [],
  };
}
