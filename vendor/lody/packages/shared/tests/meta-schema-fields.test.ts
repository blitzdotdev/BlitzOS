import { describe, expect, it } from 'vitest';

import { resolveActiveAssistantTurnId, type MachineMeta, type SessionMeta } from '../src/schema';
import {
  MACHINE_PROTOCOL_CAPABILITIES,
  getMachineProtocolCapabilityVersion,
  machineSupportsProtocolCapability,
} from '../src/machine-protocol-capabilities';

describe('meta schema fields', () => {
  it('keeps legacy session meta shape readable', () => {
    const legacy: SessionMeta = {
      id: 'session-1',
      machineId: 'machine-1',
      createdAt: '2026-03-19T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
    };

    expect(legacy.latestUserMsgId).toBeUndefined();
    expect(legacy.lastCanceledTurn).toBeUndefined();
    expect(legacy.lastHandledUserMsgId).toBeUndefined();
    expect(legacy.processingUserMsgId).toBeUndefined();
    expect(legacy.lastMissingHistoryUserMsgId).toBeUndefined();
  });

  it('accepts dispatch-driven session meta fields', () => {
    const meta: SessionMeta = {
      id: 'session-2',
      machineId: 'machine-2',
      createdAt: '2026-03-19T00:00:00.000Z',
      userId: 'user-2',
      cliType: 'builtin',
      agentType: 'codex',
      latestUserMsgId: 'turn-2',
      lastCanceledTurn: 'assistant-turn-2',
      lastHandledUserMsgId: 'turn-1',
      processingUserMsgId: 'turn-2',
      lastMissingHistoryUserMsgId: 'turn-missing',
    };

    expect(meta.latestUserMsgId).toBe('turn-2');
    expect(meta.lastCanceledTurn).toBe('assistant-turn-2');
    expect(meta.lastHandledUserMsgId).toBe('turn-1');
    expect(meta.processingUserMsgId).toBe('turn-2');
    expect(meta.lastMissingHistoryUserMsgId).toBe('turn-missing');
  });

  it('keeps deleted bulky legacy fields out of writable session meta', () => {
    const base = {
      id: 'session-legacy',
      machineId: 'machine-legacy',
      createdAt: '2026-03-19T00:00:00.000Z',
      userId: 'user-legacy',
      cliType: 'builtin',
      agentType: 'codex',
    } satisfies SessionMeta;

    const compactDiffStats = {
      ...base,
      diffStats: { allChange: { add: 1, del: 2 } },
    } satisfies SessionMeta;
    expect(compactDiffStats.diffStats.allChange).toEqual({ add: 1, del: 2 });

    const legacyDispatchError = {
      ...base,
      // @ts-expect-error dispatchError is a deleted legacy session meta field.
      dispatchError: { code: 'dispatch_failed', at: 1 },
    } satisfies SessionMeta;
    expect((legacyDispatchError as Record<string, unknown>).dispatchError).toBeDefined();

    const legacyCancelMarker = {
      ...base,
      // @ts-expect-error cancelRequestedAt is a deleted legacy session meta field.
      cancelRequestedAt: 1,
    } satisfies SessionMeta;
    expect((legacyCancelMarker as Record<string, unknown>).cancelRequestedAt).toBe(1);

    const legacyDiffStats = {
      ...base,
      diffStats: {
        allChange: { add: 1, del: 2 },
        // @ts-expect-error path-level diffStats metadata was removed.
        files: [],
      },
    } satisfies SessionMeta;
    expect((legacyDiffStats.diffStats as Record<string, unknown>).files).toEqual([]);
  });

  it('resolves the latest unfinished assistant turn id from history', () => {
    expect(
      resolveActiveAssistantTurnId([
        {
          id: 'assistant-turn-1',
          role: 'assistant',
          finished: true,
          endedAt: 123,
        },
        {
          id: 'assistant-turn-2',
          role: 'assistant',
        },
      ])
    ).toBe('assistant-turn-2');

    expect(
      resolveActiveAssistantTurnId([
        {
          id: 'assistant-turn-3',
          role: 'assistant',
          finished: true,
          endedAt: 456,
        },
      ])
    ).toBeUndefined();
  });

  it('accepts machine rpc capability fields', () => {
    const machine: MachineMeta = {
      id: 'machine-1',
      name: 'Machine',
      cliVersion: '0.0.0',
      os: 'linux',
      sessions: [],
      rpcVersion: '0',
    };

    expect(machine.rpcVersion).toBe('0');
  });

  it('negotiates versioned machine protocols without relying on CLI versions', () => {
    const legacyMachine = { protocolCapabilities: undefined };
    const currentMachine = {
      protocolCapabilities: {
        [MACHINE_PROTOCOL_CAPABILITIES.providerSetup]: 1,
        futureProtocol: 3,
      },
    };

    expect(
      machineSupportsProtocolCapability(legacyMachine, MACHINE_PROTOCOL_CAPABILITIES.providerSetup)
    ).toBe(false);
    expect(
      machineSupportsProtocolCapability(currentMachine, MACHINE_PROTOCOL_CAPABILITIES.providerSetup)
    ).toBe(true);
    expect(getMachineProtocolCapabilityVersion(currentMachine, 'futureProtocol')).toBe(3);
    expect(machineSupportsProtocolCapability(currentMachine, 'futureProtocol', 4)).toBe(false);
  });
});
