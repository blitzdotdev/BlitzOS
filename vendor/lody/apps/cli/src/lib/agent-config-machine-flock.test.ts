import { describe, expect, it, vi } from 'vitest';
import {
  getAgentConfigRoomId,
  getMachineFlockDocId,
  machineFlockKeys,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { mergeAgentConfigs, readMergedAgentConfigById } from './agent-config-machine-flock';

const createAgentConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta => ({
  id: 'agent-config-id',
  machineId: 'machine-id',
  name: 'Codex Default',
  description: undefined,
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  ...overrides,
});

describe('agent-config machine flock helpers', () => {
  it('merges loro-repo meta configs with machine flock configs and prefers machine flock', () => {
    const legacyConfig = createAgentConfig({
      id: 'shared',
      name: 'Legacy',
      env: { SOURCE: 'legacy' },
    });
    const machineFlockConfig = createAgentConfig({
      id: 'shared',
      name: 'Machine Flock',
      env: { SOURCE: 'machine-flock' },
    });
    const otherLegacyConfig = createAgentConfig({
      id: 'legacy-only',
      name: 'Legacy Only',
    });

    expect(mergeAgentConfigs([legacyConfig, otherLegacyConfig], [machineFlockConfig])).toEqual([
      machineFlockConfig,
      otherLegacyConfig,
    ]);
  });

  it('reads one Machine Flock row by exact config id without scanning repo meta', async () => {
    const workspaceId = 'workspace-id' as WorkspaceId;
    const machineId = 'machine-id' as MachineId;
    const agentConfigId = 'target-config' as AgentConfigId;
    const config = createAgentConfig({ id: agentConfigId, machineId });
    const rows = [
      { key: machineFlockKeys.agentConfig(agentConfigId), value: config },
      {
        key: machineFlockKeys.agentConfig('unrelated-config' as AgentConfigId),
        value: createAgentConfig({ id: 'unrelated-config' }),
      },
    ];
    const scan = vi.fn((options?: { prefix?: readonly unknown[] }) => {
      const prefix = options?.prefix;
      return prefix
        ? rows.filter((row) => prefix.every((part, index) => row.key[index] === part))
        : rows;
    });
    const getDocMeta = vi.fn();
    const getMeta = vi.fn(() => {
      throw new Error('repo meta enumeration is forbidden for point lookup');
    });
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock: { scan } })),
      getDocMeta,
      getMeta,
    };

    await expect(
      readMergedAgentConfigById(repo as never, workspaceId, machineId, agentConfigId)
    ).resolves.toEqual({ config, source: 'machine-flock' });

    expect(repo.openFlockDoc).toHaveBeenCalledWith(getMachineFlockDocId(workspaceId, machineId));
    expect(scan).toHaveBeenCalledWith({ prefix: machineFlockKeys.agentConfig(agentConfigId) });
    expect(getDocMeta).not.toHaveBeenCalled();
    expect(getMeta).not.toHaveBeenCalled();
  });

  it('falls back to one legacy repo-meta document lookup by config id', async () => {
    const workspaceId = 'workspace-id' as WorkspaceId;
    const machineId = 'machine-id' as MachineId;
    const agentConfigId = 'legacy-config' as AgentConfigId;
    const legacyConfig = createAgentConfig({ id: agentConfigId, machineId });
    const scan = vi.fn((_options?: { prefix?: readonly unknown[] }) => []);
    const getDocMeta = vi.fn(async () => ({ meta: legacyConfig }));
    const getMeta = vi.fn(() => {
      throw new Error('repo meta enumeration is forbidden for point lookup');
    });
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock: { scan } })),
      getDocMeta,
      getMeta,
    };

    await expect(
      readMergedAgentConfigById(repo as never, workspaceId, machineId, agentConfigId)
    ).resolves.toEqual({ config: legacyConfig, source: 'legacy-repo-meta' });

    expect(getDocMeta).toHaveBeenCalledOnce();
    expect(getDocMeta).toHaveBeenCalledWith(getAgentConfigRoomId(agentConfigId));
    expect(getMeta).not.toHaveBeenCalled();
  });
});
