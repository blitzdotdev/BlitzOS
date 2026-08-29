// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, MachineId, MachineViewMeta } from '@lody/shared';

import { ProviderRow } from '../src/components/settings/provider-row';
import { initI18n } from '../src/i18n';

const machineId = 'machine-test' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.76.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
};

const makeConfig = (
  overrides: Pick<AgentConfigMeta, 'cliType' | 'agentType'>
): AgentConfigMeta => ({
  id: `config-${overrides.agentType}` as AgentConfigId,
  machineId,
  name: overrides.agentType,
  env: {},
  ...overrides,
});

describe('ProviderRow reauthentication', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const renderConfig = async (config: AgentConfigMeta) => {
    await act(async () => {
      root.render(
        <ProviderRow config={config} machine={machine} onEdit={vi.fn()} onRefresh={vi.fn()} />
      );
    });
  };

  // Asserts on rendered text rather than a mocked panel: the row must not grow a
  // sign-in affordance again, whichever component would provide it.
  const hasSignInAction = () =>
    Array.from(container.querySelectorAll('button')).some((button) =>
      button.textContent?.includes('Sign in')
    );

  // Signing in again lives in the provider detail dialog, so no list row shows it.
  it.each([
    { cliType: 'builtin', agentType: 'claude' },
    { cliType: 'builtin', agentType: 'codex' },
    { cliType: 'builtin', agentType: 'kimi' },
    { cliType: 'registry', agentType: 'auggie' },
  ] as const)('does not offer Sign in again for the $agentType provider row', async (overrides) => {
    await renderConfig(makeConfig(overrides));

    expect(hasSignInAction()).toBe(false);
  });

  it('still opens the provider detail when the row is clicked', async () => {
    const config = makeConfig({ cliType: 'builtin', agentType: 'claude' });
    const onEdit = vi.fn();
    await act(async () => {
      root.render(<ProviderRow config={config} machine={machine} onEdit={onEdit} />);
    });

    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Config"]');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onEdit).toHaveBeenCalledWith(config);
  });
});
