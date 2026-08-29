import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { createAsyncConcurrencyGate } from '@/lib/async-concurrency-gate';

export type StartupAcpCapabilitiesRefreshPorts = {
  listMachineIds: () => Promise<MachineId[]>;
  isMachineOnline: (machineId: MachineId) => boolean;
  listAgentConfigs: (machineId: MachineId) => Promise<AgentConfigMeta[]>;
  refreshAgentConfig: (
    machineId: MachineId,
    config: AgentConfigMeta,
    signal?: AbortSignal
  ) => Promise<void>;
  onError?: (error: unknown, context: { machineId: MachineId; configId?: string }) => void;
};

/**
 * Refresh every configured ACP on online machines once, serializing configs per machine.
 *
 * Connection invariant: callers must reuse the workspace runtime's existing Machine
 * Flock and RPC transports. This pass may add bounded RPC work, but it must never
 * create or retain one Streams subscription per agent config or refresh request.
 */
export async function runStartupAcpCapabilitiesRefresh(
  ports: StartupAcpCapabilitiesRefreshPorts,
  options: { machineConcurrency?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) return;
  const listedMachineIds = await ports.listMachineIds();
  if (signal?.aborted) return;
  const machineIds = listedMachineIds.filter(ports.isMachineOnline);
  const runMachine = createAsyncConcurrencyGate(options.machineConcurrency ?? 2);

  await Promise.all(
    machineIds.map((machineId) =>
      runMachine(async () => {
        if (signal?.aborted || !ports.isMachineOnline(machineId)) return;

        let configs: AgentConfigMeta[];
        try {
          configs = await ports.listAgentConfigs(machineId);
        } catch (error) {
          if (signal?.aborted) return;
          ports.onError?.(error, { machineId });
          return;
        }

        for (const config of configs) {
          if (signal?.aborted || !ports.isMachineOnline(machineId)) return;
          if (config.machineId !== machineId) {
            ports.onError?.(new Error('Agent config belongs to a different machine'), {
              machineId,
              configId: config.id,
            });
            continue;
          }
          try {
            await ports.refreshAgentConfig(machineId, config, signal);
          } catch (error) {
            if (signal?.aborted) return;
            ports.onError?.(error, { machineId, configId: config.id });
          }
        }
      })
    )
  );
}
