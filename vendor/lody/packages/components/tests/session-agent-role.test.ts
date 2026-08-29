// Coverage for the Role offer inside an EXISTING session: which Roles it may
// reuse, and what "still applied" means when the session's agent is fixed.

import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import {
  isAgentRoleRunConfigApplied,
  isComposerAgentRoleApplied,
  selectSessionAgentRoles,
} from '../src/lib/composer-agent-roles';

const config = (id: string, agentType: string, machineId = 'machine-1'): AgentConfigMeta =>
  ({
    id: id as AgentConfigId,
    machineId: machineId as MachineId,
    name: id,
    cliType: 'builtin',
    agentType,
    env: {},
  }) as AgentConfigMeta;

const makeRole = (
  overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name' | 'agentConfigId'>
): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-1',
  visibility: 'private',
  machineId: 'machine-1' as MachineId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('selectSessionAgentRoles', () => {
  const codexHere = makeRole({
    id: 'r-codex' as AgentRoleId,
    name: 'Reviewer',
    agentConfigId: 'codex-1' as AgentConfigId,
  });
  // Same TYPE, other config, other machine: its run-config values are published
  // per cliType:agentType, so they still mean something for this session.
  const codexElsewhere = makeRole({
    id: 'r-codex-2' as AgentRoleId,
    name: 'Auditor',
    agentConfigId: 'codex-2' as AgentConfigId,
    machineId: 'machine-2' as MachineId,
  });
  const claude = makeRole({
    id: 'r-claude' as AgentRoleId,
    name: 'Docs',
    agentConfigId: 'claude-1' as AgentConfigId,
  });
  const agentConfigs = [
    config('codex-1', 'codex'),
    config('codex-2', 'codex', 'machine-2'),
    config('claude-1', 'claude'),
  ];

  it('offers every Role bound to an agent of the same type, on any machine', () => {
    const items = selectSessionAgentRoles({
      roles: [codexHere, codexElsewhere, claude],
      agentType: 'codex',
      agentConfigs,
    });
    expect(items.map((item) => item.role.id)).toEqual(['r-codex-2', 'r-codex']);
  });

  it('drops a Role bound to another agent type — its values would not transfer', () => {
    const items = selectSessionAgentRoles({
      roles: [claude],
      agentType: 'codex',
      agentConfigs,
    });
    expect(items).toEqual([]);
  });

  it('drops a Role whose config is gone rather than guessing its type', () => {
    const orphan = makeRole({
      id: 'r-orphan' as AgentRoleId,
      name: 'Orphan',
      agentConfigId: 'deleted' as AgentConfigId,
    });
    expect(selectSessionAgentRoles({ roles: [orphan], agentType: 'codex', agentConfigs })).toEqual(
      []
    );
  });

  it('offers nothing until the session reports its agent type', () => {
    expect(selectSessionAgentRoles({ roles: [codexHere], agentType: null, agentConfigs })).toEqual(
      []
    );
  });

  // Nothing is going to that Role's machine, so its availability is not what is
  // being asked of it here.
  it('does not consult availability, because the binding is not executed', () => {
    const items = selectSessionAgentRoles({
      roles: [codexElsewhere],
      agentType: 'codex',
      agentConfigs,
    });
    expect(items[0]?.availability).toEqual({ kind: 'available' });
  });
});

describe('isAgentRoleRunConfigApplied', () => {
  const role = makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Reviewer',
    agentConfigId: 'codex-1' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.5', modeId: 'plan', configOptionValues: { effort: 'high' } },
  });
  const applied = {
    modeId: 'plan',
    modelId: 'gpt-5.5',
    configOptionValues: { effort: 'high' },
  };

  it('holds on the values alone, whatever agent is running', () => {
    expect(isAgentRoleRunConfigApplied(role, applied)).toBe(true);
  });

  it('stops holding when a pinned value is changed by hand', () => {
    expect(isAgentRoleRunConfigApplied(role, { ...applied, modelId: 'gpt-5.5-mini' })).toBe(false);
    expect(
      isAgentRoleRunConfigApplied(role, { ...applied, configOptionValues: { effort: 'low' } })
    ).toBe(false);
  });

  // The landing still authorizes the WHOLE Role, so it keeps the agent check on
  // top of the same value rule.
  it('is the value half of the new-chat rule, which also binds the agent', () => {
    const selection = {
      ...applied,
      agentSelection: { agentId: 'codex-2' as AgentConfigId, machineId: 'machine-1' as MachineId },
    };
    expect(isAgentRoleRunConfigApplied(role, selection)).toBe(true);
    expect(isComposerAgentRoleApplied(role, selection)).toBe(false);
  });
});
