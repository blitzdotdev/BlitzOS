import { describe, expect, it } from 'vitest';
import {
  findLatestMachineMonitorSnapshot,
  getMachineMonitorObserverKey,
  parseMachineMonitorStates,
  toLodyMachineMonitorStreamUrl,
  type MachineId,
  type MachineMonitorSnapshot,
} from '../src';

const MACHINE_ID = 'machine-1' as MachineId;

describe('machine monitor protocol', () => {
  it('parses valid state and drops untrusted invalid state', () => {
    const snapshot = makeSnapshot(10);
    snapshot.deviceCpuCores = 2;
    snapshot.cliControlPlane.memoryKind = 'physical-footprint';
    snapshot.sessionsAggregate.memoryKind = 'physical-footprint-sum';
    const states = parseMachineMonitorStates({ valid: snapshot, invalid: { kind: 'snapshot' } });
    expect(states).toEqual({ valid: snapshot });
  });

  it('selects the newest snapshot for a machine', () => {
    const states = parseMachineMonitorStates({ older: makeSnapshot(10), newer: makeSnapshot(20) });
    expect(findLatestMachineMonitorSnapshot(states, MACHINE_ID)?.updatedAtMs).toBe(20);
  });

  it('uses an isolated ephemeral channel and stable observer keys', () => {
    expect(toLodyMachineMonitorStreamUrl('https://example.com/stream?foo=bar')).toContain(
      'ephemeral=machine-monitor'
    );
    expect(getMachineMonitorObserverKey(MACHINE_ID, 'viewer')).toBe('observer:machine-1:viewer');
  });
});

function makeSnapshot(updatedAtMs: number): MachineMonitorSnapshot {
  const resource = {
    memoryBytes: 1,
    cpuCores: null,
    cpuPercentOfMachine: null,
    processCount: 1,
    memoryKind: 'rss' as const,
    quality: 'exact-process' as const,
  };
  return {
    kind: 'snapshot',
    protocolVersion: 1,
    machineId: MACHINE_ID,
    instanceId: 'instance-1',
    updatedAtMs,
    sampleWindowMs: null,
    platform: 'linux',
    cpuLogicalCores: 8,
    effectiveMemoryBytes: 100,
    availableMemoryBytes: 50,
    sessionAccounting: 'cgroup-v2',
    cliControlPlane: resource,
    sessionsAggregate: { ...resource, memoryKind: 'rss-sum' },
    sessions: [],
    sessionsTruncated: false,
    warnings: [],
  };
}
