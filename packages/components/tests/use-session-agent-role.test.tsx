// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigMeta,
  AgentRole,
  AgentRoleId,
  MachineId,
  SessionId,
} from '@lody/shared';

const catalog = vi.hoisted(() => ({
  roles: [] as AgentRole[],
  agentConfigs: [] as AgentConfigMeta[],
}));

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAtomValue: () => catalog.agentConfigs,
}));

vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: catalog.roles }),
}));

import {
  useSessionAgentRole,
  type SessionAgentRoleControl,
} from '../src/hooks/use-session-agent-role';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const role = (id: string, modelId: string): AgentRole => ({
  v: 1,
  id: id as AgentRoleId,
  revision: 1,
  name: id,
  visibility: 'private',
  ownerUserId: 'user-1',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'agent-1' as AgentConfigId,
  runConfig: { modelId },
  createdAt: Date.UTC(2026, 7, 25),
  updatedAt: Date.UTC(2026, 7, 25),
});

const agentConfig = {
  id: 'agent-1',
  name: 'Codex',
  machineId: 'machine-1',
  cliType: 'builtin',
  agentType: 'codex',
} as AgentConfigMeta;

describe('useSessionAgentRole', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let control: SessionAgentRoleControl | null = null;
  let hookProps: {
    sessionId: string;
    provenanceRoleId?: AgentRoleId;
    selectedModelId: string;
  };

  function Harness() {
    control = useSessionAgentRole({
      sessionId: hookProps.sessionId as SessionId,
      provenanceRoleId: hookProps.provenanceRoleId,
      agentType: 'codex',
      modelOptions: [{ value: 'model-1', label: 'Model 1' }],
      selectedModelId: hookProps.selectedModelId,
      modeOptions: [],
      selectedModeId: null,
      configOptionSelectors: [],
      configOptionValues: {},
    });
    return null;
  }

  const render = async ({
    sessionId = 'session-1',
    provenanceRoleId,
    selectedModelId = 'model-1',
  }: {
    sessionId?: string;
    provenanceRoleId?: AgentRoleId;
    selectedModelId?: string;
  }) => {
    hookProps = { sessionId, provenanceRoleId, selectedModelId };
    await act(async () => root?.render(createElement(Harness)));
  };

  beforeEach(() => {
    catalog.roles = [];
    catalog.agentConfigs = [agentConfig];
    control = null;
    hookProps = { sessionId: 'session-1', selectedModelId: 'model-1' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it('shows the creating Role after the workspace catalog loads', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    await render({ provenanceRoleId });
    expect(control?.selectedRoleId).toBeNull();

    catalog.roles = [role('role-1', 'model-1')];
    await render({ provenanceRoleId });

    expect(control?.selectedRoleId).toBe(provenanceRoleId);
  });

  it('keeps an explicit None selection and scopes it to the current session', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    catalog.roles = [role('role-1', 'model-1')];
    await render({ provenanceRoleId });
    expect(control?.selectedRoleId).toBe(provenanceRoleId);

    await act(async () => control?.onSelect(null));
    expect(control?.selectedRoleId).toBeNull();

    await render({ provenanceRoleId });
    expect(control?.selectedRoleId).toBeNull();

    await render({ sessionId: 'session-2', provenanceRoleId });
    expect(control?.selectedRoleId).toBe(provenanceRoleId);
  });

  it('does not name the provenance Role after its run config changes', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    catalog.roles = [role('role-1', 'model-1')];

    await render({ provenanceRoleId, selectedModelId: 'model-2' });

    expect(control?.selectedRoleId).toBeNull();
  });
});
