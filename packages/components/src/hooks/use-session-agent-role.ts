import { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { AgentRoleId, SessionId } from '@lody/shared';

import { getAllAgentConfigAtom } from '@/atoms/agents';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import {
  isAgentRoleRunConfigApplied,
  selectSessionAgentRoles,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';
import { useWorkspaceAgentRoles } from '@/hooks/use-workspace-agent-roles';

export type SessionAgentRoleControl = {
  items: ComposerAgentRoleItem[];
  /** The Role this session's run config still IS, not merely the last picked. */
  selectedRoleId: AgentRoleId | null;
  onSelect: (roleId: AgentRoleId | null) => void;
};

/**
 * The Role row for an EXISTING session's composer.
 *
 * A live session's agent is fixed, so this is deliberately not the landing's
 * feature. It offers only Roles bound to an agent of the same TYPE and applies
 * only their RUN CONFIG — model, reasoning, permission, and whatever else that
 * agent publishes — because those are exactly the values that transfer between
 * configs of one type and exactly the values a session can still change per
 * turn. The Role's machine, config, and instruction are not applied and are not
 * claimed to be.
 *
 * Applied by calling the composer's own change callbacks rather than through a
 * preference channel: this surface has no reconcile pass to seed, and a value
 * the agent does not support is skipped rather than forced in.
 */
export function useSessionAgentRole({
  sessionId,
  provenanceRoleId,
  agentType,
  modelOptions,
  selectedModelId,
  onModelChange,
  modeOptions,
  selectedModeId,
  onModeChange,
  configOptionSelectors,
  configOptionValues,
  onConfigOptionChange,
}: {
  sessionId: SessionId;
  /** Role that created this session; seeds only the composer's display name. */
  provenanceRoleId?: AgentRoleId;
  agentType: string | null | undefined;
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  onModelChange?: (value: string) => void;
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  onModeChange?: (value: string) => void;
  configOptionSelectors: ReadonlyArray<AcpConfigOptionSelector>;
  configOptionValues: Record<string, AcpConfigOptionValue | undefined> | undefined;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
}): SessionAgentRoleControl {
  const { roles } = useWorkspaceAgentRoles();
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const items = useMemo(
    () => selectSessionAgentRoles({ roles, agentType, agentConfigs }),
    [agentConfigs, agentType, roles]
  );

  /* Which Role was picked, as a NAME. A newly created session starts with its
     provenance Role, while an explicit choice (including None) overrides that
     seed for this mounted session. Scoping the override keeps a reused composer
     from carrying one session's Role into another. Whether the Role still
     describes the run config is derived below, so a knob moved by hand takes
     the name away on its own. */
  const [selectionOverride, setSelectionOverride] = useState<{
    sessionId: SessionId;
    roleId: AgentRoleId | null;
  } | null>(null);
  const pickedRoleId =
    selectionOverride?.sessionId === sessionId
      ? selectionOverride.roleId
      : (provenanceRoleId ?? null);
  const selection = useMemo(
    () => ({
      modeId: selectedModeId,
      modelId: selectedModelId,
      configOptionValues: configOptionValues ?? {},
    }),
    [configOptionValues, selectedModeId, selectedModelId]
  );
  const selectedRoleId = useMemo(() => {
    if (!pickedRoleId) return null;
    const role = items.find((item) => item.role.id === pickedRoleId)?.role;
    if (!role) return null;
    return isAgentRoleRunConfigApplied(role, selection) ? role.id : null;
  }, [items, pickedRoleId, selection]);

  const onSelect = useCallback(
    (roleId: AgentRoleId | null) => {
      if (roleId === null) {
        // Clears the NAME, not the configuration: the values are the user's own
        // now, and rolling them back would undo choices they never asked to undo.
        setSelectionOverride({ sessionId, roleId: null });
        return;
      }
      const role = items.find((item) => item.role.id === roleId)?.role;
      if (!role) return;
      setSelectionOverride({ sessionId, roleId });

      const { modelId, modeId, configOptionValues: pinned } = role.runConfig;
      if (modelId && modelOptions.some((option) => option.value === modelId)) {
        onModelChange?.(modelId);
      }
      if (modeId && modeOptions.some((option) => option.value === modeId)) {
        onModeChange?.(modeId);
      }
      // An option this agent dropped, or whose value it no longer offers, is
      // skipped rather than forced back in — through the same filter every
      // other surface applies to remembered values.
      for (const [configId, value] of Object.entries(
        filterAcpSessionConfigOptionValues(pinned, configOptionSelectors)
      )) {
        onConfigOptionChange?.(configId, value);
      }
    },
    [
      configOptionSelectors,
      items,
      modeOptions,
      modelOptions,
      onConfigOptionChange,
      onModeChange,
      onModelChange,
      sessionId,
    ]
  );

  return { items, selectedRoleId, onSelect };
}
