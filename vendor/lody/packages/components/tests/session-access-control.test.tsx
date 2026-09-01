// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionAccessControl } from '../src/components/session-sharing';
import type { SessionSharingState } from '../src/lib/session-sharing';
import { TooltipProvider } from '../src/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseState = {
  canManage: true,
  machineId: 'machine-1' as MachineId,
  localProjectId: 'project-1' as LocalProjectId,
  machineName: 'Workstation',
  projectName: 'Lody',
};

describe('SessionAccessControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function renderState(state: SessionSharingState) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <SessionAccessControl state={state} onShareWithTeam={vi.fn()} />
        </TooltipProvider>
      );
    });
  }

  it('renders the access control for a private conversation', async () => {
    await renderState({
      ...baseState,
      visibility: 'private',
      privateReason: 'project',
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    expect(trigger?.textContent).toContain('Private');
    expect(trigger?.getAttribute('aria-label')).toContain('Private to you');
  });

  it.each(['team', 'unknown'] as const)('renders nothing when visibility is %s', async (visibility) => {
    await renderState({ ...baseState, visibility });

    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
