import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MANAGED_BUILTIN_RUNTIMES,
  type AgentConfigMeta,
  type BuiltinAgentType,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { useMachineAcpBinaryActions } from '@/hooks/use-machine-acp-binary-actions';
import type { DetectedAgent, DetectedAgentStatus } from './detected-agents';

// Probes the machine for the assistants it can run.
//
// This is the substance behind the zero-config provider step: instead of asking
// a first-run user to choose between assistants they have no basis to compare,
// we ask their machine what is already there and offer that.
//
// `machine/acp-binary-status` is the same call the settings screen uses to
// decide whether an agent needs downloading, so detection and the rest of the
// product agree by construction rather than through a second heuristic.

/** Probes run concurrently; this bounds how long the step can look busy. */
const DETECTION_TIMEOUT_MS = 12_000;

function toStatus(raw: string): DetectedAgentStatus {
  switch (raw) {
    case 'installed':
      return 'installed';
    case 'not-installed':
      return 'missing';
    case 'unsupported-platform':
    case 'incompatible-host':
      return 'unavailable';
    default:
      // 'not-applicable' means the agent does not use a managed binary, so
      // there is nothing to fetch and nothing blocking it.
      return 'installed';
  }
}

export function useDetectedAgents({
  runtime,
  workspaceId,
  machineId,
  existingConfigs,
}: {
  runtime: WorkspaceRuntime | null;
  workspaceId: WorkspaceId | null;
  machineId: MachineId | null;
  existingConfigs: AgentConfigMeta[];
}): {
  agents: DetectedAgent[];
  enabled: Record<string, boolean>;
  toggle: (agentType: BuiltinAgentType, next: boolean) => void;
  detecting: boolean;
} {
  const { checkBinaryStatus } = useMachineAcpBinaryActions(runtime, workspaceId);
  const [probes, setProbes] = useState<
    Record<string, { status: DetectedAgentStatus; detail?: string }>
  >({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const configuredTypes = useMemo(
    () =>
      new Set(
        existingConfigs.filter((config) => config.cliType === 'builtin').map((c) => c.agentType)
      ),
    [existingConfigs]
  );

  // Guards against a late probe from a previous machine overwriting a fresh
  // one — switching machines mid-detection would otherwise report the wrong
  // machine's binaries as if they were this one's.
  const generation = useRef(0);

  useEffect(() => {
    if (!runtime || workspaceId == null || machineId == null) return undefined;
    generation.current += 1;
    const mine = generation.current;
    setProbes({});

    let cancelled = false;
    const timer = window.setTimeout(() => {
      cancelled = true;
    }, DETECTION_TIMEOUT_MS);

    void Promise.all(
      MANAGED_BUILTIN_RUNTIMES.map(async (entry) => {
        try {
          const result = await checkBinaryStatus({ machineId, agentType: entry.agentType });
          if (cancelled || generation.current !== mine) return;
          setProbes((prev) => ({
            ...prev,
            [entry.agentType]: { status: toStatus(result.status), detail: result.version },
          }));
        } catch {
          if (cancelled || generation.current !== mine) return;
          // A failed probe is not a failed agent. Offering it as something we
          // can set up is the recoverable reading; marking it unavailable would
          // hide a working assistant behind a transient RPC error.
          setProbes((prev) => ({ ...prev, [entry.agentType]: { status: 'missing' } }));
        }
      })
    ).finally(() => window.clearTimeout(timer));

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runtime, workspaceId, machineId, checkBinaryStatus]);

  const agents = useMemo<DetectedAgent[]>(
    () =>
      MANAGED_BUILTIN_RUNTIMES.map((entry) => {
        const probe = probes[entry.agentType];
        return {
          agentType: entry.agentType,
          name: entry.displayName,
          status: probe?.status ?? 'checking',
          detail: probe?.detail,
          configured: configuredTypes.has(entry.agentType),
        };
      }),
    [probes, configuredTypes]
  );

  // Default: everything usable is on. The step's whole claim is "we found these
  // for you", so making the user switch them on one at a time would undo it.
  // An explicit choice always wins over the default.
  const enabled = useMemo(() => {
    const next: Record<string, boolean> = {};
    for (const agent of agents) {
      next[agent.agentType] =
        overrides[agent.agentType] ??
        (agent.configured || (agent.status !== 'unavailable' && agent.status !== 'checking'));
    }
    return next;
  }, [agents, overrides]);

  const toggle = useCallback((agentType: BuiltinAgentType, next: boolean) => {
    setOverrides((prev) => ({ ...prev, [agentType]: next }));
  }, []);

  return {
    agents,
    enabled,
    toggle,
    detecting: agents.some((agent) => agent.status === 'checking'),
  };
}
