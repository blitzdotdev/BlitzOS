import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { runStartupAcpCapabilitiesRefresh } from '../src/providers/startup-acp-capabilities-refresh';

const config = (id: string, machineId: MachineId): AgentConfigMeta => ({
  id: id as AgentConfigMeta['id'],
  machineId,
  name: id,
  cliType: 'builtin',
  agentType: id,
  env: {},
  prompt: '',
});

describe('runStartupAcpCapabilitiesRefresh', () => {
  it('refreshes every config and continues after per-config failures', async () => {
    const machine1 = 'machine-1' as MachineId;
    const machine2 = 'machine-2' as MachineId;
    const configs = new Map([
      [machine1, [config('first', machine1), config('second', machine1)]],
      [machine2, [config('third', machine2)]],
    ]);
    const refreshed: string[] = [];
    const onError = vi.fn();

    await runStartupAcpCapabilitiesRefresh({
      listMachineIds: async () => [machine1, machine2],
      isMachineOnline: () => true,
      listAgentConfigs: async (machineId) => configs.get(machineId) ?? [],
      refreshAgentConfig: async (_machineId, agentConfig) => {
        refreshed.push(agentConfig.id);
        if (agentConfig.id === 'first') {
          throw new Error('probe failed');
        }
      },
      onError,
    });

    expect(refreshed).toEqual(expect.arrayContaining(['first', 'second', 'third']));
    expect(refreshed.indexOf('second')).toBeGreaterThan(refreshed.indexOf('first'));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      machineId: machine1,
      configId: 'first',
    });
  });

  it('does not route a config through a different machine than its owning document', async () => {
    const sourceMachineId = 'machine-source' as MachineId;
    const targetMachineId = 'machine-target' as MachineId;
    const refreshed: Array<{ machineId: MachineId; configId: string }> = [];
    const errors: Array<{ machineId: MachineId; configId?: string }> = [];

    await runStartupAcpCapabilitiesRefresh({
      listMachineIds: async () => [sourceMachineId],
      isMachineOnline: () => true,
      listAgentConfigs: async () => [config('foreign-config', targetMachineId)],
      refreshAgentConfig: async (machineId, agentConfig) => {
        refreshed.push({ machineId, configId: agentConfig.id });
      },
      onError: (_error, context) => errors.push(context),
    });

    expect(refreshed).toEqual([]);
    expect(errors).toEqual([{ machineId: sourceMachineId, configId: 'foreign-config' }]);
  });

  it('limits concurrent machine refreshes while keeping each machine serial', async () => {
    const machineIds = ['machine-1', 'machine-2', 'machine-3'] as MachineId[];
    let activeMachines = 0;
    let maxActiveMachines = 0;
    const releases: Array<() => void> = [];

    const run = runStartupAcpCapabilitiesRefresh(
      {
        listMachineIds: async () => machineIds,
        isMachineOnline: () => true,
        listAgentConfigs: async (machineId) => [config(`${machineId}-agent`, machineId)],
        refreshAgentConfig: async () => {
          activeMachines += 1;
          maxActiveMachines = Math.max(maxActiveMachines, activeMachines);
          await new Promise<void>((resolve) => releases.push(resolve));
          activeMachines -= 1;
        },
      },
      { machineConcurrency: 2 }
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await run;

    expect(maxActiveMachines).toBe(2);
  });

  it('skips machines that are offline when the one-shot scan starts', async () => {
    const onlineMachine = 'machine-online' as MachineId;
    const offlineMachine = 'machine-offline' as MachineId;
    const listed: MachineId[] = [];
    const refreshed: string[] = [];

    await runStartupAcpCapabilitiesRefresh({
      listMachineIds: async () => [onlineMachine, offlineMachine],
      isMachineOnline: (machineId) => machineId === onlineMachine,
      listAgentConfigs: async (machineId) => {
        listed.push(machineId);
        return [config(`${machineId}-agent`, machineId)];
      },
      refreshAgentConfig: async (_machineId, agentConfig) => {
        refreshed.push(agentConfig.id);
      },
    });

    expect(listed).toEqual([onlineMachine]);
    expect(refreshed).toEqual(['machine-online-agent']);
  });

  it('stops refreshing a machine when it goes offline during the pass', async () => {
    const machineId = 'machine-online-then-offline' as MachineId;
    let online = true;
    const refreshed: string[] = [];

    await runStartupAcpCapabilitiesRefresh({
      listMachineIds: async () => [machineId],
      isMachineOnline: () => online,
      listAgentConfigs: async () => [config('first', machineId), config('second', machineId)],
      refreshAgentConfig: async (_machineId, agentConfig) => {
        refreshed.push(agentConfig.id);
        online = false;
      },
    });

    expect(refreshed).toEqual(['first']);
  });

  it('cancels an in-flight wait before starting the next config', async () => {
    const machineId = 'machine-disconnected-during-refresh' as MachineId;
    const abortController = new AbortController();
    const refreshed: string[] = [];
    const onError = vi.fn();
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const run = runStartupAcpCapabilitiesRefresh(
      {
        listMachineIds: async () => [machineId],
        isMachineOnline: () => true,
        listAgentConfigs: async () => [config('first', machineId), config('second', machineId)],
        refreshAgentConfig: async (_machineId, agentConfig, signal) => {
          refreshed.push(agentConfig.id);
          if (agentConfig.id !== 'first') return;
          markFirstStarted();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        onError,
      },
      { signal: abortController.signal }
    );

    await firstStarted;
    abortController.abort();
    await run;

    expect(refreshed).toEqual(['first']);
    expect(onError).not.toHaveBeenCalled();
  });
});
